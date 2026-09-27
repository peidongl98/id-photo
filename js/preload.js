/* 模型加载：同域相对路径 + fetch stream 实时进度 + Cache Storage 强缓存 + 版本号管理
   只管「把模型拿下来并缓存」，进度与重试由启动页（main.js）驱动。 */
(function () {
  'use strict';

  var CACHE_VERSION = 'v3';
  var CACHE = 'idphoto-models-' + CACHE_VERSION;

  /* 两个模型在启动页统一加载；并行下载，不串行 */
  var FILES = [
    { id: 'face',   url: 'models/face_landmarker.task', label: '正在加载人脸检测模型…', size: 3758596 },
    { id: 'modnet', url: 'models/modnet.onnx',          label: '正在加载背景处理模型…', size: 25888640 }
  ];

  function hasCache() { return typeof caches !== 'undefined' && !!caches.open; }

  function cacheOpen() {
    if (!hasCache()) return Promise.resolve(null);
    return caches.open(CACHE).catch(function () { return null; });
  }

  /* 缓存命中直接返回，不发网络请求 */
  function readCached(url) {
    if (!hasCache()) return Promise.resolve(null);
    return caches.match(url).then(function (r) {
      return r ? r.arrayBuffer() : null;
    }).catch(function () { return null; });
  }

  function writeCache(url, buf) {
    return cacheOpen().then(function (c) {
      if (!c) return;
      /* 存副本，原始 buffer 还要交给模型使用 */
      return c.put(new Request(url), new Response(buf.slice(0), {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.byteLength) }
      })).catch(function () { });
    });
  }

  function download(url, onProgress) {
    return fetch(url, { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
      var total = parseInt(res.headers.get('content-length') || '0', 10);
      if (!res.body || !total) {
        return res.arrayBuffer().then(function (b) { onProgress(1); return b; });
      }
      var reader = res.body.getReader(), chunks = [], got = 0;
      return (function pump() {
        return reader.read().then(function (x) {
          if (x.done) {
            var buf = new Uint8Array(got), off = 0;
            for (var i = 0; i < chunks.length; i++) { buf.set(chunks[i], off); off += chunks[i].length; }
            return buf.buffer;
          }
          chunks.push(x.value); got += x.value.length;
          onProgress(Math.min(1, got / total));
          return pump();
        });
      })();
    });
  }

  function loadOne(file, onProgress) {
    return readCached(file.url).then(function (buf) {
      if (buf && buf.byteLength > 0) { onProgress(1, true); return buf; }
      return download(file.url, function (p) { onProgress(p, false); })
        .then(function (b) { return writeCache(file.url, b).then(function () { return b; }); });
    });
  }

  /* 并行加载全部模型；返回 { face: ArrayBuffer, modnet: ArrayBuffer } */
  function loadAll(onModel) {
    var out = {};
    return Promise.all(FILES.map(function (f) {
      return loadOne(f, function (p, cached) {
        if (onModel) onModel(f.id, p, !!cached);
      }).then(function (buf) { out[f.id] = buf; });
    })).then(function () { return out; });
  }

  /* 重试前清掉可能残缺的缓存 */
  function clear() {
    if (!hasCache()) return Promise.resolve();
    return caches.delete(CACHE).catch(function () { });
  }

  window.IDP = window.IDP || {};
  window.IDP.Preload = {
    VERSION: CACHE_VERSION,
    CACHE: CACHE,
    FILES: FILES,
    loadAll: loadAll,
    readCached: readCached,
    writeCache: writeCache,
    clear: clear
  };
})();
