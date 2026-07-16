'use strict';

const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const runsRoot = path.join(projectRoot, 'artifacts', 'runs');
const keep = Math.max(1, Number(process.env.MAX_RUN_HISTORY || 3));

function main() {
  fs.mkdirSync(runsRoot, { recursive: true });
  const directories = fs.readdirSync(runsRoot)
    .map(name => ({ name, fullPath: path.join(runsRoot, name) }))
    .filter(item => fs.statSync(item.fullPath).isDirectory())
    .map(item => ({ ...item, mtimeMs: fs.statSync(item.fullPath).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const removed = [];
  for (const item of directories.slice(keep)) {
    fs.rmSync(item.fullPath, { recursive: true, force: true });
    removed.push(item.name);
  }

  console.log(`Run history retained: ${Math.min(keep, directories.length)}; removed: ${removed.length}`);
  if (removed.length) console.log(`Removed: ${removed.join(', ')}`);
}

main();
