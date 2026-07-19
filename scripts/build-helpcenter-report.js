const fs = require('fs');
const path = require('path');

const root = process.cwd();

const reportName = process.argv[2] || 'helpcenter-faq-report';
const targetEnv = (process.env.TARGET_ENV || 'UAT').toUpperCase();

const reportsDir = path.join(root, 'reports');
const screenshotsDir = path.join(reportsDir, 'screenshots');
const auditsDir = path.join(reportsDir, 'audits');
const outputDir = path.join(reportsDir, 'shareable');
const outputPath = path.join(outputDir, `${reportName}.html`);

fs.mkdirSync(outputDir, { recursive: true });

function exists(filePath) {
  return filePath && fs.existsSync(filePath);
}

function readJson(filePath, fallback = null) {
  try {
    if (!exists(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function listFiles(dir, predicate = () => true) {
  if (!exists(dir)) return [];
  return fs.readdirSync(dir)
    .map(file => path.join(dir, file))
    .filter(file => fs.statSync(file).isFile())
    .filter(predicate)
    .sort();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fileToDataUri(filePath) {
  if (!exists(filePath)) return '';
  const ext = path.extname(filePath).toLowerCase().replace('.', '') || 'png';
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
  const base64 = fs.readFileSync(filePath).toString('base64');
  return `data:${mime};base64,${base64}`;
}

function shortPath(filePath) {
  return filePath ? path.relative(root, filePath) : '';
}

function pct(value) {
  const number = Number(value || 0);
  return `${(number * 100).toFixed(2)}%`;
}

function statusBadge(ok, labelOk = 'PASSED', labelBad = 'FAILED') {
  return `<span class="badge ${ok ? 'pass' : 'fail'}">${ok ? labelOk : labelBad}</span>`;
}

function jsonBlock(title, data) {
  if (!data) return '';
  return `
    <details class="json-block">
      <summary>${escapeHtml(title)}</summary>
      <pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>
    </details>
  `;
}

function imageCard(title, filePath, type = '') {
  if (!exists(filePath)) return '';

  const dataUri = fileToDataUri(filePath);
  const rel = shortPath(filePath);

  return `
    <article class="image-card" data-search="${escapeHtml(`${title} ${rel}`.toLowerCase())}">
      <div class="image-card-header">
        <h4>${escapeHtml(title)}</h4>
        ${type ? `<span class="mini-tag">${escapeHtml(type)}</span>` : ''}
      </div>
      <button class="image-button" onclick="openLightbox('${escapeHtml(dataUri)}', '${escapeHtml(title)}', '${escapeHtml(rel)}')">
        <img src="${dataUri}" alt="${escapeHtml(title)}" loading="lazy" />
      </button>
      <p>${escapeHtml(rel)}</p>
    </article>
  `;
}

const auditFiles = listFiles(auditsDir, file => file.endsWith('.json'));
const visualAudits = auditFiles
  .filter(file => /visual_comparison\.json$/i.test(file))
  .map(file => ({ file, data: readJson(file) }))
  .filter(item => item.data);

const linkAuditFile = auditFiles.find(file => /link.*audit|links.*buttons/i.test(path.basename(file)));
const linkAudit = readJson(linkAuditFile);

const explorationFile =
  auditFiles.find(file => /exploration.*audit/i.test(path.basename(file))) ||
  auditFiles.find(file => /exploration/i.test(path.basename(file)));

const exploration = readJson(explorationFile);

const screenshotFilesFromExplorer = Array.isArray(exploration?.screenshots)
  ? exploration.screenshots.filter(exists)
  : [];

const screenshotFilesFromFolder = listFiles(screenshotsDir, file => /\.(png|jpg|jpeg)$/i.test(file));

const screenshots = [...new Set([...screenshotFilesFromExplorer, ...screenshotFilesFromFolder])];

const metricsFile = path.join(reportsDir, 'web-helpcenter-faq-audit.metrics.json');
const metrics = readJson(metricsFile);

const visualFailed = visualAudits.some(item => item.data && item.data.passed === false);
const linkFailed = linkAudit?.summary?.passed === false;
const explorationFailed = exploration?.summary?.passed === false;

/*
 * Visual pixel differences are report-only.
 * Link and exploration failures remain blocking.
 */
const overallPassed =
  !linkFailed &&
  !explorationFailed;

const visualDifferenceReported =
  visualFailed;

const visualSection = visualAudits.length
  ? visualAudits.map(({ file, data }) => {
      const hasDiff = Boolean(data.hasDifference || data.diffPath || data.overlayPath);
      return `
        <section class="panel visual-panel">
          <div class="section-title">
            <div>
              <h2>Visual comparison: ${escapeHtml(data.name || path.basename(file))}</h2>
              <p>${escapeHtml(data.reason || '')}</p>
            </div>
            ${statusBadge(data.passed)}
          </div>

          <div class="metric-grid">
            <div class="metric"><span>Mismatch</span><strong>${pct(data.mismatchRatio)}</strong></div>
            <div class="metric"><span>Allowed</span><strong>${pct(data.maxMismatchRatio)}</strong></div>
            <div class="metric"><span>Mismatch pixels</span><strong>${escapeHtml(data.mismatchPixels ?? 0)}</strong></div>
            <div class="metric"><span>Compared size</span><strong>${escapeHtml(data.comparedSize || '-')}</strong></div>
            <div class="metric"><span>Baseline action</span><strong>${escapeHtml(data.baselineAction || '-')}</strong></div>
            <div class="metric"><span>Has difference</span><strong>${hasDiff ? 'Yes' : 'No'}</strong></div>
          </div>

          <div class="visual-grid ${hasDiff ? 'four' : 'two'}">
            ${imageCard('Baseline', data.baselinePath, 'approved')}
            ${imageCard('Actual', data.actualPath, 'current')}
            ${hasDiff ? imageCard('Pixel Diff', data.diffPath, 'diff') : ''}
            ${hasDiff ? imageCard('Highlighted Overlay', data.overlayPath, 'overlay') : ''}
          </div>

          ${jsonBlock('Visual comparison JSON', data)}
        </section>
      `;
    }).join('\n')
  : `<section class="panel"><h2>Visual comparisons</h2><p>No visual comparison JSON found yet. Run the generated spec once after patching VisualValidator.</p></section>`;

const linkSection = `
  <section class="panel">
    <div class="section-title">
      <div>
        <h2>Link and button audit</h2>
        <p>${linkAuditFile ? escapeHtml(shortPath(linkAuditFile)) : 'No link audit file found.'}</p>
      </div>
      ${linkAudit ? statusBadge(linkAudit.summary?.passed !== false) : '<span class="badge warn">NO DATA</span>'}
    </div>

    <div class="metric-grid">
      <div class="metric"><span>Visible links</span><strong>${escapeHtml(linkAudit?.summary?.visibleLinks ?? '-')}</strong></div>
      <div class="metric"><span>Visible buttons</span><strong>${escapeHtml(linkAudit?.summary?.visibleButtons ?? '-')}</strong></div>
      <div class="metric"><span>Checked links</span><strong>${escapeHtml(linkAudit?.summary?.checkedLinks ?? '-')}</strong></div>
      <div class="metric"><span>Errors</span><strong>${escapeHtml(linkAudit?.summary?.errors ?? '-')}</strong></div>
      <div class="metric"><span>Warnings</span><strong>${escapeHtml(linkAudit?.summary?.warnings ?? '-')}</strong></div>
      <div class="metric"><span>Disabled buttons</span><strong>${escapeHtml(linkAudit?.summary?.disabledVisibleButtons ?? '-')}</strong></div>
    </div>

    ${jsonBlock('Link/button audit JSON', linkAudit)}
  </section>
`;

const explorationSection = `
  <section class="panel">
    <div class="section-title">
      <div>
        <h2>Help Centre exploration</h2>
        <p>${explorationFile ? escapeHtml(shortPath(explorationFile)) : 'No exploration file found.'}</p>
      </div>
      ${exploration ? statusBadge(exploration.summary?.passed !== false) : '<span class="badge warn">NO DATA</span>'}
    </div>

    <div class="metric-grid">
      <div class="metric"><span>Gen FAQ asked</span><strong>${escapeHtml(exploration?.summary?.genFaqQuestionsAsked ?? '-')}</strong></div>
      <div class="metric"><span>Suggestion chips</span><strong>${escapeHtml(exploration?.summary?.suggestionChipsClicked ?? '-')}</strong></div>
      <div class="metric"><span>Source links</span><strong>${escapeHtml(exploration?.summary?.sourceLinksOpened ?? '-')}</strong></div>
      <div class="metric"><span>Browse topics</span><strong>${escapeHtml(exploration?.summary?.browseTopicsOpened ?? '-')}</strong></div>
      <div class="metric"><span>Articles opened</span><strong>${escapeHtml(exploration?.summary?.articlesOpened ?? '-')}</strong></div>
      <div class="metric"><span>Positive ratings</span><strong>${escapeHtml(exploration?.summary?.positiveRatings ?? '-')}</strong></div>
      <div class="metric"><span>Negative ratings</span><strong>${escapeHtml(exploration?.summary?.negativeRatings ?? '-')}</strong></div>
      <div class="metric"><span>Feedback submitted</span><strong>${exploration?.summary?.feedbackSubmitted ? 'Yes' : 'No'}</strong></div>
      <div class="metric"><span>Olive launched</span><strong>${exploration?.summary?.oliveLaunched ? 'Yes' : 'No'}</strong></div>
      <div class="metric"><span>App landing opened</span><strong>${exploration?.summary?.appLandingOpened ? 'Yes' : 'No'}</strong></div>
    </div>

    ${exploration?.warnings?.length ? `
      <details class="warning-block">
        <summary>Warnings (${exploration.warnings.length})</summary>
        <pre>${escapeHtml(JSON.stringify(exploration.warnings, null, 2))}</pre>
      </details>
    ` : ''}

    ${exploration?.errors?.length ? `
      <details class="error-block">
        <summary>Errors (${exploration.errors.length})</summary>
        <pre>${escapeHtml(JSON.stringify(exploration.errors, null, 2))}</pre>
      </details>
    ` : ''}

    ${jsonBlock('Exploration JSON', exploration)}
  </section>
`;

const screenshotGallery = screenshots.length
  ? screenshots.map((file, index) => imageCard(`Screenshot ${index + 1}`, file, 'evidence')).join('\n')
  : '<p>No screenshots found.</p>';

const summaryText = [
  `Environment: ${targetEnv}`,
  `Overall: ${overallPassed ? 'PASSED' : 'FAILED / REVIEW REQUIRED'}`,
  `Visual checks: ${visualAudits.length}`,
  `Screenshots: ${screenshots.length}`,
  `Link audit passed: ${linkAudit?.summary?.passed !== false}`,
  `Exploration passed: ${exploration?.summary?.passed !== false}`,
].join('\\n');

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Help Centre FAQ QA Report - ${escapeHtml(targetEnv)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root {
      --bg: #f6f8fb;
      --panel: #ffffff;
      --text: #172033;
      --muted: #667085;
      --border: #e4e7ec;
      --green: #16a34a;
      --red: #dc2626;
      --amber: #d97706;
      --blue: #2563eb;
      --purple: #7c3aed;
      --shadow: 0 18px 45px rgba(15, 23, 42, 0.08);
    }

    body.dark {
      --bg: #0b1220;
      --panel: #111827;
      --text: #e5e7eb;
      --muted: #9ca3af;
      --border: #253247;
      --shadow: 0 18px 45px rgba(0, 0, 0, 0.35);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
    }

    .hero {
      padding: 32px;
      color: white;
      background:
        radial-gradient(circle at 10% 20%, rgba(255, 255, 255, .25), transparent 28%),
        linear-gradient(135deg, #0f9d58, #00a3ff 45%, #7c3aed);
    }

    .hero-content {
      max-width: 1440px;
      margin: 0 auto;
      display: flex;
      justify-content: space-between;
      gap: 24px;
      align-items: flex-start;
    }

    .hero h1 {
      font-size: 34px;
      margin: 0 0 8px;
      letter-spacing: -0.04em;
    }

    .hero p {
      margin: 4px 0;
      opacity: .92;
    }

    .actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    button.action {
      border: 0;
      border-radius: 999px;
      padding: 10px 14px;
      font-weight: 700;
      cursor: pointer;
      background: rgba(255, 255, 255, .18);
      color: white;
      backdrop-filter: blur(10px);
    }

    button.action:hover {
      background: rgba(255, 255, 255, .28);
    }

    .container {
      max-width: 1440px;
      margin: -32px auto 64px;
      padding: 0 24px;
    }

    .top-cards {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 16px;
      margin-bottom: 16px;
    }

    .status-card, .panel {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 20px;
      box-shadow: var(--shadow);
    }

    .status-card {
      padding: 18px;
    }

    .status-card span {
      display: block;
      color: var(--muted);
      font-size: 13px;
      margin-bottom: 8px;
    }

    .status-card strong {
      font-size: 26px;
      letter-spacing: -0.03em;
    }

    .tabs {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin: 22px 0;
    }

    .tab {
      border: 1px solid var(--border);
      background: var(--panel);
      color: var(--text);
      padding: 10px 14px;
      border-radius: 999px;
      cursor: pointer;
      font-weight: 700;
    }

    .tab.active {
      background: var(--blue);
      color: white;
      border-color: var(--blue);
    }

    .panel {
      padding: 22px;
      margin-bottom: 18px;
    }

    .section-title {
      display: flex;
      justify-content: space-between;
      gap: 20px;
      align-items: flex-start;
      margin-bottom: 18px;
    }

    .section-title h2 {
      margin: 0 0 6px;
      letter-spacing: -0.03em;
    }

    .section-title p {
      margin: 0;
      color: var(--muted);
    }

    .badge {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 7px 11px;
      font-weight: 900;
      font-size: 12px;
      letter-spacing: .05em;
      white-space: nowrap;
    }

    .badge.pass { color: white; background: var(--green); }
    .badge.fail { color: white; background: var(--red); }
    .badge.warn { color: white; background: var(--amber); }

    .metric-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      gap: 12px;
      margin: 18px 0;
    }

    .metric {
      padding: 14px;
      border: 1px solid var(--border);
      border-radius: 16px;
      background: linear-gradient(180deg, rgba(37,99,235,.06), transparent);
    }

    .metric span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 6px;
    }

    .metric strong {
      font-size: 19px;
    }

    .visual-grid {
      display: grid;
      gap: 16px;
      margin-top: 18px;
    }

    .visual-grid.two {
      grid-template-columns: repeat(auto-fit, minmax(480px, 1fr));
    }

    .visual-grid.four {
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    }

    .gallery-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 16px;
    }

    .image-card {
      border: 1px solid var(--border);
      border-radius: 18px;
      overflow: hidden;
      background: var(--panel);
    }

    .image-card-header {
      padding: 12px 14px;
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      border-bottom: 1px solid var(--border);
    }

    .image-card h4 {
      margin: 0;
      font-size: 14px;
    }

    .mini-tag {
      padding: 4px 8px;
      border-radius: 999px;
      color: white;
      background: var(--purple);
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
    }

    .image-card p {
      padding: 0 14px 12px;
      margin: 0;
      color: var(--muted);
      font-size: 11px;
      word-break: break-all;
    }

    .image-button {
      border: 0;
      padding: 0;
      background: transparent;
      cursor: zoom-in;
      width: 100%;
    }

    .image-card img {
      width: 100%;
      display: block;
      max-height: 520px;
      object-fit: contain;
      background: #fff;
    }

    details {
      border: 1px solid var(--border);
      border-radius: 16px;
      margin-top: 14px;
      overflow: hidden;
    }

    summary {
      cursor: pointer;
      padding: 14px;
      font-weight: 800;
      background: rgba(37, 99, 235, .08);
    }

    pre {
      margin: 0;
      padding: 16px;
      overflow: auto;
      font-size: 12px;
      line-height: 1.5;
      color: var(--text);
    }

    .warning-block summary { background: rgba(217, 119, 6, .14); }
    .error-block summary { background: rgba(220, 38, 38, .14); }

    .search {
      width: 100%;
      padding: 14px 16px;
      border-radius: 14px;
      border: 1px solid var(--border);
      background: var(--panel);
      color: var(--text);
      font-size: 15px;
      margin-bottom: 16px;
    }

    .hidden { display: none !important; }

    .lightbox {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,.86);
      z-index: 1000;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 28px;
    }

    .lightbox.open { display: flex; }

    .lightbox-inner {
      max-width: 96vw;
      max-height: 94vh;
      color: white;
    }

    .lightbox img {
      max-width: 96vw;
      max-height: 82vh;
      display: block;
      object-fit: contain;
      background: white;
      border-radius: 12px;
    }

    .lightbox h3 { margin: 12px 0 4px; }
    .lightbox p { margin: 0; opacity: .8; word-break: break-all; }

    @media print {
      .actions, .tabs, .search, .lightbox { display: none !important; }
      .container { margin: 0; max-width: none; }
      body { background: white; }
      .panel, .status-card { box-shadow: none; break-inside: avoid; }
    }

    @media (max-width: 900px) {
      .hero-content { flex-direction: column; }
      .top-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }

    @media (max-width: 600px) {
      .top-cards { grid-template-columns: 1fr; }
      .visual-grid.two, .visual-grid.four { grid-template-columns: 1fr; }
      .hero { padding: 24px; }
      .container { padding: 0 14px; }
    }
  </style>
</head>
<body>
  <header class="hero">
    <div class="hero-content">
      <div>
        <h1>Help Centre FAQ QA Report</h1>
        <p><strong>Environment:</strong> ${escapeHtml(targetEnv)}</p>
        <p><strong>Generated:</strong> ${escapeHtml(new Date().toLocaleString())}</p>
        <p><strong>Overall:</strong> ${overallPassed ? 'Passed' : 'Review required'}</p>
      </div>
      <div class="actions">
        <button class="action" onclick="copySummary()">Copy summary</button>
        <button class="action" onclick="window.print()">Print / Save PDF</button>
        <button class="action" onclick="toggleTheme()">Toggle theme</button>
      </div>
    </div>
  </header>

  <main class="container">
    <section class="top-cards">
      <div class="status-card"><span>Overall</span><strong>${overallPassed ? 'Passed' : 'Review'}</strong></div>
      <div class="status-card"><span>Visual checks</span><strong>${visualAudits.length}</strong></div>
      <div class="status-card"><span>Screenshots</span><strong>${screenshots.length}</strong></div>
      <div class="status-card"><span>Environment</span><strong>${escapeHtml(targetEnv)}</strong></div>
    </section>

    <nav class="tabs">
      <button class="tab active" data-tab="overview" onclick="showTab('overview')">Overview</button>
      <button class="tab" data-tab="visual" onclick="showTab('visual')">Visual</button>
      <button class="tab" data-tab="audit" onclick="showTab('audit')">Audits</button>
      <button class="tab" data-tab="screenshots" onclick="showTab('screenshots')">Screenshots</button>
      <button class="tab" data-tab="raw" onclick="showTab('raw')">Raw evidence</button>
    </nav>

    <section id="tab-overview" class="tab-panel">
      ${visualSection}
      ${linkSection}
      ${explorationSection}
    </section>

    <section id="tab-visual" class="tab-panel hidden">
      ${visualSection}
    </section>

    <section id="tab-audit" class="tab-panel hidden">
      ${linkSection}
      ${explorationSection}
    </section>

    <section id="tab-screenshots" class="tab-panel hidden">
      <section class="panel">
        <div class="section-title">
          <div>
            <h2>Screenshot evidence</h2>
            <p>Search and click any image to enlarge it.</p>
          </div>
          <span class="badge pass">${screenshots.length} images</span>
        </div>
        <input class="search" id="screenshotSearch" placeholder="Search screenshots..." oninput="filterScreenshots()" />
        <div class="gallery-grid" id="screenshotGallery">
          ${screenshotGallery}
        </div>
      </section>
    </section>

    <section id="tab-raw" class="tab-panel hidden">
      <section class="panel">
        <h2>Raw evidence</h2>
        ${jsonBlock('Metrics JSON', metrics)}
        ${jsonBlock('Visual audits', visualAudits.map(item => item.data))}
        ${jsonBlock('Link audit', linkAudit)}
        ${jsonBlock('Exploration', exploration)}
      </section>
    </section>
  </main>

  <div id="lightbox" class="lightbox" onclick="closeLightbox()">
    <div class="lightbox-inner" onclick="event.stopPropagation()">
      <img id="lightboxImage" alt="Preview" />
      <h3 id="lightboxTitle"></h3>
      <p id="lightboxPath"></p>
    </div>
  </div>

  <script>
    const summaryText = ${JSON.stringify(summaryText)};

    function showTab(name) {
      document.querySelectorAll('.tab').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === name));
      document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.add('hidden'));
      document.getElementById('tab-' + name).classList.remove('hidden');
      window.location.hash = name;
    }

    function toggleTheme() {
      document.body.classList.toggle('dark');
      localStorage.setItem('qaReportTheme', document.body.classList.contains('dark') ? 'dark' : 'light');
    }

    function copySummary() {
      navigator.clipboard.writeText(summaryText).then(() => alert('Summary copied'));
    }

    function openLightbox(src, title, filePath) {
      document.getElementById('lightboxImage').src = src;
      document.getElementById('lightboxTitle').textContent = title;
      document.getElementById('lightboxPath').textContent = filePath;
      document.getElementById('lightbox').classList.add('open');
    }

    function closeLightbox() {
      document.getElementById('lightbox').classList.remove('open');
      document.getElementById('lightboxImage').src = '';
    }

    function filterScreenshots() {
      const value = document.getElementById('screenshotSearch').value.toLowerCase();
      document.querySelectorAll('#screenshotGallery .image-card').forEach(card => {
        card.classList.toggle('hidden', !(card.dataset.search || '').includes(value));
      });
    }

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') closeLightbox();
    });

    if (localStorage.getItem('qaReportTheme') === 'dark') {
      document.body.classList.add('dark');
    }

    if (window.location.hash) {
      const tab = window.location.hash.replace('#', '');
      if (document.getElementById('tab-' + tab)) showTab(tab);
    }
  </script>
</body>
</html>`;

fs.writeFileSync(outputPath, html, 'utf8');
console.log(`Shareable report created: ${outputPath}`);