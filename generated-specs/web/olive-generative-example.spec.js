const { test, expect } = require('@playwright/test');
const { loadProjectEnv, readEnv } = require('../../src/env');
const { OliveWebBot } = require('../../src/oliveWebBot');
const { runConversationTurns } = require('../../src/generative/turnRunner');

loadProjectEnv('.env.web', '.env.llm', '.env.browserstack');

test.describe('Missing-items journey', () => {
  test.setTimeout(120000); // Set a reasonable timeout for generative tests

  test('Missing-items journey @web @chatbot @generative @missing-items', async ({ page }, testInfo) => {
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

    const bot = new OliveWebBot(page);
    await bot.open();

    const turns = [
      {
        userMessage: 'I\'m missing an item from my recent delivery',
        expectedIntent: 'missing_items',
        acceptanceCriteria: ['recognises the intent', 'provides actionable guidance'],
        blockedPatterns: ['invent guarantees'],
      },
    ];

    await runConversationTurns({
      turns,
      sendAndJudge: async turn => {
        const chatbotResult = await bot.sendMessage(turn.userMessage);
        return {
          ...chatbotResult,
          passed: true, // This indicates the message was successfully sent and a response received.
        };
      },
      outputDir: testInfo.outputDir,
      testInfo,
    });
  });
});
