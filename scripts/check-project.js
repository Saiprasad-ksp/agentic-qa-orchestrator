'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const ignored = new Set(['node_modules', '.git', 'artifacts', 'reports', 'test-results', 'playwright-report']);
const files = [];
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (ignored.has(name)) continue;
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full); else if (name.endsWith('.js')) files.push(full);
  }
}
walk(root);
let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) { failed += 1; console.error(`INVALID ${path.relative(root,file)}\n${result.stderr}`); }
}
console.log(`Checked ${files.length} JavaScript files; failures: ${failed}`);
process.exit(failed ? 1 : 0);
