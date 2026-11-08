'use strict';
/* NorthLight Tower — small, safe markdown converter (for the reply reader and chat).
   PO.md.render(text) → HTML string (everything escaped; only http/https links). Heading, bold/italic, `kod` (inline code), ``` code block,
   list (one nested level), quote, table, horizontal rule, paragraph. PO.md.plain(text) → short plain text without markup (for the summary). */
(function (PO) {
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const NUL = String.fromCharCode(0);

const HOLD_RE = new RegExp(NUL + '(\\d+)' + NUL, 'g');
function inline(raw) {
  // code and link parts are replaced by placeholders and put back at the very end: no nested <a>, italic markers inside bold do not stay raw
  const held = [];
  const hold = h => NUL + (held.push(h) - 1) + NUL;
  const back = t => t.replace(HOLD_RE, (_, i) => back(held[+i]));
  let s = String(raw).split(NUL).join('').replace(/`([^`\n]+)`/g, (_, c) => hold('<code>' + esc(c) + '</code>'));
  s = esc(s);
  s = s.replace(/\*\*((?:[^*\n]|\*(?!\*))+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?![*\w])/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => hold('<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + t + '</a>'));
  s = s.replace(/(^|[\s(>])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  return back(s);
}
const isTableSep = l => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l) && l.includes('-') && l.includes('|');
const cells = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

const MAX_LINE = 4000, MAX_QUOTE = 5;           // at most 4000 characters per line; at most 5 quote levels (so a broken/very long input cannot freeze the page)
function renderBlocks(text, depth) {
  const lines = String(text == null ? '' : text).slice(0, 60000).replace(/\r\n?/g, '\n').split('\n').map(l => (l.length > MAX_LINE ? l.slice(0, MAX_LINE) + '…' : l));
  const out = [];
  let i = 0, para = [];
  const flush = () => { if (para.length) { out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; } };
  while (i < lines.length) {
    const ln = lines[i];
    let m;
    if ((m = /^\s*```\s*([\w+-]*)\s*$/.exec(ln))) {                        // code block
      flush();
      const body = []; i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push('<pre class="md-code"' + (m[1] ? ' data-lang="' + esc(m[1]) + '"' : '') + '><code>' + esc(body.join('\n')) + '</code></pre>');
      continue;
    }
    if (!ln.trim()) { flush(); i++; continue; }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(ln))) { flush(); const n = Math.min(m[1].length + 1, 5); out.push('<h' + n + '>' + inline(m[2]) + '</h' + n + '>'); i++; continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(ln) && !/^\s*[-*]\s+\S/.test(ln)) { flush(); out.push('<hr>'); i++; continue; }
    if (depth < MAX_QUOTE && /^\s*>/.test(ln)) {                             // quote (plain text after the 5th level)
      flush();
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push('<blockquote>' + renderBlocks(q.join('\n'), depth + 1) + '</blockquote>');
      continue;
    }
    if (ln.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {   // table
      flush();
      const head = cells(ln); i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push('<div class="md-table"><table><thead><tr>' + head.map(c => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>' +
        rows.map(r => '<tr>' + head.map((_, k) => '<td>' + inline(r[k] || '') + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>');
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(ln)) {                                 // list (one nested level)
      flush();
      const ordered = /^\s*\d+[.)]\s+/.test(ln);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        const mm = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        const depth = mm[1].length >= 2 ? 1 : 0;
        items.push({ depth, text: mm[3] });
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) items[items.length - 1].text += ' ' + lines[i++].trim();
      }
      const tag = ordered ? 'ol' : 'ul';
      const html = '<' + tag + '>' + items.map(it => '<li' + (it.depth ? ' class="d1"' : '') + '>' + inline(it.text) + '</li>').join('') + '</' + tag + '>';
      out.push(html);
      continue;
    }
    para.push(ln); i++;
  }
  flush();
  return '<div class="md">' + out.join('') + '</div>';
}
// do not crash on error: show escaped plain text (so one reply cannot stop the card / chat update)
function render(text) {
  try { return renderBlocks(text, 0); }
  catch (e) {
    console.error('[md]', e);
    return '<div class="md"><p>' + esc(String(text == null ? '' : text).slice(0, 30000)).replace(/\n/g, '<br>') + '</p></div>';
  }
}
// short text without markup (for the summary line)
function plain(text, max) {
  let s = String(text == null ? '' : text).slice(0, 8000).replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]*)`/g, '$1').replace(/^#{1,6}\s+/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1$2').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/^\s*[-*+]\s+/gm, '• ').replace(/^\s*>\s?/gm, '').replace(/\s+/g, ' ').trim();
  return max && s.length > max ? s.slice(0, max - 1) + '…' : s;
}
PO.md = { render, plain, esc };
})(window.PO = window.PO || {});
