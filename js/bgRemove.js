/* 背景移除
   首选 MODNet（onnxruntime-web + 本地 onnx，输出连续 alpha matte，发丝自然）
   降级 MediaPipe Selfie Segmentation
   输出 alpha 为 Float32Array（0–1），分辨率 = 输入画布尺寸 */
(function () {
  'use strict';

  var ORT_V = '1.20.0';
  var ORT_JS = [
    'https://cdn.jsdelivr.net/npm/onnxruntime-web@' + ORT_V + '/dist/ort.min.js',
    'https://unpkg.com/onnxruntime-web@' + ORT_V + '/dist/ort.min.js'
  ];
  var ORT_WASM = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@' + ORT_V + '/dist/';
  /* 模型同域相对路径（/models/），由启动页统一预加载；不走任何外部 CDN */
  var MODNET_URLS = ['models/modnet.onnx'];

  /* 启动页把已下载的 model.onnx 原始 buffer 交进来，直接建 session，不重新下载 */
  var _modnetBuffer = null;
  function setModnetBuffer(buf) {
    if (buf && buf.byteLength) _modnetBuffer = buf;
  }
  /* MODNet 输入短边。512 时整理 matte 只有 512 级信息量，交付到 880px 宽会把发丝放大 3.1× 拉糊，
     故与 main.js 的 ANALYZE_SHORT 一起提到 1024。 */
  var SEG_SHORT = 1024, SEG_LONG_CAP = 2048;

  var _ortP = null, _session = null, _modnetP = null, _seg = null, _segP = null;

  /* ---------- 工具 ---------- */
  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { res(); };
      s.onerror = function () { rej(new Error('脚本加载失败：' + src)); };
      document.head.appendChild(s);
    });
  }

  function fetchWithProgress(url, onProgress) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var total = +(r.headers.get('content-length') || 0);
      if (!r.body || !total) return r.arrayBuffer();
      var reader = r.body.getReader(), chunks = [], got = 0;
      return (function pump() {
        return reader.read().then(function (x) {
          if (x.done) {
            var buf = new Uint8Array(got), off = 0;
            for (var i = 0; i < chunks.length; i++) { buf.set(chunks[i], off); off += chunks[i].length; }
            return buf.buffer;
          }
          chunks.push(x.value); got += x.value.length;
          if (onProgress) onProgress(got / total);
          return pump();
        });
      })();
    });
  }

  function bilinear(src, sw, sh, dw, dh, out) {
    out = out || new Float32Array(dw * dh);
    var xs = sw / dw, ys = sh / dh;
    for (var y = 0; y < dh; y++) {
      var fy = (y + 0.5) * ys - 0.5;
      if (fy < 0) fy = 0; else if (fy > sh - 1) fy = sh - 1;
      var y0 = fy | 0, y1 = y0 + 1 < sh ? y0 + 1 : sh - 1, wy = fy - y0;
      var r0 = y0 * sw, r1 = y1 * sw, o = y * dw;
      for (var x = 0; x < dw; x++) {
        var fx = (x + 0.5) * xs - 0.5;
        if (fx < 0) fx = 0; else if (fx > sw - 1) fx = sw - 1;
        var x0 = fx | 0, x1 = x0 + 1 < sw ? x0 + 1 : sw - 1, wx = fx - x0;
        var a = src[r0 + x0], b = src[r0 + x1], c = src[r1 + x0], d = src[r1 + x1];
        out[o + x] = (a * (1 - wx) + b * wx) * (1 - wy) + (c * (1 - wx) + d * wx) * wy;
      }
    }
    return out;
  }

  /* ---------- 引擎 1：MODNet ---------- */
  function loadOrt(onStage) {
    if (_ortP) return _ortP;
    _ortP = (function () {
      if (window.ort) return Promise.resolve(window.ort);
      var chain = Promise.reject();
      ORT_JS.forEach(function (url) {
        chain = chain.catch(function () {
          if (onStage) onStage('正在加载抠图运行时…');
          return loadScript(url).then(function () {
            if (!window.ort) throw new Error('no ort');
          });
        });
      });
      return chain.then(function () {
        var ort = window.ort;
        /* 单线程 + 不开 SAB，否则 Cloudflare Pages 没设 COOP/COEP 会直接失败 */
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.simd = true;
        ort.env.wasm.wasmPaths = ORT_WASM;
        ort.env.logLevel = 'error';
        return ort;
      }).catch(function () {
        _ortP = null;
        throw new Error('抠图运行时加载失败，请检查网络或改用「标准抠图」');
      });
    })();
    return _ortP;
  }

  /* 按需加载 MODNet（用户点「高精度抠图」才调用） */
  function ensureModnet(onStage, onProgress) {
    if (_session) return Promise.resolve(_session);
    if (_modnetP) return _modnetP;
    _modnetP = loadOrt(onStage).then(function (ort) {
      if (onStage) onStage('正在初始化 MODNet…');
      var chain = Promise.reject();
      var lastErr = null;
      var sources = _modnetBuffer ? [{ buf: _modnetBuffer }] : MODNET_URLS.map(function (u) { return { url: u }; });
      sources.forEach(function (src) {
        chain = chain.catch(function () {
          var getBuf = src.buf
            ? Promise.resolve(src.buf)
            : fetchWithProgress(src.url, function (p) { if (onProgress) onProgress(p); });
          return getBuf.then(function (buf) {
            if (onStage) onStage('正在初始化 MODNet…');
            return ort.InferenceSession.create(buf, {
              executionProviders: ['wasm'],
              graphOptimizationLevel: 'all'
            });
          }).catch(function (e) { lastErr = e; throw e; });
        });
      });
      return chain.then(function (s) {
        _session = s;
        return s;
      }).catch(function () {
        _modnetP = null;
        throw new Error('MODNet 模型加载失败（' + (lastErr && lastErr.message || '') + '）');
      });
    });
    return _modnetP;
  }

  /* MODNet 输入尺寸：短边 512、32 整除、长边 ≤1024 */
  function modnetInputSize(w, h) {
    var s = SEG_SHORT / Math.min(w, h);
    if (Math.max(w, h) * s > SEG_LONG_CAP) s = SEG_LONG_CAP / Math.max(w, h);
    function r32(v) { return Math.max(32, Math.ceil(v / 32) * 32); }
    return [r32(w * s), r32(h * s)];
  }

  function modnetMatte(canvas) {
    var ort = window.ort;
    var w = canvas.width, h = canvas.height;
    var iw = modnetInputSize(w, h)[0], ih = modnetInputSize(w, h)[1];

    var c = document.createElement('canvas');
    c.width = iw; c.height = ih;
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, iw, ih);
    var px = ctx.getImageData(0, 0, iw, ih).data;

    var n = iw * ih, data = new Float32Array(3 * n);
    for (var i = 0; i < n; i++) {
      var o = i * 4;
      /* (x/255 - 0.5) / 0.5  → [-1,1]（与 preprocessor_config 一致） */
      data[i] = px[o] / 127.5 - 1;
      data[n + i] = px[o + 1] / 127.5 - 1;
      data[2 * n + i] = px[o + 2] / 127.5 - 1;
    }

    var feeds = {};
    feeds[_session.inputNames[0]] = new ort.Tensor('float32', data, [1, 3, ih, iw]);

    return _session.run(feeds).then(function (out) {
      var t = null;
      _session.outputNames.forEach(function (k) { if (!t && out[k]) t = out[k]; });
      if (!t) throw new Error('MODNet 无输出');
      var dims = t.dims;
      var oh = dims.length === 4 ? dims[2] : ih;
      var ow = dims.length === 4 ? dims[3] : iw;
      var raw = t.data;
      var m = new Float32Array(ow * oh);
      var minv = Infinity, maxv = -Infinity;
      for (var i = 0; i < m.length; i++) {
        var v = raw[i];
        m[i] = v;
        if (v < minv) minv = v;
        if (v > maxv) maxv = v;
      }
      /* 只在明显超出 [0,1] 时才做归一化，避免把合法的软边压硬 */
      if (maxv - minv < 1e-6) m.fill(1);
      else if (maxv > 1.5 || minv < -0.5) {
        for (i = 0; i < m.length; i++) m[i] = (m[i] - minv) / (maxv - minv);
      }
      return { data: m, w: ow, h: oh };
    });
  }

  /* ---------- 引擎 2：MediaPipe Selfie Segmentation（降级） ---------- */
  function ensureFallback() {
    if (_seg) return Promise.resolve(_seg);
    if (_segP) return _segP;
    _segP = window.IDP.loadVision().then(function (v) {
      return window.IDP.FaceDetect.SEG_MODEL.reduce(function (chain, url) {
        return chain.catch(function () {
          return v.mod.ImageSegmenter.createFromOptions(v.fileset, {
            baseOptions: { modelAssetPath: url, delegate: 'GPU' },
            runningMode: 'IMAGE', outputCategoryMask: true, outputConfidenceMasks: true
          }).catch(function () {
            return v.mod.ImageSegmenter.createFromOptions(v.fileset, {
              baseOptions: { modelAssetPath: url, delegate: 'CPU' },
              runningMode: 'IMAGE', outputCategoryMask: true, outputConfidenceMasks: true
            });
          });
        });
      }, Promise.reject()).then(function (s) { _seg = s; return s; })
        .catch(function (e) {
          _segP = null;
          throw new Error('降级抠图模型加载失败（' + (e && e.message || '') + '）');
        });
    });
    return _segP;
  }

  function maskToArray(mask) {
    if (!mask) return null;
    try { return mask.getAsFloat32Array(); } catch (e) { }
    try { return mask.getAsUint8Array(); } catch (e) { }
    return null;
  }

  /* 从候选蒙版里挑「人」的那一路：人像中心亮、四边暗 */
  function pickPersonMask(res) {
    var cands = [];
    if (res.confidenceMasks) {
      for (var i = 0; i < res.confidenceMasks.length; i++) {
        var m = res.confidenceMasks[i], arr = maskToArray(m);
        if (arr) cands.push({ arr: arr, w: m.width, h: m.height });
      }
    }
    if (!cands.length && res.categoryMask) {
      var cm = res.categoryMask, ca = maskToArray(cm);
      if (ca) {
        var bin = new Float32Array(ca.length);
        for (var k = 0; k < ca.length; k++) bin[k] = ca[k] > 0 ? 1 : 0;
        cands.push({ arr: bin, w: cm.width, h: cm.height });
      }
    }
    if (!cands.length) throw new Error('抠图模型未返回有效蒙版');

    var best = null, bestScore = -Infinity;
    for (var c = 0; c < cands.length; c++) {
      var cd = cands[c], s = 0, n = 0;
      function sampleAt(u, v) {
        var x = Math.max(0, Math.min(cd.w - 1, Math.round(u * cd.w)));
        var y = Math.max(0, Math.min(cd.h - 1, Math.round(v * cd.h)));
        return cd.arr[y * cd.w + x];
      }
      for (var gy = 0; gy < 20; gy++) for (var gx = 0; gx < 20; gx++) {
        var u = (gx + 0.5) / 20, v2 = (gy + 0.5) / 20;
        if (u > 0.38 && u < 0.62 && v2 > 0.38 && v2 < 0.62) { s += sampleAt(u, v2); n++; }
        else if (u < 0.06 || u > 0.94 || v2 < 0.06 || v2 > 0.94) { s -= sampleAt(u, v2); n++; }
      }
      var score = n ? s / n : 0;
      if (score > bestScore) { bestScore = score; best = cd; }
    }
    return best;
  }

  function fallbackMatte(canvas) {
    return ensureFallback().then(function (seg) {
      var w = canvas.width, h = canvas.height;
      var res = seg.segment(canvas);
      var picked = pickPersonMask(res);
      var lo = 0.26, hi = 0.78, span = hi - lo;
      var low = bilinear(picked.arr, picked.w, picked.h, w, h);
      for (var i = 0; i < low.length; i++) {
        var a = (low[i] - lo) / span;
        low[i] = a < 0 ? 0 : (a > 1 ? 1 : a);
      }
      if (res.close) res.close();
      return { data: low, w: w, h: h };
    });
  }

  /* ---------- 蒙版精修：联合双边，把边缘吸附到图像真实边缘 ---------- */
  function refine(alpha, rgba, w, h, radius, iters, sigmaC) {
    var i, j, x, y, k;
    var ss2 = 2 * radius * radius, sc2 = 2 * sigmaC * sigmaC;
    var sp = (2 * radius + 1) * (2 * radius + 1);
    var offs = new Int32Array(sp * 2);
    var wts = new Float32Array(sp);
    var p = 0;
    for (j = -radius; j <= radius; j++) for (i = -radius; i <= radius; i++) {
      offs[p * 2] = i; offs[p * 2 + 1] = j;
      wts[p] = Math.exp(-(i * i + j * j) / ss2);
      p++;
    }
    var cur = alpha, next = new Float32Array(w * h);
    for (var it = 0; it < iters; it++) {
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          var idx = y * w + x;
          var a0 = cur[idx];
          if (a0 < 0.02 || a0 > 0.98) { next[idx] = a0; continue; }
          var ci = idx * 4;
          var r0 = rgba[ci], g0 = rgba[ci + 1], b0 = rgba[ci + 2];
          var sum = 0, wsum = 0;
          var ylo = Math.max(0, y - radius), yhi = Math.min(h - 1, y + radius);
          var xlo = Math.max(0, x - radius), xhi = Math.min(w - 1, x + radius);
          for (k = 0; k < sp; k++) {
            var yy = y + offs[k * 2 + 1];
            if (yy < ylo || yy > yhi) continue;
            var xx = x + offs[k * 2];
            if (xx < xlo || xx > xhi) continue;
            var ni = (yy * w + xx) * 4;
            var dr = rgba[ni] - r0, dg = rgba[ni + 1] - g0, db = rgba[ni + 2] - b0;
            var wt = wts[k] * Math.exp(-(dr * dr + dg * dg + db * db) / sc2);
            sum += cur[yy * w + xx] * wt;
            wsum += wt;
          }
          next[idx] = wsum > 1e-6 ? sum / wsum : a0;
        }
      }
      var t = cur; cur = next; next = (t === alpha) ? new Float32Array(w * h) : t;
    }
    return cur;
  }

  /* ---------- 对外：分割 ---------- */
  function segment(canvas, opts) {
    opts = opts || {};
    var w = canvas.width, h = canvas.height;
    var useModnet = opts.engine === 'modnet';
    var p = useModnet
      ? ensureModnet(opts.onStage, opts.onProgress).then(function () { return modnetMatte(canvas); })
        .then(function (m) { return { m: m, engine: 'modnet' }; })
        .catch(function (e) { if (opts.strict) throw e; return fallbackMatte(canvas).then(function (m) { return { m: m, engine: 'fallback', modnetError: e.message }; }); })
      : fallbackMatte(canvas).then(function (m) { return { m: m, engine: 'fallback' }; });

    return p.then(function (r) {
      var m = r.m;
      var alpha = (m.w === w && m.h === h) ? m.data : bilinear(m.data, m.w, m.h, w, h);
      /* 对比度拉伸：把半透明带收窄，轮廓才硬（参数可调，见文件顶部 params） */
      var lo = r.engine === 'modnet' ? params.alphaLo : 0.0;
      var hi = r.engine === 'modnet' ? params.alphaHi : 1.0;
      var span = hi - lo;
      for (var i = 0; i < alpha.length; i++) {
        var a = (alpha[i] - lo) / span;
        alpha[i] = a < 0 ? 0 : (a > 1 ? 1 : a);
      }
      var img = canvas.getContext('2d').getImageData(0, 0, w, h);
      alpha = refine(alpha, img.data, w, h, params.rRadius, params.rIters, params.rSigma);
      return { alpha: alpha, w: w, h: h, engine: r.engine, modnetError: r.modnetError };
    });
  }

  /* ---------- 合成到新背景（含溢色去除） ---------- */
  function hexToRgb(hex) {
    var s = String(hex || '#FFFFFF').replace('#', '');
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    return [parseInt(s.slice(0, 2), 16) || 0, parseInt(s.slice(2, 4), 16) || 0, parseInt(s.slice(4, 6), 16) || 0];
  }

  /* 合成/抠图参数
     spill       去溢色强度：0 = 旧行为（观测值再乘一次 alpha，发丝发灰）；
                 0.85 = 对着原背景色反解前景真色
     spillMinA   参与反解的最小 alpha（防低 alpha 处放大噪声）
     alphaLo/Hi  matte 对比度拉伸区间。收窄它才能把「人像轮廓外的灰色晕影」压掉：
                 实测头发上缘过渡带 20.0→15.0 原图 px、脸颊轮廓 15.0→10.0 px，
                 再窄到 0.20–0.80 会把真实飞发削掉（观感像剪出来）。
     rRadius/rIters/rSigma  联合双边精修（吸附到图像真实边缘）。实测对过渡带宽度无影响，
                 只做平滑，故保持较轻的 3/4/0.05。 */
  var params = {
    spill: 0.85, spillMinA: 0.12,
    alphaLo: 0.12, alphaHi: 0.88,
    rRadius: 3, rIters: 4, rSigma: 0.05
  };

  function composite(canvas, alpha, bgHex) {
    var w = canvas.width, h = canvas.height;
    var ctx = canvas.getContext('2d');
    var src = ctx.getImageData(0, 0, w, h).data;
    var bg = hexToRgb(bgHex);
    var out = new Uint8ClampedArray(w * h * 4);
    var RAD = 4;

    /* 邻近「原背景色」＝ (2RAD+1)² 邻域内 alpha≈0 的像素均值。
       去溢色要对着它反解，不能用邻近前景色 —— 用前景色等于把发丝往实心头发上拽，
       边缘会整体变淡。 */
    function bgColorAt(idx) {
      var x = idx % w, y = (idx / w) | 0;
      var cr = 0, cg = 0, cb = 0, n = 0;
      var xlo = Math.max(0, x - RAD), xhi = Math.min(w - 1, x + RAD);
      var ylo = Math.max(0, y - RAD), yhi = Math.min(h - 1, y + RAD);
      for (var yy = ylo; yy <= yhi; yy++) for (var xx = xlo; xx <= xhi; xx++) {
        var j = yy * w + xx;
        if (alpha[j] <= 0.05) { var t = j * 4; cr += src[t]; cg += src[t + 1]; cb += src[t + 2]; n++; }
      }
      return n >= 3 ? [cr / n, cg / n, cb / n] : null;
    }

    for (var i = 0; i < w * h; i++) {
      var a = alpha[i], o = i * 4;
      if (a >= 0.995) {
        out[o] = src[o]; out[o + 1] = src[o + 1]; out[o + 2] = src[o + 2]; out[o + 3] = 255;
      } else if (a <= 0.005) {
        out[o] = bg[0]; out[o + 1] = bg[1]; out[o + 2] = bg[2]; out[o + 3] = 255;
      } else {
        /* 观测值 = a·F + (1-a)·B_原背景，其中 F 是前景真色。
           ⚠ 不能直接把观测值再乘一次 a —— 那等于把前景变成 a²F，发丝边缘会被再压淡一层。
           先按上式反解出 F，再合成到新背景。 */
        var r = src[o], g = src[o + 1], b = src[o + 2];
        var ob = bgColorAt(i);
        if (ob && params.spill > 0) {
          var a2 = a < params.spillMinA ? params.spillMinA : a;
          var k = (1 - a) / a2 * params.spill;
          r += (r - ob[0]) * k; g += (g - ob[1]) * k; b += (b - ob[2]) * k;
        }
        out[o] = r * a + bg[0] * (1 - a);
        out[o + 1] = g * a + bg[1] * (1 - a);
        out[o + 2] = b * a + bg[2] * (1 - a);
        out[o + 3] = 255;
      }
    }

    var dst = document.createElement('canvas');
    dst.width = w; dst.height = h;
    dst.getContext('2d').putImageData(new ImageData(out, w, h), 0, 0);
    return dst;
  }

  function foregroundRatio(alpha) {
    var n = 0;
    for (var i = 0; i < alpha.length; i++) if (alpha[i] > 0.5) n++;
    return n / alpha.length;
  }

  /* 把「整图 matte」里对应裁剪框的那一块，双线性重采样到裁剪输出尺寸。
     rect 用 matte 像素坐标（可为小数）；落在 matte 之外的部分按背景（0）处理。
     这样裁剪框怎么拖动都不用重跑 MODNet。 */
  function sampleMatte(matte, mw, mh, rect, W, H) {
    var out = new Float32Array(W * H);
    if (!matte) return out;
    var xs = rect.w / W, ys = rect.h / H;
    for (var y = 0; y < H; y++) {
      var fy = (y + 0.5) * ys + rect.y - 0.5;
      var y0 = Math.floor(fy), wy = fy - y0;
      var ya = y0 < 0 ? -1 : (y0 >= mh ? mh : y0);
      var yb = y0 + 1 < 0 ? -1 : (y0 + 1 >= mh ? mh : y0 + 1);
      y0 = ya; var y1 = yb;
      var rowA = y0 < 0 ? null : y0 * mw, rowB = y1 < 0 ? null : y1 * mw;
      var o = y * W;
      for (var x = 0; x < W; x++) {
        var fx = (x + 0.5) * xs + rect.x - 0.5;
        var x0 = Math.floor(fx), wx = fx - x0;
        var xa = x0 < 0 ? -1 : (x0 >= mw ? mw : x0);
        var xb = x0 + 1 < 0 ? -1 : (x0 + 1 >= mw ? mw : x0 + 1);
        var v00 = rowA == null || xa < 0 ? 0 : matte[rowA + xa];
        var v01 = rowA == null || xb < 0 ? 0 : matte[rowA + xb];
        var v10 = rowB == null || xa < 0 ? 0 : matte[rowB + xa];
        var v11 = rowB == null || xb < 0 ? 0 : matte[rowB + xb];
        out[o + x] = (v00 * (1 - wx) + v01 * wx) * (1 - wy) + (v10 * (1 - wx) + v11 * wx) * wy;
      }
    }
    return out;
  }

  /* 蒙版软边统计：半透明像素占比越高，发丝过渡越细腻 */
  function softRatio(alpha) {
    var n = 0;
    for (var i = 0; i < alpha.length; i++) if (alpha[i] > 0.05 && alpha[i] < 0.95) n++;
    return n / alpha.length;
  }

  window.IDP = window.IDP || {};
  window.IDP.BgRemove = {
    ensureModnet: ensureModnet,
    setModnetBuffer: setModnetBuffer,
    ensureFallback: ensureFallback,
    isModnetReady: function () { return !!_session; },
    segment: segment,
    composite: composite,
    /* 去溢色强度：0 = 旧行为（观测值再乘一次 alpha，发丝发灰发糊）；0.85 = 对着原背景反解前景 */
    params: params,
    setParams: function (o) { for (var k in o) if (Object.prototype.hasOwnProperty.call(params, k)) params[k] = o[k]; },
    sampleMatte: sampleMatte,
    hexToRgb: hexToRgb,
    foregroundRatio: foregroundRatio,
    softRatio: softRatio,
    modnetInputSize: modnetInputSize
  };
})();
