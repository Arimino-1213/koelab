/* 声の編集アプリ — 音声処理（ブラウザ・Node 両用）
 * 外部ライブラリなし。すべて Float32Array（モノラル）を受け取り、新しい配列を返す。 */
(function (root, factory) {
  const DSP = factory();
  if (typeof module === 'object' && module.exports) module.exports = DSP;
  else root.DSP = DSP;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const db = (v) => 20 * Math.log10(Math.max(v, 1e-10));
  const fromDb = (d) => Math.pow(10, d / 20);
  const tick = () => new Promise((r) => setTimeout(r, 0));

  // ---------- 基本 ----------

  function toMono(buf) {
    const n = buf.length, ch = buf.numberOfChannels;
    if (ch === 1) return Float32Array.from(buf.getChannelData(0));
    const out = new Float32Array(n);
    for (let c = 0; c < ch; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) out[i] += d[i];
    }
    for (let i = 0; i < n; i++) out[i] /= ch;
    return out;
  }

  function peak(x) {
    let m = 0;
    for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > m) m = a; }
    return m;
  }

  function percentile(arr, p) {
    const a = Array.from(arr).sort((m, n) => m - n);
    if (!a.length) return NaN;
    return a[Math.min(a.length - 1, Math.max(0, Math.round(p * (a.length - 1))))];
  }

  function biquad(x, b0, b1, b2, a0, a1, a2) {
    b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
    const y = new Float32Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const xi = x[i];
      const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = xi; y2 = y1; y1 = yi; y[i] = yi;
    }
    return y;
  }

  function lowpass(x, sr, fc, q = Math.SQRT1_2) {
    const w0 = 2 * Math.PI * fc / sr, c = Math.cos(w0), al = Math.sin(w0) / (2 * q);
    return biquad(x, (1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al);
  }

  // ---------- 音量（ITU-R BS.1770 / LUFS） ----------

  function kWeight(x, sr) {
    // 1段目: ハイシェルフ（頭の影響） 2段目: ハイパス（RLB）。係数式は pyloudnorm と同じ
    let G = 4.0, Q = 1 / Math.SQRT2, fc = 1500;
    const A = Math.pow(10, G / 40), sA = Math.sqrt(A);
    let w0 = 2 * Math.PI * fc / sr, c = Math.cos(w0), al = Math.sin(w0) / (2 * Q);
    const y = biquad(x,
      A * ((A + 1) + (A - 1) * c + 2 * sA * al), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - 2 * sA * al),
      (A + 1) - (A - 1) * c + 2 * sA * al, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - 2 * sA * al);
    Q = 0.5; fc = 38;
    w0 = 2 * Math.PI * fc / sr; c = Math.cos(w0); al = Math.sin(w0) / (2 * Q);
    return biquad(y, (1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al);
  }

  /** 統合ラウドネス（LUFS）。無音なら -Infinity */
  function lufs(x, sr) {
    const y = kWeight(x, sr);
    const L = (v) => -0.691 + 10 * Math.log10(v);
    const bl = Math.round(0.4 * sr), hop = Math.round(0.1 * sr);
    const cs = new Float64Array(y.length + 1);
    for (let i = 0; i < y.length; i++) cs[i + 1] = cs[i] + y[i] * y[i];
    const z = [];
    if (y.length < bl) z.push(cs[y.length] / Math.max(1, y.length));
    else for (let s = 0; s + bl <= y.length; s += hop) z.push((cs[s + bl] - cs[s]) / bl);
    const mean = (a) => a.reduce((p, q) => p + q, 0) / a.length;
    let g = z.filter((v) => v > 0 && L(v) > -70);
    if (!g.length) return -Infinity;
    const rel = L(mean(g)) - 10;
    g = g.filter((v) => L(v) > rel);
    return g.length ? L(mean(g)) : -Infinity;
  }

  // ---------- 無音・話し声の区間 ----------

  function analyzeLevels(x, sr) {
    const frameSec = 0.02, f = Math.max(1, Math.round(frameSec * sr));
    const n = Math.floor(x.length / f);
    const dbs = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      let s = 0;
      for (let i = k * f; i < (k + 1) * f; i++) s += x[i] * x[i];
      dbs[k] = db(Math.sqrt(s / f));
    }
    const noise = n ? percentile(dbs, 0.1) : -100;
    const speech = n ? percentile(dbs, 0.95) : -100;
    let thr = Math.max(-65, noise + 0.35 * (speech - noise));
    if (speech - noise < 12) thr = Math.min(thr, speech - 20); // ほぼ鳴りっぱなしの素材

    // 声の前後を少し残す（語尾 0.1 秒・語頭 0.04 秒）
    const active = new Uint8Array(n);
    const hangAfter = Math.round(0.1 / frameSec), hangBefore = 2;
    for (let k = 0, h = 0; k < n; k++) {
      if (dbs[k] > thr) { active[k] = 1; h = hangAfter; } else if (h > 0) { active[k] = 1; h--; }
    }
    for (let k = n - 1, h = 0; k >= 0; k--) {
      if (dbs[k] > thr) h = hangBefore; else if (h > 0) { active[k] = 1; h--; }
    }

    const silences = [];
    let speechFrames = 0;
    for (let k = 0; k < n;) {
      if (active[k]) { speechFrames++; k++; continue; }
      let e = k;
      while (e < n && !active[e]) e++;
      silences.push({ start: k * frameSec, end: e * frameSec });
      k = e;
    }
    return { frameSec, dbs, noiseDb: noise, speechDb: speech, thresholdDb: thr, active, silences, speechSec: speechFrames * frameSec };
  }

  /** 長い無音を詰める。前後 keep 秒は残し、つなぎ目は 5ms でクロスフェード */
  function cutSilence(x, sr, levels, opts = {}) {
    const minSilence = opts.minSilence ?? 0.5, keep = opts.keep ?? 0.15;
    const ranges = [];
    let cur = 0;
    for (const s of levels.silences) {
      if (s.end - s.start < minSilence) continue;
      const a = Math.round((s.start + keep) * sr), b = Math.round((s.end - keep) * sr);
      if (b <= a || a < cur) continue;
      ranges.push([cur, a]);
      cur = b;
    }
    ranges.push([cur, x.length]);
    const xf = Math.round(0.005 * sr);
    const out = new Float32Array(x.length);
    let pos = 0;
    for (const [a, b] of ranges) {
      const seg = x.subarray(a, b);
      if (!seg.length) continue;
      const L = Math.min(xf, pos, seg.length);
      for (let i = 0; i < L; i++) {
        const t = (i + 1) / (L + 1);
        out[pos - L + i] = out[pos - L + i] * (1 - t) + seg[i] * t;
      }
      out.set(seg.subarray(L), pos);
      pos += seg.length - L;
    }
    return out.slice(0, pos);
  }

  // ---------- 声の高さ（YIN） ----------

  function pitchTrack(x, sr, minRms = 0.003) {
    const factor = Math.max(1, Math.floor(sr / 11025));
    const dsr = sr / factor, n = Math.floor(x.length / factor);
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j < factor; j++) s += x[i * factor + j];
      d[i] = s / factor;
    }
    const W = Math.round(0.035 * dsr);
    const minLag = Math.floor(dsr / 500), maxLag = Math.ceil(dsr / 65);
    const span = n - W - maxLag - 2;
    const times = [], f0 = [];
    if (span <= 0) return { times: new Float32Array(0), f0: new Float32Array(0) };
    let hop = Math.round(0.01 * dsr);
    if (span / hop > 5000) hop = Math.ceil(span / 5000);
    const diff = new Float64Array(maxLag + 2);
    for (let t = 0; t < span; t += hop) {
      let e = 0;
      for (let j = 0; j < W; j++) e += d[t + j] * d[t + j];
      times.push((t + W / 2) / dsr);
      if (Math.sqrt(e / W) < minRms) { f0.push(0); continue; }
      for (let tau = 1; tau <= maxLag + 1; tau++) {
        let s = 0;
        for (let j = 0; j < W; j++) { const v = d[t + j] - d[t + j + tau]; s += v * v; }
        diff[tau] = s;
      }
      // 累積平均で正規化した差分関数
      let run = 0, best = -1;
      const cm = new Float64Array(maxLag + 2);
      cm[0] = 1;
      for (let tau = 1; tau <= maxLag + 1; tau++) { run += diff[tau]; cm[tau] = run > 0 ? diff[tau] * tau / run : 1; }
      for (let tau = minLag; tau <= maxLag; tau++) {
        if (cm[tau] < 0.15) {
          while (tau + 1 <= maxLag && cm[tau + 1] < cm[tau]) tau++;
          best = tau; break;
        }
      }
      if (best < 0) {
        let m = Infinity;
        for (let tau = minLag; tau <= maxLag; tau++) if (cm[tau] < m) { m = cm[tau]; best = tau; }
        if (m > 0.35) { f0.push(0); continue; }
      }
      const a = cm[best - 1], b = cm[best], c = cm[best + 1];
      const den = a - 2 * b + c;
      const shift = den !== 0 ? Math.max(-1, Math.min(1, 0.5 * (a - c) / den)) : 0;
      f0.push(dsr / (best + shift));
    }
    return { times: Float32Array.from(times), f0: Float32Array.from(f0) };
  }

  // ---------- FFT ----------

  const fftCache = {};
  function fftTables(n) {
    if (fftCache[n]) return fftCache[n];
    const rev = new Uint32Array(n), bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      rev[i] = r;
    }
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let k = 0; k < n / 2; k++) { cos[k] = Math.cos(2 * Math.PI * k / n); sin[k] = -Math.sin(2 * Math.PI * k / n); }
    return (fftCache[n] = { rev, cos, sin });
  }

  function fft(re, im, inverse = false) {
    const n = re.length, { rev, cos, sin } = fftTables(n);
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    const sg = inverse ? -1 : 1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j, b = a + half, wr = cos[k], wi = sg * sin[k];
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }

  /** 声の明るさ（スペクトル重心）と帯域ごとの強さ */
  function spectrumStats(x, sr, levels) {
    const N = 2048;
    const candidates = [];
    const fs = levels.frameSec;
    for (let k = 0; k < levels.active.length; k++) {
      const s = Math.round(k * fs * sr);
      if (levels.active[k] && s + N <= x.length) candidates.push(s);
    }
    if (!candidates.length) for (let s = 0; s + N <= x.length; s += N) candidates.push(s);
    const pick = [];
    const step = Math.max(1, candidates.length / 200);
    for (let i = 0; i < candidates.length; i += step) pick.push(candidates[Math.floor(i)]);
    const pow = new Float64Array(N / 2 + 1);
    const re = new Float64Array(N), im = new Float64Array(N);
    for (const s of pick) {
      for (let i = 0; i < N; i++) { re[i] = x[s + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)); im[i] = 0; }
      fft(re, im);
      for (let b = 0; b <= N / 2; b++) pow[b] += re[b] * re[b] + im[b] * im[b];
    }
    const top = Math.min(8000, sr / 2);
    let num = 0, den = 0;
    for (let b = 1; b <= N / 2; b++) {
      const f = b * sr / N;
      if (f < 60 || f > top) continue;
      const m = Math.sqrt(pow[b]);
      num += f * m; den += m;
    }
    const nb = 24, lo = 80, bands = [];
    for (let i = 0; i < nb; i++) {
      const f0 = lo * Math.pow(top / lo, i / nb), f1 = lo * Math.pow(top / lo, (i + 1) / nb);
      let s = 0, c = 0;
      for (let b = Math.max(1, Math.floor(f0 * N / sr)); b <= Math.min(N / 2, Math.ceil(f1 * N / sr)); b++) { s += pow[b]; c++; }
      bands.push({ f0, f1, p: c ? s / c : 0 });
    }
    const maxP = Math.max(...bands.map((b) => b.p), 1e-20);
    for (const b of bands) b.db = 10 * Math.log10(Math.max(b.p / maxP, 1e-10));
    return { centroidHz: den > 0 ? num / den : 0, bands, frames: pick.length };
  }

  // ---------- ノイズ除去（スペクトルゲート） ----------

  async function denoise(x, sr, strength, onProgress) {
    if (!(strength > 0)) return x;
    const N = sr > 32000 ? 1024 : 512, H = N / 2, bins = N / 2 + 1;
    const win = new Float64Array(N);
    for (let i = 0; i < N; i++) win[i] = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
    const xp = new Float32Array(x.length + 2 * N);
    xp.set(x, N);
    const starts = [];
    for (let t = 0; t + N <= xp.length; t += H) starts.push(t);

    // 静かなフレーム（下位10%）からノイズの形を推定
    const valid = starts.filter((t) => t >= N && t + N <= N + x.length);
    if (valid.length < 4) return x;
    const energy = valid.map((t) => { let s = 0; for (let i = 0; i < N; i++) s += xp[t + i] * xp[t + i]; return [s, t]; });
    energy.sort((a, b) => a[0] - b[0]);
    const quiet = energy.slice(0, Math.min(400, Math.max(4, Math.round(energy.length * 0.1))));
    const noise = new Float64Array(bins);
    const re = new Float64Array(N), im = new Float64Array(N);
    for (const [, t] of quiet) {
      for (let i = 0; i < N; i++) { re[i] = xp[t + i] * win[i]; im[i] = 0; }
      fft(re, im);
      for (let b = 0; b < bins; b++) noise[b] += Math.hypot(re[b], im[b]);
    }
    for (let b = 0; b < bins; b++) noise[b] /= quiet.length;

    const over = 1 + 1.5 * strength, floor = fromDb(-6 - 18 * strength);
    const prevG = new Float64Array(bins).fill(1), G = new Float64Array(bins), Gs = new Float64Array(bins);
    const out = new Float32Array(xp.length);
    for (let f = 0; f < starts.length; f++) {
      const t = starts[f];
      for (let i = 0; i < N; i++) { re[i] = xp[t + i] * win[i]; im[i] = 0; }
      fft(re, im);
      for (let b = 0; b < bins; b++) {
        const mag = Math.hypot(re[b], im[b]);
        let g = Math.max(floor, 1 - over * noise[b] / (mag + 1e-12));
        if (g < prevG[b]) g = 0.5 * prevG[b] + 0.5 * g; // 下げるときはゆっくり（ピロピロ音の抑制）
        prevG[b] = g; G[b] = g;
      }
      for (let b = 0; b < bins; b++) Gs[b] = (G[Math.max(0, b - 1)] + 2 * G[b] + G[Math.min(bins - 1, b + 1)]) / 4;
      for (let b = 0; b < bins; b++) {
        re[b] *= Gs[b]; im[b] *= Gs[b];
        if (b > 0 && b < N / 2) { re[N - b] *= Gs[b]; im[N - b] *= Gs[b]; }
      }
      fft(re, im, true);
      for (let i = 0; i < N; i++) out[t + i] += re[i] * win[i];
      if (f % 1500 === 1499) { onProgress && onProgress(f / starts.length); await tick(); }
    }
    return out.slice(N, N + x.length);
  }

  // ---------- 速さ（WSOLA）と声の高さの変更 ----------

  /** 音の高さを変えずに長さを ratio 倍にする */
  function wsola(x, sr, ratio) {
    if (Math.abs(ratio - 1) < 1e-4) return Float32Array.from(x);
    let N = Math.round(0.04 * sr); N -= N % 2;
    const Hs = N / 2, Ha = Hs / ratio, tol = Math.round(0.012 * sr);
    const outLen = Math.round(x.length * ratio);
    const pad = N + 2 * tol + Hs;
    const xp = new Float32Array(x.length + 2 * pad);
    xp.set(x, pad);
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    const D = 4, xd = new Float32Array(Math.floor(xp.length / D));
    for (let i = 0; i < xd.length; i++) xd[i] = (xp[i * D] + xp[i * D + 1] + xp[i * D + 2] + xp[i * D + 3]) / 4;
    const out = new Float32Array(outLen + N), norm = new Float32Array(outLen + N);
    const L = Hs, LD = Math.floor(L / D), tolD = Math.floor(tol / D);
    let prev = pad;
    const frames = Math.ceil(outLen / Hs) + 1;
    for (let k = 0; k < frames; k++) {
      let pos;
      if (k === 0) pos = pad;
      else {
        const nominal = pad + Math.round(k * Ha), target = prev + Hs;
        if (target + L >= xp.length || nominal + N + tol >= xp.length) break;
        // 粗く探して（1/4に間引き）→ 細かく詰める
        const tD = Math.floor(target / D), nD = Math.floor(nominal / D);
        let best = -Infinity, bestD = 0;
        for (let dd = -tolD; dd <= tolD; dd++) {
          const c = nD + dd;
          if (c < 0 || c + LD >= xd.length) continue;
          let s = 0;
          for (let j = 0; j < LD; j++) s += xd[c + j] * xd[tD + j];
          if (s > best) { best = s; bestD = dd; }
        }
        const p0 = nominal + bestD * D;
        best = -Infinity; pos = p0;
        for (let dd = -D; dd <= D; dd++) {
          const c = p0 + dd;
          if (c < 0 || c + L >= xp.length) continue;
          let s = 0;
          for (let j = 0; j < L; j++) s += xp[c + j] * xp[target + j];
          if (s > best) { best = s; pos = c; }
        }
      }
      if (pos + N > xp.length) break;
      const so = k * Hs;
      for (let i = 0; i < N && so + i < out.length; i++) { out[so + i] += xp[pos + i] * win[i]; norm[so + i] += win[i]; }
      prev = pos;
    }
    const y = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) y[i] = norm[i] > 1e-3 ? out[i] / norm[i] : out[i];
    return y;
  }

  /** step ずつ読み進める再サンプリング（3次補間） */
  function resample(y, step, outLen) {
    const out = new Float32Array(outLen);
    const n = y.length, at = (i) => (i < 0 ? y[0] : i >= n ? y[n - 1] : y[i]);
    for (let i = 0; i < outLen; i++) {
      const p = i * step, i0 = Math.floor(p), t = p - i0;
      const a = at(i0 - 1), b = at(i0), c = at(i0 + 1), d = at(i0 + 2);
      out[i] = b + 0.5 * t * (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)));
    }
    return out;
  }

  /** semitones 半音だけ高さを変え、speed 倍速にする（長さ = 元 / speed） */
  function pitchSpeed(x, sr, semitones, speed) {
    const p = Math.pow(2, semitones / 12);
    if (Math.abs(p - 1) < 1e-4 && Math.abs(speed - 1) < 1e-4) return x;
    let y = wsola(x, sr, p / speed);
    if (Math.abs(p - 1) < 1e-4) return y;
    if (p > 1) { const fc = 0.45 * sr / p; y = lowpass(lowpass(y, sr, fc), sr, fc); }
    return resample(y, p, Math.round(x.length / speed));
  }

  // ---------- 音量をそろえる・音割れ防止 ----------

  function slidingMin(a, r) {
    const n = a.length, out = new Float32Array(n), dq = new Int32Array(n);
    let h = 0, t = 0, j = 0;
    for (let i = 0; i < n; i++) {
      const hi = Math.min(n - 1, i + r);
      while (j <= hi) { while (t > h && a[dq[t - 1]] >= a[j]) t--; dq[t++] = j; j++; }
      while (dq[h] < i - r) h++;
      out[i] = a[dq[h]];
    }
    return out;
  }

  /** 先読みリミッター。出力のピークは ceilingDb を超えない */
  function limit(x, sr, ceilingDb = -1) {
    const c = fromDb(ceilingDb), n = x.length;
    const need = new Float32Array(n);
    let any = false;
    for (let i = 0; i < n; i++) { const a = Math.abs(x[i]); if (a > c) { need[i] = c / a; any = true; } else need[i] = 1; }
    if (!any) return x;
    const look = Math.max(1, Math.round(0.005 * sr));
    const m = slidingMin(need, look);
    const cs = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + m[i];
    const rel = Math.exp(-1 / (0.08 * sr));
    const y = new Float32Array(n);
    let g = 1;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - look), b = Math.min(n, i + look + 1);
      const s = (cs[b] - cs[a]) / (b - a);
      g = s < g ? s : s + (g - s) * rel;
      y[i] = x[i] * Math.min(g, s);
    }
    return y;
  }

  /** 目標ラウドネスに合わせる。リミッターで削られた分は測り直して足す（割線法・最大6回） */
  function normalizeLoudness(x, sr, targetLufs = -16, ceilingDb = -1) {
    const L0 = lufs(x, sr);
    if (!isFinite(L0)) return x;
    const render = (gDb) => {
      const g = fromDb(gDb), z = new Float32Array(x.length);
      for (let i = 0; i < x.length; i++) z[i] = x[i] * g;
      const y = limit(z, sr, ceilingDb);
      return [y, lufs(y, sr)];
    };
    let gPrev = 0, lPrev = L0, g = Math.min(40, targetLufs - L0);
    let [y, L] = render(g), best = [y, L];
    for (let it = 0; it < 6 && Math.abs(targetLufs - L) >= 0.1; it++) {
      const slope = (L - lPrev) / (g - gPrev || 1e-9); // ゲイン1dBあたりのラウドネス変化（リミッターが効くほど1未満）
      const step = (targetLufs - L) / Math.max(0.1, Math.min(1, slope));
      gPrev = g; lPrev = L;
      g = Math.min(40, g + Math.max(-12, Math.min(12, step)));
      [y, L] = render(g);
      if (Math.abs(targetLufs - L) < Math.abs(targetLufs - best[1])) best = [y, L];
    }
    return best[0];
  }

  // ---------- 書き出し ----------

  function encodeWav(x, sr) {
    const buf = new ArrayBuffer(44 + x.length * 2), v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + x.length * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, x.length * 2, true);
    for (let i = 0; i < x.length; i++) {
      const s = Math.max(-1, Math.min(1, x[i]));
      v.setInt16(44 + i * 2, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
    }
    return buf;
  }

  function pcm16ToFloat(bytes) {
    const n = Math.floor(bytes.length / 2), out = new Float32Array(n);
    const v = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
    for (let i = 0; i < n; i++) out[i] = v.getInt16(i * 2, true) / 32768;
    return out;
  }

  // ---------- 台本の行と音声の対応づけ ----------

  /**
   * 1本の音声の中で、台本の各行がいつ話されているかを推定する。
   * 文字数の割合から予想した切れ目に近く、かつ長い「間」を、行の数-1個だけ順番に選ぶ（動的計画法）。
   * weights: 各行の重み（文字数）。返り値: [{start, end}]（秒）と、間で合わせられたか(snapped)
   */
  function alignLines(x, sr, weights) {
    const n = weights.length, dur = x.length / sr;
    const lv = analyzeLevels(x, sr), fs = lv.frameSec, act = lv.active;
    let first = 0, last = act.length - 1;
    while (first < act.length && !act[first]) first++;
    while (last > 0 && !act[last]) last--;
    let t0 = first * fs, t1 = Math.min(dur, (last + 1) * fs);
    if (!(t1 > t0)) { t0 = 0; t1 = dur; }
    if (n <= 1) return { segs: [{ start: t0, end: t1 }], snapped: true };
    const w = weights.map((v) => Math.max(1, v)), total = w.reduce((a, b) => a + b, 0);
    const expect = [];
    for (let k = 0, acc = 0; k < n - 1; k++) { acc += w[k]; expect.push(t0 + (t1 - t0) * acc / total); }
    const gaps = lv.silences.filter((s) => s.start > t0 && s.end < t1 && s.end - s.start >= 0.06);
    const K = n - 1, G = gaps.length, span = t1 - t0;
    let bounds, snapped = false;
    if (G >= K) {
      const cost = (k, j) => Math.abs((gaps[j].start + gaps[j].end) / 2 - expect[k]) / span - 0.15 * Math.min(gaps[j].end - gaps[j].start, 1);
      const dp = [], from = [];
      for (let k = 0; k < K; k++) { dp.push(new Float64Array(G).fill(Infinity)); from.push(new Int32Array(G).fill(-1)); }
      for (let j = 0; j < G; j++) dp[0][j] = cost(0, j);
      for (let k = 1; k < K; k++) {
        let best = Infinity, bi = -1;
        for (let j = 0; j < G; j++) {
          if (j > 0 && dp[k - 1][j - 1] < best) { best = dp[k - 1][j - 1]; bi = j - 1; }
          if (bi >= 0) { dp[k][j] = best + cost(k, j); from[k][j] = bi; }
        }
      }
      let j = -1, m = Infinity;
      for (let q = 0; q < G; q++) if (dp[K - 1][q] < m) { m = dp[K - 1][q]; j = q; }
      const pick = [];
      for (let k = K - 1; k >= 0; k--) { pick.unshift(gaps[j]); j = from[k][j]; }
      bounds = pick; snapped = true;
    } else bounds = expect.map((t) => ({ start: t, end: t }));
    const segs = [];
    let s = t0;
    for (const b of bounds) { segs.push({ start: s, end: b.start }); s = b.end; }
    segs.push({ start: s, end: t1 });
    return { segs, snapped };
  }

  /** 字幕の突き合わせ用に文字をそろえる（句読点・空白を除き、数字や「Google」の書き方の違いを吸収） */
  function normText(t) {
    const kanji = { '〇': '0', '一': '1', '二': '2', '三': '3', '四': '4', '五': '5', '六': '6', '七': '7', '八': '8', '九': '9' };
    return String(t || '').toLowerCase()
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[〇一二三四五六七八九]/g, (c) => kanji[c])
      .replace(/google/g, 'グーグル')
      .replace(/[\s、。，．,.!?！？「」『』（）()・…ー―\-〜~"'“”‘’；：;:《》〈〉【】]/g, '');
  }

  function editDistance(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = new Int32Array(n + 1), cur = new Int32Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      [prev, cur] = [cur, prev];
    }
    return prev[n];
  }

  /**
   * 音声の断片（間で区切ったもの）の文字起こしを、台本の各行に順番どおり割り当てる。
   * どの行にも1つ以上の断片が入るように、文字の食い違い（編集距離）が最小になる分け方を動的計画法で求める。
   * 返り値: 各行に入る断片の範囲 [{from, to}]（to は含む）。断片が行より少なければ null
   */
  function assignChunks(chunkTexts, lineTexts) {
    const M = chunkTexts.length, N = lineTexts.length;
    if (M < N || !N) return null;
    // （笑）（ため息）のような注記は文字として数えない
    const strip = (t) => String(t || '').replace(/[（(][^）)]*[）)]/g, '');
    const c = chunkTexts.map((t) => normText(strip(t))), l = lineTexts.map((t) => normText(strip(t)));
    // 言葉のない断片（息・笑い・ため息など）は、話し始める前に出ることが多いので次の行の頭に付ける。
    // 行の「終わり」に付くときだけ小さな費用を足して、同点のときに次の行へ寄せる
    const NONVERBAL = 0.6;
    const INF = 1e18, dp = [], from = [];
    for (let k = 0; k <= N; k++) { dp.push(new Float64Array(M + 1).fill(INF)); from.push(new Int32Array(M + 1).fill(-1)); }
    dp[0][0] = 0;
    for (let k = 1; k <= N; k++) {
      for (let i = k; i <= M - (N - k); i++) {
        let text = '', trailing = 0, onlyTrailing = true;
        for (let j = i - 1; j >= k - 1; j--) {
          text = c[j] + text; // 断片 j..i-1 を行 k-1 に入れる
          if (onlyTrailing && !c[j]) trailing++; else onlyTrailing = false;
          if (dp[k - 1][j] >= INF) continue;
          // 行の中身がすべて言葉のない断片なら、末尾扱いにしない（その行の頭として数える）
          const tail = onlyTrailing ? Math.max(0, trailing - 1) : trailing;
          const v = dp[k - 1][j] + editDistance(text, l[k - 1]) + NONVERBAL * tail;
          if (v < dp[k][i]) { dp[k][i] = v; from[k][i] = j; }
        }
      }
    }
    if (dp[N][M] >= INF) return null;
    const out = [];
    for (let k = N, i = M; k > 0; k--) { const j = from[k][i]; out.unshift({ from: j, to: i - 1 }); i = j; }
    return out;
  }

  // ---------- まとめて分析 ----------

  function analyze(x, sr) {
    const duration = x.length / sr;
    const levels = analyzeLevels(x, sr);
    // 音割れ = 上限に3サンプル以上張り付いた箇所（ピークがちょうど上限なだけのものは数えない）
    let clipRuns = 0;
    for (let i = 0, run = 0; i <= x.length; i++) {
      if (i < x.length && Math.abs(x[i]) >= 0.999) run++;
      else { if (run >= 3) clipRuns++; run = 0; }
    }
    const pitch = pitchTrack(x, sr, Math.max(fromDb(levels.thresholdDb), 0.001));
    const voiced = Array.from(pitch.f0).filter((v) => v > 0);
    const f0Median = voiced.length ? percentile(voiced, 0.5) : 0;
    const f0P10 = voiced.length ? percentile(voiced, 0.1) : 0;
    const f0P90 = voiced.length ? percentile(voiced, 0.9) : 0;
    const spec = spectrumStats(x, sr, levels);
    const longSilences = levels.silences.filter((s) => s.end - s.start >= 0.7 && s.start > 0.05 && s.end < duration - 0.1).length;
    return {
      duration, sr,
      peakDb: db(peak(x)), clipRuns,
      lufs: lufs(x, sr),
      noiseDb: levels.noiseDb, speechDb: levels.speechDb,
      speechSec: levels.speechSec,
      silenceRatio: duration > 0 ? Math.max(0, 1 - levels.speechSec / duration) : 0,
      longSilences,
      f0Median, f0P10, f0P90,
      rangeSemitones: f0P10 > 0 ? 12 * Math.log2(f0P90 / f0P10) : 0,
      voicedRatio: pitch.f0.length ? voiced.length / pitch.f0.length : 0,
      centroidHz: spec.centroidHz, bands: spec.bands,
      pitch, levels,
    };
  }

  return {
    db, fromDb, toMono, peak, percentile, lowpass, kWeight, lufs,
    analyzeLevels, cutSilence, pitchTrack, fft, spectrumStats, denoise,
    wsola, resample, pitchSpeed, limit, normalizeLoudness, encodeWav, pcm16ToFloat, alignLines, normText, editDistance, assignChunks, analyze,
  };
});
