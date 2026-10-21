// 色彩调整模型：CSS filter 生成 + 色温叠加

export const DEFAULT_ADJ = Object.freeze({
  exposure: 0,   // -100..100 → brightness 0..2
  contrast: 0,   // -100..100 → contrast 0..2
  saturation: 0, // -100..100 → saturate 0..2
  temperature: 0, // -100 冷 .. 100 暖
  hue: 0,        // -100..100 → ±180°
});

export function defaultAdjustments() {
  return { ...DEFAULT_ADJ };
}

export function cssFilter(adj) {
  const parts = [];
  if (adj.exposure) parts.push(`brightness(${(1 + adj.exposure / 100).toFixed(3)})`);
  if (adj.contrast) parts.push(`contrast(${(1 + adj.contrast / 100).toFixed(3)})`);
  if (adj.saturation) parts.push(`saturate(${(1 + adj.saturation / 100).toFixed(3)})`);
  if (adj.hue) parts.push(`hue-rotate(${(adj.hue * 1.8).toFixed(1)}deg)`);
  return parts.length ? parts.join(' ') : 'none';
}

/**
 * 在已绘制的图层上叠加冷暖色调（soft-light 混合）。
 * 需保留 alpha 时传入 keepAlphaFrom（canvas），叠加后按其 alpha 裁剪，
 * 避免透明区域被染出一圈色边。
 */
export function applyTemperature(ctx, w, h, temp, keepAlphaFrom = null) {
  if (!temp) return;
  const a = Math.min(0.6, (Math.abs(temp) / 100) * 0.6);
  ctx.save();
  ctx.globalCompositeOperation = 'soft-light';
  ctx.fillStyle =
    temp > 0 ? `rgba(255,138,40,${a})` : `rgba(70,140,255,${a})`;
  ctx.fillRect(0, 0, w, h);
  if (keepAlphaFrom) {
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(keepAlphaFrom, 0, 0);
  }
  ctx.restore();
}
