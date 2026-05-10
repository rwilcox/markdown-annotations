// Two-pane annotated markdown viewer.
// Fetches doc + notes JSON, mounts them, then lays notes out so each one
// sits at the same Y as its target paragraph (cascading down to avoid overlap).

const docEl = document.getElementById('doc');
const notesEl = document.getElementById('notes');
const analysisEl = document.getElementById('analysis');
const NOTE_GAP = 8; // px between stacked notes

// Latest data from the server, kept so the editor can populate its textarea
// without needing a second fetch.
let latest = { notesSrc: '', analysisSrc: '' };
// Track which columns are currently in edit mode so a refresh leaves them alone.
const editing = { notes: false, analysis: false };

async function load() {
  const res = await fetch(`/api/doc/${encodeURIComponent(window.DOC_NAME)}`);
  if (!res.ok) {
    docEl.innerHTML = `<p style="color:red">Failed to load: ${res.status}</p>`;
    return;
  }
  const data = await res.json();
  latest = data;

  docEl.innerHTML = data.docHtml;

  if (!editing.notes) {
    mountNotes(notesEl, data.notes);
    const countEl = document.getElementById('notes-count');
    if (countEl) countEl.textContent = `(${data.notes.length})`;
  }
  if (!editing.analysis) {
    analysisEl.innerHTML = data.analysisHtml || '';
  }

  mountToc(data.tocHtml || '');

  // Wait for fonts/images to settle before measuring.
  await document.fonts?.ready;
  if (!editing.notes) layoutColumn(notesEl);
  wireInteractions();
}

function mountNotes(container, notes) {
  container.innerHTML = '';
  for (const note of notes) {
    const el = document.createElement('div');
    el.className = 'note';
    el.dataset.target = note.target || '';
    if (!note.target || !docEl.querySelector(`[data-anchor="${note.target}"]`)) {
      el.classList.add('orphan');
    }
    const quote = `<div class="note-quote">${note.quoteHtml || ''}</div>`;
    const commentary = note.commentaryHtml
      ? `<div class="note-commentary">${note.commentaryHtml}</div>`
      : '';
    el.innerHTML = quote + commentary;
    container.appendChild(el);
  }
}

function layoutColumn(container) {
  const colRect = container.getBoundingClientRect();
  const noteEls = [...container.querySelectorAll('.note')];
  const placements = noteEls.map(el => {
    const targetId = el.dataset.target;
    const target = targetId && docEl.querySelector(`[data-anchor="${targetId}"]`);
    const desired = target
      ? target.getBoundingClientRect().top - colRect.top
      : el.offsetTop;
    return { el, desired };
  });
  placements.sort((a, b) => a.desired - b.desired);

  let cursor = 0;
  for (const p of placements) {
    const top = Math.max(p.desired, cursor);
    p.el.style.top = `${top}px`;
    cursor = top + p.el.offsetHeight + NOTE_GAP;
  }
  container.style.minHeight = `${cursor}px`;
}

function wireInteractions() {
  for (const note of notesEl.querySelectorAll('.note')) {
    const target = note.dataset.target
      ? docEl.querySelector(`[data-anchor="${note.dataset.target}"]`)
      : null;
    if (!target) continue;

    const activate = () => {
      note.classList.add('is-active');
      target.classList.add('is-hovered');
    };
    const deactivate = () => {
      note.classList.remove('is-active');
      target.classList.remove('is-hovered');
    };
    note.addEventListener('mouseenter', activate);
    note.addEventListener('mouseleave', deactivate);
    target.addEventListener('mouseenter', activate);
    target.addEventListener('mouseleave', deactivate);
    note.addEventListener('click', () => {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  let resizeRaf = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      if (!editing.notes) layoutColumn(notesEl);
    });
  });
}

// --- editing -----------------------------------------------------------

function enterEditMode(kind) {
  if (editing[kind]) return;
  editing[kind] = true;
  const container = kind === 'notes' ? notesEl : analysisEl;
  const src = kind === 'notes' ? (latest.notesSrc || '') : (latest.analysisSrc || '');

  container.classList.add('is-editing');
  container.innerHTML = '';
  // layoutColumn() sets an inline min-height equal to the cumulative cascade
  // height of the note cards. Clear it so the CSS min-height: 100% wins.
  container.style.minHeight = '';

  // Inner sticky wrapper — its containing block is the (tall) grid cell, so
  // it stays pinned to the viewport for the entire doc-column scroll height.
  const sticky = document.createElement('div');
  sticky.className = 'editor-sticky';
  container.appendChild(sticky);

  const ta = document.createElement('textarea');
  ta.className = 'editor-textarea';
  ta.value = src;
  sticky.appendChild(ta);

  // Autosize the textarea to its content so it's exactly as tall as needed.
  // The sticky parent caps it at viewport height and scrolls if it overflows.
  const autosize = () => {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  };
  ta.addEventListener('input', autosize);

  const bar = document.createElement('div');
  bar.className = 'editor-bar';
  const save = document.createElement('button');
  save.type = 'button';
  save.textContent = 'save';
  save.className = 'btn-save';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'cancel';
  cancel.className = 'btn-cancel';
  const status = document.createElement('span');
  status.className = 'editor-status';
  bar.append(save, cancel, status);
  sticky.appendChild(bar);

  setEditButton(kind, true);
  ta.focus();
  autosize();

  save.addEventListener('click', async () => {
    save.disabled = cancel.disabled = true;
    status.textContent = 'saving…';
    try {
      const res = await fetch(
        `/api/doc/${encodeURIComponent(window.DOC_NAME)}/${kind}`,
        { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: ta.value }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Update our cached source so the editor would re-open with current text
      // if we stayed editing — but we exit edit mode and refresh the view.
      if (kind === 'notes') latest.notesSrc = ta.value;
      else latest.analysisSrc = ta.value;
      exitEditMode(kind);
      await load();
    } catch (err) {
      status.textContent = `error: ${err.message}`;
      save.disabled = cancel.disabled = false;
    }
  });

  cancel.addEventListener('click', async () => {
    exitEditMode(kind);
    await load();
  });
}

function exitEditMode(kind) {
  editing[kind] = false;
  const container = kind === 'notes' ? notesEl : analysisEl;
  container.classList.remove('is-editing');
  container.innerHTML = '';
  setEditButton(kind, false);
}

function setEditButton(kind, isEditing) {
  const btn = document.querySelector(`.edit-btn[data-edit="${kind}"]`);
  if (btn) btn.textContent = isEditing ? 'editing…' : 'edit';
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.edit-btn');
  if (!btn) return;
  const kind = btn.dataset.edit;
  if (editing[kind]) return; // already editing; ignore
  enterEditMode(kind);
});

// --- Ask the LLM ------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

const askForm = document.getElementById('ask-form');
const askInput = document.getElementById('ask-input');
const askSend = document.getElementById('ask-send');
const askAppend = document.getElementById('ask-append');
const askLog = document.getElementById('ask-log');

console.log('[ask] init', { askForm, askInput, askSend, askAppend, askLog });

function appendTurn(kind, html) {
  const el = document.createElement('div');
  el.className = `ask-turn ${kind}`;
  el.innerHTML = `<div class="who">${kind === 'q' ? 'you' : kind === 'a' ? 'llm' : kind === 'note' ? 'note' : 'error'}</div>` +
                 `<div class="body">${html}</div>`;
  askLog.appendChild(el);
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return el;
}

async function submitAsk({ noLlm }) {
  const question = askInput.value.trim();
  console.log('[ask] submit', { question, noLlm });
  if (!question) return;

  appendTurn('q', `<p>${escapeHtml(question)}</p>`);
  askInput.value = '';
  askSend.disabled = true;
  if (askAppend) askAppend.disabled = true;
  askInput.disabled = true;
  const pending = appendTurn(noLlm ? 'note' : 'a',
    noLlm ? '<p><em>appending…</em></p>' : '<p><em>thinking…</em></p>');

  try {
    console.log('[ask] POST /api/doc/' + window.DOC_NAME + '/ask');
    const res = await fetch(
      `/api/doc/${encodeURIComponent(window.DOC_NAME)}/ask`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, noLlm }),
      }
    );
    console.log('[ask] response status', res.status);
    const data = await res.json();
    console.log('[ask] response body', data);
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (noLlm) {
      pending.querySelector('.body').innerHTML = '<p><em>appended (no LLM call)</em></p>';
    } else {
      pending.querySelector('.body').innerHTML = data.answerHtml || `<p>${escapeHtml(data.answer || '')}</p>`;
    }
    // The server appended the exchange to the source doc — refresh so the
    // user sees it (and the notes column re-aligns to the new content).
    await load();
    // Add a deep-link to the freshly-appended block in the document.
    if (data.answerAnchor) {
      const link = document.createElement('a');
      link.href = '#';
      link.className = 'jump-link';
      link.textContent = '↑ open in document';
      link.addEventListener('click', (ev) => {
        ev.preventDefault();
        const target = docEl.querySelector(`[data-anchor="${data.answerAnchor}"]`);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.classList.add('flash');
          setTimeout(() => target.classList.remove('flash'), 1500);
        }
      });
      pending.appendChild(link);
    }
  } catch (err) {
    console.error('[ask] error', err);
    pending.classList.remove('a', 'note');
    pending.classList.add('error');
    pending.querySelector('.who').textContent = 'error';
    pending.querySelector('.body').innerHTML = `<p>${escapeHtml(err.message)}</p>`;
  } finally {
    askSend.disabled = false;
    if (askAppend) askAppend.disabled = false;
    askInput.disabled = false;
    askInput.focus();
  }
}

if (askForm) {
  askForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitAsk({ noLlm: false });
  });

  if (askAppend) {
    askAppend.addEventListener('click', () => submitAsk({ noLlm: true }));
  }

  // Cmd/Ctrl+Enter submits (with LLM); Cmd/Ctrl+Shift+Enter appends only.
  askInput.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submitAsk({ noLlm: e.shiftKey });
    }
  });
} else {
  console.warn('[ask] #ask-form not found in DOM');
}

// --- Table of contents ------------------------------------------------

const tocEl = document.getElementById('toc');
const tocDisclosure = document.getElementById('toc-disclosure');
const tocFilter = document.getElementById('toc-filter');

function mountToc(html) {
  if (!tocEl) return;
  tocEl.innerHTML = html;
  // If there's no ToC for this doc, hide the disclosure entirely.
  if (tocDisclosure) tocDisclosure.style.display = html ? '' : 'none';
}

if (tocEl) {
  tocEl.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-target]');
    if (!li) return;
    const target = docEl.querySelector(`[data-anchor="${li.dataset.target}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.classList.add('flash');
    setTimeout(() => target.classList.remove('flash'), 1500);
    if (tocDisclosure) tocDisclosure.open = false;
  });
}

if (tocFilter) {
  tocFilter.addEventListener('input', () => {
    const q = tocFilter.value.trim().toLowerCase();
    for (const li of tocEl.querySelectorAll('li')) {
      // Match against just this item's own label, not its nested children.
      const own = li.cloneNode(true);
      own.querySelectorAll('ul, ol').forEach(n => n.remove());
      const ownText = own.textContent.toLowerCase();
      const descendantHit = !!li.querySelector('li[data-target]') &&
        Array.from(li.querySelectorAll('li')).some(d => {
          const c = d.cloneNode(true);
          c.querySelectorAll('ul, ol').forEach(n => n.remove());
          return c.textContent.toLowerCase().includes(q);
        });
      const hit = !q || ownText.includes(q) || descendantHit;
      li.classList.toggle('toc-hidden', !hit);
    }
  });
  if (tocDisclosure) {
    tocDisclosure.addEventListener('toggle', () => {
      if (tocDisclosure.open) tocFilter.focus();
    });
  }
}

load();
