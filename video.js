/* こえラボ — 解説動画（波形アニメ＋字幕）の描画と mp4 書き出し */
(function (root) {
  'use strict';

  const C = { bg: '#FBF5E6', grid: 'rgba(36,51,224,0.05)', ink: '#1D1D29', muted: '#6E6B60', dim: '#BDB7A6', blue: '#2433E0', card: '#FFFDF6', line: '#E8DFC8' };
  const SPEAKER_COLORS = ['#2433E0', '#E0413A'];
  const FONTS = {
    ja: '"Noto Sans JP", "Yu Gothic", "Meiryo", sans-serif',
    zh: '"Noto Sans SC", "Microsoft YaHei", "Noto Sans JP", sans-serif', // 簡体字の字形で描く
  };
  let FONT = FONTS.ja;
  const MUXER = 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/build/mp4-muxer.min.js';
  const NO_LINE_START = '、。，．,.!?！？」』）)]】ー〜…ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮ；：”’》〉';

  /** 声の大きさの変化（10ms ごと、0〜1 程度） */
  function envelope(x, sr) {
    const hop = Math.max(1, Math.round(sr * 0.01)), n = Math.ceil(x.length / hop), env = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      let s = 0; const a = k * hop, b = Math.min(x.length, a + hop);
      for (let i = a; i < b; i++) s += x[i] * x[i];
      env[k] = Math.sqrt(s / Math.max(1, b - a));
    }
    const ref = Math.max(1e-4, Array.from(env).sort((p, q) => p - q)[Math.floor(n * 0.95)] || 0);
    for (let k = 0; k < n; k++) env[k] = Math.min(1.25, env[k] / ref);
    return { env, hop: hop / sr };
  }

  function envAt(v, t) {
    if (t < 0) return 0;
    const i = t / v.hop, a = Math.floor(i);
    if (a + 1 >= v.env.length) return 0;
    return v.env[a] + (v.env[a + 1] - v.env[a]) * (i - a);
  }

  /** 日本語の折り返し（行頭に来てはいけない文字はぶら下げる） */
  function wrap(g, text, maxW) {
    const out = [];
    let cur = '';
    // 英語など空白で区切る文章は、単語の途中で切らない
    if (/ /.test(text) && /^[\x00-\x7F\u2018-\u201D\u2026]*$/.test(text)) {
      for (const word of text.split(/ +/)) {
        const next = cur ? `${cur} ${word}` : word;
        if (cur && g.measureText(next).width > maxW) { out.push(cur); cur = word; } else cur = next;
      }
      if (cur) out.push(cur);
      return out;
    }
    for (const ch of text) {
      if (cur && g.measureText(cur + ch).width > maxW && !NO_LINE_START.includes(ch)) {
        // 行末の数字・英字のかたまり（「1行」の「1」など）は途中で切らず、次の行へ送る
        const m = cur.match(/[0-9A-Za-z０-９Ａ-Ｚａ-ｚ.,%]+$/);
        if (m && m[0].length < cur.length) { out.push(cur.slice(0, -m[0].length)); cur = m[0] + ch; }
        else { out.push(cur); cur = ch; }
      } else cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  }

  /** maxLines に収まるまで文字を小さくする */
  function fit(g, text, weight, size, minSize, maxW, maxLines) {
    let s = size, lines;
    for (;;) {
      g.font = `${weight} ${s}px ${FONT}`;
      lines = wrap(g, text, maxW);
      if (lines.length <= maxLines || s <= minSize) break;
      s = Math.max(minSize, Math.round(s * 0.9));
    }
    // 行の長さをそろえる（「聞いて／みて」のように最後の行が短く残らないよう、同じ行数で収まる最小の幅を探す）
    if (lines.length > 1 && lines.length <= maxLines) {
      let lo = maxW * 0.4, hi = maxW;
      for (let i = 0; i < 12; i++) {
        const mid = (lo + hi) / 2;
        if (wrap(g, text, mid).length <= lines.length) hi = mid; else lo = mid;
      }
      lines = wrap(g, text, hi);
    }
    return { size: s, lines: lines.slice(0, maxLines) };
  }

  function rrect(g, x, y, w, h, r) {
    g.beginPath();
    if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h);
  }

  /** 何行目を話しているか（次の行が始まるまで前の行を出し続ける） */
  function lineAt(v, t) {
    let k = -1;
    for (let i = 0; i < v.segs.length; i++) if (v.segs[i].start <= t + 0.08) k = i;
    return k;
  }

  /** 行の中でどこまで話し終えたか（0〜1）。断片の時刻があれば、間では止まり話している間だけ進む */
  function spokenRatio(seg, t) {
    if (!seg.parts || !seg.parts.length) return Math.max(0, Math.min(1, (t - seg.start) / Math.max(0.3, seg.end - seg.start)));
    const total = seg.parts.reduce((a, p) => a + p.w, 0);
    let done = 0;
    for (const p of seg.parts) {
      if (t >= p.end) { done += p.w; continue; }
      if (t > p.start) done += p.w * (t - p.start) / Math.max(0.05, p.end - p.start);
      break;
    }
    return Math.max(0, Math.min(1, done / total));
  }

  /** 1コマ描く。v は buildState の結果、t は秒 */
  function drawFrame(g, W, H, v, t) {
    FONT = FONTS[v.lang] || FONTS.ja;
    const portrait = H > W, s = Math.min(W, H) / 1080, M = (portrait ? 80 : 110) * s;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = C.bg; g.fillRect(0, 0, W, H);
    g.strokeStyle = C.grid; g.lineWidth = Math.max(1, s);
    const step = 40 * s;
    g.beginPath();
    for (let x = step; x < W; x += step) { g.moveTo(x, 0); g.lineTo(x, H); }
    for (let y = step; y < H; y += step) { g.moveTo(0, y); g.lineTo(W, y); }
    g.stroke();
    g.textBaseline = 'alphabetic';

    const k = lineAt(v, t), cur = k >= 0 ? v.lines[k] : null;
    const color = cur && v.multi ? SPEAKER_COLORS[cur.sp] || C.blue : C.blue;

    // 左上（縦長は中央上）のラベル＋進み具合の点
    let y = (portrait ? 150 : 110) * s;
    const tag = v.tag.trim();
    if (tag || v.lines.length > 1) {
      g.font = `700 ${26 * s}px ${FONT}`;
      const tw = tag ? g.measureText(tag).width : 0;
      const dots = Math.min(v.lines.length, 12), dotW = v.lines.length > 1 ? dots * 14 * s + 6 * s : 0;
      const pw = tw + dotW + 40 * s, ph = 46 * s;
      const px = portrait ? (W - pw) / 2 : M;
      g.fillStyle = C.blue; rrect(g, px, y - ph / 2, pw, ph, ph / 2); g.fill();
      g.fillStyle = '#fff'; g.textAlign = 'left';
      g.fillText(tag, px + 20 * s, y + 9 * s);
      const on = v.lines.length > 12 ? Math.round((k + 1) / v.lines.length * dots) : k + 1;
      for (let i = 0; i < (v.lines.length > 1 ? dots : 0); i++) {
        g.fillStyle = i < on ? '#fff' : 'rgba(255,255,255,.4)';
        g.beginPath(); g.arc(px + 20 * s + tw + (tag ? 14 * s : 0) + i * 14 * s + 4 * s, y, 4.5 * s, 0, Math.PI * 2); g.fill();
      }
    }
    if (v.showAi) {
      g.font = `700 ${22 * s}px ${FONT}`;
      const txt = v.aiLabel || 'AI音声', tw = g.measureText(txt).width, pw = tw + 28 * s, ph = 40 * s;
      const px = portrait ? (W - pw) / 2 : W - M - pw, py = portrait ? H - 150 * s : 110 * s;
      g.strokeStyle = C.line; g.lineWidth = 2 * s; g.fillStyle = C.card;
      rrect(g, px, py - ph / 2, pw, ph, 10 * s); g.fill(); g.stroke();
      g.fillStyle = C.muted; g.textAlign = 'left'; g.fillText(txt, px + 14 * s, py + 8 * s);
    }

    // タイトル
    y += (portrait ? 135 : 95) * s;
    const title = v.title.trim();
    if (title) {
      const f = fit(g, title, 900, (portrait ? 84 : 76) * s, 44 * s, W - 2 * M, 2);
      g.fillStyle = C.ink; g.textAlign = portrait ? 'center' : 'left';
      f.lines.forEach((ln, i) => g.fillText(ln, portrait ? W / 2 : M, y + i * f.size * 1.25));
      const lastY = y + (f.lines.length - 1) * f.size * 1.25;
      g.fillStyle = C.blue;
      const bw = 90 * s;
      g.fillRect(portrait ? W / 2 - bw / 2 : M, lastY + (portrait ? 40 : 22) * s, bw, 8 * s); // 縦長は中央寄せなので、文字の一部に見えないよう離す
    }

    // 波形（中央から外へ広がる棒＋うっすら同心円）
    const cy = portrait ? H * 0.43 : H * (title ? 0.53 : 0.45);
    const count = portrait ? 34 : 56, areaW = portrait ? W - 2 * M : Math.min(W - 2 * M, 1300 * s);
    const bw = areaW / count, maxH = (portrait ? 300 : 260) * s, c = (count - 1) / 2;
    const now = envAt(v, t);
    g.lineWidth = 2 * s;
    for (let r = 0; r < 4; r++) {
      g.strokeStyle = `rgba(36,51,224,${0.07 - r * 0.012})`;
      g.beginPath(); g.arc(W / 2, cy, (portrait ? 250 : 190) * s * (1 + r * 0.42) * (1 + now * 0.05), 0, Math.PI * 2); g.stroke();
    }
    g.fillStyle = color;
    for (let i = 0; i < count; i++) {
      const d = Math.abs(i - c) / c;
      const amp = envAt(v, t - d * 0.22);
      const bell = 0.3 + 0.7 * Math.cos(d * Math.PI / 2);
      const idle = 0.05 * (0.5 + 0.5 * Math.sin(t * 5 + i * 0.8));
      const h = Math.max(10 * s, maxH * Math.min(1, amp * bell + idle));
      const x = W / 2 - areaW / 2 + i * bw + bw * 0.22;
      rrect(g, x, cy - h / 2, bw * 0.56, h, Math.min(bw * 0.28, 6 * s)); g.fill();
    }

    // 字幕
    if (v.showSub && cur) {
      const seg = v.segs[k], appear = Math.min(1, Math.max(0, (t - seg.start + 0.08) / 0.2));
      const top = (portrait ? H * 0.62 : H * 0.72) + (1 - appear) * 14 * s;
      g.globalAlpha = appear;
      // 話す人と演技指示
      g.font = `700 ${(portrait ? 32 : 28) * s}px ${FONT}`;
      const chips = [];
      if (v.multi) chips.push({ text: v.speakers[cur.sp] || '', kind: 'sp' });
      if (cur.dir) chips.push({ text: cur.dir, kind: 'dir' });
      const ph = (portrait ? 54 : 48) * s, gap = 14 * s;
      const widths = chips.map((ch) => g.measureText(ch.text).width + (ch.kind === 'sp' ? 58 : 36) * s);
      let cx = W / 2 - (widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, chips.length - 1)) / 2;
      chips.forEach((ch, i) => {
        if (ch.kind === 'sp') {
          g.fillStyle = C.card; g.strokeStyle = C.line; g.lineWidth = 2 * s;
          rrect(g, cx, top - ph, widths[i], ph, ph / 2); g.fill(); g.stroke();
          g.fillStyle = color; g.beginPath(); g.arc(cx + 26 * s, top - ph / 2, 8 * s, 0, Math.PI * 2); g.fill();
          g.fillStyle = C.ink; g.textAlign = 'left'; g.fillText(ch.text, cx + 42 * s, top - ph / 2 + 10 * s);
        } else {
          g.fillStyle = 'rgba(36,51,224,.1)';
          rrect(g, cx, top - ph, widths[i], ph, 12 * s); g.fill();
          g.fillStyle = C.blue; g.textAlign = 'left'; g.fillText(ch.text, cx + 18 * s, top - ph / 2 + 10 * s);
        }
        cx += widths[i] + gap;
      });
      // セリフ（話し終えた部分を濃く）
      const f = fit(g, cur.text, 700, (portrait ? 64 : 58) * s, (portrait ? 40 : 36) * s, W - 2 * M - (portrait ? 0 : 80 * s), portrait ? 5 : 3);
      const p = spokenRatio(seg, t);
      let spoken = Math.floor(p * [...cur.text].length);
      const lh = f.size * 1.4;
      g.textAlign = 'left';
      f.lines.forEach((ln, i) => {
        const chars = [...ln], lw = g.measureText(ln).width, ly = top + (chips.length ? 30 * s : 0) + f.size + i * lh;
        let x = W / 2 - lw / 2;
        const done = chars.slice(0, Math.max(0, Math.min(chars.length, spoken))).join('');
        g.fillStyle = C.ink; g.fillText(done, x, ly);
        x += g.measureText(done).width;
        g.fillStyle = C.dim; g.fillText(chars.slice(done.length ? [...done].length : 0).join(''), x, ly);
        spoken -= chars.length;
      });
      g.globalAlpha = 1;
    }

    // 下の進み具合
    const by = H - (portrait ? 90 : 56) * s, bx = M, bwid = W - 2 * M, bh = 6 * s;
    g.fillStyle = C.line; rrect(g, bx, by, bwid, bh, bh / 2); g.fill();
    g.fillStyle = C.blue; rrect(g, bx, by, Math.max(bh, bwid * Math.min(1, t / v.dur)), bh, bh / 2); g.fill();

    // 透かし（縁に半透明で。転載されても出どころが分かるように）
    const wm = (v.wm || '').trim();
    if (wm) {
      const fs = (portrait ? 30 : 28) * s, pad = (portrait ? 40 : 34) * s, pos = v.wmPos || 'br';
      g.font = `700 ${fs}px ${FONT}`;
      g.textBaseline = 'alphabetic';
      g.textAlign = pos === 'bc' ? 'center' : pos.endsWith('r') ? 'right' : 'left';
      const x = pos === 'bc' ? W / 2 : pos.endsWith('r') ? W - pad : pad;
      const y = pos.startsWith('t') ? pad + fs * 0.8 : by - 18 * s; // 下は進み具合の線の少し上
      g.globalAlpha = 0.55;
      g.lineWidth = 4 * s; g.strokeStyle = C.bg; g.lineJoin = 'round';
      g.strokeText(wm, x, y); // 背景に溶けないよう、地色で縁取り
      g.fillStyle = C.ink; g.fillText(wm, x, y);
      g.globalAlpha = 1;
    }
  }

  /** 動画に必要な情報をまとめる */
  function buildState(tts, opts) {
    const e = envelope(tts.data, tts.sr);
    return {
      lines: tts.lines, segs: tts.segs, multi: tts.multi, speakers: tts.speakers,
      title: opts.title || '', tag: opts.tag || '', showSub: opts.showSub !== false, showAi: opts.showAi !== false,
      wm: opts.wm || '', wmPos: opts.wmPos || 'br',
      lang: tts.lang || 'ja',
      aiLabel: { en: 'AI voice', zh: 'AI语音' }[tts.lang] || 'AI音声',
      env: e.env, hop: e.hop, dur: tts.data.length / tts.sr,
    };
  }

  function loadScript(src) {
    return new Promise((res, rej) => {
      if (document.querySelector(`script[src="${src}"]`) && root.Mp4Muxer) return res();
      const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('部品を読み込めませんでした（インターネット接続が必要です）'));
      document.head.appendChild(s);
    });
  }

  async function loadFonts(v) {
    if (!document.fonts || !document.fonts.load) return;
    const text = [v.title, v.tag, v.wm || '', v.aiLabel || 'AI音声', ...v.speakers, ...v.lines.map((l) => l.text + l.dir)].join('');
    try {
      const family = v.lang === 'zh' ? 'Noto Sans SC' : 'Noto Sans JP';
      await Promise.all([900, 700].map((w) => document.fonts.load(`${w} 40px "${family}"`, text || 'あ')));
    } catch { /* 読み込めなければ代わりの書体で描く */ }
  }

  async function resampleTo(x, from, to) {
    if (from === to) return x;
    const ctx = new OfflineAudioContext(1, Math.ceil(x.length * to / from), to);
    const b = ctx.createBuffer(1, x.length, from); b.copyToChannel(x, 0);
    const src = ctx.createBufferSource(); src.buffer = b; src.connect(ctx.destination); src.start();
    return (await ctx.startRendering()).getChannelData(0);
  }

  /** mp4 を作る（1コマずつ描いて符号化するので、再生時間より速く・タブが裏でも止まらない） */
  async function exportMp4(v, audio, sr, W, H, onProgress) {
    if (!('VideoEncoder' in root) || !('AudioEncoder' in root)) throw new Error('このブラウザは動画の作成に対応していません（Chrome か Edge で開いてください）');
    await loadScript(MUXER);
    await loadFonts(v);
    const fps = 30, ASR = 48000;
    let vcfg = null;
    for (const codec of ['avc1.640028', 'avc1.4d0028', 'avc1.42e028']) {
      const c = { codec, width: W, height: H, bitrate: 6e6, framerate: fps };
      if ((await VideoEncoder.isConfigSupported(c)).supported) { vcfg = c; break; }
    }
    if (!vcfg) throw new Error('このパソコンでは H.264 の動画を作れませんでした');
    let acfg = null, amux = null;
    for (const [codec, mux] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
      const c = { codec, sampleRate: ASR, numberOfChannels: 1, bitrate: 160000 };
      if ((await AudioEncoder.isConfigSupported(c)).supported) { acfg = c; amux = mux; break; }
    }
    if (!acfg) throw new Error('このパソコンでは音声を符号化できませんでした');

    const a = await resampleTo(audio, sr, ASR);
    const muxer = new root.Mp4Muxer.Muxer({
      target: new root.Mp4Muxer.ArrayBufferTarget(),
      video: { codec: 'avc', width: W, height: H },
      audio: { codec: amux, numberOfChannels: 1, sampleRate: ASR },
      fastStart: 'in-memory',
    });
    let failure = null;
    const ve = new VideoEncoder({ output: (ch, meta) => muxer.addVideoChunk(ch, meta), error: (e) => { failure = e; } });
    ve.configure(vcfg);
    const ae = new AudioEncoder({ output: (ch, meta) => muxer.addAudioChunk(ch, meta), error: (e) => { failure = e; } });
    ae.configure(acfg);

    for (let i = 0; i < a.length; i += 4800) {
      const n = Math.min(4800, a.length - i);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: ASR, numberOfFrames: n, numberOfChannels: 1, timestamp: Math.round(i * 1e6 / ASR), data: a.slice(i, i + n) });
      ae.encode(ad); ad.close();
    }

    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    const frames = Math.ceil((v.dur + 0.4) * fps);
    for (let f = 0; f < frames; f++) {
      if (failure) throw failure;
      drawFrame(g, W, H, v, f / fps);
      const vf = new VideoFrame(cv, { timestamp: Math.round(f * 1e6 / fps), duration: Math.round(1e6 / fps) });
      ve.encode(vf, { keyFrame: f % (fps * 2) === 0 });
      vf.close();
      while (ve.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 5));
      if (f % 10 === 0) { onProgress && onProgress(f / frames); await new Promise((r) => setTimeout(r, 0)); }
    }
    await ve.flush(); await ae.flush();
    if (failure) throw failure;
    muxer.finalize();
    ve.close(); ae.close();
    return new Blob([muxer.target.buffer], { type: 'video/mp4' });
  }

  root.KoeVideo = { drawFrame, buildState, exportMp4, loadFonts, lineAt };
})(typeof self !== 'undefined' ? self : this);
