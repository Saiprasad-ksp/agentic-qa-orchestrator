'use strict';

const { judgeChatbotResponse } = require('../llmJudge');
const { withSelfHealing } = require('../healing/selfHealing');

class OliveMobileBot {
  constructor(browser, options = {}) {
    this.browser = browser;
    this.options = options;
    this.inputSelectors = options.inputSelectors || [
      '~Ask anything', '~Message', 'android=new UiSelector().className("android.widget.EditText")', '-ios class chain:**/XCUIElementTypeTextView', '-ios class chain:**/XCUIElementTypeTextField'
    ];
    this.sendSelectors = options.sendSelectors || ['~Send', 'android=new UiSelector().descriptionContains("Send")', '-ios predicate string:name CONTAINS[c] "send"'];
  }

  async firstDisplayed(selectors) {
    for (const selector of selectors) {
      const element = await this.browser.$(selector);
      if (await element.isDisplayed().catch(() => false)) return element;
    }
    return null;
  }

  async open() {
    const triggers = this.options.triggerSelectors || ['~Chat with Olive', '~Chat now', '~Ask Olive', 'android=new UiSelector().textMatches("(?i).*(chat|olive|help).*")'];
    return withSelfHealing({
      operation: async () => {
        const input = await this.firstDisplayed(this.inputSelectors);
        if (input) return input;
        throw new Error('Olive input is not visible.');
      },
      fallbacks: [{ name: 'tap-chat-trigger', fn: async () => {
        const trigger = await this.firstDisplayed(triggers);
        if (!trigger) throw new Error('No Olive trigger found.');
        await trigger.click();
        await this.browser.pause(1500);
        const input = await this.firstDisplayed(this.inputSelectors);
        if (!input) throw new Error('Olive did not open after trigger click.');
        return input;
      }}],
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
    await this.browser.waitUntil(async () => (await this.readConversation()) !== before, { timeout: Number(process.env.OLIVE_RESPONSE_TIMEOUT_MS || 45000), timeoutMsg: 'Olive response did not change the mobile page source.' });
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
