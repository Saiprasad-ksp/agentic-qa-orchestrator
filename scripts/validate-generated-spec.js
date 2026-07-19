'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseScenarioText } = require('../src/core/scenario');

function validateGeneratedSpec(filePath, options = {}) {
  const errors = [];
  if (!fs.existsSync(filePath)) return [`Generated spec does not exist: ${filePath}`];
  const code = fs.readFileSync(filePath, 'utf8');
  const syntax = spawnSync(process.execPath, ['--check', filePath], { encoding: 'utf8' });
  if (syntax.status !== 0) errors.push(`Syntax error:\n${syntax.stderr || syntax.stdout}`);

  const scenario = options.scenarioText ? parseScenarioText(options.scenarioText) : null;
  const platform = options.platform || scenario?.platform || (/generated-specs[\\/]mobile/.test(filePath) ? 'mobile' : 'web');
  const testType = options.testType || scenario?.testType || 'deterministic';

  if (
    /readEnv\s*\(\s*\)\s*\./.test(code) ||
    /const\s+\w+\s*=\s*readEnv\s*\(\s*\)/.test(code)
  ) {
    errors.push(
      'readEnv must be called with a variable name; readEnv() without a key is invalid.'
    );
  }

  if (platform === 'web') {
    const resolvesSupportedWebUrl =
      /readEnv\s*\(\s*['"]WEB_BASE_URL['"]/.test(code) ||
      /readEnv\s*\(\s*['"]BASE_URL['"]/.test(code) ||
      (
        /readEnv\s*\(\s*['"]URL_PROD['"]/.test(code) &&
        /readEnv\s*\(\s*['"]URL_UAT['"]/.test(code)
      ) ||
      /readEnv\s*\(\s*['"]HELP_CENTER_WEB_URL['"]/.test(code);

    if (!resolvesSupportedWebUrl) {
      errors.push(
        'Web spec must resolve its URL through a supported readEnv configuration.'
      );
    }
  }

  if (
    platform === 'web' &&
    /page\.goto\s*\(\s*readEnv\s*\(\s*['"]TARGET_PATH['"]/.test(code)
  ) {
    errors.push(
      'TARGET_PATH is relative and must be combined with WEB_BASE_URL or BASE_URL.'
    );
  }

  if (
    platform === 'web' &&
    /page\.goto\s*\(\s*['"]\/['"]\s*\)/.test(code)
  ) {
    errors.push(
      'Web spec must not navigate to a relative path without a base URL.'
    );
  }

  if (platform === 'web') {
    if (
      !/const\s*\{[^}]*loadProjectEnv[^}]*readEnv[^}]*\}\s*=\s*require\(['"]\.\.\/\.\.\/src\/env['"]\)/s.test(code)
    ) {
      errors.push(
        'Web spec must import loadProjectEnv and readEnv from ../../src/env.'
      );
    }

    if (
      !/loadProjectEnv\s*\(\s*['"]\.env\.web['"]/.test(code)
    ) {
      errors.push(
        'Web spec must load .env.web before reading WEB_BASE_URL.'
      );
    }
  }

  if (
    platform === 'web' &&
    testType === 'generative'
  ) {
    const runConversationCall =
      code.match(
        /runConversationTurns\s*\(\s*\{([\s\S]*?)\}\s*\)/
      );

    if (!runConversationCall) {
      errors.push(
        'Generative web spec must call runConversationTurns with an options object.'
      );
    } else {
      const options = runConversationCall[1];

      if (!/\bturns\s*,|\bturns\s*:/.test(options)) {
        errors.push(
          'runConversationTurns requires a turns array.'
        );
      }

      if (!/\bsendAndJudge\s*:/.test(options)) {
        errors.push(
          'runConversationTurns requires a sendAndJudge callback.'
        );
      }
    }

    const unsupportedTurnRunnerOptions = [
      'initialTurn',
      'customerPersona',
      'conversationStrategy',
      'expectations',
      'allowedIntermediateStates',
      'failureConditions',
      'stopConditions',
      'generateFollowUp',
      'validateBotResponse',
    ];

    for (const option of unsupportedTurnRunnerOptions) {
      const pattern =
        new RegExp(`\\b${option}\\s*:`);

      if (pattern.test(code)) {
        errors.push(
          `${option} is not supported by runConversationTurns.`
        );
      }
    }
  }

  if (
    platform === 'web' &&
    testType === 'generative'
  ) {
    if (
      !/const\s*\{\s*OliveWebBot\s*\}\s*=\s*require\(['"]\.\.\/\.\.\/src\/oliveWebBot['"]\)/.test(code)
    ) {
      errors.push(
        'Generative web spec must destructure OliveWebBot from ../../src/oliveWebBot.'
      );
    }

    if (/new\s+OliveWebBot\s*\(\s*page\s*,/.test(code)) {
      errors.push(
        'OliveWebBot constructor accepts page only; do not pass testInfo.'
      );
    }

    if (/\.openChatbot\s*\(/.test(code)) {
      errors.push(
        'openChatbot() is not a valid API; use bot.open().'
      );
    }

    if (
      !/new\s+OliveWebBot\s*\(\s*page\s*\)/.test(code)
    ) {
      errors.push(
        'Generative web spec must instantiate new OliveWebBot(page).'
      );
    }

    if (!/await\s+bot\.open\s*\(\s*\)/.test(code)) {
      errors.push(
        'Generative web spec must open the chatbot using await bot.open().'
      );
    }
  }

  if (platform === 'web') {
    if (!code.includes("require('@playwright/test')")) errors.push('Web spec must import @playwright/test.');
    if (!/test\s*\(|test\.describe\s*\(/.test(code)) errors.push('Web spec must contain a Playwright test.');
  } else {
    if (!/describe\s*\(/.test(code) || !/it\s*\(/.test(code)) errors.push('Mobile spec must contain Mocha describe/it blocks.');
    if (!/browser\.|OliveMobileBot/.test(code)) errors.push('Mobile spec must use WebdriverIO browser APIs or OliveMobileBot.');
  }

  if (testType === 'generative') {
    if (!/judgeChatbotResponse|sendAndJudge|runConversationTurns/.test(code)) errors.push('Generative spec must include semantic LLM judging.');
    if (!/OliveWebBot|OliveMobileBot/.test(code)) errors.push('Generative spec must use the Olive platform helper.');
  }

  for (const tag of scenario?.tags || []) {
    if (!code.includes(tag)) errors.push(`Generated spec is missing scenario tag ${tag}.`);
  }

  const banned = [
    /GOOGLE_APPLICATION_CREDENTIALS\s*=\s*['"][^'"]+['"]/, /private_key/i,
    /service-account\.json/i, /process\.env\s*=\s*\{/, /child_process.*exec\(/,
    /https:\/\/uatsite\.woolworths\.com\.au\/shop\/help/g,
  ];
  for (const pattern of banned) if (pattern.test(code)) errors.push(`Banned or unsafe generated-spec pattern: ${pattern}`);
  return errors;
}

if (require.main === module) {
  const filePath = process.argv[2];
  if (!filePath) { console.error('Usage: node scripts/validate-generated-spec.js <spec-file>'); process.exit(2); }
  const errors = validateGeneratedSpec(path.resolve(filePath));
  if (errors.length) { console.error(errors.join('\n\n')); process.exit(1); }
  console.log(`Generated spec passed validation: ${filePath}`);
}

module.exports = { validateGeneratedSpec };
