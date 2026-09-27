/* 磨皮：WebGL 双边滤波（自写 shader）
   sigma_space = radius * 0.6   → 空间核随半径放大
   sigma_color = 0.08           → 强保边（低对比差异被磨掉，高对比边缘被保留）
   只作用于传入蒙版椭圆内，边缘羽化过渡 */
(function () {
  'use strict';

  var VERT = [
    'attribute vec2 a_pos;',
    'varying vec2 v_uv;',
    'void main(){',
    '  v_uv = a_pos * 0.5 + 0.5;',
    '  gl_Position = vec4(a_pos, 0.0, 1.0);',
    '}'
  ].join('\n');

  var FRAG = [
    'precision highp float;',
    'precision highp int;',
    'varying vec2 v_uv;',
    'uniform sampler2D u_src;',
    'uniform sampler2D u_mask;',
    'uniform vec2 u_texel;',
    'uniform int u_radius;',
    'uniform float u_sigmaSpace;',
    'uniform float u_sigmaColor;',
    'uniform float u_intensity;',
    'uniform float u_blend;',
    'uniform float u_restore;',
    'vec3 at(vec2 o){ return texture2D(u_src, v_uv + o).rgb; }',
    'void main(){',
    '  vec4 c0 = texture2D(u_src, v_uv);',
    '  float m = texture2D(u_mask, v_uv).r;',
    '  if (u_intensity <= 0.0001 || m <= 0.002) { gl_FragColor = vec4(c0.rgb, 1.0); return; }',
    '  float ss2 = 2.0 * u_sigmaSpace * u_sigmaSpace;',
    '  float sc2 = 2.0 * u_sigmaColor * u_sigmaColor;',
    '  vec3 acc = vec3(0.0);',
    '  float wsum = 0.0;',
    '  for (int i = -5; i <= 5; i++){',
    '    if (i > u_radius || i < -u_radius) continue;',
    '    for (int j = -5; j <= 5; j++){',
    '      if (j > u_radius || j < -u_radius) continue;',
    '      vec2 off = vec2(float(i) * u_texel.x, float(j) * u_texel.y);',
    '      vec3 c = texture2D(u_src, v_uv + off).rgb;',
    '      vec3 d = c - c0.rgb;',
    '      float d2 = float(i * i + j * j);',
    '      float dc2 = dot(d, d);',
    '      float w = exp(-d2 / ss2 - dc2 / sc2);',
    '      acc += c * w;',
    '      wsum += w;',
    '    }',
    '  }',
    '  vec3 f = acc / max(wsum, 1e-5);',
    /* 1–2px 高频层：3×3 二项式低通取差值。频率分离的关键：
       双边把「痘（6–9px 中频结构）」连同「毛孔（1–2px 高频）」一起抹掉，
       再把高频层按 u_restore 补回 —— 痘走掉、毛孔留下。 */
    '  vec2 tx = u_texel;',
    '  vec3 bl = (at(vec2(0.0, 0.0)) * 4.0',
    '          + (at(vec2(-tx.x, 0.0)) + at(vec2(tx.x, 0.0)) + at(vec2(0.0, -tx.y)) + at(vec2(0.0, tx.y))) * 2.0',
    '          + at(vec2(-tx.x, -tx.y)) + at(vec2(tx.x, -tx.y)) + at(vec2(-tx.x, tx.y)) + at(vec2(tx.x, tx.y))) / 16.0;',
    '  vec3 hp = c0.rgb - bl;',
    '  float k = u_blend * m;',
    '  vec3 outc = mix(c0.rgb, f, k) + hp * k * u_restore;',
    '  gl_FragColor = vec4(clamp(outc, 0.0, 1.0), 1.0);',
    '}'
  ].join('\n');

  var gl = null, prog = null, texSrc = null, texMask = null, canvas = null;
  var loc = {}, quad = null;
  var supported = null;

  /* 可调参数：
     sigmaScale  放大空间核；blendScale 把强度映射到混合比例；passes 级联次数；
     restore     高频回填系数（频率分离核心）——
                 0 = 老行为（高频一起被压掉，毛孔消失）；
                 1 = 高频完整保留，只有 6–9px 的痘被削。
     σ_color 恒为 0.08（规格），σ_space 恒 = radius×0.6（规格）。
     级联对「中频（痘）」是乘法削减，对「高频（毛孔）」被 restore 抵消 → 两遍只加强去痘，不额外伤毛孔。 */
  var params = { sigmaScale: 1, blendScale: 3.33, passes: 2, restore: 0.85 };

  function init() {
    if (supported !== null) return supported;
    try {
      canvas = document.createElement('canvas');
      gl = canvas.getContext('webgl', {
        premultipliedAlpha: false, preserveDrawingBuffer: true,
        antialias: false, alpha: false, depth: false, stencil: false
      }) || canvas.getContext('experimental-webgl', { preserveDrawingBuffer: true, alpha: false });
      if (!gl) throw new Error('no webgl');

      function sh(type, src) {
        var s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
          throw new Error('shader: ' + gl.getShaderInfoLog(s));
        }
        return s;
      }
      prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error('link: ' + gl.getProgramInfoLog(prog));
      }
      gl.useProgram(prog);

      quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      var aPos = gl.getAttribLocation(prog, 'a_pos');
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

      loc = {
        src: gl.getUniformLocation(prog, 'u_src'),
        mask: gl.getUniformLocation(prog, 'u_mask'),
        texel: gl.getUniformLocation(prog, 'u_texel'),
        radius: gl.getUniformLocation(prog, 'u_radius'),
        ss: gl.getUniformLocation(prog, 'u_sigmaSpace'),
        sc: gl.getUniformLocation(prog, 'u_sigmaColor'),
        inten: gl.getUniformLocation(prog, 'u_intensity'),
        blend: gl.getUniformLocation(prog, 'u_blend'),
        restore: gl.getUniformLocation(prog, 'u_restore')
      };

      texSrc = makeTex(); texMask = makeTex();
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.uniform1i(loc.src, 0);
      gl.uniform1i(loc.mask, 1);
      supported = true;
    } catch (e) {
      supported = false;
      gl = null;
    }
    return supported;
  }

  function makeTex() {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  }

  /* 主入口：返回新画布（不修改入参） */
  function apply(srcCanvas, opts) {
    var intensity = opts.intensity, radius = opts.radius, maskCanvas = opts.mask;
    var out = document.createElement('canvas');
    out.width = srcCanvas.width; out.height = srcCanvas.height;
    var outCtx = out.getContext('2d');

    if (intensity <= 0 || !init()) {
      outCtx.drawImage(srcCanvas, 0, 0);
      return out;
    }

    var w = srcCanvas.width, h = srcCanvas.height;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texMask);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, maskCanvas);
    gl.uniform2f(loc.texel, 1 / w, 1 / h);
    gl.uniform1f(loc.sc, 0.08);
    gl.uniform1f(loc.inten, Math.max(0, Math.min(1, intensity)));

    var passes = Math.max(1, Math.round(params.passes));
    var cur = srcCanvas;
    for (var p = 0; p < passes; p++) {
      /* 第一遍用规格给定核，之后逐级把尺度推大（级联等价于更大 σ 但保留细节分层） */
      var r = radius * params.sigmaScale * (p === 0 ? 1 : 1.8);
      gl.viewport(0, 0, w, h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texSrc);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cur);
      gl.uniform1i(loc.radius, Math.max(1, Math.min(5, Math.round(r))));
      gl.uniform1f(loc.ss, Math.max(0.6, r * 0.6));
      gl.uniform1f(loc.blend, Math.max(0, Math.min(1, intensity * params.blendScale)));
      gl.uniform1f(loc.restore, Math.max(0, Math.min(1, params.restore)));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      outCtx.drawImage(canvas, 0, 0);
      cur = out;
    }
    return out;
  }

  /* ---------- 无 WebGL 时的 CPU 兜底（仅在蒙版范围内做双边） ---------- */
  function applyCPU(srcCanvas, opts) {
    var out = document.createElement('canvas');
    out.width = srcCanvas.width; out.height = srcCanvas.height;
    var ctx = out.getContext('2d');
    ctx.drawImage(srcCanvas, 0, 0);
    if (opts.intensity <= 0) return out;

    var w = out.width, h = out.height;
    var src = ctx.getImageData(0, 0, w, h);
    var msk = opts.mask.getContext('2d').getImageData(0, 0, w, h).data;
    var dst = new Uint8ClampedArray(src.data);
    var R = Math.max(1, Math.min(5, Math.round(opts.radius)));
    var ss2 = 2 * (R * 0.6) * (R * 0.6), sc2 = 2 * 0.08 * 0.08;
    var d = src.data;
    var restore = Math.max(0, Math.min(1, params.restore == null ? 1 : params.restore));

    /* 1–2px 高频层（3×3 二项式低通与自身的差）—— 与 shader 同一口径 */
    function blur3(x, y, c) {
      var xl = x > 0 ? x - 1 : x, xr = x < w - 1 ? x + 1 : x;
      var yt = y > 0 ? y - 1 : y, yb = y < h - 1 ? y + 1 : y;
      var s = d[(yt * w + xl) * 4 + c] + d[(yt * w + x) * 4 + c] + d[(yt * w + xr) * 4 + c]
            + 2 * (d[(y * w + xl) * 4 + c] + d[(y * w + x) * 4 + c] + d[(y * w + xr) * 4 + c])
            + d[(yb * w + xl) * 4 + c] + d[(yb * w + x) * 4 + c] + d[(yb * w + xr) * 4 + c];
      return s / 16;
    }

    var x0 = w, x1 = 0, y0 = h, y1 = 0, any = false;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (msk[(y * w + x) * 4] > 2) {
          any = true;
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    if (!any) return out;

    for (y = Math.max(0, y0 - R); y <= Math.min(h - 1, y1 + R); y++) {
      for (x = Math.max(0, x0 - R); x <= Math.min(w - 1, x1 + R); x++) {
        var i = (y * w + x) * 4;
        var m = msk[i] / 255;
        if (m <= 0.008) continue;
        var r0 = d[i], g0 = d[i + 1], b0 = d[i + 2];
        var ar = 0, ag = 0, ab = 0, ws = 0;
        for (var j = -R; j <= R; j++) {
          var yy = y + j; if (yy < 0 || yy >= h) continue;
          for (var k = -R; k <= R; k++) {
            var xx = x + k; if (xx < 0 || xx >= w) continue;
            var ni = (yy * w + xx) * 4;
            var dr = d[ni] - r0, dg = d[ni + 1] - g0, db = d[ni + 2] - b0;
            var wgt = Math.exp(-(j * j + k * k) / ss2 - (dr * dr + dg * dg + db * db) / sc2);
            ar += d[ni] * wgt; ag += d[ni + 1] * wgt; ab += d[ni + 2] * wgt;
            ws += wgt;
          }
        }
        if (ws <= 0) continue;
        var t = Math.max(0, Math.min(1, opts.intensity * params.blendScale * m));
        /* 频率分离：双边结果 + 高频层回填 */
        for (var c = 0; c < 3; c++) {
          var o0 = d[i + c];
          var hp = o0 - blur3(x, y, c);
          var v = o0 + ((c === 0 ? ar : c === 1 ? ag : ab) / ws - o0) * t + hp * t * restore;
          dst[i + c] = v < 0 ? 0 : (v > 255 ? 255 : v);
        }
      }
    }
    ctx.putImageData(new ImageData(dst, w, h), 0, 0);
    return out;
  }

  function applySafe(srcCanvas, opts) {
    if (init()) return apply(srcCanvas, opts);
    return applyCPU(srcCanvas, opts);
  }

  window.IDP = window.IDP || {};
  window.IDP.Mopi = {
    apply: applySafe,
    isWebGL: function () { return init(); },
    params: params,
    setParams: function (o) {
      for (var k in o) if (Object.prototype.hasOwnProperty.call(params, k)) params[k] = o[k];
    }
  };
})();
