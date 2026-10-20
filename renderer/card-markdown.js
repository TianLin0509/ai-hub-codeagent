'use strict';

const escapeHtml = value => String(value || '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Card bodies show image destinations as links. Keep this per parse so file
// previews and other Markdown surfaces still use the normal image renderer.
function parseCardMarkdown(marked, text) {
  return marked.parse(text, {
    breaks: true,
    gfm: true,
    walkTokens(token) {
      // An image inside an existing link must not create nested anchors.
      if (token.type === 'link') {
        marked.walkTokens(token.tokens || [], child => {
          if (child.type !== 'image') return;
          child.type = 'text';
          child.text = /^data:/i.test(child.href || '') ? child.text || '查看图片' : child.href || child.text;
          delete child.tokens;
        });
      }
      if (token.type !== 'image') return;
      if (/^data:image\/(?:png|jpe?g|gif|webp|bmp|avif|svg\+xml)[;,]/i.test(token.href || '')) {
        token.type = 'text';
        token.text = '<button type="button" class="conversation-image-thumb" data-action="card-open-image"'
          + ' data-image-src="' + escapeHtml(token.href) + '">'
          + escapeHtml(token.text || '查看图片') + '</button>';
        token.escaped = true;
        delete token.tokens;
        return;
      }
      const label = /^data:/i.test(token.href || '')
        ? token.text || '查看图片'
        : token.href || token.text || '查看图片';
      token.type = 'link';
      token.text = label;
      token.tokens = [{ type: 'text', raw: label, text: label }];
    },
  });
}

module.exports = { parseCardMarkdown };
