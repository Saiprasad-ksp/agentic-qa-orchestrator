'use strict';

const fs = require('fs');
const path = require('path');

function safeName(value) {
  return String(value || 'run').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

function createRunContext(projectRoot, scenarioBase) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runId = `${timestamp}-${safeName(scenarioBase)}`;
  const runDir = path.join(projectRoot, 'artifacts', 'runs', runId);
  const directories = {
    runDir,
    screenshotsDir: path.join(runDir, 'screenshots'),
    tracesDir: path.join(runDir, 'traces'),
    reportsDir: path.join(runDir, 'reports'),
    evidenceDir: path.join(runDir, 'evidence'),
  };
  Object.values(directories).forEach(directory => fs.mkdirSync(directory, { recursive: true }));
  process.env.QA_RUN_ID = runId;
  process.env.QA_RUN_DIR = runDir;
  process.env.QA_SCREENSHOTS_DIR = directories.screenshotsDir;
  return { runId, ...directories };
}

module.exports = { createRunContext, safeName };
