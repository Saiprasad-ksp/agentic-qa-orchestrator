'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const reportName = process.argv[2] || 'qa-report';
const scenarioName = process.env.QA_SCENARIO_NAME || reportName.replace(/-report$/, '');
const scenarioType = String(process.env.QA_SCENARIO_TYPE || '').toLowerCase();
const outputDir = path.join(root, 'reports', 'shareable');
const outputPath = path.join(outputDir, `${reportName}.html`);
fs.mkdirSync(outputDir, { recursive: true });

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}
function normaliseFilePath(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (!value || typeof value !== 'object') {
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

function calculateTokenUsage(metrics = {}) {
  const events = Array.isArray(metrics.tokenEvents)
    ? metrics.tokenEvents
    : [];

  const toNumber = value => {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  };

  const totals = events.reduce(
    (result, event) => {
      const promptTokens = toNumber(
        event.promptTokenCount ??
        event.promptTokens ??
        event.inputTokenCount
      );

      const candidateTokens = toNumber(
        event.candidatesTokenCount ??
        event.candidateTokenCount ??
        event.outputTokenCount ??
        event.completionTokenCount
      );

      const cachedTokens = toNumber(
        event.cachedContentTokenCount ??
        event.cachedTokenCount
      );

      /*
       * totalTokenCount is the usage for this individual API call.
       * It is not the cumulative total for the complete test run.
       */
      const eventTotal = toNumber(
        event.totalTokenCount
      ) || promptTokens + candidateTokens;

      result.promptTokens += promptTokens;
      result.candidateTokens += candidateTokens;
      result.cachedTokens += cachedTokens;
      result.totalTokens += eventTotal;
      result.peakRequestTokens = Math.max(
        result.peakRequestTokens,
        eventTotal
      );
      result.apiCalls += 1;

      return result;
    },
    {
      promptTokens: 0,
      candidateTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      peakRequestTokens: 0,
      apiCalls: 0,
    }
  );

  return totals;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('en-AU');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
}
function statusClass(passed) { return passed ? 'pass' : 'fail'; }
function shortNumber(value) { return Number(value || 0).toLocaleString(); }


function imageToDataUri(value) {
  const filePath = normaliseFilePath(value);

  if (!filePath || !fs.existsSync(filePath)) {
    return '';
  }

  const extension = path.extname(filePath).toLowerCase();

  const mimeTypes = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  };

  const mimeType = mimeTypes[extension];

  if (!mimeType) {
    return '';
  }

  const encoded = fs.readFileSync(filePath).toString('base64');

  return `data:${mimeType};base64,${encoded}`;
}

function calculateTokenUsage(metrics = {}) {
  const events = Array.isArray(metrics.tokenEvents)
    ? metrics.tokenEvents
    : [];

  const number = value => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  return events.reduce(
    (totals, event) => {
      const promptTokens = number(
        event.promptTokenCount ??
        event.promptTokens ??
        event.inputTokenCount
      );

      const outputTokens = number(
        event.candidatesTokenCount ??
        event.candidateTokenCount ??
        event.outputTokenCount ??
        event.completionTokenCount
      );

      const cachedTokens = number(
        event.cachedContentTokenCount ??
        event.cachedTokenCount
      );

      const requestTotal =
        number(event.totalTokenCount) ||
        promptTokens + outputTokens;

      totals.promptTokens += promptTokens;
      totals.outputTokens += outputTokens;
      totals.cachedTokens += cachedTokens;
      totals.totalTokens += requestTotal;
      totals.peakRequestTokens = Math.max(
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

function buildGenerativeReport() {
  const metricsCandidates = [
    process.env.QA_REPORTS_DIR ? path.join(process.env.QA_REPORTS_DIR, `${scenarioName}.metrics.json`) : '',
    path.join(root, 'reports', `${scenarioName}.metrics.json`),
  ].filter(Boolean);
  const transcriptCandidates = [
    process.env.QA_REPORTS_DIR ? path.join(process.env.QA_REPORTS_DIR, 'transcripts', `${scenarioName}.transcript.json`) : '',
    path.join(root, 'reports', 'transcripts', `${scenarioName}.transcript.json`),
  ].filter(Boolean);
  const metricsPath = metricsCandidates.find(fs.existsSync);
  const transcriptPath = transcriptCandidates.find(fs.existsSync);
  const metrics = readJson(metricsPath) || {};
  const transcript = readJson(transcriptPath) || metrics.transcript || [];
  const validations = metrics.validations || transcript.filter(item => item.type === 'llm_judge').map(item => item.judgement).filter(Boolean);
  const passedCount = validations.filter(item => item.passed).length;
  const failedCount = validations.length - passedCount;
  const tokenEvents = Array.isArray(metrics.tokenEvents)
    ? metrics.tokenEvents
    : [];

  const tokenUsage = calculateTokenUsage(metrics);
  const totalTokens = tokenUsage.totalTokens;
  const frameworkStatus = String(process.env.QA_LIFECYCLE_STATUS || 'UNKNOWN').toUpperCase();
  const applicationPassed = validations.length > 0 && failedCount === 0;
  const screenshots = Array.isArray(metrics.screenshots)
    ? metrics.screenshots
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

  const turns = validations.map((item, index) => `
    <article class="turn ${statusClass(item.passed)}">
      <div class="turn-head"><h3>Conversation validation ${index + 1}</h3><span class="badge ${statusClass(item.passed)}">${item.passed ? 'PASS' : 'FAIL'} · ${Number(item.score || 0).toFixed(2)}</span></div>
      <div class="bubble user"><b>User</b><p>${escapeHtml(item.userMessage)}</p></div>
      <div class="bubble bot"><b>${escapeHtml(botName)}</b><p>${escapeHtml(item.botResponse).replace(/\n/g, '<br>')}</p></div>
      <div class="judge-grid">
        <div><span>Intent matched</span><strong>${item.intentMatched === false ? 'No' : 'Yes'}</strong></div>
        <div><span>Safe</span><strong>${item.safe === false ? 'No' : 'Yes'}</strong></div>
        <div><span>Detected state</span><strong>${escapeHtml(item.detectedState || '-')}</strong></div>
        <div><span>Judge mode</span><strong>${escapeHtml(item.judgeMode || 'llm')}</strong></div>
      </div>
      <p class="summary">${escapeHtml(item.summary || '')}</p>
      ${item.evidence?.length ? `<details><summary>Evidence</summary><ul>${item.evidence.map(value => `<li>${escapeHtml(value)}</li>`).join('')}</ul></details>` : ''}
      ${item.issues?.length ? `<details open><summary>Issues</summary><ul>${item.issues.map(value => `<li>${escapeHtml(value)}</li>`).join('')}</ul></details>` : ''}
      ${item.missing?.length ? `<details><summary>Missing criteria</summary><ul>${item.missing.map(value => `<li>${escapeHtml(value)}</li>`).join('')}</ul></details>` : ''}
    </article>`).join('\n') || '<section class="panel"><h2>No generative validations found</h2><p>Metrics or transcript evidence was not available.</p></section>';

  const tokenRows = tokenEvents.map(event => `<tr><td>${escapeHtml(event.turn)}</td><td>${shortNumber(event.promptTokenCount)}</td><td>${shortNumber(event.candidatesTokenCount)}</td><td>${shortNumber(event.totalTokenCount)}</td></tr>`).join('');
  const screenshotCards = screenshots
    .map(item => {
      const filePath = normaliseFilePath(item);
      const imageData = imageToDataUri(item);

      if (!filePath || !imageData) {
        return '';
      }

      return `
        <figure class="shot">
          <img
            src="${imageData}"
            alt="${escapeHtml(path.basename(filePath))}"
            loading="lazy"
          >
          <figcaption>
            ${escapeHtml(path.basename(filePath))}
          </figcaption>
        </figure>
      `;
    })
    .filter(Boolean)
    .join('') || '<p>No valid screenshots were captured.</p>';
  const summaryText =
    `Framework: ${frameworkName}\n` +
    `Brand: ${brandName}\n` +
    `Bot: ${botName}\n` +
    `Scenario: ${scenarioName}\n` +
    `Lifecycle: ${frameworkStatus}\n` +
    `Application: ${applicationPassed ? 'PASSED' : 'FAILED'}\n` +
    `Validations: ${validations.length}\n` +
    `Total tokens: ${totalTokens}\n` +
    `Gemini API calls: ${tokenUsage.apiCalls}`;

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(botName)} Generative QA Report</title>
<style>
:root{--bg:#f5f7fb;--panel:#fff;--text:#172033;--muted:#667085;--border:#e4e7ec;--pass:#15803d;--fail:#dc2626;--blue:#2563eb}body.dark{--bg:#0b1220;--panel:#111827;--text:#e5e7eb;--muted:#9ca3af;--border:#253247}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,system-ui,sans-serif}.hero{padding:30px;color:#fff;background:linear-gradient(135deg,#0f9d58,#00a3ff 48%,#7c3aed)}.hero-inner,.container{max-width:1400px;margin:auto}.hero-inner{display:flex;justify-content:space-between;gap:20px}.hero h1{margin:0 0 8px;font-size:34px}.actions button{border:0;border-radius:999px;padding:10px 14px;color:#fff;background:#ffffff2d;font-weight:700;cursor:pointer}.container{padding:20px}.cards{display:grid;grid-template-columns:repeat(5,1fr);gap:14px;margin-top:-38px}.card,.panel,.turn{background:var(--panel);border:1px solid var(--border);border-radius:18px;box-shadow:0 12px 34px #0f172a12}.card{padding:18px}.card span,.judge-grid span{color:var(--muted);font-size:13px;display:block}.card strong{font-size:26px}.panel,.turn{padding:22px;margin:18px 0}.turn{border-left:6px solid var(--blue)}.turn.pass{border-left-color:var(--pass)}.turn.fail{border-left-color:var(--fail)}.turn-head{display:flex;justify-content:space-between;gap:12px}.badge{padding:7px 11px;border-radius:999px;color:#fff;font-weight:800}.badge.pass{background:var(--pass)}.badge.fail{background:var(--fail)}.bubble{padding:14px 16px;border-radius:14px;margin:12px 0}.bubble.user{background:#eaf2ff}.dark .bubble.user{background:#172554}.bubble.bot{background:#eefbf3}.dark .bubble.bot{background:#052e16}.judge-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.judge-grid div{padding:12px;border:1px solid var(--border);border-radius:12px}.summary{font-weight:650}.tokens{width:100%;border-collapse:collapse}.tokens th,.tokens td{padding:10px;border-bottom:1px solid var(--border);text-align:left}.shots{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.shot{color:var(--text);text-decoration:none;margin:0}.shot img{display:block;width:100%;height:auto;border-radius:12px;border:1px solid var(--border)}.shot figcaption{padding:8px 2px;color:var(--muted);font-size:13px;word-break:break-word}pre{white-space:pre-wrap;word-break:break-word;background:#0b1220;color:#d1e7ff;padding:16px;border-radius:12px}@media(max-width:900px){.cards{grid-template-columns:repeat(2,1fr)}.judge-grid{grid-template-columns:repeat(2,1fr)}.shots{grid-template-columns:1fr}.hero-inner{display:block}}
</style></head><body><header class="hero"><div class="hero-inner"><div><h1>${escapeHtml(botName)} Generative QA Report</h1>
<p>${escapeHtml(frameworkName)}</p>
<p>Brand: ${escapeHtml(brandName)}</p>
<p>Scenario: ${escapeHtml(scenarioName)}</p>
<p>Environment: ${escapeHtml(process.env.TARGET_ENV || 'UAT')}</p></div><div class="actions"><button onclick="navigator.clipboard.writeText(document.getElementById('summary').textContent)">Copy summary</button><button onclick="window.print()">Print / Save PDF</button><button onclick="document.body.classList.toggle('dark')">Toggle theme</button></div></div></header><main class="container"><pre id="summary" style="display:none">${escapeHtml(summaryText)}</pre><section class="cards"><div class="card"><span>Framework</span><strong>${escapeHtml(frameworkStatus)}</strong></div><div class="card"><span>Application</span><strong>${applicationPassed ? 'PASS' : 'FAIL'}</strong></div><div class="card"><span>Validations</span><strong>${validations.length}</strong></div><div class="card"><span>Passed / Failed</span><strong>${passedCount} / ${failedCount}</strong></div><div class="card"><span>Total consumed tokens</span><strong>${shortNumber(totalTokens)}</strong></div></section>${turns}<section class="panel">
<h2>Token usage</h2>
<div class="judge-grid">
  <div>
    <span>Prompt tokens</span>
    <strong>${shortNumber(tokenUsage.promptTokens)}</strong>
  </div>
  <div>
    <span>Output tokens</span>
    <strong>${shortNumber(tokenUsage.outputTokens)}</strong>
  </div>
  <div>
    <span>Peak request size</span>
    <strong>${shortNumber(tokenUsage.peakRequestTokens)}</strong>
  </div>
  <div>
    <span>Gemini API calls</span>
    <strong>${shortNumber(tokenUsage.apiCalls)}</strong>
  </div>
</div>
<table class="tokens"><thead><tr><th>Stage</th><th>Prompt</th><th>Output</th><th>Total</th></tr></thead><tbody>${tokenRows || '<tr><td colspan="4">No token events found.</td></tr>'}</tbody></table></section><section class="panel"><h2>Screenshots</h2><div class="shots">${screenshotCards}</div></section><section class="panel"><h2>Evidence files</h2><p>Metrics: ${escapeHtml(metricsPath || 'Not found')}</p><p>Transcript: ${escapeHtml(transcriptPath || 'Not found')}</p><details><summary>Raw metrics</summary><pre>${escapeHtml(JSON.stringify(metrics, null, 2))}</pre></details></section></main></body></html>`;

  fs.writeFileSync(outputPath, html, 'utf8');
  console.log(`Shareable generative report created: ${outputPath}`);
}

if (scenarioType === 'generative') {
  buildGenerativeReport();
} else {
  const legacy = path.join(__dirname, 'build-helpcenter-report.js');
  if (!fs.existsSync(legacy)) throw new Error(`Missing legacy report builder: ${legacy}`);
  const result = spawnSync(process.execPath, [legacy, reportName], { cwd: root, stdio: 'inherit', env: process.env });
  process.exit(Number.isInteger(result.status) ? result.status : 1);
}