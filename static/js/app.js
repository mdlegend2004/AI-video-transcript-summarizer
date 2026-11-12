/* app.js — frontend logic for YT Summarizer */

(function () {
  'use strict';

  /* ── state ───────────────────────────────────────────────────────────── */
  let currentJobId = null;
  let currentResult = null;
  let sseSource = null;
  const PROGRESS_STEPS = ['Downloading', 'Transcribing', 'Summarising', 'Done'];

  /* ── element refs ────────────────────────────────────────────────────── */
  const $ = id => document.getElementById(id);
  const urlInput       = $('url-input');
  const submitBtn      = $('submit-btn');
  const progressPanel  = $('progress-panel');
  const progressTitle  = $('progress-title');
  const progressBar    = $('progress-bar');
  const logFeed        = $('log-feed');
  const resultPanel    = $('result-panel');
  const resultTitle    = $('result-title');
  const resultBadge    = $('result-style-badge');
  const resultSummary  = $('result-summary');
  const resultTranscript = $('result-transcript');
  const resultWordCount  = $('result-word-count');
  const errorPanel     = $('error-panel');
  const errorMsg       = $('error-msg');
  const ttsBtn         = $('tts-btn');
  const copyBtn        = $('copy-btn');
  const downloadBtn    = $('download-btn');
  const newBtn         = $('new-btn');
  const errorRetryBtn  = $('error-retry-btn');
  const historyList    = $('history-list');
  const refreshHistoryBtn = $('refresh-history-btn');

  /* ── tab navigation ──────────────────────────────────────────────────── */
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab').forEach(t => { t.classList.remove('active'); t.classList.add('hidden'); });
      btn.classList.add('active');
      const el = document.getElementById('tab-' + tab);
      el.classList.remove('hidden');
      el.classList.add('active');
      if (tab === 'history') loadHistory();
    });
  });

  /* ── style card selection ────────────────────────────────────────────── */
  document.querySelectorAll('.style-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.style-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      card.querySelector('input[type="radio"]').checked = true;
    });
  });

  /* ── submit ──────────────────────────────────────────────────────────── */
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

    // reset UI
    hideAll();
    showPanel(progressPanel);
    submitBtn.disabled = true;
    logFeed.innerHTML  = '';
    setProgress(5);
    progressTitle.textContent = 'Starting…';

    try {
      const res = await fetch('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, style_key: styleKey }),
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
    let stepIdx = 0;
    let finished = false;   // guard: ignore onerror after we finish cleanly

    sseSource.onmessage = event => {
      const msg = JSON.parse(event.data);

      if (msg.type === 'log') {
        appendLog(msg.payload);
        const text = msg.payload.toLowerCase();
        if (text.includes('download'))   { stepIdx = Math.max(stepIdx, 1); setProgress(15); progressTitle.textContent = 'Downloading audio…'; }
        if (text.includes('transcrib'))  { stepIdx = Math.max(stepIdx, 2); setProgress(45); progressTitle.textContent = 'Transcribing with Whisper…'; }
        if (text.includes('generat') || text.includes('summar')) { stepIdx = Math.max(stepIdx, 3); setProgress(80); progressTitle.textContent = 'Generating summary…'; }
        if (text.includes('transcript ready')) { setProgress(75); }
      }

      if (msg.type === 'done') {
        finished = true;
        setProgress(100);
        progressTitle.textContent = 'Done!';
        currentResult = msg.payload;
        sseSource.onmessage = null;
        sseSource.onerror   = null;
        sseSource.close();
        setTimeout(() => showResult(msg.payload), 400);
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
      if (finished) return;          // normal close after done/error — ignore
      finished = true;
      sseSource.onmessage = null;
      sseSource.onerror   = null;
      sseSource.close();
      // Try polling the job status as fallback
      pollJobFallback(jobId);
    };
  }

  async function pollJobFallback(jobId) {
    // SSE dropped mid-stream — poll once to see if job actually finished
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

  /* ── UI helpers ──────────────────────────────────────────────────────── */
  function hideAll() {
    [progressPanel, resultPanel, errorPanel].forEach(p => p.classList.add('hidden'));
  }
  function showPanel(el) { el.classList.remove('hidden'); }

  function setProgress(pct) {
    progressBar.style.width = pct + '%';
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
    stopTTS();
    hideAll();
    submitBtn.disabled = false;
    resultTitle.textContent  = data.title || 'Summary';
    resultBadge.textContent  = data.style_label || '';
    resultSummary.textContent = data.summary || '';
    resultTranscript.textContent = data.transcript || '';
    resultWordCount.textContent  = `${(data.transcript_word_count || 0).toLocaleString()} words transcribed`;
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
    el.style.animation = 'shake 0.3s ease';
    el.addEventListener('animationend', () => { el.style.animation = ''; }, { once: true });
  }

  /* ── TTS ─────────────────────────────────────────────────────────────── */
  let ttsActive = false;

  ttsBtn.addEventListener('click', () => {
    if (!currentResult) return;
    ttsActive ? stopTTS() : startTTS(currentResult.summary);
  });

  function startTTS(text) {
    if (!window.speechSynthesis) return;
    stopTTS();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate  = 1;
    utter.onend   = () => setTTSState(false);
    utter.onerror = () => setTTSState(false);
    window.speechSynthesis.speak(utter);
    setTTSState(true);
  }

  function stopTTS() {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    setTTSState(false);
  }

  function setTTSState(playing) {
    ttsActive = playing;
    ttsBtn.textContent = playing ? '⏹' : '▶';
    ttsBtn.title       = playing ? 'Stop reading' : 'Read summary aloud';
    ttsBtn.classList.toggle('tts-playing', playing);
  }

  /* ── result actions ──────────────────────────────────────────────────── */
  copyBtn.addEventListener('click', () => {
    if (!currentResult) return;
    navigator.clipboard.writeText(currentResult.summary).then(() => {
      copyBtn.textContent = '✅';
      setTimeout(() => { copyBtn.textContent = '📋'; }, 1500);
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
    submitBtn.disabled   = false;
    urlInput.value       = '';
    currentResult        = null;
    currentJobId         = null;
    if (sseSource) { sseSource.close(); sseSource = null; }
    urlInput.focus();
  }

  /* ── history ─────────────────────────────────────────────────────────── */
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
        el.className = 'history-item';
        el.style.animationDelay = (i * 0.05) + 's';
        el.innerHTML = `
          <div class="history-thumb">📺</div>
          <div class="history-info">
            <div class="history-title">${esc(item.title)}</div>
            <div class="history-meta">${esc(item.style_label)} · ${item.word_count?.toLocaleString() || '?'} words · ${formatDate(item.saved_at)}</div>
          </div>
          <span class="history-arrow">→</span>
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
      <div class="modal">
        <div class="modal-header">
          <div>
            <div class="modal-title">${esc(data.title || 'Summary')}</div>
            <span class="badge" style="margin-top:4px;display:inline-block">${esc(data.style_label || '')}</span>
          </div>
          <button class="modal-close" title="Close">✕</button>
        </div>
        <div class="modal-body">${esc(data.summary || '')}</div>
      </div>
    `;
    overlay.querySelector('.modal-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  /* ── utils ───────────────────────────────────────────────────────────── */
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

  /* ── shake keyframe (injected) ───────────────────────────────────────── */
  const style = document.createElement('style');
  style.textContent = `
    @keyframes shake {
      0%,100% { transform: translateX(0); }
      25%      { transform: translateX(-6px); }
      75%      { transform: translateX(6px); }
    }
  `;
  document.head.appendChild(style);
})();