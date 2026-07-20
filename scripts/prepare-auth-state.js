'use strict';


// LOGIN_CREDENTIALS_SOURCE_OF_TRUTH
(function loadProtectedLoginCredentials() {
  const fsModule = require('node:fs');
  const pathModule = require('node:path');

  const credentialsDirectory =
    process.env.AGENTIC_QA_CREDENTIALS_DIR
      ? pathModule.resolve(
          process.env.AGENTIC_QA_CREDENTIALS_DIR,
        )
      : pathModule.resolve(
          process.cwd(),
          '.credentials',
        );

  const loginEnvironmentPath = pathModule.join(
    credentialsDirectory,
    'login.env',
  );

  if (!fsModule.existsSync(loginEnvironmentPath)) {
    throw new Error(
      `Deterministic login credentials were not found: ${loginEnvironmentPath}`,
    );
  }

  const requiredVariables = [
    'LOGIN_URL_UAT',
    'LOGIN_URL_PROD',
    'TEST_LOGIN_EMAIL',
    'TEST_LOGIN_PASSWORD',
  ];

  const allowedVariables = new Set(requiredVariables);

  const fileLines = fsModule
    .readFileSync(loginEnvironmentPath, 'utf8')
    .replace(/\r/g, '')
    .split('\n');

  for (const originalLine of fileLines) {
    let line = originalLine.trim();

    if (!line || line.startsWith('#')) {
      continue;
    }

    line = line.replace(/^export\s+/, '');

    const equalsIndex = line.indexOf('=');

    if (equalsIndex <= 0) {
      continue;
    }

    const key = line
      .slice(0, equalsIndex)
      .trim();

    if (!allowedVariables.has(key)) {
      continue;
    }

    let value = line
      .slice(equalsIndex + 1)
      .trim();

    if (
      value.length >= 2 &&
      (
        (
          value.startsWith('"') &&
          value.endsWith('"')
        ) ||
        (
          value.startsWith("'") &&
          value.endsWith("'")
        )
      )
    ) {
      value = value.slice(1, -1);
    }

    // The protected credentials file always wins over
    // placeholders loaded from .env or .env.web.
    process.env[key] = value;
  }

  const placeholderPattern =
    /replace_with|with_test_account|your_(?:test_)?(?:email|password)|placeholder/i;

  const invalidVariables = requiredVariables.filter(
    variableName => {
      const value = String(
        process.env[variableName] || '',
      ).trim();

      return (
        !value ||
        placeholderPattern.test(value)
      );
    },
  );

  if (invalidVariables.length > 0) {
    throw new Error(
      [
        'Deterministic login credentials are missing',
        'or still contain placeholder values in',
        loginEnvironmentPath + ':',
        invalidVariables.join(', '),
      ].join(' '),
    );
  }

  if (
    !String(process.env.TEST_LOGIN_EMAIL).includes('@')
  ) {
    throw new Error(
      'TEST_LOGIN_EMAIL in login.env is not a valid email address.',
    );
  }

  console.log(
    'Deterministic login credentials loaded from protected login.env.',
  );
})();


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

      async function findVisibleLoginButton(
        timeout = 30000
      ) {
        const deadline =
          Date.now() + timeout;

        const buttonSelector = [
          'button[data-action-button-primary="true"]',
          'button[type="submit"]',
          'input[type="submit"]',
          '[role="button"]',
        ].join(', ');

        const acceptedLabelPattern =
          /^(?:log\s*in|continue)$/i;

        let lastDiagnostics = [];

        while (Date.now() < deadline) {
          const candidates =
            page.locator(buttonSelector);

          const count =
            await candidates.count();

          lastDiagnostics = [];

          for (
            let index = 0;
            index < count;
            index += 1
          ) {
            const candidate =
              candidates.nth(index);

            try {
              const details =
                await candidate.evaluate(
                  element => ({
                    text:
                      String(
                        element.innerText ||
                        element.textContent ||
                        ''
                      )
                        .replace(/\s+/g, ' ')
                        .trim(),

                    value:
                      String(
                        element.value || ''
                      )
                        .replace(/\s+/g, ' ')
                        .trim(),

                    ariaLabel:
                      String(
                        element.getAttribute(
                          'aria-label'
                        ) || ''
                      )
                        .replace(/\s+/g, ' ')
                        .trim(),

                    ariaHidden:
                      element.getAttribute(
                        'aria-hidden'
                      ),

                    className:
                      String(
                        element.className || ''
                      ),
                  })
                );

              const visible =
                await candidate.isVisible();

              const enabled =
                await candidate.isEnabled();

              const labels = [
                details.text,
                details.value,
                details.ariaLabel,
              ].filter(Boolean);

              const hiddenAuth0Button =
                details.ariaHidden === 'true' ||
                details.className.includes(
                  'ulp-hidden-form-submit-button'
                );

              lastDiagnostics.push({
                index,
                labels,
                visible,
                enabled,
                ariaHidden:
                  details.ariaHidden,
                className:
                  details.className,
              });

              if (
                visible &&
                enabled &&
                !hiddenAuth0Button &&
                labels.some(label =>
                  acceptedLabelPattern.test(label)
                )
              ) {
                console.log(
                  [
                    'Using visible login control',
                    `${index + 1}/${count}:`,
                    labels.join(' | '),
                  ].join(' ')
                );

                return candidate;
              }
            } catch (_error) {
              // Auth0 may rerender while changing stages.
            }
          }

          await page.waitForTimeout(250);
        }

        console.log(
          'Login controls at timeout:',
          JSON.stringify(
            lastDiagnostics,
            null,
            2
          )
        );

        return null;
      }

      async function getVisibleLoginErrors() {
        const candidates =
          page.locator(
            [
              '[role="alert"]',
              '[aria-live="assertive"]',
              '[data-testid*="error"]',
              '.error-message',
            ].join(', ')
          );

        const messages = [];
        const count = Math.min(
          await candidates.count(),
          5
        );

        for (
          let index = 0;
          index < count;
          index += 1
        ) {
          const candidate =
            candidates.nth(index);

          try {
            if (await candidate.isVisible()) {
              const message =
                String(
                  await candidate.innerText()
                ).trim();

              if (
                message &&
                !messages.includes(message)
              ) {
                messages.push(message);
              }
            }
          } catch (_error) {
            // Ignore disappearing validation elements.
          }
        }

        return messages;
      }

      const emailInput =
        page.locator(
          [
            '#username',
            'input[type="email"]',
            'input[name="email"]',
            'input[autocomplete="username"]',
            '[data-testid="email"]',
          ].join(', ')
        ).first();

      await emailInput.waitFor({
        state: 'visible',
        timeout: 60000,
      });

      console.log(
        'Email field displayed.'
      );

      await emailInput.click();
      await emailInput.fill('');
      await emailInput.fill(email);

      await page.waitForTimeout(300);

      const enteredEmail =
        await emailInput.inputValue();

      if (
        enteredEmail.trim() !==
        email.trim()
      ) {
        throw new Error(
          'Email field did not retain TEST_LOGIN_EMAIL.'
        );
      }

      const emailSubmit =
        await findVisibleLoginButton(
          30000
        );

      if (!emailSubmit) {
        throw new Error(
          'Could not find the visible Log in button for the email step.'
        );
      }

      console.log(
        'Email entered. Clicking first visible Log in button.'
      );

      /*
       * Auth0 contains a hidden submit button before the visible
       * button. Calling the visible element's DOM click avoids the
       * hidden button and the floating-label pointer interception.
       */
      await emailSubmit.evaluate(
        button => button.click()
      );

      console.log(
        'First Log in button clicked. Waiting for password field.'
      );

      let passwordInput =
        page.locator(
          [
            'input[type="password"]',
            'input[name="password"]',
            'input[autocomplete="current-password"]',
            '[data-testid="password"]',
          ].join(', ')
        ).first();

      await passwordInput.waitFor({
        state: 'visible',
        timeout: 60000,
      });

      console.log(
        'Password field displayed.'
      );

      await passwordInput.click();
      await passwordInput.fill('');
      await passwordInput.fill(password);

      await page.waitForTimeout(500);

      let enteredPassword =
        await passwordInput
          .inputValue()
          .catch(() => '');

      if (
        enteredPassword !==
        password
      ) {
        console.log(
          'Password field rerendered. Locating and filling it again.'
        );

        passwordInput =
          page.locator(
            [
              'input[type="password"]',
              'input[name="password"]',
              'input[autocomplete="current-password"]',
              '[data-testid="password"]',
            ].join(', ')
          ).first();

        await passwordInput.waitFor({
          state: 'visible',
          timeout: 30000,
        });

        await passwordInput.click();
        await passwordInput.fill('');
        await passwordInput.fill(password);

        await page.waitForTimeout(500);

        enteredPassword =
          await passwordInput
            .inputValue()
            .catch(() => '');
      }

      if (
        enteredPassword !==
        password
      ) {
        throw new Error(
          'Password field did not retain TEST_LOGIN_PASSWORD.'
        );
      }

      const passwordSubmit =
        await findVisibleLoginButton(
          30000
        );

      if (!passwordSubmit) {
        throw new Error(
          'Could not find the visible Log in button for the password step.'
        );
      }

      console.log(
        'Password entered. Clicking second visible Log in button.'
      );

      const authenticationHost =
        new URL(loginUrl).host;

      console.log(
        'Clicking second Log in button.'
      );

      await passwordSubmit.evaluate(
        button => button.click()
      );

      console.log(
        'Second Log in button clicked. Waiting for Auth0 completion.'
      );

      /*
       * Auth0 clears the password and can remain on:
       * /u/login/password#postSuccessLogin
       *
       * Treat that hash as an intermediate successful state rather
       * than waiting indefinitely for an automatic redirect.
       */
      const completionDeadline =
        Date.now() + 30000;

      while (
        Date.now() <
        completionDeadline
      ) {
        const currentUrl =
          page.url();

        const currentHost =
          new URL(currentUrl).host;

        if (
          currentHost !==
          authenticationHost
        ) {
          break;
        }

        if (
          currentUrl.includes(
            '#postSuccessLogin'
          )
        ) {
          break;
        }

        await page.waitForTimeout(250);
      }

      let currentUrl =
        page.url();

      let currentHost =
        new URL(currentUrl).host;

      if (
        currentHost ===
          authenticationHost &&
        currentUrl.includes(
          '#postSuccessLogin'
        )
      ) {
        console.log(
          'Auth0 post-success state reached.'
        );

        const applicationUrl =
          targetEnv === 'PROD'
            ? (
                process.env.URL_PROD ||
                process.env.WEB_BASE_URL ||
                process.env.BASE_URL
              )
            : (
                process.env.URL_UAT ||
                process.env.WEB_BASE_URL ||
                process.env.BASE_URL
              );

        if (!applicationUrl) {
          throw new Error(
            [
              `Application URL is missing for ${targetEnv}.`,
              `Configure URL_${targetEnv}, WEB_BASE_URL or BASE_URL.`,
            ].join(' ')
          );
        }

        console.log(
          `Opening authenticated application: ${applicationUrl}`
        );

        await page.goto(
          applicationUrl,
          {
            waitUntil:
              'domcontentloaded',
            timeout: 120000,
          }
        );

        await page.waitForTimeout(
          3000
        );

        currentUrl =
          page.url();

        currentHost =
          new URL(currentUrl).host;
      }

      if (
        currentHost ===
        authenticationHost
      ) {
        const errors =
          await getVisibleLoginErrors();

        throw new Error(
          [
            'Authentication remained on the Auth0 domain.',
            `Current URL: ${currentUrl}`,
            errors.length
              ? `Visible error: ${errors.join(' | ')}`
              : 'No visible authentication error was detected.',
          ].join(' ')
        );
      }

      console.log(
        `Deterministic login completed: ${currentUrl}`
      );

      await page.waitForLoadState(
        'domcontentloaded',
        {
          timeout: 30000,
        }
      ).catch(() => {});

      await page.waitForTimeout(2000);

      if (
        new URL(page.url()).host ===
        authenticationHost
      ) {
        throw new Error(
          `Login remained on the authentication domain: ${page.url()}`
        );
      }

      console.log(
        `Deterministic login completed: ${page.url()}`
      );

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
