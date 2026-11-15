/* こえラボ — 画面の動き（依存なし）
   「動きを減らす」設定の端末では何も動かさず、最初から全部見える（<html class="motion"> のときだけ動く。class は index.html の head で付ける）。
   動きは見た目だけで、分析・変換・書き出しの処理には関わらない。見えていない描画は止める。

   KoeMotion.reduce            動きを減らす設定なら true
   KoeMotion.split(el)         見出しを1文字ずつ持ち上げて出す（語の途中で折れないよう語ごとにまとめる）
   KoeMotion.countUp(el)       中の数字を0から数え上げる（最後は必ず元の文字に戻す）
   KoeMotion.replay(el, cls)   CSS の動きを最初からやり直す
   KoeMotion.loop(el, fn)      el が画面に見えていて、タブが表に出ている間だけ fn(時刻ms) を毎コマ呼ぶ
   KoeMotion.scope(canvas)     声の波形が流れる背景（ファイルを置く枠の後ろ）。戻り値の .level(数) で振れ幅を変える */
(function () {
  'use strict';
  var root = document.documentElement;
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  root.classList.toggle('motion', !reduce);
  var ease = function (t) { return 1 - Math.pow(1 - t, 3); };

  function split(el) {
    if (!el || el.classList.contains('sp')) return;
    if (!el.hasAttribute('aria-label')) el.setAttribute('aria-label', el.textContent.replace(/\s+/g, ' ').trim());
    var n = 0;
    (function walk(node) {
      Array.prototype.slice.call(node.childNodes).forEach(function (ch) {
        if (ch.nodeType === 3) {
          var frag = document.createDocumentFragment(), words = [ch.nodeValue];
          if (window.Intl && Intl.Segmenter) {
            words = [];
            Array.from(new Intl.Segmenter('ja', { granularity: 'word' }).segment(ch.nodeValue)).forEach(function (g) {
              var t = g.segment;
              if (words.length && /^[ぁ-んー、。，．！？!?・」』）)]+$/.test(t) && words[words.length - 1].trim()) words[words.length - 1] += t; else words.push(t);
            });
          }
          words.forEach(function (wd) {
            if (!wd.trim()) { frag.appendChild(document.createTextNode(wd)); return; }
            var box = document.createElement('span'); box.className = 'sp-w'; box.setAttribute('aria-hidden', 'true');
            Array.from(wd).forEach(function (t) {
              var o = document.createElement('span'); o.className = 'sp-o';
              var i = document.createElement('span'); i.className = 'sp-i'; i.textContent = t; i.style.setProperty('--i', n++);
              o.appendChild(i); box.appendChild(o);
            });
            frag.appendChild(box);
          });
          node.replaceChild(frag, ch);
        } else if (ch.nodeType === 1 && ch.tagName !== 'BR') walk(ch);
      });
    })(el);
    el.classList.add('sp');
  }

  // "0:27.2"（分:秒）・"-36.3"・"244" のような数字を数え上げる。数字でない文字（"—" "−90未満"）はそのまま
  function countUp(el, delay) {
    var node = el && el.firstChild;
    if (!node || node.nodeType !== 3) return;
    var final = node.nodeValue, m;
    if (reduce) return;
    var fmt, target;
    if ((m = final.match(/^(\d+):(\d{2})\.(\d)$/))) {
      target = +m[1] * 60 + +m[2] + +m[3] / 10;
      fmt = function (v) { var t = Math.round(v * 10), mm = Math.floor(t / 600); return mm + ':' + ((t - mm * 600) / 10).toFixed(1).padStart(4, '0'); };
    } else if ((m = final.match(/^(-?)(\d+)(?:\.(\d+))?$/))) {
      var dec = m[3] ? m[3].length : 0;
      target = parseFloat(final);
      fmt = function (v) { return v.toFixed(dec); };
    } else return;
    var t0 = 0, dur = 750;
    node.nodeValue = fmt(0);
    function step(now) {
      if (!t0) t0 = now + (delay || 0);
      var p = Math.max(0, Math.min(1, (now - t0) / dur));
      if (el.firstChild !== node) return; // 描き直された
      node.nodeValue = p >= 1 ? final : fmt(target * ease(p));
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function replay(el, cls) {
    if (!el || reduce) return;
    el.classList.remove(cls);
    void el.offsetWidth; // 動きを最初から
    el.classList.add(cls);
  }

  // 見えている間だけ毎コマ動かす（隠れたタブ・画面外・display:none では止まる）
  function loop(el, fn) {
    var seen = false, raf = 0;
    function frame(now) { raf = 0; fn(now); run(); }
    function run() { if (!raf && seen && !document.hidden) raf = requestAnimationFrame(frame); }
    function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }
    new IntersectionObserver(function (es) { seen = es[es.length - 1].isIntersecting; if (seen) run(); else stop(); }).observe(el);
    document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); else run(); });
  }

  // 声の波形が流れる背景。音節のような山が右から左へ流れていく（重ねた正弦波・乱数なし）
  function scope(canvas) {
    var g = canvas.getContext('2d'), amp = 1, target = 1, w = 0, h = 0, dpr = 1;
    function size() {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = canvas.clientWidth; h = canvas.clientHeight;
      if (w && h) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    }
    new ResizeObserver(function () { size(); if (reduce) draw(0); }).observe(canvas);
    // 話し声らしい包絡：いくつかの「音節」が並び、間がある
    function env(x) {
      var s = 0.5 + 0.5 * Math.sin(x * 0.9) * Math.sin(x * 0.37 + 1.3);
      return Math.max(0, s - 0.18) / 0.82;
    }
    function draw(now) {
      if (!w || !h) return;
      amp += (target - amp) * 0.08;
      var t = now / 1000, mid = h / 2;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      // 目盛り（計器の格子）
      g.strokeStyle = 'rgba(36,51,224,.10)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, mid + 0.5); g.lineTo(w, mid + 0.5); g.stroke();
      var layers = [[0.13, 1, 2.2], [0.08, 0.62, 1.6], [0.05, 0.38, 3.1]];
      for (var L = 0; L < layers.length; L++) {
        var a = layers[L][0] * (1 + (amp - 1) * 2.2), scale = layers[L][1], sp = layers[L][2];
        g.strokeStyle = 'rgba(36,51,224,' + Math.min(0.55, a + (amp - 1) * 0.12) + ')';
        g.lineWidth = L === 0 ? 1.6 : 1;
        g.beginPath();
        for (var x = 0; x <= w; x += 3) {
          var u = x / 70 + t * sp * 0.55;
          var e = env(u * 0.5 + L * 2.1);
          var y = mid + Math.sin(x * 0.11 * scale + t * 9 * sp) * Math.sin(x * 0.023 + t * 2.3) * e * h * 0.36 * amp * scale;
          if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.stroke();
      }
    }
    size();
    if (reduce) draw(0); else loop(canvas, draw);
    return { level: function (v) { target = v; if (reduce) { amp = v; draw(0); } } };
  }

  window.KoeMotion = { reduce: reduce, split: split, countUp: countUp, replay: replay, loop: loop, scope: scope };
})();
