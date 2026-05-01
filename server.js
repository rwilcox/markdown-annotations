import express from 'express';
import MarkdownIt from 'markdown-it';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = path.resolve(process.env.CONTENT_DIR || path.join(__dirname, 'content'));
const PORT = Number(process.env.PORT || 3000);

const md = new MarkdownIt({ html: false, linkify: true, typographer: true });

/** Normalize text for stable hashing across small whitespace differences. */
function normalize(text) {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function hashAnchor(text) {
  return 'a' + crypto.createHash('sha1').update(normalize(text)).digest('hex').slice(0, 10);
}

/**
 * Render the source document. For every top-level block token, attach a
 * `data-anchor` derived from a hash of its normalized plaintext, so the
 * browser can find paragraphs/headings/lists by content-derived id.
 *
 * Returns { html, blocks } where `blocks` is a list of
 * { anchor, normalizedText } so notes can do substring lookups.
 */
function renderDoc(source) {
  const tokens = md.parse(source, {});
  const blocks = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.level !== 0 || !t.type.endsWith('_open')) continue;
    // Collect plaintext of this block by scanning until matching _close.
    const closeType = t.type.replace(/_open$/, '_close');
    let depth = 1;
    let text = '';
    for (let j = i + 1; j < tokens.length; j++) {
      const tj = tokens[j];
      if (tj.type === t.type) depth++;
      else if (tj.type === closeType) {
        depth--;
        if (depth === 0) break;
      }
      if (tj.type === 'inline') text += ' ' + tj.content;
      else if (tj.type === 'fence' || tj.type === 'code_block') text += ' ' + tj.content;
    }
    if (!text.trim()) continue;
    const anchor = hashAnchor(text);
    t.attrJoin('data-anchor', anchor);
    blocks.push({ anchor, normalizedText: normalize(text) });
  }
  return { html: md.renderer.render(tokens, md.options, {}), blocks };
}

/**
 * Parse the notes file. Each top-level blockquote is one annotation. The
 * blockquote's first non-empty line MUST be a quoted snippet of source text,
 * e.g.  > "the original text"  — that snippet is matched against the source
 * blocks (substring, normalized) to find a target anchor. The rest of the
 * blockquote becomes the annotation body.
 */
function renderNotes(source, blocks) {
  const tokens = md.parse(source, {});
  const notes = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.level !== 0 || t.type !== 'blockquote_open') continue;
    // Find matching close.
    let depth = 1;
    let end = i;
    for (let j = i + 1; j < tokens.length; j++) {
      if (tokens[j].type === 'blockquote_open') depth++;
      else if (tokens[j].type === 'blockquote_close') {
        depth--;
        if (depth === 0) { end = j; break; }
      }
    }
    const inner = tokens.slice(i + 1, end);

    // Extract first inline token's first line as the snippet.
    let snippet = null;
    for (let k = 0; k < inner.length; k++) {
      const tk = inner[k];
      if (tk.type === 'inline' && tk.content.trim()) {
        const firstLine = tk.content.split('\n')[0].trim();
        const m = firstLine.match(/^["“”'‘’](.+)["“”'‘’]$/);
        if (m) {
          snippet = m[1];
          const rest = tk.content.split('\n').slice(1).join('\n').trim();
          if (rest === '') {
            // Drop the whole paragraph_open/inline/paragraph_close trio so
            // we don't emit an empty <p></p> in the rendered annotation.
            const dropFrom = inner[k - 1]?.type === 'paragraph_open' ? k - 1 : k;
            const dropTo = inner[k + 1]?.type === 'paragraph_close' ? k + 1 : k;
            inner.splice(dropFrom, dropTo - dropFrom + 1);
          } else {
            tk.content = rest;
            if (tk.children) {
              tk.children = md.parseInline(rest, {})[0]?.children || [];
            }
          }
        }
        break;
      }
    }

    const target = snippet ? findTarget(snippet, blocks) : null;
    const bodyHtml = md.renderer.render(inner, md.options, {});
    notes.push({ target, snippet, html: bodyHtml });

    i = end;
  }
  return notes;
}

/** Find the source block whose normalized text contains the snippet. */
function findTarget(snippet, blocks) {
  const needle = normalize(snippet);
  if (!needle) return null;
  // Prefer the first block that contains the full snippet.
  for (const b of blocks) {
    if (b.normalizedText.includes(needle)) return b.anchor;
  }
  return null;
}

async function readIfExists(p) {
  try { return await fs.readFile(p, 'utf8'); } catch { return null; }
}

async function listDocs() {
  const entries = await fs.readdir(CONTENT_DIR, { withFileTypes: true });
  return entries
    .filter(e => e.isFile() && e.name.endsWith('.md')
      && !e.name.endsWith('.notes.md')
      && !e.name.endsWith('.analysis.md'))
    .map(e => e.name.replace(/\.md$/, ''))
    .sort();
}

const app = express();
app.use('/static', express.static(path.join(__dirname, 'public')));

app.get('/', async (_req, res) => {
  try {
    const docs = await listDocs();
    const items = docs.map(n => `<li><a href="/view/${encodeURIComponent(n)}">${n}</a></li>`).join('\n');
    res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Annotated docs</title>
<link rel="stylesheet" href="/static/viewer.css"></head>
<body class="index"><h1>Documents</h1><p><code>${CONTENT_DIR}</code></p>
<ul>${items || '<li><em>No .md files found</em></li>'}</ul></body></html>`);
  } catch (err) {
    res.status(500).type('text').send(String(err));
  }
});

app.get('/api/doc/:name', async (req, res) => {
  const name = req.params.name;
  const docPath = path.join(CONTENT_DIR, name + '.md');
  const notesPath = path.join(CONTENT_DIR, name + '.notes.md');
  const docSrc = await readIfExists(docPath);
  if (docSrc == null) return res.status(404).json({ error: 'doc not found' });
  const analysisPath = path.join(CONTENT_DIR, name + '.analysis.md');
  const notesSrc = (await readIfExists(notesPath)) || '';
  const analysisSrc = (await readIfExists(analysisPath)) || '';
  const { html: docHtml, blocks } = renderDoc(docSrc);
  res.json({
    name,
    docHtml,
    notes: renderNotes(notesSrc, blocks),
    analysisHtml: analysisSrc ? md.render(analysisSrc) : '',
  });
});

app.get('/view/:name', (req, res) => {
  const name = req.params.name;
  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>${name}</title>
<link rel="stylesheet" href="/static/viewer.css"></head>
<body class="viewer">
<header><a href="/">&larr; index</a> <strong>${name}</strong></header>
<main>
  <article id="doc"></article>
  <aside id="notes" class="annot-col"></aside>
  <aside id="analysis"></aside>
</main>
<script>window.DOC_NAME = ${JSON.stringify(name)};</script>
<script type="module" src="/static/viewer.js"></script>
</body></html>`);
});

app.listen(PORT, () => {
  console.log(`Serving ${CONTENT_DIR} on http://localhost:${PORT}`);
});
