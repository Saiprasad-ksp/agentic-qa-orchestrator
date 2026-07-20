'use strict';
const fs = require('fs');
const assert = require('assert');
const pkg = require('../package.json');
const required = [
  'agent-hybrid-runtime.js',
  'mcp-server.js',
  'src/oliveWebBot.js',
  'src/llmJudge.js',
  'scenarios/web/aem-pages-visual-regression.txt',
];
for (const file of required) assert(fs.existsSync(file), `Missing ${file}`);
assert(pkg.scripts['scenario:discover'], 'Missing scenario:discover script');
assert(pkg.scripts.check, 'Missing check script');
console.log('Smoke test passed.');
