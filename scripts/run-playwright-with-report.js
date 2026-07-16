'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');

const specGlob =
  process.env.SPEC_GLOB ||
  'generated-specs/web';

const specTag =
  process.env.SPEC_TAG === undefined
    ? '@regression'
    : process.env.SPEC_TAG;

const project =
  process.env.PLAYWRIGHT_PROJECT ||
  'chromium';

const reportName =
  process.env.REPORT_NAME ||
  'qa-report';

const shouldOpen =
  String(process.env.OPEN_REPORT || 'false').toLowerCase() === 'true';

const playwrightArgs = [
  'playwright',
  'test',
  specGlob,
  '--project',
  project,
];

if (specTag.trim()) {
  playwrightArgs.push('--grep', specTag.trim());
}

if (process.env.HEADLESS === 'false') {
  playwrightArgs.push('--headed');
}

console.log('');
console.log('▶️ Running generated Playwright specs');
console.log(`Specs: ${specGlob}`);
console.log(`Tag: ${specTag || 'none'}`);
console.log(`Environment: ${process.env.TARGET_ENV || 'UAT'}`);
console.log('');

const testResult = spawnSync(
  'npx',
  playwrightArgs,
  {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  }
);

const testStatus =
  typeof testResult.status === 'number'
    ? testResult.status
    : 1;

console.log('');
console.log('📊 Creating shareable QA report...');

const reportResult = spawnSync(
  process.execPath,
  [
    path.join(
      projectRoot,
      'scripts',
      'build-shareable-report.js'
    ),
    reportName,
  ],
  {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  }
);

const reportStatus =
  typeof reportResult.status === 'number'
    ? reportResult.status
    : 1;

const reportPath = path.join(
  projectRoot,
  'reports',
  'shareable',
  `${reportName}.html`
);

if (reportStatus !== 0 || !fs.existsSync(reportPath)) {
  console.error(`❌ Shareable report was not created: ${reportPath}`);
  process.exit(testStatus !== 0 ? testStatus : 1);
}

console.log(`✅ Shareable report created: ${reportPath}`);

if (shouldOpen && process.platform === 'darwin') {
  spawnSync('open', [reportPath], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
}

process.exit(testStatus);
