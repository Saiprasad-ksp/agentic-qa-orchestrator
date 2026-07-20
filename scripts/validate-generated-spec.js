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

  if (testType === 'generative') {
    if (!/\.runGeneratedJourney\s*\(/.test(code)) {
      errors.push('Generated generative spec must execute deterministic-first steps through runGeneratedJourney().');
    }
    if (!/semanticContract|scenario\s*:/.test(code)) {
      errors.push('Generative spec must provide a semantic scenario contract.');
    }
    if (/runConversationTurns\s*\(|\.runSemanticJourney\s*\(/.test(code)) {
      errors.push('Generated generative specs must not replay discovered turns or invoke the discovery semantic loop.');
    }
    if (/milestones\s*:\s*\[\s*['"]/s.test(code)) {
      errors.push('Generated generative specs must use typed milestone objects, not milestone strings.');
    }
    if (/targetId\s*:\s*['"]control_\d+|getByText\s*\(\s*['"][^'"]+['"]\s*\)/.test(code)) {
      errors.push('Generative specs must not hardcode runtime control IDs or bot chip wording.');
    }
  }

  if (platform === 'web' && testType === 'generative') {
    if (!/const\s*\{\s*OliveWebBot\s*\}\s*=\s*require\(['"]\.\.\/\.\.\/src\/oliveWebBot['"]\)/.test(code)) {
      errors.push('Generative web spec must import OliveWebBot from ../../src/oliveWebBot.');
    }
    if (!/new\s+OliveWebBot\s*\(\s*page\s*\)/.test(code)) {
      errors.push('Generative web spec must instantiate new OliveWebBot(page).');
    }
    if (!/\.ensureAuthenticated\s*\(\s*\{[^}]*targetUrl[^}]*required\s*:\s*true/s.test(code)) {
      errors.push('Generated web spec must restore deterministic authentication before chatbot execution.');
    }
    if (!/\.open\s*\(/.test(code)) {
      errors.push('Generated web spec must explicitly open the chatbot before executing generated steps.');
    }
  }

  if (platform === 'mobile' && testType === 'generative') {
    if (!/OliveMobileBot/.test(code)) errors.push('Generative mobile spec must use OliveMobileBot.');
    if (!/new\s+OliveMobileBot\s*\(\s*browser\s*\)/.test(code)) {
      errors.push('Generative mobile spec must instantiate new OliveMobileBot(browser).');
    }
    if (!/\.ensureAuthenticated\s*\(\s*\{[^}]*required\s*:\s*true/s.test(code)) {
      errors.push('Generated mobile spec must establish or verify deterministic authenticated app state.');
    }
    if (!/\.open\s*\(/.test(code)) {
      errors.push('Generated mobile spec must explicitly open the chatbot before executing generated steps.');
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
    if (!/runGeneratedJourney/.test(code)) errors.push('Generated generative spec must use the deterministic-first shared runtime.');
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
