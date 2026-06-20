/**
 * ai-tabs.js
 * Tab management, SSE streaming, quiz rendering, flashcard rendering,
 * upload modal wiring, and document deletion — zinc dark theme.
 */

(function () {

  // ── Tab switching ─────────────────────────────────────────────────────────
  const tabBtns     = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  function activateTab(name) {
    tabBtns.forEach(btn => {
      const active = btn.dataset.tab === name;
      btn.classList.toggle('active', active);
      btn.classList.toggle('text-zinc-500', !active);
    });
    tabContents.forEach(el => {
      const active = el.id === `tab-${name}`;
      el.classList.toggle('hidden', !active);
      el.classList.toggle('flex',   active);
    });
  }

  tabBtns.forEach(btn => btn.addEventListener('click', () => activateTab(btn.dataset.tab)));
  activateTab('chat');

  // ── Strip internal reasoning / thinking blocks before rendering ──────────
  // Removes <think>...</think>, <reasoning>...</reasoning>, and similar
  // raw chain-of-thought tags some models may emit, so only the clean
  // final answer ever reaches the chat bubble.
  function stripThinkingBlocks(text) {
    if (!text) return text;
    return text
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
      .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
      .replace(/\[THINKING\][\s\S]*?\[\/THINKING\]/gi, '');
  }

  // ── Markdown → HTML (safe simple renderer) ───────────────────────────────
  function renderMarkdown(md) {
    if (!md) return '';
    const clean = stripThinkingBlocks(md);
    let html = clean
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm,  '<h2>$1</h2>')
      .replace(/^# (.+)$/gm,   '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g,     '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/^[\-\*] (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>[\s\S]*?<\/li>)(\n<li>[\s\S]*?<\/li>)*/g, m => `<ul>${m}</ul>`)
      .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
      .replace(/\n{2,}/g, '</p><p>')
      .replace(/\n/g, '<br>');

    html = `<p>${html}</p>`;
    html = html.replace(/<p>\s*<\/p>/g, '');
    return html;
  }

  // ── Conversational context tracking ──────────────────────────────────────
  // Remembers the last highlighted snippet so follow-up chat messages typed
  // into the sticky input box (without a new highlight) stay grounded in it.
  let lastHighlightedContext = '';

  // ── Chat helpers ──────────────────────────────────────────────────────────
  function hideEmptyState() {
    const empty = document.getElementById('chatEmpty');
    if (empty) empty.style.display = 'none';
  }

  function appendUserBubble(text, action) {
    hideEmptyState();
    const msgs    = document.getElementById('chatMessages');
    const labels  = { explain: 'Explain', summarize: 'Summarize' };
    const label   = labels[action] || 'Ask';
    const preview = text.length > 140 ? text.slice(0, 140) + '…' : text;

    const div = document.createElement('div');
    div.className = 'msg-user';
    div.innerHTML = `
      <p class="text-[9px] text-violet-400 mb-1 font-semibold uppercase tracking-wider">${label}</p>
      <p class="text-[11px] text-zinc-400 leading-relaxed">${preview.replace(/</g,'&lt;')}</p>
    `;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function createAiBubble() {
    const msgs = document.getElementById('chatMessages');
    const div  = document.createElement('div');
    div.innerHTML = `
      <div class="flex items-center gap-1.5 mb-2">
        <div class="w-4 h-4 rounded bg-violet-600 flex items-center justify-center flex-shrink-0">
          <svg class="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M9.663 17h4.673M12 3v1m6.364 1.636-.707.707M21 12h-1M4 12H3
                 m3.343-5.657-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547
                 A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531
                 c0-.895-.356-1.754-.988-2.386l-.548-.547z"/>
          </svg>
        </div>
        <span class="text-[9px] text-zinc-600 font-medium uppercase tracking-wider">StudyMind</span>
      </div>
      <div class="msg-ai-content pl-5"></div>
    `;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
    return div.querySelector('.msg-ai-content');
  }

  // ── EXPLAIN / SUMMARIZE — SSE streaming ──────────────────────────────────
  async function triggerExplain(text, action = 'explain') {
    activateTab('chat');
    appendUserBubble(text, action);

    // Remember this snippet so a follow-up typed question (without a new
    // highlight) can still be answered relative to it.
    lastHighlightedContext = text;

    const indicator = document.getElementById('streamingIndicator');
    indicator.classList.remove('hidden');

    const aiBox = createAiBubble();
    const msgs  = document.getElementById('chatMessages');
    let rawText = '';
    let errored = false;

    try {
      const resp = await fetch('/api/ai/explain', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text, documentId: DOCUMENT_ID, mode: action }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
        throw new Error(err.error || `Server error ${resp.status}`);
      }

      const reader  = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const events = buffer.split('\n\n');
        buffer = events.pop();

        for (const event of events) {
          for (const line of event.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6).trim();
            if (!payload) continue;

            let parsed;
            try { parsed = JSON.parse(payload); } catch { continue; }

            if (parsed.error) {
              aiBox.innerHTML = `<p class="text-red-400">⚠ ${parsed.error}</p>`;
              errored = true; break;
            }
            if (parsed.chunk) {
              rawText += parsed.chunk;
              aiBox.innerHTML = renderMarkdown(rawText);
              msgs.scrollTop  = msgs.scrollHeight;
            }
            if (parsed.done) indicator.classList.add('hidden');
          }
          if (errored) break;
        }
        if (errored) break;
      }
    } catch (err) {
      console.error('Explain error:', err);
      aiBox.innerHTML = `<p class="text-red-400 text-xs">⚠ ${err.message}</p>`;
    } finally {
      indicator.classList.add('hidden');
    }
  }

  // ── CONTINUOUS CHAT — sticky input box, multi-turn, document-aware ──────
  async function triggerChatMessage(message) {
    if (!message || !message.trim()) return;

    activateTab('chat');
    appendUserBubble(message, 'ask');

    const indicator = document.getElementById('streamingIndicator');
    indicator.classList.remove('hidden');

    const aiBox = createAiBubble();
    const msgs  = document.getElementById('chatMessages');
    let rawText = '';
    let errored = false;

    try {
      const resp = await fetch('/api/ai/chat', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          message,
          documentId: DOCUMENT_ID,
          // CONTEXTUAL AWARENESS: pass along the last highlighted snippet,
          // if any, so the backend can ground the answer in it. If empty,
          // the backend falls back to GLOBAL FILE AWARENESS automatically.
          highlightedContext: lastHighlightedContext,
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
        throw new Error(err.error || `Server error ${resp.status}`);
      }

      const reader  = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const events = buffer.split('\n\n');
        buffer = events.pop();

        for (const event of events) {
          for (const line of event.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6).trim();
            if (!payload) continue;

            let parsed;
            try { parsed = JSON.parse(payload); } catch { continue; }

            if (parsed.error) {
              aiBox.innerHTML = `<p class="text-red-400">⚠ ${parsed.error}</p>`;
              errored = true; break;
            }
            if (parsed.chunk) {
              rawText += parsed.chunk;
              aiBox.innerHTML = renderMarkdown(rawText);
              msgs.scrollTop  = msgs.scrollHeight;
            }
            if (parsed.done) indicator.classList.add('hidden');
          }
          if (errored) break;
        }
        if (errored) break;
      }
    } catch (err) {
      console.error('Chat error:', err);
      aiBox.innerHTML = `<p class="text-red-400 text-xs">⚠ ${err.message}</p>`;
    } finally {
      indicator.classList.add('hidden');
    }
  }

  // ── QUIZ ─────────────────────────────────────────────────────────────────
  async function triggerQuiz(text, action = 'quiz') {
    activateTab('quiz');

    const loading   = document.getElementById('quizLoading');
    const empty     = document.getElementById('quizEmpty');
    const container = document.getElementById('quizQuestions');

    empty.style.display   = 'none';
    container.innerHTML   = '';
    loading.style.display = 'flex';

    try {
      const resp = await fetch('/api/ai/quiz', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text, documentId: DOCUMENT_ID, mode: action }),
      });
      const data = await resp.json();
      if (!resp.ok || !Array.isArray(data.quiz)) throw new Error(data.error || 'Invalid response');

      loading.style.display = 'none';
      renderQuiz(data.quiz, container);
    } catch (err) {
      console.error('Quiz error:', err);
      loading.style.display = 'none';
      container.innerHTML   = `<p class="text-red-400 text-xs p-2">⚠ ${err.message}</p>`;
    }
  }

  function renderQuiz(quiz, container) {
    quiz.forEach((q, i) => {
      const card = document.createElement('div');
      card.className = 'bg-zinc-900/60 border border-zinc-800 rounded-xl p-3.5';
      card.innerHTML = `
        <p class="text-[9px] font-semibold text-zinc-600 mb-1 uppercase tracking-wider">Question ${i + 1}</p>
        <p class="text-[12.5px] text-white mb-3 leading-snug">${q.question.replace(/</g,'&lt;')}</p>
        <div class="space-y-1.5 options-group" data-correct="${q.correctAnswer.replace(/"/g,'&quot;').replace(/</g,'&lt;')}">
          ${q.options.map(opt => `
            <div class="quiz-option border border-zinc-800 rounded-lg px-3 py-2 text-[11px] text-zinc-400 flex items-center gap-2 select-none"
                 data-option="${opt.replace(/"/g,'&quot;').replace(/</g,'&lt;')}">
              <span class="w-3.5 h-3.5 rounded-full border border-zinc-700 flex-shrink-0 transition-all"></span>
              <span>${opt.replace(/</g,'&lt;')}</span>
            </div>
          `).join('')}
        </div>
        <div class="explanation hidden mt-3 p-2.5 bg-black/30 rounded-lg border-l-2 border-emerald-500">
          <p class="text-[9px] text-emerald-400 font-semibold mb-1 uppercase tracking-wider">Why this is correct</p>
          <p class="text-[11px] text-zinc-400 leading-relaxed">${q.explanation.replace(/</g,'&lt;')}</p>
        </div>
      `;

      card.querySelectorAll('.quiz-option').forEach(optEl => {
        optEl.addEventListener('click', () => {
          const group = optEl.closest('.options-group');
          if (group.classList.contains('answered')) return;
          group.classList.add('answered');

          const correct = group.dataset.correct;
          group.querySelectorAll('.quiz-option').forEach(o => {
            o.classList.add('answered');
            if (o.dataset.option === correct) {
              o.classList.add('correct');
              o.querySelector('span').style.background = '#10b981';
              o.querySelector('span').style.borderColor = '#10b981';
            } else if (o === optEl) {
              o.classList.add('incorrect');
              o.querySelector('span').style.background = '#ef4444';
              o.querySelector('span').style.borderColor = '#ef4444';
            }
          });
          card.querySelector('.explanation').classList.remove('hidden');
        });
      });

      container.appendChild(card);
    });
  }

  // ── FLASHCARDS ────────────────────────────────────────────────────────────
  async function triggerFlashcards(text) {
    activateTab('flashcards');

    const loading   = document.getElementById('flashcardsLoading');
    const empty     = document.getElementById('flashcardsEmpty');
    const container = document.getElementById('flashcardsList');

    empty.style.display   = 'none';
    container.innerHTML   = '';
    loading.style.display = 'flex';

    try {
      const resp = await fetch('/api/ai/flashcards', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text, documentId: DOCUMENT_ID }),
      });
      const data = await resp.json();
      if (!resp.ok || !Array.isArray(data.flashcards)) throw new Error(data.error || 'Invalid response');

      loading.style.display = 'none';
      renderFlashcards(data.flashcards, container);
    } catch (err) {
      console.error('Flashcards error:', err);
      loading.style.display = 'none';
      container.innerHTML   = `<p class="text-red-400 text-xs p-2">⚠ ${err.message}</p>`;
    }
  }

  function renderFlashcards(cards, container) {
    cards.forEach(card => {
      const wrapper = document.createElement('div');
      wrapper.className = 'flashcard-3d cursor-pointer';
      wrapper.innerHTML = `
        <div class="flashcard-inner">
          <div class="flashcard-face bg-zinc-900 border border-zinc-800 hover:border-amber-500/40 transition-colors">
            <div>
              <span class="text-[8.5px] uppercase tracking-widest font-semibold text-amber-400">Term</span>
              <p class="text-[12.5px] text-white mt-2 leading-snug">${card.front.replace(/</g,'&lt;')}</p>
            </div>
            <p class="text-[9.5px] text-zinc-600">Tap to reveal answer →</p>
          </div>
          <div class="flashcard-face flashcard-back-face bg-zinc-900 border border-emerald-500/25">
            <div>
              <span class="text-[8.5px] uppercase tracking-widest font-semibold text-emerald-400">Definition</span>
              <p class="text-[11px] text-zinc-400 mt-2 leading-relaxed">${card.back.replace(/</g,'&lt;')}</p>
            </div>
            <button class="save-btn text-[9.5px] font-medium bg-violet-600/15 hover:bg-violet-600 border border-violet-600/30 hover:border-violet-500 text-violet-300 hover:text-white px-2.5 py-1 rounded-md transition-all self-start"
              data-front="${card.front.replace(/"/g,'&quot;').replace(/</g,'&lt;')}"
              data-back="${card.back.replace(/"/g,'&quot;').replace(/</g,'&lt;')}">
              + Save to Deck
            </button>
          </div>
        </div>
      `;

      wrapper.addEventListener('click', e => {
        if (e.target.closest('.save-btn')) return;
        wrapper.classList.toggle('flipped');
      });

      wrapper.querySelector('.save-btn').addEventListener('click', async e => {
        e.stopPropagation();
        const btn = e.currentTarget;
        btn.textContent = 'Saving…';
        btn.disabled    = true;

        try {
          const r = await fetch('/api/ai/flashcards/save', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
              front:      btn.dataset.front,
              back:       btn.dataset.back,
              documentId: DOCUMENT_ID,
            }),
          });
          const d = await r.json();
          if (d.success) {
            btn.textContent = '✓ Saved!';
            btn.className   = btn.className.replace(/violet/g, 'emerald');
          } else {
            throw new Error(d.error);
          }
        } catch (err) {
          btn.textContent = '✗ Failed';
          btn.disabled    = false;
        }
      });

      container.appendChild(wrapper);
    });
  }

  // ── Upload modal wiring ───────────────────────────────────────────────────
  const uploadBtn       = document.getElementById('uploadBtn');
  const uploadModal     = document.getElementById('uploadModal');
  const cancelBtn        = document.getElementById('cancelUpload');
  const closeModalBtn    = document.getElementById('closeModal');
  const confirmBtn       = document.getElementById('confirmUpload');
  const fileInput        = document.getElementById('fileInput');
  const browseBtn        = document.getElementById('browseBtn');
  const dropZone         = document.getElementById('dropZone');
  const progressBar      = document.getElementById('progressBar');
  const uploadProgress   = document.getElementById('uploadProgress');
  const uploadFileName   = document.getElementById('uploadFileName');

  function openModal()  { uploadModal && uploadModal.classList.remove('hidden'); }
  function closeModal() { uploadModal && uploadModal.classList.add('hidden'); }

  if (uploadBtn)    uploadBtn.addEventListener('click', openModal);
  if (cancelBtn)    cancelBtn.addEventListener('click', closeModal);
  if (closeModalBtn) closeModalBtn.addEventListener('click', closeModal);
  if (browseBtn)    browseBtn.addEventListener('click', () => fileInput.click());
  if (dropZone)     dropZone.addEventListener('click',  () => fileInput.click());

  // Drag & drop support
  if (dropZone) {
    ['dragover', 'dragleave', 'drop'].forEach(evt => {
      dropZone.addEventListener(evt, e => e.preventDefault());
    });
    dropZone.addEventListener('drop', e => {
      const file = e.dataTransfer.files[0];
      if (file && fileInput) {
        fileInput.files = e.dataTransfer.files;
        fileInput.dispatchEvent(new Event('change'));
      }
    });
  }

  if (fileInput) {
    fileInput.addEventListener('change', () => {
      const f = fileInput.files[0];
      if (f && uploadFileName) {
        uploadFileName.textContent = f.name;
        uploadProgress && uploadProgress.classList.remove('hidden');
      }
    });
  }

  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      const f = fileInput && fileInput.files[0];
      if (!f) { alert('Please select a PDF file first.'); return; }

      const titleInput = document.getElementById('docTitle');
      const title       = (titleInput && titleInput.value) || f.name.replace('.pdf', '');
      const formData    = new FormData();
      formData.append('pdf', f);
      formData.append('title', title);

      confirmBtn.textContent = 'Uploading…';
      confirmBtn.disabled    = true;
      if (progressBar) progressBar.style.width = '60%';

      try {
        const r    = await fetch('/pdf/upload', { method: 'POST', body: formData });
        const data = await r.json();
        if (progressBar) progressBar.style.width = '100%';
        if (data.success) {
          window.location.href = `/pdf/${data.document._id}`;
        } else {
          alert(data.error || 'Upload failed.');
          confirmBtn.textContent = 'Upload';
          confirmBtn.disabled    = false;
        }
      } catch (e) {
        alert('Upload failed: ' + e.message);
        confirmBtn.textContent = 'Upload';
        confirmBtn.disabled    = false;
      }
    });
  }

  // ── Document deletion (sidebar) ─────────────────────────────────────────
  function showDeleteToast(msg) {
    const t = document.getElementById('deleteToast');
    const m = document.getElementById('deleteToastMsg');
    if (!t || !m) return;
    m.textContent = msg;
    t.classList.remove('hidden');
    setTimeout(() => t.classList.add('hidden'), 3000);
  }

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.delete-doc-btn');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();

    const docId = btn.dataset.id;
    if (!docId) return;

    if (!confirm('Delete this document and all its chats? This cannot be undone.')) return;

    try {
      const res  = await fetch(`/api/pdf/${docId}`, { method: 'DELETE' });
      const data = await res.json();

      if (data.success) {
        const item = btn.closest('.doc-item');
        if (item) item.remove();
        showDeleteToast('Document deleted.');

        if (typeof DOCUMENT_ID !== 'undefined' && DOCUMENT_ID === docId) {
          window.location.href = '/dashboard';
        }
      } else {
        alert(data.error || 'Delete failed.');
      }
    } catch (err) {
      alert('Delete failed: ' + err.message);
    }
  });

  // ── Sticky chat input box wiring ──────────────────────────────────────
  const chatInput   = document.getElementById('chatInput');
  const chatSendBtn = document.getElementById('chatSendBtn');

  function handleSend() {
    if (!chatInput) return;
    const value = chatInput.value.trim();
    if (!value) return;
    chatInput.value = '';
    chatInput.style.height = 'auto';
    triggerChatMessage(value);
  }

  if (chatSendBtn) chatSendBtn.addEventListener('click', handleSend);
  if (chatInput) {
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });
    // Auto-grow textarea up to a max height
    chatInput.addEventListener('input', () => {
      chatInput.style.height = 'auto';
      chatInput.style.height = Math.min(chatInput.scrollHeight, 96) + 'px';
    });
  }

  // ── Flashcard Deck modal (opened from sidebar "Flashcard Decks" tree) ────
  (function wireDeckModal() {
    const deckDataEl = document.getElementById('deckData');
    let decks = [];
    if (deckDataEl) {
      try {
        decks = JSON.parse(deckDataEl.textContent);
      } catch (err) {
        console.error('Failed to parse deck data — flashcard decks will be unavailable:', err);
        decks = [];
      }
    }

    const deckModal      = document.getElementById('deckModal');
    const deckModalTitle = document.getElementById('deckModalTitle');
    const deckModalGrid  = document.getElementById('deckModalGrid');
    const closeDeckModal = document.getElementById('closeDeckModal');

    if (!deckModal) return; // sidebar not present on this page

    function renderDeckCard(card) {
      const wrap = document.createElement('div');
      wrap.className = 'flashcard-3d cursor-pointer';
      wrap.onclick = (e) => {
        if (e.target.closest('.remove-deck-card')) return;
        wrap.classList.toggle('flipped');
      };
      wrap.innerHTML = `
        <div class="flashcard-inner">
          <div class="flashcard-face bg-zinc-800 border border-zinc-700 hover:border-amber-500/40 transition-colors">
            <div>
              <span class="text-[8.5px] uppercase tracking-widest font-semibold text-amber-400">Term</span>
              <p class="text-[12.5px] text-white mt-2 leading-snug">${card.front.replace(/</g,'&lt;')}</p>
            </div>
            <p class="text-[9.5px] text-zinc-600">Tap to flip</p>
          </div>
          <div class="flashcard-face flashcard-back-face bg-zinc-800/80 border border-emerald-500/25">
            <div>
              <span class="text-[8.5px] uppercase tracking-widest font-semibold text-emerald-400">Definition</span>
              <p class="text-[11px] text-zinc-300 mt-2 leading-relaxed">${card.back.replace(/</g,'&lt;')}</p>
            </div>
            <button type="button" class="remove-deck-card text-[9.5px] text-red-400/60 hover:text-red-400 transition-colors self-start" data-card-id="${card.id}">Remove</button>
          </div>
        </div>
      `;
      return wrap;
    }

    function openDeck(deckId) {
      const deck = decks.find(d => d.id === deckId);
      if (!deck) return;

      deckModalTitle.textContent = `${deck.title} Flashcards`;
      deckModalGrid.innerHTML = '';
      deck.cards.forEach(card => deckModalGrid.appendChild(renderDeckCard(card)));

      deckModal.classList.remove('hidden');
    }

    document.addEventListener('click', (e) => {
      const deckBtn = e.target.closest('.open-deck-btn');
      if (deckBtn) openDeck(deckBtn.dataset.deckId);
    });

    closeDeckModal.addEventListener('click', () => deckModal.classList.add('hidden'));
    deckModal.addEventListener('click', (e) => {
      if (e.target === deckModal) deckModal.classList.add('hidden');
    });

    deckModalGrid.addEventListener('click', async (e) => {
      const btn = e.target.closest('.remove-deck-card');
      if (!btn) return;
      e.stopPropagation();
      if (!confirm('Remove this flashcard?')) return;

      try {
        await fetch(`/api/ai/flashcards/${btn.dataset.cardId}`, { method: 'DELETE' });
        location.reload();
      } catch (err) {
        alert('Failed to delete.');
      }
    });
  })();

  // Expose for pdf-viewer.js
  window.aiTabs = { triggerExplain, triggerQuiz, triggerFlashcards, triggerChatMessage, activateTab };

})();
