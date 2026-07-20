'use strict';

const { judgeChatbotResponse } = require('../llmJudge');
const { runSemanticJourney } = require('../generative/semanticJourney');
const { withSelfHealing } = require('../healing/selfHealing');

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

class OliveMobileBot {
  constructor(browser, options = {}) {
    this.browser = browser;
    this.options = options;
    this.runtimeTargets = new Map();
    this.inputSelectors = options.inputSelectors || [
      '~Ask anything', '~Message',
      'android=new UiSelector().className("android.widget.EditText")',
      '-ios class chain:**/XCUIElementTypeTextView',
      '-ios class chain:**/XCUIElementTypeTextField',
    ];
    this.sendSelectors = options.sendSelectors || [
      '~Send',
      'android=new UiSelector().descriptionContains("Send")',
      '-ios predicate string:name CONTAINS[c] "send"',
    ];
  }

  async firstDisplayed(selectors) {
    for (const selector of selectors) {
      const element = await this.browser.$(selector).catch(() => null);
      if (element && await element.isDisplayed().catch(() => false)) return element;
    }
    return null;
  }

  async open() {
    const triggerPattern = this.options.triggerPattern || process.env.MOBILE_CHAT_TRIGGER_PATTERN || 'chat|help|message|support|assistant';
    const triggers = this.options.triggerSelectors || [
      `android=new UiSelector().textMatches("(?i).*(${triggerPattern}).*")`,
      `-ios predicate string:name MATCHES[c] ".*(${triggerPattern}).*"`,
    ];
    return withSelfHealing({
      operation: async () => {
        const input = await this.firstDisplayed(this.inputSelectors);
        if (input) return input;
        throw new Error('Chat input is not visible.');
      },
      fallbacks: [{
        name: 'tap-runtime-chat-trigger',
        fn: async () => {
          const trigger = await this.firstDisplayed(triggers);
          if (!trigger) throw new Error('No configurable chat trigger found.');
          await trigger.click();
          await this.browser.pause(Number(process.env.MOBILE_CHAT_OPEN_WAIT_MS || 1500));
          const input = await this.firstDisplayed(this.inputSelectors);
          if (!input) throw new Error('Chat surface did not expose an input after opening.');
          return input;
        },
      }],
    });
  }

  async captureStructuredState() {
    const context = String(await this.browser.getContext().catch(() => 'NATIVE_APP'));
    const selector = context.includes('WEBVIEW')
      ? 'button, a, input, textarea, [role="button"], [contenteditable="true"], [aria-label]'
      : '//*[@text != "" or @label != "" or @content-desc != "" or self::android.widget.EditText or self::XCUIElementTypeTextField or self::XCUIElementTypeTextView]';
    const elements = await this.browser.$$(selector).catch(() => []);
    this.runtimeTargets.clear();
    const messages = [];
    const controls = [];
    const inputs = [];
    const seen = new Set();

    for (const element of elements.slice(-160)) {
      if (!(await element.isDisplayed().catch(() => false))) continue;
      const [tag, valueText, label, description, enabled] = await Promise.all([
        element.getTagName().catch(() => ''),
        element.getText().catch(() => ''),
        element.getAttribute('label').catch(() => ''),
        element.getAttribute('content-desc').catch(() => ''),
        element.isEnabled().catch(() => true),
      ]);
      const display = clean(valueText || label || description);
      const key = `${tag}|${display}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const inputLike = /EditText|TextField|TextView|input|textarea/i.test(tag);
      if (inputLike) {
        const id = `input_${inputs.length + 1}`;
        inputs.push({ id, type: 'text', placeholder: display, enabled: enabled !== false });
        this.runtimeTargets.set(id, element);
      } else if (display) {
        const id = `control_${controls.length + 1}`;
        controls.push({ id, type: clean(tag) || 'control', label: display, enabled: enabled !== false });
        this.runtimeTargets.set(id, element);
        messages.push({ id: `message_${messages.length + 1}`, text: display });
      }
    }

    const screen = `${await this.browser.getCurrentPackage().catch(() => '')}/${await this.browser.getCurrentActivity().catch(() => '')}`;
    return {
      surfaceReady: inputs.length > 0 || controls.length > 0,
      busy: messages.some(item => /loading|please wait|typing|connecting/i.test(item.text)),
      messages: messages.slice(-40),
      controls,
      inputs,
      text: messages.map(item => item.text).slice(-120),
      url: screen,
      title: context,
      capturedAt: new Date().toISOString(),
    };
  }

  async executeStructuredAction(action = {}) {
    const kind = String(action.action || '').toUpperCase();
    if (kind === 'WAIT') {
      await this.browser.pause(Math.max(250, Number(action.waitMs || 1000)));
      return { executed: true, action: kind };
    }
    const targetId = String(action.targetId || '');
    const value = String(action.value || '');
    let target = this.runtimeTargets.get(targetId);
    if (!target && (kind === 'TYPE' || kind === 'SEND_MESSAGE')) {
      target = [...this.runtimeTargets.values()].find(item => item && typeof item.setValue === 'function') || null;
    }
    if (!target) throw new Error(`Runtime target not found: ${targetId || '<none>'}`);
    if (kind === 'CLICK') await target.click();
    else if (kind === 'TYPE') {
      if (!value.trim()) throw new Error('TYPE requires a non-empty value.');
      await target.click();
      await target.setValue(value);
    }
    else if (kind === 'SEND_MESSAGE') {
      if (!value.trim()) throw new Error('SEND_MESSAGE requires a non-empty value.');
      await target.click();
      await target.setValue(value);
      const send = await this.firstDisplayed(this.sendSelectors);
      const sendReady = send && await send.isEnabled().catch(() => true);
      if (sendReady) await send.click(); else await this.browser.keys('Enter');
    } else throw new Error(`Unsupported mobile action: ${kind}`);
    return { executed: true, action: kind, targetId: action.targetId };
  }

  async ensureAuthenticated({ required = String(process.env.MOBILE_AUTH_REQUIRED || 'false').toLowerCase() === 'true' } = {}) {
    if (!required) return { authenticated: true, assumedFromSession: true };
    const authenticatedSelector = process.env.MOBILE_AUTHENTICATED_SELECTOR;
    if (authenticatedSelector) {
      const element = await this.browser.$(authenticatedSelector).catch(() => null);
      if (element && await element.isDisplayed().catch(() => false)) return { authenticated: true };
    }
    const usernameSelector = process.env.MOBILE_LOGIN_USERNAME_SELECTOR;
    const passwordSelector = process.env.MOBILE_LOGIN_PASSWORD_SELECTOR;
    const submitSelector = process.env.MOBILE_LOGIN_SUBMIT_SELECTOR;
    const username = process.env.TEST_LOGIN_EMAIL;
    const password = process.env.TEST_LOGIN_PASSWORD;
    if (!usernameSelector || !passwordSelector || !submitSelector || !username || !password) {
      throw new Error('Mobile deterministic authentication is required but selector/credential configuration is incomplete.');
    }
    const user = await this.browser.$(usernameSelector);
    const pass = await this.browser.$(passwordSelector);
    const submit = await this.browser.$(submitSelector);
    await user.setValue(username);
    await pass.setValue(password);
    await submit.click();
    if (authenticatedSelector) await this.browser.$(authenticatedSelector).waitForDisplayed({ timeout: Number(process.env.MOBILE_LOGIN_TIMEOUT_MS || 60000) });
    return { authenticated: true };
  }

  async runGeneratedJourney({ scenario, maxTurns = 25, options = {}, onStep } = {}) {
    const { runGeneratedJourney } = require('../generative/semanticJourney');
    await this.open();
    return runGeneratedJourney({
      scenario, maxTurns, options, onStep,
      adapter: {
        captureState: async () => ({ chat: await this.captureStructuredState(), page: { surfaceReady: true, messages: [], controls: [], inputs: [], text: [] } }),
        executeAction: action => this.executeStructuredAction(action),
      },
    });
  }

  async runSemanticJourney({ scenario, maxTurns = 25, options = {}, onTurn } = {}) {
    await this.open();
    return runSemanticJourney({
      scenario,
      maxTurns,
      options,
      onTurn,
      adapter: {
        captureState: async () => ({
          chat: await this.captureStructuredState(),
          page: { surfaceReady: true, messages: [], controls: [], inputs: [], text: [] },
        }),
        executeAction: action => this.executeStructuredAction(action),
      },
    });
  }

  async readConversation() {
    return this.browser.getPageSource();
  }

  async sendMessage(message) {
    const before = await this.readConversation();
    const opened = await this.open();
    const input = opened.value || opened;
    await input.click();
    await input.setValue(message);
    const send = await this.firstDisplayed(this.sendSelectors);
    if (send) await send.click(); else await this.browser.keys('Enter');
    await this.browser.waitUntil(async () => (await this.readConversation()) !== before, {
      timeout: Number(process.env.OLIVE_RESPONSE_TIMEOUT_MS || 45000),
      timeoutMsg: 'Chat response did not change the mobile page source.',
    });
    const after = await this.readConversation();
    return { userMessage: message, botResponse: after.slice(-8000), fullConversation: after };
  }

  async sendAndJudge(turn) {
    const response = await this.sendMessage(turn.userMessage);
    const judgement = await judgeChatbotResponse({ ...turn, botResponse: response.botResponse });
    return { ...response, judgement };
  }
}

module.exports = { OliveMobileBot };
