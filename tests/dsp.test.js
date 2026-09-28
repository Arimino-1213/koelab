// node tests/dsp.test.js
const DSP = require('../dsp.js');
let fail = 0;
const ok = (cond, msg) => { console.log((cond ? '  OK ' : '  NG ') + msg); if (!cond) fail++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const sr = 48000;
const sine = (f, sec, amp = 0.5, rate = sr) => { const x = new Float32Array(Math.round(sec * rate)); for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin(2 * Math.PI * f * i / rate); return x; };
// 声っぽい信号（倍音つき）
const voice = (f, sec, rate = sr) => { const x = new Float32Array(Math.round(sec * rate)); for (let i = 0; i < x.length; i++) { let s = 0; for (let h = 1; h <= 8; h++) s += Math.sin(2 * Math.PI * f * h * i / rate) / h; x[i] = 0.25 * s; } return x; };
const concat = (...a) => { const o = new Float32Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
let seed = 1; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };

console.log('LUFS（規格値との照合）');
{
  // 997Hz・振幅0.1 のモノラル正弦波 = -23.0 LUFS（フルスケール正弦波は -3.01 LUFS）
  const L = DSP.lufs(sine(997, 10, 0.1), sr);
  ok(near(L, -23.0, 0.1), `997Hz -20dBFS → ${L.toFixed(2)} LUFS（期待 -23.0）`);
  const L2 = DSP.lufs(sine(997, 10, 0.1, 44100), 44100);
  ok(near(L2, -23.0, 0.1), `44.1kHz でも ${L2.toFixed(2)} LUFS`);
  ok(DSP.lufs(new Float32Array(sr), sr) === -Infinity, '無音は -Infinity');
}

console.log('声の高さ');
for (const f of [90, 150, 220, 330]) {
  const pt = DSP.pitchTrack(voice(f, 2), sr);
  const v = Array.from(pt.f0).filter((x) => x > 0);
  const med = DSP.percentile(v, 0.5);
  ok(near(med, f, f * 0.015), `${f}Hz → ${med.toFixed(1)}Hz（有声 ${v.length}/${pt.f0.length}）`);
}

console.log('速さ・高さの変更');
{
  const x = voice(200, 3);
  for (const [semi, speed] of [[0, 1.5], [0, 0.75], [12, 1], [-5, 1], [4, 1.25]]) {
    const y = DSP.pitchSpeed(x, sr, semi, speed);
    const expLen = Math.round(x.length / speed);
    const med = DSP.percentile(Array.from(DSP.pitchTrack(y, sr).f0).filter((v) => v > 0), 0.5);
    const expF = 200 * Math.pow(2, semi / 12);
    ok(Math.abs(y.length - expLen) <= 2 && near(med, expF, expF * 0.02),
      `半音${semi >= 0 ? '+' : ''}${semi}・${speed}倍 → 長さ ${(y.length / sr).toFixed(3)}s（期待 ${(expLen / sr).toFixed(3)}）, ${med.toFixed(1)}Hz（期待 ${expF.toFixed(1)}）`);
  }
  // 速さだけ変えたとき音量が崩れない（つなぎ目で山や谷ができない）
  const y = DSP.wsola(sine(200, 2), sr, 1.3);
  const mid = y.subarray(sr * 0.2, y.length - sr * 0.2);
  let mn = 1, mx = 0; const f = Math.round(sr * 0.02);
  for (let s = 0; s + f < mid.length; s += f) { let e = 0; for (let i = 0; i < f; i++) e += mid[s + i] ** 2; const r = Math.sqrt(e / f); mn = Math.min(mn, r); mx = Math.max(mx, r); }
  ok(mx / mn < 1.15, `伸ばしたときの音量ゆれ ${(20 * Math.log10(mx / mn)).toFixed(2)} dB`);
}

console.log('無音カット');
{
  const x = concat(voice(180, 1), new Float32Array(sr * 2), voice(180, 1), new Float32Array(sr * 0.3), voice(180, 1));
  const lv = DSP.analyzeLevels(x, sr);
  const y = DSP.cutSilence(x, sr, lv, { minSilence: 0.5, keep: 0.15 });
  // 合計5.3秒。2秒の無音（語尾の余韻0.1秒を除く1.86秒）は前後0.15秒ずつ残して詰める → 約3.74秒。0.3秒の間はそのまま
  ok(near(y.length / sr, 3.74, 0.05), `5.3秒 → ${(y.length / sr).toFixed(2)}秒（期待 約3.74）`);
  const a = DSP.analyze(x, sr);
  ok(a.longSilences === 1, `長い間の数 ${a.longSilences}（期待 1）`);
  // 無音 2.3秒から余韻分（0.14秒×2か所）を引いた 2.02秒 / 5.3秒
  ok(near(a.silenceRatio, 2.02 / 5.3, 0.03), `無音の割合 ${(a.silenceRatio * 100).toFixed(0)}%（期待 約38%）`);
}

console.log('音割れの数え方');
{
  const x = voice(200, 1); const pk = DSP.peak(x); for (let i = 0; i < x.length; i++) x[i] /= pk; // ピークがちょうど 1.0
  ok(DSP.analyze(x, sr).clipRuns === 0, 'ピークがちょうど上限なだけ → 0か所');
  const y = voice(200, 1).map((v) => Math.max(-1, Math.min(1, v * 3))); // 3倍にして頭打ち
  ok(DSP.analyze(y, sr).clipRuns > 50, `頭打ちした声 → ${DSP.analyze(y, sr).clipRuns}か所`);
}

console.log('台本の行と音声の対応づけ');
{
  const gap = (s) => new Float32Array(Math.round(s * sr));
  // 3行：1.0秒 / 2.0秒（途中に0.2秒の息継ぎ）/ 0.6秒。行間は0.45秒。前後に0.3秒の無音
  const x = concat(gap(0.3), voice(200, 1.0), gap(0.45), voice(180, 0.9), gap(0.2), voice(180, 0.9), gap(0.45), voice(220, 0.6), gap(0.3));
  const { segs, snapped } = DSP.alignLines(x, sr, [10, 20, 6]);
  const starts = segs.map((s) => s.start.toFixed(2)).join(', ');
  // 本当の開始: 0.30 / 1.75 / 4.20
  ok(snapped && near(segs[0].start, 0.3, 0.06) && near(segs[1].start, 1.75, 0.06) && near(segs[2].start, 4.2, 0.06), `開始時刻 ${starts}（正解 0.30, 1.75, 4.20。息継ぎを行の切れ目と取り違えない）`);
  // 実際の読み上げ音声（Haruka）。1行目の途中「こんにちは。」の後にも行間と同じ長さの間がある難しい例
  // 正解（ffmpeg silencedetect）: 2行目 5.63秒・3行目 8.78秒
  const fs = require('fs'), path = require('path');
  const wavPath = path.join(__dirname, 'samples', 'voice_raw.wav');
  if (fs.existsSync(wavPath)) {
    const b = fs.readFileSync(wavPath), rsr = b.readUInt32LE(24);
    const rx = DSP.pcm16ToFloat(new Uint8Array(b.buffer, b.byteOffset + 44, b.length - 44));
    const w = ['こんにちは。今日は、声の編集アプリを試しています。', 'ここで少し、間を空けます。', '音声や動画をドラッグして、分析して、変換したものを書き出せます。']
      .map((t) => [...t.replace(/[\s、。]/g, '')].length);
    const r = DSP.alignLines(rx, rsr, w);
    ok(near(r.segs[1].start, 5.63, 0.1) && near(r.segs[2].start, 8.78, 0.1), `実音声の行の開始 ${r.segs.map((s) => s.start.toFixed(2)).join(', ')}（正解 2行目5.63・3行目8.78）`);
  }
  const one = DSP.alignLines(x, sr, [5]);
  ok(one.segs.length === 1 && near(one.segs[0].start, 0.3, 0.06), '1行だけなら全体が1区間');
  const flat = DSP.alignLines(voice(200, 3), sr, [1, 1, 1]);
  ok(!flat.snapped && flat.segs.length === 3 && near(flat.segs[1].start, 1, 0.05), `間がない音声は文字数の割合で配置（${flat.segs.map((s) => s.start.toFixed(2)).join(', ')}）`);
}

console.log('文字起こしによる字幕の割り当て');
{
  // 回帰: 謝罪会見の台本。文字数の割合で予想すると 4〜6 行目がずれた（9/27）
  const lines = ['このたびは、私の軽率な行動により、皆さまに多大なるご心配をおかけしましたこと、深くお詫び申し上げます。', '具体的に何をしたのか、ご自身の口で説明してください！', '……冷蔵庫にあった、家族共有のプリンを、食べました。', '共有のプリンを！？ ふたに名前は書いてあったんですか？', '「ママ」と……書いてあったような、なかったような。', '書いてあったんですね？', '……書いてありました。'];
  // 間で区切った断片の文字起こし（数字・句読点・言い回しの揺れを含む）
  const chunks = ['この度は私の軽率な行動により', '皆様に多大なるご心配をおかけしましたこと', '深くお詫び申し上げます', '具体的に何をしたのかご自身の口で', '説明してください', '冷蔵庫にあった', '家族共有のプリンを', '食べました', '共有のプリンを', '蓋に名前は書いてあったんですか', 'ママと', '書いてあったような', 'なかったような', '書いてあったんですね', '書いてありました'];
  const g = DSP.assignChunks(chunks, lines);
  const got = g.map((r) => `${r.from}-${r.to}`).join(' ');
  ok(got === '0-2 3-4 5-7 8-9 10-12 13-13 14-14', `断片の割り当て ${got}（正解 0-2 3-4 5-7 8-9 10-12 13-13 14-14）`);
  // 中国語（簡体字）の台本でも、全角の句読点や引用符をそろえて割り当てられること
  const zh = DSP.assignChunks(['对于我的轻率行为', '给大家带来的困扰我在此深表歉意', '请您亲口说明您到底做了什么', '我把冰箱里', '全家共享的布丁', '吃掉了', '全家共享的布丁盖子上写名字了吗'],
    ['对于我的轻率行为给大家带来的困扰，我在此深表歉意。', '请您亲口说明，您到底做了什么！', '……我把冰箱里，全家共享的布丁，吃掉了。', '全家共享的布丁？！盖子上写名字了吗？']);
  ok(zh.map((r) => `${r.from}-${r.to}`).join(' ') === '0-1 2-2 3-5 6-6', `中国語の割り当て ${zh.map((r) => `${r.from}-${r.to}`).join(' ')}（正解 0-1 2-2 3-5 6-6）`);
  // 回帰（9/27 宣伝動画）: 息「……」や「（笑）」の断片が前の行の終わりに付き、2行目と6行目の字幕が遅れていた
  const promoLines = ['どうも！ 台本を渡されると、何でも演じる声のAIです。', '……ちょっと、まだ本番じゃないよ。', '失礼しました。こちら、こえラボ。1行ずつ、演技を指示できるアプリです。', 'ささやく、ため息、笑いをこらえる……全部、文章で指示できるんだ。', 'おかげで私、今日だけで三回も謝罪会見をしました。', 'プリンの件ね。', 'しかも、二人の掛け合いも一回で作れるんです。つまり……', 'つまり？', '……相方も、私です。', 'それは言わなくていいから！', '字幕つきの動画にもできます。日本語、英語、中国語にも対応しております。', 'ブラウザだけで動いて、APIキーは各自でね！', 'こえラボ。あなたの台本、演じます。リンクは投稿の下に！'];
  const promoChunks = ['どうも！台本を渡されると、何でも演じる声のAIです。', '……', 'ちょっと', 'まだ本番じゃないよ。', '失礼しました。', 'こちら', 'こえラボ。1行ずつ演技を指示できるアプリです。', 'ささやく', 'ため息', '笑いをこらえる。全部文章で指示できるんだ。', 'おかげで私、今日だけで三回も謝罪会見をしました。', '（笑）', 'プリンの件ね。', 'しかも、二人の掛け合いも一回で作れるんです。', 'つまり', 'つまり？', '相方も', '私です。', 'それは言わなくていいから！', '字幕つきの動画にもできます。日本語', '英語、中国語にも対応しております。', 'ブラウザだけで動いてAPIキーは各自でね！', 'こえラボ。', 'あなたの', 'あなたの台本、演じます。', 'リンクは投稿の下に！'];
  const pg = DSP.assignChunks(promoChunks, promoLines).map((r) => r.from).join(' ');
  ok(pg === '0 1 4 7 10 11 13 15 16 18 19 21 22', `宣伝動画の各行の始まり ${pg}（正解 0 1 4 7 10 11 13 15 16 18 19 21 22）`);
  // 回帰（9/27）: 台本を渡さずに文字起こしすると短い断片が空欄になる。空欄は次の行の頭に付けて正解になること
  const rawChunks = ['どうも。台本を渡されると何でも演じる声のAIです。', '', '', 'まだ本番じゃないよ', '', '', '声ラボ。1行ずつ演技を指示できるアプリです。', 'さや', 'ため息', '笑いをこらえる。全部文章で指示できる。', 'おかげで私今日だけで3回も謝罪会見をしました。', '', 'プリンの件', 'しかも2人の掛け合いも1回でつくれるんです。', 'つまり', 'つまり', '相手が', '私です', 'それは言わなくていいかな', '字幕付きの動画にもできます。日本', '英語、中国語にも対応しています。', 'ブラウザだけで動いてAPIキーは各自', '声ラボ', '', 'あなたの台本演じます。', 'リンクは投稿'];
  const rg = DSP.assignChunks(rawChunks, promoLines).map((r) => r.from).join(' ');
  ok(rg === '0 1 4 7 10 11 13 15 16 18 19 21 22', `空欄を含む文字起こしでも各行の始まり ${rg}（正解 0 1 4 7 10 11 13 15 16 18 19 21 22）`);
  // 回帰（9/27 08:08 の動画）: 息の断片・短い空欄・聞き違い（「おかけ」「相手も」）を含んでも各行の始まりが合うこと
  const v3Chunks = ['おお', '台本を渡されると何でも演じる声のAIです', '（息）', 'まだ本番じゃない', '失礼します', 'こちら', '声ラボ', '', '1行ずつ演技を指示できるアプリです', '囁く', 'ため息', '笑い', '', '全部', '文書で指示できる', 'おかけ', '今日だけで3回も謝罪会見をしました', 'プリンの件', 'しかも', '2人の掛け合いも1回で作成', 'つまり', 'つまり', '相手も', '私です', 'それは言わなくていいから', '字幕付きの動画も', '日本語', '中国語にも対応', 'ブラウザだけで動いてAPIキーは各自で', '声ラボ', 'あなたの台本演じます', 'リンクは投稿の'];
  const v3 = DSP.assignChunks(v3Chunks, promoLines).map((r) => r.from).join(' ');
  ok(v3 === '0 2 4 9 15 17 18 21 22 24 25 28 29', `08:08の動画の各行の始まり ${v3}（正解 0 2 4 9 15 17 18 21 22 24 25 28 29）`);
  ok(DSP.assignChunks(['あ'], ['あ', 'い']) === null, '断片が行より少なければ null（従来の方法に戻す）');
  ok(DSP.normText('１つ、一つ Google！') === '1つ1つググル', `表記ゆれをそろえる（${DSP.normText('１つ、一つ Google！')}）`);
}

console.log('リミッター・音量そろえ');
{
  const x = sine(300, 2, 0.3); for (let i = sr; i < sr + 200; i++) x[i] = 1.8; // 突発的な大きな音
  const y = DSP.limit(x, sr, -1);
  ok(DSP.peak(y) <= DSP.fromDb(-1) + 1e-6, `ピーク ${DSP.db(DSP.peak(y)).toFixed(2)} dBFS（上限 -1）`);
  const z = DSP.normalizeLoudness(voice(200, 5).map((v) => v * 0.05), sr, -16);
  const L = DSP.lufs(z, sr);
  ok(near(L, -16, 0.5) && DSP.peak(z) <= DSP.fromDb(-1) + 1e-6, `小さい声 → ${L.toFixed(2)} LUFS・ピーク ${DSP.db(DSP.peak(z)).toFixed(2)} dBFS`);
  // 回帰: ピークの大きい素材（リミッターが強くかかる）でも目標に届くこと。以前は -17.6 で止まっていた
  // 声＋0.25秒ごとの鋭いピーク（ピークとラウドネスの差 約25dB。旧実装では -23.9 LUFS 止まり）
  const spiky = voice(200, 4).map((v) => v * 0.05);
  for (let t = 0.1; t < 4; t += 0.25) { const s = Math.round(t * sr); for (let i = 0; i < 96; i++) spiky[s + i] += 0.5 * Math.sin(Math.PI * i / 96); }
  const zs = DSP.normalizeLoudness(spiky, sr, -16);
  const Ls = DSP.lufs(zs, sr);
  ok(near(Ls, -16, 0.3) && DSP.peak(zs) <= DSP.fromDb(-1) + 1e-6, `ピークの大きい素材 → ${Ls.toFixed(2)} LUFS・ピーク ${DSP.db(DSP.peak(zs)).toFixed(2)} dBFS`);
}

console.log('ノイズ除去');
(async () => {
  const clean = concat(new Float32Array(sr), voice(200, 2), new Float32Array(sr));
  const noisy = clean.map((v) => v + rnd() * 0.02);
  const y = await DSP.denoise(noisy, sr, 0.7);
  const rms = (a, s, e) => { let t = 0; for (let i = s; i < e; i++) t += a[i] ** 2; return Math.sqrt(t / (e - s)); };
  const nBefore = rms(noisy, 1000, sr - 1000), nAfter = rms(y, 1000, sr - 1000);
  const sBefore = rms(noisy, sr + 1000, 3 * sr - 1000), sAfter = rms(y, sr + 1000, 3 * sr - 1000);
  ok(DSP.db(nAfter / nBefore) < -10, `無音部のノイズ ${DSP.db(nAfter / nBefore).toFixed(1)} dB`);
  ok(Math.abs(DSP.db(sAfter / sBefore)) < 1.5, `声の部分の音量変化 ${DSP.db(sAfter / sBefore).toFixed(2)} dB`);
  ok(y.length === noisy.length, '長さが変わらない');

  console.log('WAV・FFT');
  const w = DSP.encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1]), 24000);
  ok(w.byteLength === 54 && new DataView(w).getUint32(24, true) === 24000, 'WAVヘッダ');
  const back = DSP.pcm16ToFloat(new Uint8Array(w, 44));
  ok(near(back[1], 0.5, 1e-3) && near(back[4], -1, 1e-3), '16bit 読み戻し');
  const re = Float64Array.from({ length: 64 }, (_, i) => Math.sin(i) + i * 0.01), im = new Float64Array(64), orig = Float64Array.from(re);
  DSP.fft(re, im); DSP.fft(re, im, true);
  ok(orig.every((v, i) => near(v, re[i], 1e-9)), 'FFT 往復一致');

  console.log('処理時間（1分の声）');
  const long = voice(160, 60);
  let t = Date.now(); DSP.analyze(long, sr); const tA = Date.now() - t;
  t = Date.now(); DSP.pitchSpeed(long, sr, 3, 1.1); const tP = Date.now() - t;
  t = Date.now(); await DSP.denoise(long, sr, 0.5); const tD = Date.now() - t;
  console.log(`  分析 ${tA}ms / 高さ+速さ ${tP}ms / ノイズ除去 ${tD}ms`);

  console.log(fail ? `\n${fail} 件 失敗` : '\nすべて成功');
  process.exit(fail ? 1 : 0);
})();
