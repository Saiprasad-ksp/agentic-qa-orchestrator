const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeName(value) {
  return String(value || `step-${Date.now()}`)
    .replace(/\.png$/i, '')
    .replace(/[^a-z0-9-_]/gi, '_')
    .replace(/_+/g, '_')
    .toLowerCase()
    .slice(0, 120);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function visible(locator, timeout = 1500) {
  return locator.isVisible({ timeout }).catch(() => false);
}

class HelpCenterAdvancedExplorer {
  constructor(page, options = {}) {
    this.page = page;
    this.options = options;
    this.readEnv = options.readEnv || ((key, fallback) => process.env[key] || fallback);
    this.startUrl = options.startUrl || page.url();

    this.screenshotsDir = options.screenshotsDir || path.resolve(process.cwd(), 'reports', 'screenshots');
    this.auditDir = options.auditDir || path.resolve(process.cwd(), 'reports', 'audits');

    ensureDir(this.screenshotsDir);
    ensureDir(this.auditDir);

    this.result = {
      startedAt: new Date().toISOString(),
      url: this.startUrl,
      screenshots: [],
      steps: [],
      warnings: [],
      errors: [],
      summary: {
        genFaqQuestionsAsked: 0,
        suggestionChipsClicked: 0,
        sourceLinksOpened: 0,
        browseTopicsOpened: 0,
        articlesOpened: 0,
        positiveRatings: 0,
        negativeRatings: 0,
        feedbackSubmitted: false,
        oliveLaunched: false,
        appLandingOpened: false,
        screenshots: 0,
        passed: false,
      },
    };
  }

  async wait(ms = 1500) {
    await this.page.waitForTimeout(ms);

    // Avoid waiting for networkidle after every click.
    // Retail pages often keep analytics/chat/network calls open.
    await this.page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
  }

  recordStep(name, status, extra = {}) {
    this.result.steps.push({
      name,
      status,
      url: this.page.url(),
      timestamp: new Date().toISOString(),
      ...extra,
    });
  }

  warn(message, extra = {}) {
    this.result.warnings.push({ message, ...extra, url: this.page.url() });
  }

  error(message, extra = {}) {
    this.result.errors.push({ message, ...extra, url: this.page.url() });
  }

  async screenshot(label) {
    const filePath = path.join(this.screenshotsDir, `${safeName(label)}.png`);

    await this.page.screenshot({ path: filePath, fullPage: true }).catch(async () => {
      await this.page.screenshot({ path: filePath }).catch(() => {});
    });

    this.result.screenshots.push(filePath);
    this.result.summary.screenshots = this.result.screenshots.length;
    return filePath;
  }

  async goHome() {
    await this.page.goto(this.startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await this.wait(2500);
  }

  async goBackToHelpCenter() {
    const breadcrumb = this.page
      .locator('nav[aria-label*="breadcrumb" i] a, [aria-label*="breadcrumb" i] a, a')
      .filter({ hasText: /help|help centre|help center/i })
      .first();

    if (await visible(breadcrumb, 1200)) {
      await breadcrumb.click({ timeout: 8000 }).catch(() => {});
      await this.wait(2000);
      return;
    }

    await this.goHome();
  }

  async clickFirst(candidates, stepName, options = {}) {
    for (const candidate of candidates) {
      const locator = typeof candidate === 'function' ? candidate() : candidate;

      if (!(await visible(locator, options.timeout || 1500))) continue;

      await locator.scrollIntoViewIfNeeded().catch(() => {});
      await this.page.waitForTimeout(300);

      await locator.click({ timeout: 10000 }).catch(async () => {
        await locator.click({ timeout: 10000, force: true });
      });

      await this.wait(options.waitAfter || 1800);
      this.recordStep(stepName, 'SUCCESS');
      return true;
    }

    this.warn(`Could not find element for: ${stepName}`);
    return false;
  }

  async getSuggestionChipTexts() {
    if (Array.isArray(this.options.suggestionChips) && this.options.suggestionChips.length > 0) {
      return this.options.suggestionChips;
    }

    await this.goHome();

    const chipTexts = await this.page
      .getByRole('group', { name: /try asking/i })
      .getByRole('button')
      .evaluateAll(buttons =>
        buttons
          .map(button => button.innerText || button.textContent || '')
          .map(text => text.replace(/^Ask:\s*/i, '').replace(/\s+/g, ' ').trim())
          .filter(Boolean),
      )
      .catch(() => []);

    return chipTexts;
  }

  async getBrowseTopicTexts() {
    if (Array.isArray(this.options.browseTopics) && this.options.browseTopics.length > 0) {
      return this.options.browseTopics;
    }

    await this.goHome();

    const topicTexts = await this.page
      .locator('main a[href*="/shop/help/"]')
      .evaluateAll(links =>
        links
          .map(link => {
            const heading = link.querySelector('h2,h3,h4');
            const text = heading?.innerText || link.innerText || link.textContent || '';
            return text.replace(/\s+/g, ' ').trim();
          })
          .filter(Boolean)
          .filter(text => !/help centre|help center|accessibility/i.test(text)),
      )
      .catch(() => []);

    return [...new Set(topicTexts)];
  }

  getGenFaqQuestions() {
    if (Array.isArray(this.options.genFaqQuestions) && this.options.genFaqQuestions.length > 0) {
      return this.options.genFaqQuestions;
    }

    return [
      'How do I track my order?',
      'How do I get a refund?',
      'Missing item from my delivery',
    ];
  }

  async askGenFaqQuestions() {
    const questions = this.getGenFaqQuestions();

    for (const [index, question] of questions.entries()) {
      await this.goHome();

      const input = this.page.getByRole('textbox', { name: /ask anything/i }).first();

      if (!(await visible(input, 5000))) {
        this.warn('Gen FAQ Ask Anything input not found.');
        await this.screenshot(`gen_faq_input_not_found_${index + 1}`);
        continue;
      }

      await input.click();
      await input.fill(question);

      const send = this.page.getByRole('button', { name: /^send$/i }).first();

      if (await visible(send, 1500)) {
        await send.click({ timeout: 10000 });
      } else {
        await input.press('Enter').catch(() => {});
      }

      await this.wait(Number(this.options.responseWaitMs || 7000));

      this.result.summary.genFaqQuestionsAsked += 1;
      this.recordStep(`Ask Gen FAQ question ${index + 1}`, 'SUCCESS', { question });
      await this.screenshot(`gen_faq_question_${index + 1}_${safeName(question)}`);

      await this.openCorrectSourceDropdownAndArticle(`gen_faq_question_${index + 1}`, 'positive');
    }
  }

  async clickSuggestionChips() {
    const chipTexts = await this.getSuggestionChipTexts();
    const maxChips = Number(this.options.suggestionChipsToClick || chipTexts.length);

    if (chipTexts.length === 0) {
      this.warn('No suggestion chip texts found.');
      await this.screenshot('suggestion_chips_not_found');
      return;
    }

    for (const [index, chipText] of chipTexts.slice(0, maxChips).entries()) {
      await this.goHome();

      const chip = this.page
        .getByRole('group', { name: /try asking/i })
        .getByRole('button', { name: new RegExp(escapeRegExp(chipText), 'i') })
        .first();

      const fallbackChip = this.page
        .locator('main button')
        .filter({ hasText: new RegExp(escapeRegExp(chipText), 'i') })
        .first();

      const target = (await visible(chip, 1500)) ? chip : fallbackChip;

      if (!(await visible(target, 3000))) {
        this.warn(`Suggestion chip not found: ${chipText}`);
        await this.screenshot(`suggestion_chip_not_found_${index + 1}`);
        continue;
      }

      await target.scrollIntoViewIfNeeded().catch(() => {});
      await target.click({ timeout: 10000 });
      await this.wait(Number(this.options.responseWaitMs || 7000));

      this.result.summary.suggestionChipsClicked += 1;
      this.recordStep(`Click suggestion chip ${index + 1}`, 'SUCCESS', { chipText });
      await this.screenshot(`suggestion_chip_${index + 1}_${safeName(chipText)}`);

      await this.openCorrectSourceDropdownAndArticle(`suggestion_chip_${index + 1}`, 'positive');
    }
  }

  async openCorrectSourceDropdownAndArticle(contextName, ratingType = 'positive') {
    const sourceButtonCandidates = [
      this.page.locator('main button').filter({ hasText: /^sources?$/i }).last(),
      this.page.locator('main button').filter({ hasText: /sources?|articles?|references?/i }).last(),
      this.page.locator('main [aria-expanded]').filter({ hasText: /sources?|articles?|references?/i }).last(),
      this.page.getByRole('button', { name: /sources?|articles?|references?/i }).last(),
    ];

    let opened = false;

    for (const sourceButton of sourceButtonCandidates) {
      if (!(await visible(sourceButton, 1500))) continue;

      const text = await sourceButton.innerText().catch(() => '');

      if (/everyday|delivery|browse|more|account|cart|search|time/i.test(text)) continue;

      await sourceButton.scrollIntoViewIfNeeded().catch(() => {});
      await sourceButton.click({ timeout: 10000 }).catch(async () => {
        await sourceButton.click({ timeout: 10000, force: true });
      });

      await this.wait(1500);
      opened = true;
      break;
    }

    if (!opened) {
      this.warn(`Correct source dropdown not found for ${contextName}`);
      await this.screenshot(`${contextName}_source_dropdown_not_found`);
      return;
    }

    await this.screenshot(`${contextName}_source_dropdown_opened`);

    const articleLink = this.page
      .locator('main a[href*="/shop/help"]')
      .filter({ hasText: /.+/ })
      .last();

    const fallbackArticleLink = this.page
      .getByRole('link')
      .filter({ hasText: /refund|order|delivery|missing|item|track|change|wrong|help/i })
      .first();

    const targetLink = (await visible(articleLink, 2000)) ? articleLink : fallbackArticleLink;

    if (!(await visible(targetLink, 3000))) {
      this.warn(`Source article link not found for ${contextName}`);
      await this.screenshot(`${contextName}_source_article_not_found`);
      return;
    }

    const linkText = (await targetLink.innerText().catch(() => 'source_article')).trim();

    await targetLink.scrollIntoViewIfNeeded().catch(() => {});
    await targetLink.click({ timeout: 10000 });
    await this.wait(3500);

    this.result.summary.sourceLinksOpened += 1;
    this.result.summary.articlesOpened += 1;
    this.recordStep(`Open source article for ${contextName}`, 'SUCCESS', { linkText });
    await this.screenshot(`${contextName}_source_article_${safeName(linkText)}`);

    await this.expandArticleContent(contextName);
    await this.rateCurrentArticle(contextName, ratingType);

    await this.goBackToHelpCenter();
  }

  async expandArticleContent(contextName) {
    // Article content is often hidden behind an accordion/question row.
    // Click the question/accordion inside the article/topic content before rating.
    const alreadyHasRating = await this.page
      .locator('main button, main [role="button"]')
      .filter({ hasText: /thumbs up|thumbs down|helpful|not helpful|yes|no/i })
      .first()
      .isVisible({ timeout: 1000 })
      .catch(() => false);

    if (alreadyHasRating) {
      return;
    }

    const expanders = [
      this.page.locator('main button[aria-expanded="false"]').filter({ hasText: /.+/ }),
      this.page.locator('main [role="button"][aria-expanded="false"]').filter({ hasText: /.+/ }),
      this.page.locator('main h2, main h3, main h4').locator('xpath=following-sibling::*[1]//button').filter({ hasText: /.+/ }),
      this.page.getByRole('button', { name: /show more|read more|expand|view more|open/i }).first(),
    ];

    for (const locator of expanders) {
      const count = await locator.count().catch(() => 0);

      for (let index = 0; index < count; index += 1) {
        const item = locator.nth(index);

        if (!(await visible(item, 1200))) continue;

        const text = (await item.innerText().catch(() => '')).trim();

        // Avoid opening page/global controls instead of article questions.
        if (/browse|search|cart|login|log in|delivery|select a time|chat now|see more|source/i.test(text)) {
          continue;
        }

        await item.scrollIntoViewIfNeeded().catch(() => {});
        await item.click({ timeout: 10000 }).catch(async () => {
          await item.click({ timeout: 10000, force: true });
        });

        await this.wait(1500);
        this.recordStep(`Expand article question/content for ${contextName}`, 'SUCCESS', { text });
        await this.screenshot(`${contextName}_article_question_expanded`);
        return;
      }
    }

    this.warn(`No expandable article question/content found for ${contextName}`);
  }

  async rateCurrentArticle(contextName, ratingType = 'positive') {
    const positiveCandidates = [
      this.page.getByRole('button', { name: /thumbs up|helpful|yes|like/i }).last(),
      this.page.locator('main button[aria-label*="thumbs up" i]').last(),
      this.page.locator('main button[title*="thumbs up" i]').last(),
    ];

    const negativeCandidates = [
      this.page.getByRole('button', { name: /thumbs down|not helpful|no|dislike/i }).last(),
      this.page.locator('main button[aria-label*="thumbs down" i]').last(),
      this.page.locator('main button[title*="thumbs down" i]').last(),
    ];

    const clicked = await this.clickFirst(
      ratingType === 'negative' ? negativeCandidates : positiveCandidates,
      `${ratingType} rating for ${contextName}`,
      { timeout: 1800, waitAfter: 1500 },
    );

    if (!clicked) {
      this.warn(`${ratingType} rating control not found for ${contextName}`);
      return;
    }

    if (ratingType === 'negative') {
      this.result.summary.negativeRatings += 1;
      await this.fillNegativeFeedback(contextName);
    } else {
      this.result.summary.positiveRatings += 1;
      await this.screenshot(`${contextName}_positive_rating`);
    }
  }

  async fillNegativeFeedback(contextName) {
    const feedbackText = this.options.negativeFeedbackText || 'DSS qa';

    await this.wait(1000);

    // Do not use broad getByRole('textbox').last().
    // It can pick the Help Centre "Ask Anything" Gen FAQ input.
    const boxes = this.page.locator(
      'main textarea, main input[type="text"], textarea, input[type="text"], [contenteditable="true"]'
    );

    const count = await boxes.count().catch(() => 0);

    for (let index = 0; index < count; index += 1) {
      const box = boxes.nth(index);

      if (!(await visible(box, 1000))) continue;

      const attrs = [
        await box.getAttribute('aria-label').catch(() => ''),
        await box.getAttribute('placeholder').catch(() => ''),
        await box.getAttribute('name').catch(() => ''),
        await box.getAttribute('id').catch(() => ''),
      ].filter(Boolean).join(' ').toLowerCase();

      // Critical: skip top FAQ/search inputs.
      if (/ask anything|search products|search everyday|search|question/i.test(attrs)) {
        continue;
      }

      const tagName = await box.evaluate(el => el.tagName.toLowerCase()).catch(() => '');
      const isContentEditable = await box.getAttribute('contenteditable').catch(() => '');

      if (isContentEditable === 'true') {
        await box.click().catch(() => {});
        await box.fill('').catch(() => {});
        await box.type(feedbackText, { delay: 10 }).catch(() => {});
      } else if (tagName === 'textarea' || tagName === 'input') {
        await box.fill(feedbackText).catch(() => {});
      } else {
        continue;
      }

      await this.screenshot(`${contextName}_negative_feedback_filled`);

      await this.clickFirst(
        [
          this.page.locator('main button[type="submit"]').last(),
          this.page.getByRole('button', { name: /submit|send|done/i }).last(),
          this.page.locator('button[type="submit"]').last(),
        ],
        `Submit negative feedback for ${contextName}`,
        { timeout: 1800, waitAfter: 1500 },
      );

      return;
    }

    this.warn(`Negative feedback textarea was not found for ${contextName}. Rating click may still have been captured.`);
    await this.screenshot(`${contextName}_negative_rating_clicked_no_feedback_box`);
  }

  async browseTopicsAndArticles() {
    const topics = await this.getBrowseTopicTexts();
    const maxTopics = Number(this.options.browseTopicsToOpen || topics.length);
    const articlesPerTopic = Number(this.options.articlesToOpenPerTopic || 3);

    if (topics.length === 0) {
      this.warn('No browse topics found.');
      await this.screenshot('browse_topics_not_found');
      return;
    }

    for (const [topicIndex, topic] of topics.slice(0, maxTopics).entries()) {
      await this.goHome();

      const topicLink = this.page.getByRole('link', { name: new RegExp(escapeRegExp(topic), 'i') }).first();

      if (!(await visible(topicLink, 3000))) {
        this.warn(`Browse topic not found: ${topic}`);
        await this.screenshot(`browse_topic_not_found_${safeName(topic)}`);
        continue;
      }

      await topicLink.scrollIntoViewIfNeeded().catch(() => {});
      await topicLink.click({ timeout: 10000 });
      await this.wait(2500);

      this.result.summary.browseTopicsOpened += 1;
      this.recordStep(`Open browse topic ${topicIndex + 1}`, 'SUCCESS', { topic });
      await this.screenshot(`browse_topic_${topicIndex + 1}_${safeName(topic)}`);

      await this.openArticlesFromTopic(topic, articlesPerTopic);
      await this.goBackToHelpCenter();
    }
  }

  async openArticlesFromTopic(topic, maxArticles) {
    const topicUrl = this.page.url();

    for (let index = 0; index < maxArticles; index += 1) {
      await this.page.goto(topicUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await this.wait(1500);

      // Articles/questions may appear as accordions under headings, not only as links.
      const candidates = this.page.locator(
        'main button[aria-expanded], main [role="button"][aria-expanded], main a[href*="/shop/help"]'
      ).filter({ hasText: /.+/ });

      const count = await candidates.count().catch(() => 0);

      if (count === 0) {
        this.warn(`No article/question candidates found under topic: ${topic}`);
        await this.screenshot(`no_article_questions_found_${safeName(topic)}`);
        break;
      }

      let clicked = false;

      for (let candidateIndex = index; candidateIndex < count; candidateIndex += 1) {
        const article = candidates.nth(candidateIndex);
        const articleText = (await article.innerText().catch(() => `article_${candidateIndex + 1}`)).trim();

        if (!articleText) continue;

        // Avoid breadcrumbs, topic cards, page/global controls, and navigation controls.
        if (
          /help centre|help center|browse topics|contact us|chat now|see more|log in|cart|delivery|search|source/i.test(articleText)
        ) {
          continue;
        }

        await article.scrollIntoViewIfNeeded().catch(() => {});
        await article.click({ timeout: 10000 }).catch(async () => {
          await article.click({ timeout: 10000, force: true });
        });

        await this.wait(2500);

        this.result.summary.articlesOpened += 1;
        this.recordStep(`Open article/question ${index + 1} from ${topic}`, 'SUCCESS', { articleText });
        await this.screenshot(`topic_${safeName(topic)}_article_${index + 1}_${safeName(articleText)}`);

        // If the click navigated to an article page or opened a content page,
        // click the article question/content heading before rating.
        await this.expandArticleContent(`topic_${safeName(topic)}_article_${index + 1}`);

        const ratingType = index % 2 === 0 ? 'negative' : 'positive';
        await this.rateCurrentArticle(`topic_${safeName(topic)}_article_${index + 1}`, ratingType);

        clicked = true;
        break;
      }

      if (!clicked) {
        this.warn(`Could not click article/question ${index + 1} under topic: ${topic}`);
        await this.screenshot(`article_question_not_clicked_${safeName(topic)}_${index + 1}`);
        break;
      }
    }
  }

  async feedbackFormFlow() {
    await this.goHome();

    const feedbackTopic = this.page.getByRole('link', { name: /feedback/i }).first();

    if (!(await visible(feedbackTopic, 3000))) {
      this.warn('Feedback browse topic not found.');
      await this.screenshot('feedback_topic_not_found');
      return;
    }

    await feedbackTopic.click({ timeout: 10000 });
    await this.wait(2500);
    await this.screenshot('feedback_topic_page');

    const feedbackAndEnquiry = this.page
      .locator('main a, main button')
      .filter({ hasText: /feedback.*enquiry|enquiry.*feedback|feedback and enquiry|feedback & enquiry/i })
      .first();

    const fallbackFeedbackArticle = this.page
      .locator('main a[href*="/shop/help"]')
      .filter({ hasText: /feedback|enquiry|shopping experience/i })
      .first();

    const article = (await visible(feedbackAndEnquiry, 2000))
      ? feedbackAndEnquiry
      : fallbackFeedbackArticle;

    if (!(await visible(article, 3000))) {
      this.warn('Feedback and Enquiry article not found.');
      await this.screenshot('feedback_and_enquiry_article_not_found');
      return;
    }

    await article.scrollIntoViewIfNeeded().catch(() => {});
    await article.click({ timeout: 10000 });
    await this.wait(2500);
    await this.screenshot('feedback_and_enquiry_article');

    await this.expandArticleContent('feedback_and_enquiry');

    const opened = await this.clickFirst(
      [
        this.page.locator('main button, main a').filter({ hasText: /feedback form|submit feedback|give feedback|make an enquiry|enquiry form|contact form/i }).first(),
        this.page.locator('main iframe').first(),
      ],
      'Open hidden feedback form inside Feedback and Enquiry content',
      { timeout: 2500, waitAfter: 2500 },
    );

    if (!opened) {
      this.warn('Feedback form trigger not found inside Feedback and Enquiry content.');
      await this.screenshot('feedback_form_trigger_not_found');
      return;
    }

    await this.screenshot('feedback_form_opened');

    const timestamp = Date.now();

    const fields = [
      [/first name|name/i, 'DSS'],
      [/last name|surname/i, 'QA'],
      [/email/i, `dssqa.${timestamp}@example.com`],
      [/phone|mobile/i, '0400000000'],
      [/message|comment|feedback|details|tell us|enquiry/i, this.options.formSubmissionText || 'DSS qa'],
    ];

    for (const [label, value] of fields) {
      const byLabel = this.page.getByLabel(label).first();

      if (await visible(byLabel, 800)) {
        await byLabel.fill(value).catch(() => {});
        continue;
      }

      const byPlaceholder = this.page.getByPlaceholder(label).first();

      if (await visible(byPlaceholder, 800)) {
        await byPlaceholder.fill(value).catch(() => {});
      }
    }

    const textarea = this.page.locator('textarea').last();

    if (await visible(textarea, 1000)) {
      await textarea.fill(this.options.formSubmissionText || 'DSS qa').catch(() => {});
    }

    await this.screenshot('feedback_form_filled');

    const targetEnv = this.readEnv('TARGET_ENV', 'PROD').toUpperCase();
    const allowSubmit =
      this.options.submitFormInUAT === true ||
      this.readEnv('ALLOW_FEEDBACK_SUBMIT', targetEnv === 'UAT' ? 'true' : 'false') === 'true';

    if (!allowSubmit) {
      this.warn('Feedback form submit skipped outside UAT or without ALLOW_FEEDBACK_SUBMIT=true.');
      return;
    }

    const submitted = await this.clickFirst(
      [
        this.page.getByRole('button', { name: /submit|send/i }).last(),
        this.page.locator('button[type="submit"]').last(),
      ],
      'Submit Feedback and Enquiry form',
      { timeout: 2500, waitAfter: 3000 },
    );

    if (submitted) {
      this.result.summary.feedbackSubmitted = true;
      await this.screenshot('feedback_form_submitted');
    }
  }

  async verifyOrderArea() {
    await this.goHome();

    const hasLoginBanner = await this.page
      .getByText(/get help with your orders|log in to track deliveries|request refunds/i)
      .first()
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    const hasOrderCarousel = await this.page
      .getByText(/recent orders|your orders|order history|track deliveries/i)
      .first()
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    await this.screenshot('orders_area_login_banner_or_carousel');

    if (hasLoginBanner) {
      this.recordStep('Verify logged-out order support banner', 'SUCCESS');
    } else if (hasOrderCarousel) {
      this.recordStep('Verify logged-in order carousel', 'SUCCESS');
    } else {
      this.warn('Could not clearly identify order login banner or order carousel.');
    }
  }

  async contactUsFlow() {
    await this.goHome();

    await this.page.getByText(/contact us/i).first().scrollIntoViewIfNeeded().catch(async () => {
      await this.page.mouse.wheel(0, 2600);
    });

    await this.screenshot('contact_us_section');

    await this.clickFirst(
      [
        this.page.getByRole('tab', { name: /woolworths/i }).first(),
        this.page.getByRole('button', { name: /woolworths/i }).first(),
      ],
      'Select Woolworths Contact Us tab',
      { timeout: 1500, waitAfter: 1000 },
    );

    const oliveLaunched = await this.clickFirst(
      [
        this.page.getByRole('button', { name: /chat now/i }).first(),
        this.page.locator('main button').filter({ hasText: /chat now|chat with olive/i }).first(),
      ],
      'Launch Olive from Contact Us',
      { timeout: 2500, waitAfter: 5000 },
    );

    if (oliveLaunched) {
      this.result.summary.oliveLaunched = true;
      await this.screenshot('contact_us_olive_launched');
    }

    await this.goHome();

    await this.page.getByText(/contact us/i).first().scrollIntoViewIfNeeded().catch(async () => {
      await this.page.mouse.wheel(0, 2600);
    });

    const appLanding = await this.clickFirst(
      [
        this.page.getByRole('button', { name: /see more/i }).first(),
        this.page.locator('main button, main a').filter({ hasText: /see more/i }).first(),
      ],
      'Open Message us on the app See more landing page',
      { timeout: 2500, waitAfter: 3500 },
    );

    if (appLanding) {
      this.result.summary.appLandingOpened = true;
      await this.screenshot('message_us_on_app_landing_page');
    }
  }

  async run() {
    await this.goHome();
    await this.screenshot('help_centre_advanced_start');

    await this.askGenFaqQuestions();
    await this.clickSuggestionChips();
    await this.verifyOrderArea();
    await this.browseTopicsAndArticles();
    await this.feedbackFormFlow();
    await this.contactUsFlow();

    this.result.endedAt = new Date().toISOString();

    this.result.summary.passed =
      this.result.summary.genFaqQuestionsAsked > 0 &&
      this.result.summary.suggestionChipsClicked > 0 &&
      this.result.summary.browseTopicsOpened > 0 &&
      this.result.summary.articlesOpened > 0;

    return this.result;
  }
}

async function runAdvancedHelpCenterExploration(page, options = {}) {
  const explorer = new HelpCenterAdvancedExplorer(page, options);
  return explorer.run();
}

module.exports = { runAdvancedHelpCenterExploration };
