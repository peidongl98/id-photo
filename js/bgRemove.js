/* 背景移除：MediaPipe Selfie Segmentation + 蒙版精修 + 溢色去除
   输出 alpha 为 Float32Array（0–1），分辨率 = 输入画布尺寸 */
(function () {
  'use strict';

  var _seg = null;
  var _segP = null;

  /* ---------- 模型 ---------- */
  function ensure() {
    if (_seg) return Promise.resolve(_seg);
    if (_segP) return _segP;
    _segP = window.IDP.loadVision().then(function (v) {
      return window.IDP.FaceDetect.SEG_MODEL.reduce(function (chain, url) {
        return chain.catch(function () {
          return v.mod.ImageSegmenter.createFromOptions(v.fileset, {
            baseOptions: { modelAssetPath: url, delegate: 'GPU' },
            runningMode: 'IMAGE',
            outputCategoryMask: true,
            outputConfidenceMasks: true
          }).catch(function () {
            return v.mod.ImageSegmenter.createFromOptions(v.fileset, {
              baseOptions: { modelAssetPath: url, delegate: 'CPU' },
              runningMode: 'IMAGE',
              outputCategoryMask: true,
              outputConfidenceMasks: true
            });
          });
        });
      }, Promise.reject()).then(function (s) { _seg = s; return s; })
        .catch(function (e) {
          _segP = null;
          throw new Error('抠图模型加载失败（' + (e && e.message || '') + '）');
        });
    });
    return _segP;
  }

  /* ---------- 工具 ---------- */
  function maskToArray(mask) {
    if (!mask) return null;
    try { return mask.getAsFloat32Array(); } catch (e) { }
    try { return mask.getAsUint8Array(); } catch (e) { }
    return null;
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

  /* 从候选蒙版里挑「人」的那一路：人像中心亮、四边暗 */
  function pickPersonMask(res, w, h) {
    var cands = [];
    if (res.confidenceMasks) {
      for (var i = 0; i < res.confidenceMasks.length; i++) {
        var arr = maskToArray(res.confidenceMasks[i]);
        var m = res.confidenceMasks[i];
        if (arr) cands.push({ arr: arr, w: m.width, h: m.height, kind: 'conf', idx: i });
      }
    }
    if (!cands.length && res.categoryMask) {
      var ca = maskToArray(res.categoryMask);
      if (ca) {
        var cm = res.categoryMask;
        var maxc = 0;
        for (var k = 0; k < ca.length; k++) if (ca[k] > maxc) maxc = ca[k];
        /* 二值化：非 0 视为人 */
        var bin = new Float32Array(ca.length);
        for (var k2 = 0; k2 < ca.length; k2++) bin[k2] = ca[k2] > 0 ? 1 : 0;
        cands.push({ arr: bin, w: cm.width, h: cm.height, kind: 'cat-binary' });
      }
    }
    if (!cands.length) throw new Error('抠图模型未返回有效蒙版');

    var best = null, bestScore = -1e9;
    for (var c = 0; c < cands.length; c++) {
      var cd = cands[c], s = 0, n = 0;
      function sampleAt(px, py) {
        var x = Math.max(0, Math.min(cd.w - 1, Math.round(px * cd.w)));
        var y = Math.max(0, Math.min(cd.h - 1, Math.round(py * cd.h)));
        return cd.arr[y * cd.w + x];
      }
      /* 中心 24% 区域 vs 四边 6% 区域 */
      for (var gy = 0; gy < 20; gy++) {
        for (var gx = 0; gx < 20; gx++) {
          var u = (gx + 0.5) / 20, v2 = (gy + 0.5) / 20;
          var inCenter = u > 0.38 && u < 0.62 && v2 > 0.38 && v2 < 0.62;
          var inBorder = u < 0.06 || u > 0.94 || v2 < 0.06 || v2 > 0.94;
          if (inCenter) { s += sampleAt(u, v2); n++; }
          else if (inBorder) { s -= sampleAt(u, v2); n++; }
        }
      }
      var score = n ? s / n : 0;
      if (score > bestScore) { bestScore = score; best = cd; }
    }
    return best;
  }

  /* 联合双边精修：让蒙版边缘吸附到图像真实边缘（发丝就靠这一步） */
  function refine(alpha, rgba, w, h, radius, iters, sigmaC) {
    var i, j, x, y, k;
    var ss2 = 2 * radius * radius, sc2 = 2 * sigmaC * sigmaC;
    /* 预计算空间权重 */
    var sp = (2 * radius + 1) * (2 * radius + 1);
    var offs = new Int32Array(sp * 3);
    var wts = new Float32Array(sp);
    var p = 0;
    for (j = -radius; j <= radius; j++) {
      for (i = -radius; i <= radius; i++) {
        offs[p * 3] = i; offs[p * 3 + 1] = j;
        offs[p * 3 + 2] = j * w + i;
        wts[p] = Math.exp(-(i * i + j * j) / ss2);
        p++;
      }
    }

    var cur = alpha, next = new Float32Array(w * h);
    for (var it = 0; it < iters; it++) {
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          var idx = y * w + x;
          var a0 = cur[idx];
          /* 只精修过渡带，其余保持（大幅省时） */
          if (a0 < 0.02 || a0 > 0.98) { next[idx] = a0; continue; }
          var ci = idx * 4;
          var r0 = rgba[ci], g0 = rgba[ci + 1], b0 = rgba[ci + 2];
          var sum = 0, wsum = 0;
          var ydone = y - radius, ymax = y + radius;
          var ylo = ydone < 0 ? 0 : ydone, yhi = ymax > h - 1 ? h - 1 : ymax;
          var xlo = x - radius < 0 ? 0 : x - radius, xhi = x + radius > w - 1 ? w - 1 : x + radius;
          for (k = 0; k < sp; k++) {
            var yy = y + offs[k * 3 + 1];
            if (yy < ylo || yy > yhi) continue;
            var xx = x + offs[k * 3];
            if (xx < xlo || xx > xhi) continue;
            var ni = (yy * w + xx) * 4;
            var dr = rgba[ni] - r0, dg = rgba[ni + 1] - g0, db = rgba[ni + 2] - b0;
            var dc2 = dr * dr + dg * dg + db * db;
            var wt = wts[k] * Math.exp(-dc2 / sc2);
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

  /* 分割：返回 { alpha: Float32Array(w*h), w, h } */
  function segment(canvas) {
    return ensure().then(function (seg) {
      var w = canvas.width, h = canvas.height;
      var res = seg.segment(canvas);
      var picked = pickPersonMask(res, w, h);
      /* 对比度拉伸，让边缘更果断 */
      var lo = 0.26, hi = 0.78, span = hi - lo;
      var low = bilinear(picked.arr, picked.w, picked.h, w, h);
      for (var i = 0; i < low.length; i++) {
        var a = (low[i] - lo) / span;
        low[i] = a < 0 ? 0 : (a > 1 ? 1 : a);
      }
      if (res.close) res.close();

      var ctx = canvas.getContext('2d');
      var img = ctx.getImageData(0, 0, w, h);
      var alpha = refine(low, img.data, w, h, 2, 2, 0.09);
      return { alpha: alpha, w: w, h: h };
    });
  }

  /* ---------- 合成到新背景（含溢色去除） ---------- */
  function hexToRgb(hex) {
    var s = String(hex || '#FFFFFF').replace('#', '');
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    return [parseInt(s.slice(0, 2), 16) || 0, parseInt(s.slice(2, 4), 16) || 0, parseInt(s.slice(4, 6), 16) || 0];
  }

  function composite(canvas, alpha, bgHex) {
    var w = canvas.width, h = canvas.height;
    var ctx = canvas.getContext('2d');
    var img = ctx.getImageData(0, 0, w, h);
    var src = img.data;
    var bg = hexToRgb(bgHex);

    var out = new Uint8ClampedArray(w * h * 4);
    var RAD = 4;

    function coreColor(idx) {
      var x = idx % w, y = (idx / w) | 0;
      var cr = 0, cg = 0, cb = 0, n = 0;
      var xlo = x - RAD < 0 ? 0 : x - RAD, xhi = x + RAD > w - 1 ? w - 1 : x + RAD;
      var ylo = y - RAD < 0 ? 0 : y - RAD, yhi = y + RAD > h - 1 ? h - 1 : y + RAD;
      for (var yy = ylo; yy <= yhi; yy++) {
        for (var xx = xlo; xx <= xhi; xx++) {
          var j = yy * w + xx;
          if (alpha[j] > 0.92) {
            var t = j * 4;
            cr += src[t]; cg += src[t + 1]; cb += src[t + 2]; n++;
          }
        }
      }
      return n ? [cr / n, cg / n, cb / n] : null;
    }

    for (var i = 0; i < w * h; i++) {
      var a = alpha[i], o = i * 4;
      if (a >= 0.995) {
        out[o] = src[o]; out[o + 1] = src[o + 1]; out[o + 2] = src[o + 2]; out[o + 3] = 255;
      } else if (a <= 0.005) {
        out[o] = bg[0]; out[o + 1] = bg[1]; out[o + 2] = bg[2]; out[o + 3] = 255;
      } else {
        var r = src[o], g = src[o + 1], b = src[o + 2];
        /* 半透明像素里混着原背景颜色 → 用邻近实心前景色拉回来 */
        var core = coreColor(i);
        if (core) {
          var kk = 0.85 * (1 - a);
          r = r + (core[0] - r) * kk;
          g = g + (core[1] - g) * kk;
          b = b + (core[2] - b) * kk;
        }
        out[o]     = r * a + bg[0] * (1 - a);
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

  /* 供合规检测使用：背景取样像素占比 */
  function foregroundRatio(alpha) {
    var n = 0;
    for (var i = 0; i < alpha.length; i++) if (alpha[i] > 0.5) n++;
    return n / alpha.length;
  }

  window.IDP = window.IDP || {};
  window.IDP.BgRemove = {
    ensure: ensure,
    segment: segment,
    composite: composite,
    hexToRgb: hexToRgb,
    foregroundRatio: foregroundRatio
  };
})();
