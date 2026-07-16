const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeName(value) {
  return String(value || `visual-${Date.now()}`)
    .replace(/\.png$/i, '')
    .replace(/[^a-z0-9-_]/gi, '_')
    .replace(/_+/g, '_')
    .toLowerCase();
}

function readEnv(key, fallback) {
  return process.env[key] || fallback;
}

async function compareImages({ baselinePath, actualPath, diffPath, threshold = 0.12 }) {
  const pixelmatch = (await import('pixelmatch')).default;

  const baseline = PNG.sync.read(fs.readFileSync(baselinePath));
  const actual = PNG.sync.read(fs.readFileSync(actualPath));

  const compareWidth = Math.min(baseline.width, actual.width);
  const compareHeight = Math.min(baseline.height, actual.height);

  const dimensionMismatch =
    baseline.width !== actual.width ||
    baseline.height !== actual.height;

  const crop = (source) => {
    const cropped = new PNG({ width: compareWidth, height: compareHeight });

    for (let y = 0; y < compareHeight; y += 1) {
      for (let x = 0; x < compareWidth; x += 1) {
        const sourceIdx = (source.width * y + x) << 2;
        const targetIdx = (compareWidth * y + x) << 2;

        cropped.data[targetIdx] = source.data[sourceIdx];
        cropped.data[targetIdx + 1] = source.data[sourceIdx + 1];
        cropped.data[targetIdx + 2] = source.data[sourceIdx + 2];
        cropped.data[targetIdx + 3] = source.data[sourceIdx + 3];
      }
    }

    return cropped;
  };

  const baselineComparable = crop(baseline);
  const actualComparable = crop(actual);

  const diff = new PNG({ width: compareWidth, height: compareHeight });

  const mismatchPixels = pixelmatch(
    baselineComparable.data,
    actualComparable.data,
    diff.data,
    compareWidth,
    compareHeight,
    {
      threshold,
      includeAA: true,
      diffColor: [255, 0, 0],
      diffColorAlt: [0, 0, 255],
      aaColor: [255, 165, 0],
      alpha: 0.15,
    },
  );

  const totalPixels = compareWidth * compareHeight;
  const mismatchRatio = mismatchPixels / totalPixels;
  const maxMismatchRatio = Number(readEnv('VISUAL_MAX_MISMATCH_RATIO', '0.01'));

  const hasDifference = mismatchPixels > 0 || dimensionMismatch;

  let finalDiffPath = null;
  let overlayPath = null;

  const staleOverlayPath = diffPath.replace(/\.png$/i, '_overlay.png');

  if (!hasDifference) {
    if (fs.existsSync(diffPath)) fs.rmSync(diffPath);
    if (fs.existsSync(staleOverlayPath)) fs.rmSync(staleOverlayPath);
  }

  if (hasDifference) {
    fs.writeFileSync(diffPath, PNG.sync.write(diff));
    finalDiffPath = diffPath;

    const overlay = new PNG({ width: compareWidth, height: compareHeight });

    for (let y = 0; y < compareHeight; y += 1) {
      for (let x = 0; x < compareWidth; x += 1) {
        const idx = (compareWidth * y + x) << 2;

        const br = baselineComparable.data[idx];
        const bg = baselineComparable.data[idx + 1];
        const bb = baselineComparable.data[idx + 2];
        const ba = baselineComparable.data[idx + 3];

        const ar = actualComparable.data[idx];
        const ag = actualComparable.data[idx + 1];
        const ab = actualComparable.data[idx + 2];
        const aa = actualComparable.data[idx + 3];

        const delta =
          Math.abs(br - ar) +
          Math.abs(bg - ag) +
          Math.abs(bb - ab) +
          Math.abs(ba - aa);

        overlay.data[idx] = ar;
        overlay.data[idx + 1] = ag;
        overlay.data[idx + 2] = ab;
        overlay.data[idx + 3] = aa;

        if (delta > Number(readEnv('VISUAL_RAW_PIXEL_DELTA', '60'))) {
          overlay.data[idx] = 255;
          overlay.data[idx + 1] = 0;
          overlay.data[idx + 2] = 0;
          overlay.data[idx + 3] = 255;
        }
      }
    }

    if (dimensionMismatch) {
      const border = 8;

      for (let y = 0; y < compareHeight; y += 1) {
        for (let x = 0; x < compareWidth; x += 1) {
          const isBorder =
            x < border ||
            y < border ||
            x >= compareWidth - border ||
            y >= compareHeight - border;

          if (isBorder) {
            const idx = (compareWidth * y + x) << 2;
            overlay.data[idx] = 255;
            overlay.data[idx + 1] = 0;
            overlay.data[idx + 2] = 0;
            overlay.data[idx + 3] = 255;
          }
        }
      }
    }

    overlayPath = staleOverlayPath;
    fs.writeFileSync(overlayPath, PNG.sync.write(overlay));
  }

  const passed = mismatchRatio <= maxMismatchRatio;

  return {
    compared: true,
    passed,
    hasDifference,
    reason: passed
      ? hasDifference
        ? dimensionMismatch
          ? `Visual comparison passed on common area ${compareWidth}x${compareHeight}. Dimension warning: baseline ${baseline.width}x${baseline.height}, actual ${actual.width}x${actual.height}.`
          : `Visual comparison passed with minor difference ratio ${mismatchRatio.toFixed(5)}.`
        : 'Visual comparison passed. No pixel differences detected.'
      : `Visual mismatch ratio ${mismatchRatio.toFixed(5)} exceeded allowed ${maxMismatchRatio}.`,
    dimensionMismatch,
    baselineSize: `${baseline.width}x${baseline.height}`,
    actualSize: `${actual.width}x${actual.height}`,
    comparedSize: `${compareWidth}x${compareHeight}`,
    mismatchPixels,
    totalPixels,
    mismatchRatio,
    maxMismatchRatio,
    threshold,
    baselinePath,
    actualPath,
    diffPath: finalDiffPath,
    overlayPath,
  };
}

class VisualValidator {
  constructor(page, options = {}) {
    this.page = page;
    this.rootDir = options.rootDir || process.cwd();
    this.targetEnv = String(options.targetEnv || process.env.TARGET_ENV || 'PROD').toLowerCase();

    this.baselineDir = path.resolve(this.rootDir, 'visual-baselines');
    this.actualDir = path.resolve(this.rootDir, 'visual-actuals');
    this.diffDir = path.resolve(this.rootDir, 'visual-diffs');

    ensureDir(this.baselineDir);
    ensureDir(this.actualDir);
    ensureDir(this.diffDir);
  }

  paths(name) {
    const base = `${this.targetEnv}_${safeName(name)}`;

    return {
      name: base,
      baselinePath: path.join(this.baselineDir, `${base}.png`),
      actualPath: path.join(this.actualDir, `${base}.png`),
      diffPath: path.join(this.diffDir, `${base}.png`),
    };
  }

  async captureAndCompare(name, options = {}) {
    const paths = this.paths(name);

    const updateBaseline =
      options.updateBaseline === true ||
      process.env.UPDATE_VISUAL_BASELINE === 'true';

    await this.page.screenshot({
      path: paths.actualPath,
      fullPage: options.fullPage !== false,
    });

    let baselineAction = 'baseline_exists';

    if (updateBaseline || !fs.existsSync(paths.baselinePath)) {
      fs.copyFileSync(paths.actualPath, paths.baselinePath);
      baselineAction = updateBaseline ? 'baseline_updated' : 'baseline_created';
    }

    const comparison = await compareImages({
      baselinePath: paths.baselinePath,
      actualPath: paths.actualPath,
      diffPath: paths.diffPath,
      threshold: Number(options.threshold || process.env.VISUAL_PIXEL_THRESHOLD || 0.12),
    });

    const result = {
      name: paths.name,
      baselineAction,
      createdAt: new Date().toISOString(),
      ...comparison,
    };

    const auditDir = path.resolve(this.rootDir, 'reports', 'audits');
    ensureDir(auditDir);

    fs.writeFileSync(
      path.join(auditDir, `${paths.name}_visual_comparison.json`),
      JSON.stringify(result, null, 2),
      'utf8'
    );

    return result;
  }
}

module.exports = {
  VisualValidator,
  compareImages,
};
