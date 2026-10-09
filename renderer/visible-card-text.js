'use strict';

// Extract the human-readable answer from rendered card DOM. Copying raw markdown
// leaks fences such as ```bash; copying innerText directly leaks hover controls
// such as “Bash · 复制”, “展开 30 行” and meeting escape buttons. Clone first so
// the live card is never mutated, strip UI chrome, then ask Chromium for rendered
// text so paragraphs/lists/code keep their visible line breaks.
function extractVisibleCardText(root) {
  if (!root || typeof root.cloneNode !== 'function') return '';
  const doc = root.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc || !doc.body) return String(root.textContent || '').trim();

  const clone = root.cloneNode(true);
  clone.querySelectorAll([
    'button',
    '.code-copy',
    '.code-toggle',
    '.body-fold-toggle',
    '.mr-gc-code-copy',
    '.mr-ft-cursor',
    '.mr-truncated-hint',
    '.conversation-entry-head',
    '.conversation-long-preview',
    '[data-copy-exclude]',
  ].join(',')).forEach(node => node.remove());
  clone.querySelectorAll('.conversation-long-message, .conversation-activity').forEach(details => {
    details.open=true;
    details.querySelector('summary')?.remove();
  });

  // A collapsed code block is still answer content; only its fold control is UI.
  clone.querySelectorAll('pre').forEach(pre => {
    if (pre.style && pre.style.display === 'none') pre.style.display = '';
  });

  // KaTeX carries visual HTML and an accessibility MathML copy. Replace the whole
  // widget with its original TeX annotation to avoid duplicated formula text.
  clone.querySelectorAll('.katex').forEach(math => {
    const annotation = math.querySelector('annotation[encoding="application/x-tex"]');
    if (annotation) math.replaceWith(doc.createTextNode(annotation.textContent || ''));
  });

  const sandbox = doc.createElement('div');
  sandbox.setAttribute('aria-hidden', 'true');
  sandbox.style.cssText = [
    'position:fixed',
    'left:-100000px',
    'top:0',
    `width:${Math.max(320, Math.round(root.getBoundingClientRect?.().width || 720))}px`,
    'opacity:0',
    'pointer-events:none',
    'white-space:normal',
  ].join(';');
  sandbox.appendChild(clone);
  doc.body.appendChild(sandbox);
  let text = '';
  try {
    text = clone.innerText || clone.textContent || '';
  } finally {
    sandbox.remove();
  }
  return String(text)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { extractVisibleCardText };
