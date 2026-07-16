const fs = require('fs');
function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function pct(value, total) {
  if (!total) return '0%';
  return `${Math.round((value / total) * 100)}%`;
}

function avg(values) {
  const valid = values.filter(v => typeof v === 'number' && !Number.isNaN(v));
  if (!valid.length) return 0;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

function ms(value) {
  if (!value && value !== 0) return '-';
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(2)}s`;
}

function imageFromPath(filePath, label) {
  if (!filePath) return '';

  try {
    if (!fs.existsSync(filePath)) {
      return `<div class="image-card"><h4>${escapeHtml(label)}</h4><p>Image not found: ${escapeHtml(filePath)}</p></div>`;
    }

    const base64 = fs.readFileSync(filePath, 'base64');

    return `
      <div class="image-card">
        <h4>${escapeHtml(label)}</h4>
        <img src="data:image/png;base64,${base64}" />
        <p class="small">${escapeHtml(filePath)}</p>
      </div>
    `;
  } catch (error) {
    return `<div class="image-card"><h4>${escapeHtml(label)}</h4><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function renderStatus(status) {
  const normalised = String(status || '').toUpperCase();
  if (normalised === 'SUCCESS' || normalised === 'PASSED') return '<span class="badge pass">PASS</span>';
  if (normalised === 'FAILED' || normalised === 'ERROR') return '<span class="badge fail">FAIL</span>';
  return `<span class="badge neutral">${escapeHtml(status || 'UNKNOWN')}</span>`;
}

function generateHtmlReport(input = {}) {
  const metrics = input.metrics || {};
  const steps = metrics.steps || input.steps || [];
  const validations = metrics.validations || [];
  const tokenEvents = metrics.tokenEvents || [];
  const screenshots = metrics.screenshots || input.screenshots || [];
  const visualComparisons = metrics.visualComparisons || [];
  const startedAt = metrics.startedAt || new Date().toISOString();
  const endedAt = metrics.endedAt || new Date().toISOString();

  const totalSteps = steps.length;
  const passedSteps = steps.filter(s => ['SUCCESS', 'PASSED'].includes(String(s.status).toUpperCase())).length;
  const failedSteps = steps.filter(s => ['FAILED', 'ERROR'].includes(String(s.status).toUpperCase())).length;

  const judgeScores = validations.map(v => Number(v.score)).filter(v => !Number.isNaN(v));
  const avgJudgeScore = avg(judgeScores);
  const minJudgeScore = judgeScores.length ? Math.min(...judgeScores) : 0;
  const maxJudgeScore = judgeScores.length ? Math.max(...judgeScores) : 0;

  const durationMs = metrics.durationMs || Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime());
  const totalTokens = metrics.totalTokens || tokenEvents.reduce((sum, t) => sum + Number(t.totalTokenCount || 0), 0);

  const toolDurations = steps.map(s => Number(s.durationMs)).filter(v => !Number.isNaN(v));
  const avgToolDuration = avg(toolDurations);

  const validationRows = validations.map((v, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${escapeHtml(v.expectedIntent)}</td>
      <td>${escapeHtml(v.userMessage)}</td>
      <td>${escapeHtml(v.botResponse)}</td>
      <td>${Number(v.score || 0).toFixed(2)}</td>
      <td>${renderStatus(v.passed ? 'PASSED' : 'FAILED')}</td>
      <td>${escapeHtml(v.intentMatched)}</td>
      <td>${escapeHtml(v.safe)}</td>
      <td>${escapeHtml(v.hallucinationRisk)}</td>
      <td>${escapeHtml(v.summary)}</td>
    </tr>
  `).join('');

  const stepRows = steps.map((s, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${escapeHtml(s.name)}</td>
      <td>${renderStatus(s.status)}</td>
      <td>${ms(s.durationMs)}</td>
      <td>${escapeHtml(s.tokenCount ?? '-')}</td>
      <td><pre>${escapeHtml(s.argsPreview || '')}</pre></td>
      <td><pre>${escapeHtml(s.outputPreview || '')}</pre></td>
    </tr>
  `).join('');

  const tokenRows = tokenEvents.map((t, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${escapeHtml(t.turn)}</td>
      <td>${escapeHtml(t.promptTokenCount ?? '-')}</td>
      <td>${escapeHtml(t.candidatesTokenCount ?? '-')}</td>
      <td>${escapeHtml(t.totalTokenCount ?? '-')}</td>
    </tr>
  `).join('');

  const visualComparisonHtml = visualComparisons.map((v, index) => {
    const hasDiff = Boolean(v.hasDifference || v.diffPath || v.overlayPath);

    return `
      <section class="visual-card ${v.passed ? 'ok' : 'bad'}">
        <div class="card-header">
          <h3>Visual Comparison ${index + 1}: ${escapeHtml(v.name || 'visual-check')}</h3>
          ${renderStatus(v.passed ? 'PASSED' : 'FAILED')}
        </div>

        <div class="metric-line">
          <span>Has difference: <b>${escapeHtml(hasDiff)}</b></span>
          <span>Mismatch pixels: <b>${escapeHtml(v.mismatchPixels ?? 0)}</b></span>
          <span>Mismatch ratio: <b>${Number(v.mismatchRatio || 0).toFixed(5)}</b></span>
          <span>Allowed ratio: <b>${Number(v.maxMismatchRatio || 0).toFixed(5)}</b></span>
          <span>Baseline size: <b>${escapeHtml(v.baselineSize || '-')}</b></span>
          <span>Actual size: <b>${escapeHtml(v.actualSize || '-')}</b></span>
          <span>Compared size: <b>${escapeHtml(v.comparedSize || '-')}</b></span>
          <span>Dimension mismatch: <b>${escapeHtml(v.dimensionMismatch || false)}</b></span>
        </div>

        <p>${escapeHtml(v.reason || '')}</p>

        <div class="visual-grid ${hasDiff ? 'four' : 'two'}">
          ${imageFromPath(v.baselinePath, 'Baseline')}
          ${imageFromPath(v.actualPath, 'Actual')}
          ${hasDiff ? imageFromPath(v.diffPath, 'Pixel Diff') : ''}
          ${hasDiff ? imageFromPath(v.overlayPath, 'Highlighted Overlay') : ''}
        </div>
      </section>
    `;
  }).join('');

  const screenshotHtml = screenshots.map(s => `
    <div class="screenshot-card">
      <h3>${escapeHtml(s.label || 'Screenshot')}</h3>
      ${s.base64 ? `<img src="data:image/png;base64,${s.base64}" />` : `<p>${escapeHtml(s.path || '')}</p>`}
    </div>
  `).join('');

  const validationCards = validations.map((v, index) => `
    <section class="validation-card ${v.passed ? 'ok' : 'bad'}">
      <div class="card-header">
        <h3>Turn ${index + 1}: ${escapeHtml(v.expectedIntent)}</h3>
        ${renderStatus(v.passed ? 'PASSED' : 'FAILED')}
      </div>
      <div class="grid two">
        <div>
          <h4>User message</h4>
          <pre>${escapeHtml(v.userMessage)}</pre>
        </div>
        <div>
          <h4>Olive response</h4>
          <pre>${escapeHtml(v.botResponse)}</pre>
        </div>
      </div>
      <div class="metric-line">
        <span>Score: <b>${Number(v.score || 0).toFixed(2)}</b></span>
        <span>Intent matched: <b>${escapeHtml(v.intentMatched)}</b></span>
        <span>Safe: <b>${escapeHtml(v.safe)}</b></span>
        <span>Hallucination risk: <b>${escapeHtml(v.hallucinationRisk)}</b></span>
      </div>
      <p>${escapeHtml(v.summary)}</p>
      ${(v.issues || []).length ? `<h4>Issues</h4><ul>${v.issues.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : ''}
      ${(v.missing || []).length ? `<h4>Missing</h4><ul>${v.missing.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : ''}
      ${(v.evidence || []).length ? `<h4>Evidence</h4><ul>${v.evidence.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : ''}
    </section>
  `).join('');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(metrics.scenarioName || input.scenarioName || 'Olive QA Report')}</title>
  <style>
    body {
      margin: 0;
      font-family: Arial, Helvetica, sans-serif;
      background: #f6f7f9;
      color: #1f2937;
    }
    header {
      background: #0b3d2e;
      color: white;
      padding: 28px 36px;
    }
    header h1 {
      margin: 0 0 8px;
      font-size: 28px;
    }
    header p {
      margin: 4px 0;
      color: #d1fae5;
    }
    main {
      padding: 28px 36px 60px;
    }
    .grid {
      display: grid;
      gap: 16px;
    }
    .grid.cards {
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
      margin-bottom: 24px;
    }
    .grid.two {
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    }
    .metric-card {
      background: white;
      padding: 18px;
      border-radius: 14px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.08);
      border-left: 5px solid #138a36;
    }
    .metric-card h2 {
      margin: 0;
      font-size: 28px;
    }
    .metric-card p {
      margin: 8px 0 0;
      color: #6b7280;
    }
    section {
      background: white;
      border-radius: 14px;
      padding: 20px;
      margin: 20px 0;
      box-shadow: 0 1px 4px rgba(0,0,0,0.08);
    }
    .validation-card.ok {
      border-left: 5px solid #16a34a;
    }
    .validation-card.bad {
      border-left: 5px solid #dc2626;
    }
    .card-header {
      display: flex;
      justify-content: space-between;
      gap: 20px;
      align-items: center;
    }
    h2, h3, h4 {
      margin-top: 0;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th {
      text-align: left;
      background: #e5e7eb;
      padding: 10px;
    }
    td {
      border-top: 1px solid #e5e7eb;
      vertical-align: top;
      padding: 10px;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: Menlo, Consolas, monospace;
      font-size: 12px;
      max-height: 240px;
      overflow: auto;
      background: #f9fafb;
      padding: 10px;
      border-radius: 8px;
    }
    .badge {
      display: inline-block;
      padding: 5px 9px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: bold;
    }
    .badge.pass {
      background: #dcfce7;
      color: #166534;
    }
    .badge.fail {
      background: #fee2e2;
      color: #991b1b;
    }
    .badge.neutral {
      background: #e5e7eb;
      color: #374151;
    }
    .metric-line {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin: 14px 0;
    }
    .metric-line span {
      background: #f3f4f6;
      padding: 8px 10px;
      border-radius: 8px;
    }
    .visual-grid {
      display: grid;
      gap: 16px;
      margin-top: 16px;
    }
    .visual-grid.two {
      grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
    }
    .visual-grid.four {
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    }
    .image-card {
      background: #f9fafb;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      padding: 12px;
    }
    .visual-card.ok {
      border-left: 5px solid #16a34a;
    }
    .visual-card.bad {
      border-left: 5px solid #dc2626;
    }
    img {
      max-width: 100%;
      border-radius: 10px;
      border: 1px solid #e5e7eb;
    }
    .small {
      color: #6b7280;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(metrics.scenarioName || input.scenarioName || 'Olive Generative QA Report')}</h1>
    <p>Platform: ${escapeHtml(metrics.platform || '-')} | Target: ${escapeHtml(metrics.executionTarget || '-')} | Model: ${escapeHtml(metrics.model || '-')}</p>
    <p>Started: ${escapeHtml(startedAt)} | Ended: ${escapeHtml(endedAt)} | Duration: ${ms(durationMs)}</p>
    <p>URL: ${escapeHtml(metrics.targetUrl || '-')}</p>
  </header>

  <main>
    <div class="grid cards">
      <div class="metric-card"><h2>${totalSteps}</h2><p>Total tool/agent turns</p></div>
      <div class="metric-card"><h2>${passedSteps}</h2><p>Passed turns (${pct(passedSteps, totalSteps)})</p></div>
      <div class="metric-card"><h2>${failedSteps}</h2><p>Failed turns (${pct(failedSteps, totalSteps)})</p></div>
      <div class="metric-card"><h2>${validations.length}</h2><p>LLM judge validations</p></div>
      <div class="metric-card"><h2>${avgJudgeScore.toFixed(2)}</h2><p>Average judge score</p></div>
      <div class="metric-card"><h2>${minJudgeScore.toFixed(2)}</h2><p>Minimum judge score</p></div>
      <div class="metric-card"><h2>${maxJudgeScore.toFixed(2)}</h2><p>Maximum judge score</p></div>
      <div class="metric-card"><h2>${ms(avgToolDuration)}</h2><p>Average tool duration</p></div>
      <div class="metric-card"><h2>${totalTokens}</h2><p>Total Gemini tokens recorded</p></div>
    </div>

    <section>
      <h2>Run Metadata</h2>
      <table>
        <tr><th>Field</th><th>Value</th></tr>
        <tr><td>Scenario</td><td>${escapeHtml(metrics.scenarioName || '-')}</td></tr>
        <tr><td>Generated spec path</td><td>${escapeHtml(metrics.savedSpecPath || '-')}</td></tr>
        <tr><td>Metrics JSON path</td><td>${escapeHtml(metrics.metricsJsonPath || '-')}</td></tr>
        <tr><td>Transcript JSON path</td><td>${escapeHtml(metrics.transcriptJsonPath || '-')}</td></tr>
        <tr><td>LLM auth mode</td><td>${escapeHtml(metrics.llmAuthMode || '-')}</td></tr>
        <tr><td>Headless</td><td>${escapeHtml(metrics.headless)}</td></tr>
      </table>
    </section>

    <section>
      <h2>LLM Judge Summary</h2>
      ${validationCards || '<p>No LLM validations were recorded.</p>'}
    </section>

    <section>
      <h2>LLM Judge Table</h2>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Expected intent</th>
            <th>User message</th>
            <th>Olive response</th>
            <th>Score</th>
            <th>Status</th>
            <th>Intent</th>
            <th>Safe</th>
            <th>Hallucination</th>
            <th>Summary</th>
          </tr>
        </thead>
        <tbody>${validationRows || '<tr><td colspan="10">No validation rows.</td></tr>'}</tbody>
      </table>
    </section>

    <section>
      <h2>Step Metrics</h2>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Tool / action</th>
            <th>Status</th>
            <th>Duration</th>
            <th>Tokens</th>
            <th>Arguments</th>
            <th>Output preview</th>
          </tr>
        </thead>
        <tbody>${stepRows || '<tr><td colspan="7">No steps recorded.</td></tr>'}</tbody>
      </table>
    </section>

    <section>
      <h2>Token Usage</h2>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Turn</th>
            <th>Prompt tokens</th>
            <th>Candidate tokens</th>
            <th>Total tokens</th>
          </tr>
        </thead>
        <tbody>${tokenRows || '<tr><td colspan="5">No token usage was returned by the model SDK.</td></tr>'}</tbody>
      </table>
    </section>

    <section>
      <h2>Visual Comparisons</h2>
      ${visualComparisonHtml || '<p>No visual comparisons were recorded.</p>'}
    </section>

    <section>
      <h2>Screenshots</h2>
      ${screenshotHtml || '<p>No screenshots attached to this report.</p>'}
    </section>
  </main>
</body>
</html>`;
}

module.exports = { generateHtmlReport };
