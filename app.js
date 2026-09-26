/* こえラボ — 画面の動き */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const fmt = (s) => {
    const t = Math.round(Math.max(0, isFinite(s) ? s : 0) * 10), m = Math.floor(t / 600);
    return `${m}:${((t - m * 600) / 10).toFixed(1).padStart(4, '0')}`;
  };
  const baseName = (n) => n.replace(/\.[^.]+$/, '');
  const stamp = () => { const d = new Date(), p = (v) => String(v).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`; };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const store = {
    get(k, d) { try { const v = localStorage.getItem('koelab.' + k); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('koelab.' + k, v); } catch { /* 保存できない環境でも動く */ } },
  };

  let AC = null;
  const ac = () => {
    if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)();
    if (AC.state === 'suspended') AC.resume();
    return AC;
  };

  // マイクが使えないときの案内（アプリ内ブラウザなどは仕組み上マイクが禁止されている）
  function micHelp(err) {
    const denied = err && /denied|NotAllowed/i.test(`${err.name} ${err.message}`);
    return denied
      ? 'マイクを使えませんでした。このブラウザではマイクが許可されていないか、禁止されています。Chrome や Edge で開いてマイクを「許可」するか、スマホ・ボイスレコーダーで録った音声を「ファイルを選ぶ」から入れてください。'
      : `マイクを使えませんでした（${err && err.message}）。マイクがつながっているか確認するか、録音したファイルを「ファイルを選ぶ」から入れてください。`;
  }
  function setStatus(id, text, err = false) { const el = $(id); el.textContent = text || ''; el.classList.toggle('err', !!err); }
  function setProgress(id, v) {
    const el = $(id);
    if (v == null) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.firstElementChild.style.width = `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
  }
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }
  function loadScript(src) {
    return new Promise((res, rej) => {
      if (document.querySelector(`script[src="${src}"]`)) return res();
      const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('読み込み失敗: ' + src));
      document.head.appendChild(s);
    });
  }
  async function resampleOffline(x, from, to) {
    if (from === to) return x;
    const ctx = new OfflineAudioContext(1, Math.max(1, Math.ceil(x.length * to / from)), to);
    const b = ctx.createBuffer(1, x.length, from); b.copyToChannel(x, 0);
    const s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start();
    return (await ctx.startRendering()).getChannelData(0);
  }

  // ================= 状態 =================
  const S = {
    name: '', isVideo: false, videoUrl: null,
    mono: null, sr: 0, sel: null,
    full: null, analysis: null, analysisKey: '',
    proc: null, procMeta: null, procAnalysis: null,
    ab: 'proc', rec: {},
    tts: null,
  };

  // ================= 波形 =================
  class Wave {
    constructor(canvas, opts = {}) {
      this.c = canvas; this.opts = opts; this.x = null; this.sr = 1; this.dur = 0; this.sel = null; this.head = -1;
      new ResizeObserver(() => this.layout()).observe(canvas);
      if (opts.onSeek || opts.onSelect) this.bindPointer();
    }
    setData(x, sr) { this.x = x; this.sr = sr; this.dur = x.length / sr; this.sel = null; this.head = -1; this.layout(); }
    layout() {
      const w = this.c.clientWidth, h = this.c.clientHeight, dpr = window.devicePixelRatio || 1;
      if (!w || !h) return;
      this.c.width = Math.round(w * dpr); this.c.height = Math.round(h * dpr);
      this.w = w; this.h = h; this.dpr = dpr;
      this.computePeaks(); this.draw();
    }
    computePeaks() {
      if (!this.x || !this.w) { this.peaks = null; return; }
      const bars = Math.max(10, Math.floor(this.w / 5)), per = this.x.length / bars, p = new Float32Array(bars);
      let mx = 1e-6;
      for (let i = 0; i < bars; i++) {
        let m = 0;
        const a = Math.floor(i * per), b = Math.min(this.x.length, Math.floor((i + 1) * per));
        const stride = Math.max(1, Math.floor((b - a) / 2000));
        for (let j = a; j < b; j += stride) { const v = Math.abs(this.x[j]); if (v > m) m = v; }
        p[i] = m; if (m > mx) mx = m;
      }
      for (let i = 0; i < bars; i++) p[i] = Math.pow(p[i] / mx, 0.75);
      this.peaks = p;
    }
    draw() {
      const g = this.c.getContext('2d'); if (!g || !this.w) return;
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      g.clearRect(0, 0, this.w, this.h);
      const mid = this.h / 2;
      if (!this.peaks) {
        g.fillStyle = '#2433E0';
        for (let x = 4; x < this.w; x += 10) g.fillRect(x, mid - 2, 4, 4);
        return;
      }
      const n = this.peaks.length, bw = this.w / n;
      const sx = this.sel ? this.sel.a / this.dur * this.w : 0, ex = this.sel ? this.sel.b / this.dur * this.w : this.w;
      const hx = this.head >= 0 ? this.head / this.dur * this.w : -1;
      if (this.sel) { g.fillStyle = 'rgba(36,51,224,.08)'; g.fillRect(sx, 0, ex - sx, this.h); }
      for (let i = 0; i < n; i++) {
        const x = i * bw + bw * 0.2, w = Math.max(1, bw * 0.6), hh = Math.max(3, this.peaks[i] * (this.h - 10));
        const inside = x + w >= sx && x <= ex;
        g.fillStyle = !inside ? '#D3D7F8' : (hx > 0 && x > hx) ? '#8E97F0' : '#2433E0';
        if (g.roundRect) { g.beginPath(); g.roundRect(x, mid - hh / 2, w, hh, Math.min(w / 2, 2)); g.fill(); }
        else g.fillRect(x, mid - hh / 2, w, hh);
      }
      if (hx >= 0) { g.fillStyle = '#E0413A'; g.fillRect(hx - 1, 0, 2, this.h); }
    }
    setHead(t) { this.head = t; this.draw(); }
    setSel(sel) { this.sel = sel; this.draw(); }
    bindPointer() {
      let sx = null, moved = false;
      const t = (e) => { const r = this.c.getBoundingClientRect(); return Math.max(0, Math.min(this.dur, (e.clientX - r.left) / r.width * this.dur)); };
      this.c.addEventListener('pointerdown', (e) => { if (!this.x) return; this.c.setPointerCapture(e.pointerId); sx = e.clientX; moved = false; this.t0 = t(e); });
      this.c.addEventListener('pointermove', (e) => {
        if (sx == null) return;
        if (Math.abs(e.clientX - sx) > 4) moved = true;
        if (moved && this.opts.onSelect) { const t1 = t(e); this.setSel({ a: Math.min(this.t0, t1), b: Math.max(this.t0, t1) }); }
      });
      this.c.addEventListener('pointerup', (e) => {
        if (sx == null) return;
        sx = null;
        if (moved && this.opts.onSelect) { if (this.sel && this.sel.b - this.sel.a > 0.05) this.opts.onSelect(this.sel); else { this.setSel(null); this.opts.onSelect(null); } }
        else if (this.opts.onSeek) this.opts.onSeek(t(e));
      });
    }
  }

  const waveOrig = new Wave($('waveOrig'), {
    onSeek: (t) => player.seek('orig', t),
    onSelect: (sel) => { S.sel = sel; onSelectionChange(); },
  });
  const waveProc = new Wave($('waveProc'), { onSeek: (t) => { S.ab = 'proc'; syncAb(); player.seek('proc', t); } });
  const waveTts = new Wave($('waveTts'), { onSeek: (t) => player.seek('tts', t) });

  // ================= 再生 =================
  const player = {
    src: null, which: null, t0: 0, off: 0, end: 0, raf: 0,
    pos: { orig: 0, proc: 0, tts: 0 },
    cache: new WeakMap(),
    data(which) {
      if (which === 'orig') return [S.mono, S.sr];
      if (which === 'proc') return [S.proc, S.sr];
      return S.tts ? [S.tts.data, S.tts.sr] : [null, 0];
    },
    buffer(x, sr) {
      let b = this.cache.get(x);
      if (!b) { b = ac().createBuffer(1, x.length, sr); b.copyToChannel(x, 0); this.cache.set(x, b); }
      return b;
    },
    range(which) {
      const [x, sr] = this.data(which), dur = x.length / sr;
      if (which === 'orig' && S.sel) return [S.sel.a, S.sel.b];
      return [0, dur];
    },
    play(which, from) {
      this.stop();
      const [x, sr] = this.data(which);
      if (!x) return;
      const [a, b] = this.range(which);
      let start = from ?? this.pos[which];
      if (start < a || start >= b - 0.02) start = a;
      const src = ac().createBufferSource();
      src.buffer = this.buffer(x, sr);
      src.connect(ac().destination);
      src.start(0, start, b - start);
      src.onended = () => { if (this.src === src) { this.stop(); this.pos[which] = a; paint(which, a); } };
      Object.assign(this, { src, which, t0: ac().currentTime, off: start, end: b });
      buttons();
      const loop = () => { if (this.src !== src) return; paint(which, this.now()); this.raf = requestAnimationFrame(loop); };
      loop();
    },
    now() { return Math.min(this.end, this.off + (ac().currentTime - this.t0)); },
    stop() {
      if (!this.src) return;
      const s = this.src; this.src = null;
      this.pos[this.which] = this.now();
      s.onended = null; try { s.stop(); } catch { /* 停止済み */ }
      cancelAnimationFrame(this.raf); this.which = null; buttons();
    },
    toggle(which) { if (this.which === which) this.stop(); else this.play(which); },
    seek(which, t) { this.pos[which] = t; paint(which, t); if (this.which === which) this.play(which, t); },
  };

  // 変換後 ⇔ 元の音 の時刻対応（無音カットありなら長さの比率で近似）
  function p2o(t) {
    const m = S.procMeta; if (!m) return t;
    const pd = S.proc.length / S.sr;
    return m.cut ? m.a + (t / pd) * (m.b - m.a) : m.a + t * m.speed;
  }
  function o2p(t) {
    const m = S.procMeta; if (!m) return t;
    const pd = S.proc.length / S.sr;
    return Math.max(0, Math.min(pd, m.cut ? (t - m.a) / (m.b - m.a) * pd : (t - m.a) / m.speed));
  }

  function paint(which, t) {
    if (which === 'orig') {
      waveOrig.setHead(t); $('timeOrig').textContent = `${fmt(t)} / ${fmt(S.mono.length / S.sr)}`;
      if (S.proc && player.which === 'orig') { const tp = o2p(t); waveProc.setHead(tp); $('timeProc').textContent = `${fmt(tp)} / ${fmt(S.proc.length / S.sr)}`; }
    } else if (which === 'proc') {
      waveProc.setHead(t); $('timeProc').textContent = `${fmt(t)} / ${fmt(S.proc.length / S.sr)}`;
    } else if (which === 'tts' && S.tts) {
      waveTts.setHead(t); $('timeTts').textContent = `${fmt(t)} / ${fmt(S.tts.data.length / S.tts.sr)}`;
      drawPreview(t);
    }
  }
  function buttons() {
    const w = player.which;
    $('playOrig').textContent = w === 'orig' ? '■ 停止' : '▶ 再生';
    $('playProc').textContent = (w === 'proc' || (w === 'orig' && S.ab === 'orig' && S.proc)) ? '■ 停止' : '▶ 再生';
    $('playTts').textContent = w === 'tts' ? '■ 停止' : '▶ 再生';
  }

  $('playOrig').onclick = () => player.toggle('orig');
  $('playTts').onclick = () => player.toggle('tts');
  $('playProc').onclick = () => {
    if (player.which) { player.stop(); return; }
    if (S.ab === 'proc') player.play('proc');
    else player.play('orig', p2o(player.pos.proc));
  };
  function syncAb() { document.querySelectorAll('[data-ab]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.ab === S.ab))); }
  document.querySelectorAll('[data-ab]').forEach((b) => b.onclick = () => {
    if (S.ab === b.dataset.ab) return;
    const playing = player.which;
    const t = playing === 'proc' ? player.now() : playing === 'orig' ? o2p(player.now()) : player.pos.proc;
    S.ab = b.dataset.ab; syncAb();
    player.pos.proc = t;
    if (playing) { if (S.ab === 'proc') player.play('proc', t); else player.play('orig', p2o(t)); }
    buttons();
  });

  // ================= タブ =================
  document.querySelectorAll('nav.tabs button').forEach((b) => b.onclick = () => showTab(b.dataset.tab));
  function showTab(name) {
    document.querySelectorAll('nav.tabs button').forEach((x) => x.setAttribute('aria-selected', String(x.dataset.tab === name)));
    $('tab-edit').classList.toggle('hidden', name !== 'edit');
    $('tab-tts').classList.toggle('hidden', name !== 'tts');
    player.stop();
  }

  // ================= 読み込み =================
  const drop = $('drop');
  const dl = drop.querySelector('.dots-line');
  for (let i = 0; i < 36; i++) { const d = document.createElement('i'); d.style.animationDelay = `${(i * 0.07) % 1.6}s`; dl.appendChild(d); }
  drop.onclick = () => $('fileInput').click();
  drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fileInput').click(); } };
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (f && !$('tab-edit').classList.contains('hidden')) loadFile(f);
  });
  $('fileInput').onchange = (e) => { const f = e.target.files[0]; if (f) loadFile(f); e.target.value = ''; };
  $('changeFile').onclick = () => $('fileInput').click();

  let rec = null;
  $('recBtn').onclick = async (e) => {
    e.stopPropagation();
    if (rec) { rec.mr.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const mr = new MediaRecorder(stream), chunks = [];
      mr.ondataavailable = (ev) => chunks.push(ev.data);
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        clearInterval(rec.iv); rec = null;
        $('recBtn').textContent = '● マイクで録音する';
        const type = mr.mimeType || 'audio/webm';
        loadFile(new File([new Blob(chunks, { type })], `録音_${stamp()}.${type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm'}`, { type }));
      };
      mr.start();
      const t0 = Date.now();
      rec = { mr, iv: setInterval(() => { $('recBtn').textContent = `■ 録音を止める（${fmt((Date.now() - t0) / 1000)}）`; }, 200) };
    } catch (err) {
      setStatus('loadStatus', micHelp(err), true);
    }
  };

  async function loadFile(file) {
    player.stop();
    const isVideo = file.type.startsWith('video/') || (!file.type.startsWith('audio/') && /\.(mp4|mov|m4v|mkv|webm)$/i.test(file.name));
    setStatus('loadStatus', `「${file.name}」を読み込んでいます…`);
    try {
      const audio = await ac().decodeAudioData(await file.arrayBuffer());
      setSource(DSP.toMono(audio), audio.sampleRate, file.name, isVideo ? URL.createObjectURL(file) : null, { channels: audio.numberOfChannels, size: file.size });
    } catch {
      setStatus('loadStatus', isVideo
        ? 'この動画から音を取り出せませんでした。音声が入っていないか、ブラウザが対応していない形式です（mp4・webm・mov がおすすめ）。'
        : 'このファイルは読み込めませんでした。mp3・wav・m4a・ogg などの音声ファイルを選んでください。', true);
    }
  }

  function setSource(mono, sr, name, videoUrl, meta = {}) {
    if (S.videoUrl) URL.revokeObjectURL(S.videoUrl);
    Object.assign(S, { mono, sr, name, videoUrl, isVideo: !!videoUrl, sel: null, full: null, analysis: null, analysisKey: '', proc: null, procMeta: null, procAnalysis: null, ab: 'proc' });
    player.pos = { orig: 0, proc: 0, tts: player.pos.tts };
    drop.classList.add('hidden');
    $('fileCard').classList.remove('hidden');
    $('fileName').textContent = name;
    $('fileKind').textContent = videoUrl ? '動画' : '音声';
    const parts = [fmt(mono.length / sr), `${(sr / 1000).toFixed(1).replace(/\.0$/, '')}kHz`];
    if (meta.channels) parts.push(meta.channels === 1 ? 'モノラル' : `${meta.channels}ch → モノラルで処理`);
    if (meta.size) parts.push(`${(meta.size / 1048576).toFixed(1)}MB`);
    $('fileMeta').textContent = parts.join(' ・ ');
    const v = $('videoPreview');
    v.classList.toggle('hidden', !videoUrl);
    if (videoUrl) v.src = videoUrl; else v.removeAttribute('src');
    setStatus('loadStatus', '');
    ['secAnalyze', 'secConvert'].forEach((id) => $(id).classList.remove('hidden'));
    $('secExport').classList.add('hidden');
    $('aiOut').innerHTML = ''; setStatus('aiStatus', '');
    waveOrig.setData(mono, sr);
    paint('orig', 0);
    $('clearSel').classList.add('hidden');
    $('selInfo').textContent = '全体';
    runAnalysis();
  }

  // ================= 分析 =================
  function rangeSamples() {
    if (!S.sel) return [0, S.mono.length];
    return [Math.floor(S.sel.a * S.sr), Math.ceil(S.sel.b * S.sr)];
  }
  function analysisFor() {
    const [a, b] = rangeSamples(), key = `${a}-${b}`;
    if (S.analysisKey === key && S.analysis) return S.analysis;
    const res = (a === 0 && b === S.mono.length && S.full) ? S.full : DSP.analyze(S.mono.subarray(a, b), S.sr);
    if (a === 0 && b === S.mono.length) S.full = res;
    S.analysis = res; S.analysisKey = key;
    return res;
  }
  async function runAnalysis() {
    $('stats').innerHTML = '<div class="stat"><div class="k">分析中…</div></div>';
    await tick();
    const a = analysisFor();
    renderStats(a); renderPitch(a); renderSpec(a); renderDiag(a);
  }
  let selTimer = 0;
  function onSelectionChange() {
    if (S.sel) {
      $('selInfo').textContent = `選択中：${fmt(S.sel.a)}〜${fmt(S.sel.b)}（${(S.sel.b - S.sel.a).toFixed(1)}秒）`;
      $('clearSel').classList.remove('hidden');
      if (player.which === 'orig') player.play('orig', S.sel.a);
    } else {
      $('selInfo').textContent = '全体';
      $('clearSel').classList.add('hidden');
    }
    clearTimeout(selTimer);
    selTimer = setTimeout(runAnalysis, 250);
  }
  $('clearSel').onclick = () => { S.sel = null; waveOrig.setSel(null); onSelectionChange(); };

  function voiceLabel(f) { return f < 120 ? '低い声' : f < 165 ? 'やや低め' : f < 220 ? '中くらい' : f < 280 ? 'やや高め' : '高い声'; }
  function noiseLabel(d) { return d < -60 ? 'とても静か' : d < -50 ? '静か' : d < -40 ? 'やや気になる' : '大きい'; }
  const showDb = (d) => (d < -90 ? '−90未満' : d.toFixed(1));
  const snr = (a) => (a.noiseDb < -90 ? '90以上' : (a.speechDb - a.noiseDb).toFixed(0));

  function stat(k, v, unit, d) {
    return `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}${unit ? `<small>${esc(unit)}</small>` : ''}</div><div class="d">${esc(d)}</div></div>`;
  }
  function renderStats(a) {
    $('stats').innerHTML = [
      stat('長さ', fmt(a.duration), '', `話している時間 ${fmt(a.speechSec)}`),
      a.f0Median > 0
        ? stat('声の高さ', Math.round(a.f0Median), 'Hz', `${voiceLabel(a.f0Median)}・音程の幅 ${a.rangeSemitones.toFixed(1)}半音`)
        : stat('声の高さ', '—', '', '声の高さを検出できませんでした'),
      stat('音量', isFinite(a.lufs) ? a.lufs.toFixed(1) : '—', 'LUFS', 'ポッドキャストの目安は -16'),
      stat('いちばん大きい所', showDb(a.peakDb), 'dBFS', a.clipRuns ? `音割れの疑い ${a.clipRuns}か所` : '音割れなし'),
      stat('無音の割合', Math.round(a.silenceRatio * 100), '%', `0.7秒以上の間 ${a.longSilences}か所`),
      stat('背景ノイズ', showDb(a.noiseDb), 'dBFS', `${noiseLabel(a.noiseDb)}・声との差 ${snr(a)}dB`),
    ].join('');
  }

  function canvasCtx(c) {
    const w = c.clientWidth, h = c.clientHeight, dpr = window.devicePixelRatio || 1;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    return [g, w, h];
  }
  function renderPitch(a) {
    const [g, w, h] = canvasCtx($('pitchChart'));
    if (!w) return;
    const lo = 60, hi = 500, L = 34, pad = 8;
    const y = (f) => pad + (1 - Math.log(f / lo) / Math.log(hi / lo)) * (h - pad * 2);
    g.font = '11px "Noto Sans JP", sans-serif'; g.textBaseline = 'middle';
    for (const f of [100, 200, 300, 400]) {
      g.strokeStyle = '#EDE6D3'; g.beginPath(); g.moveTo(L, y(f)); g.lineTo(w, y(f)); g.stroke();
      g.fillStyle = '#6E6B60'; g.fillText(`${f}Hz`, 0, y(f));
    }
    const { times, f0 } = a.pitch, dur = a.duration || 1;
    g.fillStyle = '#2433E0';
    for (let i = 0; i < f0.length; i++) {
      if (!(f0[i] > 0)) continue;
      g.fillRect(L + times[i] / dur * (w - L) - 1, y(Math.min(hi, Math.max(lo, f0[i]))) - 1, 2.4, 2.4);
    }
    if (a.f0Median > 0) {
      g.strokeStyle = '#E0413A'; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(L, y(a.f0Median)); g.lineTo(w, y(a.f0Median)); g.stroke(); g.setLineDash([]);
      $('pitchNote').textContent = `赤線 = 中央値 ${Math.round(a.f0Median)}Hz`;
    } else $('pitchNote').textContent = '';
  }
  function renderSpec(a) {
    const [g, w, h] = canvasCtx($('specChart'));
    if (!w) return;
    const n = a.bands.length, bw = w / n, base = h - 18;
    a.bands.forEach((b, i) => {
      const v = Math.max(0, (b.db + 60) / 60), hh = Math.max(2, v * (base - 6));
      g.fillStyle = b.f0 < 300 ? '#8E97F0' : b.f0 < 3000 ? '#2433E0' : '#5B67EA';
      if (g.roundRect) { g.beginPath(); g.roundRect(i * bw + bw * 0.15, base - hh, bw * 0.7, hh, 2); g.fill(); } else g.fillRect(i * bw + bw * 0.15, base - hh, bw * 0.7, hh);
    });
    g.fillStyle = '#6E6B60'; g.font = '11px "Noto Sans JP", sans-serif'; g.textBaseline = 'alphabetic';
    const top = a.bands[n - 1].f1, lo = a.bands[0].f0;
    for (const [f, t] of [[100, '100'], [1000, '1k'], [4000, '4k']]) {
      if (f > top) continue;
      const x = Math.log(f / lo) / Math.log(top / lo) * w;
      g.fillText(t, Math.min(w - 20, Math.max(0, x - 8)), h - 3);
    }
    $('specNote').textContent = a.centroidHz ? `声の明るさ ${Math.round(a.centroidHz)}Hz` : '';
  }

  function diagnose(a) {
    const items = [], rec = {};
    if (!isFinite(a.lufs) || a.speechSec < 0.3) {
      items.push(['warn', '声がほとんど見つかりませんでした。無音か、とても小さい音です。']);
      return { items, rec };
    }
    if (a.clipRuns > 0) items.push(['warn', `音割れの疑いが ${a.clipRuns} か所あります。割れた音は後から完全には戻せないので、録り直せるなら入力音量を少し下げましょう。`]);
    if (a.noiseDb > -50) { items.push(['warn', `背景ノイズが目立ちます（${a.noiseDb.toFixed(0)} dBFS）。「ノイズを減らす」がおすすめです。`]); rec.denoise = a.noiseDb > -40 ? 0.7 : 0.5; }
    else if (a.noiseDb > -60) { items.push(['info', `わずかに背景ノイズがあります（${a.noiseDb.toFixed(0)} dBFS）。気になるなら「ノイズを減らす」を弱めに。`]); rec.denoise = 0.3; }
    if (a.lufs < -24) { items.push(['warn', `音量が小さめです（${a.lufs.toFixed(1)} LUFS）。「音量をそろえる」で聞きやすい大きさになります。`]); rec.norm = true; rec.comp = true; }
    else if (a.lufs > -11) { items.push(['warn', `音量がかなり大きめです（${a.lufs.toFixed(1)} LUFS）。「音量をそろえる」で下げられます。`]); rec.norm = true; }
    else items.push(['ok', `音量はほどよい範囲です（${a.lufs.toFixed(1)} LUFS）。`]);
    if (a.longSilences >= 2 && a.silenceRatio > 0.25) { items.push(['info', `0.7秒以上の間が ${a.longSilences} か所あり、全体の ${Math.round(a.silenceRatio * 100)}% が無音です。「無音をつめる」でテンポがよくなります。`]); rec.cut = true; }
    if (a.f0Median > 0 && a.rangeSemitones < 4) items.push(['info', `抑揚が小さめです（音程の幅 ${a.rangeSemitones.toFixed(1)} 半音）。単調に聞こえやすいので、強調したい言葉で声の高さを変えてみましょう。`]);
    else if (a.f0Median > 0) items.push(['ok', `抑揚は十分あります（音程の幅 ${a.rangeSemitones.toFixed(1)} 半音）。`]);
    if (a.centroidHz > 0 && a.centroidHz < 900) { items.push(['info', `声がこもり気味です（明るさ ${Math.round(a.centroidHz)} Hz）。「はっきり」を少し上げると聞き取りやすくなります。`]); rec.clarity = 4; }
    if (!items.some(([t]) => t !== 'ok')) items.push(['ok', '大きな問題は見つかりませんでした。']);
    return { items, rec };
  }
  function renderDiag(a) {
    const { items, rec } = diagnose(a);
    S.rec = rec;
    const mk = { warn: '!', info: 'i', ok: '✓' };
    $('diag').innerHTML = items.map(([t, s]) => `<li class="${t}"><span class="mk">${mk[t]}</span><span>${esc(s)}</span></li>`).join('');
    $('applyRec').disabled = !Object.keys(rec).length;
  }
  $('applyRec').onclick = () => {
    setControls({ ...readControls(), ...S.rec });
    markPreset(null);
    $('secConvert').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // ================= 変換の設定 =================
  const DEFAULTS = { pitch: 0, speed: 1, character: 'none', denoise: 0, cut: false, comp: false, norm: false, target: '-16', bass: 0, clarity: 0, treble: 0, reverb: 0, echo: 0 };
  const PRESETS = [
    ['聞きやすく整える', { denoise: 0.35, comp: true, norm: true, clarity: 2, bass: -1 }],
    ['配信向け（テンポよく）', { denoise: 0.35, cut: true, comp: true, norm: true, target: '-14', clarity: 2 }],
    ['高い声', { pitch: 5 }],
    ['低い声', { pitch: -5, bass: 2 }],
    ['ちびキャラ', { pitch: 9, speed: 1.1 }],
    ['ロボット', { character: 'robot', pitch: -2 }],
    ['電話ごし', { character: 'phone' }],
    ['古いラジオ', { character: 'radio' }],
    ['拡声器', { character: 'megaphone' }],
    ['ホールで話す', { reverb: 0.4 }],
    ['やまびこ', { echo: 0.5 }],
    ['1.5倍速', { speed: 1.5 }],
  ];
  const RANGE = ['pitch', 'speed', 'denoise', 'bass', 'clarity', 'treble', 'reverb', 'echo'];
  const CHECK = ['cut', 'comp', 'norm'];
  const sign = (v) => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v);
  const pct = (v) => (v > 0 ? `${Math.round(v * 100)}%` : 'なし');
  const OUT = {
    pitch: (v) => `${sign(v)} 半音`, speed: (v) => `${v.toFixed(2)}倍`, denoise: pct,
    bass: (v) => `${sign(v)} dB`, clarity: (v) => `${sign(v)} dB`, treble: (v) => `${sign(v)} dB`, reverb: pct, echo: pct,
  };
  function readControls() {
    const o = {};
    for (const k of RANGE) o[k] = parseFloat($('c_' + k).value);
    for (const k of CHECK) o[k] = $('c_' + k).checked;
    o.character = $('c_character').value; o.target = $('c_target').value;
    return o;
  }
  function setControls(o) {
    for (const k of RANGE) $('c_' + k).value = o[k];
    for (const k of CHECK) $('c_' + k).checked = !!o[k];
    $('c_character').value = o.character; $('c_target').value = o.target;
    refreshOutputs();
  }
  function refreshOutputs() { for (const k of RANGE) $('o_' + k).textContent = OUT[k](parseFloat($('c_' + k).value)); }
  function markPreset(i) { document.querySelectorAll('#presets .chip').forEach((c, j) => c.classList.toggle('on', j === i)); }
  $('presets').innerHTML = PRESETS.map(([n], i) => `<button class="chip" data-i="${i}">${esc(n)}</button>`).join('');
  document.querySelectorAll('#presets .chip').forEach((c) => c.onclick = () => { const i = +c.dataset.i; setControls({ ...DEFAULTS, ...PRESETS[i][1] }); markPreset(i); });
  document.querySelectorAll('#secConvert input, #secConvert select').forEach((el) => el.addEventListener('input', () => { refreshOutputs(); markPreset(null); }));
  $('resetBtn').onclick = () => { setControls(DEFAULTS); markPreset(null); };
  setControls(DEFAULTS);

  // ================= 変換 =================
  function makeIR(ctx, sec) {
    const n = Math.round(sec * ctx.sampleRate), b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
    let seed = 7;
    for (let i = 0; i < n; i++) { seed = (seed * 16807) % 2147483647; d[i] = (seed / 2147483647 * 2 - 1) * Math.pow(1 - i / n, 3.2); }
    return b;
  }
  function shaper(ctx, k) {
    const ws = ctx.createWaveShaper(), c = new Float32Array(1024);
    for (let i = 0; i < c.length; i++) { const x = i / (c.length - 1) * 2 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
    ws.curve = c; ws.oversample = '2x';
    return ws;
  }
  async function renderEffects(x, sr, o) {
    const needs = o.bass || o.clarity || o.treble || o.character !== 'none' || o.comp || o.reverb > 0 || o.echo > 0;
    if (!needs) return x;
    const tail = (o.reverb > 0 ? 2.5 : 0) + (o.echo > 0 ? 2 : 0);
    const ctx = new OfflineAudioContext(1, x.length + Math.round(tail * sr), sr);
    const buf = ctx.createBuffer(1, x.length, sr); buf.copyToChannel(x, 0);
    const src = ctx.createBufferSource(); src.buffer = buf;
    let node = src;
    const chain = (n) => { node.connect(n); node = n; return n; };
    const filt = (type, f, gain = 0, q = Math.SQRT1_2) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.gain.value = gain; b.Q.value = q; return chain(b); };
    if (o.bass) filt('lowshelf', 180, o.bass);
    if (o.clarity) filt('peaking', 3000, o.clarity, 0.9);
    if (o.treble) filt('highshelf', 8000, o.treble);
    const hiss = (level) => {
      const nb = ctx.createBuffer(1, ctx.length, sr), d = nb.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * level;
      const ns = ctx.createBufferSource(); ns.buffer = nb; ns.start(); return ns;
    };
    let noise = null;
    switch (o.character) {
      case 'robot': {
        const g = ctx.createGain(); g.gain.value = 0;
        const osc = ctx.createOscillator(); osc.frequency.value = 50; osc.connect(g.gain); osc.start();
        chain(g);
        break;
      }
      case 'phone':
        filt('highpass', 350); filt('highpass', 350); filt('lowpass', 3400); filt('lowpass', 3400); filt('peaking', 1800, 4, 1); chain(shaper(ctx, 2));
        break;
      case 'radio':
        filt('highpass', 500); filt('lowpass', 4000); filt('lowpass', 4000); filt('peaking', 1200, 6, 1); chain(shaper(ctx, 5));
        noise = hiss(0.006);
        break;
      case 'megaphone':
        filt('highpass', 700); filt('highpass', 700); filt('lowpass', 5000); filt('peaking', 2000, 8, 1.2); chain(shaper(ctx, 10));
        break;
    }
    if (o.comp) {
      const c = ctx.createDynamicsCompressor();
      c.threshold.value = -26; c.knee.value = 10; c.ratio.value = 3.5; c.attack.value = 0.005; c.release.value = 0.15;
      chain(c);
      const mk = ctx.createGain(); mk.gain.value = 1.8; chain(mk);
    }
    const out = ctx.createGain();
    const dry = ctx.createGain(); dry.gain.value = 1 - o.reverb * 0.35;
    node.connect(dry); dry.connect(out);
    if (noise) noise.connect(out);
    if (o.echo > 0) {
      const d = ctx.createDelay(2); d.delayTime.value = 0.3;
      const fb = ctx.createGain(); fb.gain.value = 0.3 + 0.25 * o.echo;
      const wet = ctx.createGain(); wet.gain.value = 0.25 + 0.5 * o.echo;
      node.connect(d); d.connect(fb); fb.connect(d); d.connect(wet); wet.connect(out);
    }
    if (o.reverb > 0) {
      const cv = ctx.createConvolver(); cv.buffer = makeIR(ctx, 2.2);
      const wet = ctx.createGain(); wet.gain.value = o.reverb * 0.9;
      node.connect(cv); cv.connect(wet); wet.connect(out);
    }
    out.connect(ctx.destination);
    src.start();
    let y = (await ctx.startRendering()).getChannelData(0);
    // 余韻が消えたところで切る（ノイズを足した場合は元の長さに合わせる）
    let end = x.length;
    if (!noise) { for (let i = y.length - 1; i >= x.length; i--) if (Math.abs(y[i]) > 1e-4) { end = Math.min(y.length, i + Math.round(0.05 * sr)); break; } }
    return y.slice(0, end);
  }

  $('convertBtn').onclick = async () => {
    const o = readControls();
    const btn = $('convertBtn');
    btn.disabled = true; player.stop();
    const step = (t, p) => { setStatus('convStatus', t); setProgress('convProg', p); return tick(); };
    try {
      const [a, b] = rangeSamples(), sr = S.sr;
      const before = analysisFor();
      let x = S.mono.slice(a, b);
      if (o.denoise > 0) { await step('ノイズを減らしています…', 0.05); x = await DSP.denoise(x, sr, o.denoise, (p) => setProgress('convProg', 0.05 + 0.35 * p)); }
      if (o.cut) { await step('無音をつめています…', 0.42); x = DSP.cutSilence(x, sr, DSP.analyzeLevels(x, sr)); }
      if (o.pitch || o.speed !== 1) { await step('声の高さ・速さを変えています…（長い音声は少し時間がかかります）', 0.48); x = DSP.pitchSpeed(x, sr, o.pitch, o.speed); }
      await step('音色と響きをつけています…', 0.72);
      x = await renderEffects(x, sr, o);
      await step(o.norm ? '音量をそろえています…' : '仕上げています…', 0.88);
      x = o.norm ? DSP.normalizeLoudness(x, sr, parseFloat(o.target), -1) : DSP.limit(x, sr, -0.3);
      await step('変換後の音を分析しています…', 0.95);
      S.proc = x;
      S.procMeta = { ...o, a: a / sr, b: b / sr };
      S.procAnalysis = DSP.analyze(x, sr);
      player.pos.proc = 0; S.ab = 'proc'; syncAb();
      $('secExport').classList.remove('hidden');
      waveProc.setData(x, sr);
      paint('proc', 0);
      $('procInfo').textContent = S.sel ? `選択範囲 ${fmt(S.sel.a)}〜${fmt(S.sel.b)} を変換` : '全体を変換';
      renderCompare(before, S.procAnalysis);
      setupVideoExport();
      setProgress('convProg', null);
      setStatus('convStatus', '変換しました。STEP 4 で聞きくらべできます。');
      $('secExport').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      console.error(err);
      setProgress('convProg', null);
      setStatus('convStatus', '変換に失敗しました：' + err.message, true);
    } finally { btn.disabled = false; }
  };

  function renderCompare(b, a) {
    const f = (v, d = 1) => (isFinite(v) ? v.toFixed(d) : '—');
    const card = (k, x, y, unit) => `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(y)}<small>${esc(unit)}</small></div><div class="d arrow">変換前 ${esc(x)}${esc(unit)}</div></div>`;
    $('compare').innerHTML = [
      card('長さ', fmt(b.duration), fmt(a.duration), ''),
      card('声の高さ', b.f0Median ? Math.round(b.f0Median) : '—', a.f0Median ? Math.round(a.f0Median) : '—', 'Hz'),
      card('音量', f(b.lufs), f(a.lufs), 'LUFS'),
      // ノイズは音量を上げると一緒に上がるので、絶対値ではなく「声との差」で比べる
      card('声とノイズの差', snr(b), snr(a), 'dB'),
    ].join('');
  }

  // ================= 書き出し =================
  const outName = (ext) => `${baseName(S.name)}_変換.${ext}`;
  $('expWav').onclick = () => download(new Blob([DSP.encodeWav(S.proc, S.sr)], { type: 'audio/wav' }), outName('wav'));

  const LAME = 'https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js';
  const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
  async function encodeMp3(x, sr, onProg) {
    await loadScript(LAME);
    if (!MP3_RATES.includes(sr)) { x = await resampleOffline(x, sr, 48000); sr = 48000; }
    const enc = new window.lamejs.Mp3Encoder(1, sr, 160), parts = [], block = 1152;
    for (let i = 0, k = 0; i < x.length; i += block, k++) {
      const n = Math.min(block, x.length - i), s = new Int16Array(n);
      for (let j = 0; j < n; j++) { const v = Math.max(-1, Math.min(1, x[i + j])); s[j] = v < 0 ? v * 32768 : v * 32767; }
      const m = enc.encodeBuffer(s);
      if (m.length) parts.push(m);
      if (k % 400 === 0) { onProg(i / x.length); await tick(); }
    }
    parts.push(enc.flush());
    return new Blob(parts, { type: 'audio/mpeg' });
  }
  $('expMp3').onclick = async () => {
    const btn = $('expMp3'); btn.disabled = true;
    try {
      setStatus('expStatus', 'MP3に変換しています…');
      const blob = await encodeMp3(S.proc, S.sr, (p) => setProgress('expProg', p));
      download(blob, outName('mp3'));
      setStatus('expStatus', 'MP3を保存しました。');
    } catch (err) {
      setStatus('expStatus', 'MP3の作成に失敗しました（インターネット接続が必要です）：' + err.message, true);
    } finally { setProgress('expProg', null); btn.disabled = false; }
  };

  function setupVideoExport() {
    const b = $('expVideo'), note = $('videoNote');
    b.classList.toggle('hidden', !S.isVideo);
    note.textContent = '';
    if (!S.isVideo) return;
    if (S.procMeta.cut) {
      b.disabled = true;
      note.textContent = '「無音をつめる」を使うと映像と長さが合わなくなるため、動画での書き出しはできません。動画にしたいときは無音をつめずに変換してください。';
    } else {
      b.disabled = false;
      note.textContent = '動画は再生しながら録画して作るため、動画の長さぶん時間がかかります。書き出し中はこのタブを表示したままにしてください。' + (S.procMeta.speed !== 1 ? `映像も ${S.procMeta.speed.toFixed(2)} 倍速になります。` : '');
    }
  }
  $('expVideo').onclick = async () => {
    const btn = $('expVideo'); btn.disabled = true; player.stop();
    const m = S.procMeta;
    const v = document.createElement('video');
    // 画面外や非表示の動画は再生を止めるブラウザがあるので、見えない大きさで画面内に置く
    v.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:.01;pointer-events:none';
    let timer = 0, drawTimer = 0;
    try {
      v.src = S.videoUrl; v.muted = true; v.playsInline = true; v.preload = 'auto';
      document.body.appendChild(v);
      await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('動画を開けません')); });
      v.currentTime = m.a;
      await new Promise((res) => { v.onseeked = res; });
      // 映像は動画要素から直接取り込む（画面の描画に頼らないので、タブが裏に回っても止まりにくい）
      let videoTrack = v.captureStream ? v.captureStream().getVideoTracks()[0] : null;
      if (!videoTrack) {
        const scale = Math.min(1, 1920 / Math.max(v.videoWidth, v.videoHeight));
        const cv = document.createElement('canvas');
        cv.width = Math.round(v.videoWidth * scale / 2) * 2; cv.height = Math.round(v.videoHeight * scale / 2) * 2;
        const g = cv.getContext('2d');
        g.drawImage(v, 0, 0, cv.width, cv.height);
        drawTimer = setInterval(() => g.drawImage(v, 0, 0, cv.width, cv.height), 1000 / 30);
        videoTrack = cv.captureStream(30).getVideoTracks()[0];
      }
      const ctx = ac(), dest = ctx.createMediaStreamDestination();
      const src = ctx.createBufferSource(); src.buffer = player.buffer(S.proc, S.sr); src.connect(dest);
      const stream = new MediaStream([videoTrack, ...dest.stream.getAudioTracks()]);
      const mime = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
        .find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
      if (!mime) throw new Error('このブラウザは動画の録画に対応していません');
      const mr = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8e6, audioBitsPerSecond: 192e3 });
      const chunks = [];
      mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      const done = new Promise((res) => { mr.onstop = res; });
      v.playbackRate = m.speed;
      mr.start(1000);
      await v.play();
      src.start();
      setStatus('expStatus', '動画を書き出しています…');
      await new Promise((res) => {
        const check = () => {
          setProgress('expProg', (v.currentTime - m.a) / (m.b - m.a));
          if (v.ended || v.currentTime >= m.b - 0.01) res();
        };
        timer = setInterval(check, 50);
        v.ontimeupdate = check;
        v.onended = res;
      });
      v.pause(); try { src.stop(); } catch { /* 終了済み */ }
      mr.stop(); await done;
      const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
      download(new Blob(chunks, { type: mime.split(';')[0] }), outName(ext));
      setStatus('expStatus', `動画（${ext}）を保存しました。`);
    } catch (err) {
      console.error(err);
      setStatus('expStatus', '動画の書き出しに失敗しました：' + err.message, true);
    } finally {
      clearInterval(timer); clearInterval(drawTimer);
      v.removeAttribute('src'); v.remove();
      setProgress('expProg', null); btn.disabled = false;
    }
  };

  // ================= Gemini =================
  const cfg = {
    get key() { return store.get('key', ''); },
    get ttsModel() { return store.get('ttsModel', 'gemini-3.8-flash-tts'); },
    get aiModel() { return store.get('aiModel', 'gemini-3.8-flash'); },
  };
  const modelId = (m) => m.trim().replace(/^models\//, '');
  async function gemini(model, body) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId(model))}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.key }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
    return j;
  }
  // 読み上げのエラーを、何をすればよいか分かる日本語にする
  function ttsErrorText(msg, cast) {
    if (/rate limit|quota|too many|HTTP 429/i.test(msg)) {
      const lim = (msg.match(/limit:\s*(\d+)\s*requests per (day|minute)/i) || []);
      return `今の読み上げモデル（${modelId(cfg.ttsModel)}）の無料枠${lim[1] ? `（1${lim[2] === 'day' ? '日' : '分'}${lim[1]}回）` : ''}を使い切りました。⚙設定で別の読み上げモデル（例：gemini-3.8-flash-lite-tts）に切り替えるか、時間をおいてもう一度試してください。`;
    }
    if (/voice was not found|does not have permission/i.test(msg)) {
      const mine = (cast || []).filter((c) => isMyVoice(c.voice)).map((c) => `「${c.who}」＝${(myVoices().find((v) => v.id === c.voice) || {}).name || c.voice}`).join('、');
      return `声が見つかりませんでした${mine ? `（自分の声：${mine}）` : ''}。作った直後は数分使えないことがあります。少し待つか、「登録した声」の「一覧を更新」を押してから声を選び直してください。`;
    }
    if (/safety|blocked|prohibited/i.test(msg)) return `内容が Google の利用ポリシーに引っかかった可能性があります（${msg}）。台本の表現を見直してください。`;
    return msg;
  }

  // Gemini 3 系の TTS は新しい interactions 形式（generateContent では2人の掛け合いが通らない）
  const usesInteractions = (m) => version(modelId(m)) >= 3;
  async function geminiInteraction(body) {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.key }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
    return j;
  }
  // 混雑（high demand / 429 / 503）のときは少し待って再試行し、だめなら一覧の次のモデルに切り替える
  const busy = (m) => /high demand|overloaded|unavailable|resource.?exhausted|try again later|HTTP (429|503)/i.test(m);
  async function geminiText(body) {
    let cached = null;
    try { cached = JSON.parse(store.get('models', '')); } catch { /* 一覧なし */ }
    const models = [...new Set([modelId(cfg.aiModel), ...((cached && cached.ai) || []).slice(0, 4), 'gemini-2.5-flash'])];
    let last;
    for (const m of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try { return { res: await gemini(m, body), model: m }; } catch (err) {
          last = err;
          if (!busy(err.message)) throw err;
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        }
      }
    }
    throw last;
  }
  function needKey() {
    if (cfg.key) return false;
    openSettings('AI機能を使うには、Gemini の APIキーを入れてください。');
    return true;
  }
  const version = (n) => { const m = n.match(/gemini-(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; };
  // 新しい版 → 標準（lite でない）→ flash → 正式版（preview でない）の順に並べる
  const rank = (a, b) => version(b) - version(a) || (/lite/.test(a) - /lite/.test(b)) || (b.includes('flash') - a.includes('flash')) || (a.includes('preview') - b.includes('preview'));
  const NOT_FOR_US = /image|embed|live|native-audio|computer-use|robotics|customtools|transcribe|omni|aqa|learnlm/i;
  function fillModels(sel, names, current) {
    const list = names.includes(current) || !current ? names : [current, ...names];
    sel.innerHTML = list.map((n) => `<option value="${esc(n)}">${esc(n)}${n === names[0] ? '（最新）' : ''}</option>`).join('');
    sel.value = current && list.includes(current) ? current : (list[0] || '');
  }
  function cachedModels() { try { return JSON.parse(store.get('models', '')) || null; } catch { return null; } }
  async function listModels() {
    setStatus('modelStatus', '取得中…');
    try {
      const key = $('s_key').value.trim() || cfg.key;
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', { headers: { 'x-goog-api-key': key } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
      const gen = (j.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => m.name.replace(/^models\//, ''));
      const tts = gen.filter((n) => /tts/i.test(n)).sort(rank);
      const ai = gen.filter((n) => /^gemini/.test(n) && !/tts/i.test(n) && !NOT_FOR_US.test(n)).sort(rank);
      store.set('models', JSON.stringify({ tts, ai }));
      // 「取得」を押したときは最新を選ぶ（別のモデルにしたいときはプルダウンで変えてから保存）
      fillModels($('s_tts'), tts, tts[0]);
      fillModels($('s_ai'), ai, ai[0]);
      setStatus('modelStatus', `読み上げ用 ${tts.length} 件・分析用 ${ai.length} 件を取得しました。いちばん新しいものを選んであります。`);
    } catch (err) { setStatus('modelStatus', '取得できませんでした：' + err.message, true); }
  }
  function openSettings(msg) {
    const m = cachedModels() || { tts: [], ai: [] };
    $('s_key').value = cfg.key;
    fillModels($('s_tts'), m.tts, cfg.ttsModel);
    fillModels($('s_ai'), m.ai, cfg.aiModel);
    setStatus('modelStatus', msg || '', !!msg);
    $('settings').showModal();
  }
  $('openSettings').onclick = () => openSettings();
  $('listModels').onclick = listModels;
  $('saveSettings').onclick = () => {
    store.set('key', $('s_key').value.trim());
    if ($('s_tts').value.trim()) store.set('ttsModel', modelId($('s_tts').value));
    if ($('s_ai').value.trim()) store.set('aiModel', modelId($('s_ai').value));
  };

  const blobToBase64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
  function base64ToBytes(b64) { const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
  function parseJsonLoose(t) {
    try { return JSON.parse(t); } catch { /* 前後に余計な文字がある場合 */ }
    const m = t.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* 下で扱う */ } }
    return null;
  }

  const AI_PROMPT = `この音声を聞いて、次の形のJSONだけを返してください。
{"transcript":"話した内容の文字起こし（話し言葉のまま、句読点あり）",
 "summary":"話の要点を1〜2文で",
 "delivery":{"speed":"話す速さの印象","clarity":"聞き取りやすさ（滑舌・声量）","tone":"声の印象や感情"},
 "advice":["話し方をよくする具体的なアドバイス（3つ）"]}
話し声が入っていない場合は transcript を空にして、summary にその旨を書いてください。日本語で答えてください。`;

  $('aiAnalyze').onclick = async () => {
    if (needKey()) return;
    const btn = $('aiAnalyze'); btn.disabled = true;
    $('aiOut').innerHTML = '';
    try {
      const [a, b] = rangeSamples(), maxSec = 420;
      let x = S.mono.subarray(a, b), note = '';
      if (x.length / S.sr > maxSec) { x = x.subarray(0, maxSec * S.sr); note = '（長いので最初の7分だけ送りました）'; }
      setStatus('aiStatus', 'AIに送る準備をしています…');
      const x16 = await resampleOffline(x, S.sr, 16000);
      const b64 = await blobToBase64(new Blob([DSP.encodeWav(x16, 16000)]));
      const t0 = Date.now(), iv = setInterval(() => setStatus('aiStatus', `AIが聞いています…（${Math.round((Date.now() - t0) / 1000)}秒）`), 500);
      let res, usedModel;
      try {
        ({ res, model: usedModel } = await geminiText({
          contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: b64 } }, { text: AI_PROMPT }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
        }));
      } finally { clearInterval(iv); }
      const text = (res.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
      const j = parseJsonLoose(text);
      if (!j) throw new Error('AIの返答を読み取れませんでした');
      const speechMin = DSP.analyzeLevels(x, S.sr).speechSec / 60;
      const chars = String(j.transcript || '').replace(/[\s、。，．,.!?！？「」『』（）()・…]/g, '').length;
      const cpm = speechMin > 0.05 && chars ? Math.round(chars / speechMin) : 0;
      const d = j.delivery || {};
      $('aiOut').innerHTML = `
        ${j.transcript ? `<div><h4>文字起こし</h4><div class="transcript">${esc(j.transcript)}</div></div>` : ''}
        ${j.summary ? `<div><h4>要点</h4><div>${esc(j.summary)}</div></div>` : ''}
        <dl class="kv">
          ${cpm ? `<dt>話す速さ（実測）</dt><dd>${cpm} 字/分（ニュースの読み上げは約300字/分が目安）</dd>` : ''}
          ${d.speed ? `<dt>速さの印象</dt><dd>${esc(d.speed)}</dd>` : ''}
          ${d.clarity ? `<dt>聞き取りやすさ</dt><dd>${esc(d.clarity)}</dd>` : ''}
          ${d.tone ? `<dt>声の印象</dt><dd>${esc(d.tone)}</dd>` : ''}
        </dl>
        ${Array.isArray(j.advice) && j.advice.length ? `<div><h4>アドバイス</h4><ol>${j.advice.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></div>` : ''}`;
      setStatus('aiStatus', `完了（${usedModel}）${note}`);
    } catch (err) {
      setStatus('aiStatus', 'AI分析に失敗しました：' + err.message, true);
    } finally { btn.disabled = false; }
  };

  // ================= 台本から声を作る =================
  const VOICES = [['Kore', 'しっかり'], ['Puck', '弾む'], ['Zephyr', '明るい'], ['Charon', '落ち着いた解説'], ['Fenrir', '興奮ぎみ'], ['Leda', '若々しい'], ['Orus', 'しっかり'], ['Aoede', '軽やか'], ['Callirrhoe', 'おおらか'], ['Autonoe', '明るい'], ['Enceladus', '息まじり'], ['Iapetus', 'クリア'], ['Umbriel', 'おおらか'], ['Algieba', 'なめらか'], ['Despina', 'なめらか'], ['Erinome', 'クリア'], ['Algenib', 'ざらつき'], ['Rasalgethi', '解説向き'], ['Laomedeia', '弾む'], ['Achernar', 'やわらか'], ['Alnilam', 'しっかり'], ['Schedar', '平坦'], ['Gacrux', '大人びた'], ['Pulcherrima', '前に出る'], ['Achird', '親しみ'], ['Zubenelgenubi', 'くだけた'], ['Vindemiatrix', 'やさしい'], ['Sadachbia', '生き生き'], ['Sadaltager', '知的'], ['Sulafat', 'あたたかい']];
  const SAMPLE1 = [
    { sp: 0, dir: 'ゆっくり落ち着いて', text: 'このナレーションは、AIが台本から作った声です。' },
    { sp: 0, dir: '元気よく', text: '1行ずつ、演技をつけることができます。' },
    { sp: 0, dir: 'ささやくように', text: 'ここだけの話、声の雰囲気も文章で決められるんです。' },
  ];
  const SAMPLE2 = [
    { sp: 0, dir: 'ささやくように', text: 'ねえ、ここだけの話なんだけど。' },
    { sp: 1, dir: '驚いて', text: 'え、それ本当に？' },
    { sp: 0, dir: 'ため息まじりに', text: 'はぁ……締め切りが一週間早まったんだって。' },
    { sp: 1, dir: '笑いながら', text: 'じゃあ今夜は、コーヒー多めでいこうか。' },
  ];
  // 英語の見本と、謝罪会見の見本
  const APOLOGY_JA = [
    { sp: 0, dir: '深刻に、ゆっくり', text: 'このたびは、私の軽率な行動により、皆さまに多大なるご心配をおかけしましたこと、深くお詫び申し上げます。' },
    { sp: 1, dir: '早口で詰め寄る', text: '具体的に何をしたのか、ご自身の口で説明してください！' },
    { sp: 0, dir: '声を震わせて', text: '……冷蔵庫にあった、家族共有のプリンを、食べました。' },
    { sp: 1, dir: '驚いて', text: '共有のプリンを！？ ふたに名前は書いてあったんですか？' },
    { sp: 0, dir: '小声で、言い訳がましく', text: '「ママ」と……書いてあったような、なかったような。' },
    { sp: 1, dir: '厳しく', text: '書いてあったんですね？' },
    { sp: 0, dir: '間をたっぷり取って', text: '……書いてありました。' },
    { sp: 1, dir: '冷静に', text: '食べたのは一つですか？' },
    { sp: 0, dir: 'ため息まじりに', text: '本日の会見の前に、もう一つ……反省の意味を込めて。' },
    { sp: 1, dir: 'あきれて', text: '反省の意味で、なぜもう一つ食べるんですか！' },
    { sp: 0, dir: '急に明るく', text: '味の確認は、再発防止の第一歩ですので。' },
    { sp: 1, dir: '笑いをこらえながら', text: '……今後の対応は？' },
    { sp: 0, dir: '深々と頭を下げるように', text: '明日、同じプリンを三つ買って返します。一つは、記者の皆さまに。' },
  ];
  const SAMPLE1_EN = [
    { sp: 0, dir: 'warm and welcoming', text: 'This narration was not recorded by a person. It was generated from a script.' },
    { sp: 0, dir: 'excited', text: 'Every single line can have its own direction.' },
    { sp: 0, dir: 'whispering', text: 'And here is a little secret: you can even describe the voice you want.' },
  ];
  const SAMPLE2_EN = [
    { sp: 0, dir: 'whispering', text: 'Hey, can I tell you something? Just between us.' },
    { sp: 1, dir: 'surprised', text: 'Wait, what? Is this about the deadline?' },
    { sp: 0, dir: 'with a sigh', text: 'They moved it up. By a whole week.' },
    { sp: 1, dir: 'laughing', text: 'Then I guess tonight is a double espresso kind of night.' },
  ];
  const APOLOGY_EN = [
    { sp: 0, dir: 'grave and slow', text: 'I would like to sincerely apologize for the concern my careless actions have caused.' },
    { sp: 1, dir: 'pressing, fast', text: 'Tell us exactly what you did. In your own words.' },
    { sp: 0, dir: 'voice trembling', text: 'I... ate the pudding. The one in the fridge. The family pudding.' },
    { sp: 1, dir: 'shocked', text: 'The family pudding?! Was there a name on the lid?' },
    { sp: 0, dir: 'quietly, making excuses', text: 'It may have said "Mom"... or it may not have.' },
    { sp: 1, dir: 'sternly', text: 'So it did say "Mom".' },
    { sp: 0, dir: 'after a long pause', text: '...It said "Mom".' },
    { sp: 1, dir: 'calmly', text: 'Did you eat just one?' },
    { sp: 0, dir: 'with a sigh', text: 'Before this press conference, I had another one... as a sign of reflection.' },
    { sp: 1, dir: 'exasperated', text: 'Why would you eat another one as a sign of reflection?!' },
    { sp: 0, dir: 'suddenly cheerful', text: 'Tasting it is the first step in preventing it from happening again.' },
    { sp: 1, dir: 'trying not to laugh', text: '...And your plan going forward?' },
    { sp: 0, dir: 'bowing deeply', text: 'Tomorrow, I will buy three puddings and return them. One of them is for the press.' },
  ];
  // 中国語（簡体字・普通話）
  const SAMPLE1_ZH = [
    { sp: 0, dir: '温暖亲切地', text: '这段旁白不是真人录的，而是根据剧本生成的。' },
    { sp: 0, dir: '兴奋地', text: '每一句台词，都可以有自己的表演指示。' },
    { sp: 0, dir: '像说悄悄话一样', text: '偷偷告诉你：连声音的感觉，也能用文字来描述。' },
  ];
  const SAMPLE2_ZH = [
    { sp: 0, dir: '小声地', text: '喂，跟你说个秘密，别告诉别人。' },
    { sp: 1, dir: '惊讶地', text: '啊？真的假的？' },
    { sp: 0, dir: '叹着气', text: '唉……截止日期提前了整整一个星期。' },
    { sp: 1, dir: '笑着', text: '那今晚咖啡得多来几杯了。' },
  ];
  const APOLOGY_ZH = [
    { sp: 0, dir: '沉重而缓慢地', text: '对于我的轻率行为给大家带来的困扰，我在此深表歉意。' },
    { sp: 1, dir: '语速很快地逼问', text: '请您亲口说明，您到底做了什么！' },
    { sp: 0, dir: '声音颤抖', text: '……我把冰箱里，全家共享的布丁，吃掉了。' },
    { sp: 1, dir: '震惊地', text: '全家共享的布丁？！盖子上写名字了吗？' },
    { sp: 0, dir: '小声地，找借口似的', text: '好像写着“妈妈”……又好像没写。' },
    { sp: 1, dir: '严厉地', text: '写了，对吧？' },
    { sp: 0, dir: '停顿很久之后', text: '……写了。' },
    { sp: 1, dir: '冷静地', text: '您只吃了一个吗？' },
    { sp: 0, dir: '叹着气', text: '在今天的记者会之前，我又吃了一个……以示反省。' },
    { sp: 1, dir: '无奈地', text: '为了反省，为什么还要再吃一个！' },
    { sp: 0, dir: '突然开朗地', text: '确认味道，是防止再次发生的第一步。' },
    { sp: 1, dir: '忍着笑', text: '……那今后打算怎么处理？' },
    { sp: 0, dir: '深深鞠躬', text: '明天，我会买三个同样的布丁还回去。其中一个，送给各位记者。' },
  ];
  const SAMPLES = {
    ja: [
      { title: 'ナレーション', note: '1人・3行', mode: 1, personas: ['落ち着いた40代の女性ナレーター'], lines: SAMPLE1 },
      { title: '日常の掛け合い', note: '2人・4行', mode: 2, personas: ['落ち着いた30代の女性。やわらかく話す', '明るく人なつっこい20代の男性'], lines: SAMPLE2 },
      { title: '謝罪会見（プリンの件）', note: '2人・13行・名前を「自分／記者」にします', mode: 2, names: ['自分', '記者'], personas: ['', 'ワイドショーの記者。早口で詰め寄る'], style: 'テレビの謝罪会見。張りつめた空気だが、どこか間が抜けている', lines: APOLOGY_JA },
    ],
    en: [
      { title: 'Narration', note: '1人・3行', mode: 1, personas: ['a calm, warm narrator'], lines: SAMPLE1_EN },
      { title: 'Everyday chat', note: '2人・4行', mode: 2, personas: ['a calm woman in her 30s who speaks softly', 'a cheerful, friendly young man'], lines: SAMPLE2_EN },
      { title: 'Press conference (the pudding)', note: '2人・13行・名前を「Me／Reporter」にします', mode: 2, names: ['Me', 'Reporter'], personas: ['', 'a pushy tabloid reporter'], style: 'A televised apology press conference. Tense, but slightly absurd.', lines: APOLOGY_EN },
    ],
    zh: [
      { title: '旁白', note: '1人・3行（ナレーション）', mode: 1, personas: ['沉稳温暖的旁白'], lines: SAMPLE1_ZH },
      { title: '日常对话', note: '2人・4行（日常の掛け合い）', mode: 2, personas: ['说话温柔的三十多岁女性', '开朗热情的二十多岁男生'], lines: SAMPLE2_ZH },
      { title: '道歉记者会（布丁事件）', note: '2人・13行・名前を「我／记者」にします（謝罪会見）', mode: 2, names: ['我', '记者'], personas: ['', '咄咄逼人的八卦记者'], style: '电视上的道歉记者会。气氛紧张，但有点滑稽。', lines: APOLOGY_ZH },
    ],
  };
  const LANG = {
    ja: { persona: '例：落ち着いた40代の女性ナレーター', style: '例：深夜ラジオのような、親しみのあるトーン', name: '日本語' },
    en: { persona: 'e.g. a calm narrator in her 40s', style: 'e.g. a friendly late-night radio show', name: '英語' },
    zh: { persona: '例：沉稳的四十多岁女性旁白', style: '例：像深夜电台一样，亲切的语气', name: '中国語' },
  };

  const T = (() => {
    try { const j = JSON.parse(store.get('tts', '')); if (j && Array.isArray(j.lines)) return j; } catch { /* 初回 */ }
    return {
      mode: 2, style: '', lines: SAMPLE2.map((l) => ({ ...l })),
      speakers: [{ name: 'ハル', voice: 'Kore', desc: '落ち着いた30代の女性。やわらかく話す' }, { name: 'ソラ', voice: 'Puck', desc: '明るく人なつっこい20代の男性' }],
    };
  })();
  if (!['ja', 'en', 'zh'].includes(T.lang)) T.lang = 'ja';
  const saveT = () => store.set('tts', JSON.stringify(T));
  let mvReady = false; // 「自分の声」の欄を組み立て終えたか

  // 自分の声（Voice Replication で作った声）。期限切れのものは除く
  const myVoices = () => {
    let v = [];
    try { v = JSON.parse(store.get('myVoices', '[]')) || []; } catch { v = []; }
    return v.filter((x) => !x.expires || x.expires > Date.now());
  };
  const saveMyVoices = (v) => store.set('myVoices', JSON.stringify(v));
  const isMyVoice = (v) => /^voice(key)?_/.test(v || '');

  function voiceOptions(current) {
    const mine = myVoices();
    const known = VOICES.some(([v]) => v === current) || mine.some((m) => m.id === current);
    const opt = (v, label) => `<option value="${esc(v)}" ${v === current ? 'selected' : ''}>${esc(label)}</option>`;
    return (current && !known ? opt(current, `${current}（一覧外）`) : '')
      + (mine.length ? `<optgroup label="自分の声">${mine.map((m) => opt(m.id, `🎙 ${m.name}`)).join('')}</optgroup>` : '')
      + `<optgroup label="標準の声">${VOICES.map(([v, d]) => opt(v, `${v}（${d}）`)).join('')}</optgroup>`;
  }

  // 演技指示の候補メニュー（ブラウザ標準の datalist は位置がずれるので自前で出す）
  // 分類つきの候補。欄には自由に書ける（ここにない指示もそのままAIに渡る）
  const DIRECTIONS_EN = [
    ['気持ち', ['seriously', 'apologetically', 'voice trembling', 'surprised', 'shocked', 'angry', 'exasperated', 'sad', 'shyly', 'excited', 'suddenly cheerful', 'laughing', 'trying not to laugh', 'with a sigh', 'sleepy']],
    ['速さ・間', ['slowly and calmly', 'grave and slow', 'fast', 'rapid-fire', 'after a long pause', 'hesitantly']],
    ['声の大きさ', ['whispering', 'quietly', 'quietly, making excuses', 'loudly', 'shouting']],
    ['話し方・場面', ['pressing, fast', 'sternly', 'calmly', 'making excuses', 'bowing deeply', 'warm and welcoming', 'like a news anchor', 'like a sports commentator']],
  ];
  const DIRECTIONS_ZH = [
    ['気持ち', ['沉重地', '满怀歉意地', '声音颤抖', '惊讶地', '震惊地', '生气地', '无奈地', '伤心地', '害羞地', '兴奋地', '突然开朗地', '笑着', '忍着笑', '叹着气', '困倦地']],
    ['速さ・間', ['缓慢而平静地', '沉重而缓慢地', '语速很快', '连珠炮似的', '停顿很久之后', '犹豫地']],
    ['声の大きさ', ['像说悄悄话一样', '小声地', '小声地，找借口似的', '大声地', '喊叫着']],
    ['話し方・場面', ['语速很快地逼问', '严厉地', '冷静地', '找借口似的', '深深鞠躬', '温暖亲切地', '像新闻主播一样', '像体育解说一样']],
  ];
  const DIRECTIONS = [
    ['気持ち', ['深刻に', '申し訳なさそうに', '声を震わせて', '驚いて', '怒って', 'あきれて', '悲しげに', '照れながら', '元気よく', '急に明るく', '笑いながら', '笑いをこらえながら', 'ため息まじりに', '眠そうに']],
    ['速さ・間', ['ゆっくり落ち着いて', '深刻に、ゆっくり', '早口で', 'たたみかけるように', '間をたっぷり取って', '言いよどみながら']],
    ['声の大きさ', ['ささやくように', '小声で', '小声で、言い訳がましく', '大きな声で', '叫ぶように']],
    ['話し方・場面', ['早口で詰め寄る', '厳しく', '冷静に', '言い訳がましく', '深々と頭を下げるように', 'やさしく語りかけるように', 'ニュースキャスター風に', '実況中継のように']],
  ];
  const sug = document.createElement('div');
  sug.className = 'suggest hidden'; sug.setAttribute('role', 'listbox');
  document.body.appendChild(sug);
  let sugInput = null, sugIdx = -1;
  function hideSuggest() { sug.classList.add('hidden'); sugInput = null; sugIdx = -1; }
  function showSuggest(input, groups) {
    const q = input.value.trim();
    const all = groups.flatMap(([, items]) => items);
    const btn = (d) => `<button type="button" role="option">${esc(d)}</button>`;
    let html;
    if (!q || all.includes(q)) {
      html = groups.map(([name, items]) => `<div class="sg-head">${esc(name)}</div>${items.map(btn).join('')}`).join('');
    } else {
      const hits = all.filter((d) => d.includes(q));
      if (!hits.length) { hideSuggest(); return; }
      html = hits.map(btn).join('');
    }
    sugInput = input; sugIdx = -1;
    sug.innerHTML = html + '<div class="sg-foot">候補にない指示も、そのまま入力できます</div>';
    const r = input.getBoundingClientRect();
    sug.style.left = `${r.left + window.scrollX}px`;
    sug.style.top = `${r.bottom + window.scrollY + 4}px`;
    sug.style.minWidth = `${r.width}px`;
    sug.classList.remove('hidden');
    sug.querySelectorAll('button').forEach((b) => {
      b.onmousedown = (e) => e.preventDefault(); // 入力欄からフォーカスを外さない
      b.onclick = () => pick(b.textContent);
    });
  }
  function pick(v) {
    const input = sugInput;
    if (!input) return;
    input.value = v;
    input.dispatchEvent(new Event('input'));
    hideSuggest();
  }
  function attachSuggest(input, items) {
    input.addEventListener('focus', () => showSuggest(input, items));
    input.addEventListener('click', () => showSuggest(input, items));
    input.addEventListener('input', () => { if (sugInput === input || document.activeElement === input) showSuggest(input, items); });
    input.addEventListener('blur', () => setTimeout(() => { if (sugInput === input) hideSuggest(); }, 0));
    input.addEventListener('keydown', (e) => {
      if (sug.classList.contains('hidden') || sugInput !== input) return;
      const bs = [...sug.querySelectorAll('button')];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        sugIdx = (sugIdx + (e.key === 'ArrowDown' ? 1 : -1) + bs.length) % bs.length;
        bs.forEach((b, i) => b.classList.toggle('active', i === sugIdx));
        bs[sugIdx].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter' && sugIdx >= 0) { e.preventDefault(); pick(bs[sugIdx].textContent); }
      else if (e.key === 'Escape') hideSuggest();
    });
  }
  window.addEventListener('resize', hideSuggest);

  const SPEAKER_COLORS = ['#2433E0', '#E0413A'];
  // 人物像の下の一言。自分の声に別人の人物像が付いていたら注意する
  const hasKana = (t) => /[\u3040-\u30ff]/.test(t || '');
  function castHint(s) {
    if (T.lang !== 'ja' && hasKana(s.desc)) return ['warn', `人物像が日本語です。${LANG[T.lang].name}の台本では日本語読みが混ざる原因になるので、${LANG[T.lang].name}で書くか空欄にしてください`];
    if (isMyVoice(s.voice) && T.lang === 'zh') return ['', '日本語の録音から作った声は、中国語の中に日本語読みが混ざることがあります。気になる場合は標準の声を選んでください'];
    if (isMyVoice(s.voice) && s.desc.trim()) return ['warn', '自分の声を選んでいます。人物像は空欄がおすすめです（声の質は録音から決まるので、別人の設定は食い違いのもとになります）'];
    if (isMyVoice(s.voice)) return ['', '自分の声で読みます。話し方の調子は台本の演技指示で付けられます'];
    return ['', '人物像は、各行の演技指示と一緒にAIへ渡します'];
  }
  function renderSpeakers() {
    const n = T.mode === 2 ? 2 : 1;
    $('speakers').classList.toggle('one', n === 1);
    $('speakers').innerHTML = T.speakers.slice(0, n).map((s, i) => `
      <div class="cast-card" style="--c:${SPEAKER_COLORS[i]}">
        <div class="who"><span class="dot"></span>${n === 2 ? `<input type="text" data-sp="${i}" data-k="name" value="${esc(s.name)}" placeholder="名前" aria-label="話す人の名前">` : 'ナレーター'}</div>
        <label class="field"><span>声</span><select data-sp="${i}" data-k="voice">${voiceOptions(s.voice)}</select></label>
        <label class="field"><span>人物像（任意）</span><input type="text" data-sp="${i}" data-k="desc" value="${esc(s.desc)}" placeholder="${esc(LANG[T.lang].persona)}"></label>
        <p class="hint" data-hint="${i}"></p>
      </div>`).join('');
    $('speakers').querySelectorAll('[data-sp]').forEach((el) => el.oninput = () => {
      const i = +el.dataset.sp;
      T.speakers[i][el.dataset.k] = el.value;
      if (el.dataset.k === 'name') renderLines();
      saveT();
      if (el.dataset.k !== 'name') paintHint(i); // 入力欄は描き直さず、注意書きだけ書き換える（カーソルが外れないように）
    });
    for (let i = 0; i < n; i++) paintHint(i);
  }
  function paintHint(i) {
    const h = $('speakers').querySelector(`[data-hint="${i}"]`);
    if (!h) return;
    const [hc, ht] = castHint(T.speakers[i]);
    h.className = `hint ${hc}`;
    h.innerHTML = esc(ht) + (hc === 'warn' ? ' <button type="button" class="linkbtn">空欄にする</button>' : '');
    const b = h.querySelector('button');
    if (b) b.onclick = () => {
      T.speakers[i].desc = ''; saveT();
      const inp = $('speakers').querySelector(`[data-sp="${i}"][data-k="desc"]`);
      if (inp) inp.value = '';
      paintHint(i);
    };
  }
  function renderLines() {
    const two = T.mode === 2;
    $('script').classList.toggle('one', !two);
    $('lines').innerHTML = T.lines.map((l, i) => `
      <div class="line" data-i="${i}">
        <span class="no">${i + 1}</span>
        ${two ? `<select data-k="sp" style="--c:${SPEAKER_COLORS[l.sp] || SPEAKER_COLORS[0]}" aria-label="話す人">${T.speakers.slice(0, 2).map((s, j) => `<option value="${j}" ${l.sp === j ? 'selected' : ''}>${esc(s.name || `話者${j + 1}`)}</option>`).join('')}</select>` : ''}
        <input type="text" class="dir-input" data-k="dir" value="${esc(l.dir)}" placeholder="自由に入力／候補から選ぶ" autocomplete="off">
        <textarea rows="1" data-k="text" placeholder="セリフ">${esc(l.text)}</textarea>
        <button class="del" title="この行を消す" aria-label="この行を消す">×</button>
      </div>`).join('');
    $('lines').querySelectorAll('.line').forEach((row) => {
      const i = +row.dataset.i;
      row.querySelectorAll('[data-k]').forEach((el) => el.oninput = () => {
        T.lines[i][el.dataset.k] = el.dataset.k === 'sp' ? +el.value : el.value;
        if (el.dataset.k === 'sp') el.style.setProperty('--c', SPEAKER_COLORS[+el.value]);
        saveT();
      });
      attachSuggest(row.querySelector('.dir-input'), { en: DIRECTIONS_EN, zh: DIRECTIONS_ZH }[T.lang] || DIRECTIONS);
      row.querySelector('.del').onclick = () => { T.lines.splice(i, 1); if (!T.lines.length) T.lines.push({ sp: 0, dir: '', text: '' }); renderLines(); saveT(); };
    });
  }
  function renderMode() {
    document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.mode === T.mode)));
    renderSpeakers(); renderLines();
    if (mvReady) renderMyVoices();
  }
  document.querySelectorAll('[data-mode]').forEach((b) => b.onclick = () => { T.mode = +b.dataset.mode; saveT(); renderMode(); });
  $('addLine').onclick = () => { const last = T.lines[T.lines.length - 1]; T.lines.push({ sp: T.mode === 2 && last ? 1 - last.sp : 0, dir: '', text: '' }); renderLines(); saveT(); $('lines').lastElementChild.querySelector('textarea').focus(); };
  // 見本の台本（今の言語のものをメニューで選ぶ）
  const sampleMenu = document.createElement('div');
  sampleMenu.className = 'suggest sample-menu hidden'; sampleMenu.setAttribute('role', 'menu');
  document.body.appendChild(sampleMenu);
  const hideSampleMenu = () => sampleMenu.classList.add('hidden');
  $('sampleScript').onclick = (e) => {
    e.stopPropagation();
    if (!sampleMenu.classList.contains('hidden')) { hideSampleMenu(); return; }
    const list = SAMPLES[T.lang];
    sampleMenu.innerHTML = `<div class="sg-head">${esc(LANG[T.lang].name)}の見本</div>` + list.map((smp, i) => `<button type="button" role="menuitem" data-i="${i}">${esc(smp.title)}<small>${esc(smp.note)}</small></button>`).join('')
      + '<div class="sg-foot">今の台本は置き換わります</div>';
    const r = e.currentTarget.getBoundingClientRect();
    sampleMenu.style.left = `${r.left + window.scrollX}px`;
    sampleMenu.style.top = `${r.bottom + window.scrollY + 4}px`;
    sampleMenu.style.minWidth = `${Math.max(r.width, 260)}px`;
    sampleMenu.classList.remove('hidden');
    sampleMenu.querySelectorAll('button').forEach((b) => b.onclick = () => {
      const smp = list[+b.dataset.i];
      T.mode = smp.mode;
      T.lines = smp.lines.map((l) => ({ ...l }));
      if (smp.names) smp.names.forEach((n, k) => { T.speakers[k].name = n; });
      // 人物像もその言語のものにする（自分の声の話者は空欄のまま）
      if (smp.personas) smp.personas.forEach((d, k) => { T.speakers[k].desc = isMyVoice(T.speakers[k].voice) ? '' : d; });
      T.style = smp.style || ''; $('ttsStyle').value = T.style; paintStyleHint(); // 見本を選んだら雰囲気もその見本のものにする
      saveT(); renderMode(); hideSampleMenu();
    });
  };
  document.addEventListener('click', (e) => { if (!sampleMenu.contains(e.target)) hideSampleMenu(); });
  window.addEventListener('resize', hideSampleMenu);

  // 読み上げる言語
  function paintStyleHint() {
    const h = $('styleHint');
    if (T.lang !== 'ja' && hasKana(T.style)) {
      h.className = 'hint warn';
      h.innerHTML = `全体の雰囲気が日本語です。${esc(LANG[T.lang].name)}で書くか空欄にしてください（日本語読みが混ざる原因になります） <button type="button" class="linkbtn">空欄にする</button>`;
      h.querySelector('button').onclick = () => { T.style = ''; $('ttsStyle').value = ''; saveT(); paintStyleHint(); };
    } else { h.className = 'hint'; h.textContent = ''; }
  }
  function renderLang() {
    document.querySelectorAll('[data-lang]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === T.lang)));
    $('ttsStyle').placeholder = LANG[T.lang].style;
    const tag = { ja: 'ja', en: 'en', zh: 'zh-Hans' }[T.lang];
    document.querySelector('.tts-card').setAttribute('lang', tag);
    sug.setAttribute('lang', tag);
    paintStyleHint();
  }
  document.querySelectorAll('[data-lang]').forEach((b) => b.onclick = () => {
    if (T.lang === b.dataset.lang) return;
    T.lang = b.dataset.lang; saveT(); renderLang(); renderMode();
    setStatus('ttsStatus', `読み上げる言語を${LANG[T.lang].name}にしました。「見本の台本を入れる」で${LANG[T.lang].name}の見本を選べます。`);
  });
  renderLang();
  $('ttsStyle').value = T.style || '';
  $('ttsStyle').oninput = (e) => { T.style = e.target.value; saveT(); if (typeof paintStyleHint === 'function') paintStyleHint(); };
  renderMode();

  function buildTts() {
    const two = T.mode === 2;
    const sp = two ? T.speakers.slice(0, 2) : [T.speakers[0]];
    const lines = T.lines.filter((l) => l.text.trim());
    if (!lines.length) throw new Error('セリフが1行もありません');
    if (sp.some((s) => !s.voice.trim())) throw new Error('声の名前が空欄です');
    if (sp.some((s) => isMyVoice(s.voice)) && !usesInteractions(cfg.ttsModel)) throw new Error('自分の声は Gemini 3.8 の読み上げモデルでだけ使えます（⚙設定で gemini-3.8-flash-tts を選んでください）');
    if (two) {
      const names = sp.map((s) => s.name.trim());
      if (names.some((n) => !n) || names[0] === names[1]) throw new Error('2人の名前は、空欄にせず別々の名前にしてください');
      if (lines.every((l) => l.sp === lines[0].sp)) throw new Error('掛け合いモードでは、2人ともセリフが必要です（1人だけなら「1人」に切り替えてください）');
    }
    // 動画の字幕用に、生成したときの台本を控えておく（あとで台本を書き換えても動画はずれない）
    const snap = {
      lang: T.lang, multi: two, speakers: sp.map((s) => s.name.trim()),
      lines: lines.map((l) => ({ sp: two ? l.sp : 0, dir: l.dir.trim(), text: l.text.trim() })),
    };
    const style = T.style.trim();

    if (usesInteractions(cfg.ttsModel)) {
      // Gemini 3 系: interactions 形式。行ごとに「話す人」と演技指示（style）を付ける
      // 指示のつなぎ言葉も台本の言語にそろえる
      const W = { ja: ['声の人物像：', '全体の雰囲気：', '。'], en: ['Character: ', 'Overall mood: ', '. '], zh: ['人物设定：', '整体氛围：', '。'] }[T.lang];
      // 言語を指定する項目が API にないため、各行の指示の先頭で読み上げ言語を念押しする
      const LEAD = { en: 'Speak in natural English', zh: '请用标准普通话朗读，不要用日语读音' }[T.lang];
      const lineStyle = (l) => [
        LEAD,
        l.dir.trim(),
        sp[two ? l.sp : 0].desc.trim() && `${W[0]}${sp[two ? l.sp : 0].desc.trim()}`,
        style && `${W[1]}${style}`,
      ].filter(Boolean).join(W[2]);
      const content = lines.map((l) => {
        const meta = { type: 'speech_metadata' };
        if (two) meta.speaker = sp[l.sp].name.trim();
        const st = lineStyle(l);
        if (st) meta.style = st;
        return { type: 'text', text: l.text.trim(), annotations: [meta] };
      });
      const speech_config = two
        ? { mode: 'conversational', speakers: sp.map((s) => ({ speaker: s.name.trim(), voice: s.voice.trim() })) }
        : [{ voice: sp[0].voice.trim() }];
      return { api: 'interactions', snap, body: { model: modelId(cfg.ttsModel), input: [{ type: 'user_input', content }], response_format: { type: 'audio' }, generation_config: { speech_config } } };
    }

    // Gemini 2.5 系: generateContent 形式。台本を1つの文章にして渡す
    let p = {
      en: 'Read the following script aloud in English, performing each line as directed in parentheses. Do not read the directions or speaker names aloud.\n',
      zh: '请用普通话，按照括号中的表演指示朗读下面的剧本。不要读出表演指示和说话人的名字。\n',
    }[T.lang] || '次の台本を、かっこ内の演技指示のとおりに演じて読み上げてください。演技指示と話者名は読み上げないでください。\n';
    const descs = sp.filter((s) => s.desc.trim()).map((s) => (two ? `・${s.name.trim()}の声：${s.desc.trim()}` : `・声の人物像：${s.desc.trim()}`));
    if (style) descs.push(`・全体の雰囲気：${style}`);
    if (descs.length) p += '\n' + descs.join('\n') + '\n';
    p += '\n' + lines.map((l) => {
      const d = l.dir.trim() ? `（${l.dir.trim()}）` : '';
      return two ? `${sp[l.sp].name.trim()}: ${d}${l.text.trim()}` : `${d}${l.text.trim()}`;
    }).join('\n');
    const voiceCfg = (s) => ({ prebuiltVoiceConfig: { voiceName: s.voice.trim() } });
    const speechConfig = two
      ? { multiSpeakerVoiceConfig: { speakerVoiceConfigs: sp.map((s) => ({ speaker: s.name.trim(), voiceConfig: voiceCfg(s) })) } }
      : { voiceConfig: voiceCfg(sp[0]) };
    return { api: 'generate', snap, body: { contents: [{ parts: [{ text: p }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig } } };
  }

  $('ttsGen').onclick = async () => {
    if (needKey()) return;
    const btn = $('ttsGen');
    let body, snap, api;
    try { ({ body, snap, api } = buildTts()); } catch (err) { setStatus('ttsStatus', err.message, true); return; }
    btn.disabled = true; player.stop();
    // 自分の声を使う話者がいたら、その声が Google 側にあるかを先に確かめる
    const cast = (T.mode === 2 ? T.speakers.slice(0, 2) : [T.speakers[0]]).map((s, i) => ({ who: T.mode === 2 ? (s.name.trim() || `話者${i + 1}`) : 'ナレーター', voice: s.voice.trim() }));
    const voiceName = (id) => (myVoices().find((v) => v.id === id) || {}).name || id;
    for (const c of cast.filter((c) => isMyVoice(c.voice) && c.voice.startsWith('voice_'))) {
      try { await voicesApi('GET', `/${encodeURIComponent(c.voice)}`); } catch (err) {
        if (/not found|permission|HTTP 404/i.test(err.message)) {
          btn.disabled = false;
          const name = voiceName(c.voice); // 一覧を最新にする前に名前を控える
          await syncMyVoices();
          setStatus('ttsStatus', `「${c.who}」に設定した声（${name}）が Google 側で見つかりません。消されたか、別のAPIキーで作った声です。「登録した声」の一覧を最新にしたので、声を選び直してください。`, true);
          return;
        }
      }
    }
    const t0 = Date.now(), iv = setInterval(() => { setStatus('ttsStatus', `声を生成しています…（${Math.round((Date.now() - t0) / 1000)}秒）`); setProgress('ttsProg', Math.min(0.95, (Date.now() - t0) / 30000)); }, 300);
    try {
      let mime, b64;
      if (api === 'interactions') {
        const res = await geminiInteraction(body);
        const audio = (res.steps || []).flatMap((st) => st.content || []).find((c) => c.type === 'audio' && c.data);
        if (!audio) throw new Error('音声が返ってきませんでした（' + (res.status || '理由不明') + '）');
        mime = audio.mime_type || audio.mimeType || 'audio/wav'; b64 = audio.data;
      } else {
        const res = await gemini(cfg.ttsModel, body);
        const part = (res.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData?.data);
        if (!part) throw new Error('音声が返ってきませんでした（' + (res.candidates?.[0]?.finishReason || res.promptFeedback?.blockReason || '理由不明') + '）');
        mime = part.inlineData.mimeType || ''; b64 = part.inlineData.data;
      }
      const bytes = base64ToBytes(b64);
      let data, sr;
      if (/wav|mpeg|mp3|ogg/i.test(mime)) {
        const ab = await ac().decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
        data = DSP.toMono(ab); sr = ab.sampleRate;
      } else {
        sr = parseInt((mime.match(/rate=(\d+)/) || [])[1] || '24000', 10);
        data = DSP.pcm16ToFloat(bytes);
      }
      clearInterval(iv);
      setStatus('ttsStatus', '字幕の位置を合わせています…（話した内容を文字起こしして、台本の行と照らし合わせます）');
      const al = await alignSubtitles(data, sr, snap.lines);
      S.tts = { data, sr, ...snap, segs: al.segs, snapped: al.snapped };
      vState = null;
      $('vTiming').textContent = snap.lines.length < 2 ? '1行なので、字幕はずっと同じ行を出します'
        : al.method === 'transcript' ? `${snap.lines.length}行の切り替えを、話した内容と照らし合わせて合わせました`
        : al.snapped ? `${snap.lines.length}行の切り替えを、声の「間」から推定しました（文字起こしで合わせられなかったため目安です${al.why ? `：${al.why}` : ''}）`
        : '行の間がはっきりしないため、文字数の割合で切り替えます（目安）';
      player.pos.tts = 0;
      $('ttsResult').classList.remove('hidden');
      waveTts.setData(data, sr);
      paint('tts', 0);
      drawPreview();
      $('ttsInfo').textContent = `${fmt(data.length / sr)} ・ ${modelId(cfg.ttsModel)}`;
      setStatus('ttsStatus', 'できました。下で再生・保存できます。');
      player.play('tts', 0);
      $('ttsResult').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      setStatus('ttsStatus', '生成に失敗しました：' + ttsErrorText(err.message, cast), true);
    } finally { clearInterval(iv); setProgress('ttsProg', null); btn.disabled = false; }
  };
  /**
   * 字幕の切り替え位置を決める。
   * 音声を「間」ですべて区切り、断片をまとめて文字起こしして、台本の行に順番どおり割り当てる（切れ目は必ず間に置く）。
   * 断片ごとの時刻も持たせ、字幕の文字が濃くなる進み方を実際の話す速さに合わせる。
   * 文字起こしできないときは、文字数の割合と間から推定する従来の方法に戻す。
   */
  async function alignSubtitles(x, sr, lines) {
    const weights = lines.map((l) => [...DSP.normText(l.text)].length);
    const fallback = (why) => ({ ...DSP.alignLines(x, sr, weights), method: 'gaps', why });
    if (lines.length < 2 || !cfg.key) return fallback('');
    try {
      const lv = DSP.analyzeLevels(x, sr), fs = lv.frameSec, act = lv.active, dur = x.length / sr;
      let f = 0, l = act.length - 1;
      while (f < act.length && !act[f]) f++;
      while (l > 0 && !act[l]) l--;
      const t0 = f * fs, t1 = Math.min(dur, (l + 1) * fs);
      // 間が多すぎるときは長いものから使う（問い合わせを軽くするため）
      let gaps = lv.silences.filter((g) => g.start > t0 && g.end < t1 && g.end - g.start >= 0.06);
      const cap = Math.max(lines.length * 3, 40);
      if (gaps.length > cap) gaps = gaps.slice().sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, cap).sort((a, b) => a.start - b.start);
      if (gaps.length + 1 < lines.length) return fallback('行の間が少ない');
      const chunks = [];
      let s = t0;
      for (const g of gaps) { chunks.push({ start: s, end: g.start }); s = g.end; }
      chunks.push({ start: s, end: t1 });
      const parts = [];
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i], y = await resampleOffline(x.subarray(Math.round(c.start * sr), Math.round(c.end * sr)), sr, 16000);
        parts.push({ text: `断片${i + 1}:` }, { inlineData: { mimeType: 'audio/wav', data: await blobToBase64(new Blob([DSP.encodeWav(y, 16000)])) } });
      }
      parts.push({ text: `上の${chunks.length}個の音声の断片（${LANG[T.lang].name}）を、それぞれ聞こえたとおりに文字起こしして、JSON配列（文字列${chunks.length}個、断片の順。聞き取れない断片は空文字）だけを返してください。` });
      const { res } = await geminiText({ contents: [{ parts }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } });
      const texts = parseJsonLoose((res.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join(''));
      if (!Array.isArray(texts) || texts.length !== chunks.length) return fallback('文字起こしの数が合わない');
      const groups = DSP.assignChunks(texts.map(String), lines.map((ln) => ln.text));
      if (!groups) return fallback('割り当てできない');
      const segs = groups.map(({ from, to }) => ({
        start: chunks[from].start, end: chunks[to].end,
        // 行の中の断片ごとの時刻と文字数（字幕の文字を濃くする速さに使う）
        parts: chunks.slice(from, to + 1).map((c, k) => ({ start: c.start, end: c.end, w: Math.max(1, [...DSP.normText(texts[from + k])].length) })),
      }));
      return { segs, snapped: true, method: 'transcript' };
    } catch (err) {
      return fallback(err.message);
    }
  }

  $('ttsWav').onclick = () => download(new Blob([DSP.encodeWav(S.tts.data, S.tts.sr)], { type: 'audio/wav' }), `AIボイス_${stamp()}.wav`);
  $('ttsToEdit').onclick = () => {
    showTab('edit');
    setSource(Float32Array.from(S.tts.data), S.tts.sr, `AIボイス_${stamp()}.wav`, null, { channels: 1 });
  };

  // ================= 自分の声を登録（Voice Replication） =================
  const MV = { src: null, con: null };
  // 同意文（公式の文面そのまま）。読む言語を声の言語（voice.language_code）として一緒に送る
  const CONSENT = {
    'ja-JP': '私はこの音声の所有者であり、Googleがこの音声を使用して音声合成モデルを作成することを承認します。',
    'en-US': 'I am the owner of this voice and I consent to Google using this voice to create a synthetic voice model.',
  };
  const syncConsent = () => { $('mvConsentText').textContent = CONSENT[$('mvLang').value]; };
  $('mvLang').value = store.get('mvLang', 'ja-JP');
  $('mvLang').onchange = () => { store.set('mvLang', $('mvLang').value); syncConsent(); if (MV.con) hearConsent(MV.con); };
  syncConsent();
  const VOICE_SR = 24000; // 公式の推奨: 24kHz・モノラル・16bit WAV

  /** 録音やファイルを 24kHz モノラルにし、前後の無音を落とし、長ければ区切りのよい所で maxSec 以内に切る */
  async function toVoiceClip(blob, maxSec) {
    const audio = await ac().decodeAudioData(await blob.arrayBuffer());
    const x = Float32Array.from(await resampleOffline(DSP.toMono(audio), audio.sampleRate, VOICE_SR));
    const lv = DSP.analyzeLevels(x, VOICE_SR), fs = lv.frameSec, n = lv.active.length, dur = x.length / VOICE_SR;
    let f = 0, l = n - 1;
    while (f < n && !lv.active[f]) f++;
    while (l > 0 && !lv.active[l]) l--;
    let a = Math.max(0, f * fs - 0.25), b = Math.min(dur, (l + 1) * fs + 0.25);
    if (f >= n) { a = 0; b = dur; }
    let cut = false;
    if (b - a > maxSec) {
      cut = true;
      const gaps = lv.silences.filter((g) => g.start > a + 10 && g.start < a + maxSec - 0.2);
      b = gaps.length ? gaps[gaps.length - 1].start + 0.2 : a + maxSec;
    }
    const y = x.slice(Math.floor(a * VOICE_SR), Math.floor(b * VOICE_SR));
    return { data: y, wav: DSP.encodeWav(y, VOICE_SR), a: DSP.analyze(y, VOICE_SR), rawDur: dur, cut };
  }

  function checkClip(kind, c) {
    const items = [], d = c.a.duration;
    let ok = true;
    if (kind === 'src') {
      if (d < 10) { items.push(['warn', `短すぎます（${d.toFixed(1)}秒）。10秒以上話してください。`]); ok = false; }
      else items.push(['ok', `長さ ${d.toFixed(1)}秒${c.cut ? `（${c.rawDur.toFixed(0)}秒の録音から30秒以内に切り出しました）` : ''}`]);
      if (c.a.speechSec < 6) items.push(['warn', '話している時間が短めです。間を空けすぎず話してください。']);
    } else {
      if (d < 3) { items.push(['warn', `短すぎます（${d.toFixed(1)}秒）。文を最後まで読んでください。`]); ok = false; }
      else items.push(['ok', `長さ ${d.toFixed(1)}秒`]);
    }
    if (c.a.clipRuns > 0) items.push(['warn', `音割れが ${c.a.clipRuns} か所あります。マイクから少し離れて録り直すのがおすすめです。`]);
    if (c.a.noiseDb > -50) items.push(['warn', `背景の雑音が目立ちます（${c.a.noiseDb.toFixed(0)} dBFS）。静かな場所で録ると仕上がりがよくなります。`]);
    if (isFinite(c.a.lufs) && c.a.lufs < -35) items.push(['warn', `声が小さめです（${c.a.lufs.toFixed(0)} LUFS）。マイクに少し近づいてください。`]);
    if (kind === 'con' && MV.src && Math.abs(MV.src.a.noiseDb - c.a.noiseDb) > 12) items.push(['info', '見本と録音の環境が違うようです。同じ場所・同じマイクで録ると照合が通りやすくなります。']);
    return { items, ok };
  }

  function renderClip(kind) {
    const c = MV[kind], el = $(kind === 'src' ? 'mvSrcCheck' : 'mvConCheck');
    $(kind === 'src' ? 'mvPlaySrc' : 'mvPlayCon').classList.toggle('hidden', !c);
    if (!c) { el.innerHTML = ''; $(kind === 'src' ? 'mvSaveSrc' : 'mvSaveCon').classList.add('hidden'); updateCreateBtn(); return; }
    $(kind === 'src' ? 'mvSaveSrc' : 'mvSaveCon').classList.toggle('hidden', !c);
    const { items } = checkClip(kind, c);
    if (kind === 'con' && c.heard) items.push(c.heard);
    const mk = { warn: '!', info: 'i', ok: '✓' };
    el.innerHTML = items.map(([t, s]) => `<li class="${t}"><span class="mk">${mk[t]}</span><span>${esc(s)}</span></li>`).join('');
    updateCreateBtn();
  }
  function updateCreateBtn() {
    $('mvCreate').disabled = !(MV.src && MV.con && checkClip('src', MV.src).ok && checkClip('con', MV.con).ok);
  }
  async function setClip(kind, blob) {
    try {
      setStatus('mvStatus', '音声を整えています…');
      MV[kind] = await toVoiceClip(blob, kind === 'src' ? 30 : 20);
      setStatus('mvStatus', '');
    } catch {
      MV[kind] = null;
      setStatus('mvStatus', 'この音声は読み込めませんでした。wav・mp3・m4a などを使ってください。', true);
    }
    renderClip(kind);
    if (kind === 'src' && MV.con) renderClip('con');
    if (kind === 'con' && MV.con) hearConsent(MV.con);
  }

  // 送る直前の同意の録音を Gemini に聞き取らせ、画面の文と比べる（食い違いが録音側か照合側かを切り分ける）
  const normalizeJa = (t) => String(t || '').toLowerCase().replace(/google/g, 'グーグル')
    .replace(/[\s、。，．,.!?！？「」『』（）()・…ー―-]/g, '');
  function similarity(a, b) {
    const m = a.length, n = b.length;
    if (!m || !n) return 0;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return 1 - prev[n] / Math.max(m, n);
  }
  async function hearConsent(clip) {
    if (!cfg.key) return;
    clip.heard = ['info', '聞き取りを確認しています…'];
    renderClip('con');
    try {
      const { res } = await geminiText({
        contents: [{ parts: [
          { inlineData: { mimeType: 'audio/wav', data: await blobToBase64(new Blob([clip.wav])) } },
          { text: 'この音声を、聞こえたとおりに一字一句そのまま文字起こししてください。言い直しや言いよどみも含め、文字起こしの文だけを返してください。' },
        ] }],
        generationConfig: { temperature: 0 },
      });
      const heard = (res.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
      const sim = similarity(normalizeJa(heard), normalizeJa(CONSENT[$('mvLang').value]));
      clip.heard = sim >= 0.9
        ? ['ok', `聞き取り結果：「${heard}」（画面の文と一致）`]
        : ['warn', `聞き取り結果：「${heard}」— 画面の文と ${Math.round(sim * 100)}% しか一致しません。録り直してください。`];
    } catch (err) {
      clip.heard = ['info', `聞き取り確認はできませんでした（${err.message}）`];
    }
    if (MV.con === clip) renderClip('con');
  }
  $('mvSaveSrc').onclick = () => download(new Blob([MV.src.wav], { type: 'audio/wav' }), `見本_${stamp()}.wav`);
  $('mvSaveCon').onclick = () => download(new Blob([MV.con.wav], { type: 'audio/wav' }), `同意_${stamp()}.wav`);

  // 録音（見本は最長35秒、同意は最長20秒で自動停止）
  let mvRec = null;
  async function toggleRecord(btn, kind, maxSec) {
    if (mvRec) { if (mvRec.btn === btn) mvRec.mr.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const mr = new MediaRecorder(stream), chunks = [], t0 = Date.now();
      mr.ondataavailable = (e) => chunks.push(e.data);
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        clearInterval(mvRec.iv); clearTimeout(mvRec.to); mvRec = null;
        btn.textContent = '● 録り直す';
        setClip(kind, new Blob(chunks, { type: mr.mimeType || 'audio/webm' }));
      };
      mr.start();
      mvRec = {
        btn, mr,
        iv: setInterval(() => { btn.textContent = `■ 止める（${fmt((Date.now() - t0) / 1000)}）`; }, 200),
        to: setTimeout(() => { if (mr.state === 'recording') mr.stop(); }, maxSec * 1000),
      };
    } catch (err) {
      setStatus('mvStatus', micHelp(err), true);
    }
  }
  $('mvRecSrc').onclick = (e) => toggleRecord(e.currentTarget, 'src', 35);
  $('mvRecCon').onclick = (e) => toggleRecord(e.currentTarget, 'con', 20);
  $('mvFileSrc').onclick = () => $('mvFileSrcInput').click();
  $('mvFileCon').onclick = () => $('mvFileConInput').click();
  $('mvFileSrcInput').onchange = (e) => { const f = e.target.files[0]; if (f) setClip('src', f); e.target.value = ''; };
  $('mvFileConInput').onchange = (e) => { const f = e.target.files[0]; if (f) setClip('con', f); e.target.value = ''; };

  let mvSource = null;
  function mvPlay(kind, btn) {
    const was = mvSource && mvSource.kind === kind;
    if (mvSource) { try { mvSource.node.stop(); } catch { /* 停止済み */ } }
    document.querySelectorAll('#mvPlaySrc, #mvPlayCon').forEach((b) => { b.textContent = '▶ 聞く'; });
    mvSource = null;
    if (was || !MV[kind]) return;
    player.stop();
    const node = ac().createBufferSource();
    node.buffer = player.buffer(MV[kind].data, VOICE_SR);
    node.connect(ac().destination); node.start();
    node.onended = () => { if (mvSource && mvSource.node === node) { mvSource = null; btn.textContent = '▶ 聞く'; } };
    mvSource = { kind, node }; btn.textContent = '■ 止める';
  }
  $('mvPlaySrc').onclick = (e) => mvPlay('src', e.currentTarget);
  $('mvPlayCon').onclick = (e) => mvPlay('con', e.currentTarget);

  async function voicesApi(method, path, body) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/voices${path || ''}`, {
      method, headers: { 'x-goog-api-key': cfg.key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(voiceError(j, r.status));
    return j;
  }

  // Google 側の不具合で「Error translating server response to JSON」に置き換わった本当の理由を取り出す
  function voiceError(j, status) {
    const e = j.error || {};
    const detail = (e.details || []).map((d) => d.detail || '').join('\n');
    const orig = (detail.match(/Original error:\s*([^[]+)/) || [])[1];
    const text = (orig || e.message || `HTTP ${status}`).replace(/\s+/g, ' ').trim();
    if (/phrase didn.t match|read the prompt exactly/i.test(text)) return '同意文が画面の文と一致しませんでした。言い換えや言い間違いのないよう、一字一句そのまま、はっきり読んで録り直してください（読む言語の選択も確認してください）。';
    if (/speaker|same person|verif/i.test(text) && /consent/i.test(text)) return '見本と同意の声が同じ人だと確認できませんでした。同じ場所・同じマイク・同じ距離で、両方を録り直してください。';
    if (/consent/i.test(text)) return `同意の確認に失敗しました（${text}）`;
    return text;
  }

  $('mvCreate').onclick = async () => {
    if (needKey()) return;
    $('mvCreate').disabled = true;
    const stored = $('mvStore').checked, name = $('mvName').value.trim() || '自分の声';
    const model = version(modelId(cfg.ttsModel)) >= 3.8 && /tts/.test(cfg.ttsModel) ? modelId(cfg.ttsModel) : 'gemini-3.8-flash-tts';
    const t0 = Date.now(), iv = setInterval(() => setStatus('mvStatus', `声を作っています…（${Math.round((Date.now() - t0) / 1000)}秒）`), 300);
    try {
      const b64 = (buf) => blobToBase64(new Blob([buf]));
      const j = await voicesApi('POST', '', {
        store: stored,
        voice: {
          model, type: 'replicated', display_name: name, language_code: $('mvLang').value,
          replicated: {
            source_audio: { mime_type: 'audio/wav', data: await b64(MV.src.wav) },
            consent_audio: { mime_type: 'audio/wav', data: await b64(MV.con.wav) },
          },
        },
      });
      const rv = j.replicated_voice || j.voice || j;
      const id = rv.id || rv.key || String(rv.name || '').split('/').pop();
      if (!isMyVoice(id)) throw new Error('声の番号が返ってきませんでした');
      const list = myVoices().filter((v) => v.id !== id);
      list.unshift({ id, name, stored, created: Date.now(), expires: Date.now() + (stored ? 365 : 7) * 86400000 });
      saveMyVoices(list);
      T.speakers[0].voice = id; saveT();
      renderSpeakers(); renderMyVoices();
      setStatus('mvStatus', `「${name}」を作りました。${T.mode === 2 ? (T.speakers[0].name || '1人目') : 'ナレーター'}の声に設定したので、「声を生成する」でこの声が使われます。`);
    } catch (err) {
      setStatus('mvStatus', '声を作れませんでした：' + err.message, true);
    } finally { clearInterval(iv); updateCreateBtn(); }
  };

  function renderMyVoices() {
    const list = myVoices(), two = T.mode === 2;
    const date = (t) => { const d = new Date(t); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`; };
    const users = two ? T.speakers.slice(0, 2) : [T.speakers[0]];
    $('mvList').innerHTML = list.length ? list.map((v, i) => `
      <li data-i="${i}">
        <strong>🎙 ${esc(v.name)}</strong>
        <span class="id">${esc(v.id)}</span>
        <span class="sp">${v.expires ? `${date(v.expires)} まで` : ''}</span>
        ${users.map((s, j) => `<button class="btn ghost small" data-use="${j}">${esc(two ? (s.name || `話者${j + 1}`) : 'ナレーター')}に使う</button>`).join('')}
        <button class="btn ghost small" data-del>削除</button>
      </li>`).join('') : '<li class="empty">まだありません。上の 1〜3 で作れます。</li>';
    $('mvList').querySelectorAll('li[data-i]').forEach((li) => {
      const v = list[+li.dataset.i];
      li.querySelectorAll('[data-use]').forEach((b) => { b.onclick = () => { T.speakers[+b.dataset.use].voice = v.id; saveT(); renderSpeakers(); }; });
      li.querySelector('[data-del]').onclick = async () => {
        if (!window.confirm(`「${v.name}」を削除しますか？ 元に戻せません。`)) return;
        try {
          if (v.id.startsWith('voice_')) await voicesApi('DELETE', `/${encodeURIComponent(v.id)}`);
          saveMyVoices(myVoices().filter((x) => x.id !== v.id));
          T.speakers.forEach((s) => { if (s.voice === v.id) s.voice = 'Kore'; });
          saveT(); renderSpeakers(); renderMyVoices();
          setStatus('mvStatus', `「${v.name}」を削除しました。`);
        } catch (err) { setStatus('mvStatus', '削除できませんでした：' + err.message, true); }
      };
    });
  }

  // Google 側の一覧と合わせる（1年保存の声はサーバーの一覧が正、7日の声はこのブラウザの控えを使う）
  async function syncMyVoices() {
    if (!cfg.key) return;
    try {
      const j = await voicesApi('GET', '?type=replicated&page_size=200');
      const local = myVoices(), server = (j.voices || []).filter((v) => v.id);
      const merged = server.map((v) => {
        const l = local.find((x) => x.id === v.id);
        return { id: v.id, name: v.display_name || (l && l.name) || v.id, stored: true, created: (l && l.created) || Date.now(), expires: (l && l.expires) || 0 };
      });
      for (const l of local) if (!l.stored && !merged.some((m) => m.id === l.id)) merged.push(l);
      saveMyVoices(merged);
      renderSpeakers(); renderMyVoices();
    } catch (err) { setStatus('mvStatus', '登録した声の一覧を取れませんでした：' + err.message, true); }
  }
  $('mvRefresh').onclick = syncMyVoices;
  mvReady = true;
  renderMyVoices();
  syncMyVoices();

  // ================= 解説動画 =================
  T.video = { orient: 'h', title: '', tag: 'AIボイス', sub: true, ai: true, ...(T.video || {}) };
  let vState = null;
  const vOpts = () => ({ title: T.video.title, tag: T.video.tag, showSub: T.video.sub, showAi: T.video.ai });
  const vSize = () => (T.video.orient === 'v' ? [1080, 1920] : [1920, 1080]);
  function drawPreview(t) {
    if (!S.tts || !S.tts.segs) return;
    if (!vState) {
      vState = KoeVideo.buildState(S.tts, vOpts());
      KoeVideo.loadFonts(vState).then(() => drawPreview());
    }
    if (t == null) t = player.which === 'tts' ? player.now() : (player.pos.tts || Math.min(vState.dur, S.tts.segs[0].start + 0.8));
    const c = $('vPreview'), [W, H] = T.video.orient === 'v' ? [540, 960] : [960, 540];
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    KoeVideo.drawFrame(c.getContext('2d'), W, H, vState, t);
  }
  function syncVideoUi() {
    document.querySelectorAll('[data-orient]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.orient === T.video.orient)));
    $('vPreviewWrap').classList.toggle('portrait', T.video.orient === 'v');
    $('vTitle').value = T.video.title; $('vTag').value = T.video.tag;
    $('vSub').checked = T.video.sub; $('vAi').checked = T.video.ai;
  }
  const onVideoOpt = () => { vState = null; saveT(); drawPreview(); };
  document.querySelectorAll('[data-orient]').forEach((b) => b.onclick = () => { T.video.orient = b.dataset.orient; syncVideoUi(); onVideoOpt(); });
  $('vTitle').oninput = (e) => { T.video.title = e.target.value; onVideoOpt(); };
  $('vTag').oninput = (e) => { T.video.tag = e.target.value; onVideoOpt(); };
  $('vSub').onchange = (e) => { T.video.sub = e.target.checked; onVideoOpt(); };
  $('vAi').onchange = (e) => { T.video.ai = e.target.checked; onVideoOpt(); };
  syncVideoUi();

  $('vMake').onclick = async () => {
    if (!S.tts) return;
    const btn = $('vMake'); btn.disabled = true; player.stop();
    const [W, H] = vSize();
    const t0 = Date.now();
    try {
      setStatus('vStatus', '動画を作っています…');
      const state = KoeVideo.buildState(S.tts, vOpts());
      const blob = await KoeVideo.exportMp4(state, S.tts.data, S.tts.sr, W, H, (p) => {
        setProgress('vProg', p);
        setStatus('vStatus', `動画を作っています… ${Math.round(p * 100)}%`);
      });
      download(blob, `解説動画_${T.video.orient === 'v' ? '縦' : '横'}_${stamp()}.mp4`);
      setStatus('vStatus', `保存しました（${W}×${H}・${fmt(state.dur)}・${(blob.size / 1048576).toFixed(1)}MB・作成 ${Math.round((Date.now() - t0) / 1000)}秒）`);
    } catch (err) {
      console.error(err);
      setStatus('vStatus', '動画を作れませんでした：' + err.message, true);
    } finally { setProgress('vProg', null); btn.disabled = false; }
  };

  // 画面幅が変わったらグラフを描き直す
  let rz = 0;
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (S.analysis) { renderPitch(S.analysis); renderSpec(S.analysis); } }, 150); });
})();
