/* app.js — YTSum Premium Frontend */
(function () {
  'use strict';

  /* ── SVG gradient defs for the ring spinner ──────────────────────────── */
  const svgDefs = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svgDefs.setAttribute('class', 'svg-defs');
  svgDefs.innerHTML = `
    <defs>
      <linearGradient id="ringGrad" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%"   stop-color="#c9f53b"/>
        <stop offset="100%" stop-color="#3bdfff"/>
      </linearGradient>
    </defs>`;
  document.body.prepend(svgDefs);

  /* ── Injected keyframes ──────────────────────────────────────────────── */
  const extraStyles = document.createElement('style');
  extraStyles.textContent = `
    @keyframes shake {
      0%,100% { transform: translateX(0); }
      20%,60% { transform: translateX(-6px); }
      40%,80% { transform: translateX(6px); }
    }
  `;
  document.head.appendChild(extraStyles);

  /* ── State ───────────────────────────────────────────────────────────── */
  let currentJobId  = null;
  let currentResult = null;
  let sseSource     = null;
  let ttsObjectUrl  = null;

  /* ── Element refs ────────────────────────────────────────────────────── */
  const $ = id => document.getElementById(id);

  const urlInput         = $('url-input');
  const submitBtn        = $('submit-btn');
  const progressPanel    = $('progress-panel');
  const progressTitle    = $('progress-title');
  const progressBar      = $('progress-bar');
  const progressBarWrap  = $('progress-bar-wrap');
  const logFeed          = $('log-feed');
  const resultPanel      = $('result-panel');
  const resultTitle      = $('result-title');
  const resultBadge      = $('result-style-badge');
  const resultSummary    = $('result-summary');
  const resultTranscript = $('result-transcript');
  const resultWordCount  = $('result-word-count');
  const errorPanel       = $('error-panel');
  const errorMsg         = $('error-msg');
  const copyBtn          = $('copy-btn');
  const downloadBtn      = $('download-btn');
  const newBtn           = $('new-btn');
  const errorRetryBtn    = $('error-retry-btn');
  const historyList      = $('history-list');
  const refreshHistoryBtn = $('refresh-history-btn');

  // Ring progress
  const ringFill    = $('ring-fill-el');
  const ringPctText = $('ring-pct-text');
  const RING_CIRC   = 88; // 2π × r ≈ 2π × 14 ≈ 87.96

  // TTS
  const ttsBtn       = $('tts-btn');
  const voiceSelect  = $('voice-select');
  const ttsPlayer    = $('tts-player');
  const ttsAudio     = $('tts-audio');
  const ttsPlayPause = $('tts-play-pause');
  const ttsFilled    = $('tts-filled');
  const ttsThumb     = $('tts-thumb');
  const ttsSeek      = $('tts-seek');
  const ttsTime      = $('tts-time');
  const ttsStop      = $('tts-stop');


  /* ════════════════════════════════════════════════════════════════════════
     3-D CARD TILT
     ════════════════════════════════════════════════════════════════════════ */
  function initTilt(card) {
    const MAX = 8; // max degrees

    card.addEventListener('mousemove', e => {
      const rect = card.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width  - 0.5;  // -0.5 → 0.5
      const y = (e.clientY - rect.top)  / rect.height - 0.5;
      const rotY =  x * MAX;
      const rotX = -y * MAX;
      card.classList.add('tilt-active');
      card.style.transform = `perspective(900px) rotateX(${rotX}deg) rotateY(${rotY}deg) scale3d(1.01,1.01,1.01)`;
    });

    card.addEventListener('mouseleave', () => {
      card.classList.remove('tilt-active');
      card.style.transform = '';
    });
  }

  document.querySelectorAll('.glass-card').forEach(initTilt);


  /* ════════════════════════════════════════════════════════════════════════
     TAB NAVIGATION
     ════════════════════════════════════════════════════════════════════════ */
  document.querySelectorAll('.nav-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.nav-pill').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab').forEach(t => {
        t.classList.remove('active');
        t.classList.add('hidden');
      });
      btn.classList.add('active');
      const el = document.getElementById('tab-' + tab);
      el.classList.remove('hidden');
      el.classList.add('active');
      if (tab === 'history') loadHistory();
    });
  });


  /* ════════════════════════════════════════════════════════════════════════
     STYLE CHIP SELECTION
     ════════════════════════════════════════════════════════════════════════ */
  document.querySelectorAll('.style-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.style-chip').forEach(c => c.classList.remove('selected'));
      chip.classList.add('selected');
      chip.querySelector('input[type="radio"]').checked = true;
    });
  });


  /* ════════════════════════════════════════════════════════════════════════
     SUBMIT
     ════════════════════════════════════════════════════════════════════════ */
  submitBtn.addEventListener('click', startSummary);
  urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') startSummary(); });

  function getSelectedStyle() {
    const checked = document.querySelector('input[name="style"]:checked');
    return checked ? checked.value : '1';
  }

  async function startSummary() {
    const url = urlInput.value.trim();
    if (!url) { urlInput.focus(); shake(urlInput.closest('.input-row')); return; }

    const styleKey = getSelectedStyle();
    hideAll();
    showPanel(progressPanel);
    submitBtn.disabled = true;
    logFeed.innerHTML  = '';
    setProgress(5);
    progressTitle.textContent = 'Starting…';

    try {
      const res = await fetch('/api/summarize', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ url, style_key: styleKey }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Server error');
      currentJobId = data.job_id;
      listenToJob(currentJobId);
    } catch (err) {
      showError(err.message);
    }
  }

  function listenToJob(jobId) {
    if (sseSource) { sseSource.onmessage = null; sseSource.onerror = null; sseSource.close(); }
    sseSource = new EventSource('/api/stream/' + jobId);
    let finished = false;

    sseSource.onmessage = event => {
      const msg = JSON.parse(event.data);

      if (msg.type === 'log') {
        appendLog(msg.payload);
        const text = msg.payload.toLowerCase();
        if (text.includes('download'))              { setProgress(15); progressTitle.textContent = 'Downloading audio…'; }
        if (text.includes('transcrib'))             { setProgress(45); progressTitle.textContent = 'Transcribing with Whisper…'; }
        if (text.includes('generat') || text.includes('summar')) { setProgress(80); progressTitle.textContent = 'Generating summary…'; }
        if (text.includes('captions'))              { setProgress(30); progressTitle.textContent = 'Fetching captions…'; }
      }

      if (msg.type === 'done') {
        finished = true;
        setProgress(100);
        progressTitle.textContent = 'Done! ✦';
        currentResult = msg.payload;
        sseSource.onmessage = null;
        sseSource.onerror   = null;
        sseSource.close();
        setTimeout(() => showResult(msg.payload), 500);
      }

      if (msg.type === 'error') {
        finished = true;
        sseSource.onmessage = null;
        sseSource.onerror   = null;
        sseSource.close();
        showError(msg.payload);
      }
    };

    sseSource.onerror = () => {
      if (finished) return;
      finished = true;
      sseSource.onmessage = null;
      sseSource.onerror   = null;
      sseSource.close();
      pollJobFallback(jobId);
    };
  }

  async function pollJobFallback(jobId) {
    try {
      const res  = await fetch('/api/job/' + jobId);
      const data = await res.json();
      if (data.status === 'done' && data.result) {
        currentResult = data.result;
        showResult(data.result);
      } else if (data.status === 'error') {
        showError(data.error || 'Job failed');
      } else {
        showError('Connection lost. Please try again.');
      }
    } catch {
      showError('Connection lost. Please try again.');
    }
  }


  /* ════════════════════════════════════════════════════════════════════════
     UI HELPERS
     ════════════════════════════════════════════════════════════════════════ */
  function hideAll() {
    [progressPanel, resultPanel, errorPanel].forEach(p => p.classList.add('hidden'));
  }
  function showPanel(el) { el.classList.remove('hidden'); }

  function setProgress(pct) {
    // Linear bar
    progressBar.style.width = pct + '%';
    if (progressBarWrap) progressBarWrap.setAttribute('aria-valuenow', pct);

    // Ring indicator
    if (ringFill) {
      const offset = RING_CIRC - (pct / 100) * RING_CIRC;
      ringFill.style.strokeDashoffset = offset;
    }
    if (ringPctText) ringPctText.textContent = Math.round(pct) + '%';
  }

  function appendLog(text) {
    const line = document.createElement('span');
    line.className = 'log-line';
    if (text.includes('✅') || text.includes('🎉')) line.classList.add('ok');
    if (text.includes('❌') || text.includes('⚠️')) line.classList.add('err');
    line.textContent = text;
    logFeed.appendChild(line);
    logFeed.appendChild(document.createTextNode('\n'));
    logFeed.scrollTop = logFeed.scrollHeight;
  }

  function showResult(data) {
    hideAll();
    stopTTS();
    submitBtn.disabled = false;
    resultTitle.textContent      = data.title || 'Summary';
    resultBadge.textContent      = data.style_label || '';
    resultSummary.textContent    = data.summary || '';
    resultTranscript.textContent = data.transcript || '';
    resultWordCount.textContent  = `${(data.transcript_word_count || 0).toLocaleString()} words transcribed`;
    // Reset TTS button
    ttsBtn.innerHTML   = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
    ttsBtn.className   = 'action-btn tts-idle';
    ttsBtn.disabled    = false;
    showPanel(resultPanel);
    resultPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function showError(msg) {
    hideAll();
    submitBtn.disabled = false;
    errorMsg.textContent = msg;
    showPanel(errorPanel);
  }

  function shake(el) {
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = 'shake 0.35s ease';
    el.addEventListener('animationend', () => { el.style.animation = ''; }, { once: true });
  }


  /* ════════════════════════════════════════════════════════════════════════
     RESULT ACTIONS
     ════════════════════════════════════════════════════════════════════════ */
  copyBtn.addEventListener('click', () => {
    if (!currentResult) return;
    navigator.clipboard.writeText(currentResult.summary).then(() => {
      const orig = copyBtn.innerHTML;
      copyBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4afa9a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
      setTimeout(() => { copyBtn.innerHTML = orig; }, 1600);
    });
  });

  downloadBtn.addEventListener('click', () => {
    if (!currentResult) return;
    const { title, url, style_label, summary } = currentResult;
    const text = `Title  : ${title}\nURL    : ${url}\nStyle  : ${style_label}\n${'═'.repeat(60)}\n\n${summary}\n`;
    const blob = new Blob([text], { type: 'text/plain' });
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    const safe = (title || 'summary').replace(/[^a-z0-9 _-]/gi, '_').slice(0, 40);
    a.download = `summary_${safe}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  newBtn.addEventListener('click', resetUI);
  errorRetryBtn.addEventListener('click', resetUI);

  function resetUI() {
    stopTTS();
    hideAll();
    submitBtn.disabled = false;
    urlInput.value     = '';
    currentResult      = null;
    currentJobId       = null;
    if (sseSource) { sseSource.close(); sseSource = null; }
    urlInput.focus();
  }


  /* ════════════════════════════════════════════════════════════════════════
     TTS
     ════════════════════════════════════════════════════════════════════════ */
  const PLAY_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
  const PAUSE_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;

  ttsBtn.addEventListener('click', async () => {
    if (!currentResult) return;

    // Toggle if already loaded
    if (ttsAudio.src && ttsAudio.readyState >= 2) {
      togglePlayPause();
      return;
    }

    const text  = currentResult.summary;
    const voice = voiceSelect.value;

    // Loading state
    ttsBtn.innerHTML = '↻';
    ttsBtn.className = 'action-btn tts-loading';
    ttsBtn.disabled  = true;
    ttsPlayer.classList.add('hidden');

    try {
      const res = await fetch('/api/tts', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text, voice }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'TTS request failed' }));
        throw new Error(err.error || 'TTS failed');
      }

      const blob = await res.blob();
      if (ttsObjectUrl) URL.revokeObjectURL(ttsObjectUrl);
      ttsObjectUrl = URL.createObjectURL(blob);

      ttsAudio.src         = ttsObjectUrl;
      ttsAudio.currentTime = 0;
      await ttsAudio.play();

      ttsPlayer.classList.remove('hidden');
      ttsPlayPause.innerHTML   = PAUSE_ICON;
      ttsBtn.innerHTML         = PAUSE_ICON;
      ttsBtn.className         = 'action-btn tts-playing';
      ttsBtn.disabled          = false;

    } catch (err) {
      ttsBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
      ttsBtn.className = 'action-btn tts-idle';
      ttsBtn.disabled  = false;
      alert('TTS error: ' + err.message);
    }
  });

  ttsPlayPause.addEventListener('click', togglePlayPause);

  function togglePlayPause() {
    if (ttsAudio.paused) {
      ttsAudio.play();
      ttsPlayPause.innerHTML = PAUSE_ICON;
      ttsBtn.innerHTML       = PAUSE_ICON;
      ttsBtn.className       = 'action-btn tts-playing';
    } else {
      ttsAudio.pause();
      ttsPlayPause.innerHTML = PLAY_ICON;
      ttsBtn.innerHTML       = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
      ttsBtn.className       = 'action-btn tts-idle';
    }
  }

  ttsStop.addEventListener('click', stopTTS);

  function stopTTS() {
    ttsAudio.pause();
    ttsAudio.src              = '';
    ttsFilled.style.width     = '0%';
    if (ttsThumb) ttsThumb.style.left = '0%';
    ttsTime.textContent       = '0:00';
    ttsPlayPause.innerHTML    = PLAY_ICON;
    ttsBtn.innerHTML          = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
    ttsBtn.className          = 'action-btn tts-idle';
    ttsBtn.disabled           = false;
    ttsPlayer.classList.add('hidden');
    if (ttsObjectUrl) { URL.revokeObjectURL(ttsObjectUrl); ttsObjectUrl = null; }
  }

  ttsAudio.addEventListener('timeupdate', () => {
    if (!ttsAudio.duration) return;
    const pct = (ttsAudio.currentTime / ttsAudio.duration) * 100;
    ttsFilled.style.width = pct + '%';
    if (ttsThumb) ttsThumb.style.left = pct + '%';
    if (ttsSeek)  ttsSeek.setAttribute('aria-valuenow', Math.round(pct));
    ttsTime.textContent = fmtSec(ttsAudio.currentTime) + ' / ' + fmtSec(ttsAudio.duration);
  });

  ttsAudio.addEventListener('ended', () => {
    ttsFilled.style.width  = '100%';
    if (ttsThumb) ttsThumb.style.left = '100%';
    ttsPlayPause.innerHTML = PLAY_ICON;
    ttsBtn.innerHTML       = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
    ttsBtn.className       = 'action-btn tts-idle';
  });

  ttsSeek.addEventListener('click', e => {
    if (!ttsAudio.duration) return;
    const rect = ttsSeek.getBoundingClientRect();
    ttsAudio.currentTime = ((e.clientX - rect.left) / rect.width) * ttsAudio.duration;
  });

  function fmtSec(s) {
    const m = Math.floor(s / 60);
    return m + ':' + Math.floor(s % 60).toString().padStart(2, '0');
  }


  /* ════════════════════════════════════════════════════════════════════════
     HISTORY
     ════════════════════════════════════════════════════════════════════════ */
  refreshHistoryBtn.addEventListener('click', loadHistory);

  async function loadHistory() {
    historyList.innerHTML = '<div class="history-empty">Loading…</div>';
    try {
      const res  = await fetch('/api/history');
      const data = await res.json();
      if (!data.length) {
        historyList.innerHTML = '<div class="history-empty">No summaries saved yet.</div>';
        return;
      }
      historyList.innerHTML = '';
      data.forEach((item, i) => {
        const el = document.createElement('div');
        el.className  = 'history-item';
        el.setAttribute('role', 'listitem');
        el.style.animationDelay = (i * 0.06) + 's';
        el.innerHTML = `
          <div class="history-thumb">📺</div>
          <div class="history-info">
            <div class="history-title">${esc(item.title)}</div>
            <div class="history-meta">${esc(item.style_label)} · ${item.word_count?.toLocaleString() || '?'} words · ${formatDate(item.saved_at)}</div>
          </div>
          <span class="history-arrow" aria-hidden="true">→</span>
        `;
        el.addEventListener('click', () => openHistoryItem(item.file));
        historyList.appendChild(el);
      });
    } catch {
      historyList.innerHTML = '<div class="history-empty">Failed to load history.</div>';
    }
  }

  async function openHistoryItem(filename) {
    try {
      const res  = await fetch('/api/history/' + encodeURIComponent(filename));
      const data = await res.json();
      showModal(data);
    } catch {
      alert('Failed to load this summary.');
    }
  }

  function showModal(data) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-heading">
        <div class="modal-header">
          <div>
            <div class="modal-title" id="modal-heading">${esc(data.title || 'Summary')}</div>
            <span class="chip-badge" style="margin-top:6px;display:inline-flex">${esc(data.style_label || '')}</span>
          </div>
          <button class="modal-close" title="Close" aria-label="Close modal">✕</button>
        </div>
        <div class="modal-body">${esc(data.summary || '')}</div>
      </div>
    `;
    overlay.querySelector('.modal-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onEsc); }
    });
    document.body.appendChild(overlay);
  }


  /* ════════════════════════════════════════════════════════════════════════
     UTILS
     ════════════════════════════════════════════════════════════════════════ */
  function esc(str) {
    return String(str)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function formatDate(str) {
    if (!str || str.length < 8) return str || '';
    try {
      const y = str.slice(0,4), m = str.slice(4,6), d = str.slice(6,8);
      return new Date(`${y}-${m}-${d}`).toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' });
    } catch { return str; }
  }

})();