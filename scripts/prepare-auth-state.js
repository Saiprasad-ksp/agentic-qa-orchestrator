'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root =
  path.resolve(__dirname, '..');

const scenarioPath =
  process.argv[2];

if (!scenarioPath) {
  throw new Error(
    'Usage: node scripts/prepare-auth-state.js <scenario-path>'
  );
}

const absoluteScenarioPath =
  path.resolve(root, scenarioPath);

if (!fs.existsSync(absoluteScenarioPath)) {
  throw new Error(
    `Scenario file not found: ${absoluteScenarioPath}`
  );
}

const scenarioText =
  fs.readFileSync(
    absoluteScenarioPath,
    'utf8'
  );

function readField(name) {
  const pattern =
    new RegExp(
      `^${name}:\\s*(.+?)\\s*$`,
      'im'
    );

  return (
    scenarioText.match(pattern)?.[1]?.trim() ||
    ''
  );
}

const authRequired =
  /^AUTH_REQUIRED:\s*(true|yes|required)\s*$/im.test(
    scenarioText
  ) ||
  /@loggedin\b/i.test(
    scenarioText
  ) ||
  /@authenticated\b/i.test(
    scenarioText
  ) ||
  /\blogged[- ]in\b/i.test(
    readField('TAGS')
  );

if (!authRequired) {
  console.log(
    'Scenario does not require deterministic authentication.'
  );

  process.exit(0);
}

const targetEnv =
  String(
    process.env.TARGET_ENV || 'UAT'
  ).toUpperCase();

const loginUrl =
  targetEnv === 'PROD'
    ? process.env.LOGIN_URL_PROD
    : process.env.LOGIN_URL_UAT;

const email =
  process.env.TEST_LOGIN_EMAIL;

const password =
  process.env.TEST_LOGIN_PASSWORD;

if (!loginUrl) {
  throw new Error(
    `Login URL is missing for ${targetEnv}. Configure LOGIN_URL_${targetEnv}.`
  );
}

if (!email) {
  throw new Error(
    'TEST_LOGIN_EMAIL is missing.'
  );
}

if (!password) {
  throw new Error(
    'TEST_LOGIN_PASSWORD is missing.'
  );
}

const authDirectory =
  path.join(
    root,
    'artifacts',
    '.auth'
  );

fs.mkdirSync(
  authDirectory,
  {
    recursive: true,
  }
);

const storageStatePath =
  path.join(
    authDirectory,
    `woolworths-${targetEnv.toLowerCase()}.json`
  );

async function findVisible(page, selectors) {
  for (const selector of selectors) {
    const locator =
      page.locator(selector).first();

    try {
      if (
        await locator.isVisible({
          timeout: 2500,
        })
      ) {
        return locator;
      }
    } catch (_error) {
      // Try the next deterministic selector.
    }
  }

  return null;
}

async function main() {
  const browser =
    await chromium.launch({
      headless:
        String(
          process.env.HEADLESS ||
          'true'
        ).toLowerCase() !==
        'false',
    });

  const context =
    await browser.newContext();

  const page =
    await context.newPage();

  try {
    console.log(
      `Starting deterministic login: ${loginUrl}`
    );

    await page.goto(
      loginUrl,
      {
        waitUntil:
          'domcontentloaded',
        timeout: 120000,
      }
    );

    const emailInput =
      await findVisible(
        page,
        [
          'input[type="email"]',
          'input[name="email"]',
          'input[autocomplete="username"]',
          '[data-testid="email"]',
        ]
      );

    if (!emailInput) {
      throw new Error(
        'Deterministic login could not find the email field.'
      );
    }

    await emailInput.fill(email);

    const emailSubmit =
      await findVisible(
        page,
        [
          'button[type="submit"]',
          'button:has-text("Log in")',
          'button:has-text("Next")',
          'button:has-text("Submit")',
        ]
      );

    if (!emailSubmit) {
      throw new Error(
        'Deterministic login could not find the email submit button.'
      );
    }

    await emailSubmit.click();

    const passwordInput =
      await findVisible(
        page,
        [
          'input[type="password"]',
          'input[name="password"]',
          'input[autocomplete="current-password"]',
          '[data-testid="password"]',
        ]
      );

    if (!passwordInput) {
      throw new Error(
        'Deterministic login could not find the password field.'
      );
    }

    await passwordInput.fill(password);

    const passwordSubmit =
      await findVisible(
        page,
        [
          'button[type="submit"]',
          'button:has-text("Log in")',
          'button:has-text("Sign in")',
          'button:has-text("Continue")',
        ]
      );

    if (!passwordSubmit) {
      throw new Error(
        'Deterministic login could not find the password submit button.'
      );
    }

    await Promise.all([
      page.waitForLoadState(
        'domcontentloaded',
        {
          timeout: 120000,
        }
      ).catch(() => {}),
      passwordSubmit.click(),
    ]);

    await page.waitForTimeout(5000);

    await context.storageState({
      path: storageStatePath,
    });

    console.log(
      `Authenticated storage state saved: ${storageStatePath}`
    );

    if (process.env.GITHUB_ENV) {
      fs.appendFileSync(
        process.env.GITHUB_ENV,
        `PLAYWRIGHT_STORAGE_STATE=${storageStatePath}\n`,
        'utf8'
      );
    }
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(
    `Deterministic login failed: ${error.message}`
  );

  process.exitCode = 1;
});
