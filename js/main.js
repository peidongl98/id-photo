/* 主流程
   上传 → EXIF 方向 → 人脸检测 → MODNet 整图 matte（一次）→ 头顶含发定位 → 裁剪框
   → 「预生成」按当前裁剪框裁剪 + 磨皮 + 合成（复用中间结果）→ 结果视图
   裁剪视图拖动/缩放只移动取景框，不做任何图像处理。 */
(function () {
  'use strict';

  var SPECS = window.IDP.SPECS;
  var CATS = window.IDP.CATEGORIES;
  var D = window.IDP.SPEC_DEFAULTS;

  var RESULT_LONG_CAP = 1200;  /* 屏幕预览层的长边上限（够屏幕清晰，又不至于太贵） */
  var ANALYZE_SHORT = 640;     /* 整图 matte 的分析分辨率（MODNet 内部也只会用到 512 短边） */
  var ANALYZE_LONG_CAP = 1280;
  var JOB_TIMEOUT = 15000;     /* 处理超时 */
  var RERENDER_DEBOUNCE = 300; /* 结果视图调参重算的 debounce */
  var MAX_KB_CANVAS = 16000000;
  var HEIC_CDNS = [
    'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js',
    'https://unpkg.com/heic2any@0.0.4/dist/heic2any.min.js'
  ];

  var state = {
    master: null, face: null, fileName: '',
    cat: CATS[0], spec: SPECS[0],
    bg: SPECS[0].bg_color,
    intensity: 0.22, radius: 3,
    target: 'none', customUnit: 'mm',
    zoom: 1, offsetX: 0, offsetY: 0, centerY: null,
    rect: null, dragging: false,
    view: 'crop',                 /* crop | result */
    engine: 'modnet',
    hasPhoto: false, analyzing: false, booted: false,
    matte: null, matteW: 0, matteH: 0,      /* 整图 alpha，分析阶段算一次 */
    result: null,                            /* { base, alpha, mask, composed, canvas, metrics } */
    fullCanvas: null,
    metrics: null, results: [], overall: 'pass',
    exportInfo: null, gen: 0, renderSeq: 0
  };

  var el = {};
  ['boot','bootStage','bootRows','bootErr','bootEnter','bootRetry',
   'app','display','uploadBox','pickBtn','shootBtn','fileInput','camInput','uploadNotice',
   'viewwrap','viewCanvas','viewHint','cropMeta','busyChip','busyText','resetFit','peekBtn',
   'sumBar','sumIcon','sumText',
   'controls','mainRow','mainAction','cancelBtn',
   'specTabs','specScroll','specFade','specRow','specHint','specText','specPicker',
   'customSpec','customUnit','cw','ch','applyCustom',
   'swatches','bgCustom','matteHint','intenSlider','intenOut','radiusSlider','radiusOut','mopiHint',
   'sizeChips','sizeHint','preHint','applyBgBtn','downloadBtn','resetBtn','exportNotice',
   'progress','progressFill','progressText',
   'modal','modalClose','modalDownload','checks','checkNotice',
   'zoomView','zoomCanvas'
  ].forEach(function (id) { el[id] = document.getElementById(id); });

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* ================= 轻提示 ================= */
  var toastEl = null, toastTimer = 0;
  function toast(text, ms) {
    if (toastEl) toastEl.parentNode.removeChild(toastEl);
    toastEl = document.createElement('div');
    toastEl.className = 'locktoast';
    toastEl.textContent = text;
    document.body.appendChild(toastEl);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
      toastEl = null;
    }, ms || 2000);
  }
  function notice(node, text, kind) {
    if (!node) return;
    if (!text) { node.hidden = true; node.textContent = ''; return; }
    node.hidden = false; node.textContent = text;
    node.className = 'notice' + (kind ? ' is-' + kind : '');
  }
  function busy(on, text) {
    el.busyChip.hidden = !on;
    if (text) el.busyText.textContent = text;
  }
  function fail(err) {
    var msg = (err && err.message) || String(err);
    busy(false); notice(el.uploadNotice, msg, 'err');
    if (el.exportNotice) notice(el.exportNotice, msg, 'err');
  }

  /* ================= 图片读取 ================= */
  function isHeic(f) { return /^image\/hei[cf]$/i.test(f.type) || /\.hei[cf]$/i.test(f.name || ''); }
  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src; s.onload = function () { res(); };
      s.onerror = function () { rej(new Error('脚本加载失败：' + src)); };
      document.head.appendChild(s);
    });
  }
  function heicToJpeg(file) {
    function convert() {
      return window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.95 })
        .then(function (o) { return Array.isArray(o) ? o[0] : o; });
    }
    if (window.heic2any) return convert();
    var chain = Promise.reject();
    HEIC_CDNS.forEach(function (url) {
      chain = chain.catch(function () {
        return loadScript(url).then(function () { if (!window.heic2any) throw new Error('no heic2any'); });
      });
    });
    return chain.then(convert).catch(function () {
      throw new Error('HEIC 转换库加载失败，请把照片导出为 JPG / PNG 后重试');
    });
  }
  function loadImageEl(blob) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () { res(img); };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('图片解码失败')); };
      img.src = url;
    });
  }
  function readFile(file) {
    if (!file) return Promise.resolve(null);
    if (!/^image\//i.test(file.type) && !isHeic(file)) return Promise.reject(new Error('只支持 JPG / PNG / HEIC 图片'));
    if (file.size > 40 * 1024 * 1024) return Promise.reject(new Error('图片太大（超过 40MB），请先压缩'));
    if (isHeic(file)) {
      busy(true, '正在转换 HEIC 照片…');
      return heicToJpeg(file).then(function (b) {
        return loadImageEl(b).catch(function () { throw new Error('HEIC 转换失败，请改用 JPG / PNG'); });
      });
    }
    return loadImageEl(file).catch(function () { return heicToJpeg(file).then(loadImageEl); });
  }

  /* ================= 任务（可取消 + 超时） ================= */
  function newJob() {
    var j = { cancelled: false, timedOut: false, timer: 0 };
    j.timer = setTimeout(function () { j.timedOut = true; j.cancelled = true; }, JOB_TIMEOUT);
    return j;
  }
  function endJob(j) { if (j) clearTimeout(j.timer); }
  /* 分帧执行：每步让出主线程，取消按钮才点得动，也能及时更新提示 */
  function step(job, fn) {
    return new Promise(function (res, rej) {
      setTimeout(function () {
        if (job && job.cancelled) return res(false);
        try { fn(); res(true); } catch (e) { rej(e); }
      }, 0);
    });
  }
  function cancelRunning() {
    if (state.job) { state.job.cancelled = true; state.job.timedOut = false; }
  }

  /* ================= 规格 / 构图 ================= */
  function specFor() {
    var s = {};
    for (var k in state.spec) s[k] = state.spec[k];
    s.centerY = state.centerY == null ? (state.spec.centerY == null ? D.centerY : state.spec.centerY) : state.centerY;
    if (s.faceRatio == null) s.faceRatio = D.faceRatio;
    if (s.topMargin == null) s.topMargin = D.topMargin;
    return s;
  }
  function computeRect() {
    if (!state.face || !state.master) return null;
    return window.IDP.Crop.computeCrop(state.face, state.master, specFor(), {
      zoom: state.zoom, offsetX: state.offsetX, offsetY: state.offsetY
    });
  }
  function refreshRect() {
    if (!state.face) return;
    state.rect = computeRect();
    invalidateResult();
    updateMeta();
    drawView();
  }
  function invalidateResult() { state.result = null; state.fullCanvas = null; }
  function invalidateFull() { state.fullCanvas = null; }

  /* ================= 分析阶段（每个照片只跑一次） ================= */
  function analyzeCanvas(master) {
    var w = master.width, h = master.height;
    var s = Math.min(1, ANALYZE_SHORT / Math.min(w, h), ANALYZE_LONG_CAP / Math.max(w, h));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * s));
    c.height = Math.max(1, Math.round(h * s));
    var ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(master, 0, 0, c.width, c.height);
    return c;
  }

  /* 人脸 + 整图 matte + 头顶（含发）→ 裁剪框 */
  /* 分析期间：还没有裁剪框，取景工具与「对比原图」都无意义，先收起 */
  function setAnalyzingUI(on) {
    el.resetFit.hidden = on;
    el.peekBtn.hidden = true;          /* 只有结果视图才显示 */
    el.viewHint.textContent = on ? '正在分析，暂不可拖动取景' : '';
  }

  function analyzePhoto() {
    state.analyzing = true;
    setLocked(true);
    setAnalyzingUI(true);
    el.mainAction.textContent = '分析中…';
    busy(true, '正在分析人脸和轮廓…');
    return Promise.resolve()
      .then(function () { return window.IDP.FaceDetect.analyze(state.master); })
      .then(function (face) {
        if (face === null) {
          notice(el.uploadNotice, '没有检测到清晰的正脸。请换一张正面免冠、光线均匀、人脸清晰的照片。', 'err');
          return null;
        }
        if (!face) return null;
        state.face = face;
        busy(true, '正在分析人像轮廓…');
        var ac = analyzeCanvas(state.master);
        return window.IDP.BgRemove.segment(ac, { engine: state.engine }).then(function (r) {
          state.engine = r.engine;
          state.matte = r.alpha; state.matteW = ac.width; state.matteH = ac.height;
          if (r.engine !== 'modnet') updateMatteTag(r.modnetError); else updateMatteTag();
          busy(true, '正在定位头顶与发际…');
          state.face = window.IDP.Crop.withHairHead(state.face, state.matte, state.matteW, state.matteH);
          state.rect = computeRect();
          return true;
        });
      })
      .then(function (ok) {
        state.analyzing = false;
        busy(false);
        if (!ok) {
          /* 没检测到正脸：没有裁剪框，取景工具保持隐藏 */
          setLocked(true);
          el.resetFit.hidden = true;
          el.viewHint.textContent = '';
          el.mainAction.textContent = '预生成';
          return;
        }
        setLocked(false);
        gotoView('crop');
        updateMeta();
        drawView();
      })
      .catch(function (e) { state.analyzing = false; busy(false); fail(e); });
  }

  /* ================= 生成结果（复用分析阶段的 matte，不重跑模型） ================= */
  function viewDeviceLong() {
    var w = el.viewwrap.clientWidth, h = el.viewwrap.clientHeight;
    if (!w || !h) {
      w = Math.max(240, Math.min(window.innerWidth, 620) - 24);
      h = clamp(window.innerHeight * 0.52, 190, 540);
    }
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    return Math.max(w, h) * dpr;
  }
  /* 结果层长边：不小于规格像素（保证「所见即所得」的下限），也不小于屏幕实际需要，
     且不超过裁剪源本身的像素（避免无意义的放大）。规格本身超过上限时不缩——预览不能比
     交付文件还差。 */
  function resultLong() {
    var specLong = Math.max(state.spec.width_px, state.spec.height_px);
    var need = Math.max(specLong, Math.round(viewDeviceLong()));
    if (specLong <= RESULT_LONG_CAP) need = Math.min(need, RESULT_LONG_CAP);
    if (state.rect) {
      var srcLong = Math.max(state.rect.w, state.rect.h);
      need = Math.min(need, Math.max(specLong, Math.round(srcLong)));
    }
    return need;
  }
  function alphaFor(rect, base) {
    var sA = state.matteW / state.master.width;
    return window.IDP.BgRemove.sampleMatte(
      state.matte, state.matteW, state.matteH,
      { x: rect.x * sA, y: rect.y * sA, w: rect.w * sA, h: rect.h * sA },
      base.width, base.height);
  }
  /* long=null 表示按规格原始像素 */
  function computeResult(long, onStage, job) {
    var spec = specFor();
    var rect = state.rect;
    var r = { spec: spec, rect: rect, long: long, timings: {} };
    var tA = performance.now();
    return step(job, function () {
      onStage('正在裁剪…');
      r.base = window.IDP.Crop.renderCrop(state.master, rect, spec, long);
      r.timings.crop = performance.now() - tA; tA = performance.now();
    })
      .then(function (ok) {
        if (!ok) return false;
        return step(job, function () {
          onStage('正在处理发丝边缘…');
          r.alpha = alphaFor(rect, r.base);
          r.timings.alpha = performance.now() - tA; tA = performance.now();
        });
      })
      .then(function (ok) {
        if (!ok) return false;
        return step(job, function () {
          onStage('正在合成背景…');
          r.composed = window.IDP.BgRemove.composite(r.base, r.alpha, state.bg);
          r.bgUsed = state.bg;
          r.timings.composite = performance.now() - tA; tA = performance.now();
          r.mask = window.IDP.Crop.makeFaceMask(state.face, state.master, rect, spec, r.base.width, r.base.height);
        });
      })
      .then(function (ok) {
        if (!ok) return false;
        return step(job, function () {
          onStage('正在磨皮…');
          r.canvas = window.IDP.Mopi.apply(r.composed, {
            intensity: state.intensity, radius: state.radius, mask: r.mask
          });
          r.metrics = window.IDP.Crop.faceMetrics(state.face, state.master, rect, spec, r.base.width, r.base.height);
          r.timings.mopi = performance.now() - tA;
        });
      })
      .then(function (ok) { return ok ? r : null; });
  }

  /* 预览层（屏幕清晰）+ 交付层（规格原始像素）。两层共用同一份 alpha，都不重跑模型。 */
  function renderBoth(onStage, job) {
    var plong = resultLong();
    return computeResult(plong, onStage, job).then(function (r) {
      if (!r) return null;
      r.full = null;
      if (r.canvas.width === state.spec.width_px && r.canvas.height === state.spec.height_px) return r;
      return computeResult(null, onStage, job).then(function (f) {
        if (f) r.full = f;
        return r;
      });
    });
  }
  function resultCanvas() {
    var r = state.result;
    if (!r) return null;
    return (r.full && r.full.canvas) || r.canvas;
  }

  function beginJob(text) {
    var job = newJob();
    state.job = job;
    setLocked(true);
    el.mainAction.textContent = text;
    el.mainAction.disabled = true;
    el.cancelBtn.hidden = false;
    busy(true, text);
    return job;
  }
  function finishJob(job) {
    endJob(job);
    if (state.job === job) state.job = null;
    el.cancelBtn.hidden = true;
    el.mainAction.disabled = false;
    busy(false);
    setLocked(false);
    applyViewUI();
  }

  function preGenerate() {
    if (state.view === 'result') { backToCrop(); return; }
    if (!state.hasPhoto || !state.face || state.analyzing || state.job) return;
    if (!state.rect) state.rect = computeRect();
    if (!state.rect) return;
    notice(el.uploadNotice, '');
    var job = beginJob('处理中…');
    var key = resultKey();
    if (state.result && state.result.key === key) {  /* 裁剪框没动 → 直接复用 */
      finishJob(job);
      gotoView('result');
      return;
    }
    var stage = function (t) { if (state.job === job) { el.mainAction.textContent = t; busy(true, t); } };
    renderBoth(stage, job)
      .then(function (r) {
        var timedOut = job.timedOut;
        finishJob(job);
        if (!r) {
          if (timedOut) { fail(new Error('处理超时，请重试')); }
          gotoView('crop');
          return;
        }
        r.key = key;
        state.result = r;
        state.fullCanvas = null;
        state.metrics = r.metrics;
        runCompliance(r.canvas, r.metrics, r.alpha);
        gotoView('result');
        refreshExportInfo();
        drawView();
        state.renderSeq++;
      })
      .catch(function (e) { finishJob(job); fail(e); gotoView('crop'); });
  }

  function resultKey() {
    var r = state.rect;
    if (!r) return '';
    return [state.spec.id, state.bg, state.intensity, state.radius,
            Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)].join('|');
  }

  /* 结果视图里调背景 / 磨皮 → 复用 base / alpha / mask 快速重算 */
  var rerenderTimer = 0;
  function scheduleReRender() {
    if (state.view !== 'result' || !state.result) return;
    invalidateFull();
    clearTimeout(rerenderTimer);
    rerenderTimer = setTimeout(doReRender, RERENDER_DEBOUNCE);
  }
  function doReRender() {
    var r = state.result;
    if (state.view !== 'result' || !r || state.job) return;
    var job = newJob();
    state.job = job;
    busy(true, '正在应用参数…');
    el.cancelBtn.hidden = false;
    step(job, function () {
      /* 只动了磨皮 / 半径时不必重新合成背景 */
      if (r.composed && r.bgUsed === state.bg) return;
      r.composed = window.IDP.BgRemove.composite(r.base, r.alpha, state.bg);
      r.bgUsed = state.bg;
    })
      .then(function (ok) {
        if (!ok) return false;
        return step(job, function () {
          r.canvas = window.IDP.Mopi.apply(r.composed, {
            intensity: state.intensity, radius: state.radius, mask: r.mask
          });
        });
      })
      .then(function (ok) {
        /* 交付层同步重算（规格很小，代价可忽略；预览即规格时跳过） */
        if (!ok || !r.full) return ok;
        return step(job, function () {
          var f = r.full;
          if (f.composed && f.bgUsed === state.bg) return;
          f.composed = window.IDP.BgRemove.composite(f.base, f.alpha, state.bg);
          f.bgUsed = state.bg;
        }).then(function (ok2) {
          if (!ok2) return false;
          return step(job, function () {
            var f = r.full;
            f.canvas = window.IDP.Mopi.apply(f.composed, {
              intensity: state.intensity, radius: state.radius, mask: f.mask
            });
          });
        });
      })
      .then(function (ok) {
        endJob(job); state.job = null;
        el.cancelBtn.hidden = true; busy(false);
        if (!ok || !r.canvas) return;
        r.key = resultKey();
        state.metrics = r.metrics;
        runCompliance(r.canvas, r.metrics, r.alpha);
        drawView();
        refreshExportInfo();
        state.renderSeq++;
      })
      .catch(function (e) { endJob(job); state.job = null; el.cancelBtn.hidden = true; busy(false); fail(e); });
  }

  /* ================= 视图绘制 ================= */
  function syncCanvas() {
    var wrap = el.viewwrap, vc = el.viewCanvas;
    var W = wrap.clientWidth, H = wrap.clientHeight;
    if (!W || !H) return null;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (vc.width !== Math.round(W * dpr) || vc.height !== Math.round(H * dpr)) {
      vc.width = Math.round(W * dpr); vc.height = Math.round(H * dpr);
    }
    var ctx = vc.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    return { ctx: ctx, W: W, H: H };
  }

  function drawView() {
    if (!state.master) return;
    var s = syncCanvas();
    if (!s) return;
    if (state.view === 'result') drawResult(s.ctx, s.W, s.H);
    else drawCropView(s.ctx, s.W, s.H);
  }

  function drawResult(ctx, W, H) {
    var c = state.result && state.result.canvas;
    if (!c) return;
    var k = Math.min(W / c.width, H / c.height);
    var dw = c.width * k, dh = c.height * k;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect((W - dw) / 2, (H - dh) / 2, dw, dh);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(c, (W - dw) / 2, (H - dh) / 2, dw, dh);
    state._viewScale = k;
    state._viewOrigin = [(W - dw) / 2, (H - dh) / 2, true];
  }

  function drawCropView(ctx, W, H) {
    var m = state.master, r = state.rect;
    if (!state.dragging || !state._fit) {
      var bx0 = 0, by0 = 0, bx1 = m.width, by1 = m.height;
      if (r) {
        bx0 = Math.min(bx0, r.x); by0 = Math.min(by0, r.y);
        bx1 = Math.max(bx1, r.x + r.w); by1 = Math.max(by1, r.y + r.h);
      }
      var pad = 0.03, bw = bx1 - bx0, bh = by1 - by0;
      state._fit = { x0: bx0 - bw * pad, y0: by0 - bh * pad, w: bw * (1 + pad * 2), h: bh * (1 + pad * 2) };
    }
    var fit = state._fit;
    var k = Math.min(W / fit.w, H / fit.h);
    var ox = (W - fit.w * k) / 2 - fit.x0 * k;
    var oy = (H - fit.h * k) / 2 - fit.y0 * k;
    state._viewScale = k;

    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(m, ox, oy, m.width * k, m.height * k);
    if (!r) return;

    var rx = ox + r.x * k, ry = oy + r.y * k, rw = r.w * k, rh = r.h * k;
    state._frame = { x: rx, y: ry, w: rw, h: rh };

    ctx.save();
    ctx.fillStyle = 'rgba(18,18,22,.44)';
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.rect(rx, ry, rw, rh);
    ctx.fill('evenodd');
    ctx.restore();

    ctx.strokeStyle = 'rgba(255,255,255,.35)';
    ctx.lineWidth = 1;
    for (var i = 1; i < 3; i++) {
      ctx.beginPath(); ctx.moveTo(rx + rw * i / 3, ry); ctx.lineTo(rx + rw * i / 3, ry + rh); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(rx, ry + rh * i / 3); ctx.lineTo(rx + rw, ry + rh * i / 3); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,255,255,.95)';
    ctx.lineWidth = 2;
    ctx.strokeRect(rx, ry, rw, rh);
  }

  function updateMeta() {
    var r = state.rect, sp = specFor();
    if (!r) { el.cropMeta.hidden = true; return; }
    el.cropMeta.hidden = state.view === 'result';
    el.cropMeta.textContent = sp.width_px + '×' + sp.height_px + 'px' +
      ' · 头顶留白 ' + (r.topMargin * 100).toFixed(1) + '%' +
      ' · 头部占比 ' + (r.faceRatio * 100).toFixed(0) + '%' +
      ' · 下巴 ' + (r.chinMargin * 100).toFixed(0) + '%';
  }

  function updateMatteTag(err) {
    var hd = state.engine === 'modnet';
    el.matteHint.textContent = hd
      ? '已启用 MODNet 高精度抠图（发丝过渡更自然）。'
      : (err ? 'MODNet 不可用，已降级为标准抠图：' + err : '抠图引擎：标准模式。');
  }

  /* ================= 视图 / 锁定 ================= */
  function applyViewUI() {
    var res = state.view === 'result';
    el.specPicker.hidden = res;
    el.customSpec.hidden = res ? true : (state.cat !== '自定义');
    el.specText.hidden = !res;
    if (res) {
      el.specText.textContent = '当前规格：' + state.spec.name +
        '（' + state.spec.width_px + '×' + state.spec.height_px + 'px）';
    }
    el.resetFit.hidden = res;
    el.peekBtn.hidden = !res;
    el.viewHint.textContent = res ? '点图片可放大查看' : '拖动移动取景框 · 滚轮 / 双指缩放';
    el.preHint.hidden = res;
    el.sumBar.hidden = !res || !state.hasPhoto;
    el.downloadBtn.classList.toggle('is-muted', !res);
    el.mainAction.textContent = res ? '重新裁剪' : '预生成';
    updateMeta();
  }

  function gotoView(v) {
    state.view = v;
    if (v === 'crop') { state._fit = null; }
    applyViewUI();
    drawView();
  }
  function backToCrop() {
    closeZoom();
    gotoView('crop');
    el.controls.scrollTop = 0;
  }

  function setLocked(on) {
    el.controls.classList.toggle('locked', on);
    el.mainAction.disabled = on;
  }

  /* ================= 上传 ================= */
  function handleFile(file) {
    notice(el.uploadNotice, '');
    busy(true, '正在读取照片…');
    readFile(file).then(function (img) {
      if (!img) return null;
      if (img.naturalWidth * img.naturalHeight > 1e8) throw new Error('照片分辨率过高（超过 1 亿像素），请先缩小');
      state.fileName = file.name || '';
      state.master = window.IDP.Crop.loadMaster(img);
      state.matte = null; state.matteW = state.matteH = 0;
      resetComposition();
      state.face = null;
      state.rect = null;
      state.result = null; state.fullCanvas = null;
      el.sumBar.hidden = true;
      el.uploadBox.hidden = true;
      el.viewwrap.hidden = false;
      el.cropMeta.hidden = true;
      state.hasPhoto = true;
      state.gen++;
      drawView();                       /* 先显示原图，不画裁剪框 */
      return analyzePhoto();
    }).catch(function (e) { busy(false); state.analyzing = false; fail(e); });
  }

  /* ---------- 三态：未上传 / 已上传 / 重新上传 ---------- */
  function bgName(hex) {
    var hit = window.IDP.BG_COLORS.filter(function (c) { return c.hex.toLowerCase() === String(hex).toLowerCase(); })[0];
    return hit ? hit.name : '自定义';
  }
  function gotoState(next) {
    if (next === 'idle') {
      cancelRunning();
      state.hasPhoto = false;
      state.master = null; state.face = null; state.rect = null;
      state.matte = null; state.matteW = state.matteH = 0;
      state.result = null; state.fullCanvas = null; state.metrics = null;
      state.results = []; state.overall = 'pass';
      state.view = 'crop';
      closeZoom(); closeModal();
      el.uploadBox.hidden = false;
      el.viewwrap.hidden = true;
      el.cropMeta.hidden = true;
      el.sumBar.hidden = true;
      el.resetBtn.hidden = true;
      el.progress.hidden = true;
      el.controls.classList.add('locked');
      el.mainAction.disabled = true;
      el.mainAction.textContent = '预生成';
      notice(el.uploadNotice, ''); notice(el.exportNotice, ''); notice(el.checkNotice, '');
      el.fileInput.value = ''; el.camInput.value = '';
      el.controls.scrollTop = 0;
    } else {
      el.uploadBox.hidden = true;
      el.viewwrap.hidden = false;
      el.resetBtn.hidden = false;
      el.controls.classList.remove('locked');
      if (!state.job && !state.analyzing) el.mainAction.disabled = false;
      applyViewUI();
    }
    updateSpecFade();
  }

  function updateSpecFade() {
    if (!el.specScroll || !el.specRow) return;
    var more = el.specRow.scrollWidth - el.specRow.clientWidth - el.specRow.scrollLeft > 4;
    el.specScroll.classList.toggle('can-scroll', more);
  }

  function resetComposition() {
    state.zoom = 1; state.offsetX = 0; state.offsetY = 0;
    state.centerY = state.spec.centerY == null ? D.centerY : state.spec.centerY;
    state._fit = null;
  }

  /* ================= 拖动 / 缩放（仅裁剪视图，纯几何，零图像处理） ================= */
  function bindDrag() {
    var wrap = el.viewwrap;
    var pointers = {}, start = null, pinchStart = null;

    function localPos(e) {
      var r = wrap.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    function ids() { return Object.keys(pointers); }

    wrap.addEventListener('pointerdown', function (e) {
      if (state.view !== 'crop' || !state.master || !state.rect || state.analyzing || state.job) return;
      try { wrap.setPointerCapture(e.pointerId); } catch (err) { }
      pointers[e.pointerId] = localPos(e);
      if (ids().length === 1) {
        start = { p: localPos(e), o: { x: state.offsetX, y: state.offsetY } };
        state.dragging = true;
        wrap.classList.add('dragging');
        drawView();
      } else if (ids().length === 2) {
        var k = ids();
        var a = pointers[k[0]], b = pointers[k[1]];
        pinchStart = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: state.zoom };
        start = null;
      }
      e.preventDefault();
    });

    wrap.addEventListener('pointermove', function (e) {
      if (!pointers[e.pointerId]) return;
      pointers[e.pointerId] = localPos(e);
      var k = ids();
      if (k.length >= 2 && pinchStart) {
        var a = pointers[k[0]], b = pointers[k[1]];
        var d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchStart.d > 4) {
          state.zoom = clamp(pinchStart.zoom * (d / pinchStart.d), 0.5, 1.3);
          state.rect = computeRect();
          updateMeta(); drawView();
        }
        return;
      }
      if (!start || !state.rect) return;
      var s = state._viewScale || 1;
      state.offsetX = start.o.x + (localPos(e).x - start.p.x) / s / state.rect.w;
      state.offsetY = start.o.y + (localPos(e).y - start.p.y) / s / state.rect.h;
      state.rect = computeRect();     /* 纯数学，零延迟 */
      updateMeta();
      drawView();
      e.preventDefault();
    });

    function endPointer(e) {
      if (!pointers[e.pointerId]) return;
      delete pointers[e.pointerId];
      if (ids().length < 2) pinchStart = null;
      if (ids().length === 0) {
        state.dragging = false;
        start = null;
        invalidateResult();          /* 取景变了，旧的预生成结果作废 */
        wrap.classList.remove('dragging');
        drawView();
      }
    }
    wrap.addEventListener('pointerup', endPointer);
    wrap.addEventListener('pointercancel', endPointer);
    wrap.addEventListener('lostpointercapture', endPointer);

    wrap.addEventListener('wheel', function (e) {
      if (state.view !== 'crop' || !state.master || !state.rect || state.job) return;
      e.preventDefault();
      state.zoom = clamp(state.zoom * (1 - e.deltaY * 0.0012), 0.5, 1.3);
      state.rect = computeRect();
      updateMeta(); drawView();
    }, { passive: false });

    /* 结果视图：点一下 → 全屏放大 */
    wrap.addEventListener('click', function () {
      if (state.view !== 'result' || state.dragging) return;
      openZoom();
    });
  }

  /* ================= 点按放大 ================= */
  function openZoom() {
    if (state.view !== 'result' || !state.result || !state.result.canvas) return;
    var c = el.zoomCanvas, src = state.result.canvas;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var W = window.innerWidth, H = window.innerHeight;
    c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
    c.style.width = W + 'px'; c.style.height = H + 'px';
    var ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0B0B0C';
    ctx.fillRect(0, 0, W, H);
    var k = Math.min(W / src.width, H / src.height);
    var dw = src.width * k, dh = src.height * k;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
    el.zoomView.hidden = false;
  }
  function closeZoom() { el.zoomView.hidden = true; }

  /* ================= 上传区绑定 ================= */
  function bindDrop() {
    el.uploadBox.addEventListener('click', function (e) { if (!e.target.closest('button')) el.fileInput.click(); });
    el.pickBtn.addEventListener('click', function (e) { e.stopPropagation(); el.fileInput.click(); });
    el.shootBtn.addEventListener('click', function (e) { e.stopPropagation(); el.camInput.click(); });
    el.fileInput.addEventListener('change', function () { if (this.files[0]) handleFile(this.files[0]); this.value = ''; });
    el.camInput.addEventListener('change', function () { if (this.files[0]) handleFile(this.files[0]); this.value = ''; });
    ['dragenter', 'dragover'].forEach(function (ev) {
      el.uploadBox.addEventListener(ev, function (e) { e.preventDefault(); el.uploadBox.classList.add('is-over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      el.uploadBox.addEventListener(ev, function (e) { e.preventDefault(); el.uploadBox.classList.remove('is-over'); });
    });
    el.uploadBox.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFile(f);
    });
    window.addEventListener('paste', function (e) {
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf('image') === 0) {
          var f = items[i].getAsFile();
          if (f) { handleFile(f); break; }
        }
      }
    });
    el.resetBtn.addEventListener('click', function () { gotoState('idle'); });
  }

  /* ================= 规格 UI ================= */
  function renderTabs() {
    el.specTabs.innerHTML = CATS.map(function (c) {
      return '<button type="button" class="tab' + (c === state.cat ? ' is-on' : '') + '" data-cat="' + c + '">' + c + '</button>';
    }).join('');
    Array.prototype.forEach.call(el.specTabs.children, function (b) {
      b.addEventListener('click', function () { state.cat = b.dataset.cat; renderTabs(); renderSpecRow(); });
    });
  }

  function renderSpecRow() {
    if (state.cat === '自定义') {
      el.specRow.hidden = true; el.customSpec.hidden = false;
      el.specHint.textContent = '输入任意尺寸，毫米按 300 DPI 换算；构图用默认参数（头部占比 0.68 / 头顶留白 0.05）。';
      return;
    }
    el.customSpec.hidden = true; el.specRow.hidden = false;
    var list = SPECS.filter(function (s) { return s.category === state.cat; });
    el.specRow.innerHTML = list.map(function (s) {
      var dim = s.width_mm ? s.width_mm + '×' + s.height_mm + 'mm · ' + s.width_px + '×' + s.height_px + 'px'
                           : s.width_px + '×' + s.height_px + 'px';
      return '<button type="button" class="spec' + (s.id === state.spec.id ? ' is-on' : '') + '" data-id="' + s.id + '">' +
        '<div class="spec-name">' + s.name + '</div>' +
        '<div class="spec-size">' + dim + '</div>' +
        '<div class="spec-note">' + (s.note || '') + '</div></button>';
    }).join('');
    Array.prototype.forEach.call(el.specRow.children, function (b) {
      b.addEventListener('click', function () {
        var s = SPECS.filter(function (x) { return x.id === b.dataset.id; })[0];
        if (s) selectSpec(s);
      });
    });
    var cur = SPECS.filter(function (s) { return s.id === state.spec.id; })[0];
    el.specHint.textContent = cur
      ? (cur.note || '') + '　构图：头部 ' + (cur.faceRatio * 100).toFixed(0) + '% / 居中 ' + cur.centerY + ' / 头顶留白 ' + (cur.topMargin * 100).toFixed(0) + '%'
      : '';
  }

  function selectSpec(s) {
    if (state.view === 'result') return;      /* 规格只在裁剪视图可改 */
    state.spec = s;
    if (s.bg_color) setBg(s.bg_color, true);
    resetComposition();
    renderSpecRow();
    refreshRect();                            /* 复用已算好的 matte 与人脸点，只重算裁剪框 */
    updateSpecFade();
  }

  /* ================= 背景 UI ================= */
  function renderSwatches() {
    el.swatches.innerHTML = window.IDP.BG_COLORS.map(function (c) {
      return '<button type="button" class="sw' + (c.hex.toLowerCase() === state.bg.toLowerCase() ? ' is-on' : '') +
        '" data-hex="' + c.hex + '" title="' + c.name + ' ' + c.note + '">' +
        '<span class="sw-chip" style="background:' + c.hex + '"></span>' +
        '<span class="sw-name">' + c.name + '</span></button>';
    }).join('');
    Array.prototype.forEach.call(el.swatches.children, function (b) {
      b.addEventListener('click', function () { setBg(b.dataset.hex); });
    });
    el.bgCustom.value = /^#[0-9a-f]{6}$/i.test(state.bg) ? state.bg : '#FFFFFF';
  }

  function setBg(hex, silent) {
    state.bg = hex;
    renderSwatches();
    if (!silent) scheduleReRender();
  }

  /* ================= 控件绑定 ================= */
  function bindControls() {
    el.intenSlider.addEventListener('input', function () {
      state.intensity = (+this.value) / 100;
      el.intenOut.textContent = this.value + '%';
      el.mopiHint.textContent = state.intensity * 100 > 28
        ? '已接近上限（' + this.value + '%），建议不超过 28%'
        : '只作用于人脸区域，上限 30%';
      scheduleReRender();
    });
    el.radiusSlider.addEventListener('input', function () {
      state.radius = +this.value;
      el.radiusOut.textContent = this.value + 'px';
      scheduleReRender();
    });
    el.resetFit.addEventListener('click', function () {
      if (state.view === 'result') return;
      resetComposition();
      refreshRect();
    });
    el.bgCustom.addEventListener('input', function () { setBg(this.value); });

    /* 主按钮：预生成 / 重新裁剪 */
    el.mainAction.addEventListener('click', function () {
      if (state.analyzing || state.job) return;
      preGenerate();
    });
    /* 取消 */
    el.cancelBtn.addEventListener('click', function () {
      cancelRunning();
      toast('已取消');
    });

    Array.prototype.forEach.call(el.customUnit.children, function (b) {
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(el.customUnit.children, function (x) { x.classList.remove('is-on'); });
        b.classList.add('is-on');
        state.customUnit = b.dataset.unit;
      });
    });
    el.applyCustom.addEventListener('click', function () {
      if (state.view === 'result') return;
      var w = parseFloat(el.cw.value), h = parseFloat(el.ch.value);
      if (!(w > 0) || !(h > 0)) { notice(el.uploadNotice, '自定义尺寸必须大于 0', 'err'); return; }
      var wp, hp, wmm, hmm;
      if (state.customUnit === 'mm') {
        wp = Math.round(w * 300 / 25.4); hp = Math.round(h * 300 / 25.4); wmm = w; hmm = h;
      } else {
        wp = Math.round(w); hp = Math.round(h);
        wmm = +(w * 25.4 / 300).toFixed(1); hmm = +(h * 25.4 / 300).toFixed(1);
      }
      if (wp * hp > MAX_KB_CANVAS) { notice(el.uploadNotice, '尺寸过大（超过 16 兆像素），请调小', 'err'); return; }
      if (wp < 40 || hp < 40) { notice(el.uploadNotice, '尺寸过小，宽高至少 40px', 'err'); return; }
      notice(el.uploadNotice, '');
      state.spec = {
        id: 'custom', name: '自定义', category: '自定义',
        width_mm: wmm, height_mm: hmm, width_px: wp, height_px: hp,
        bg_color: state.bg, faceRatio: D.faceRatio, centerY: D.centerY, topMargin: D.topMargin, note: ''
      };
      el.specHint.textContent = '已应用自定义规格 ' + wp + ' × ' + hp + ' px（构图用默认参数）';
      resetComposition();
      refreshRect();
    });

    /* 目标大小 */
    el.sizeChips.innerHTML = window.IDP.Export.TARGETS.map(function (t) {
      return '<button type="button" class="chip' + (t.id === state.target ? ' is-on' : '') + '" data-id="' + t.id + '">' +
        t.name + (t.note ? '（' + t.note + '）' : '') + '</button>';
    }).join('');
    Array.prototype.forEach.call(el.sizeChips.children, function (b) {
      b.addEventListener('click', function () {
        state.target = b.dataset.id;
        Array.prototype.forEach.call(el.sizeChips.children, function (x) { x.classList.remove('is-on'); });
        b.classList.add('is-on');
        refreshExportInfo();
      });
    });

    el.downloadBtn.addEventListener('click', function () { doDownload(false); });

    /* 按住对比原图（结果视图） */
    function peek(on) {
      var r = state.result;
      if (!r || !r.composed || !r.canvas) return;
      var canvas = on ? r.composed : r.canvas;
      var ctx = el.viewCanvas.getContext('2d');
      var W = el.viewwrap.clientWidth, H = el.viewwrap.clientHeight;
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      var k = Math.min(W / canvas.width, H / canvas.height);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(canvas, (W - canvas.width * k) / 2, (H - canvas.height * k) / 2,
                    canvas.width * k, canvas.height * k);
      el.viewHint.textContent = on ? '正在显示：未磨皮效果' : '点图片可放大查看';
    }
    ['pointerdown', 'touchstart', 'mousedown'].forEach(function (ev) {
      el.peekBtn.addEventListener(ev, function (e) { e.preventDefault(); peek(true); });
    });
    ['pointerup', 'pointerleave', 'touchend', 'touchcancel', 'mouseup', 'mouseleave'].forEach(function (ev) {
      el.peekBtn.addEventListener(ev, function () { peek(false); });
    });

    window.addEventListener('resize', function () { drawView(); updateSpecFade(); });
    window.addEventListener('orientationchange', function () { setTimeout(function () { drawView(); updateSpecFade(); }, 260); });
    if (window.ResizeObserver) new ResizeObserver(function () { drawView(); }).observe(el.viewwrap);

    /* 校验概要 → 详情浮层 */
    el.sumBar.addEventListener('click', openModal);
    el.modalClose.addEventListener('click', closeModal);
    el.modal.addEventListener('click', function (e) {
      if (e.target.closest('[data-close]')) closeModal();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!el.zoomView.hidden) closeZoom(); else closeModal();
    });
    el.modalDownload.addEventListener('click', function () { closeModal(); doDownload(false); });

    /* 换背景：显式应用一次并给反馈 */
    el.applyBgBtn.addEventListener('click', function () {
      if (!state.hasPhoto) return;
      if (state.view === 'result') {
        scheduleReRender();
        toast('已应用' + bgName(state.bg) + '背景');
      } else {
        toast('背景色将在预生成后生效');
      }
    });

    /* 未上传时点操作区 → 提示先上传照片 */
    el.controls.addEventListener('click', function (e) {
      if (state.hasPhoto) return;
      e.preventDefault(); e.stopPropagation();
      toast('请先上传照片');
    }, true);

    el.specRow.addEventListener('scroll', updateSpecFade, { passive: true });

    /* 点按放大：点视图任意处退出 */
    el.zoomView.addEventListener('click', closeZoom);
  }

  /* ================= 合规 ================= */
  var ICONS = {
    pass: '<svg class="ck-icon" viewBox="0 0 24 24" fill="none" stroke="#34C759" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg>',
    warn: '<svg class="ck-icon" viewBox="0 0 24 24" fill="none" stroke="#FF9500" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.6l9 15.4H3z"/><path d="M12 9.5v4.2"/><circle cx="12" cy="16.6" r="0.9" fill="#FF9500" stroke="none"/></svg>',
    fail: '<svg class="ck-icon" viewBox="0 0 24 24" fill="none" stroke="#FF3B30" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>'
  };

  function runCompliance(canvas, metrics, matte) {
    if (!canvas || !metrics) return;
    state.results = window.IDP.Compliance.check(canvas, metrics, {
      intensity: state.intensity,
      bgRgb: window.IDP.BgRemove.hexToRgb(state.bg),
      alpha: matte
    });
    state.overall = window.IDP.Compliance.overall(state.results);

    el.checks.innerHTML = state.results.map(function (r) {
      return '<li class="lv-' + r.level + '">' + ICONS[r.level] +
        '<div class="ck-body"><div class="ck-name">' + r.name + '</div>' +
        '<div class="ck-text">' + r.text + '</div></div></li>';
    }).join('');

    var nWarn = 0, nFail = 0;
    state.results.forEach(function (r) {
      if (r.level === 'warn') nWarn++;
      else if (r.level === 'fail') nFail++;
    });
    el.sumBar.className = 'sumbar lv-' + state.overall;
    el.sumIcon.innerHTML = ICONS[state.overall];
    el.sumText.textContent = nFail ? (nFail + ' 项不通过') : (nWarn ? (nWarn + ' 项警告') : '符合规范');
    el.sumBar.hidden = state.view !== 'result';

    var can = state.overall !== 'fail';
    el.modalDownload.disabled = !can;
    if (can) {
      notice(el.checkNotice, state.overall === 'warn'
        ? '有提醒项，仍可下载；如需通过官方验证建议先按提示调整。' : '', state.overall === 'warn' ? 'warn' : '');
    } else {
      el.checkNotice.hidden = false;
      el.checkNotice.className = 'notice is-err';
      el.checkNotice.innerHTML = '检测未通过，请先按提示修正。' +
        ' <button type="button" class="btn btn-ghost btn-sm" id="forceDl" style="min-height:28px;padding:0 10px;font-size:13px;margin-left:6px">仍要下载</button>';
      var f = document.getElementById('forceDl');
      if (f) f.addEventListener('click', function () { closeModal(); doDownload(true); });
    }
  }

  function openModal() { if (state.view === 'result' && state.result) el.modal.hidden = false; }
  function closeModal() { el.modal.hidden = true; }

  /* ================= 导出 ================= */
  var exportTimer = 0;
  function refreshExportInfo() {
    clearTimeout(exportTimer);
    exportTimer = setTimeout(function () {
      if (state.view !== 'result' || !state.result) { notice(el.exportNotice, ''); return; }
      var c = resultCanvas();                 /* 规格原始像素，估算即实测 */
      if (!c) return;
      window.IDP.Export.encode(c, state.target).then(function (info) {
        state.exportInfo = info;
        var t = info.target;
        var msg = '当前导出 ' + info.kb.toFixed(1) + ' KB（' +
          c.width + '×' + c.height + 'px，质量 ' + info.quality.toFixed(2) + '）';
        if (t.max !== Infinity) msg += '，目标 ' + t.min + '–' + t.max + ' KB';
        var kind = 'ok';
        if (state.target !== 'none' && !info.ok && info.reason === 'over') {
          msg += ' —— 已压到最低质量仍超出，可直接下载但不满足目标'; kind = 'err';
        }
        if (state.target !== 'none' && !info.ok && info.reason === 'under') {
          msg += ' —— 低于目标下限，官方系统可能拒收小文件'; kind = 'warn';
        }
        notice(el.exportNotice, msg, kind);
      }).catch(function () { });
    }, 320);
  }

  function doDownload(force) {
    if (state.view !== 'result' || !state.result) { toast('请先点「预生成」'); return; }
    if (state.overall === 'fail' && !force) return;
    if (state.job) return;
    var cv = resultCanvas();                  /* 交付层已缓存，直接编码 */
    if (!cv) { toast('请先点「预生成」'); return; }
    el.progress.hidden = false;
    el.progressFill.style.width = '30%';
    el.progressText.textContent = '正在编码 JPEG…';
    window.IDP.Export.encode(cv, state.target).then(function (info) {
      window.IDP.Export.download(info.blob, window.IDP.Export.fileName(state.spec.id));
      state.exportInfo = info;
      el.progressFill.style.width = '100%';
      el.progressText.textContent = '完成 · ' + info.kb.toFixed(1) + ' KB';
      setTimeout(function () { el.progress.hidden = true; }, 1600);
    }).catch(function (e) { el.progress.hidden = true; fail(e); });
  }

  /* ================= 启动 ================= */
  function boot() {
    renderTabs(); renderSpecRow(); renderSwatches();
    bindDrop(); bindControls(); bindDrag();
    updateMatteTag();
    gotoState('idle');
    registerSW();
    startBootScreen();
  }

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { });
    });
  }

  function startBootScreen() {
    var attempt = 0, entered = false, t0 = Date.now(), models = null;
    var FILES = window.IDP.Preload.FILES;

    el.bootRows.innerHTML = FILES.map(function (f) {
      return '<div class="boot-row" data-id="' + f.id + '">' +
        '<div class="boot-line"><span class="boot-label">' + f.label + '</span><span class="boot-pct">0%</span></div>' +
        '<div class="boot-track"><i></i></div></div>';
    }).join('');

    function setP(id, p, cached) {
      var row = el.bootRows.querySelector('[data-id="' + id + '"]');
      if (!row) return;
      row.querySelector('.boot-track i').style.width = Math.round(p * 100) + '%';
      var pct = row.querySelector('.boot-pct');
      if (pct) pct.textContent = cached ? '已缓存' : Math.round(p * 100) + '%';
      if (p >= 1) row.classList.add('is-done');
    }

    function enter() {
      if (entered) return;
      entered = true;
      if (models) {
        if (window.IDP.FaceDetect.setModelBuffer) window.IDP.FaceDetect.setModelBuffer(models.face);
        if (window.IDP.BgRemove.setModnetBuffer) window.IDP.BgRemove.setModnetBuffer(models.modnet);
      }
      el.boot.classList.add('is-gone');
      el.app.hidden = false;
      state.booted = true;
      setTimeout(function () { el.boot.hidden = true; drawView(); updateSpecFade(); }, 320);
    }

    function fail2(e) {
      el.bootStage.textContent = '加载未完成';
      el.bootErr.hidden = false;
      el.bootErr.textContent = attempt >= 3
        ? '网络异常，请检查后刷新页面（已重试 3 次）'
        : ('模型加载失败：' + ((e && e.message) || e));
      el.bootRetry.hidden = attempt >= 3;
    }

    function start() {
      attempt++;
      el.bootErr.hidden = true;
      el.bootRetry.hidden = true;
      el.bootEnter.hidden = true;
      el.bootStage.textContent = '正在准备模型…';
      Array.prototype.forEach.call(el.bootRows.querySelectorAll('.boot-row'), function (r) {
        r.classList.remove('is-done');
        r.querySelector('.boot-track i').style.width = '0%';
        r.querySelector('.boot-pct').textContent = '0%';
      });
      if (attempt === 1) t0 = Date.now();
      window.IDP.Preload.loadAll(setP).then(function (m) {
        models = m;
        el.bootStage.textContent = '准备就绪';
        el.bootEnter.hidden = false;
        var wait = Math.max(0, 1000 - (Date.now() - t0));
        setTimeout(enter, wait + 1400);
      }).catch(fail2);
    }

    el.bootEnter.addEventListener('click', enter, { once: true });
    el.bootRetry.addEventListener('click', function () {
      window.IDP.Preload.clear().then(start);
    });
    start();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* ================= 测试 API ================= */
  function rectKey() {
    var r = state.rect;
    return r ? [Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)].join(',') : '';
  }
  window.IDPDebug = {
    ready: function () { return !!(state.master && state.face && state.rect); },
    state: function () {
      var r = state.result;
      return {
        view: state.view, spec: state.spec.id, specName: state.spec.name,
        w: state.spec.width_px, h: state.spec.height_px,
        bg: state.bg, intensity: state.intensity, radius: state.radius, target: state.target,
        overall: state.overall, results: state.results,
        rect: state.rect, metrics: state.metrics,
        zoom: state.zoom, offsetX: state.offsetX, offsetY: state.offsetY,
        centerY: state.centerY, faceRatio: specFor().faceRatio, topMargin: specFor().topMargin,
        engine: state.engine, dragging: state.dragging,
        booted: state.booted, hasPhoto: state.hasPhoto, analyzing: state.analyzing,
        bootHidden: !!document.getElementById('boot').hidden,
        uploadBoxVisible: !document.getElementById('uploadBox').hidden,
        viewVisible: !document.getElementById('viewwrap').hidden,
        controlsLocked: document.getElementById('controls').classList.contains('locked'),
        locked: !!state.job || state.analyzing,
        webgl: window.IDP.Mopi.isWebGL(), faceCount: state.face ? state.face.count : 0,
        matteSize: state.matte ? [state.matteW, state.matteH] : null,
        resultSize: r && r.canvas ? [r.canvas.width, r.canvas.height] : null,
        fullSize: state.fullCanvas ? [state.fullCanvas.width, state.fullCanvas.height] : null,
        masterSize: state.master ? [state.master.width, state.master.height] : null,
        gen: state.gen, renderSeq: state.renderSeq,
        modnetReady: window.IDP.BgRemove.isModnetReady(),
        busy: !!state.job, zoomOpen: !document.getElementById('zoomView').hidden,
        mainLabel: document.getElementById('mainAction').textContent,
        mainDisabled: document.getElementById('mainAction').disabled,
        specPickerVisible: !document.getElementById('specPicker').hidden,
        sumVisible: !document.getElementById('sumBar').hidden,
        rectKey: rectKey()
      };
    },
    head: function () {
      var f = state.face; if (!f) return null;
      return {
        ovalX: f.ovalBox.x, ovalW: f.ovalBox.w,
        ovalTop: f.ovalBox.y, ovalH: f.ovalBox.h,
        hairTop: f.hairTop, headTop: f.headTop, chin: f.chin,
        headH: f.head.h, hairRatio: f.head.h / f.ovalBox.h,
        scanX0: f.ovalBox.x - f.ovalBox.w * 0.40,
        scanX1: f.ovalBox.x + f.ovalBox.w * 1.40,
        rect: state.rect
      };
    },
    specList: function () {
      return window.IDP.SPECS.map(function (s) {
        return { id: s.id, name: s.name, category: s.category, w: s.width_px, h: s.height_px,
                 faceRatio: s.faceRatio, centerY: s.centerY, topMargin: s.topMargin };
      });
    },
    loadUrl: function (url, name) {
      return fetch(url).then(function (r) { return r.blob(); }).then(function (b) {
        return handleFile(new File([b], name || 'test.png', { type: b.type }));
      });
    },
    analyzeDone: function () { return !state.analyzing && !!state.face; },
    /* 逐个规格体检（纯几何，不跑图像处理） */
    checkSpecs: function () {
      var out = [];
      var save = { spec: state.spec, zoom: state.zoom, ox: state.offsetX, oy: state.offsetY, cy: state.centerY };
      for (var i = 0; i < SPECS.length; i++) {
        var s = SPECS[i];
        var rect = window.IDP.Crop.computeCrop(state.face, state.master, s, { zoom: 1, offsetX: 0, offsetY: 0 });
        var m = window.IDP.Crop.faceMetrics(state.face, state.master, rect, s);
        out.push({
          id: s.id, name: s.name, category: s.category, w: s.width_px, h: s.height_px,
          faceRatio: +(m.headH / m.H).toFixed(4), wantFaceRatio: s.faceRatio,
          topMargin: +m.topMargin.toFixed(4), wantTopMargin: s.topMargin,
          chinMargin: +m.chinMargin.toFixed(4),
          headTopOut: +m.top.toFixed(2), chinOut: +m.bottom.toFixed(2),
          clamped: !!(rect.w > state.master.width * 1.49 || rect.h > state.master.height * 1.49)
        });
      }
      state.spec = save.spec; state.zoom = save.zoom;
      state.offsetX = save.ox; state.offsetY = save.oy; state.centerY = save.cy;
      return out;
    },
    attachFile: function (file) { return handleFile(file); },
    masterCanvas: function () { return state.master; },
    matteInfo: function () { return state.matte ? { w: state.matteW, h: state.matteH, data: state.matte } : null; },
    setSpecById: function (id) {
      var s = SPECS.filter(function (x) { return x.id === id; })[0];
      if (!s) throw new Error('unknown spec ' + id);
      selectSpec(s);
      return state.rect;
    },
    setBg: function (hex) { setBg(hex); },
    setIntensity: function (v) {
      state.intensity = v; el.intenSlider.value = Math.round(v * 100);
      el.intenOut.textContent = Math.round(v * 100) + '%';
      scheduleReRender();
    },
    setRadius: function (v) { state.radius = v; el.radiusSlider.value = v; el.radiusOut.textContent = v + 'px'; scheduleReRender(); },
    setTarget: function (id) { state.target = id; refreshExportInfo(); },
    setComposition: function (o) {
      if (state.view === 'result') state.view = 'crop';
      if (o.zoom != null) state.zoom = o.zoom;
      if (o.offsetX != null) state.offsetX = o.offsetX;
      if (o.offsetY != null) state.offsetY = o.offsetY;
      if (o.centerY != null) state.centerY = o.centerY;
      state.rect = computeRect();
      invalidateResult();
      updateMeta(); drawView();
      return state.rect;
    },
    setEngine: function (e) { state.engine = e; state.matte = null; updateMatteTag(); },
    ensureModnet: function () { return window.IDP.BgRemove.ensureModnet(function () { }, function () { }); },
    viewRect: function () { return el.viewwrap.getBoundingClientRect(); },
    viewScale: function () { return state._viewScale; },
    /* 预生成 / 重新裁剪 */
    preGenerate: function () { preGenerate(); return waitIdle(); },
    backToCrop: backToCrop,
    cancel: cancelRunning,
    runFull: function () {
      if (!state.rect) return Promise.resolve(null);
      return computeResult(null, function () { }, { cancelled: false }).then(function (r) {
        if (r) { state.fullCanvas = r.canvas; if (state.result) state.result.full = r; }
        return r ? r.canvas : null;
      });
    },
    resultCanvas: resultCanvas,
    timings: function () { return state.result ? state.result.timings : null; },
    openZoom: openZoom, closeZoom: closeZoom,
    gotoState: gotoState,
    resultLong: resultLong,
    /* long=null → 规格原始像素；返回 {data,w,h}（w/h 为真实画布尺寸，勿用 long 推算） */
    alphaForRect: function (long) {
      var base = window.IDP.Crop.renderCrop(state.master, state.rect, specFor(), long == null ? null : long);
      return { data: alphaFor(state.rect, base), w: base.width, h: base.height };
    },
    modelsCached: function () {
      if (typeof caches === 'undefined') return Promise.resolve(null);
      return caches.open(window.IDP.Preload.CACHE).then(function (c) {
        return Promise.all(window.IDP.Preload.FILES.map(function (f) {
          return c.match(f.url).then(function (r) { return r ? f.id + ':hit' : f.id + ':miss'; });
        }));
      });
    },
    clearModelCache: function () { return window.IDP.Preload.clear(); },
    encode: function () {
      var cv = resultCanvas();
      return window.IDP.Export.encode(cv, state.target);
    },
    pngUrl: function (which) {
      var r = state.result;
      var c = which === 'full' ? resultCanvas()
            : which === 'result' ? (r && r.canvas)
            : which === 'base' ? (r && r.base)
            : which === 'mask' ? (r && r.mask)
            : which === 'composed' ? (r && r.composed) : null;
      return c ? c.toDataURL('image/png') : null;
    },
    mattePngUrl: function () {
      if (!state.matte) return null;
      var c = document.createElement('canvas');
      c.width = state.matteW; c.height = state.matteH;
      var d = c.getContext('2d').createImageData(state.matteW, state.matteH);
      for (var i = 0; i < state.matte.length; i++) {
        var v = Math.round(clamp(state.matte[i], 0, 1) * 255);
        d.data[i * 4] = v; d.data[i * 4 + 1] = v; d.data[i * 4 + 2] = v; d.data[i * 4 + 3] = 255;
      }
      c.getContext('2d').putImageData(d, 0, 0);
      return c.toDataURL('image/png');
    },
    alphaStats: function () {
      if (!state.matte) return null;
      var a = state.matte, n = 0, soft = 0;
      for (var i = 0; i < a.length; i++) { if (a[i] > 0.5) n++; if (a[i] > 0.05 && a[i] < 0.95) soft++; }
      return { len: a.length, fgRatio: n / a.length, softRatio: soft / a.length };
    },
    /* 发丝边缘锐度：过渡带梯度均值，越大越"硬" */
    edgeProfile: function () {
      var r = state.result;
      if (!r || !r.alpha || !r.base) return null;
      var w = r.base.width, h = r.base.height, a = r.alpha;
      var band = 0, sum = 0, n = 0;
      for (var y = 1; y < h - 1; y++) for (var x = 1; x < w - 1; x++) {
        var i = y * w + x;
        if (a[i] < 0.02 || a[i] > 0.98) continue;
        band++;
        var gx = a[i + 1] - a[i - 1], gy = a[i + w] - a[i - w];
        sum += Math.sqrt(gx * gx + gy * gy); n++;
      }
      return { bandPixels: band, bandRatio: band / (w * h), meanGrad: n ? sum / n : 0 };
    }
  };

  function waitIdle() {
    return new Promise(function (res) {
      (function poll() {
        if (!state.job && !state.analyzing) return res(state.result);
        setTimeout(poll, 60);
      })();
    });
  }
})();
