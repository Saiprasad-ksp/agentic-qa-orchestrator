const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const scenariosDir = path.resolve(__dirname, '..', 'scenarios');

function getArg(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

function parseTags(text) {
  const match = text.match(/^TAGS:\s*(.+)$/mi);
  if (!match) return [];
  return match[1].split(/\s+/).map(t => t.trim()).filter(Boolean);
}

function parsePlatform(text, fileName) {
  const match = text.match(/^PLATFORM:\s*(Web|Mobile)\s*$/mi);
  if (match) return match[1].toLowerCase();

  if (fileName.toLowerCase().includes('mobile')) return 'mobile';
  if (fileName.toLowerCase().includes('web')) return 'web';

  return 'unknown';
}

const tagArg = getArg('--tag') || getArg('-t');
const platformArg = getArg('--platform') || process.env.TARGET_PLATFORM;
const targetArg = getArg('--target') || process.env.RUN_TARGET || 'local';

if (!tagArg) {
  console.error('Usage: node scripts/run-by-tag.js --tag @web --target local');
  console.error('Example: node scripts/run-by-tag.js --tag @mobile --target browserstack');
  process.exit(1);
}

const requiredTags = tagArg
  .split(',')
  .map(t => t.trim())
  .filter(Boolean);

const files = fs.readdirSync(scenariosDir)
  .filter(f => f.endsWith('.txt'))
  .map(file => {
    const fullPath = path.join(scenariosDir, file);
    const text = fs.readFileSync(fullPath, 'utf8');
    return {
      file,
      text,
      tags: parseTags(text),
      platform: parsePlatform(text, file),
    };
  })
  .filter(scenario => {
    const tagMatch = requiredTags.every(tag => scenario.tags.includes(tag));
    const platformMatch = platformArg
      ? scenario.platform === platformArg.toLowerCase()
      : true;

    return tagMatch && platformMatch;
  });

if (!files.length) {
  console.error(`No scenarios found for tags: ${requiredTags.join(', ')}`);
  process.exit(1);
}

console.log(`Found ${files.length} scenario(s):`);
for (const f of files) {
  console.log(`- ${f.file} [${f.platform}] ${f.tags.join(' ')}`);
}

let failed = false;

for (const scenario of files) {
  console.log(`\n==================================================`);
  console.log(`Running scenario: ${scenario.file}`);
  console.log(`Platform: ${scenario.platform}`);
  console.log(`Target: ${targetArg}`);
  console.log(`==================================================\n`);

  const result = spawnSync(
    process.execPath,
    ['agent-hybrid-client.js', scenario.file],
    {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'inherit',
      env: {
        ...process.env,
        RUN_TARGET: targetArg,
        TARGET_PLATFORM: scenario.platform,
        MCP_SERVER_MODE: process.env.MCP_SERVER_MODE || 'local',
      },
    },
  );

  if (result.status !== 0) {
    failed = true;
  }
}

process.exit(failed ? 1 : 0);
