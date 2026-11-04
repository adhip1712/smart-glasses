(() => {
  'use strict';

  const SELECTORS = [
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    '.ytp-skip-ad-button'
  ];
  const LABEL = /skip\s*(this\s*)?(ad|ads)|skip\s*ad/i;
  const clicked = new WeakSet();

  function isVisibleAndEnabled(button) {
    if (!(button instanceof HTMLElement)) return false;
    const style = getComputedStyle(button);
    const rect = button.getBoundingClientRect();
    return !button.hasAttribute('disabled') &&
      button.getAttribute('aria-disabled') !== 'true' &&
      style.display !== 'none' && style.visibility !== 'hidden' &&
      Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  }

  function isNativeSkipControl(button) {
    const label = [
      button.getAttribute('aria-label'),
      button.getAttribute('title'),
      button.innerText,
      button.textContent
    ].filter(Boolean).join(' ');
    return SELECTORS.some(selector => button.matches(selector)) || LABEL.test(label);
  }

  function trySkip() {
    const candidates = new Set();
    for (const selector of SELECTORS) {
      document.querySelectorAll(selector).forEach(el => candidates.add(el));
    }
    document.querySelectorAll('button[aria-label], button[title]').forEach(el => {
      if (LABEL.test([el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent].join(' '))) {
        candidates.add(el);
      }
    });

    for (const button of candidates) {
      if (clicked.has(button) || !isNativeSkipControl(button) || !isVisibleAndEnabled(button)) continue;
      clicked.add(button);
      button.click();
      console.info('[Visionary Nexus] Clicked YouTube native Skip Ads control.');
      break;
    }
  }

  let queued = false;
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      trySkip();
    });
  });

  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'aria-label', 'disabled'] });
  trySkip();
})();
