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

function detectConversationState(text) {
  const value = String(text || '').toLowerCase();

  if (
    /log\s*in|sign\s*in|your account|authenticate/.test(value)
  ) {
    return 'AUTHENTICATION_REQUIRED';
  }

  if (
    /select.*order|choose.*order|which order|recent order/.test(value)
  ) {
    return 'ORDER_SELECTION';
  }

  if (
    /select.*item|choose.*item|which item/.test(value)
  ) {
    return 'ITEM_SELECTION';
  }

  if (
    /refund|money back|processing time|business days/.test(value)
  ) {
    return 'REFUND_INFORMATION';
  }

  if (
    /team member|customer service|agent|specialist|support team/.test(value)
  ) {
    return 'HUMAN_ESCALATION';
  }

  if (
    /sorry|understand|missing.*item|help.*sort/.test(value)
  ) {
    return 'ACKNOWLEDGED';
  }

  if (
    /didn't quite catch|did not quite catch|rephras/.test(value)
  ) {
    return 'FALLBACK';
  }

  return 'UNKNOWN';
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
      return existing;
    }

    await this.dismissOverlays();

    const deadline = Date.now() + OPEN_TIMEOUT;

    let attempt = 0;
    let lastControls = '';

    while (Date.now() < deadline) {
      attempt += 1;

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

    const candidates = [
      () =>
        this.page
          .getByRole('button', {
            name: patterns,
          })
          .first(),

      () =>
        this.page
          .getByRole('link', {
            name: patterns,
          })
          .first(),

      () =>
        this.page
          .locator(
            'button, a, [role="button"]'
          )
          .filter({
            hasText: patterns,
          })
          .first(),

      () =>
        this.page
          .locator([
            'button[aria-label*="chat" i]',
            'button[aria-label*="olive" i]',
            'button[title*="chat" i]',
            'button[title*="olive" i]',
            '[role="button"][aria-label*="chat" i]',
            '[role="button"][aria-label*="olive" i]',
            '[data-testid*="chat" i]',
            '[data-testid*="olive" i]',
            '[id*="chat" i]',
            '[id*="olive" i]',
          ].join(','))
          .first(),
    ];

    for (const makeLocator of candidates) {
      const locator = makeLocator();

      if (!(await visible(locator, 800))) {
        continue;
      }

      await locator
        .scrollIntoViewIfNeeded()
        .catch(() => {});

      await locator
        .click({
          timeout: 7000,
        })
        .catch(async () => {
          await locator
            .click({
              timeout: 7000,
              force: true,
            })
            .catch(() => {});
        });

      await this.page.waitForTimeout(1200);

      const surface =
        await this.findChatSurface({
          timeout: Number(
            process.env.OLIVE_SURFACE_TIMEOUT_MS ||
            6000
          ),
        });

      if (surface) {
        await this.waitUntilReady(surface);
        return surface;
      }
    }

    void label;
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
         * Small final delay prevents a message from
         * being sent in the same animation frame as
         * the final greeting bubble.
         */
        await this.page.waitForTimeout(500);

        this.initialChatReady = true;
        this.initialGreetingLines =
          await this.readChatLines();

        console.log(
          '✅ Olive greeting completed and chat is ready.'
        );

        return {
          ready: true,
          greetingLines:
            this.initialGreetingLines,
        };
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

    const result =
      await this.waitForResponseDelta(
        beforeLines,
        userMessage
      );

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
          `after=${afterLines.length}, busy=${busy}`
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

      const stable =
        Boolean(stableSince) &&
        Date.now() - stableSince >=
          RESPONSE_STABLE_MS;

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
        (
          sawBusy ||
          Date.now() - stableSince >=
            RESPONSE_STABLE_MS
        )
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
