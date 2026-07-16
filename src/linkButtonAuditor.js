async function auditLinksAndButtons(page, options = {}) {
  const maxLinksToCheck = Number(options.maxLinksToCheck || process.env.AUDIT_MAX_LINKS_TO_CHECK || 40);

  const raw = await page.evaluate(() => {
    const isVisible = el => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        rect.width > 0 &&
        rect.height > 0;
    };

    const textOf = el => [
      el.innerText,
      el.textContent,
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('placeholder'),
      el.value,
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

    const links = Array.from(document.querySelectorAll('a'))
      .filter(isVisible)
      .map((el, index) => ({
        index,
        text: textOf(el).slice(0, 180),
        href: el.href || el.getAttribute('href') || '',
        area: el.closest('header') ? 'header' : el.closest('footer') ? 'footer' : 'main',
        disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      }));

    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(isVisible)
      .map((el, index) => ({
        index,
        text: textOf(el).slice(0, 180),
        role: el.getAttribute('role') || el.tagName.toLowerCase(),
        area: el.closest('header') ? 'header' : el.closest('footer') ? 'footer' : 'main',
        disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
        expanded: el.getAttribute('aria-expanded'),
      }));

    return {
      url: location.href,
      origin: location.origin,
      title: document.title,
      links,
      buttons,
    };
  });

  const importantPattern = /help|faq|contact|order|delivery|pickup|refund|return|account|rewards|manage/i;
  const checkedLinks = [];
  const warnings = [];
  const errors = [];

  for (const link of raw.links.slice(0, maxLinksToCheck)) {
    const result = { ...link, status: 'not_checked', ok: true, severity: 'none', issue: '' };

    if (!link.href) {
      result.status = 'missing_href';
      result.ok = false;
      result.severity = importantPattern.test(link.text) ? 'error' : 'warning';
      result.issue = 'Visible link has no href.';
      checkedLinks.push(result);
      (result.severity === 'error' ? errors : warnings).push(result);
      continue;
    }

    if (
      link.href.startsWith('mailto:') ||
      link.href.startsWith('tel:') ||
      link.href.startsWith('javascript:') ||
      link.href.includes('#')
    ) {
      result.status = 'skipped_protocol_or_anchor';
      checkedLinks.push(result);
      continue;
    }

    let url;
    try {
      url = new URL(link.href);
    } catch (_) {
      result.status = 'invalid_url';
      result.ok = false;
      result.severity = importantPattern.test(link.text) ? 'error' : 'warning';
      result.issue = 'Invalid URL.';
      checkedLinks.push(result);
      (result.severity === 'error' ? errors : warnings).push(result);
      continue;
    }

    if (url.origin !== raw.origin) {
      result.status = 'skipped_external';
      checkedLinks.push(result);
      continue;
    }

    try {
      const response = await page.request.get(link.href, {
        timeout: Number(process.env.LINK_CHECK_TIMEOUT_MS || 12000),
        maxRedirects: 3,
      });

      result.status = response.status();

      if ([404, 410].includes(response.status()) || response.status() >= 500) {
        result.ok = false;
        result.severity = 'error';
        result.issue = `Important internal link returned HTTP ${response.status()}`;
        errors.push(result);
      } else if (response.status() >= 400) {
        result.ok = false;
        result.severity = 'warning';
        result.issue = `Internal link returned HTTP ${response.status()}. This may be expected on UAT/protected pages.`;
        warnings.push(result);
      }
    } catch (error) {
      result.status = 'request_failed';
      result.ok = false;
      result.severity = importantPattern.test(link.text) ? 'error' : 'warning';
      result.issue = error.message;
      (result.severity === 'error' ? errors : warnings).push(result);
    }

    checkedLinks.push(result);
  }

  const disabledButtons = raw.buttons
    .filter(button => button.disabled)
    .map(button => ({
      ...button,
      ok: false,
      severity: importantPattern.test(button.text) ? 'error' : 'warning',
      issue: 'Visible button is disabled.',
    }));

  for (const button of disabledButtons) {
    (button.severity === 'error' ? errors : warnings).push(button);
  }

  return {
    url: raw.url,
    title: raw.title,
    summary: {
      visibleLinks: raw.links.length,
      visibleButtons: raw.buttons.length,
      checkedLinks: checkedLinks.length,
      errors: errors.length,
      warnings: warnings.length,
      linkIssues: checkedLinks.filter(link => !link.ok).length,
      disabledVisibleButtons: disabledButtons.length,
      passed: errors.length === 0,
    },
    links: raw.links,
    checkedLinks,
    buttons: raw.buttons,
    warnings,
    errors,
  };
}

module.exports = { auditLinksAndButtons };
