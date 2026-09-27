/* 主流程：上传 → 人脸检测 → 构图（可拖动）→ 抠图 → 磨皮 → 合成 → 合规 → 导出
   两层处理：实时预览层（最长边 600）+ 输出层（原分辨率，只在下载时跑） */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var SPECS = window.IDP.SPECS;
  var CATS = window.IDP.CATEGORIES;
  var D = window.IDP.SPEC_DEFAULTS;

  var PREVIEW_LONG = 600;      /* 实时预览层尺寸 */
  var DEBOUNCE_MS = 300;       /* 松手后重算延迟 */
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
    /* 构图 */
    zoom: 1, offsetX: 0, offsetY: 0, centerY: null,
    rect: null, dragging: false, viewMode: 'adjust',
    /* 结果 */
    engine: 'modnet',
    hasPhoto: false,
    matte: null, matteKey: '',
    previewBase: null, previewCanvas: null, previewMask: null,
    fullCanvas: null,
    metrics: null, results: [], overall: 'pass',
    exportInfo: null, gen: 0
  };

  var el = {};
  ['boot','bootStage','bootRows','bootErr','bootEnter','bootRetry',
   'app','display','uploadBox','pickBtn','shootBtn','fileInput','camInput','uploadNotice',
   'viewwrap','viewCanvas','viewHint','cropMeta','busyChip','busyText','viewMode','resetFit','peekBtn',
   'sumBar','sumIcon','sumText',
   'controls','specTabs','specScroll','specFade','specRow','specHint','customSpec','customUnit','cw','ch','applyCustom',
   'swatches','bgCustom','matteHint','intenSlider','intenOut','radiusSlider','radiusOut','mopiHint',
   'sizeChips','sizeHint','applyBgBtn','downloadBtn','resetBtn','exportNotice','progress','progressFill','progressText',
   'modal','modalClose','modalDownload','checks','checkNotice'
  ].forEach(function (id) { el[id] = document.getElementById(id); });

  /* ================= 轻提示（顶部横条已移除，不再遮挡预览） ================= */
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

  /* 处理阶段：有照片时走预览区内的「处理中…」角标，无照片时用轻提示 */
  function setStage(text) {
    if (state.hasPhoto) busy(!!text, text || undefined);
    else if (text) toast(text, 2000);
  }
  function setStageProgress() { /* 启动页与导出进度条各自负责，这里不再需要 */ }
  function notice(node, text, kind) {
    if (!text) { node.hidden = true; node.textContent = ''; return; }
    node.hidden = false; node.textContent = text;
    node.className = 'notice' + (kind ? ' is-' + kind : '');
  }
  function fail(err) {
    var msg = (err && err.message) || String(err);
    setStage(''); setStageProgress(null);
    notice(el.uploadNotice, msg, 'err');
    if (el.exportNotice) notice(el.exportNotice, msg, 'err');
  }
  function busy(on, text) {
    el.busyChip.hidden = !on;
    if (text) el.busyText.textContent = text;
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
      setStage('正在转换 HEIC 照片…', true);
      return heicToJpeg(file).then(function (b) {
        return loadImageEl(b).catch(function () { throw new Error('HEIC 转换失败，请改用 JPG / PNG'); });
      });
    }
    return loadImageEl(file).catch(function () { return heicToJpeg(file).then(loadImageEl); });
  }

  /* ================= 规格 ================= */
  function specFor() {
    var s = {};
    for (var k in state.spec) s[k] = state.spec[k];
    s.centerY = state.centerY == null ? (state.spec.centerY == null ? D.centerY : state.spec.centerY) : state.centerY;
    if (s.faceRatio == null) s.faceRatio = D.faceRatio;
    if (s.topMargin == null) s.topMargin = D.topMargin;
    return s;
  }
  function computeRect() {
    return window.IDP.Crop.computeCrop(state.face, state.master, specFor(), {
      zoom: state.zoom, offsetX: state.offsetX, offsetY: state.offsetY
    });
  }

  /* ================= 预览层 ================= */
  var previewTimer = 0, previewBusy = false, previewQueued = false, lastUpAt = 0;

  function schedulePreview(delay) {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(function () { runPreview(); }, delay == null ? DEBOUNCE_MS : delay);
  }

  function matteKey(rect, spec) {
    return [spec.width_px, spec.height_px, state.engine,
            Math.round(rect.x), Math.round(rect.y), Math.round(rect.w), Math.round(rect.h)].join(':');
  }

  function ensureMatte(base, key, onStage) {
    if (state.matte && state.matteKey === key) return Promise.resolve(state.matte);
    if (onStage) onStage('正在分离人像…');
    var needLoad = state.engine === 'modnet' && !window.IDP.BgRemove.isModnetReady();
    if (needLoad) { setStage('正在加载 MODNet 模型…', true); setStageProgress(0); }
    return window.IDP.BgRemove.segment(base, {
      engine: state.engine,
      onStage: function (t) { if (needLoad) setStage(t, true); },
      onProgress: function (p) { if (needLoad) setStageProgress(0.05 + p * 0.9); }
    }).then(function (r) {
      if (needLoad) { setStage('MODNet 就绪', false); setStageProgress(null); }
      state.matte = r.alpha;
      state.matteKey = key;
      if (r.engine !== state.engine) {
        state.engine = r.engine;
        updateMatteTag(r.modnetError);
      } else if (r.engine === 'modnet' && state.engine === 'modnet') {
        updateMatteTag();
      }
      return state.matte;
    });
  }

  function runPreview() {
    if (!state.master || !state.face) return Promise.resolve();
    if (previewBusy) { previewQueued = true; return Promise.resolve(); }
    if (lastUpAt) { state.lastDebounce = performance.now() - lastUpAt; lastUpAt = 0; }
    previewBusy = true;
    var spec = specFor();
    var rect = computeRect();
    state.rect = rect;
    state.metrics = window.IDP.Crop.faceMetrics(state.face, state.master, rect, spec);
    busy(true, '处理中…');
    var T = {}, tA = performance.now();
    return Promise.resolve()
      .then(function () {
        var base = window.IDP.Crop.renderCrop(state.master, rect, spec, PREVIEW_LONG);
        T.crop = performance.now() - tA; tA = performance.now();
        var key = matteKey(rect, spec);
        return ensureMatte(base, key).then(function () {
          T.segment = performance.now() - tA; tA = performance.now();
          state.previewBase = window.IDP.BgRemove.composite(base, state.matte, state.bg);
          T.composite = performance.now() - tA; tA = performance.now();
          state.previewMask = window.IDP.Crop.makeFaceMask(state.face, state.master, rect, spec, base.width, base.height);
          state.previewCanvas = window.IDP.Mopi.apply(state.previewBase, {
            intensity: state.intensity, radius: state.radius, mask: state.previewMask
          });
          T.mopi = performance.now() - tA; tA = performance.now();
          runCompliance(state.previewCanvas, state.metrics);
          T.total = T.crop + T.segment + T.composite + T.mopi;
          state.timings = T;
          drawView();
          updateMeta();
          state.gen++;
        });
      })
      .catch(fail)
      .then(function () {
        busy(false);
        previewBusy = false;
        if (previewQueued) { previewQueued = false; return runPreview(); }
        if (!state.fullCanvas) refreshExportInfo();
      });
  }

  /* ================= 全分辨率输出层 ================= */
  function runFull(onStage, onProgress) {
    var spec = specFor();
    var rect = state.rect || computeRect();
    var fullMatte = null;
    state.rect = rect;
    return Promise.resolve()
      .then(function () {
        onStage('正在按原分辨率裁剪…'); onProgress(0.06);
        var base = window.IDP.Crop.renderCrop(state.master, rect, spec, null);
        return { base: base, spec: spec, rect: rect };
      })
      .then(function (r) {
        if (state.engine === 'modnet' && !window.IDP.BgRemove.isModnetReady()) {
          onStage('正在加载 MODNet 模型…');
          return window.IDP.BgRemove.ensureModnet(onStage, function (p) {
            onProgress(0.08 + p * 0.32);
          }).then(function () { return r; });
        }
        return r;
      })
      .then(function (r) {
        onStage('正在分离人像…'); onProgress(0.44);
        return window.IDP.BgRemove.segment(r.base, { engine: state.engine }).then(function (m) {
          state.engine = m.engine;
          fullMatte = m.alpha;
          return r;
        });
      })
      .then(function (r) {
        onStage('正在合成背景与磨皮…'); onProgress(0.72);
        var composed = window.IDP.BgRemove.composite(r.base, fullMatte, state.bg);
        var mask = window.IDP.Crop.makeFaceMask(state.face, state.master, r.rect, r.spec, r.base.width, r.base.height);
        var final = window.IDP.Mopi.apply(composed, { intensity: state.intensity, radius: state.radius, mask: mask });
        onProgress(0.9);
        state.metrics = window.IDP.Crop.faceMetrics(state.face, state.master, r.rect, r.spec, r.base.width, r.base.height);
        return final;
      })
      .then(function (final) {
        state.fullCanvas = final;
        onStage('正在做合规检测…');
        runCompliance(final, state.metrics, fullMatte);
        onProgress(1);
        return final;
      });
  }

  /* ================= 视图绘制 ================= */
  function drawView() {
    var wrap = el.viewwrap, vc = el.viewCanvas;
    var W = wrap.clientWidth, H = wrap.clientHeight;
    if (!W || !H) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (vc.width !== Math.round(W * dpr) || vc.height !== Math.round(H * dpr)) {
      vc.width = Math.round(W * dpr); vc.height = Math.round(H * dpr);
    }
    var ctx = vc.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!state.master) return;

    if (state.viewMode === 'result') {
      var c = state.previewCanvas;
      if (!c) return;
      var s0 = Math.min(W / c.width, H / c.height);
      var dw0 = c.width * s0, dh0 = c.height * s0;
      ctx.drawImage(c, (W - dw0) / 2, (H - dh0) / 2, dw0, dh0);
      state._viewScale = s0; state._viewOrigin = [(W - dw0) / 2, (H - dh0) / 2, true];
      return;
    }

    var m = state.master;
    var r = state.rect;
    /* 适配范围 = 原图 ∪ 裁剪框，保证取景框永远完整可见；
       拖动时锁定缩放，避免画面跟着取景框一起缩放 */
    if (!state.dragging || !state._fit) {
      var bx0 = 0, by0 = 0, bx1 = m.width, by1 = m.height;
      if (r) {
        bx0 = Math.min(bx0, r.x); by0 = Math.min(by0, r.y);
        bx1 = Math.max(bx1, r.x + r.w); by1 = Math.max(by1, r.y + r.h);
      }
      var pad = 0.03;
      var bw = (bx1 - bx0) * (1 + pad * 2), bh = (by1 - by0) * (1 + pad * 2);
      state._fit = { x0: bx0 - (bx1 - bx0) * pad, y0: by0 - (by1 - by0) * pad, w: bw, h: bh };
    }
    var fit = state._fit;
    var s = Math.min(W / fit.w, H / fit.h);
    var ox = (W - fit.w * s) / 2 - fit.x0 * s;
    var oy = (H - fit.h * s) / 2 - fit.y0 * s;
    state._viewScale = s;

    ctx.drawImage(m, ox, oy, m.width * s, m.height * s);

    if (!r) return;
    var rx = ox + r.x * s, ry = oy + r.y * s, rw = r.w * s, rh = r.h * s;
    state._frame = { x: rx, y: ry, w: rw, h: rh };

      if (!state.dragging && state.previewCanvas) {
        ctx.save();
        ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip();
        ctx.drawImage(state.previewCanvas, rx, ry, rw, rh);
        ctx.restore();
      } else {
        /* 拖动中：框内直接用原图垫底，避免露出画布底色 */
        ctx.save();
        ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip();
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(rx, ry, rw, rh);
        ctx.drawImage(m, ox, oy, m.width * s, m.height * s);
        ctx.restore();
      }

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
    if (!r) return;
    el.cropMeta.textContent = sp.width_px + '×' + sp.height_px + 'px' +
      ' · 头顶留白 ' + (r.topMargin * 100).toFixed(1) + '%' +
      ' · 下巴 ' + (r.chinMargin * 100).toFixed(0) + '%';
  }

  function updateMatteTag(err) {
    var hd = state.engine === 'modnet';
    el.matteHint.textContent = hd
      ? '已启用 MODNet 高精度抠图（模型已缓存，发丝过渡更自然）。'
      : (err ? 'MODNet 加载失败，已自动降级为标准抠图：' + err
             : 'MODNet 约 6.6MB，首次点击才下载，之后浏览器自动缓存。');
  }

  function invalidateMatte() { state.matte = null; state.matteKey = ''; state.fullCanvas = null; }
  function invalidateFull() { state.fullCanvas = null; }

  /* ================= 合规 ================= */
  var ICONS = {
    pass: '<svg class="ck-icon" viewBox="0 0 24 24" fill="none" stroke="#34C759" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg>',
    warn: '<svg class="ck-icon" viewBox="0 0 24 24" fill="none" stroke="#FF9500" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.6l9 15.4H3z"/><path d="M12 9.5v4.2"/><circle cx="12" cy="16.6" r="0.9" fill="#FF9500" stroke="none"/></svg>',
    fail: '<svg class="ck-icon" viewBox="0 0 24 24" fill="none" stroke="#FF3B30" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>'
  };
  var LV_TEXT = { pass: '检测通过，可正常下载', warn: '检测有提醒项，仍可下载', fail: '检测未通过，请先修正' };

  function runCompliance(canvas, metrics, matte) {
    if (!canvas) return;
    state.results = window.IDP.Compliance.check(canvas, metrics, {
      intensity: state.intensity,
      bgRgb: window.IDP.BgRemove.hexToRgb(state.bg),
      alpha: matte || state.matte
    });
    state.overall = window.IDP.Compliance.overall(state.results);

    el.checks.innerHTML = state.results.map(function (r) {
      return '<li class="lv-' + r.level + '">' + ICONS[r.level] +
        '<div class="ck-body"><div class="ck-name">' + r.name + '</div>' +
        '<div class="ck-text">' + r.text + '</div></div></li>';
    }).join('');

    /* 概要行：全通过 / N 项警告 / N 项不通过 */
    var nWarn = 0, nFail = 0;
    state.results.forEach(function (r) {
      if (r.level === 'warn') nWarn++;
      else if (r.level === 'fail') nFail++;
    });
    el.sumBar.className = 'sumbar lv-' + state.overall;
    el.sumIcon.innerHTML = ICONS[state.overall];
    el.sumText.textContent = nFail ? (nFail + ' 项不通过') : (nWarn ? (nWarn + ' 项警告') : '符合规范');
    el.sumBar.hidden = !state.hasPhoto;

    var can = state.overall !== 'fail';
    el.downloadBtn.disabled = !can;
    el.modalDownload.disabled = !can;
    if (can) {
      notice(el.checkNotice, state.overall === 'warn'
        ? '有提醒项，仍可下载；如需通过官方验证建议先按提示调整。' : '', state.overall === 'warn' ? 'warn' : '');
    } else {
      el.checkNotice.hidden = false;
      el.checkNotice.className = 'notice is-err';
      el.checkNotice.innerHTML = '检测未通过，下载已停用，请先按提示修正。' +
        ' <button type="button" class="btn btn-ghost btn-sm" id="forceDl" style="min-height:28px;padding:0 10px;font-size:13px;margin-left:6px">仍要下载</button>';
      var f = document.getElementById('forceDl');
      if (f) f.addEventListener('click', function () { closeModal(); doDownload(true); });
    }
  }

  /* ---------- 校验详情浮层 ---------- */
  function openModal() { if (state.hasPhoto) el.modal.hidden = false; }
  function closeModal() { el.modal.hidden = true; }

  /* ================= 导出 ================= */
  var exportTimer = 0;
  function refreshExportInfo() {
    clearTimeout(exportTimer);
    exportTimer = setTimeout(function () {
      var cv = state.fullCanvas || state.previewCanvas;
      if (!cv) return;
      window.IDP.Export.encode(cv, state.target).then(function (info) {
        state.exportInfo = info;
        var t = info.target;
        var msg = (state.fullCanvas ? '' : '按预览估算：') + '当前导出约 ' + info.kb.toFixed(1) + ' KB（质量 ' + info.quality.toFixed(2) + '）';
        if (t.max !== Infinity) msg += '，目标 ' + t.min + '–' + t.max + ' KB';
        var kind = 'ok';
        if (!info.ok && info.reason === 'over') { msg += ' —— 已压到最低质量仍超出，可直接下载但不满足目标'; kind = 'err'; }
        if (!info.ok && info.reason === 'under') { msg += ' —— 低于目标下限，官方系统可能拒收小文件'; kind = 'warn'; }
        notice(el.exportNotice, msg, kind);
      }).catch(function () { });
    }, 320);
  }

  function doDownload(force) {
    if (state.overall === 'fail' && !force) return;
    el.downloadBtn.disabled = true;
    el.progress.hidden = false;
    el.progressFill.style.width = '2%';
    el.progressText.textContent = '准备中…';
    setStage('正在生成原分辨率图片…', true);
    runFull(function (text) { el.progressText.textContent = text; },
            function (p) { el.progressFill.style.width = Math.round(p * 100) + '%'; })
      .then(function () {
        el.progressText.textContent = '正在编码 JPEG…';
        return window.IDP.Export.encode(state.fullCanvas, state.target);
      })
      .then(function (info) {
        window.IDP.Export.download(info.blob, window.IDP.Export.fileName(state.spec.id));
        state.exportInfo = info;
        el.progressFill.style.width = '100%';
        el.progressText.textContent = '完成 · ' + info.kb.toFixed(1) + ' KB';
        setStage(''); setStageProgress(null);
        setTimeout(function () { el.progress.hidden = true; }, 1600);
        el.downloadBtn.disabled = state.overall === 'fail';
        refreshExportInfo();
      })
      .catch(function (e) {
        el.progress.hidden = true;
        el.downloadBtn.disabled = state.overall === 'fail';
        setStage(''); setStageProgress(null);
        fail(e);
      });
  }

  /* ================= 上传 ================= */
  function handleFile(file) {
    notice(el.uploadNotice, '');
    setStage('正在读取照片…', true);
    readFile(file).then(function (img) {
      if (!img) return;
      if (img.naturalWidth * img.naturalHeight > 1e8) throw new Error('照片分辨率过高（超过 1 亿像素），请先缩小');
      state.fileName = file.name || '';
      state.master = window.IDP.Crop.loadMaster(img);
      invalidateMatte();
      resetComposition();
      setStage('正在检测人脸…', true);
      return window.IDP.FaceDetect.analyze(state.master);
    }).then(function (face) {
      if (face === null) {
        setStage('');
        notice(el.uploadNotice, '没有检测到清晰的正脸。请换一张正面免冠、光线均匀、人脸清晰的照片。', 'err');
        return;
      }
      if (!face) return;
      state.face = face;
      state.hasPhoto = true;
      gotoState('photo');
      setStage('正在处理…');
      requestAnimationFrame(function () { drawView(); schedulePreview(0); });
    }).catch(fail);
  }

  /* ---------- 三态：未上传 / 已上传 / 重新上传 ---------- */
  function bgName(hex) {
    var hit = window.IDP.BG_COLORS.filter(function (c) { return c.hex.toLowerCase() === String(hex).toLowerCase(); })[0];
    return hit ? hit.name : '自定义';
  }

  function gotoState(next) {
    if (next === 'idle') {
      state.hasPhoto = false;
      state.master = null; state.face = null;
      state.previewCanvas = null; state.previewBase = null; state.previewMask = null;
      state.fullCanvas = null; state.metrics = null;
      state.results = []; state.overall = 'pass';
      invalidateMatte();
      el.uploadBox.hidden = false;
      el.viewwrap.hidden = true;
      el.cropMeta.hidden = true;
      el.sumBar.hidden = true;
      el.controls.classList.add('locked');
      el.resetBtn.hidden = true;
      el.progress.hidden = true;
      closeModal();
      notice(el.uploadNotice, ''); notice(el.exportNotice, ''); notice(el.checkNotice, '');
      el.fileInput.value = ''; el.camInput.value = '';
      el.controls.scrollTop = 0;
    } else {
      el.uploadBox.hidden = true;
      el.viewwrap.hidden = false;
      el.cropMeta.hidden = false;
      el.sumBar.hidden = false;
      el.controls.classList.remove('locked');
      el.resetBtn.hidden = false;
      el.controls.scrollTop = 0;
      state._fit = null;
      requestAnimationFrame(function () { drawView(); });
    }
    updateSpecFade();
  }

  /* 规格卡片横向滚动提示：可滑时右侧出渐变 + 箭头 */
  function updateSpecFade() {
    if (!el.specScroll || !el.specRow) return;
    var more = el.specRow.scrollWidth - el.specRow.clientWidth - el.specRow.scrollLeft > 4;
    el.specScroll.classList.toggle('can-scroll', more);
  }

  function resetComposition() {
    state.zoom = 1; state.offsetX = 0; state.offsetY = 0;
    state.centerY = state.spec.centerY == null ? D.centerY : state.spec.centerY;
    state.viewMode = 'adjust';
    Array.prototype.forEach.call(el.viewMode.children, function (b) {
      b.classList.toggle('is-on', b.dataset.mode === 'adjust');
    });
    state._fit = null;
  }

  function setViewMode(mode) {
    state.viewMode = mode;
    Array.prototype.forEach.call(el.viewMode.children, function (b) {
      b.classList.toggle('is-on', b.dataset.mode === mode);
    });
    drawView();
  }

  /* ================= 拖动调参 ================= */
  function bindDrag() {
    var wrap = el.viewwrap;
    var pointers = {}, start = null, pinchStart = null;

    function localPos(e) {
      var r = wrap.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    function ids() { return Object.keys(pointers); }

    wrap.addEventListener('pointerdown', function (e) {
      if (!state.master) return;
      /* 指针可能已失效（合成事件 / 已被释放），失败不影响拖动 */
      try { wrap.setPointerCapture(e.pointerId); } catch (err) { }
      pointers[e.pointerId] = localPos(e);
      if (ids().length === 1) {
        start = { p: localPos(e), o: { x: state.offsetX, y: state.offsetY } };
        state.dragging = true;
        wrap.classList.add('dragging');
        if (state.viewMode !== 'adjust') setViewMode('adjust');
        clearTimeout(previewTimer);
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
          state.rect = computeRect(); invalidateFull(); drawView(); updateMeta();
        }
        return;
      }
      if (!start || !state.rect) return;
      var s = state._viewScale || 1;
      var dx = (localPos(e).x - start.p.x) / s;
      var dy = (localPos(e).y - start.p.y) / s;
      state.offsetX = start.o.x + dx / state.rect.w;
      state.offsetY = start.o.y + dy / state.rect.h;
      state.rect = computeRect();     /* 纯数学，零延迟 */
      invalidateFull();
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
        lastUpAt = performance.now();   /* 量 debounce 用 */
        invalidateFull();
        wrap.classList.remove('dragging');
        schedulePreview(DEBOUNCE_MS);
        drawView();
      }
    }
    wrap.addEventListener('pointerup', endPointer);
    wrap.addEventListener('pointercancel', endPointer);
    wrap.addEventListener('lostpointercapture', endPointer);

    wrap.addEventListener('wheel', function (e) {
      if (!state.master) return;
      e.preventDefault();
      state.zoom = clamp(state.zoom * (1 - e.deltaY * 0.0012), 0.5, 1.3);
      state.rect = computeRect();
      invalidateFull();
      updateMeta(); drawView();
      schedulePreview(DEBOUNCE_MS);
    }, { passive: false });
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

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
      el.specHint.textContent = '输入任意尺寸，毫米按 300 DPI 换算；构图用默认参数（faceRatio 0.65 / centerY 0.42 / 头顶留白 0.05）。';
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
      ? (cur.note || '') + '　构图：人脸 ' + (cur.faceRatio * 100).toFixed(0) + '% / 居中 ' + cur.centerY + ' / 头顶留白 ' + (cur.topMargin * 100).toFixed(0) + '%'
      : '';
  }

  function selectSpec(s) {
    state.spec = s;
    if (s.bg_color) setBg(s.bg_color, true);
    resetComposition();
    renderSpecRow();
    invalidateFull();
    if (state.face) { state.rect = computeRect(); drawView(); updateMeta(); schedulePreview(0); }
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
    state.fullCanvas = null;
    if (!silent && state.face) schedulePreview(0);
  }

  /* ================= 控件绑定 ================= */
  function bindControls() {
    el.intenSlider.addEventListener('input', function () {
      state.intensity = (+this.value) / 100;
      el.intenOut.textContent = this.value + '%';
      el.mopiHint.textContent = state.intensity * 100 > 28
        ? '已接近上限（' + this.value + '%），建议不超过 28%'
        : '只作用于人脸区域，上限 30%';
      state.fullCanvas = null;
      if (state.previewBase && state.previewMask) {
        state.previewCanvas = window.IDP.Mopi.apply(state.previewBase, {
          intensity: state.intensity, radius: state.radius, mask: state.previewMask
        });
        runCompliance(state.previewCanvas, state.metrics);
        drawView();
      }
      refreshExportInfo();
    });
    el.radiusSlider.addEventListener('input', function () {
      state.radius = +this.value;
      el.radiusOut.textContent = this.value + 'px';
      state.fullCanvas = null;
      if (state.previewBase && state.previewMask) {
        state.previewCanvas = window.IDP.Mopi.apply(state.previewBase, {
          intensity: state.intensity, radius: state.radius, mask: state.previewMask
        });
        runCompliance(state.previewCanvas, state.metrics);
        drawView();
      }
    });
    if (el.ratioSlider) el.ratioSlider.addEventListener('input', function () {
      state.zoom = clamp((+this.value) / 100, 0.5, 1.3);
      el.ratioOut.textContent = this.value + '%';
      invalidateFull();
      if (state.face) { state.rect = computeRect(); updateMeta(); drawView(); schedulePreview(DEBOUNCE_MS); }
    });
    if (el.posSlider) el.posSlider.addEventListener('input', function () {
      state.centerY = (+this.value) / 100;
      el.posOut.textContent = state.centerY.toFixed(2);
      invalidateFull();
      if (state.face) { state.rect = computeRect(); updateMeta(); drawView(); schedulePreview(DEBOUNCE_MS); }
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-nudge]'), function (b) {
      b.addEventListener('click', function () {
        var d = b.dataset.nudge.split(',');
        state.offsetX = clamp(state.offsetX + parseFloat(d[0]), -0.4, 0.4);
        state.offsetY = clamp(state.offsetY + parseFloat(d[1]), -0.4, 0.4);
        invalidateFull();
        if (state.face) { state.rect = computeRect(); updateMeta(); drawView(); schedulePreview(120); }
      });
    });
    if (el.nudgeReset) el.nudgeReset.addEventListener('click', function () {
      state.offsetX = 0; state.offsetY = 0;
      invalidateFull();
      if (state.face) { state.rect = computeRect(); updateMeta(); drawView(); schedulePreview(120); }
    });
    el.resetFit.addEventListener('click', function () {
      resetComposition(); invalidateFull();
      if (state.face) { state.rect = computeRect(); drawView(); updateMeta(); schedulePreview(120); }
    });
    el.bgCustom.addEventListener('input', function () { setBg(this.value); });

    if (el.hdMatteBtn) el.hdMatteBtn.addEventListener('click', function () {
      if (state.engine === 'modnet') { setStage('已在使用 MODNet 高精度抠图'); return; }
      setStage('正在加载 MODNet…', true);
      setStageProgress(0);
      window.IDP.BgRemove.ensureModnet(function (t) { setStage(t, true); },
        function (p) { setStageProgress(0.05 + p * 0.9); })
        .then(function () {
          state.engine = 'modnet';
          invalidateMatte(); updateMatteTag();
          setStage('MODNet 就绪', false); setStageProgress(null);
          schedulePreview(0);
        })
        .catch(function (e) {
          state.engine = 'fallback';
          setStageProgress(null); setStage('');
          updateMatteTag(e.message);
          notice(el.uploadNotice, e.message, 'warn');
        });
    });

    /* 视图模式 */
    Array.prototype.forEach.call(el.viewMode.children, function (b) {
      b.addEventListener('click', function () { setViewMode(b.dataset.mode); });
    });

    /* 更多 */
    if (el.moreToggle) el.moreToggle.addEventListener('click', function () {
      var open = el.moreBody.hidden;
      el.moreBody.hidden = !open;
      el.moreToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (window.innerWidth < 768) {
        el.studio.classList.toggle('sheet-full', true);
        el.studio.classList.remove('sheet-half', 'sheet-peek');
      }
    });

    /* 自定义规格 */
    Array.prototype.forEach.call(el.customUnit.children, function (b) {
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(el.customUnit.children, function (x) { x.classList.remove('is-on'); });
        b.classList.add('is-on');
        state.customUnit = b.dataset.unit;
      });
    });
    el.applyCustom.addEventListener('click', function () {
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
      invalidateMatte();
      if (state.face) { state.rect = computeRect(); drawView(); updateMeta(); schedulePreview(0); }
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

    /* 按住对比原图 */
    function peek(on) {
      if (!state.previewBase || !state.previewCanvas) return;
      var canvas = on ? state.previewBase : state.previewCanvas;
      var tmp = document.createElement('canvas');
      tmp.width = canvas.width; tmp.height = canvas.height;
      tmp.getContext('2d').drawImage(canvas, 0, 0);
      el.viewHint.textContent = on ? '正在显示：未磨皮原图' : '拖动移动取景框 · 滚轮 / 双指缩放';
      var ctx = el.viewCanvas.getContext('2d');
      var W = el.viewwrap.clientWidth, H = el.viewwrap.clientHeight;
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      var s = Math.min(W / tmp.width, H / tmp.height);
      ctx.drawImage(tmp, (W - tmp.width * s) / 2, (H - tmp.height * s) / 2, tmp.width * s, tmp.height * s);
    }
    ['pointerdown', 'touchstart', 'mousedown'].forEach(function (ev) {
      el.peekBtn.addEventListener(ev, function (e) { e.preventDefault(); peek(true); });
    });
    ['pointerup', 'pointerleave', 'touchend', 'touchcancel', 'mouseup', 'mouseleave'].forEach(function (ev) {
      el.peekBtn.addEventListener(ev, function () { peek(false); });
    });

    /* 手机端抽屉 */
    var gripStart = null;
    if (el.grip) el.grip.addEventListener('pointerdown', function (e) {
      gripStart = e.clientY; el.grip.setPointerCapture(e.pointerId);
    });
    if (el.grip) el.grip.addEventListener('pointerup', function (e) {
      if (gripStart == null) return;
      var dy = e.clientY - gripStart;
      gripStart = null;
      var cur = el.studio.classList.contains('sheet-full') ? 2
              : el.studio.classList.contains('sheet-peek') ? 0 : 1;
      var next = cur;
      if (dy < -30) next = Math.min(2, cur + 1);
      else if (dy > 30) next = Math.max(0, cur - 1);
      else next = cur === 2 ? 1 : 2;
      el.studio.classList.toggle('sheet-full', next === 2);
      el.studio.classList.toggle('sheet-half', next === 1);
      el.studio.classList.toggle('sheet-peek', next === 0);
      document.body.classList.toggle('sheet-open', next !== 0);
      setTimeout(drawView, 280);
    });

    window.addEventListener('resize', function () { drawView(); updateSpecFade(); });
    window.addEventListener('orientationchange', function () { setTimeout(function () { drawView(); updateSpecFade(); }, 260); });
    /* 容器尺寸变化（含窗口缩放）时重设画布，避免拉伸 */
    if (window.ResizeObserver) new ResizeObserver(function () { drawView(); }).observe(el.viewwrap);

    /* 校验概要 → 详情浮层 */
    el.sumBar.addEventListener('click', openModal);
    el.modalClose.addEventListener('click', closeModal);
    el.modal.addEventListener('click', function (e) {
      if (e.target.closest('[data-close]')) closeModal();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });
    el.modalDownload.addEventListener('click', function () { closeModal(); doDownload(false); });

    /* 换背景：把当前选中的底色显式应用一次并给反馈 */
    el.applyBgBtn.addEventListener('click', function () {
      if (!state.hasPhoto) return;
      state.fullCanvas = null;
      schedulePreview(0);
      toast('已应用' + bgName(state.bg) + '背景');
    });

    /* 未上传时点操作区任意位置 → 提示先上传照片 */
    el.controls.addEventListener('click', function (e) {
      if (state.hasPhoto) return;
      e.preventDefault(); e.stopPropagation();
      toast('请先上传照片');
    }, true);

    /* 规格卡片横向滚动提示 */
    el.specRow.addEventListener('scroll', updateSpecFade, { passive: true });
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

  /* ---------- 启动页：每次访问都显示；两个模型并行下载 + 实时进度 + 最短 1 秒 ---------- */
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

    function fail(e) {
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
        /* 最短显示 1 秒；就绪后再给 1.4s 让用户看到「进入」按钮，不点也会自动进 */
        var wait = Math.max(0, 1000 - (Date.now() - t0));
        setTimeout(enter, wait + 1400);
      }).catch(fail);
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
  window.IDPDebug = {
    ready: function () { return !!(state.master && state.face && state.previewCanvas); },
    state: function () {
      return {
        spec: state.spec.id, w: state.spec.width_px, h: state.spec.height_px,
        bg: state.bg, intensity: state.intensity, radius: state.radius, target: state.target,
        overall: state.overall, results: state.results,
        rect: state.rect, metrics: state.metrics,
        zoom: state.zoom, offsetX: state.offsetX, offsetY: state.offsetY,
        centerY: state.centerY, faceRatio: specFor().faceRatio, topMargin: specFor().topMargin,
        engine: state.engine, viewMode: state.viewMode, dragging: state.dragging,
        booted: state.booted, hasPhoto: state.hasPhoto,
        bootHidden: !!document.getElementById('boot').hidden,
        uploadBoxVisible: !document.getElementById('uploadBox').hidden,
        viewVisible: !document.getElementById('viewwrap').hidden,
        controlsLocked: document.getElementById('controls').classList.contains('locked'),
        webgl: window.IDP.Mopi.isWebGL(), faceCount: state.face ? state.face.count : 0,
        previewSize: state.previewCanvas ? [state.previewCanvas.width, state.previewCanvas.height] : null,
        fullSize: state.fullCanvas ? [state.fullCanvas.width, state.fullCanvas.height] : null,
        gen: state.gen, modnetReady: window.IDP.BgRemove.isModnetReady(),
        busy: previewBusy, timings: state.timings, lastDebounce: state.lastDebounce
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
    /* 构图体检：逐个规格算裁剪框（不跑抠图，纯几何），用于验证「头不出框 + 人脸占比」 */
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
          headTopOut: +m.top.toFixed(2), chinOut: +m.bottom.toFixed(2)
        });
      }
      state.spec = save.spec; state.zoom = save.zoom;
      state.offsetX = save.ox; state.offsetY = save.oy; state.centerY = save.cy;
      return out;
    },
    attachFile: function (file) { return handleFile(file); },
    setSpecById: function (id) {
      var s = SPECS.filter(function (x) { return x.id === id; })[0];
      if (!s) throw new Error('unknown spec ' + id);
      selectSpec(s);
    },
    setBg: function (hex) { setBg(hex); },
    setIntensity: function (v) {
      state.intensity = v; el.intenSlider.value = Math.round(v * 100);
      el.intenOut.textContent = Math.round(v * 100) + '%';
      state.fullCanvas = null;
      if (state.previewBase && state.previewMask) {
        state.previewCanvas = window.IDP.Mopi.apply(state.previewBase, {
          intensity: state.intensity, radius: state.radius, mask: state.previewMask
        });
        runCompliance(state.previewCanvas, state.metrics); drawView();
      }
    },
    setRadius: function (v) { state.radius = v; el.radiusSlider.value = v; el.radiusOut.textContent = v + 'px'; state.fullCanvas = null; },
    setTarget: function (id) { state.target = id; refreshExportInfo(); },
    setComposition: function (o) {
      if (o.zoom != null) state.zoom = o.zoom;
      if (o.offsetX != null) state.offsetX = o.offsetX;
      if (o.offsetY != null) state.offsetY = o.offsetY;
      if (o.centerY != null) state.centerY = o.centerY;
      invalidateFull();
      if (state.face) { state.rect = computeRect(); updateMeta(); drawView(); schedulePreview(0); }
      return state.rect;
    },
    setEngine: function (e) { state.engine = e; invalidateMatte(); updateMatteTag(); schedulePreview(0); },
    ensureModnet: function () {
      return window.IDP.BgRemove.ensureModnet(function () { }, function () { });
    },
    setViewMode: setViewMode,
    /* 拖动模拟：直接喂 view 坐标增量，等价于真实 pointer 事件 */
    viewRect: function () { return el.viewwrap.getBoundingClientRect(); },
    viewScale: function () { return state._viewScale; },
    runFull: function () { return runFull(function () { }, function () { }); },
    runPreviewNow: function () { return runPreview(); },
    gotoState: gotoState,
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
      var cv = state.fullCanvas || state.previewCanvas;
      return window.IDP.Export.encode(cv, state.target);
    },
    pngUrl: function (which) {
      var c = which === 'full' ? state.fullCanvas
            : which === 'preview' ? state.previewCanvas
            : which === 'pre' ? state.previewBase
            : which === 'mask' ? state.previewMask : null;
      return c ? c.toDataURL('image/png') : null;
    },
    alphaStats: function () {
      if (!state.matte) return null;
      var a = state.matte, n = 0, soft = 0;
      for (var i = 0; i < a.length; i++) { if (a[i] > 0.5) n++; if (a[i] > 0.05 && a[i] < 0.95) soft++; }
      return { len: a.length, fgRatio: n / a.length, softRatio: soft / a.length };
    },
    /* 发丝边缘锐度：过渡带梯度均值，越大越"硬"，越小越自然 */
    edgeProfile: function () {
      if (!state.matte) return null;
      var cv = state.previewBase || state.previewMask;
      var w = cv ? cv.width : 0, h = cv ? cv.height : 0;
      if (!w) return null;
      var a = state.matte, band = 0, sum = 0, n = 0;
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
})();
