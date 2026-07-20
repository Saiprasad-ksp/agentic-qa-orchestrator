'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_RESPONSE_TIMEOUT = Number(
  process.env.OLIVE_RESPONSE_TIMEOUT_MS || 60000
);

const OPEN_TIMEOUT = Number(
  process.env.OLIVE_OPEN_TIMEOUT_MS || 60000
);

const RESPONSE_STABLE_MS = Number(
  process.env.OLIVE_RESPONSE_STABLE_MS || 1800
);

const MAX_RESPONSE_CHARS = Number(
  process.env.MAX_BOT_RESPONSE_CHARS || 3000
);

const INITIAL_READY_TIMEOUT_MS = Number(
  process.env.OLIVE_INITIAL_GREETING_TIMEOUT_MS || 30000
);

const INITIAL_READY_STABLE_MS = Number(
  process.env.OLIVE_INITIAL_GREETING_STABLE_MS || 1800
);

const INITIAL_MIN_WAIT_MS = Number(
  process.env.OLIVE_INITIAL_MIN_WAIT_MS || 3500
);

function normaliseLines(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .split(/\r?\n|\s{2,}/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function isNoiseLine(line, userMessage = '') {
  const value = String(line || '').trim();

  if (!value) {
    return true;
  }

  if (
    userMessage &&
    value.toLowerCase() ===
      String(userMessage).trim().toLowerCase()
  ) {
    return true;
  }

  return [
    /^send$/i,
    /^sent\s+\d{1,2}:\d{2}\s*(?:am|pm)?$/i,
    /^ai beta$/i,
    /^try asking$/i,
    /^ask anything$/i,
    /^how can we help\??$/i,
    /^chat with olive$/i,
    /^chat now$/i,
    /^skip to main content$/i,
    /^browse topics$/i,
    /^contact us$/i,
    /^close$/i,
    /^back$/i,
    /^\d+\s*\/\s*\d+$/i,
    /^slide\s+\d+\s+of\s+\d+$/i,
  ].some(pattern => pattern.test(value));
}

async function visible(locator, timeout = 500) {
  return locator
    .isVisible({ timeout })
    .catch(() => false);
}


function loadDeterministicLoginConfig() {
  const credentialsPath = path.resolve(
    process.cwd(),
    process.env.AGENTIC_QA_CREDENTIALS_DIR || '.credentials',
    'login.env'
  );

  if (fs.existsSync(credentialsPath)) {
    const allowed = new Set([
      'LOGIN_URL_UAT',
      'LOGIN_URL_PROD',
      'TEST_LOGIN_EMAIL',
      'TEST_LOGIN_PASSWORD',
    ]);

    for (const original of fs.readFileSync(credentialsPath, 'utf8').replace(/\r/g, '').split('\n')) {
      let line = original.trim().replace(/^export\s+/, '');
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const index = line.indexOf('=');
      const key = line.slice(0, index).trim();
      if (!allowed.has(key)) continue;
      let value = line.slice(index + 1).trim();
      if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
      process.env[key] = value;
    }
  }

  const targetEnv = String(process.env.TARGET_ENV || 'UAT').toUpperCase();
  const loginUrl = targetEnv === 'PROD' ? process.env.LOGIN_URL_PROD : process.env.LOGIN_URL_UAT;
  const email = process.env.TEST_LOGIN_EMAIL;
  const password = process.env.TEST_LOGIN_PASSWORD;
  return { loginUrl, email, password };
}

async function findEnabledAuthSubmit(page, timeout = 30000) {
  const selector = [
    'button[data-action-button-primary="true"]:not([aria-hidden="true"]):not(.ulp-hidden-form-submit-button)',
    'button[type="submit"]:not([aria-hidden="true"]):not(.ulp-hidden-form-submit-button)',
  ].join(', ');
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const candidates = page.locator(selector);
    for (let index = 0; index < await candidates.count(); index += 1) {
      const candidate = candidates.nth(index);
      if (await candidate.isVisible().catch(() => false) && await candidate.isEnabled().catch(() => false)) return candidate;
    }
    await page.waitForTimeout(250);
  }
  return null;
}

async function performDeterministicWebLogin(page, targetUrl) {
  const { loginUrl, email, password } = loadDeterministicLoginConfig();
  if (!loginUrl || !email || !password) {
    throw new Error('Deterministic login configuration is incomplete. Check .credentials/login.env.');
  }

  console.log(`[Auth] Starting deterministic login: ${loginUrl}`);
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });

  const emailInput = page.locator([
    '#username', 'input[type="email"]', 'input[name="email"]',
    'input[autocomplete="username"]', '[data-testid="email"]',
  ].join(', ')).first();
  await emailInput.waitFor({ state: 'visible', timeout: 60000 });
  await emailInput.fill(email);

  const firstSubmit = await findEnabledAuthSubmit(page);
  if (!firstSubmit) throw new Error('Deterministic login email submit button was not found.');
  await firstSubmit.click();

  const passwordInput = page.locator([
    '#password', 'input[type="password"]', 'input[name="password"]',
    'input[autocomplete="current-password"]', '[data-testid="password"]',
  ].join(', ')).first();
  await passwordInput.waitFor({ state: 'visible', timeout: 60000 });
  await passwordInput.fill(password);
  if (await passwordInput.inputValue().catch(() => '') !== password) {
    await passwordInput.fill('');
    await passwordInput.fill(password);
  }

  const secondSubmit = await findEnabledAuthSubmit(page);
  if (!secondSubmit) throw new Error('Deterministic login password submit button was not found.');
  await secondSubmit.evaluate(button => button.click());
  await page.waitForURL(url => !/\/u\/login|\/authorize|auth0/i.test(String(url)), { timeout: 120000 }).catch(() => {});
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(2500);
  if (/\/u\/login|\/authorize|auth0/i.test(page.url())) {
    throw new Error(`Deterministic authentication failed. Current URL: ${page.url()}`);
  }
  console.log(`[Auth] Deterministic login completed: ${page.url()}`);
}

function detectConversationState(text) {
  return String(text || '').trim() ? 'OBSERVED_RESPONSE' : 'UNKNOWN';
}

class OliveWebBot {
  constructor(page, options = {}) {
    this.page = page;

    this.responseTimeout =
      options.responseTimeout ||
      DEFAULT_RESPONSE_TIMEOUT;

    this.lastSurface = null;
    this.lastChatRoot = null;

    this.initialChatReady = false;
    this.initialGreetingLines = [];
    this.structuredStateBaselineLines = [];
    this.runtimeElements = new Map();
    this.runtimeElementSequence = 0;
  }

  async goto(url) {
    await this.page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    await this.page
      .waitForLoadState('networkidle', {
        timeout: 30000,
      })
      .catch(() => {});

    await this.page.waitForTimeout(1200);
  }

  async open() {
    const existing = await this.findChatSurface({
      timeout: 2500,
    });

    if (existing) {
      await this.waitUntilReady(existing);

      this.structuredStateBaselineLines =
        await this.readChatLines();

      return existing;
    }

    await this.dismissOverlays();

    const deadline = Date.now() + OPEN_TIMEOUT;

    let attempt = 0;
    let lastControls = '';

    while (Date.now() < deadline) {
      attempt += 1;

      console.log(
        `[Olive] Open attempt ${attempt}; ` +
        `URL=${this.page.url()}; ` +
        `frames=${this.page.frames().length}`
      );

      /*
       * A previous click may have started the widget asynchronously.
       * Detect that surface before clicking the launcher again.
       */
      const appearedSurface =
        await this.findChatSurface({
          timeout: 1500,
        });

      if (appearedSurface) {
        console.log(
          '[Olive] Existing chat surface detected.'
        );

        await this.waitUntilReady(
          appearedSurface
        );

        this.structuredStateBaselineLines =
          await this.readChatLines();

        return appearedSurface;
      }

      const direct =
        await this.tryClickKnownChatTriggers(
          `direct-${attempt}`
        );

      if (direct) {
        return direct;
      }

      const accordion =
        await this.tryOpenHelpAccordionsAndChat();

      if (accordion) {
        return accordion;
      }

      await this.page.mouse
        .wheel(0, 900)
        .catch(() => {});

      await this.page.waitForTimeout(600);

      const afterScroll =
        await this.tryClickKnownChatTriggers(
          `scroll-${attempt}`
        );

      if (afterScroll) {
        return afterScroll;
      }

      lastControls =
        await this.dumpVisibleControls(25);
    }

    const screenshotPath = await this
      .screenshot(
        `olive-open-failed-${Date.now()}`
      )
      .catch(() => 'not-created');

    throw new Error(
      `Unable to open Olive within ${OPEN_TIMEOUT}ms. ` +
      `Screenshot: ${screenshotPath}\n` +
      `Visible controls near failure:\n` +
      `${lastControls || 'No controls captured.'}`
    );
  }

  async dismissOverlays() {
    const patterns =
      /accept all|accept|agree|got it|continue|no thanks|close/i;

    for (const role of ['button', 'link']) {
      const locator = this.page
        .getByRole(role, {
          name: patterns,
        })
        .first();

      if (await visible(locator, 1000)) {
        await locator
          .click({
            timeout: 3000,
          })
          .catch(() => {});

        await this.page.waitForTimeout(400);
      }
    }
  }

  async tryClickKnownChatTriggers(label) {
    const patterns =
      /chat\s*now|chat\s*with\s*olive|ask\s*olive|ask\s*anything|message\s*us|start\s*chat|live\s*chat|online\s*chat|customer\s*support|get\s*help/i;

    /*
     * The Woolworths homepage can contain hidden SSR/Angular copies of
     * the Olive launcher. Do not use `.first()` before filtering by
     * visibility because it can select the hidden copy.
     */
    const candidates = [
      this.page.locator(
        'button.olive-chat-link:visible'
      ),

      this.page.locator(
        'shared-olive-chat-button ' +
        'button:visible'
      ),

      this.page.locator([
        'button[aria-label="Chat with Olive"]:visible',
        'button[aria-label*="olive" i]:visible',
        'button[title*="olive" i]:visible',
        '[role="button"][aria-label*="olive" i]:visible',
        '[data-testid*="olive" i]:visible',
      ].join(',')),

      this.page.getByRole('button', {
        name: patterns,
      }),

      this.page.getByRole('link', {
        name: patterns,
      }),

      this.page
        .locator(
          'button:visible, ' +
          'a:visible, ' +
          '[role="button"]:visible'
        )
        .filter({
          hasText: patterns,
        }),
    ];

    const surfaceTimeout = Number(
      process.env.OLIVE_SURFACE_TIMEOUT_MS ||
      6000
    );

    for (const candidateGroup of candidates) {
      const count = Math.min(
        await candidateGroup.count().catch(() => 0),
        20
      );

      for (let index = 0; index < count; index += 1) {
        const locator = candidateGroup.nth(index);

        if (!(await visible(locator, 1000))) {
          continue;
        }

        const description = await locator
          .evaluate(element => ({
            tag: element.tagName,
            text: String(
              element.innerText ||
              element.textContent ||
              ''
            )
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 150),
            ariaLabel:
              element.getAttribute('aria-label') ||
              '',
            className:
              typeof element.className === 'string'
                ? element.className
                : '',
          }))
          .catch(() => null);

        console.log(
          `[Olive] Trigger candidate ${label}: ` +
          `${JSON.stringify(description)}`
        );

        await locator
          .scrollIntoViewIfNeeded()
          .catch(() => {});

        let clicked = false;

        try {
          await locator.click({
            timeout: 7000,
          });

          clicked = true;
        } catch (normalClickError) {
          console.log(
            `[Olive] Normal click failed: ` +
            `${normalClickError.message}`
          );

          try {
            await locator.click({
              timeout: 7000,
              force: true,
            });

            clicked = true;
          } catch (forceClickError) {
            console.log(
              `[Olive] Force click failed: ` +
              `${forceClickError.message}`
            );
          }
        }

        if (!clicked) {
          continue;
        }

        console.log(
          `[Olive] Clicked trigger during ${label}.`
        );

        /*
         * Allow the external widget bootstrap script to create its
         * iframe/container and textbox.
         */
        const surface =
          await this.findChatSurface({
            timeout: surfaceTimeout,
          });

        if (surface) {
          console.log(
            `[Olive] Chat surface detected after ${label}.`
          );

          await this.waitUntilReady(surface);

          this.structuredStateBaselineLines =
            await this.readChatLines();

          return surface;
        }

        /*
         * Do not immediately click another overlapping Olive locator.
         * The widget may still be initialising. The next open-loop
         * iteration checks for an existing surface before clicking.
         */
        return null;
      }
    }

    return null;
  }

  async tryOpenHelpAccordionsAndChat() {
    const accordions = this.page.locator(
      'button[aria-expanded], ' +
      '[role="button"][aria-expanded]'
    );

    const count = Math.min(
      await accordions
        .count()
        .catch(() => 0),
      12
    );

    for (
      let index = 0;
      index < count;
      index += 1
    ) {
      const button = accordions.nth(index);

      if (!(await visible(button, 500))) {
        continue;
      }

      const expanded = await button
        .getAttribute('aria-expanded')
        .catch(() => null);

      if (expanded === 'true') {
        continue;
      }

      await button
        .scrollIntoViewIfNeeded()
        .catch(() => {});

      await button
        .click({
          timeout: 5000,
        })
        .catch(() => {});

      await this.page.waitForTimeout(600);

      const opened =
        await this.tryClickKnownChatTriggers(
          `accordion-${index + 1}`
        );

      if (opened) {
        return opened;
      }
    }

    return null;
  }

  async surfaces() {
    return [
      this.page,
      ...this.page.frames(),
    ];
  }

  async findChatSurface({
    timeout = 8000,
  } = {}) {
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const surfaces = await this.surfaces();

      for (const surface of surfaces) {
        const input =
          await this.findInputInSurface(
            surface
          );

        if (input) {
          this.lastSurface = surface;

          this.lastChatRoot =
            await this.findChatRoot(
              surface,
              input
            );

          return surface;
        }
      }

      await this.page.waitForTimeout(350);
    }

    return null;
  }

  async isInputReady(surface) {
    const input =
      await this.findInputInSurface(surface);

    if (!input) {
      return false;
    }

    if (!(await visible(input, 500))) {
      return false;
    }

    const disabled = await input
      .isDisabled()
      .catch(() => false);

    const ariaDisabled = await input
      .getAttribute('aria-disabled')
      .catch(() => null);

    return (
      !disabled &&
      ariaDisabled !== 'true'
    );
  }

  async isOliveBusy() {
    const root = this.lastChatRoot;

    if (!root) {
      return false;
    }

    const busySelectors = [
      '[aria-busy="true"]',
      '[role="progressbar"]',
      '[data-testid*="typing" i]',
      '[class*="typing" i]',
      '[class*="loading" i]',
      '[class*="spinner" i]',
    ].join(',');

    const busyElement = root
      .locator(busySelectors)
      .first();

    if (await visible(busyElement, 250)) {
      return true;
    }

    const rootText = await root
      .innerText()
      .catch(() => '');

    return (
      /\b(?:olive is typing|typing…|typing\.\.\.)\b/i
        .test(rootText)
    );
  }

  async waitUntilReady(surface) {
    if (this.initialChatReady) {
      return {
        ready: true,
        greetingLines:
          this.initialGreetingLines,
      };
    }

    this.lastSurface = surface;

    const input =
      await this.findInputInSurface(surface);

    if (input) {
      this.lastChatRoot =
        this.lastChatRoot ||
        await this.findChatRoot(
          surface,
          input
        );
    }

    const startedAt = Date.now();

    const deadline =
      startedAt +
      INITIAL_READY_TIMEOUT_MS;

    let lastSignature = '';
    let stableSince = 0;
    let inputReadySince = 0;
    let bestLines = [];

    while (Date.now() < deadline) {
      await this.page.waitForTimeout(300);

      const inputReady =
        await this.isInputReady(surface);

      const busy =
        await this.isOliveBusy();

      let lines = [];

      try {
        lines = await this.readChatLines();
      } catch {
        lines = [];
      }

      const cleaned = lines
        .map(line =>
          String(line || '').trim()
        )
        .filter(Boolean)
        .filter(line =>
          !isNoiseLine(line)
        )
        .filter(
          (line, index, values) =>
            values.indexOf(line) === index
        );

      if (
        cleaned.join('\n').length >
        bestLines.join('\n').length
      ) {
        bestLines = cleaned;
      }

      const signature =
        cleaned.join('\n');

      if (signature === lastSignature) {
        if (!stableSince) {
          stableSince = Date.now();
        }
      } else {
        lastSignature = signature;
        stableSince = Date.now();
      }

      if (inputReady) {
        inputReadySince =
          inputReadySince ||
          Date.now();
      } else {
        inputReadySince = 0;
      }

      const inputStable =
        Boolean(inputReadySince) &&
        Date.now() - inputReadySince >=
          INITIAL_READY_STABLE_MS;

      const contentStable =
        Boolean(stableSince) &&
        Date.now() - stableSince >=
          INITIAL_READY_STABLE_MS;

      const minimumWaitCompleted =
        Date.now() - startedAt >=
          INITIAL_MIN_WAIT_MS;

      if (
        inputReady &&
        !busy &&
        inputStable &&
        contentStable &&
        minimumWaitCompleted
      ) {
        /*
         * Olive can render the welcome sequence as multiple
         * delayed bubbles even after the input becomes enabled.
         * Require a continuous quiet period before allowing the
         * first customer message.
         */
        const greetingQuietWindowMs =
          Number(
            process.env
              .OLIVE_GREETING_QUIET_WINDOW_MS ||
            4000
          );

        const greetingQuietDeadline =
          Date.now() +
          Math.max(
            greetingQuietWindowMs * 3,
            12000
          );

        let quietSignature =
          signature;

        let quietSince =
          Date.now();

        let greetingStillBusy = false;

        while (
          Date.now() <
          greetingQuietDeadline
        ) {
          await this.page.waitForTimeout(350);

          greetingStillBusy =
            await this.isOliveBusy();

          const currentLines =
            await this.readChatLines()
              .catch(() => []);

          const currentSignature =
            currentLines
              .map(line =>
                String(line || '').trim()
              )
              .filter(Boolean)
              .filter(line =>
                !isNoiseLine(line)
              )
              .filter(
                (line, index, values) =>
                  values.indexOf(line) === index
              )
              .join('\n');

          if (
            currentSignature !==
            quietSignature
          ) {
            console.log(
              '[Olive] Additional greeting content detected; resetting quiet window.'
            );

            quietSignature =
              currentSignature;

            quietSince =
              Date.now();
          }

          const currentInputReady =
            await this.isInputReady(
              surface
            );

          const quietForMs =
            Date.now() -
            quietSince;

          if (
            currentInputReady &&
            !greetingStillBusy &&
            quietSignature &&
            quietForMs >=
              greetingQuietWindowMs
          ) {
            this.initialChatReady =
              true;

            this.initialGreetingLines =
              await this.readChatLines();

            console.log(
              `✅ Olive greeting completed after ${quietForMs}ms quiet window.`
            );

            return {
              ready: true,
              greetingLines:
                this.initialGreetingLines,
            };
          }
        }

        /*
         * Do not mark the widget ready merely because the input
         * is enabled. Continue the outer readiness loop when the
         * greeting has not remained quiet.
         */
        stableSince = Date.now();
      }
    }

    const inputReady =
      await this.isInputReady(surface);

    const busy =
      await this.isOliveBusy();

    /*
     * Only use the fallback when the input is
     * available and no loading indicator remains.
     */
    if (inputReady && !busy) {
      await this.page.waitForTimeout(800);

      this.initialChatReady = true;
      this.initialGreetingLines =
        await this.readChatLines();

      console.warn(
        '⚠️ Greeting text was not fully detectable, ' +
        'but the Olive input is enabled and stable.'
      );

      return {
        ready: true,
        greetingLines:
          this.initialGreetingLines,
        fallback: true,
      };
    }

    const screenshotPath = await this
      .screenshot(
        `olive-readiness-timeout-${Date.now()}`
      )
      .catch(() => null);

    throw new Error(
      `Olive chat did not become ready within ` +
      `${INITIAL_READY_TIMEOUT_MS}ms. ` +
      `Screenshot: ` +
      `${screenshotPath || 'not-created'}`
    );
  }

  async findInputInSurface(surface) {
    const candidates = [
      () =>
        surface
          .getByRole('textbox', {
            name:
              /ask anything|message|type|reply|chat|question/i,
          })
          .first(),

      () =>
        surface
          .getByPlaceholder(
            /ask anything|message|type|reply|chat|question/i
          )
          .first(),

      () =>
        surface
          .locator(
            'textarea:visible, ' +
            'input[type="text"]:visible, ' +
            '[contenteditable="true"]:visible'
          )
          .last(),
    ];

    for (const makeLocator of candidates) {
      const locator = makeLocator();

      if (await visible(locator, 700)) {
        return locator;
      }
    }

    return null;
  }

  async findChatRoot(surface, input) {
    const handle = await input
      .elementHandle()
      .catch(() => null);

    if (!handle) {
      return surface.locator('body');
    }

    const rootHandle =
      await handle.evaluateHandle(
        element => {
          const selectors = [
            '[role="dialog"]',
            '[aria-modal="true"]',
            '[data-testid*="chat" i]',
            '[data-testid*="olive" i]',
            '[class*="chat" i]',
            '[class*="conversation" i]',
            '[id*="chat" i]',
            '[id*="olive" i]',
            'section',
            'aside',
          ];

          for (const selector of selectors) {
            const root =
              element.closest(selector);

            if (
              root &&
              root.querySelectorAll('*').length <
                2500
            ) {
              return root;
            }
          }

          return (
            element.closest(
              '[role="dialog"], ' +
              '[aria-modal="true"], ' +
              'section, aside'
            ) ||
            element.parentElement
              ?.parentElement
              ?.parentElement ||
            element.parentElement
          );
        }
      );

    return surface
      .locator(':scope')
      .locator(rootHandle);
  }

  async readChatLines() {
    const surface =
      this.lastSurface ||
      await this.findChatSurface({
        timeout: 2500,
      });

    if (!surface) {
      return [];
    }

    const input =
      await this.findInputInSurface(surface);

    if (!input) {
      return [];
    }

    /*
     * Read only the chatbot container around the input.
     * Never fall back to the complete application page.
     */
    const lines = await input
      .evaluate(element => {
        const normalise = value =>
          String(value || '')
            .replace(/\u00a0/g, ' ')
            .replace(/[ \t]+/g, ' ')
            .trim();

        const isVisible = node => {
          if (!(node instanceof Element)) {
            return false;
          }

          const style =
            window.getComputedStyle(node);

          const rect =
            node.getBoundingClientRect();

          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width > 0 &&
            rect.height > 0
          );
        };

        let root =
          element.closest(
            '[role="dialog"], ' +
            '[aria-modal="true"], ' +
            '[role="region"], ' +
            'aside'
          );

        /*
         * Generic fallback: walk upward from the input and choose the
         * smallest visible ancestor with useful chatbot-sized content.
         */
        if (!root) {
          let current =
            element.parentElement;

          while (current) {
            if (!isVisible(current)) {
              current =
                current.parentElement;
              continue;
            }

            const value =
              normalise(
                current.innerText ||
                current.textContent
              );

            const bounds =
              current.getBoundingClientRect();

            const usefulSize =
              bounds.width >= 250 &&
              bounds.height >= 250;

            const usefulText =
              value.length >= 30 &&
              value.length <= 12000;

            if (
              usefulSize &&
              usefulText &&
              current.contains(element)
            ) {
              root = current;
              break;
            }

            current =
              current.parentElement;
          }
        }

        if (!root) {
          return [];
        }

        const rawText =
          String(
            root.innerText ||
            root.textContent ||
            ''
          );

        return [
          ...new Set(
            rawText
              .split(/\r?\n/)
              .map(normalise)
              .filter(Boolean)
              .filter(line =>
                line.length <= 2000
              )
          ),
        ];
      })
      .catch(error => {
        console.warn(
          `⚠️ Chatbot text extraction failed: ${error.message}`
        );

        return [];
      });

    return lines;
  }

  redactRuntimeLabel(value) {
    return String(value || '')
      .replace(/\b\d{6,}\b/g, '[REDACTED_ID]')
      .replace(/\b[A-Z0-9]{12,}\b/gi, '[REDACTED_TOKEN]')
      .replace(/\s+/g, ' ')
      .trim();
  }

  registerRuntimeElement(locator, kind, metadata = {}) {
    this.runtimeElementSequence += 1;
    const id = `${kind}_${this.runtimeElementSequence}`;
    this.runtimeElements.set(id, { locator, kind, metadata });
    return id;
  }

  async captureStructuredState() {
    const surface =
      this.lastSurface ||
      await this.findChatSurface({ timeout: 4000 }) ||
      await this.open();

    const input = await this.findInputInSurface(surface);
    const root = this.lastChatRoot ||
      (input ? await this.findChatRoot(surface, input) : null);
    /*
     * The chat root is useful for transcript extraction, but some
     * implementations render controls and the textbox outside that
     * container. Interactive discovery must use the whole Olive
     * surface/frame.
     */
    const scope = surface;

    this.runtimeElements.clear();
    this.runtimeElementSequence = 0;

    const allLines =
      await this.readChatLines();

    const baseline =
      Array.isArray(
        this.structuredStateBaselineLines
      )
        ? this.structuredStateBaselineLines
        : [];

    let currentLines = allLines;

    if (
      baseline.length &&
      allLines.length >= baseline.length
    ) {
      const prefixMatches =
        baseline.every(
          (line, index) =>
            allLines[index] === line
        );

      if (prefixMatches) {
        currentLines =
          allLines.slice(
            baseline.length
          );
      }
    }

    const messages = currentLines
      .slice(-30)
      .map((text, index) => ({
        id: `message_${index + 1}`,
        text:
          this.redactRuntimeLabel(
            text
          ),
      }));

    const controls = [];
    const seen = new Set();
    const candidates = scope.locator(
      'button, a, [role="button"], [role="option"], [role="link"], [role="menuitem"], [role="checkbox"], [role="radio"]'
    );
    const controlCount = Math.min(await candidates.count().catch(() => 0), 100);

    for (let index = 0; index < controlCount; index += 1) {
      const locator = candidates.nth(index);
      if (!(await visible(locator, 150))) continue;
      const rawLabel = String(
        await locator.getAttribute('aria-label').catch(() => '') ||
        await locator.innerText().catch(() => '') ||
        await locator.getAttribute('title').catch(() => '') || ''
      ).replace(/\s+/g, ' ').trim();
      if (!rawLabel) continue;
      const key = `${rawLabel}|${await locator.getAttribute('role').catch(() => '')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const id = this.registerRuntimeElement(locator, 'control', { rawLabel });
      controls.push({
        id,
        type: await locator.getAttribute('role').catch(() => null) ||
          await locator.evaluate(el => el.tagName.toLowerCase()).catch(() => 'control'),
        label: this.redactRuntimeLabel(rawLabel),
        enabled: !(await locator.isDisabled().catch(() => false)) &&
          await locator.getAttribute('aria-disabled').catch(() => null) !== 'true',
      });
    }

    const inputs = [];
    const inputCandidates = scope.locator('textarea, input:not([type="hidden"]), [contenteditable="true"], [role="textbox"]');
    const inputCount = Math.min(await inputCandidates.count().catch(() => 0), 20);
    for (let index = 0; index < inputCount; index += 1) {
      const locator = inputCandidates.nth(index);
      if (!(await visible(locator, 150))) continue;
      const id = this.registerRuntimeElement(locator, 'input');
      inputs.push({
        id,
        type: await locator.getAttribute('type').catch(() => null) || 'text',
        placeholder: this.redactRuntimeLabel(
          await locator.getAttribute('placeholder').catch(() => '') ||
          await locator.getAttribute('aria-label').catch(() => '') || ''
        ),
        enabled: !(await locator.isDisabled().catch(() => false)) &&
          await locator.getAttribute('aria-disabled').catch(() => null) !== 'true',
      });
    }

    return {
      surfaceReady: Boolean(surface && input),
      busy: await this.isOliveBusy().catch(() => false),
      messages,
      controls,
      inputs,
      url: this.page.url(),
      capturedAt: new Date().toISOString(),
    };
  }

  async executeStructuredAction(action = {}) {
    const kind = String(action.action || '').toUpperCase();
    const targetId = String(action.targetId || '');
    const value = String(action.value || '');

    if (kind === 'WAIT') {
      await this.page.waitForTimeout(Math.min(Math.max(Number(action.waitMs || 1200), 250), 10000));
      return { executed: true, action: kind };
    }
    if (kind === 'COMPLETE' || kind === 'FAIL') {
      return { executed: true, action: kind };
    }

    let entry = targetId ? this.runtimeElements.get(targetId) : null;
    if (!entry && kind === 'SEND_MESSAGE') {
      const firstInput = [...this.runtimeElements.values()].find(item => item.kind === 'input');
      entry = firstInput || null;
    }
    if (!entry) throw new Error(`Runtime element not found: ${targetId || '<none>'}`);

    const locator = entry.locator;
    if (!(await visible(locator, 2000))) throw new Error(`Runtime element is no longer visible: ${targetId}`);

    if (kind === 'CLICK') {
      await locator.scrollIntoViewIfNeeded().catch(() => {});
      await locator.click({ timeout: 10000 });
    } else if (kind === 'TYPE' || kind === 'SEND_MESSAGE') {
      if (!value.trim()) throw new Error(`${kind} requires a non-empty value.`);
      await locator.click({ timeout: 10000 });
      await locator.fill(value).catch(async () => {
        await locator.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
        await locator.type(value, { delay: 8 });
      });
      if (kind === 'SEND_MESSAGE') {
        const surface = this.lastSurface || await this.findChatSurface({ timeout: 2000 });
        const send = surface?.getByRole('button', { name: /^send$/i }).last();
        const sendReady = send && await visible(send, 800) && await send.isEnabled().catch(() => false);
        if (sendReady) await send.click({ timeout: 5000 });
        else await locator.press('Enter');
      }
    } else {
      throw new Error(`Unsupported structured action: ${kind}`);
    }

    await this.page.waitForTimeout(600);
    return { executed: true, action: kind, targetId };
  }

  async clickControl(targetText) {
    const beforeLines =
      await this.readChatLines();

    const value =
      String(targetText || '')
        .replace(/^text:\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim();

    if (!value) {
      throw new Error(
        'Olive control text is required.'
      );
    }

    const surface =
      this.lastSurface ||
      await this.findChatSurface({
        timeout: 5000,
      });

    if (!surface) {
      throw new Error(
        'Olive chat surface is not available.'
      );
    }

    /*
     * Do not build a RegExp from user-visible text because order
     * labels can contain punctuation. Use exact accessible text
     * first, then exact visible text.
     */
    /*
     * Business placeholders are resolved entirely inside Playwright.
     * Customer order identifiers remain local and are never sent to
     * the planner.
     */
    const candidates = [
      surface.getByRole(
        'button',
        {
          name: value,
          exact: true,
        }
      ),
      surface.getByRole(
        'option',
        {
          name: value,
          exact: true,
        }
      ),
      surface.getByRole(
        'link',
        {
          name: value,
          exact: true,
        }
      ),
      surface.getByText(
        value,
        {
          exact: true,
        }
      ),
    ];

    for (const candidateGroup of candidates) {
      const count =
        await candidateGroup
          .count()
          .catch(() => 0);

      for (
        let index = 0;
        index < count;
        index += 1
      ) {
        const candidate =
          candidateGroup.nth(index);

        const isVisible =
          await candidate
            .isVisible({
              timeout: 1000,
            })
            .catch(() => false);

        if (!isVisible) {
          continue;
        }

        await candidate
          .scrollIntoViewIfNeeded()
          .catch(() => {});

        try {
          await candidate.click({
            timeout: 10000,
          });

          console.log(
            `[Olive] Clicked control: ${value}`
          );

          const response =
            await this.waitForResponseDelta(
              beforeLines,
              ''
            );

          return {
            clicked: true,
            targetText: value,
            surface:
              surface === this.page
                ? 'page'
                : 'frame',
            botResponse:
              response.botResponse,
            newBotMessages:
              response.newBotMessages,
            newBotMessageCount:
              response.newBotMessages.length,
            conversationState:
              detectConversationState(
                response.botResponse
              ),
          };
        } catch (_) {
          /*
           * Some Olive options are rendered as clickable parent
           * containers while the matching text is on a child node.
           */
          const parentClickable =
            candidate.locator(
              'xpath=ancestor-or-self::*[' +
              '@role="button" or ' +
              '@role="option" or ' +
              '@role="link" or ' +
              'self::button or self::a' +
              '][1]'
            );

          if (
            await parentClickable
              .isVisible({
                timeout: 500,
              })
              .catch(() => false)
          ) {
            await parentClickable.click({
              timeout: 10000,
            });

            console.log(
              `[Olive] Clicked parent control: ${value}`
            );

            const response =
              await this.waitForResponseDelta(
                beforeLines,
                ''
              );

            return {
              clicked: true,
              targetText: value,
              surface:
                surface === this.page
                  ? 'page'
                  : 'frame',
              botResponse:
                response.botResponse,
              newBotMessages:
                response.newBotMessages,
              newBotMessageCount:
                response.newBotMessages.length,
              conversationState:
                detectConversationState(
                  response.botResponse
                ),
            };
          }
        }
      }
    }

    throw new Error(
      `Visible Olive control was not found: ${value}`
    );
  }

  async readVisibleOrderControls() {
    const surface =
      this.lastSurface ||
      await this.findChatSurface({
        timeout: 1500,
      });

    if (!surface) {
      return [];
    }

    const orderPattern =
      /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b[\s\S]{0,80}\b\d{6,}\b/i;

    const groups = [
      surface.getByRole('button'),
      surface.getByRole('option'),
      surface.getByRole('link'),
      surface.locator(
        'button, [role="button"], [role="option"], a'
      ),
    ];

    const labels = [];
    const seen = new Set();

    for (const group of groups) {
      const count =
        Math.min(
          await group
            .count()
            .catch(() => 0),
          100
        );

      for (
        let index = 0;
        index < count;
        index += 1
      ) {
        const candidate =
          group.nth(index);

        const visible =
          await candidate
            .isVisible({
              timeout: 100,
            })
            .catch(() => false);

        if (!visible) {
          continue;
        }

        const label =
          String(
            await candidate
              .innerText()
              .catch(() => '') ||
            await candidate
              .getAttribute(
                'aria-label'
              )
              .catch(() => '') ||
            ''
          )
            .replace(/^text:\s*/i, '')
            .replace(/\s+/g, ' ')
            .trim();

        if (
          !label ||
          !orderPattern.test(label) ||
          seen.has(label)
        ) {
          continue;
        }

        seen.add(label);
        labels.push(label);
      }
    }

    return labels;
  }

  async waitForOrderControlDelta(
    beforeControls,
    timeoutMs
  ) {
    const before =
      new Set(
        (beforeControls || [])
          .map(value =>
            String(value || '')
              .replace(/\s+/g, ' ')
              .trim()
          )
          .filter(Boolean)
      );

    const deadline =
      Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const current =
        await this
          .readVisibleOrderControls()
          .catch(() => []);

      const added =
        current.filter(
          value =>
            !before.has(value)
        );

      if (added.length) {
        /*
         * Require a short quiet period so all order options can
         * finish rendering before returning.
         */
        await this.page.waitForTimeout(
          Number(
            process.env
              .OLIVE_ORDER_CONTROL_QUIET_MS ||
            1200
          )
        );

        const finalControls =
          await this
            .readVisibleOrderControls()
            .catch(() => added);

        const finalAdded =
          finalControls.filter(
            value =>
              !before.has(value)
          );

        return {
          botResponse:
            finalAdded.join('\n'),
          newBotMessages:
            finalAdded,
          detectedBy:
            'visible_order_controls',
        };
      }

      await this.page.waitForTimeout(300);
    }

    throw new Error(
      'Timed out waiting for visible Olive order controls.'
    );
  }

  async sendMessage(userMessage) {
    const surface =
      await this.findChatSurface({
        timeout: 2500,
      }) ||
      this.lastSurface ||
      await this.open();

    await this.waitUntilReady(surface);

    const input =
      await this.findInputInSurface(
        surface
      );

    if (!input) {
      throw new Error(
        'Olive input field is not visible.'
      );
    }

    /*
     * Baseline is captured only after the
     * greeting has completely stabilised.
     */
    const beforeLines =
      await this.readChatLines();

    const beforeOrderControls =
      await this
        .readVisibleOrderControls()
        .catch(() => []);

    await input.click({
      timeout: 10000,
    });

    await input
      .fill(userMessage)
      .catch(async () => {
        await input
          .press(
            process.platform === 'darwin'
              ? 'Meta+A'
              : 'Control+A'
          )
          .catch(() => {});

        await input.type(
          userMessage,
          {
            delay: 8,
          }
        );
      });

    const sendButton = surface
      .getByRole('button', {
        name: /^send$/i,
      })
      .last();

    if (await visible(sendButton, 1500)) {
      await sendButton.click();
    } else {
      await input.press('Enter');
    }

    const responseTimeoutMs =
      Number(
        process.env
          .OLIVE_RESPONSE_TIMEOUT_MS ||
        this.responseTimeout
      );

    const textDeltaPromise =
      this.waitForResponseDelta(
        beforeLines,
        userMessage
      );

    const orderControlPromise =
      this.waitForOrderControlDelta(
        beforeOrderControls,
        responseTimeoutMs
      );

    let result;

    try {
      result =
        await Promise.any([
          textDeltaPromise,
          orderControlPromise,
        ]);
    } catch (error) {
      throw new Error(
        `Timed out waiting for Olive response to: "${userMessage}"`
      );
    }

    let screenshotPath = null;

    const captureScreenshots =
      String(
        process.env
          .CAPTURE_OLIVE_SCREENSHOTS ||
        'true'
      ).toLowerCase() === 'true';

    if (captureScreenshots) {
      screenshotPath = await this
        .screenshot(
          `olive-turn-${Date.now()}`
        )
        .catch(() => null);
    }

    return {
      userMessage,
      botResponse:
        result.botResponse,

      newBotMessages:
        result.newBotMessages,

      newBotMessageCount:
        result.newBotMessages.length,

      conversationState:
        detectConversationState(
          result.botResponse
        ),

      screenshotPath,
    };
  }

  async waitForResponseDelta(
    beforeLines,
    userMessage
  ) {
    const beforeCounts = new Map();

    for (const line of beforeLines) {
      const key =
        String(line).toLowerCase();

      beforeCounts.set(
        key,
        (
          beforeCounts.get(key) || 0
        ) + 1
      );
    }

    const deadline =
      Date.now() +
      this.responseTimeout;

    console.log(
      `🔎 Chatbot response baseline: ${beforeLines.length} lines`
    );

    let best = [];
    let lastSignature = '';
    let stableSince = 0;
    let sawBusy = false;

    /*
     * Olive often emits one response as several delayed bubbles.
     * Do not return after only the first bubble becomes stable.
     * Require a continuous quiet window after the latest change.
     */
    const responseQuietWindowMs =
      Number(
        process.env
          .OLIVE_RESPONSE_QUIET_WINDOW_MS ||
        4000
      );

    while (Date.now() < deadline) {
      await this.page.waitForTimeout(450);

      const busy =
        await this.isOliveBusy();

      if (busy) {
        sawBusy = true;
      }

      const afterLines =
        await this.readChatLines();

      if (
        process.env.DEBUG_CHATBOT_CAPTURE === 'true'
      ) {
        console.log(
          `🔎 Chatbot capture: before=${beforeLines.length}, ` +
          `after=${afterLines.length}, busy=${busy}, ` +
          `quietForMs=${stableSince ? Date.now() - stableSince : 0}`
        );
      }

      const seen = new Map();
      const delta = [];

      for (const line of afterLines) {
        const key =
          String(line).toLowerCase();

        const occurrence =
          (
            seen.get(key) || 0
          ) + 1;

        seen.set(
          key,
          occurrence
        );

        if (
          occurrence <=
          (
            beforeCounts.get(key) || 0
          )
        ) {
          continue;
        }

        if (
          isNoiseLine(
            line,
            userMessage
          )
        ) {
          continue;
        }

        delta.push(line);
      }

      const cleaned = delta.filter(
        (line, index, values) =>
          values.indexOf(line) === index
      );

      if (
        cleaned.join('\n').length >
        best.join('\n').length
      ) {
        best = cleaned;
      }

      const signature =
        cleaned.join('\n');

      if (
        signature &&
        signature === lastSignature
      ) {
        if (!stableSince) {
          stableSince = Date.now();
        }
      } else {
        lastSignature = signature;

        stableSince = signature
          ? Date.now()
          : 0;
      }

      const quietForMs =
        stableSince
          ? Date.now() - stableSince
          : 0;

      const stable =
        Boolean(stableSince) &&
        quietForMs >=
          responseQuietWindowMs;

      /*
       * Prefer completion after Olive has visibly
       * finished typing. Some builds do not expose
       * typing state, so stable response text is
       * retained as a controlled fallback.
       */
      if (
        signature.length >= 12 &&
        stable &&
        !busy &&
        quietForMs >=
          responseQuietWindowMs
      ) {
        return {
          botResponse:
            signature.slice(
              -MAX_RESPONSE_CHARS
            ),

          newBotMessages:
            cleaned,
        };
      }
    }

    if (best.length) {
      const response =
        best.join('\n');

      return {
        botResponse:
          response.slice(
            -MAX_RESPONSE_CHARS
          ),

        newBotMessages:
          best,
      };
    }

    throw new Error(
      `Timed out waiting for Olive ` +
      `response to: "${userMessage}"`
    );
  }

  async readConversationText() {
    return (
      await this.readChatLines()
    ).join('\n');
  }

  async dumpVisibleControls(
    limit = 25
  ) {
    const surface =
      this.lastSurface ||
      this.page;

    return surface
      .locator(
        'button, a, [role="button"], ' +
        'input, textarea, ' +
        '[contenteditable="true"]'
      )
      .evaluateAll(
        (elements, max) => {
          const isVisible = element => {
            const style =
              window.getComputedStyle(
                element
              );

            const rect =
              element
                .getBoundingClientRect();

            return (
              style.visibility !==
                'hidden' &&
              style.display !== 'none' &&
              rect.width > 0 &&
              rect.height > 0
            );
          };

          return elements
            .filter(isVisible)
            .slice(0, max)
            .map(
              (element, index) => {
                const name = [
                  element.getAttribute(
                    'aria-label'
                  ),
                  element.getAttribute(
                    'title'
                  ),
                  element.getAttribute(
                    'placeholder'
                  ),
                  element.innerText,
                  element.value,
                ]
                  .filter(Boolean)
                  .join(' ')
                  .replace(/\s+/g, ' ')
                  .trim()
                  .slice(0, 120);

                return (
                  `${index + 1}. ` +
                  `<${element.tagName
                    .toLowerCase()}> ` +
                  `${name || '(no visible name)'}`
                );
              }
            )
            .join('\n');
        },
        limit
      )
      .catch(
        error =>
          `Could not dump controls: ` +
          `${error.message}`
      );
  }

  async ensureAuthenticated({ targetUrl, required = true } = {}) {
    if (!targetUrl) throw new Error('ensureAuthenticated requires targetUrl.');

    const storagePath = process.env.PLAYWRIGHT_STORAGE_STATE || path.resolve(
      process.cwd(),
      'artifacts',
      '.auth',
      `woolworths-${String(process.env.TARGET_ENV || 'uat').toLowerCase()}.json`
    );
    const deterministicLoginEnabled = String(
      process.env.GENERATED_SPEC_DETERMINISTIC_AUTH ??
      process.env.MCP_DETERMINISTIC_AUTH ??
      'true'
    ).toLowerCase() !== 'false';

    if (deterministicLoginEnabled) {
      await performDeterministicWebLogin(this.page, targetUrl);
      fs.mkdirSync(path.dirname(storagePath), { recursive: true });
      await this.page.context().storageState({ path: storagePath });
      return { authenticated: true, mode: 'deterministic-login', storageStatePath: storagePath };
    }

    if (!fs.existsSync(storagePath)) {
      if (required) throw new Error(`Authenticated storage state is missing: ${storagePath}`);
      await this.goto(targetUrl);
      return { authenticated: false, mode: 'anonymous', storageStatePath: null };
    }

    const state = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
    if (Array.isArray(state.cookies) && state.cookies.length) await this.page.context().addCookies(state.cookies);
    await this.goto(targetUrl);
    for (const origin of state.origins || []) {
      if (!origin?.origin || !Array.isArray(origin.localStorage)) continue;
      if (!this.page.url().startsWith(origin.origin)) await this.page.goto(origin.origin, { waitUntil: 'domcontentloaded' });
      await this.page.evaluate(items => { for (const item of items) localStorage.setItem(item.name, item.value); }, origin.localStorage);
    }
    await this.goto(targetUrl);
    if (/\/u\/login|\/authorize|auth0/i.test(this.page.url())) {
      throw new Error(`Authenticated storage state is expired: ${storagePath}`);
    }
    return { authenticated: true, mode: 'storage-state', storageStatePath: storagePath };
  }

  async runGeneratedJourney({ scenario, maxTurns = 25, options = {}, onStep } = {}) {
    const { runGeneratedJourney } = require('./generative/semanticJourney');
    return runGeneratedJourney({
      scenario, maxTurns, options, onStep,
      adapter: {
        captureState: async () => ({
          chat: await this.captureStructuredState(),
          page: { surfaceReady: true, busy: false, messages: [], controls: [], inputs: [], text: [], url: this.page.url(), title: await this.page.title().catch(() => '') },
        }),
        executeAction: action => this.executeStructuredAction(action),
      },
    });
  }

  async runSemanticJourney({ scenario, maxTurns = 25, options = {}, onTurn } = {}) {
    const { runSemanticJourney } = require('./generative/semanticJourney');
    await this.open();
    return runSemanticJourney({
      scenario,
      maxTurns,
      options,
      onTurn,
      adapter: {
        captureState: async () => ({
          chat: await this.captureStructuredState(),
          page: {
            surfaceReady: true,
            busy: false,
            messages: [],
            controls: [],
            inputs: [],
            text: [],
            url: this.page.url(),
            title: await this.page.title().catch(() => ''),
          },
        }),
        executeAction: action => this.executeStructuredAction(action),
      },
    });
  }

  async screenshot(name) {
    const safeName =
      String(name)
        .replace(
          /[^a-z0-9-_]/gi,
          '_'
        )
        .toLowerCase();

    const directory =
      process.env.QA_SCREENSHOTS_DIR
        ? path.resolve(
            process.env
              .QA_SCREENSHOTS_DIR
          )
        : path.resolve(
            process.cwd(),
            'reports',
            'screenshots'
          );

    fs.mkdirSync(
      directory,
      {
        recursive: true,
      }
    );

    const filePath =
      path.join(
        directory,
        `${safeName}.png`
      );

    await this.page.screenshot({
      path: filePath,
      fullPage: false,
    });

    return filePath;
  }
}

module.exports = {
  OliveWebBot,
  normaliseLines,
  detectConversationState,
};
