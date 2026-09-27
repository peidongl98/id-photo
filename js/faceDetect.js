/* 人脸检测：MediaPipe Face Landmarker（468 关键点）
   用途：自动裁剪定位 + 磨皮区域椭圆 */
(function () {
  'use strict';

  var VERSION = '0.10.14';

  /* CDN 双备份，锁死版本号 */
  var PAIRS = [
    { m: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@' + VERSION + '/vision_bundle.mjs',
      w: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@' + VERSION + '/wasm' },
    { m: 'https://unpkg.com/@mediapipe/tasks-vision@' + VERSION + '/vision_bundle.mjs',
      w: 'https://unpkg.com/@mediapipe/tasks-vision@' + VERSION + '/wasm' }
  ];

  /* 模型：同域相对路径（/models/），由启动页统一预加载并写入 Cache Storage。
     不再走外部 CDN —— 官方源 storage.googleapis.com 在大陆不可直连。 */
  var FACE_MODEL = ['models/face_landmarker.task'];
  var SEG_MODEL = ['models/selfie_segmenter.tflite'];

  /* 启动页会把已下载的模型 buffer 交进来，转成 blob URL 直接喂给 MediaPipe，避免二次下载 */
  var _modelUrl = null;
  function setModelBuffer(buf) {
    if (!buf || !window.Blob || !window.URL || !URL.createObjectURL) return;
    _modelUrl = URL.createObjectURL(new Blob([buf], { type: 'application/octet-stream' }));
  }
  function modelSources() {
    return _modelUrl ? [_modelUrl].concat(FACE_MODEL) : FACE_MODEL;
  }

  /* MediaPipe 脸部轮廓关键点（FACEMESH_FACE_OVAL） */
  var OVAL_IDX = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,
                  152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];

  var _visionP = null;
  var _landmarker = null;
  var _segP = null;

  /* ---------- 引擎加载（与 bgRemove 共用） ---------- */
  function loadVision() {
    if (_visionP) return _visionP;
    _visionP = (function () {
      var lastErr = null;
      return PAIRS.reduce(function (chain, pair) {
        return chain.catch(function () {
          return import(pair.m).then(function (mod) {
            return mod.FilesetResolver.forVisionTasks(pair.w).then(function (fileset) {
              return { mod: mod, fileset: fileset };
            });
          }).catch(function (e) { lastErr = e; throw e; });
        });
      }, Promise.reject()).catch(function () {
        throw new Error('检测引擎加载失败，请检查网络后刷新重试（' + (lastErr && lastErr.message || '') + '）');
      });
    })();
    return _visionP;
  }

  function createWithFallback(createFn, modelUrls) {
    return (function () {
      var lastErr = null;
      return modelUrls.reduce(function (chain, url) {
        return chain.catch(function () {
          /* GPU 优先，失败回退 CPU（部分浏览器/驱动不支持 WebGL 委托） */
          return createFn(url, 'GPU').catch(function () {
            return createFn(url, 'CPU');
          }).catch(function (e) { lastErr = e; throw e; });
        });
      }, Promise.reject()).catch(function () {
        throw new Error('模型加载失败（' + (lastErr && lastErr.message || '') + '）');
      });
    })();
  }

  /* ---------- 人脸关键点 ---------- */
  function ensureLandmarker() {
    if (_landmarker) return Promise.resolve(_landmarker);
    return loadVision().then(function (v) {
      return createWithFallback(function (url, delegate) {
        return v.mod.FaceLandmarker.createFromOptions(v.fileset, {
          baseOptions: { modelAssetPath: url, delegate: delegate },
          runningMode: 'IMAGE',
          numFaces: 1
        });
      }, modelSources()).then(function (lm) { _landmarker = lm; return lm; });
    });
  }

  /* 返回：{ lm, bbox, head, oval }（全部为 0–1 归一化坐标，相对输入画布） */
  function analyze(canvas) {
    return ensureLandmarker().then(function (lm) {
      var res = lm.detect(canvas);
      var faces = res && res.faceLandmarks;
      if (!faces || !faces.length || !faces[0] || faces[0].length < 400) return null;

      var pts = faces[0];
      var minX = 1, minY = 1, maxX = 0, maxY = 0, sx = 0, sy = 0;
      var oval = [];
      for (var k = 0; k < OVAL_IDX.length; k++) {
        var p = pts[OVAL_IDX[k]];
        if (!p) continue;
        oval.push({ x: p.x, y: p.y });
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      var ovalB = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
      if (ovalB.w <= 0.01 || ovalB.h <= 0.01) return null;

      /* 关键点 10 在发际线、152 在下巴底。证件照口径的「头部」要把
         颅顶（头发）补上，故向上扩 14%、左右各扩 5% */
      var head = {
        w: ovalB.w * 1.10,
        h: ovalB.h * 1.14,
        cx: ovalB.x + ovalB.w / 2,
        cy: ovalB.y + ovalB.h / 2 - ovalB.h * 0.07
      };

      return {
        count: faces.length,
        lm: pts,
        oval: oval,
        ovalBox: ovalB,
        head: head
      };
    });
  }

  window.IDP = window.IDP || {};
  window.IDP.loadVision = loadVision;
  window.IDP.FaceDetect = {
    ensure: ensureLandmarker,
    analyze: analyze,
    setModelBuffer: setModelBuffer,
    OVAL_IDX: OVAL_IDX,
    SEG_MODEL: SEG_MODEL
  };
})();
