/* 导出：JPEG 质量自适应 + 目标文件大小 */
(function () {
  'use strict';

  var MAX_Q = 0.92, MIN_Q = 0.65, STEP = 0.02;

  var TARGETS = [
    { id: 'none',    name: '不限',                min: 0,   max: Infinity },
    { id: 'chsi',    name: '20–40KB',             min: 20,  max: 40,  note: '学信网' },
    { id: 'mid',     name: '40–100KB',            min: 40,  max: 100 },
    { id: 'high',    name: '100–200KB',           min: 100, max: 200 }
  ];

  function toBlob(canvas, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) {
        b ? resolve(b) : reject(new Error('导出失败：浏览器未返回图片数据'));
      }, 'image/jpeg', quality);
    });
  }

  function findTarget(id) {
    for (var i = 0; i < TARGETS.length; i++) if (TARGETS[i].id === id) return TARGETS[i];
    return TARGETS[0];
  }

  /* 目标档位仍压不到时，逐级缩小尺寸再试（等比，保持规格宽高比）。
     只有用户显式选了档位才会走到这里 —— 「不限」永远按原图质量原样交付。 */
  var SCALES = [1, 0.85, 0.72, 0.61, 0.5];

  function shrink(canvas, k) {
    var w = Math.max(1, Math.round(canvas.width * k));
    var h = Math.max(1, Math.round(canvas.height * k));
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var x = c.getContext('2d');
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    x.drawImage(canvas, 0, 0, w, h);
    return c;
  }

  /* 固定尺寸下：质量从 0.92 逐档下调到 0.65，返回第一个 ≤ max 的 */
  function encodeAt(cv, t) {
    return toBlob(cv, MAX_Q).then(function (first) {
      var kb = first.size / 1024;
      if (kb <= t.max) {
        return { blob: first, quality: MAX_Q, kb: kb,
                 ok: kb >= t.min, reason: kb >= t.min ? 'ok' : 'under' };
      }
      var last = { blob: first, quality: MAX_Q, kb: kb };
      var q = MAX_Q;
      function step() {
        q = +(q - STEP).toFixed(4);
        if (q < MIN_Q - 1e-9) return { blob: last.blob, quality: last.quality, kb: last.kb, ok: false, reason: 'over' };
        var qq = Math.max(MIN_Q, q);
        return toBlob(cv, qq).then(function (b) {
          var size = b.size / 1024;
          last = { blob: b, quality: qq, kb: size };
          if (size <= t.max) {
            return { blob: b, quality: qq, kb: size,
                     ok: size >= t.min, reason: size >= t.min ? 'ok' : 'under' };
          }
          if (qq <= MIN_Q + 1e-9) return { blob: b, quality: qq, kb: size, ok: false, reason: 'over' };
          return step();
        });
      }
      return step();
    });
  }

  /* 不限 → 原图质量（q0.92 原样交付，不动尺寸）
     选了档位 → 先降质量，仍超再逐级降尺寸 */
  function encode(canvas, targetId) {
    var t = findTarget(targetId);
    if (t.max === Infinity) {
      return toBlob(canvas, MAX_Q).then(function (b) {
        return { blob: b, quality: MAX_Q, kb: b.size / 1024, ok: true, reason: 'ok',
                 target: t, scale: 1, outSize: [canvas.width, canvas.height] };
      });
    }
    var i = 0;
    function attempt() {
      if (i >= SCALES.length) return null;
      var sc = SCALES[i++];
      var cv = sc === 1 ? canvas : shrink(canvas, sc);
      return encodeAt(cv, t).then(function (r) {
        if (r.reason === 'over') {
          return attempt() || r;          /* 这档压不到 → 换更小的尺寸；到底了就如实回报 */
        }
        r.target = t;
        r.scale = sc;
        r.outSize = [cv.width, cv.height];
        return r;
      });
    }
    return attempt();
  }

  function stamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
           p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  function fileName(specId) {
    return 'idphoto-' + (specId || 'custom').replace(/[^a-z0-9-]/gi, '') + '-' + stamp() + '.jpg';
  }

  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  window.IDP = window.IDP || {};
  window.IDP.Export = {
    TARGETS: TARGETS,
    encode: encode,
    fileName: fileName,
    download: download,
    findTarget: findTarget
  };
})();
