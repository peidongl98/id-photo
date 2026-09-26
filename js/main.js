/* 主流程：上传 → 人脸检测 → 裁剪 → 抠图 → 磨皮 → 合成 → 合规 → 导出 */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var SPECS = window.IDP.SPECS;
  var CATS = window.IDP.CATEGORIES;

  var MAX_KB_CANVAS = 16000000;
  var HEIC_CDNS = [
    'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js',
    'https://unpkg.com/heic2any@0.0.4/dist/heic2any.min.js'
  ];

  var state = {
    master: null,
    face: null,
    fileName: '',
    cat: CATS[0],
    spec: SPECS[0],
    bg: SPECS[0].bg_color,
    intensity: 0.22,
    radius: 3,
    faceRatio: 0.62,
    facePos: 0.45,
    offsetX: 0,
    offsetY: 0,
    target: 'none',
    customUnit: 'mm',
    rect: null,
    cropBase: null,
    preMop: null,
    finalCanvas: null,
    maskCanvas: null,
    maskKey: '',
    seg: null,
    metrics: null,
    results: [],
    overall: 'pass',
    exportInfo: null,
    gen: 0
  };

  var el = {};
  ['stage','stageText','uploadCard','uploadNotice','workspace','drop','pickBtn','shootBtn','fileInput','camInput',
   'origCanvas','resultCanvas','resultBox','origBox','resultCap','peekBtn','dimMeta','checks','checkNotice',
   'downloadBtn','resetBtn','exportNotice','specTabs','specRow','specHint','customSpec','customUnit',
   'cw','ch','applyCustom','swatches','bgCustom','intenSlider','intenOut','radiusSlider','radiusOut','mopiHint',
   'ratioSlider','ratioOut','posSlider','posOut','nudgeReset','sizeChips','sizeHint','compare'
  ].forEach(function (id) { el[id] = document.getElementById(id); });

  /* ================= 阶段提示 ================= */
  var stageTimer = 0;
  function setStage(text, sticky) {
    if (text) {
      el.stageText.textContent = text;
      el.stage.hidden = false;
      clearTimeout(stageTimer);
      if (!sticky) stageTimer = setTimeout(function () { el.stage.hidden = true; }, 3500);
    } else {
      el.stage.hidden = true;
    }
  }

  function notice(node, text, kind) {
    if (!text) { node.hidden = true; node.textContent = ''; return; }
    node.hidden = false;
    node.textContent = text;
    node.className = 'notice' + (kind ? ' is-' + kind : '');
  }

  function fail(err) {
    var msg = (err && err.message) || String(err);
    setStage('');
    notice(el.uploadNotice, msg, 'err');
    if (el.exportNotice) notice(el.exportNotice, msg, 'err');
  }

  /* ================= 图片读取 ================= */
  function isHeic(file) {
    return /^image\/hei[cf]$/i.test(file.type) || /\.hei[cf]$/i.test(file.name || '');
  }

  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { res(); };
      s.onerror = function () { rej(new Error('脚本加载失败：' + src)); };
      document.head.appendChild(s);
    });
  }

  function heicToJpeg(file) {
    function convert() {
      return window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.95 })
        .then(function (out) { return Array.isArray(out) ? out[0] : out; });
    }
    if (window.heic2any) return convert();
    var chain = Promise.reject();
    HEIC_CDNS.forEach(function (url) {
      chain = chain.catch(function () {
        return loadScript(url).then(function () {
          if (!window.heic2any) throw new Error('no heic2any');
        });
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
    if (!/^image\//i.test(file.type) && !isHeic(file)) {
      return Promise.reject(new Error('只支持 JPG / PNG / HEIC 图片'));
    }
    if (file.size > 40 * 1024 * 1024) {
      return Promise.reject(new Error('图片太大（超过 40MB），请先压缩'));
    }
    if (isHeic(file)) {
      setStage('正在转换 HEIC 照片…', true);
      return heicToJpeg(file).then(function (blob) {
        return loadImageEl(blob).catch(function () {
          throw new Error('HEIC 转换失败，请改用 JPG / PNG');
        });
      });
    }
    return loadImageEl(file).catch(function () {
      return heicToJpeg(file).then(loadImageEl);
    });
  }

  /* ================= 渲染调度 ================= */
  var busy = false, queued = null;

  function requestRender(mode) {
    queued = mode || 'all';
    pump();
  }

  function pump() {
    if (busy || !queued) return;
    var mode = queued; queued = null;
    busy = true;
    Promise.resolve(doRender(mode)).catch(fail).then(function () {
      busy = false;
      if (queued) pump();
      else if (mode === 'all') refreshExportInfo();
    });
  }

  function doRender(mode) {
    return Promise.resolve().then(function () {
      if (!state.master || !state.face) return;
      var spec = state.spec;
      setStage(mode === 'all' ? '正在处理…' : '正在更新预览…', true);
      if (mode === 'all') {
        state.rect = window.IDP.Crop.computeCrop(state.face, state.master, spec, state);
        state.cropBase = window.IDP.Crop.renderCrop(state.master, state.rect, spec);
        state.metrics = window.IDP.Crop.faceMetrics(state.face, state.master, state.rect, spec);
        var key = [spec.id, spec.width_px, spec.height_px,
                   Math.round(state.rect.x), Math.round(state.rect.y),
                   Math.round(state.rect.w), Math.round(state.rect.h)].join(':');
        if (!state.seg || state.seg.key !== key) {
          return window.IDP.BgRemove.ensure().then(function () {
            setStage('正在分离人物与背景…', true);
            return window.IDP.BgRemove.segment(state.cropBase);
          }).then(function (s) {
            state.seg = { alpha: s.alpha, w: s.w, h: s.h, key: key };
            finishRender(mode);
          });
        }
      }
      finishRender(mode);
    });
  }

  function finishRender(mode) {
    if (mode === 'all' || mode === 'compose') {
      state.preMop = window.IDP.BgRemove.composite(state.cropBase, state.seg.alpha, state.bg);
    }
    var spec = state.spec;
    var maskKey = [state.seg.key, spec.width_px, spec.height_px,
                   Math.round(state.metrics.cx), Math.round(state.metrics.cy),
                   Math.round(state.metrics.rx), Math.round(state.metrics.ry)].join('|');
    if (state.maskKey !== maskKey) {
      state.maskCanvas = window.IDP.Crop.makeFaceMask(state.face, state.master, state.rect, spec);
      state.maskKey = maskKey;
    }
    state.finalCanvas = window.IDP.Mopi.apply(state.preMop, {
      intensity: state.intensity,
      radius: state.radius,
      mask: state.maskCanvas
    });
    paint();
    runCompliance();
    if (mode === 'all') state.gen++;
    setStage('');
  }

  function paint() {
    draw(el.origCanvas, state.cropBase);
    draw(el.resultCanvas, state.finalCanvas);
    el.resultCap.textContent = '处理结果';
  }

  function draw(canvas, src) {
    if (!src) return;
    canvas.width = src.width;
    canvas.height = src.height;
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(src, 0, 0);
  }

  /* ================= 合规检测 ================= */
  var ICONS = {
    pass: '<svg class="ck-icon" viewBox="0 0 24 24" fill="none" stroke="#34C759" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg>',
    warn: '<svg class="ck-icon" viewBox="0 0 24 24" fill="none" stroke="#FF9500" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.6l9 15.4H3z"/><path d="M12 9.5v4.2"/><circle cx="12" cy="16.6" r="0.9" fill="#FF9500" stroke="none"/></svg>',
    fail: '<svg class="ck-icon" viewBox="0 0 24 24" fill="none" stroke="#FF3B30" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>'
  };

  function runCompliance() {
    if (!state.finalCanvas) return;
    state.results = window.IDP.Compliance.check(state.finalCanvas, state.metrics, {
      intensity: state.intensity,
      bgRgb: window.IDP.BgRemove.hexToRgb(state.bg),
      alpha: state.seg ? state.seg.alpha : null
    });
    state.overall = window.IDP.Compliance.overall(state.results);

    el.checks.innerHTML = state.results.map(function (r) {
      return '<li class="lv-' + r.level + '">' + ICONS[r.level] +
             '<div class="ck-body"><div class="ck-name">' + r.name + '</div>' +
             '<div class="ck-text">' + r.text + '</div></div></li>';
    }).join('');

    var canDownload = state.overall !== 'fail';
    el.downloadBtn.disabled = !canDownload;
    if (canDownload) {
      notice(el.checkNotice, state.overall === 'warn'
        ? '检测有提醒项，仍可下载；如需通过官方验证建议先按提示调整。' : '', state.overall === 'warn' ? 'warn' : '');
    } else {
      el.checkNotice.hidden = false;
      el.checkNotice.className = 'notice is-err';
      el.checkNotice.innerHTML = '检测未通过，下载已停用，请先按上方提示修正。' +
        ' <button type="button" class="btn btn-ghost btn-sm" id="forceDl" style="min-height:28px;padding:0 10px;font-size:13px;margin-left:6px">仍要下载</button>';
      var f = document.getElementById('forceDl');
      if (f) f.addEventListener('click', function () { doDownload(true); });
    }
    el.dimMeta.textContent = state.spec.width_px + ' × ' + state.spec.height_px + ' px' +
      (state.spec.width_mm ? ' · ' + state.spec.width_mm + '×' + state.spec.height_mm + 'mm' : '');
  }

  /* ================= 导出 ================= */
  var exportTimer = 0;
  function refreshExportInfo() {
    clearTimeout(exportTimer);
    exportTimer = setTimeout(function () {
      if (!state.finalCanvas) return;
      window.IDP.Export.encode(state.finalCanvas, state.target).then(function (info) {
        state.exportInfo = info;
        var t = info.target;
        var msg = '当前导出约 ' + info.kb.toFixed(1) + ' KB（质量 ' + info.quality.toFixed(2) + '）';
        if (t.max !== Infinity) msg += '，目标 ' + t.min + '–' + t.max + ' KB';
        var kind = 'ok';
        if (!info.ok && info.reason === 'over') { msg += ' —— 已压到最低质量仍超出，可直接下载但不满足目标'; kind = 'err'; }
        if (!info.ok && info.reason === 'under') { msg += ' —— 低于目标下限，官方系统可能拒收小文件'; kind = 'warn'; }
        notice(el.exportNotice, msg, kind);
      }).catch(function () { });
    }, 320);
  }

  function doDownload(force) {
    if (!state.finalCanvas) return;
    if (state.overall === 'fail' && !force) return;
    el.downloadBtn.disabled = true;
    setStage('正在生成文件…', true);
    window.IDP.Export.encode(state.finalCanvas, state.target).then(function (info) {
      window.IDP.Export.download(info.blob, window.IDP.Export.fileName(state.spec.id));
      state.exportInfo = info;
      setStage('');
      el.downloadBtn.disabled = false;
      refreshExportInfo();
    }).catch(function (e) {
      setStage('');
      el.downloadBtn.disabled = state.overall === 'fail';
      fail(e);
    });
  }

  /* ================= 上传 ================= */
  function handleFile(file) {
    notice(el.uploadNotice, '');
    setStage('正在读取照片…', true);
    readFile(file).then(function (img) {
      if (!img) return;
      if (img.naturalWidth * img.naturalHeight > 1e8) {
        throw new Error('照片分辨率过高（超过 1 亿像素），请先缩小');
      }
      state.fileName = file.name || '';
      state.master = window.IDP.Crop.loadMaster(img);
      state.seg = null; state.maskKey = '';
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
      state.offsetX = 0; state.offsetY = 0;
      el.uploadCard.hidden = true;
      el.workspace.hidden = false;
      setStage('正在处理…', true);
      requestRender('all');
      /* 上传成功后静默预加载抠图模型 */
      window.IDP.BgRemove.ensure().catch(function () { });
    }).catch(fail);
  }

  /* 相机回来的 HEIC 或异常格式 */
  function bindDrop() {
    el.drop.addEventListener('click', function (e) {
      if (e.target.closest('button')) return;
      el.fileInput.click();
    });
    el.pickBtn.addEventListener('click', function (e) { e.stopPropagation(); el.fileInput.click(); });
    el.shootBtn.addEventListener('click', function (e) { e.stopPropagation(); el.camInput.click(); });
    el.fileInput.addEventListener('change', function () {
      if (this.files && this.files[0]) handleFile(this.files[0]);
      this.value = '';
    });
    el.camInput.addEventListener('change', function () {
      if (this.files && this.files[0]) handleFile(this.files[0]);
      this.value = '';
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      el.drop.addEventListener(ev, function (e) { e.preventDefault(); el.drop.classList.add('is-over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      el.drop.addEventListener(ev, function (e) { e.preventDefault(); el.drop.classList.remove('is-over'); });
    });
    el.drop.addEventListener('drop', function (e) {
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
    el.resetBtn.addEventListener('click', function () {
      el.workspace.hidden = true;
      el.uploadCard.hidden = false;
      notice(el.uploadNotice, '');
      notice(el.exportNotice, '');
      notice(el.checkNotice, '');
      state.master = null; state.face = null; state.seg = null;
      state.finalCanvas = null; state.maskKey = '';
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  /* ================= 规格 UI ================= */
  function renderTabs() {
    el.specTabs.innerHTML = CATS.map(function (c) {
      return '<button type="button" class="tab' + (c === state.cat ? ' is-on' : '') +
             '" data-cat="' + c + '">' + c + '</button>';
    }).join('');
    Array.prototype.forEach.call(el.specTabs.children, function (b) {
      b.addEventListener('click', function () {
        state.cat = b.dataset.cat;
        renderTabs(); renderSpecRow();
      });
    });
  }

  function renderSpecRow() {
    if (state.cat === '自定义') {
      el.specRow.hidden = true;
      el.customSpec.hidden = false;
      el.specHint.textContent = '输入任意尺寸，毫米按 300 DPI 换算。';
      return;
    }
    el.customSpec.hidden = true;
    el.specRow.hidden = false;
    var list = SPECS.filter(function (s) { return s.category === state.cat; });
    el.specRow.innerHTML = list.map(function (s) {
      var dim = s.width_mm ? s.width_mm + '×' + s.height_mm + 'mm · ' + s.width_px + '×' + s.height_px + 'px'
                           : s.width_px + '×' + s.height_px + 'px';
      return '<button type="button" class="spec' + (s.id === state.spec.id ? ' is-on' : '') +
             '" data-id="' + s.id + '"><div class="spec-name">' + s.name + '</div>' +
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
    el.specHint.textContent = cur ? (cur.note || '') : '';
  }

  function selectSpec(s) {
    state.spec = s;
    if (s.bg_color) setBg(s.bg_color, true);
    renderSpecRow();
    requestRender('all');
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
    if (!silent && state.master && state.face) requestRender('compose');
  }

  /* ================= 滑块 / 微调 ================= */
  function bindControls() {
    el.intenSlider.addEventListener('input', function () {
      state.intensity = (+this.value) / 100;
      el.intenOut.textContent = this.value + '%';
      el.mopiHint.textContent = state.intensity * 100 > 28
        ? '已接近上限（' + this.value + '%）。证件照建议不超过 28%，避免官方人脸比对失败。'
        : '只作用于人脸区域：去痘痘、红血丝、肤色不均；保留毛孔、痣、疤痕与五官边缘。上限 30%。';
      if (state.master && state.face) requestRender('mopi');
    });
    el.radiusSlider.addEventListener('input', function () {
      state.radius = +this.value;
      el.radiusOut.textContent = this.value + 'px';
      if (state.master && state.face) requestRender('mopi');
    });
    el.ratioSlider.addEventListener('input', function () {
      state.faceRatio = (+this.value) / 100;
      el.ratioOut.textContent = state.faceRatio.toFixed(2);
      if (state.master && state.face) requestRender('all');
    });
    el.posSlider.addEventListener('input', function () {
      state.facePos = (+this.value) / 100;
      el.posOut.textContent = state.facePos.toFixed(2);
      if (state.master && state.face) requestRender('all');
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-nudge]'), function (b) {
      b.addEventListener('click', function () {
        var d = b.dataset.nudge.split(',');
        state.offsetX += parseFloat(d[0]);
        state.offsetY += parseFloat(d[1]);
        state.offsetX = Math.max(-0.3, Math.min(0.3, state.offsetX));
        state.offsetY = Math.max(-0.3, Math.min(0.3, state.offsetY));
        if (state.master && state.face) requestRender('all');
      });
    });
    el.nudgeReset.addEventListener('click', function () {
      state.offsetX = 0; state.offsetY = 0;
      if (state.master && state.face) requestRender('all');
    });
    el.bgCustom.addEventListener('input', function () { setBg(this.value); });

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
        wp = Math.round(w * 300 / 25.4); hp = Math.round(h * 300 / 25.4);
        wmm = w; hmm = h;
      } else {
        wp = Math.round(w); hp = Math.round(h);
        wmm = +(w * 25.4 / 300).toFixed(1); hmm = +(h * 25.4 / 300).toFixed(1);
      }
      if (wp * hp > MAX_KB_CANVAS) { notice(el.uploadNotice, '尺寸过大（超过 ' + (MAX_KB_CANVAS / 1e6) + ' 兆像素），请调小', 'err'); return; }
      if (wp < 40 || hp < 40) { notice(el.uploadNotice, '尺寸过小，宽高至少 40px', 'err'); return; }
      notice(el.uploadNotice, '');
      state.spec = {
        id: 'custom', name: '自定义', category: '自定义',
        width_mm: wmm, height_mm: hmm, width_px: wp, height_px: hp,
        bg_color: state.bg, note: wp + '×' + hp + 'px'
      };
      el.specHint.textContent = '已应用自定义规格 ' + wp + ' × ' + hp + ' px';
      requestRender('all');
    });

    /* 文件大小 */
    el.sizeChips.innerHTML = window.IDP.Export.TARGETS.map(function (t) {
      return '<button type="button" class="chip' + (t.id === state.target ? ' is-on' : '') +
             '" data-id="' + t.id + '">' + t.name + (t.note ? '（' + t.note + '）' : '') + '</button>';
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
      if (!state.cropBase) return;
      if (on) {
        draw(el.resultCanvas, state.cropBase);
        el.resultCap.textContent = '原图（裁剪后）';
      } else paint();
    }
    ['pointerdown', 'touchstart', 'mousedown'].forEach(function (ev) {
      el.peekBtn.addEventListener(ev, function (e) { e.preventDefault(); peek(true); });
    });
    ['pointerup', 'pointerleave', 'touchend', 'touchcancel', 'mouseup', 'mouseleave'].forEach(function (ev) {
      el.peekBtn.addEventListener(ev, function () { peek(false); });
    });
  }

  /* ================= 启动 ================= */
  function boot() {
    renderTabs();
    renderSpecRow();
    renderSwatches();
    bindDrop();
    bindControls();

    /* 打开页面只预加载人脸检测模型 */
    setStage('正在加载人脸检测模型…', true);
    window.IDP.FaceDetect.ensure().then(function () {
      setStage('');
    }).catch(function (e) {
      setStage('');
      notice(el.uploadNotice, e.message + '。可以刷新页面重试。', 'err');
    });

    if (!window.IDP.Mopi.isWebGL()) {
      setStage('');
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* ================= 测试 API ================= */
  window.IDPDebug = {
    ready: function () { return !!(state.master && state.face && state.finalCanvas); },
    state: function () {
      return {
        spec: state.spec.id, w: state.spec.width_px, h: state.spec.height_px,
        bg: state.bg, intensity: state.intensity, radius: state.radius, target: state.target,
        overall: state.overall, results: state.results, metrics: state.metrics, rect: state.rect,
        faceRatio: state.faceRatio, facePos: state.facePos, gen: state.gen,
        webgl: window.IDP.Mopi.isWebGL(), faceCount: state.face ? state.face.count : 0,
        busy: busy
      };
    },
    loadUrl: function (url, name) {
      return fetch(url).then(function (r) { return r.blob(); }).then(function (b) {
        return handleFile(new File([b], name || 'test.png', { type: b.type }));
      });
    },
    setSpecById: function (id) {
      var s = SPECS.filter(function (x) { return x.id === id; })[0];
      if (!s) throw new Error('unknown spec ' + id);
      selectSpec(s);
    },
    setBg: function (hex) { setBg(hex); },
    setIntensity: function (v) {
      state.intensity = v; el.intenSlider.value = Math.round(v * 100);
      el.intenOut.textContent = Math.round(v * 100) + '%';
      if (state.master && state.face) requestRender('mopi');
    },
    setRadius: function (v) {
      state.radius = v; el.radiusSlider.value = v; el.radiusOut.textContent = v + 'px';
      if (state.master && state.face) requestRender('mopi');
    },
    setTarget: function (id) { state.target = id; refreshExportInfo(); },
    setFaceRatio: function (v) { state.faceRatio = v; if (state.master) requestRender('all'); },
    setFacePos: function (v) { state.facePos = v; if (state.master) requestRender('all'); },
    encode: function () { return window.IDP.Export.encode(state.finalCanvas, state.target); },
    finalDataUrl: function () { return state.finalCanvas ? state.finalCanvas.toDataURL('image/jpeg', 0.95) : null; },
    pngUrl: function (which) {
      var c = which === 'final' ? state.finalCanvas
            : which === 'pre' ? state.preMop
            : which === 'orig' ? state.cropBase
            : which === 'mask' ? state.maskCanvas : null;
      return c ? c.toDataURL('image/png') : null;
    },
    maskStats: function () {
      if (!state.maskCanvas) return null;
      var c = state.maskCanvas, ctx = c.getContext('2d', { willReadFrequently: true });
      var d = ctx.getImageData(0, 0, c.width, c.height).data;
      var full = 0, soft = 0, zero = 0, n = c.width * c.height;
      for (var i = 0; i < n; i++) {
        var v = d[i * 4] / 255;
        if (v > 0.9) full++; else if (v > 0.01) soft++; else zero++;
      }
      return { w: c.width, h: c.height, fullRatio: full / n, softRatio: soft / n, zeroRatio: zero / n };
    },
    origDataUrl: function () { return state.cropBase ? state.cropBase.toDataURL('image/jpeg', 0.95) : null; },
    alphaStats: function () {
      if (!state.seg) return null;
      var a = state.seg.alpha, n = 0, soft = 0;
      for (var i = 0; i < a.length; i++) { if (a[i] > 0.5) n++; if (a[i] > 0.02 && a[i] < 0.98) soft++; }
      return { w: state.seg.w, h: state.seg.h, fgRatio: n / a.length, softRatio: soft / a.length };
    }
  };
})();
