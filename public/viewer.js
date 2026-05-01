// Two-pane annotated markdown viewer.
// Fetches doc + notes JSON, mounts them, then lays notes out so each one
// sits at the same Y as its target paragraph (cascading down to avoid overlap).

const docEl = document.getElementById('doc');
const notesEl = document.getElementById('notes');
const analysisEl = document.getElementById('analysis');
const NOTE_GAP = 8; // px between stacked notes

async function load() {
  const res = await fetch(`/api/doc/${encodeURIComponent(window.DOC_NAME)}`);
  if (!res.ok) {
    docEl.innerHTML = `<p style="color:red">Failed to load: ${res.status}</p>`;
    return;
  }
  const data = await res.json();
  docEl.innerHTML = data.docHtml;
  mountNotes(notesEl, data.notes);
  const countEl = document.getElementById('notes-count');
  if (countEl) countEl.textContent = `(${data.notes.length})`;
  analysisEl.innerHTML = data.analysisHtml || '';
  // Wait for fonts/images to settle before measuring.
  await document.fonts?.ready;
  layoutColumn(notesEl);
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
      : el.offsetTop; // orphan: leave wherever it lands
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
    resizeRaf = requestAnimationFrame(() => layoutColumn(notesEl));
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

load();
