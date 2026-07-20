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
Never invent framework APIs, credentials, absolute local paths, shell commands, hardcoded environment URLs, exact generative bot wording, runtime control IDs or recorded chip labels.
Preserve these tags in test titles: ${tags}
Use environment values through src/env.js.

The readEnv API is readEnv('VARIABLE_NAME', 'optional fallback').
Never call readEnv() without a key and never create an env object from readEnv().

Scenario:\n${scenario.raw}\nDiscovery evidence:\n${evidence.slice(0, 30000)}\nPrevious validation errors:\n${errors || 'none'}\n`;

  if (scenario.platform === 'mobile') {
    return `${common}
Generate a WebdriverIO v9 Mocha spec for generated-specs/mobile/${scenario.baseName}.spec.js.
Use global browser APIs and import { OliveMobileBot } from ../../src/mobile/oliveMobileBot.
For generative scenarios, create a semanticContract object containing the business objective, typed milestone objects, success conditions, failure conditions and maximum turns. Do not emit milestone strings. Preserve explicit scenario-authored customer messages as REQUIRED_CUSTOMER_MESSAGE with a non-empty value.
Execute it through:
const bot = new OliveMobileBot(browser);
await bot.ensureAuthenticated({ required: true });
await bot.open();
await bot.runGeneratedJourney({ scenario: semanticContract, maxTurns });
Generated-spec execution is deterministic-first: preserve explicit scenario-authored customer messages and milestone order. Use local locator matching/self-healing first, then LLM fallback only when deterministic healing cannot resolve the current control. Do not replay discovered bot responses, runtime control IDs or incidental generated chip wording. Do not assert exact bot sentences. Do not embed Appium capabilities; wdio.conf.js owns local and BrowserStack capabilities.
For deterministic non-generative scenarios, use stable accessibility locators grounded in evidence.
`;
  }

  return `${common}
Generate a Playwright CommonJS spec for generated-specs/web/${scenario.baseName}.spec.js.
Import { test, expect } from @playwright/test.
Import { loadProjectEnv, readEnv } from ../../src/env and call loadProjectEnv('.env.web', '.env.llm', '.env.browserstack') before reading values.
Resolve the target URL from WEB_BASE_URL or BASE_URL plus TARGET_PATH. Never hardcode the environment URL.
For generative scenarios, import { OliveWebBot } from ../../src/oliveWebBot and create a semanticContract object containing the business objective, typed milestone objects, success conditions, failure conditions and maximum turns. Do not emit milestone strings. Each milestone must use one of REQUIRED_CUSTOMER_MESSAGE, SEMANTIC_CONTROL, WAIT, or SEMANTIC_VALIDATION. Preserve explicit scenario-authored customer messages as REQUIRED_CUSTOMER_MESSAGE with a non-empty value.
Execute it through:
const bot = new OliveWebBot(page);
await bot.ensureAuthenticated({ targetUrl, required: true });
await bot.open();
await bot.runGeneratedJourney({ scenario: semanticContract, maxTurns });
Generated-spec execution is deterministic-first: preserve explicit scenario-authored customer messages and milestone order. Use local locator matching/self-healing first, then LLM fallback only when deterministic healing cannot resolve the current control. Do not replay discovered bot responses, runtime control IDs or incidental generated chip wording. Do not assert exact bot sentences.
For deterministic non-generative scenarios, use stable role, label, test-id or existing reusable helpers grounded in evidence.
Set an appropriate timeout and attach useful evidence through testInfo.
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
