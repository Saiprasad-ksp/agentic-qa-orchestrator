'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');

const reportName =
  process.argv[2] || 'qa-report';

const scenarioName =
  process.env.QA_SCENARIO_NAME ||
  reportName.replace(/-report$/, '');

const scenarioType =
  String(
    process.env.QA_SCENARIO_TYPE || ''
  ).toLowerCase();

const runDir = String(process.env.QA_RUN_DIR || '').trim()
  ? path.resolve(process.env.QA_RUN_DIR)
  : '';
const outputDir = runDir
  ? runDir
  : path.join(root, 'reports', 'shareable');

const outputPath =
  path.join(
    outputDir,
    `${reportName}.html`
  );

fs.mkdirSync(
  outputDir,
  {
    recursive: true,
  }
);

const IMAGE_EXTENSIONS =
  new Set([
    '.png',
    '.jpg',
    '.jpeg',
    '.webp',
    '.gif',
  ]);

function readJson(filePath) {
  if (
    !filePath ||
    !fs.existsSync(filePath)
  ) {
    return null;
  }

  try {
    return JSON.parse(
      fs.readFileSync(
        filePath,
        'utf8'
      )
    );
  } catch (_error) {
    return null;
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(
      /[&<>"']/g,
      character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;',
      })[character]
    );
}

function shortNumber(value) {
  return Number(
    value || 0
  ).toLocaleString(
    'en-AU'
  );
}

function statusClass(passed) {
  return passed
    ? 'pass'
    : 'fail';
}

function normaliseFilePath(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (
    !value ||
    typeof value !== 'object'
  ) {
    return '';
  }

  return (
    value.path ||
    value.filePath ||
    value.screenshotPath ||
    value.outputPath ||
    value.filename ||
    value.name ||
    ''
  );
}

function resolveFilePath(value) {
  const candidate =
    normaliseFilePath(value);

  if (!candidate) {
    return '';
  }

  const possiblePaths = [
    candidate,

    path.isAbsolute(candidate)
      ? candidate
      : path.resolve(
          root,
          candidate
        ),

    path.resolve(
      root,
      'reports',
      candidate
    ),

    path.resolve(
      root,
      'reports',
      'screenshots',
      path.basename(candidate)
    ),
  ];

  return (
    possiblePaths.find(
      filePath =>
        fs.existsSync(filePath) &&
        fs.statSync(filePath).isFile()
    ) || ''
  );
}

function imageToDataUri(value) {
  const filePath =
    resolveFilePath(value);

  if (!filePath) {
    return '';
  }

  const extension =
    path
      .extname(filePath)
      .toLowerCase();

  const mimeTypes = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  };

  const mimeType =
    mimeTypes[extension];

  if (!mimeType) {
    return '';
  }

  try {
    const encoded =
      fs.readFileSync(
        filePath
      ).toString('base64');

    return (
      `data:${mimeType};` +
      `base64,${encoded}`
    );
  } catch (_error) {
    return '';
  }
}

function walkImages(directory) {
  if (
    !directory ||
    !fs.existsSync(directory)
  ) {
    return [];
  }

  const results = [];

  for (
    const entry of
    fs.readdirSync(
      directory,
      {
        withFileTypes: true,
      }
    )
  ) {
    const absolutePath =
      path.join(
        directory,
        entry.name
      );

    if (entry.isDirectory()) {
      results.push(
        ...walkImages(
          absolutePath
        )
      );

      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const extension =
      path
        .extname(entry.name)
        .toLowerCase();

    if (
      IMAGE_EXTENSIONS.has(
        extension
      )
    ) {
      results.push(
        absolutePath
      );
    }
  }

  return results;
}

function fileTimestamp(filePath) {
  try {
    return fs
      .statSync(filePath)
      .mtimeMs;
  } catch (_error) {
    return 0;
  }
}

function normaliseSearchValue(value) {
  return String(value || '')
    .toLowerCase()
    .replace(
      /[^a-z0-9]+/g,
      '-'
    )
    .replace(
      /^-+|-+$/g,
      ''
    );
}

function appearsRelevantToScenario(
  filePath,
  {
    scenario,
    startedAt,
    endedAt,
  }
) {
  const baseName =
    normaliseSearchValue(
      path.basename(filePath)
    );

  const scenarioKey =
    normaliseSearchValue(
      scenario
    );

  if (
    scenarioKey &&
    baseName.includes(
      scenarioKey
    )
  ) {
    return true;
  }

  /*
   * Olive screenshots currently use generic names such as:
   * olive-turn-<timestamp>.png
   * automation-error-<timestamp>.png
   * olive-greeting-timeout-<timestamp>.png
   *
   * Use the execution time window when the filename does not contain
   * the scenario name.
   */
  const modified =
    fileTimestamp(filePath);

  const start =
    startedAt
      ? new Date(
          startedAt
        ).getTime()
      : 0;

  const end =
    endedAt
      ? new Date(
          endedAt
        ).getTime()
      : Date.now();

  const bufferMs =
    2 * 60 * 1000;

  if (
    start &&
    modified >=
      start - bufferMs &&
    modified <=
      end + bufferMs
  ) {
    return true;
  }

  return false;
}

function classifyImage(filePath) {
  const normalised =
    filePath
      .replaceAll('\\', '/')
      .toLowerCase();

  const baseName =
    path
      .basename(filePath)
      .toLowerCase();

  if (
    normalised.includes(
      'visual-baseline'
    ) ||
    normalised.includes(
      'visual-baselines'
    ) ||
    baseName.includes(
      'baseline'
    )
  ) {
    return 'Visual baseline';
  }

  if (
    normalised.includes(
      'visual-diff'
    ) ||
    normalised.includes(
      'visual-diffs'
    ) ||
    baseName.includes(
      'diff'
    )
  ) {
    return 'Pixel difference';
  }

  if (
    normalised.includes(
      'visual-overlay'
    ) ||
    normalised.includes(
      'visual-overlays'
    ) ||
    baseName.includes(
      'overlay'
    )
  ) {
    return 'Difference overlay';
  }

  if (
    normalised.includes(
      'visual-actual'
    ) ||
    normalised.includes(
      'visual-actuals'
    ) ||
    baseName.includes(
      'actual'
    )
  ) {
    return 'Visual actual';
  }

  if (
    baseName.includes(
      'error'
    ) ||
    baseName.includes(
      'timeout'
    )
  ) {
    return 'Failure evidence';
  }

  if (
    baseName.includes(
      'olive-turn'
    ) ||
    baseName.includes(
      'chat'
    )
  ) {
    return 'Conversation screenshot';
  }

  return 'Execution screenshot';
}

function collectMetricImagePaths(metrics) {
  const candidates = [];

  const append = value => {
    if (!value) {
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        append(item);
      }

      return;
    }

    if (
      typeof value === 'string'
    ) {
      candidates.push(value);
      return;
    }

    if (
      typeof value === 'object'
    ) {
      const keys = [
        'path',
        'filePath',
        'screenshotPath',
        'outputPath',
        'actualPath',
        'baselinePath',
        'diffPath',
        'overlayPath',
        'imagePath',
      ];

      let addedKnownPath = false;

      for (const key of keys) {
        if (
          typeof value[key] ===
          'string'
        ) {
          candidates.push(
            value[key]
          );

          addedKnownPath = true;
        }
      }

      if (!addedKnownPath) {
        for (
          const nested of
          Object.values(value)
        ) {
          append(nested);
        }
      }
    }
  };

  append(metrics.screenshots);
  append(metrics.visualComparisons);
  append(metrics.evidenceFiles);
  append(metrics.artifacts);

  return candidates;
}

function collectAllScreenshots(metrics) {
  const knownPaths =
    collectMetricImagePaths(
      metrics
    )
      .map(resolveFilePath)
      .filter(Boolean);

  const scanDirectories = runDir
    ? [runDir]
    : [
    path.join(
      root,
      'reports',
      'screenshots'
    ),

    path.join(
      root,
      'reports',
      'visual-actuals'
    ),

    path.join(
      root,
      'reports',
      'visual-baselines'
    ),

    path.join(
      root,
      'reports',
      'visual-diffs'
    ),

    path.join(
      root,
      'reports',
      'visual-overlays'
    ),

    path.join(
      root,
      'visual-actuals'
    ),

    path.join(
      root,
      'visual-baselines'
    ),

    path.join(
      root,
      'visual-diffs'
    ),

    path.join(
      root,
      'visual-overlays'
    ),

    path.join(
      root,
      'artifacts'
    ),

    path.join(
      root,
      'test-results'
    ),
  ];

  const discovered =
    scanDirectories
      .flatMap(
        directory =>
          walkImages(directory)
      )
      .filter(
        filePath =>
          appearsRelevantToScenario(
            filePath,
            {
              scenario:
                scenarioName,

              startedAt:
                metrics.startedAt,

              endedAt:
                metrics.endedAt,
            }
          )
      );

  const uniquePaths =
    [...new Set([
      ...knownPaths,
      ...discovered,
    ])];

  return uniquePaths
    .filter(
      filePath =>
        fs.existsSync(filePath)
    )
    .sort(
      (left, right) =>
        fileTimestamp(left) -
        fileTimestamp(right)
    )
    .map(filePath => ({
      path: filePath,
      type:
        classifyImage(
          filePath
        ),
    }));
}

function collectVideos() {
  if (!runDir || !fs.existsSync(runDir)) return [];
  const results = [];
  const pending = [runDir];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && /\.(webm|mp4|mov)$/i.test(entry.name)) results.push(absolute);
    }
  }
  return results.sort((a, b) => fileTimestamp(a) - fileTimestamp(b));
}

function buildVideoCards(videos) {
  if (!videos.length) return '<p>No video recording was produced for this execution.</p>';
  return videos.map((videoPath, index) => {
    const relative = path.relative(outputDir, videoPath).replaceAll('\\\\', '/');
    return `
      <figure class="shot">
        <video controls preload="metadata" style="width:100%;max-height:620px;background:#111">
          <source src="${escapeHtml(relative)}" type="video/${path.extname(videoPath).slice(1).toLowerCase() === 'webm' ? 'webm' : 'mp4'}">
        </video>
        <figcaption><strong>${index + 1}. Execution video</strong><span>${escapeHtml(path.relative(root, videoPath).replaceAll('\\\\', '/'))}</span></figcaption>
      </figure>`;
  }).join('');
}

function calculateTokenUsage(
  metrics = {}
) {
  const events =
    Array.isArray(
      metrics.tokenEvents
    )
      ? metrics.tokenEvents
      : [];

  const number = value => {
    const parsed =
      Number(value);

    return Number.isFinite(
      parsed
    )
      ? parsed
      : 0;
  };

  return events.reduce(
    (
      totals,
      event
    ) => {
      const promptTokens =
        number(
          event.promptTokenCount ??
          event.promptTokens ??
          event.inputTokenCount
        );

      const outputTokens =
        number(
          event.candidatesTokenCount ??
          event.candidateTokenCount ??
          event.outputTokenCount ??
          event.completionTokenCount
        );

      const cachedTokens =
        number(
          event.cachedContentTokenCount ??
          event.cachedTokenCount
        );

      const requestTotal =
        number(
          event.totalTokenCount
        ) ||
        promptTokens +
        outputTokens;

      totals.promptTokens +=
        promptTokens;

      totals.outputTokens +=
        outputTokens;

      totals.cachedTokens +=
        cachedTokens;

      totals.totalTokens +=
        requestTotal;

      totals.peakRequestTokens =
        Math.max(
          totals.peakRequestTokens,
          requestTotal
        );

      totals.apiCalls += 1;

      return totals;
    },
    {
      promptTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      peakRequestTokens: 0,
      apiCalls: 0,
    }
  );
}

function buildScreenshotCards(
  screenshots
) {
  if (!screenshots.length) {
    return (
      '<p>No screenshot files were found for this execution.</p>'
    );
  }

  return screenshots
    .map(
      (
        screenshot,
        index
      ) => {
        const imageData =
          imageToDataUri(
            screenshot.path
          );

        if (!imageData) {
          return '';
        }

        const relativePath =
          path
            .relative(
              root,
              screenshot.path
            )
            .replaceAll(
              '\\',
              '/'
            );

        return `
          <figure class="shot">
            <a
              href="${imageData}"
              target="_blank"
              rel="noopener"
            >
              <img
                src="${imageData}"
                alt="${escapeHtml(
                  path.basename(
                    screenshot.path
                  )
                )}"
                loading="lazy"
              >
            </a>

            <figcaption>
              <strong>
                ${index + 1}.
                ${escapeHtml(
                  screenshot.type
                )}
              </strong>

              <span>
                ${escapeHtml(
                  relativePath
                )}
              </span>
            </figcaption>
          </figure>
        `;
      }
    )
    .filter(Boolean)
    .join('');
}

function buildVisualComparisonCards(
  comparisons
) {
  if (
    !Array.isArray(
      comparisons
    ) ||
    !comparisons.length
  ) {
    return (
      '<p>No visual comparisons were recorded.</p>'
    );
  }

  return comparisons
    .map(
      (
        comparison,
        index
      ) => {
        const mismatchPixels =
          Number(
            comparison.mismatchPixels ||
            0
          );

        const mismatchRatio =
          Number(
            comparison.mismatchRatio ||
            0
          );

        const differenceDetected =
          comparison.differenceDetected ??
          comparison.hasDifference ??
          mismatchPixels > 0;

        const imageFields = [
          [
            'Actual',
            comparison.actualPath,
          ],

          [
            'Baseline',
            comparison.baselinePath,
          ],

          [
            'Pixel diff',
            comparison.diffPath,
          ],

          [
            'Overlay',
            comparison.overlayPath,
          ],
        ];

        const images =
          imageFields
            .map(
              (
                [
                  label,
                  filePath,
                ]
              ) => {
                const data =
                  imageToDataUri(
                    filePath
                  );

                if (!data) {
                  return '';
                }

                return `
                  <figure class="visual-image">
                    <a
                      href="${data}"
                      target="_blank"
                      rel="noopener"
                    >
                      <img
                        src="${data}"
                        alt="${escapeHtml(
                          label
                        )}"
                      >
                    </a>

                    <figcaption>
                      ${escapeHtml(
                        label
                      )}
                    </figcaption>
                  </figure>
                `;
              }
            )
            .filter(Boolean)
            .join('');

        return `
          <article class="visual-comparison">
            <div class="visual-header">
              <h3>
                Visual comparison
                ${index + 1}
              </h3>

              <span class="badge info">
                INFORMATIONAL
              </span>
            </div>

            <div class="judge-grid">
              <div>
                <span>
                  Difference detected
                </span>

                <strong>
                  ${differenceDetected
                    ? 'Yes'
                    : 'No'}
                </strong>
              </div>

              <div>
                <span>
                  Mismatch pixels
                </span>

                <strong>
                  ${shortNumber(
                    mismatchPixels
                  )}
                </strong>
              </div>

              <div>
                <span>
                  Mismatch ratio
                </span>

                <strong>
                  ${(
                    mismatchRatio *
                    100
                  ).toFixed(4)}%
                </strong>
              </div>

              <div>
                <span>
                  Scenario impact
                </span>

                <strong>
                  Report only
                </strong>
              </div>
            </div>

            <p>
              Pixel differences are reported as visual evidence
              and do not determine the functional scenario result.
            </p>

            ${
              images
                ? `<div class="visual-images">${images}</div>`
                : ''
            }
          </article>
        `;
      }
    )
    .join('');
}

function buildGenerativeReport() {
  const metricsCandidates = [
    runDir ? path.join(runDir, `${scenarioName}.metrics.json`) : '',
    process.env.QA_REPORTS_DIR
      ? path.join(
          process.env.QA_REPORTS_DIR,
          `${scenarioName}.metrics.json`
        )
      : '',

    path.join(
      root,
      'reports',
      `${scenarioName}.metrics.json`
    ),
  ].filter(Boolean);

  const transcriptCandidates = [
    runDir ? path.join(runDir, 'transcripts', `${scenarioName}.transcript.json`) : '',
    process.env.QA_REPORTS_DIR
      ? path.join(
          process.env.QA_REPORTS_DIR,
          'transcripts',
          `${scenarioName}.transcript.json`
        )
      : '',

    path.join(
      root,
      'reports',
      'transcripts',
      `${scenarioName}.transcript.json`
    ),
  ].filter(Boolean);

  const metricsPath =
    metricsCandidates.find(
      fs.existsSync
    );

  const transcriptPath =
    transcriptCandidates.find(
      fs.existsSync
    );

  const metrics =
    readJson(metricsPath) ||
    {};

  const transcript =
    readJson(transcriptPath) ||
    metrics.transcript ||
    [];

  const validations =
    Array.isArray(
      metrics.validations
    ) &&
    metrics.validations.length
      ? metrics.validations
      : transcript
          .filter(
            item =>
              item.type ===
              'llm_judge'
          )
          .map(
            item =>
              item.judgement
          )
          .filter(Boolean);

  const passedCount =
    validations.filter(
      item =>
        item.passed === true
    ).length;

  const failedCount =
    validations.filter(
      item =>
        item.passed === false
    ).length;

  const tokenEvents =
    Array.isArray(
      metrics.tokenEvents
    )
      ? metrics.tokenEvents
      : [];

  const tokenUsage =
    calculateTokenUsage(
      metrics
    );

  const totalTokens =
    tokenUsage.totalTokens;

  const plannerTokens = tokenEvents
    .filter(event => /planner/i.test(String(event.stage || event.turn || '')))
    .reduce((sum, event) => sum + Number(event.totalTokenCount || 0), 0);
  const judgeTokens = tokenEvents
    .filter(event => /judge/i.test(String(event.stage || event.turn || '')))
    .reduce((sum, event) => sum + Number(event.totalTokenCount || 0), 0);
  const averageTokensPerCall = tokenUsage.apiCalls
    ? Math.round(totalTokens / tokenUsage.apiCalls)
    : 0;

  const frameworkStatus =
    String(
      process.env.QA_LIFECYCLE_STATUS ||
      'UNKNOWN'
    ).toUpperCase();

  /*
   * A lack of generative validations is reported as UNKNOWN rather
   * than automatically marking the application as failed.
   */
  const applicationStatus =
    validations.length === 0
      ? 'UNKNOWN'
      : failedCount === 0
        ? 'PASS'
        : 'FAIL';

  const applicationPassed =
    applicationStatus ===
    'PASS';

  const screenshots =
    collectAllScreenshots(
      metrics
    );

  const videos = collectVideos();
  const videoCards = buildVideoCards(videos);

  const visualComparisons =
    Array.isArray(
      metrics.visualComparisons
    )
      ? metrics.visualComparisons
      : [];

  const frameworkName =
    process.env.QA_FRAMEWORK_NAME ||
    'Agentic QA Orchestrator';

  const brandName =
    process.env.BRAND ||
    process.env.QA_BRAND ||
    metrics.brand ||
    'Unknown brand';

  const botName =
    process.env.BOT_NAME ||
    process.env.QA_BOT_NAME ||
    metrics.botName ||
    'Chatbot';

  const turns =
    validations
      .map((item, index) => {
        const action = item.customerAction || {};
        const customerText = item.userMessage || action.value || action.label || `${action.action || 'Action'} ${action.targetId || ''}`.trim();
        const botText = item.botResponse || (Array.isArray(item.botMessages) ? item.botMessages.join('\n') : '') || 'No new bot message was captured for this validation.';
        const verdict = item.goalStatus || item.detectedState || (item.passed ? 'IN_PROGRESS' : 'FAILED');
        const evidence = Array.isArray(item.evidence) ? item.evidence : [];
        const issues = Array.isArray(item.issues) ? item.issues : [];
        const llm = item.llm || {};
        const searchable = [customerText, botText, item.reason, verdict, ...evidence].join(' ').toLowerCase();
        return `
          <article class="turn ${statusClass(item.passed)}" data-status="${item.passed ? 'pass' : 'fail'}" data-search="${escapeHtml(searchable)}">
            <div class="turn-head">
              <div>
                <h3>Business checkpoint ${index + 1}</h3>
                <p class="muted">${escapeHtml(action.scope || 'CHAT')} · ${escapeHtml(action.action || 'VALIDATE')} ${action.label ? `· ${escapeHtml(action.label)}` : ''}</p>
              </div>
              <span class="badge ${statusClass(item.passed)}">${escapeHtml(verdict)} · ${Number(item.score || 0).toFixed(2)}</span>
            </div>

            <div class="conversation-grid">
              <div class="bubble user">
                <b>Customer sent / selected</b>
                <p>${escapeHtml(customerText) || '<em>No customer action text captured</em>'}</p>
              </div>
              <div class="bubble bot">
                <b>${escapeHtml(botName)} response</b>
                <p>${escapeHtml(botText).replace(/\n/g, '<br>')}</p>
              </div>
            </div>

            <div class="verdict-box ${item.passed ? 'ok' : 'bad'}">
              <strong>${item.passed ? 'Why this was accepted' : 'Why this needs attention'}</strong>
              <p>${escapeHtml(item.reason || item.summary || 'No judge explanation was recorded.')}</p>
            </div>

            <div class="judge-grid">
              <div><span>Expected progress</span><strong>${escapeHtml(item.expectedIntent || '-')}</strong></div>
              <div><span>Progress made</span><strong>${item.madeProgress === false ? 'No' : 'Yes'}</strong></div>
              <div><span>Scenario complete</span><strong>${item.complete ? 'Yes' : 'No'}</strong></div>
            </div>

            ${evidence.length ? `<details open><summary>Evidence used by the judge</summary><ul>${evidence.map(value => `<li>${escapeHtml(value)}</li>`).join('')}</ul></details>` : '<p class="muted">No explicit evidence list was recorded.</p>'}
            ${issues.length ? `<details open><summary>Issues</summary><ul>${issues.map(value => `<li>${escapeHtml(value)}</li>`).join('')}</ul></details>` : ''}

            <details>
              <summary>Technical details: state delta and LLM request/response</summary>
              <h4>State settling evidence</h4>
              <pre>${escapeHtml(JSON.stringify(item.settleEvidence || {}, null, 2))}</pre>
              <h4>State changes</h4>
              <pre>${escapeHtml(JSON.stringify(item.stateDelta || {}, null, 2))}</pre>
              <h4>Data sent to the judge</h4>
              <pre>${escapeHtml(llm.requestPayload || 'Not recorded')}</pre>
              <h4>Raw judge response</h4>
              <pre>${escapeHtml(llm.responsePayload || 'Not recorded')}</pre>
            </details>
          </article>`;
      })
      .join('\n') || `
        <section class="panel">
          <h2>No generative validations found</h2>
          <p>No LLM-judge validation records were present. Application status is UNKNOWN.</p>
        </section>`;

  const tokenRows =
    tokenEvents
      .map(
        event => `
          <tr data-token-stage="${escapeHtml(String(event.stage || event.turn || 'LLM').toLowerCase())}">
            <td>${escapeHtml(event.stage || event.turn || 'LLM')}</td>
            <td>${escapeHtml(event.turn ?? '-')}</td>
            <td>${escapeHtml(event.model || metrics.model || '-')}</td>
            <td>${Number(event.temperature ?? metrics.llmTemperature ?? 0).toFixed(2)}</td>
            <td>${shortNumber(event.promptTokenCount)}</td>
            <td>${shortNumber(event.candidatesTokenCount)}</td>
            <td>${shortNumber(event.cachedContentTokenCount)}</td>
            <td>${shortNumber(event.totalTokenCount)}</td>
            <td>${escapeHtml(event.finishReason || '-')}</td>
          </tr>
        `
      )
      .join('');

  const screenshotCards =
    buildScreenshotCards(
      screenshots
    );

  const visualCards =
    buildVisualComparisonCards(
      visualComparisons
    );

  const summaryText =
    `Framework: ${frameworkName}\n` +
    `Brand: ${brandName}\n` +
    `Bot: ${botName}\n` +
    `Scenario: ${scenarioName}\n` +
    `Lifecycle: ${frameworkStatus}\n` +
    `Application: ${applicationStatus}\n` +
    `Validations: ${validations.length}\n` +
    `Screenshots: ${screenshots.length}\n` +
    `Visual comparisons: ${visualComparisons.length}\n` +
    `Total tokens: ${totalTokens}\n` +
    `Gemini API calls: ${tokenUsage.apiCalls}`;

  const html = `
<!doctype html>
<html>
<head>
  <meta charset="utf-8">

  <meta
    name="viewport"
    content="width=device-width,initial-scale=1"
  >

  <title>
    ${escapeHtml(
      botName
    )}
    Generative QA Report
  </title>

  <style>
    :root {
      --bg: #f5f7fb;
      --panel: #ffffff;
      --text: #172033;
      --muted: #667085;
      --border: #e4e7ec;
      --pass: #15803d;
      --fail: #dc2626;
      --info: #2563eb;
    }

    body.dark {
      --bg: #0b1220;
      --panel: #111827;
      --text: #e5e7eb;
      --muted: #9ca3af;
      --border: #253247;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family:
        Inter,
        system-ui,
        sans-serif;
    }

    .hero {
      padding: 30px;
      color: #ffffff;
      background:
        linear-gradient(
          135deg,
          #0f9d58,
          #00a3ff 48%,
          #7c3aed
        );
    }

    .hero-inner,
    .container {
      max-width: 1400px;
      margin: auto;
    }

    .hero-inner {
      display: flex;
      justify-content: space-between;
      gap: 20px;
    }

    .hero h1 {
      margin: 0 0 8px;
      font-size: 34px;
    }

    .actions button {
      border: 0;
      border-radius: 999px;
      padding: 10px 14px;
      color: #ffffff;
      background: #ffffff2d;
      font-weight: 700;
      cursor: pointer;
    }

    .container {
      padding: 20px;
    }

    .cards {
      display: grid;
      grid-template-columns:
        repeat(
          6,
          minmax(0, 1fr)
        );
      gap: 14px;
      margin-top: -38px;
    }

    .card,
    .panel,
    .turn,
    .visual-comparison {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 18px;
      box-shadow:
        0 12px 34px
        #0f172a12;
    }

    .card {
      padding: 18px;
    }

    .card span,
    .judge-grid span {
      color: var(--muted);
      font-size: 13px;
      display: block;
    }

    .card strong {
      font-size: 24px;
    }

    .panel,
    .turn,
    .visual-comparison {
      padding: 22px;
      margin: 18px 0;
    }

    .turn {
      border-left:
        6px solid
        var(--info);
    }

    .turn.pass {
      border-left-color:
        var(--pass);
    }

    .turn.fail {
      border-left-color:
        var(--fail);
    }

    .turn-head,
    .visual-header {
      display: flex;
      justify-content:
        space-between;
      gap: 12px;
      align-items: center;
    }

    .badge {
      padding: 7px 11px;
      border-radius: 999px;
      color: #ffffff;
      font-weight: 800;
    }

    .badge.pass {
      background: var(--pass);
    }

    .badge.fail {
      background: var(--fail);
    }

    .badge.info {
      background: var(--info);
    }

    .bubble {
      padding: 14px 16px;
      border-radius: 14px;
      margin: 12px 0;
    }

    .bubble.user {
      background: #eaf2ff;
    }

    .dark .bubble.user {
      background: #172554;
    }

    .bubble.bot {
      background: #eefbf3;
    }

    .dark .bubble.bot {
      background: #052e16;
    }

    .judge-grid {
      display: grid;
      grid-template-columns:
        repeat(
          4,
          minmax(0, 1fr)
        );
      gap: 10px;
    }

    .judge-grid div {
      padding: 12px;
      border:
        1px solid
        var(--border);
      border-radius: 12px;
    }

    .summary {
      font-weight: 650;
    }

    .muted { color: var(--muted); margin: 4px 0; }
    .conversation-grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
    .verdict-box { margin:14px 0; padding:14px 16px; border-radius:12px; border-left:5px solid var(--info); background:#eff6ff; }
    .verdict-box.ok { border-left-color:var(--pass); background:#f0fdf4; }
    .verdict-box.bad { border-left-color:var(--fail); background:#fef2f2; }
    .dark .verdict-box { background:#172033; }
    .toolbar { display:flex; flex-wrap:wrap; gap:10px; margin:18px 0; }
    .toolbar input, .toolbar select, .toolbar button { padding:10px 12px; border:1px solid var(--border); border-radius:10px; background:var(--panel); color:var(--text); }
    .toolbar input { min-width:300px; flex:1; }
    .token-bar { height:12px; border-radius:999px; overflow:hidden; display:flex; background:var(--border); margin:12px 0 4px; }
    .token-bar .planner { background:#2563eb; }
    .token-bar .judge { background:#7c3aed; }
    details { margin-top:12px; }
    summary { cursor:pointer; font-weight:700; }

    .tokens {
      width: 100%;
      border-collapse: collapse;
    }

    .tokens th,
    .tokens td {
      padding: 10px;
      border-bottom:
        1px solid
        var(--border);
      text-align: left;
    }

    .shots {
      display: grid;
      grid-template-columns:
        repeat(
          3,
          minmax(0, 1fr)
        );
      gap: 14px;
    }

    .shot {
      margin: 0;
      border:
        1px solid
        var(--border);
      border-radius: 14px;
      overflow: hidden;
      background: var(--panel);
    }

    .shot img {
      display: block;
      width: 100%;
      height: auto;
    }

    .shot figcaption {
      display: grid;
      gap: 4px;
      padding: 10px;
      color: var(--muted);
      font-size: 13px;
      word-break: break-word;
    }

    .shot figcaption strong {
      color: var(--text);
    }

    .visual-images {
      display: grid;
      grid-template-columns:
        repeat(
          4,
          minmax(0, 1fr)
        );
      gap: 12px;
      margin-top: 16px;
    }

    .visual-image {
      margin: 0;
    }

    .visual-image img {
      display: block;
      width: 100%;
      border-radius: 12px;
      border:
        1px solid
        var(--border);
    }

    .visual-image figcaption {
      padding: 7px 2px;
      color: var(--muted);
    }

    pre {
      white-space: pre-wrap;
      word-break: break-word;
      background: #0b1220;
      color: #d1e7ff;
      padding: 16px;
      border-radius: 12px;
    }

    @media (
      max-width: 1000px
    ) {
      .cards {
        grid-template-columns:
          repeat(
            2,
            minmax(0, 1fr)
          );
      }

      .judge-grid {
        grid-template-columns:
          repeat(
            2,
            minmax(0, 1fr)
          );
      }

      .shots,
      .visual-images,
      .conversation-grid {
        grid-template-columns: 1fr;
      }

      .hero-inner {
        display: block;
      }
    }
  </style>
</head>

<body>
  <header class="hero">
    <div class="hero-inner">
      <div>
        <h1>
          ${escapeHtml(
            botName
          )}
          Generative QA Report
        </h1>

        <p>
          ${escapeHtml(
            frameworkName
          )}
        </p>

        <p>
          Brand:
          ${escapeHtml(
            brandName
          )}
        </p>

        <p>
          Scenario:
          ${escapeHtml(
            scenarioName
          )}
        </p>

        <p>
          Environment:
          ${escapeHtml(
            process.env.TARGET_ENV ||
            'UAT'
          )}
        </p>
      </div>

      <div class="actions">
        <button
          onclick="
            navigator.clipboard.writeText(
              document.getElementById(
                'summary'
              ).textContent
            )
          "
        >
          Copy summary
        </button>

        <button
          onclick="window.print()"
        >
          Print / Save PDF
        </button>

        <button
          onclick="
            document.body.classList.toggle(
              'dark'
            )
          "
        >
          Toggle theme
        </button>
      </div>
    </div>
  </header>

  <main class="container">
    <pre
      id="summary"
      style="display:none"
    >${escapeHtml(
      summaryText
    )}</pre>

    <section class="cards">
      <div class="card">
        <span>Framework</span>

        <strong>
          ${escapeHtml(
            frameworkStatus
          )}
        </strong>
      </div>

      <div class="card">
        <span>Application</span>

        <strong>
          ${escapeHtml(
            applicationStatus
          )}
        </strong>
      </div>

      <div class="card">
        <span>Validations</span>

        <strong>
          ${validations.length}
        </strong>
      </div>

      <div class="card">
        <span>Passed / Failed</span>

        <strong>
          ${passedCount}
          /
          ${failedCount}
        </strong>
      </div>

      <div class="card">
        <span>Screenshots</span>

        <strong>
          ${screenshots.length}
        </strong>
      </div>

      <div class="card">
        <span>Videos</span>
        <strong>${videos.length}</strong>
      </div>

      <div class="card">
        <span>Total tokens</span>

        <strong>
          ${shortNumber(
            totalTokens
          )}
        </strong>
      </div>
    </section>

    <section class="panel">
      <h2>Conversation and validation journey</h2>
      <p>Each checkpoint shows what the customer sent or selected, what ${escapeHtml(botName)} returned, and why the judge accepted or rejected the response.</p>
      <div class="toolbar">
        <input id="turnSearch" type="search" placeholder="Search customer messages, bot responses or evidence..." oninput="filterTurns()">
        <select id="statusFilter" onchange="filterTurns()">
          <option value="all">All checkpoints</option>
          <option value="pass">Passed / in progress</option>
          <option value="fail">Failed</option>
        </select>
        <button onclick="toggleTechnical()">Expand / collapse technical details</button>
      </div>
    </section>

    <div id="turnsContainer">${turns}</div>

    <section class="panel token-total-footer">
      <h2>Total LLM usage</h2>
      <p class="muted">Combined Gemini usage for the complete run. Per-request token details are retained in the metrics JSON but intentionally hidden from this business report.</p>
      <div class="total-token-value">${shortNumber(totalTokens)} tokens</div>
    </section>

    <section class="panel">
      <h2>Video recording (${videos.length})</h2>
      <div class="shots">${videoCards}</div>
    </section>

    <section class="panel">
      <h2>
        Screenshots
        (${screenshots.length})
      </h2>

      <p>
        This section includes registered screenshots and images
        discovered from the execution evidence directories.
      </p>

      <div class="shots">
        ${screenshotCards}
      </div>
    </section>

    <section class="panel">
      <h2>
        Visual differences
      </h2>

      <p>
        Pixel differences are informational and do not fail the
        functional scenario.
      </p>

      ${visualCards}
    </section>

    <section class="panel">
      <h2>
        Evidence files
      </h2>

      <p>
        Metrics:
        ${escapeHtml(
          metricsPath ||
          'Not found'
        )}
      </p>

      <p>
        Transcript:
        ${escapeHtml(
          transcriptPath ||
          'Not found'
        )}
      </p>

      <details>
        <summary>
          Raw metrics
        </summary>

        <pre>${escapeHtml(
          JSON.stringify(
            metrics,
            null,
            2
          )
        )}</pre>
      </details>
    </section>
  </main>
  <script>
    function filterTurns() {
      const query = (document.getElementById('turnSearch')?.value || '').toLowerCase();
      const status = document.getElementById('statusFilter')?.value || 'all';
      document.querySelectorAll('#turnsContainer .turn').forEach(card => {
        const matchesText = !query || (card.dataset.search || '').includes(query);
        const matchesStatus = status === 'all' || card.dataset.status === status;
        card.style.display = matchesText && matchesStatus ? '' : 'none';
      });
    }
    function toggleTechnical() {
      const details = [...document.querySelectorAll('#turnsContainer details')];
      const shouldOpen = details.some(item => !item.open);
      details.forEach(item => { item.open = shouldOpen; });
    }
  </script>
</body>
</html>
`;

  fs.writeFileSync(
    outputPath,
    html,
    'utf8'
  );

  console.log(
    `Shareable generative report created: ${outputPath}`
  );

  console.log(
    `Screenshots included: ${screenshots.length}`
  );

  console.log(
    `Videos included: ${videos.length}`
  );

  console.log(
    `Visual comparisons included: ${visualComparisons.length}`
  );
}

const inferredGenerative = scenarioType === 'generative' || Boolean(
  readJson(runDir ? path.join(runDir, `${scenarioName}.metrics.json`) : '')?.judgements
);

if (inferredGenerative) {
  buildGenerativeReport();
} else {
  const legacy =
    path.join(
      __dirname,
      'build-helpcenter-report.js'
    );

  if (
    !fs.existsSync(legacy)
  ) {
    throw new Error(
      `Missing legacy report builder: ${legacy}`
    );
  }

  const result =
    spawnSync(
      process.execPath,
      [
        legacy,
        reportName,
      ],
      {
        cwd: root,
        stdio: 'inherit',
        env: process.env,
      }
    );

  process.exit(
    Number.isInteger(
      result.status
    )
      ? result.status
      : 1
  );
}
