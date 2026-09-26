/* 裁剪：按人脸自动构图 + 规格输出 */
(function () {
  'use strict';

  var CANVAS_LIMIT = 16000000; /* iOS Safari canvas 像素上限 */
  var MASTER_LONG = 3600; /* 长边上限，3600×3600 ≈ 13MP，留足 iOS 16MP 余量 */

  /* 把 ImageBitmap 落到一张受控尺寸的 master canvas（长边 ≤ 4000，逐级折半） */
  function loadMaster(bitmap) {
    var w = bitmap.width, h = bitmap.height;
    var long = Math.max(w, h);
    var s = long > MASTER_LONG ? MASTER_LONG / long : 1;
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * s));
    c.height = Math.max(1, Math.round(h * s));
    var ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, c.width, c.height);
    return c;
  }

  /* 按人脸算裁剪框（master 坐标系，单位 px） */
  function computeCrop(face, master, spec, opts) {
    var sw = master.width, sh = master.height;
    var aspect = spec.width_px / spec.height_px;
    var head = face.head;

    var headH = head.h * sh;
    var faceRatio = clamp(opts.faceRatio, 0.4, 0.85);
    var cropH = headH / faceRatio;
    var cropW = cropH * aspect;

    /* 允许适度超出原图（最多 1.5 倍），超出部分补白底——
       证件照本来就该把头部缩到标准占比，原图留白不够时补背景比强行放大更对 */
    var maxW = sw * 1.5, maxH = sh * 1.5;
    if (cropW > maxW || cropH > maxH) {
      var k = Math.min(maxW / cropW, maxH / cropH);
      cropW *= k; cropH *= k;
    }

    var cx = head.cx * sw + (opts.offsetX || 0) * cropW;
    var cy = head.cy * sh + (opts.offsetY || 0) * cropH;
    var x = cx - cropW / 2;
    var y = cy - clamp(opts.facePos, 0.2, 0.75) * cropH;

    /* 装得下就贴边夹紧（不留白）；装不下则允许溢出，溢出部分补白底 */
    if (cropW <= sw) x = Math.max(0, Math.min(sw - cropW, x));
    if (cropH <= sh) y = Math.max(0, Math.min(sh - cropH, y));

    return { x: x, y: y, w: cropW, h: cropH };
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* 裁到规格像素（多级降采样，避免锯齿） */
  function renderCrop(master, rect, spec) {
    var W = spec.width_px, H = spec.height_px;
    var cw = Math.max(1, Math.round(rect.w)), ch = Math.max(1, Math.round(rect.h));

    var scale = Math.min(1, Math.sqrt(CANVAS_LIMIT / (cw * ch)));
    var ew = Math.max(1, Math.round(cw * scale)), eh = Math.max(1, Math.round(ch * scale));

    var tmp = document.createElement('canvas');
    tmp.width = ew; tmp.height = eh;
    var tc = tmp.getContext('2d');
    tc.imageSmoothingEnabled = true; tc.imageSmoothingQuality = 'high';
    tc.drawImage(master, -rect.x * scale, -rect.y * scale, master.width * scale, master.height * scale);

    var cur = tmp;
    while (cur.width >= W * 2 && cur.height >= H * 2) {
      var nw = Math.max(W, cur.width >> 1), nh = Math.max(H, cur.height >> 1);
      var n = document.createElement('canvas');
      n.width = nw; n.height = nh;
      var nc = n.getContext('2d');
      nc.imageSmoothingEnabled = true; nc.imageSmoothingQuality = 'high';
      nc.drawImage(cur, 0, 0, nw, nh);
      cur = n;
    }

    var out = document.createElement('canvas');
    out.width = W; out.height = H;
    var oc = out.getContext('2d', { willReadFrequently: true });
    /* 溢出部分补白：抠图阶段会把它判为背景，最终由所选底色覆盖 */
    oc.fillStyle = '#FFFFFF';
    oc.fillRect(0, 0, W, H);
    oc.imageSmoothingEnabled = true; oc.imageSmoothingQuality = 'high';
    oc.drawImage(cur, 0, 0, W, H);
    return out;
  }

  /* 人脸 → 输出图坐标 */
  function faceMetrics(face, master, rect, spec) {
    var sx = spec.width_px / rect.w, sy = spec.height_px / rect.h;
    var ob = face.ovalBox, head = face.head;
    function map(px, py) {
      return { x: (px * master.width - rect.x) * sx, y: (py * master.height - rect.y) * sy };
    }
    var c = map(ob.x + ob.w / 2, ob.y + ob.h / 2);
    var top = map(head.cx, head.cy - head.h / 2);
    var bot = map(head.cx, head.cy + head.h / 2);
    var left = map(head.cx - head.w / 2, head.cy);
    var right = map(head.cx + head.w / 2, head.cy);
    return {
      cx: c.x, cy: c.y,
      top: top.y, bottom: bot.y,
      left: left.x, right: right.x,
      rx: (ob.w / 2) * master.width * sx,
      ry: (ob.h / 2) * master.height * sy,
      headH: bot.y - top.y,
      W: spec.width_px, H: spec.height_px
    };
  }

  /* 磨皮作用区：人脸椭圆 + 径向羽化（黑底白椭圆，直接当蒙版用） */
  function makeFaceMask(face, master, rect, spec) {
    var m = faceMetrics(face, master, rect, spec);
    var c = document.createElement('canvas');
    c.width = spec.width_px; c.height = spec.height_px;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, c.width, c.height);

    /* 略微外扩，覆盖颧骨与下颌 */
    var rx = Math.max(4, m.rx * 1.06);
    var ry = Math.max(4, m.ry * 1.06);
    ctx.save();
    ctx.translate(m.cx, m.cy);
    ctx.scale(rx, ry);
    var g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.70, 'rgba(255,255,255,1)');
    g.addColorStop(0.88, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return c;
  }

  window.IDP = window.IDP || {};
  window.IDP.Crop = {
    loadMaster: loadMaster,
    computeCrop: computeCrop,
    renderCrop: renderCrop,
    makeFaceMask: makeFaceMask,
    faceMetrics: faceMetrics
  };
})();
