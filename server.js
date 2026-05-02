import express from 'express';
import MarkdownIt from 'markdown-it';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { askLLM } from './llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Content directory resolution (in priority order):
 *   1. --content-dir <path>  CLI flag
 *   2. CONTENT_DIR           env var
 *   3. ~/Documents/markdown_analysis  (default)
 *
 * A leading `~` in any of those is expanded to the user's home directory.
 */
function resolveContentDir() {
  const args = process.argv.slice(2);
  let cli = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--content-dir' && args[i + 1]) cli = args[i + 1];
    else if (args[i].startsWith('--content-dir=')) cli = args[i].slice('--content-dir='.length);
  }
  const raw = cli || process.env.CONTENT_DIR || path.join(os.homedir(), 'Documents', 'markdown_analysis');
  const expanded = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
  return path.resolve(expanded);
}

const CONTENT_DIR = resolveContentDir();
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
 * Parse the notes file. Each top-level blockquote starts a new note: the
 * blockquote text IS the quoted snippet from the source. Any plain
 * paragraphs that follow (until the next blockquote or heading) are the
 * user's commentary on that quote, rendered together in the same card.
 */
function renderNotes(source, blocks) {
  const tokens = md.parse(source, {});
  const notes = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.level !== 0 || t.type !== 'blockquote_open') { i++; continue; }

    // Find matching blockquote_close.
    let depth = 1;
    let bqEnd = i;
    for (let j = i + 1; j < tokens.length; j++) {
      if (tokens[j].type === 'blockquote_open') depth++;
      else if (tokens[j].type === 'blockquote_close') {
        depth--;
        if (depth === 0) { bqEnd = j; break; }
      }
    }
    const quoteTokens = tokens.slice(i, bqEnd + 1);

    // Plain text of the blockquote — used to match against source blocks.
    let snippetText = '';
    for (const tt of quoteTokens) {
      if (tt.type === 'inline') snippetText += ' ' + tt.content;
    }
    snippetText = snippetText.trim();

    // Collect following commentary tokens up to the next blockquote/heading.
    let cEnd = bqEnd;
    let k = bqEnd + 1;
    while (k < tokens.length) {
      const tk = tokens[k];
      if (tk.level === 0 && (tk.type === 'blockquote_open' || tk.type === 'heading_open')) break;
      cEnd = k;
      k++;
    }
    const commentaryTokens = tokens.slice(bqEnd + 1, cEnd + 1);

    notes.push({
      target: findTarget(snippetText, blocks),
      snippet: snippetText,
      quoteHtml: md.renderer.render(quoteTokens, md.options, {}),
      commentaryHtml: md.renderer.render(commentaryTokens, md.options, {}),
    });

    i = cEnd + 1;
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
    notesSrc,
    analysisHtml: analysisSrc ? md.render(analysisSrc) : '',
    analysisSrc,
  });
});

/**
 * Save edits made in the browser back to disk.
 * `kind` must be `notes` or `analysis` — we never let the client write the
 * source `.md` itself, and the resolved file path is required to live
 * inside CONTENT_DIR (no traversal).
 */
app.put('/api/doc/:name/:kind', express.text({ type: '*/*', limit: '5mb' }), async (req, res) => {
  const { name, kind } = req.params;
  if (kind !== 'notes' && kind !== 'analysis') {
    return res.status(400).json({ error: 'kind must be "notes" or "analysis"' });
  }
  const filename = `${name}.${kind}.md`;
  const target = path.resolve(CONTENT_DIR, filename);
  if (path.dirname(target) !== CONTENT_DIR) {
    return res.status(400).json({ error: 'invalid path' });
  }
  // Require the source doc to exist — don't let arbitrary names be created.
  const docExists = await readIfExists(path.join(CONTENT_DIR, name + '.md'));
  if (docExists == null) return res.status(404).json({ error: 'doc not found' });
  try {
    await fs.writeFile(target, req.body ?? '', 'utf8');
    res.json({ ok: true, path: target });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/**
 * Ask the LLM a question about the source document. The question is
 * appended to the doc text and sent on stdin to the `llm` CLI.
 */
app.post('/api/doc/:name/ask', express.json({ limit: '1mb' }), async (req, res) => {
  const name = req.params.name;
  const question = (req.body?.question || '').trim();
  if (!question) return res.status(400).json({ error: 'question is required' });

  const docPath = path.join(CONTENT_DIR, name + '.md');
  const docSrc = await readIfExists(docPath);
  if (docSrc == null) return res.status(404).json({ error: 'doc not found' });

  try {
    const answer = await askLLM({ docSource: docSrc, question });
    // Append the exchange to the source document so the conversation lives
    // alongside the file itself.
    const sep = docSrc.endsWith('\n') ? '' : '\n';
    const transcript = `${sep}\n---\n\nUser: ${question}\n\n---\n\nLLM: ${answer}\n`;
    await fs.appendFile(docPath, transcript, 'utf8');

    // Re-parse the whole doc to find the anchor of the freshly-appended LLM
    // block, so the client can deep-link straight to it.
    const updated = await fs.readFile(docPath, 'utf8');
    const { blocks: updatedBlocks } = renderDoc(updated);
    const llmBlock = [...updatedBlocks].reverse().find(b =>
      b.normalizedText.startsWith('llm:')
    );

    res.json({
      answer,
      answerHtml: md.render(answer),
      answerAnchor: llmBlock ? llmBlock.anchor : null,
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/view/:name', (req, res) => {
  const name = req.params.name;
  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>${name}</title>
<link rel="stylesheet" href="/static/viewer.css"></head>
<body class="viewer">
<header><a href="/">&larr; index</a> <strong>${name}</strong></header>
<main>
  <h2 class="col-header h-doc">Document</h2>
  <h2 class="col-header h-notes">
    Notes <span id="notes-count" class="count"></span>
    <button class="edit-btn" data-edit="notes" type="button">edit</button>
  </h2>
  <h2 class="col-header h-analysis">
    Analysis
    <button class="edit-btn" data-edit="analysis" type="button">edit</button>
  </h2>
  <article id="doc"></article>
  <aside id="notes" class="annot-col"></aside>
  <aside id="analysis"></aside>
</main>
<section id="ask">
  <h2 class="col-header">Ask the LLM</h2>
  <div id="ask-log"></div>
  <form id="ask-form">
    <textarea id="ask-input" rows="2" placeholder="Ask a question about this document…"></textarea>
    <button type="submit" id="ask-send">ask</button>
  </form>
</section>
<script>window.DOC_NAME = ${JSON.stringify(name)};</script>
<script type="module" src="/static/viewer.js"></script>
</body></html>`);
});

app.listen(PORT, async () => {
  try {
    await fs.mkdir(CONTENT_DIR, { recursive: true });
  } catch (err) {
    console.error(`Could not create content dir ${CONTENT_DIR}:`, err.message);
  }
  console.log(`Serving ${CONTENT_DIR} on http://localhost:${PORT}`);
  console.log('  override with --content-dir <path> or CONTENT_DIR env var');
});
