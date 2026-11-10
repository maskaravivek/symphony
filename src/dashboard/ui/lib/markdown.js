// Minimal markdown → AST. Supports headings, paragraphs, lists, code fences,
// block quotes, rules, inline code, bold, italics and http(s) links.
// Output is plain data; the DOM renderer creates text nodes only, so nothing
// in the source can ever be interpreted as HTML.

const FENCE = /^\s*(```|~~~)\s*([\w+.-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;

export function parseMarkdown(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  let list = null;

  const flushPara = () => {
    if (para.length) blocks.push({ type: 'paragraph', inline: parseInline(para.join(' ')) });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push(list);
    list = null;
  };
  const flush = () => { flushPara(); flushList(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(FENCE);
    if (fence) {
      flush();
      const marker = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) body.push(lines[i++]);
      blocks.push({ type: 'code', lang: fence[2] || null, text: body.join('\n') });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const heading = line.match(HEADING);
    if (heading) {
      flush();
      blocks.push({ type: 'heading', level: heading[1].length, inline: parseInline(heading[2]) });
      continue;
    }
    if (RULE.test(line)) { flush(); blocks.push({ type: 'rule' }); continue; }
    const bullet = line.match(BULLET);
    const ordered = bullet ? null : line.match(ORDERED);
    if (bullet || ordered) {
      flushPara();
      const isOrdered = Boolean(ordered);
      const indent = (bullet ?? ordered)[1].length;
      const text = bullet ? bullet[2] : ordered[3];
      if (!list || list.ordered !== isOrdered) {
        flushList();
        list = { type: 'list', ordered: isOrdered, start: isOrdered ? Number(ordered[2]) : null, items: [] };
      }
      list.items.push({ depth: Math.min(3, Math.floor(indent / 2)), inline: parseInline(text) });
      continue;
    }
    const quote = line.match(QUOTE);
    if (quote) {
      flush();
      const body = [quote[1]];
      while (i + 1 < lines.length && QUOTE.test(lines[i + 1])) body.push(lines[++i].match(QUOTE)[1]);
      blocks.push({ type: 'quote', inline: parseInline(body.join(' ')) });
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      // continuation of the previous list item
      const last = list.items[list.items.length - 1];
      last.inline = last.inline.concat([{ type: 'text', text: ' ' }], parseInline(line.trim()));
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flush();
  return blocks;
}

function safeHref(href) {
  const h = String(href).trim();
  return /^(https?:\/\/|mailto:)/i.test(h) ? h : null;
}

/** Inline parse → [{type:'text'|'code'|'strong'|'em'|'link', ...}] */
export function parseInline(text) {
  const out = [];
  const s = String(text ?? '');
  let i = 0;
  let buf = '';
  const pushText = () => {
    if (buf) out.push({ type: 'text', text: buf });
    buf = '';
  };
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length && /[\\`*_[\]()#>-]/.test(s[i + 1])) {
      buf += s[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      let ticks = 1;
      while (s[i + ticks] === '`') ticks++;
      const marker = '`'.repeat(ticks);
      const end = s.indexOf(marker, i + ticks);
      if (end > i) {
        pushText();
        out.push({ type: 'code', text: s.slice(i + ticks, end).replace(/^ (.*) $/, '$1') });
        i = end + ticks;
        continue;
      }
    }
    if ((ch === '*' || ch === '_') && s[i + 1] === ch) {
      const marker = ch + ch;
      const end = s.indexOf(marker, i + 2);
      if (end > i + 2) {
        pushText();
        out.push({ type: 'strong', children: parseInline(s.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if ((ch === '*' || ch === '_') && s[i + 1] && s[i + 1] !== ' ' && s[i + 1] !== ch) {
      const prev = s[i - 1];
      const end = s.indexOf(ch, i + 1);
      const wordInner = ch === '_' && prev && /\w/.test(prev);
      if (!wordInner && end > i + 1 && s[end - 1] !== ' ') {
        pushText();
        out.push({ type: 'em', children: parseInline(s.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (ch === '[') {
      const close = s.indexOf(']', i + 1);
      if (close > i && s[close + 1] === '(') {
        const end = s.indexOf(')', close + 2);
        if (end > close) {
          const href = safeHref(s.slice(close + 2, end));
          const label = s.slice(i + 1, close);
          pushText();
          if (href) out.push({ type: 'link', href, children: parseInline(label) });
          else out.push(...parseInline(label));
          i = end + 1;
          continue;
        }
      }
    }
    if (ch === 'h' && /^https?:\/\/[^\s<>()]+/.test(s.slice(i)) && (i === 0 || /[\s(]/.test(s[i - 1]))) {
      const m = s.slice(i).match(/^https?:\/\/[^\s<>()]+/);
      let url = m[0];
      while (/[.,;:!?]$/.test(url)) url = url.slice(0, -1);
      pushText();
      out.push({ type: 'link', href: url, children: [{ type: 'text', text: url }] });
      i += url.length;
      continue;
    }
    buf += ch;
    i++;
  }
  pushText();
  return out;
}

/** Find the SYMPHONY_GROOMING_RESULT JSON in a last message, if any. */
export function extractGroomingResult(text) {
  const s = String(text ?? '');
  const idx = s.lastIndexOf('SYMPHONY_GROOMING_RESULT');
  if (idx < 0) return null;
  const rest = s.slice(idx + 'SYMPHONY_GROOMING_RESULT'.length);
  const start = rest.indexOf('{');
  const end = rest.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(rest.slice(start, end + 1));
  } catch {
    return null;
  }
}
