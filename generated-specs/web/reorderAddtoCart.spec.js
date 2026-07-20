const { test, expect } = require('@playwright/test');
const { loadProjectEnv, readEnv } = require('../../src/env');
const { OliveWebBot } = require('../../src/oliveWebBot');

loadProjectEnv('.env.web', '.env.llm', '.env.browserstack');

test.setTimeout(8 * 60 * 1000); // 8 minutes for generative flow

test('Olive Reorder, Cart Verification and Recovery Handover @web @loggedin @reorder @cart-verification @recovery @agent-handover @regression @generative', async ({ page }, testInfo) => {
  const targetPath = '/';
  const baseUrl = readEnv('WEB_BASE_URL', readEnv('BASE_URL'));
  const targetUrl = `${baseUrl}${targetPath}`;

  const semanticContract = {
    businessObjective: "Reorder items from the first eligible recent order, verify that the items were actually added to the shopping cart, and use Olive's recovery path when the cart was not updated. Pass when either the cart is verified successfully or Olive proceeds to human-agent connection after the recovery option is selected.",
    milestones: [
      {
        type: 'REQUIRED_CUSTOMER_MESSAGE',
        value: 'Reorder',
        description: 'Initiate the reorder process with Olive.'
      },
      {
        type: 'SEMANTIC_CONTROL',
        description: 'first eligible recent order',
        controlType: 'button',
        // The bot will select the first control semantically matching "first eligible recent order".
      },
      {
        type: 'SEMANTIC_CONTROL',
        description: 'Add to cart',
        controlType: 'button',
        // The bot will select the control semantically matching "Add to cart".
      },
      {
        type: 'SEMANTIC_VALIDATION',
        description: 'cart contains reordered items',
        success: true,
        // This milestone represents the successful path where reordered items are found in the cart.
        // If this validation fails, the bot will automatically look for recovery options.
      },
      {
        type: 'SEMANTIC_CONTROL',
        description: 'It didn\'t work',
        controlType: 'button',
        recovery: true,
        // This milestone is attempted only if the previous SEMANTIC_VALIDATION fails.
        // The bot will select the control semantically matching "It didn't work".
      },
      {
        type: 'SEMANTIC_VALIDATION',
        description: 'Olive enters human-agent handover flow',
        success: true,
        // This milestone represents the successful recovery path where Olive offers or enters agent handover.
      }
    ],
    successConditions: [
      "reordered items are visibly present in the cart.",
      "cart verification fails, 'It didn't work' is selected, and Olive enters a genuine agent-handover/queue/connecting state."
    ],
    failureConditions: [
      "Deterministic login fails or the authenticated session is lost.",
      "Olive cannot be opened or the conversation cannot continue.",
      "No eligible recent order is available.",
      "Add to cart cannot be reached or clicked.",
      "Cart verification is inconclusive after reasonable retries and no recovery control is available.",
      "The recovery control is selected but Olive neither resolves the issue nor offers/enters human-agent support.",
      "The conversation loops without progress or reaches the maximum turn limit.",
      "Sensitive customer data is exposed."
    ],
    maxTurns: 20,
    minMeaningfulResponses: 4
  };

  const bot = new OliveWebBot(page);

  // 1. Open the configured environment and confirm deterministic login is active.
  await bot.ensureAuthenticated({ targetUrl, required: true });

  // 2. Open Olive and start a clean conversation.
  await bot.open();

  // Execute the generative journey based on the semantic contract
  await bot.runGeneratedJourney({ scenario: semanticContract, maxTurns: semanticContract.maxTurns, testInfo });
});
