const { test, expect } = require('@playwright/test');
const { loadProjectEnv, readEnv } = require('../../src/env');
const { VisualValidator } = require('../../src/visualValidator');
const { auditLinksAndButtons } = require('../../src/linkButtonAuditor');
const { runAdvancedHelpCenterExploration } = require('../../src/helpCenterAdvancedExplorer');
const path = require('path');
const fs = require('fs');

loadProjectEnv('.env.web', '.env.llm', '.env.browserstack');
const targetEnv = readEnv('TARGET_ENV', 'UAT').toUpperCase();
const baseUrl = targetEnv === 'PROD'
  ? readEnv('URL_PROD', 'https://www.woolworths.com.au')
  : readEnv('URL_UAT', 'https://uatsite.woolworths.com.au');
const helpUrl = readEnv('HELP_CENTER_WEB_URL', `${baseUrl.replace(/\/$/, '')}/shop/help`);

test.describe('Web Help Centre FAQ Page Audit @web @faq @helpcenter @visual @linkcheck @exploratory @regression', () => {
  test('Check Woolworths Help Centre FAQ page @web @faq @helpcenter @visual @linkcheck @exploratory @regression', async ({ page }, testInfo) => {
    test.setTimeout(Number(readEnv('HELP_CENTER_SPEC_TIMEOUT_MS', '900000')));

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(helpUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.getByRole('heading', { name: /how can we help/i }).waitFor({ timeout: 30000 });
    await page.waitForTimeout(2000);

    const visualValidator = new VisualValidator(page, { targetEnv });
    const visualResult = await visualValidator.captureAndCompare('web_help_centre_faq_landing', {
      fullPage: true,
      updateBaseline: process.env.UPDATE_VISUAL_BASELINE === 'true',
    });

    await testInfo.attach('visual_baseline', { path: visualResult.baselinePath, contentType: 'image/png' });
    await testInfo.attach('visual_actual', { path: visualResult.actualPath, contentType: 'image/png' });
    if (visualResult.hasDifference) {
      await testInfo.attach('visual_diff', { path: visualResult.diffPath, contentType: 'image/png' });
      await testInfo.attach('visual_overlay', { path: visualResult.overlayPath, contentType: 'image/png' });
    }

    expect.soft(
      visualResult.passed,
      `Visual comparison failed: ${visualResult.reason}`
    ).toBe(true);

    if (process.env.UPDATE_VISUAL_BASELINE === 'true' && process.env.RUN_FULL_FLOW_ON_BASELINE !== 'true') {
      return;
    }

    const reportsDir = path.join(process.cwd(), 'reports');
    const auditDir = path.join(reportsDir, 'audits');
    const screenshotsDir = path.join(reportsDir, 'screenshots');

    if (!fs.existsSync(auditDir)) {
      fs.mkdirSync(auditDir, { recursive: true });
    }
    if (!fs.existsSync(screenshotsDir)) {
      fs.mkdirSync(screenshotsDir, { recursive: true });
    }

    const linkAudit = await auditLinksAndButtons(page, { maxLinksToCheck: 40 });
    const linkAuditFilePath = path.join(auditDir, 'web_help_centre_faq_link_audit.json');
    fs.writeFileSync(linkAuditFilePath, JSON.stringify(linkAudit, null, 2));
    await testInfo.attach('web_help_centre_faq_link_audit', { path: linkAuditFilePath, contentType: 'application/json' });

    expect.soft(linkAudit.summary.passed, `Link audit failed. Errors: ${JSON.stringify(linkAudit.errors)}, Warnings: ${JSON.stringify(linkAudit.warnings)}`).toBe(true);

    const exploration = await runAdvancedHelpCenterExploration(page, {
      startUrl: helpUrl,
      screenshotsDir,
      auditDir,
      readEnv,
      name: 'web_help_centre_faq_exploration',
      genFaqQuestions: [
        'How do I track my order?',
        'How do I get a refund?',
        'Missing item from my delivery',
        'Can I change my delivery time?',
      ],
      suggestionChips: [
        'What do I do if I have an item missing from my order?',
        'What happens if I receive a wrong item?',
        'Can I change my Pick up or Delivery time?',
        'How do I get a refund?',
        'How do I track my order?',
        'How do I change my order?',
      ],
      suggestionChipsToClick: 6,
      browseTopics: [
        'Manage your order',
        'Delivery, pick up & stores',
        'Returns, refunds & missing items',
        'Feedback',
        'Everyday Rewards & offers',
      ],
      browseTopicsToOpen: 5,
      articlesToOpenPerTopic: 3,
      negativeFeedbackText: 'DSS qa',
      formSubmissionText: 'DSS qa',
      submitFormInUAT: targetEnv === 'UAT',
      responseWaitMs: 7000,
    });

    const explorationFilePath = path.join(auditDir, 'web_help_centre_faq_exploration.json');
    fs.writeFileSync(explorationFilePath, JSON.stringify(exploration, null, 2));
    await testInfo.attach('web_help_centre_faq_exploration_report', { path: explorationFilePath, contentType: 'application/json' });

    for (const screenshotPath of exploration.screenshots || []) {
      if (fs.existsSync(screenshotPath)) {
        await testInfo.attach(path.basename(screenshotPath), { path: screenshotPath, contentType: 'image/png' });
      }
    }

    expect(exploration.summary.genFaqQuestionsAsked).toBeGreaterThan(0);
    expect(exploration.summary.suggestionChipsClicked).toBeGreaterThan(0);
    expect(exploration.summary.browseTopicsOpened).toBeGreaterThan(0);
    expect(exploration.summary.articlesOpened).toBeGreaterThan(0);
  });
});
