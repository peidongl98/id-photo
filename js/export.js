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

  /* 从 0.92 逐步下调到 0.65；压不到就返回实际大小 */
  function encode(canvas, targetId) {
    var t = findTarget(targetId);
    return toBlob(canvas, MAX_Q).then(function (first) {
      var kb = first.size / 1024;
      if (t.max === Infinity || kb <= t.max) {
        return {
          blob: first, quality: MAX_Q, kb: kb,
          ok: !(t.min > 0 && kb < t.min),
          reason: (t.min > 0 && kb < t.min) ? 'under' : 'ok',
          target: t
        };
      }
      var last = { blob: first, quality: MAX_Q };
      var qs = [];
      for (var q = +(MAX_Q - STEP).toFixed(4); q > MIN_Q + 1e-9; q = +(q - STEP).toFixed(4)) qs.push(q);
      qs.push(MIN_Q);
      var i = 0;
      function next() {
        if (i >= qs.length) {
          return { blob: last.blob, quality: last.quality, kb: last.blob.size / 1024,
                   ok: false, reason: 'over', target: t };
        }
        var qq = qs[i++];
        return toBlob(canvas, qq).then(function (b) {
          last = { blob: b, quality: qq };
          var size = b.size / 1024;
          if (size <= t.max) {
            return { blob: b, quality: qq, kb: size,
                     ok: size >= t.min, reason: size >= t.min ? 'ok' : 'under', target: t };
          }
          return next();
        });
      }
      return next();
    });
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
