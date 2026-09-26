/* 合规检测：人脸居中 / 五官比例 / 亮度 / 背景纯色 / 磨皮强度
   每项返回 pass | warn | fail，颜色 + 图标 + 文字三重编码 */
(function () {
  'use strict';

  function luma(r, g, b) { return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; }

  function level(v, passLo, passHi, warnLo, warnHi) {
    if (v >= passLo && v <= passHi) return 'pass';
    if (v >= warnLo && v <= warnHi) return 'warn';
    return 'fail';
  }

  function check(canvas, metrics, opts) {
    var out = [];
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height;
    var data = ctx.getImageData(0, 0, W, H).data;
    var alpha = opts.alpha || null;

    /* 1. 人脸检测 */
    if (!metrics) {
      out.push({ id: 'face', name: '人脸检测', level: 'fail', text: '未检测到人脸，请换一张正面免冠照' });
      return out;
    }
    out.push({ id: 'face', name: '人脸检测', level: 'pass', text: '已检测到 1 张人脸' });

    /* 2. 人脸居中 */
    var hx = (metrics.cx - W / 2) / W;
    var hy = metrics.cy / H;
    var hxAbs = Math.abs(hx);
    var lvH = hxAbs <= 0.045 && hy >= 0.40 && hy <= 0.52 ? 'pass'
            : (hxAbs <= 0.085 && hy >= 0.34 && hy <= 0.60 ? 'warn' : 'fail');
    out.push({
      id: 'center', name: '人脸居中', level: lvH,
      text: lvH === 'pass' ? '头部位于画面中央，位置标准'
        : (lvH === 'warn' ? '头部略有偏移（水平 ' + (hx * 100).toFixed(1) + '%、垂直 ' + (hy * 100).toFixed(0) + '%）'
          : '头部明显偏离中心，请重新构图')
    });

    /* 3. 五官比例 */
    var ratio = metrics.headH / H;
    var lvR = level(ratio, 0.52, 0.72, 0.44, 0.80);
    out.push({
      id: 'ratio', name: '五官比例', level: lvR,
      text: lvR === 'pass' ? '头部高度占画面 ' + (ratio * 100).toFixed(0) + '%，符合证件照标准'
        : (lvR === 'warn' ? '头部占比 ' + (ratio * 100).toFixed(0) + '%，建议 52%–72%'
          : '头部占比 ' + (ratio * 100).toFixed(0) + '%，明显偏离标准')
    });

    /* 4. 亮度（脸部区域采样） */
    var lum = faceLuma(data, W, H, metrics);
    var lvB = level(lum, 0.34, 0.86, 0.26, 0.92);
    out.push({
      id: 'brightness', name: '亮度', level: lvB,
      text: lvB === 'pass' ? '曝光正常'
        : (lvB === 'warn' ? (lum < 0.34 ? '偏暗，建议补光重拍' : '偏亮，可能过曝')
          : (lum < 0.26 ? '严重欠曝，官方验证易失败' : '严重过曝，官方验证易失败'))
    });

    /* 5. 背景纯色（顶部 + 上部两侧取样，跳过人像像素） */
    var bg = bgStats(data, W, H, opts.bgRgb, alpha);
    var lvG;
    if (bg.samples < 200) {
      lvG = 'fail';
    } else {
      lvG = bg.std <= 7 && bg.diff <= 16 ? 'pass' : (bg.std <= 16 && bg.diff <= 34 ? 'warn' : 'fail');
    }
    out.push({
      id: 'bg', name: '背景纯色', level: lvG,
      text: bg.samples < 200 ? '人像几乎占满画面，四周没有足够背景可供判断'
        : (lvG === 'pass' ? '背景均匀，无色块与残留'
          : (lvG === 'warn' ? '背景略有杂色（波动 ' + bg.std.toFixed(1) + '），建议换底或重试'
            : '背景不纯净（波动 ' + bg.std.toFixed(1) + '），可能抠图残留'))
    });

    /* 6. 磨皮强度 */
    var pct = opts.intensity * 100;
    var lvM = pct <= 28 ? 'pass' : (pct <= 30 ? 'warn' : 'fail');
    out.push({
      id: 'mopi', name: '磨皮强度', level: lvM,
      text: lvM === 'pass' ? (pct < 1 ? '未磨皮' : '强度 ' + pct.toFixed(0) + '%，在安全区间内')
        : (lvM === 'warn' ? '强度 ' + pct.toFixed(0) + '%，接近上限（>28%）' : '强度超出 30% 上限')
    });

    return out;
  }

  function faceLuma(data, W, H, m) {
    var rx = Math.max(2, m.rx * 0.8), ry = Math.max(2, m.ry * 0.8);
    var x0 = Math.max(0, Math.round(m.cx - rx)), x1 = Math.min(W - 1, Math.round(m.cx + rx));
    var y0 = Math.max(0, Math.round(m.cy - ry)), y1 = Math.min(H - 1, Math.round(m.cy + ry));
    var stepX = Math.max(1, Math.floor((x1 - x0) / 60)), stepY = Math.max(1, Math.floor((y1 - y0) / 60));
    var sum = 0, n = 0;
    for (var y = y0; y <= y1; y += stepY) {
      for (var x = x0; x <= x1; x += stepX) {
        var i = (y * W + x) * 4;
        sum += luma(data[i], data[i + 1], data[i + 2]);
        n++;
      }
    }
    return n ? sum / n : 0;
  }

  /* 顶部横带 + 上部左右竖带取样；alpha > 0.15 的人像像素剔除 */
  function bgStats(data, W, H, bgRgb, alpha) {
    var topBand = Math.max(2, Math.round(H * 0.07));
    var sideBand = Math.max(2, Math.round(W * 0.09));
    var upperLimit = Math.round(H * 0.55);
    var rs = [], gs = [], bs = [], n = 0;

    function add(x, y) {
      if (alpha && alpha[y * W + x] > 0.15) return;
      var i = (y * W + x) * 4;
      rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]); n++;
    }

    var ax = Math.max(1, Math.floor(W / 120)), ay = Math.max(1, Math.floor(H / 120));
    var x, y;
    for (x = 0; x < W; x += ax) for (y = 0; y < topBand; y++) add(x, y);
    for (y = 0; y < upperLimit; y += ay) {
      for (x = 0; x < sideBand; x++) add(x, y);
      for (x = W - sideBand; x < W; x++) add(x, y);
    }
    if (!n) return { std: 999, diff: 999, samples: 0 };
    var mr = mean(rs), mg = mean(gs), mb = mean(bs);
    var std = (sd(rs, mr) + sd(gs, mg) + sd(bs, mb)) / 3;
    var diff = bgRgb
      ? (Math.abs(mr - bgRgb[0]) + Math.abs(mg - bgRgb[1]) + Math.abs(mb - bgRgb[2])) / 3
      : 0;
    return { std: std, diff: diff, samples: n, mean: [mr, mg, mb] };
  }

  function mean(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s / a.length; }
  function sd(a, m) {
    var s = 0;
    for (var i = 0; i < a.length; i++) { var d = a[i] - m; s += d * d; }
    return Math.sqrt(s / a.length);
  }

  function overall(results) {
    var lv = 'pass';
    for (var i = 0; i < results.length; i++) {
      if (results[i].level === 'fail') return 'fail';
      if (results[i].level === 'warn') lv = 'warn';
    }
    return lv;
  }

  window.IDP = window.IDP || {};
  window.IDP.Compliance = { check: check, overall: overall };
})();
