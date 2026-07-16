'use strict';

const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const { loadProjectEnv, readEnv, requireEnv } = require('../src/env');
const { readScenario } = require('../src/core/scenario');
const { validateGeneratedSpec } = require('./validate-generated-spec');

loadProjectEnv('.env.web', '.env.mobile', '.env.llm', '.env.browserstack');
const projectRoot = path.resolve(__dirname, '..');
if (process.env.GOOGLE_APPLICATION_CREDENTIALS && !path.isAbsolute(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve(projectRoot, process.env.GOOGLE_APPLICATION_CREDENTIALS);
}

function client() {
  if (readEnv('GEMINI_AUTH_MODE', 'vertex').toLowerCase() === 'vertex') {
    const project = readEnv('GOOGLE_CLOUD_PROJECT') || readEnv('GCP_PROJECT_ID');
    if (!project) throw new Error('Vertex authentication requires GOOGLE_CLOUD_PROJECT.');
    return new GoogleGenAI({ vertexai: true, project, location: readEnv('GOOGLE_CLOUD_LOCATION', 'us-central1') });
  }
  return new GoogleGenAI({ apiKey: requireEnv('GEMINI_API_KEY') });
}

function readEvidence(manifest) {
  const files = [...(manifest.evidenceFiles || []), ...(manifest.screenshotFiles || [])].filter(Boolean).slice(-30);
  return files.map(file => {
    const resolved = path.isAbsolute(file) ? file : path.join(projectRoot, file);
    if (!fs.existsSync(resolved) || !/\.(json|txt|md|log)$/i.test(resolved)) return `FILE: ${file}`;
    return `FILE: ${file}\n${fs.readFileSync(resolved, 'utf8').slice(0, 12000)}`;
  }).join('\n\n');
}

function promptFor({ scenario, evidence, errors }) {
  const tags = scenario.tags.join(' ');
  const common = `
You generate a validated executable QA spec from a successful real discovery run.
Output only CommonJS JavaScript without markdown.
Never invent framework APIs, credentials, absolute local paths, shell commands, or hardcoded environment URLs.
Preserve these tags in test titles: ${tags}
Use environment values through src/env.js.

The readEnv API is:
readEnv('VARIABLE_NAME', 'optional fallback').

Never call readEnv() without a key.
Never use property access such as:
readEnv().TARGET_PATH
readEnv().WEB_BASE_URL
readEnv().BASE_URL

For web navigation, use exactly:
const baseUrl =
  readEnv('WEB_BASE_URL') ||
  readEnv('BASE_URL');

const targetPath =
  readEnv('TARGET_PATH', '/');

if (!baseUrl) {
  throw new Error(
    'WEB_BASE_URL or BASE_URL must be configured.'
  );
}

await page.goto(
  new URL(targetPath, baseUrl).toString()
);

Scenario:\n${scenario.raw}\nDiscovery evidence:\n${evidence.slice(0, 30000)}\nPrevious validation errors:\n${errors || 'none'}\n`;

  if (scenario.platform === 'mobile') {
    return `${common}
Generate a WebdriverIO v9 Mocha spec for generated-specs/mobile/${scenario.baseName}.spec.js.
Use global browser APIs. Import readEnv from ../../src/env.
For generative scenarios import OliveMobileBot from ../../src/mobile/oliveMobileBot and runConversationTurns from ../../src/generative/turnRunner.
Store execution evidence under process.env.QA_RUN_DIR when available.
Do not embed Appium capabilities in the spec; wdio.conf.js owns capabilities.
For deterministic scenarios use accessibility IDs, Android UiSelector or iOS predicates grounded in evidence and provide sensible deterministic fallbacks.
For generative scenarios create structured turns with userMessage, expectedIntent, acceptanceCriteria and blockedPatterns, then call bot.sendAndJudge for every turn.
`;
  }

  return `${common}
Generate a Playwright CommonJS spec for generated-specs/web/${scenario.baseName}.spec.js.
Import { test, expect } from @playwright/test.
Import both loadProjectEnv and readEnv from ../../src/env exactly as:
const { loadProjectEnv, readEnv } = require('../../src/env');

Before reading any environment variable, call exactly:
loadProjectEnv('.env.web', '.env.llm', '.env.browserstack');

Use role, label, placeholder and stable test-id selectors grounded in discovery evidence.
For generative web scenarios use these exact existing CommonJS APIs:
const { OliveWebBot } = require('../../src/oliveWebBot');
const { runConversationTurns } = require('../../src/generative/turnRunner');

Instantiate the bot exactly as:
const bot = new OliveWebBot(page);

Open the chatbot exactly as:
await bot.open();

Send a customer message using:
await bot.sendMessage(customerMessage);

The existing runConversationTurns API is exactly:
await runConversationTurns({
  turns,
  sendAndJudge,
  outputDir,
  testInfo,
});

The turns value must be an array of deterministic turns recovered from the successful discovery evidence, for example:
const turns = [
  {
    userMessage: 'Discovered customer message',
    expectedIntent: 'missing_items',
    acceptanceCriteria: ['recognises the intent'],
    blockedPatterns: ['unsupported guarantee'],
  },
];

The sendAndJudge callback must accept one turn and return the combined chatbot and validation result:
sendAndJudge: async turn => {
  const chatbotResult = await bot.sendMessage(turn.userMessage);
  return {
    ...chatbotResult,
    passed: true,
  };
}

Do not pass initialTurn, customerPersona, conversationStrategy, expectations, allowedIntermediateStates, failureConditions, stopConditions, generateFollowUp or validateBotResponse into runConversationTurns.
Do not invent a different runConversationTurns signature.
Generated regression specs must replay the successful discovered messages deterministically.

Do not create an env object from readEnv().
Do not call readEnv() without a variable name.
Do not navigate to a relative path by itself.
Use the exact web navigation pattern defined above.

Do not invent methods such as openChatbot, sendAndJudge, openWidget, startChat or waitForGreeting.
Do not pass testInfo into the OliveWebBot constructor.
Use only APIs proven by the discovery evidence or explicitly listed above.
Use the successful discovered customer messages as deterministic regression inputs.
Validate semantic response state and behaviour rather than exact chatbot wording.
For deterministic scenarios use existing reusable helpers only when they match the scenario evidence, including VisualValidator, auditLinksAndButtons and runAdvancedHelpCenterExploration.
Set an appropriate test timeout and attach evidence through testInfo.
`;
}

function stripFence(value) { return String(value || '').replace(/^```(?:javascript|js)?\s*/i, '').replace(/```\s*$/i, '').trim() + '\n'; }

async function main() {
  const argument = process.argv[2];
  if (!argument) throw new Error('Usage: npm run spec:generate -- <scenario.txt>');
  const scenario = readScenario(projectRoot, argument);
  const manifestPath = path.join(projectRoot, 'reports', 'discovery', `${scenario.baseName}.manifest.json`);
  if (!fs.existsSync(manifestPath)) throw new Error(`Discovery manifest missing: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.status !== 0) throw new Error('Spec generation blocked because discovery did not pass.');
  const evidence = readEvidence(manifest);
  const outputDir = path.join(projectRoot, 'generated-specs', scenario.platform);
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${scenario.baseName}.spec.js`);
  const ai = client();
  let errors = '';
  for (let attempt = 1; attempt <= Number(readEnv('SPEC_GENERATION_ATTEMPTS', '4')); attempt += 1) {
    const response = await ai.models.generateContent({ model: readEnv('GEMINI_MODEL', 'gemini-2.5-flash'), contents: promptFor({ scenario, evidence, errors }), config: { temperature: 0 } });
    fs.writeFileSync(outputPath, stripFence(response.text), 'utf8');
    const validation = validateGeneratedSpec(outputPath, { scenarioText: scenario.raw, platform: scenario.platform, testType: scenario.testType });
    if (!validation.length) { console.log(`Generated valid ${scenario.platform} ${scenario.testType} spec: ${outputPath}`); return; }
    errors = validation.join('\n');
    console.error(`Attempt ${attempt} failed validation:\n${errors}`);
  }
  throw new Error(`Unable to generate a valid spec: ${outputPath}`);
}

main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
