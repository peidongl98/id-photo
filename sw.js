/* Service Worker：应用外壳预缓存 + 模型强缓存 + 版本化管理
   改模型或改前端资源时同步改 VERSION，激活时会自动清掉旧版本缓存。 */
'use strict';

const VERSION = 'v4';
const CORE = 'idphoto-core-' + VERSION;
const MODELS = 'idphoto-models-' + VERSION;
const RUNTIME = 'idphoto-runtime-' + VERSION;
const KEEP = [CORE, MODELS, RUNTIME];

const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './data/specs.js',
  './js/preload.js',
  './js/faceDetect.js',
  './js/bgRemove.js',
  './js/mopi.js',
  './js/crop.js',
  './js/compliance.js',
  './js/export.js',
  './js/main.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CORE).then(function (c) {
      /* 逐个加，单个失败不影响整体安装 */
      return Promise.all(SHELL.map(function (u) {
        return c.add(new Request(u, { cache: 'reload' })).catch(function () { });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return KEEP.indexOf(k) < 0 ? caches.delete(k) : null;
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  /* 模型：缓存优先，永久不变（配合 _headers 的 immutable） */
  if (sameOrigin && url.pathname.indexOf('/models/') >= 0) {
    e.respondWith(cacheFirst(req, MODELS));
    return;
  }
  /* 外部 CDN（onnxruntime / tasks-vision / heic2any）：也进运行时缓存，二次访问不再走网络 */
  if (!sameOrigin && /(^|\.)(cdn\.jsdelivr\.net|unpkg\.com)$/.test(url.hostname)) {
    e.respondWith(cacheFirst(req, RUNTIME));
    return;
  }
  /* 同源页面与脚本：网络优先，断网回退缓存 */
  if (sameOrigin && (req.mode === 'navigate' || /\.(js|css|html)$/.test(url.pathname))) {
    e.respondWith(networkFirst(req, CORE));
  }
});

function cacheFirst(req, cacheName) {
  return caches.open(cacheName).then(function (c) {
    return c.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && (res.ok || res.type === 'opaque')) {
          c.put(req, res.clone()).catch(function () { });
        }
        return res;
      });
    });
  });
}

function networkFirst(req, cacheName) {
  return caches.open(cacheName).then(function (c) {
    return fetch(req).then(function (res) {
      if (res && res.ok) c.put(req, res.clone()).catch(function () { });
      return res;
    }).catch(function () {
      return c.match(req).then(function (hit) {
        if (hit) return hit;
        throw new Error('offline');
      });
    });
  });
}
