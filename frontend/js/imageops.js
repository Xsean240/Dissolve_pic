// 图像底层工具：加载、缩放、透明检测、色彩统计、LUT 匹配、alpha 羽化

/** 加载 File/Blob 为可绘制位图，优先 createImageBitmap（自动处理 EXIF 方向）。 */
export async function loadBitmap(file) {
  try {
    return await createImageBitmap(file);
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = () => rej(new Error('图片解码失败'));
        img.src = url;
      });
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/** 位图 → canvas，限制最长边。后续所有操作统一基于 canvas。 */
export function bitmapToCanvas(src, maxSide = 2048) {
  const w = src.width || src.naturalWidth;
  const h = src.height || src.naturalHeight;
  const ratio = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * ratio));
  canvas.height = Math.max(1, Math.round(h * ratio));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** 粗略检测图片是否含透明像素（已抠图的 PNG）。 */
export function hasAlpha(canvas) {
  const scale = Math.min(1, 96 / Math.max(canvas.width, canvas.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(canvas.width * scale));
  c.height = Math.max(1, Math.round(canvas.height * scale));
  const ctx = c.getContext('2d');
  ctx.drawImage(canvas, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] < 250) return true;
  }
  return false;
}

/** 降采样统计不透明像素的 RGB 均值/标准差，供色调匹配使用。 */
export function computeStats(canvas) {
  const scale = Math.min(1, 128 / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(canvas, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;

  const sum = [0, 0, 0];
  const sq = [0, 0, 0];
  let count = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    count++;
    for (let ch = 0; ch < 3; ch++) {
      const v = d[i + ch];
      sum[ch] += v;
      sq[ch] += v * v;
    }
  }
  if (!count) return { mean: [128, 128, 128], std: [50, 50, 50] };
  const mean = sum.map((s) => s / count);
  const std = sq.map((s, ch) => Math.max(8, Math.sqrt(s / count - mean[ch] ** 2)));
  return { mean, std };
}

/** Reinhard 均值/方差匹配（RGB 空间），返回 3×256 查找表，已混入 strength。 */
export function buildMatchLuts(charStats, sceneStats, strength) {
  return [0, 1, 2].map((ch) => {
    const gain = sceneStats.std[ch] / charStats.std[ch];
    const base = sceneStats.mean[ch] - gain * charStats.mean[ch];
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) {
      lut[i] = i * (1 - strength) + (gain * i + base) * strength;
    }
    return lut;
  });
}

/** 对 canvas 逐像素套用 LUT（跳过全透明像素）。 */
export function applyLuts(canvas, luts) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const [lr, lg, lb] = luts;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    d[i] = lr[d[i]];
    d[i + 1] = lg[d[i + 1]];
    d[i + 2] = lb[d[i + 2]];
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** 只模糊 alpha 通道（两趟盒模糊近似高斯），用于柔化抠图边缘。 */
export function featherAlpha(canvas, radius) {
  if (radius <= 0) return canvas;
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, w, h);
  const a = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) a[p] = img.data[p * 4 + 3];
  boxBlur(a, w, h, radius);
  boxBlur(a, w, h, radius);
  for (let p = 0; p < w * h; p++) img.data[p * 4 + 3] = a[p];
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function clampI(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 漫水填充：从 (su,sv) 出发取 RGB 相似（欧氏距离 ≤ tol）的连通区域。
 * 返回 Uint8Array（1=区域内），种子点接近全透明时返回 null。
 */
export function floodRegion(imageData, w, h, su, sv, tol) {
  const d = imageData.data;
  const start = sv * w + su;
  if (d[start * 4 + 3] < 30) return null;
  const sr = d[start * 4];
  const sg = d[start * 4 + 1];
  const sb = d[start * 4 + 2];
  const tol2 = tol * tol * 3;
  const visited = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  stack[sp++] = start;
  visited[start] = 1;
  while (sp > 0) {
    const i = stack[--sp];
    out[i] = 1;
    const x = i % w;
    const y = (i / w) | 0;
    // 四邻域
    if (x > 0 && !visited[i - 1]) {
      const k = (i - 1) * 4;
      const dr = d[k] - sr, dg = d[k + 1] - sg, db = d[k + 2] - sb;
      if (dr * dr + dg * dg + db * db <= tol2) { visited[i - 1] = 1; stack[sp++] = i - 1; }
    }
    if (x < w - 1 && !visited[i + 1]) {
      const k = (i + 1) * 4;
      const dr = d[k] - sr, dg = d[k + 1] - sg, db = d[k + 2] - sb;
      if (dr * dr + dg * dg + db * db <= tol2) { visited[i + 1] = 1; stack[sp++] = i + 1; }
    }
    if (y > 0 && !visited[i - w]) {
      const k = (i - w) * 4;
      const dr = d[k] - sr, dg = d[k + 1] - sg, db = d[k + 2] - sb;
      if (dr * dr + dg * dg + db * db <= tol2) { visited[i - w] = 1; stack[sp++] = i - w; }
    }
    if (y < h - 1 && !visited[i + w]) {
      const k = (i + w) * 4;
      const dr = d[k] - sr, dg = d[k + 1] - sg, db = d[k + 2] - sb;
      if (dr * dr + dg * dg + db * db <= tol2) { visited[i + w] = 1; stack[sp++] = i + w; }
    }
  }
  return out;
}

/**
 * 估计场景光源：亮部重心 → 方位角（0=正上，顺时针），
 * 同时给出亮部/暗部的平均色（自动提亮/压暗，避免过曝死黑）。
 */
export function computeSceneLighting(canvas) {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d');
  ctx.drawImage(canvas, 0, 0, S, S);
  const d = ctx.getImageData(0, 0, S, S).data;
  const n = S * S;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    lum[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
  }
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => lum[a] - lum[b]);
  const k = Math.max(1, Math.round(n * 0.2));
  const lo = idx.slice(0, k);
  const hi = new Set(idx.slice(n - k));

  const meanRGB = (list) => {
    let r = 0, g = 0, b = 0;
    for (const i of list) { r += d[i * 4]; g += d[i * 4 + 1]; b += d[i * 4 + 2]; }
    const m = list.length;
    return [Math.round(r / m), Math.round(g / m), Math.round(b / m)];
  };
  const lighten = (rgb) => rgb.map((v) => Math.round(v + (255 - v) * 0.35));
  const darken = (rgb) => rgb.map((v) => Math.round(v * 0.55));

  let bx = 0, by = 0, wsum = 0;
  for (let i = 0; i < n; i++) {
    if (!hi.has(i)) continue;
    bx += i % S;
    by += (i / S) | 0;
    wsum++;
  }
  bx /= wsum;
  by /= wsum;
  let angle = Math.round((Math.atan2(bx - S / 2, -(by - S / 2)) * 180) / Math.PI);
  angle = ((angle % 360) + 360) % 360;
  return { angle, lightColor: lighten(meanRGB(idx.slice(n - k))), shadowColor: darken(meanRGB(lo)) };
}

function boxBlur(buf, w, h, r) {
  const tmp = new Float32Array(buf.length);
  const win = r * 2 + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += buf[row + clampI(x, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / win;
      sum += buf[row + clampI(x + r + 1, 0, w - 1)] - buf[row + clampI(x - r, 0, w - 1)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[clampI(y, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      buf[y * w + x] = sum / win;
      sum += tmp[clampI(y + r + 1, 0, h - 1) * w + x] - tmp[clampI(y - r, 0, h - 1) * w + x];
    }
  }
}
