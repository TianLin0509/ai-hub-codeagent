'use strict';

const OMITTED_IMAGE = '[图片编码已过滤]';

// Work on incoming JSON text, BEFORE the transport's size guard/JSON.parse.
// Keep only a small lookahead while discarding binary strings, including when
// the header, escape or image body straddles arbitrary stdout chunks.
class InlineImageFilter {
  constructor() { this.tail = ''; this.dropping = false; }
  feed(text, final = false) {
    let rest = this.tail + text, out = '';
    this.tail = '';
    while (rest) {
      if (this.dropping) {
        const boundary = /[^A-Za-z0-9+/=]/.exec(rest);
        rest = boundary ? rest.slice(boundary.index) : '';
        if (!rest) break;
        if (/^\\[\/nr]/.test(rest)) { rest = rest.slice(2); continue; }
        // An escaped slash can itself be split across chunks.
        if (!final && rest === '\\') { this.tail = rest; break; }
        this.dropping = false;
      }
      const header = /data:image(?:\/|\\\/)[a-z0-9.+-]+;base64,/i.exec(rest);
      if (header) {
        out += rest.slice(0, header.index) + OMITTED_IMAGE;
        rest = rest.slice(header.index + header[0].length);
        this.dropping = true;
      } else {
        const keep = final ? 0 : Math.min(128, rest.length);
        out += rest.slice(0, rest.length - keep);
        this.tail = rest.slice(rest.length - keep);
        break;
      }
    }
    return out;
  }
}

class JsonImageFilter {
  constructor() { this.stack = []; this.string = null; }
  feed(text) {
    const out = [];
    let pos = 0;
    const emitString = (raw, final = false) => {
      const s = this.string;
      if (s.capture && s.captureText.length < 256) s.captureText += raw.slice(0, 256 - s.captureText.length);
      if (s.key) { s.probe += raw; if (s.probe.length > 32 * 1024 * 1024) throw Error('JSON key exceeds 32 MiB'); return; }
      if (s.drop) return;
      // Native user echoes participate in exact submission reconciliation.
      // Deliberately supplied text/vision input must not be rewritten here.
      if (s.preserve) { out.push(raw); return; }
      if (!s.inline) {
        s.probe += raw;
        if (!final && s.probe.length < 192) return;
        // Raw PNG/JPEG/GIF/WebP payloads sometimes arrive before their type
        // discriminator. Recognise signatures only in binary-bearing fields.
        if (['result', 'data', 'base64', 'image', 'image_url', 'url'].includes(s.field)
            && /^(?:iVBORw0KGgo|\/9j\/|R0lGOD|UklGR)/.test(s.probe)
            && s.probe.length >= 128) {
          s.drop = true; s.probe = ''; out.push(OMITTED_IMAGE); return;
        }
        s.inline = new InlineImageFilter();
        raw = s.probe; s.probe = '';
      }
      out.push(s.inline.feed(raw, final));
    };
    while (pos < text.length) {
      const s = this.string;
      if (s) {
        if (s.escape) {
          const ch = text[pos++];
          if (s.unicode) {
            if (!/[0-9a-f]/i.test(ch)) throw Error('Invalid JSON unicode escape');
            s.unicode--; if (!s.unicode) s.escape = false;
          } else if (ch === 'u') s.unicode = 4;
          else { if (!'"\\/bfnrt'.includes(ch)) throw Error('Invalid JSON escape'); s.escape = false; }
          emitString(ch); continue;
        }
        const special = /["\\\x00-\x1f]/g;
        special.lastIndex = pos;
        const match = special.exec(text);
        const end = match ? match.index : text.length;
        if (end > pos) {
          // Probe a bounded prefix, never concatenate a whole image to it.
          const split = Math.min(end, pos + Math.max(0, 192 - s.probe.length));
          if (!s.key && !s.inline && !s.drop && split > pos) { emitString(text.slice(pos, split)); pos = split; }
          if (end > pos) emitString(text.slice(pos, end));
          pos = end;
        }
        if (!match) continue;
        const ch = text[pos++];
        if (ch === '\\') { emitString(ch); s.escape = true; }
        else if (ch === '"') {
          emitString('', true);
          if (s.key) {
            s.frame.field = JSON.parse('"' + s.probe + '"');
            s.frame.key = false; out.push(s.probe);
          } else if (s.capture) {
            // Discriminator values are short and never image payloads.
            s.frame[s.field] = s.captureText;
            if (s.field === 'type' && /^(?:userMessage|user_message)$/.test(s.captureText)) s.frame.preserve = true;
          }
          out.push('"'); this.string = null;
        } else throw Error('Invalid control character in JSON string');
        continue;
      }
      const ch = text[pos++];
      const frame = this.stack.at(-1);
      if (ch === '"') {
        const key = !!frame?.key, field = key ? null : frame?.field;
        const type = String(frame?.type || '').toLowerCase();
        const image = type === 'image' || /image.?generation/.test(type)
          || /^image\//.test(frame?.mimeType || frame?.media_type || '');
        const preserve = frame?.preserve === true;
        const drop = !key && !preserve && (['b64_json', 'partial_image_b64'].includes(field)
          || (image && ['data', 'result', 'image', 'base64'].includes(field)));
        this.string = { key, field, frame, probe:'', drop, preserve, inline:null, escape:false,
          capture:!key && ['type', 'mimeType', 'media_type'].includes(field), captureText:'' };
        out.push('"'); if (drop) out.push(OMITTED_IMAGE);
      } else if (ch === '{' || ch === '[') this.stack.push({ object:ch === '{', key:ch === '{', preserve:frame?.preserve === true });
      else if (ch === '}' || ch === ']') this.stack.pop();
      else if (ch === ',' && frame?.object) { frame.key = true; frame.field = null; }
      out.push(ch === '"' ? '' : ch);
    }
    return out.join('');
  }
}

module.exports = { JsonImageFilter, OMITTED_IMAGE };
