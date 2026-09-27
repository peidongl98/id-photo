/* 裁剪：按规格的 faceRatio / centerY / topMargin 自动构图，并支持拖拽偏移与缩放 */
(function () {
  'use strict';

  var MASTER_LONG = 3600;      /* 长边上限，3600×3600 ≈ 13MP，留足 iOS 16MP 余量 */
  var CHIN_MIN = 0.10;         /* 下巴到画面下边缘的最小留白 */
  var MATTE_FG = 0.40;         /* 判定「这是头发/人像」的 alpha 阈值 */
  var MATTE_ROW = 0.04;        /* 该行至少要有这个比例的前景像素，才认作头顶 */
  var MATTE_XSPAN = 0.40;      /* 扫描横带 = 人脸框左右各外扩 40% 脸宽（头发通常比脸宽） */

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* ---------- 头顶（含发）定位 ----------
     人脸框（Face Landmarker 的 468 点轮廓）只到发际线，不含头发。
     在人脸横带内自上而下扫 alpha matte，第一个有效前景行就是真正的头顶。 */
  function headTopFromMatte(face, matte, mw, mh) {
    var ob = face.ovalBox;
    var x0 = clamp(ob.x - ob.w * MATTE_XSPAN, 0, 1);
    var x1 = clamp(ob.x + ob.w * (1 + MATTE_XSPAN), 0, 1);
    var ix0 = Math.max(0, Math.floor(x0 * mw));
    var ix1 = Math.min(mw, Math.ceil(x1 * mw));
    var span = ix1 - ix0;
    if (span < 3 || !matte) return null;

    var need = Math.max(2, Math.round(span * MATTE_ROW));
    /* 上界保护：不认 1.5 倍脸高以上才出现的前景，避免抓到背景杂物 */
    var yStart = Math.max(0, Math.floor((ob.y - ob.h * 1.5) * mh));
    for (var y = yStart; y < mh; y++) {
      var row = y * mw, n = 0;
      for (var x = ix0; x < ix1; x++) {
        if (matte[row + x] > MATTE_FG) { n++; if (n >= need) break; }
      }
      if (n >= need) return y / mh;
    }
    return null;
  }

  /* 把 face.head 换成「头顶含发 → 下巴」的完整头部（cx/cy/h 语义不变，下游无需改） */
  function withHairHead(face, matte, mw, mh) {
    var ob = face.ovalBox;
    var chin = ob.y + ob.h;
    var found = matte ? headTopFromMatte(face, matte, mw, mh) : null;
    var fb = ob.y - ob.h * 0.15;                  /* 拿不到 matte 时退回「发际线上扩 15%」 */
    var top = found == null ? fb : Math.min(found, ob.y);
    var h = Math.max(ob.h, chin - top);
    var head = { cx: ob.x + ob.w / 2, w: ob.w * 1.25, h: h, cy: (chin + top) / 2 };
    return {
      count: face.count, lm: face.lm, oval: face.oval,
      ovalBox: ob, head: head,
      headTop: top, hairTop: found, chin: chin,
      hairHeight: top < ob.y ? (ob.y - top) : 0      /* 发际线以上的头发高度（归一化） */
    };
  }

  /* 把 ImageBitmap / HTMLImageElement 落到一张受控尺寸的 master canvas */
  function loadMaster(img) {
    var w = img.width || img.naturalWidth, h = img.height || img.naturalHeight;
    var long = Math.max(w, h);
    var s = long > MASTER_LONG ? MASTER_LONG / long : 1;
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * s));
    c.height = Math.max(1, Math.round(h * s));
    var ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  /* 按规格算裁剪框（master 坐标系，单位 px）
     opts: { zoom 缩放倍数(1=规格默认), offsetX/offsetY 拖拽偏移(以裁剪框宽/高为单位) } */
  function computeCrop(face, master, spec, opts) {
    opts = opts || {};
    var sw = master.width, sh = master.height;
    var aspect = spec.width_px / spec.height_px;
    var head = face.head;

    var zoom = clamp(opts.zoom || 1, 0.5, 2.5);
    var faceRatio = clamp((spec.faceRatio || 0.65) * zoom, 0.28, 0.92);
    var centerY = clamp(spec.centerY == null ? 0.42 : spec.centerY, 0.15, 0.8);
    var topMargin = spec.topMargin == null ? 0.05 : spec.topMargin;

    var headH = head.h * sh;
    var cropH = headH / faceRatio;
    var cropW = cropH * aspect;

    /* 允许适度超出原图（最多 1.5 倍），超出部分补白底 */
    var maxW = sw * 1.5, maxH = sh * 1.5;
    if (cropW > maxW || cropH > maxH) {
      var k = Math.min(maxW / cropW, maxH / cropH);
      cropW *= k; cropH *= k;
    }

    var cx = head.cx * sw + (opts.offsetX || 0) * cropW;
    var cy = head.cy * sh + (opts.offsetY || 0) * cropH;
    var x = cx - cropW / 2;
    var y = cy - centerY * cropH;

    /* 装得下就贴边夹紧；装不下则允许溢出（溢出部分补白底） */
    if (cropW <= sw) x = clamp(x, 0, sw - cropW);
    if (cropH <= sh) y = clamp(y, 0, sh - cropH);

    /* 构图约束：master px ↔ 输出 px 的换算 */
    var scaleY = spec.height_px / cropH;
    var headTop = (head.cy - head.h / 2) * sh;              /* 颅顶（含头发） */
    var chin = (face.ovalBox.y + face.ovalBox.h) * sh;      /* 下巴（关键点 152） */

    var needTop = topMargin * spec.height_px / scaleY;      /* 需要的头顶留白（master px） */
    var minBottom = CHIN_MIN * spec.height_px / scaleY;

    /* ② 下巴留白不足 → 调整裁剪框把它补出来 */
    var bottomGap = (y + cropH) - chin;
    if (bottomGap < minBottom) y = chin + minBottom - cropH;

    /* ① 头顶留白不足 → 最高优先级，头顶绝不出框 */
    if (headTop - y < needTop) y = headTop - needTop;

    return {
      x: x, y: y, w: cropW, h: cropH,
      topMargin: (headTop - y) * scaleY / spec.height_px,
      chinMargin: ((y + cropH) - chin) * scaleY / spec.height_px,
      faceRatio: faceRatio,
      zoom: zoom
    };
  }

  /* 裁到目标像素；targetLong 用于低分辨率预览层。
     ⚠ 这里**必须一次重采样完成**，不要再做「多级折半降采样」：
     drawImage 在 imageSmoothingQuality='high' 时本身就会为降采样施加一次低通，
     链式折半等于把同一个低通反复卷积，实测会额外丢掉 25%–45% 的高频细节
     （头发丝、衬衫纹理、毛孔就是这么整张糊掉的）。实测对照：
       一次成型 ≈ 理想面积平均的 97%–104%；多级折半只有 66%–78%。 */
  function renderCrop(master, rect, spec, outLong) {
    var W = spec.width_px, H = spec.height_px;
    var specLong = Math.max(W, H);
    var long = specLong;
    if (outLong && outLong > specLong) {
      /* 屏幕预览层：要按显示设备像素渲染才不会在手机上被放大糊掉；
         但最多放大到裁剪源自身的像素数——再往上只是插值，没有新细节。 */
      long = Math.min(outLong, Math.max(specLong, Math.max(rect.w, rect.h)));
    } else if (outLong && outLong < specLong) {
      long = outLong;
    }
    if (long !== specLong) {
      var k0 = long / specLong;
      W = Math.max(1, Math.round(W * k0));
      H = Math.max(1, Math.round(H * k0));
    }

    var out = document.createElement('canvas');
    out.width = W; out.height = H;
    var oc = out.getContext('2d', { willReadFrequently: true });
    oc.fillStyle = '#FFFFFF';   /* 裁剪框溢出原图的部分补白：抠图阶段判为背景，最终由所选底色覆盖 */
    oc.fillRect(0, 0, W, H);

    /* 只画「裁剪框 ∩ 原图」这一块，按它在裁剪框里的相对位置映射到输出画布 */
    var sx = Math.max(0, Math.round(rect.x));
    var sy = Math.max(0, Math.round(rect.y));
    var ex = Math.min(master.width, Math.round(rect.x + rect.w));
    var ey = Math.min(master.height, Math.round(rect.y + rect.h));
    if (ex - sx < 1 || ey - sy < 1) return out;   /* 完全在画外 */

    var kx = W / rect.w, ky = H / rect.h;
    oc.imageSmoothingEnabled = true;
    oc.imageSmoothingQuality = 'high';
    oc.drawImage(master, sx, sy, ex - sx, ey - sy,
                 (sx - rect.x) * kx, (sy - rect.y) * ky, (ex - sx) * kx, (ey - sy) * ky);
    return out;
  }

  /* 人脸 → 输出图坐标 */
  function faceMetrics(face, master, rect, spec, outW, outH) {
    var W = outW || spec.width_px, H = outH || spec.height_px;
    var sx = W / rect.w, sy = H / rect.h;
    var ob = face.ovalBox, head = face.head;
    function map(px, py) {
      return { x: (px * master.width - rect.x) * sx, y: (py * master.height - rect.y) * sy };
    }
    var c = map(ob.x + ob.w / 2, ob.y + ob.h / 2);
    var top = map(head.cx, head.cy - head.h / 2);
    var bot = map(head.cx, head.cy + head.h / 2);
    return {
      cx: c.x, cy: c.y,
      top: top.y, bottom: bot.y,
      rx: (ob.w / 2) * master.width * sx,
      ry: (ob.h / 2) * master.height * sy,
      headH: bot.y - top.y,
      topMargin: top.y / H,
      chinMargin: (H - bot.y) / H,
      W: W, H: H
    };
  }

  /* 磨皮作用区：人脸椭圆 + 径向羽化（黑底白椭圆） */
  function makeFaceMask(face, master, rect, spec, outW, outH) {
    var W = outW || spec.width_px, H = outH || spec.height_px;
    var m = faceMetrics(face, master, rect, spec, W, H);
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

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
    faceMetrics: faceMetrics,
    headTopFromMatte: headTopFromMatte,
    withHairHead: withHairHead,
    CHIN_MIN: CHIN_MIN
  };
})();
