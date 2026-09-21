/* PolicyPilot front end: chat, agent trace, and document upload. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const chat = $('chat');
  const form = $('chatForm');
  const question = $('question');
  const sendBtn = $('sendBtn');
  const trace = $('trace');
  const sourceUsed = $('sourceUsed');
  const sourceBox = $('sourceBox');
  const modal = $('uploadModal');
  const uploadBtn = $('uploadBtn');
  const uploadStatus = $('uploadStatus');

  const scrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';

  let busy = false;
  let lastOpener = null;

  /* ---------- Source labels and colors ---------- */
  const SOURCES = {
    private_kb: { label: 'Company HR documents', tone: 'kb' },
    web_search: { label: 'Public web', tone: 'web' },
    web: { label: 'Public web', tone: 'web' },
    direct: { label: 'Direct reply', tone: 'direct' },
    insufficient_evidence: { label: 'Not enough evidence', tone: 'none' },
    error: { label: 'Request failed', tone: 'error' },
  };
  const sourceMeta = (key) => SOURCES[key] || { label: key || '—', tone: 'none' };

  /* ---------- Text helpers ---------- */
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escapeHtml = (s = '') => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
  const plainToHtml = (s = '') => escapeHtml(s).replace(/\n/g, '<br>');

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (e) {
      return '';
    }
  }

  function errorDetail(data, res) {
    const detail = data && data.detail;
    if (typeof detail === 'string') return detail;
    if (detail) return JSON.stringify(detail);
    return `Request failed (${res.status})`;
  }

  /* ---------- Markdown (sanitized) ---------- */
  const canRenderMarkdown = typeof window.marked !== 'undefined' && typeof window.DOMPurify !== 'undefined';

  if (canRenderMarkdown) {
    window.marked.setOptions({ gfm: true, breaks: true });
    window.DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
  }

  function renderMarkdown(text = '') {
    if (!canRenderMarkdown) return plainToHtml(text);
    const clean = window.DOMPurify.sanitize(window.marked.parse(text));
    const tpl = document.createElement('template');
    tpl.innerHTML = clean;
    // Wide tables scroll inside their own container instead of breaking the layout.
    tpl.content.querySelectorAll('table').forEach((table) => {
      const wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      table.replaceWith(wrap);
      wrap.appendChild(table);
    });
    return tpl.innerHTML;
  }

  /* ---------- Chat rendering ---------- */
  function removeWelcome() {
    const welcome = $('welcome');
    if (welcome) welcome.remove();
  }

  function sourcesHtml(citations = []) {
    if (!citations.length) return '';
    const items = citations
      .map((c, i) => {
        const title = escapeHtml(c.title || c.url || 'Source');
        const num = `<span class="source-num" aria-hidden="true">${i + 1}</span>`;
        if (c.url && /^https?:\/\//i.test(c.url)) {
          const host = escapeHtml(hostOf(c.url));
          return `<li><a class="source" href="${escapeHtml(c.url)}" target="_blank" rel="noopener noreferrer" title="${title}">${num}<span class="source-text"><span class="source-title">${title}</span><span class="source-host">${host}</span></span></a></li>`;
        }
        return `<li><div class="source" title="${title}">${num}<span class="source-text"><span class="source-title">${title}</span><span class="source-host">Company document</span></span></div></li>`;
      })
      .join('');
    return `<footer class="sources">
      <h3 class="sources-title">Sources <span class="sources-count">${citations.length}</span></h3>
      <ol class="source-grid">${items}</ol>
    </footer>`;
  }

  function addMessage(role, text, source = '', citations = []) {
    removeWelcome();
    const wrap = document.createElement('div');

    if (role === 'user') {
      wrap.className = 'message user';
      wrap.innerHTML = `<div class="bubble"><p>${plainToHtml(text)}</p></div>`;
      chat.appendChild(wrap);
      chat.scrollTo({ top: chat.scrollHeight, behavior: scrollBehavior });
      return wrap;
    }

    const meta = sourceMeta(source);
    wrap.className = `message assistant tone-${meta.tone}`;
    wrap.innerHTML = `
      <article class="card">
        <header class="card-head">
          <span class="avatar" aria-hidden="true">PP</span>
          <span class="card-name">PolicyPilot</span>
          ${source ? `<span class="badge">${escapeHtml(meta.label)}</span>` : ''}
        </header>
        <div class="card-body"><div class="prose">${renderMarkdown(text)}</div></div>
        ${sourcesHtml(citations)}
      </article>`;
    chat.appendChild(wrap);
    // Start at the top of the answer so long answers are read from the beginning.
    wrap.scrollIntoView({ behavior: scrollBehavior, block: 'start' });
    return wrap;
  }

  function addTyping() {
    const el = document.createElement('div');
    el.className = 'message assistant tone-none';
    el.innerHTML = `
      <div class="card">
        <div class="typing-wrap">
          <span class="typing" aria-hidden="true"><i></i><i></i><i></i></span>
          <span class="typing-label">Working on it</span>
        </div>
      </div>`;
    chat.appendChild(el);
    chat.scrollTo({ top: chat.scrollHeight, behavior: scrollBehavior });
    return el;
  }

  /* ---------- Agent trace ---------- */
  function renderTrace(items = []) {
    if (!items.length) {
      trace.innerHTML = '<li class="trace-empty">Ask a question to see the steps here.</li>';
      return;
    }
    trace.innerHTML = items
      .map((item) => {
        const [label, ...rest] = String(item).split(' → ');
        const value = rest.join(' → ');
        const tone = /^good$/i.test(value) ? 'good' : /^weak$/i.test(value) ? 'weak' : '';
        return `<li class="trace-step ${tone}">
          <span class="trace-dot" aria-hidden="true"></span>
          <div>
            <div class="trace-label">${escapeHtml(label)}</div>
            ${value ? `<div class="trace-value">${escapeHtml(value)}</div>` : ''}
          </div>
        </li>`;
      })
      .join('');
  }

  function renderPendingTrace() {
    trace.innerHTML = `<li class="trace-step pending">
      <span class="trace-dot" aria-hidden="true"></span>
      <div><div class="trace-label">Working on your question</div></div>
    </li>`;
  }

  function setSourceBox(label, tone) {
    sourceUsed.textContent = label;
    sourceBox.dataset.tone = tone;
  }
  function setSource(key) {
    const meta = sourceMeta(key);
    setSourceBox(meta.label, meta.tone);
  }

  /* ---------- Ask the agent ---------- */
  function setBusy(value) {
    busy = value;
    sendBtn.disabled = value;
    form.setAttribute('aria-busy', String(value));
  }

  function autosize() {
    question.style.height = 'auto';
    question.style.height = `${Math.min(question.scrollHeight, 160)}px`;
  }

  async function askAgent(q) {
    if (busy) return;
    addMessage('user', q);
    question.value = '';
    autosize();
    setBusy(true);
    renderPendingTrace();
    setSourceBox('Working…', 'pending');
    const typing = addTyping();

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(errorDetail(data, res));

      typing.remove();
      addMessage('assistant', data.answer, data.source_used, data.citations || []);
      renderTrace(data.trace || []);
      setSource(data.source_used);
    } catch (e) {
      typing.remove();
      addMessage('assistant', `Couldn't get an answer: ${e.message}. Check that the server is running, then try again.`, 'error');
      renderTrace(['Request → failed']);
      setSource('error');
    } finally {
      setBusy(false);
      question.focus();
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = question.value.trim();
    if (q) askAgent(q);
  });

  question.addEventListener('input', autosize);
  question.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (form.requestSubmit) form.requestSubmit();
      else form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    }
  });

  document.querySelectorAll('.example').forEach((btn) => {
    btn.addEventListener('click', () => askAgent(btn.textContent.trim()));
  });

  /* ---------- Trace drawer (smaller screens) ---------- */
  const openTrace = () => document.body.classList.add('trace-open');
  const closeTrace = () => document.body.classList.remove('trace-open');
  $('openTrace').addEventListener('click', openTrace);
  $('closeTrace').addEventListener('click', closeTrace);
  $('scrim').addEventListener('click', closeTrace);

  /* ---------- Upload dialog ---------- */
  function openModal(opener) {
    lastOpener = opener;
    modal.classList.remove('hidden');
    $('adminKey').focus();
  }
  function closeModal() {
    modal.classList.add('hidden');
    if (lastOpener) lastOpener.focus();
  }
  function setUploadStatus(message, state = '') {
    uploadStatus.textContent = message;
    uploadStatus.className = `upload-status${state ? ` is-${state}` : ''}`;
  }

  document.querySelectorAll('[data-open-upload]').forEach((btn) => {
    btn.addEventListener('click', () => openModal(btn));
  });
  $('closeUpload').addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!modal.classList.contains('hidden')) closeModal();
    else closeTrace();
  });

  uploadBtn.addEventListener('click', async () => {
    const fileInput = $('fileInput');
    const file = fileInput.files[0];
    const key = $('adminKey').value;
    if (!file) {
      setUploadStatus('Choose a file first.', 'error');
      return;
    }

    setUploadStatus('Indexing document…');
    uploadBtn.disabled = true;
    const fd = new FormData();
    fd.append('file', file);

    try {
      const res = await fetch('/api/ingest', { method: 'POST', headers: { 'X-Admin-Key': key }, body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(errorDetail(data, res));
      setUploadStatus(`Indexed ${data.file} in ${data.chunks} chunks.`, 'ok');
      fileInput.value = '';
    } catch (e) {
      setUploadStatus(`Upload failed: ${e.message}`, 'error');
    } finally {
      uploadBtn.disabled = false;
    }
  });

  /* ---------- Initial state ---------- */
  renderTrace([]);
  setSourceBox('—', 'none');
  autosize();
})();