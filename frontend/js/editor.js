// 合成引擎：场景 + 角色双层渲染、变换交互、笔刷/魔棒修补、光影融合、导出
// 渲染策略：场景层/角色层各自按参数缓存，拖拽缩放只做最终合成，保证实时性
import { cssFilter, applyTemperature } from './adjust.js';
import { applyLuts, featherAlpha, floodRegion } from './imageops.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function defaultAdj() {
  return { exposure: 0, contrast: 0, saturation: 0, temperature: 0, hue: 0 };
}

/** 光源方位角 → 指向光源的单位向量（屏幕坐标，y 向下） */
function lightVector(angleDeg) {
  const a = (angleDeg * Math.PI) / 180;
  return { x: Math.sin(a), y: -Math.cos(a) };
}

export class Compositor extends EventTarget {
  constructor(canvas) {
    super();
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    this.scene = null;      // 场景 canvas（整图）
    this.charSource = null; // 原始抠图 canvas
    this.charSourceData = null; // 抠图 ImageData 缓存（魔棒取色用，懒加载）
    this.charWork = null;   // 羽化 + 橡皮擦之后的角色 canvas
    this.mask = null;       // 用户擦除/魔棒清除的记录层
    this.adj = { char: defaultAdj(), scene: defaultAdj() };
    this.autoMatch = { enabled: false, strength: 0.7, luts: null };
    this.light = {
      angle: 315,         // 光源方位角：0=正上，顺时针，315=左上
      strength: 0,        // 定向明暗 0..100
      rim: 0,             // 轮廓光 0..100
      shadowStrength: 35, // 地面投影强度 0..100
      shadowLength: 35,   // 投影长度 0..100
      lightColor: [255, 244, 214],
      shadowColor: [44, 62, 112],
    };
    this.feather = 0;       // 边缘羽化 0..12
    this.brush = null;      // { tool: 'erase'|'restore'|'wand', radius, tolerance } null=拖动
    this.char = { x: 0.5, y: 0.62, scale: 1, rotation: 0, flipX: false, opacity: 1 };

    this._sceneCache = null; this._sceneKey = '';
    this._charCache = null; this._charKey = '';
    this._silhouetteCache = null; this._silhouetteRev = -1;
    this._workRev = 0; this._lutsRev = 0;
    this._raf = 0; this._renderTimer = 0; this._rebuildRaf = 0; this._rebuildTimer = 0;
  }

  // ── 素材管理 ─────────────────────────
  setScene(c) {
    this.scene = c;
    this._sceneCache = null; this._sceneKey = '';
    this.canvas.width = c.width;
    this.canvas.height = c.height;
    if (this.charWork) this.fitChar();
    this.scheduleRender();
  }

  clearScene() {
    this.scene = null;
    this._sceneCache = null; this._sceneKey = '';
    if (this.charWork) {
      this.canvas.width = this.charWork.width;
      this.canvas.height = this.charWork.height;
      this.fitChar();
    }
    this.scheduleRender();
  }

  setChar(c) {
    this.charSource = c;
    this.charSourceData = null;
    this.mask = null;
    this.rebuildWork();
    this.fitChar();
    if (!this.scene) {
      this.canvas.width = c.width;
      this.canvas.height = c.height;
    }
    this.scheduleRender();
  }

  clearChar() {
    this.charSource = null;
    this.charSourceData = null;
    this.charWork = null;
    this.mask = null;
    this._charCache = null; this._charKey = '';
    if (!this.scene) {
      this.canvas.width = 1;
      this.canvas.height = 1;
    }
    this.scheduleRender();
  }

  reset() {
    this.clearScene();
    this.clearChar();
    this.adj = { char: defaultAdj(), scene: defaultAdj() };
    this.autoMatch = { enabled: false, strength: this.autoMatch.strength, luts: null };
    this.light = {
      angle: 315, strength: 0, rim: 0, shadowStrength: 35, shadowLength: 35,
      lightColor: [255, 244, 214], shadowColor: [44, 62, 112],
    };
    this.feather = 0;
  }

  fitChar() {
    const opacity = this.char?.opacity ?? 1;
    this.char = {
      x: 0.5,
      y: this.scene ? 0.62 : 0.5,
      scale: 1,
      rotation: 0,
      flipX: false,
      opacity,
    };
    this.dispatchEvent(new Event('transform'));
  }

  resetCharTransform() {
    const { opacity } = this.char;
    this.fitChar();
    this.char.opacity = opacity;
    this.scheduleRender();
  }

  /** 角色基准缩放：有场景时目标高度约为场景的 55%。 */
  _charScale() {
    if (!this.charWork) return 1;
    const base = this.scene
      ? (this.scene.height * 0.55) / this.charWork.height
      : (this.canvas.height * 0.8) / this.charWork.height;
    return base * this.char.scale;
  }

  setFeather(r) {
    this.feather = r;
    this.rebuildWork();
  }

  setAutoMatch({ enabled, strength, luts }) {
    this.autoMatch.enabled = enabled;
    if (strength !== undefined) this.autoMatch.strength = strength;
    if (luts !== undefined) {
      this.autoMatch.luts = luts;
      this._lutsRev++;
    }
    this.scheduleRender();
  }

  // ── 画布坐标 → 角色局部坐标（含旋转/翻转/缩放逆变换） ──
  _toCharLocal(px, py) {
    if (!this.charWork) return null;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const s = this._charScale();
    const dx = px - this.char.x * W;
    const dy = py - this.char.y * H;
    const rot = (-this.char.rotation * Math.PI) / 180;
    const rx = dx * Math.cos(rot) - dy * Math.sin(rot);
    const ry = dx * Math.sin(rot) + dy * Math.cos(rot);
    const u = rx / (s * (this.char.flipX ? -1 : 1)) + this.charWork.width / 2;
    const v = ry / s + this.charWork.height / 2;
    return { u, v };
  }

  hitChar(px, py) {
    const p = this._toCharLocal(px, py);
    if (!p) return false;
    return p.u >= 0 && p.v >= 0 && p.u < this.charWork.width && p.v < this.charWork.height;
  }

  // ── 角色层重建（羽化 + 橡皮擦/魔棒蒙版） ──
  rebuildWork() {
    if (!this.charSource) return;
    const src = this.charSource;
    let c = this.charWork;
    if (!c || c.width !== src.width || c.height !== src.height) {
      c = document.createElement('canvas');
      c.width = src.width;
      c.height = src.height;
    }
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(src, 0, 0);
    if (this.feather > 0) featherAlpha(c, this.feather);
    if (this.mask) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(this.mask, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
    }
    this.charWork = c;
    this._workRev++;
    this._charCache = null; this._charKey = '';
    this.scheduleRender();
  }

  _scheduleRebuild() {
    if (this._rebuildRaf) return;
    this._rebuildRaf = requestAnimationFrame(() => {
      this._rebuildRaf = 0;
      this.rebuildWork();
    });
    setTimeout(() => {
      if (this._rebuildRaf) {
        cancelAnimationFrame(this._rebuildRaf);
        this._rebuildRaf = 0;
        this.rebuildWork();
      }
    }, 250);
  }

  /** 橡皮擦笔触：坐标为画布空间，内部换算到角色局部空间再写入蒙版 */
  _brushStamp(x0, y0, x1, y1) {
    const p0 = this._toCharLocal(x0, y0);
    const p1 = this._toCharLocal(x1, y1);
    if (!p0 || !p1) return;
    const s = this._charScale();
    const r = this.brush.radius / s;
    const w = this.charWork.width;
    const h = this.charWork.height;
    if (p1.u < -r || p1.v < -r || p1.u > w + r || p1.v > h + r) return;

    if (!this.mask) {
      this.mask = document.createElement('canvas');
      this.mask.width = w;
      this.mask.height = h;
    }
    const ctx = this.mask.getContext('2d');
    ctx.globalCompositeOperation =
      this.brush.tool === 'erase' ? 'source-over' : 'destination-out';
    ctx.strokeStyle = '#fff';
    ctx.fillStyle = '#fff';
    ctx.lineWidth = r * 2;
    ctx.lineCap = 'round';
    if (p0.u !== p1.u || p0.v !== p1.v) {
      ctx.beginPath();
      ctx.moveTo(p0.u, p0.v);
      ctx.lineTo(p1.u, p1.v);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(p1.u, p1.v, r, 0, Math.PI * 2);
    ctx.fill();
    this._scheduleRebuild();
  }

  /** 魔棒：在角色原图上从点击处漫水取相似色区域，写入蒙版清除残留 */
  wandAt(px, py) {
    if (!this.charSource) return false;
    const p = this._toCharLocal(px, py);
    if (!p) return false;
    const w = this.charSource.width;
    const h = this.charSource.height;
    const u = Math.round(p.u);
    const v = Math.round(p.v);
    if (u < 0 || v < 0 || u >= w || v >= h) return false;

    if (!this.charSourceData) {
      this.charSourceData = this.charSource
        .getContext('2d', { willReadFrequently: true })
        .getImageData(0, 0, w, h);
    }
    const region = floodRegion(this.charSourceData, w, h, u, v, this.brush.tolerance);
    if (!region) return false;

    const rc = document.createElement('canvas');
    rc.width = w;
    rc.height = h;
    const rctx = rc.getContext('2d');
    const img = rctx.createImageData(w, h);
    for (let i = 0; i < region.length; i++) {
      if (region[i]) {
        img.data[i * 4] = 255;
        img.data[i * 4 + 1] = 255;
        img.data[i * 4 + 2] = 255;
        img.data[i * 4 + 3] = 255;
      }
    }
    rctx.putImageData(img, 0, 0);

    if (!this.mask) {
      this.mask = document.createElement('canvas');
      this.mask.width = w;
      this.mask.height = h;
    }
    const mctx = this.mask.getContext('2d');
    mctx.globalCompositeOperation = 'source-over';
    mctx.drawImage(rc, 0, 0);
    this._scheduleRebuild();
    return true;
  }

  // ── 渲染 ────────────────────────────
  scheduleRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.render();
    });
    // 后台/被遮挡的标签页里 rAF 可能长期不触发，兜底保证最终上屏
    if (this._renderTimer) clearTimeout(this._renderTimer);
    this._renderTimer = setTimeout(() => {
      if (this._raf) {
        cancelAnimationFrame(this._raf);
        this._raf = 0;
        this.render();
      }
    }, 250);
  }

  render() {
    const { canvas, ctx } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (this.scene) ctx.drawImage(this._sceneLayer(), 0, 0);
    if (this.charWork) this._drawChar(ctx, canvas.width, canvas.height);
  }

  _sceneLayer() {
    const key = JSON.stringify(this.adj.scene);
    if (this._sceneKey === key && this._sceneCache) return this._sceneCache;
    const src = this.scene;
    let c = this._sceneCache;
    if (!c || c.width !== src.width || c.height !== src.height) {
      c = document.createElement('canvas');
      c.width = src.width;
      c.height = src.height;
    }
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.filter = cssFilter(this.adj.scene);
    ctx.drawImage(src, 0, 0);
    ctx.filter = 'none';
    applyTemperature(ctx, c.width, c.height, this.adj.scene.temperature);
    this._sceneCache = c;
    this._sceneKey = key;
    return c;
  }

  _charLayer() {
    const L = this.light;
    const key = [
      JSON.stringify(this.adj.char),
      this._workRev,
      this.autoMatch.enabled ? this._lutsRev : -1,
      JSON.stringify([L.angle, L.strength, L.rim, L.lightColor, L.shadowColor]),
    ].join('|');
    if (this._charKey === key && this._charCache) return this._charCache;
    const src = this.charWork;
    let c = this._charCache;
    if (!c || c.width !== src.width || c.height !== src.height) {
      c = document.createElement('canvas');
      c.width = src.width;
      c.height = src.height;
    }
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.filter = cssFilter(this.adj.char);
    ctx.drawImage(src, 0, 0);
    ctx.filter = 'none';
    applyTemperature(ctx, c.width, c.height, this.adj.char.temperature, src);
    if (this.autoMatch.enabled && this.autoMatch.luts) {
      applyLuts(c, this.autoMatch.luts);
    }
    this._applyRelight(ctx, c, src);
    this._charCache = c;
    this._charKey = key;
    return c;
  }

  /** 在角色层上烘焙方向性明暗与轮廓光（自动保持 alpha） */
  _applyRelight(ctx, canvas, src) {
    const L = this.light;
    if (L.strength <= 0 && L.rim <= 0) return;
    const w = canvas.width;
    const h = canvas.height;
    const { x: Lx, y: Ly } = lightVector(L.angle);
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.hypot(w, h) / 2;
    const [lr, lg, lb] = L.lightColor;
    const [sr, sg, sb] = L.shadowColor;

    if (L.strength > 0) {
      const s = L.strength / 100;
      const grad = ctx.createLinearGradient(
        cx + Lx * R, cy + Ly * R, cx - Lx * R, cy - Ly * R,
      );
      grad.addColorStop(0, `rgba(${lr},${lg},${lb},${(0.55 * s).toFixed(3)})`);
      grad.addColorStop(1, `rgba(${sr},${sg},${sb},${(0.65 * s).toFixed(3)})`);
      ctx.save();
      ctx.globalCompositeOperation = 'overlay';
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(src, 0, 0);
      ctx.restore();
    }

    if (L.rim > 0) {
      const k = Math.max(3, Math.round(0.012 * Math.max(w, h) * (0.5 + L.rim / 100)));
      const rim = document.createElement('canvas');
      rim.width = w;
      rim.height = h;
      const rctx = rim.getContext('2d');
      rctx.drawImage(src, 0, 0);
      rctx.globalCompositeOperation = 'destination-out';
      rctx.drawImage(src, -Lx * k, -Ly * k);
      rctx.globalCompositeOperation = 'source-in';
      rctx.fillStyle = `rgba(${lr},${lg},${lb},${Math.min(0.85, L.rim / 100 + 0.15).toFixed(2)})`;
      rctx.fillRect(0, 0, w, h);
      ctx.save();
      ctx.filter = 'blur(2px)';
      ctx.drawImage(rim, 0, 0);
      ctx.restore();
    }
  }

  /** 角色剪影（用于地面投影），按角色层版本缓存 */
  _silhouette() {
    if (this._silhouetteRev === this._workRev && this._silhouetteCache) {
      return this._silhouetteCache;
    }
    const src = this.charWork;
    const c = document.createElement('canvas');
    c.width = src.width;
    c.height = src.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = 'rgb(24,28,40)';
    ctx.fillRect(0, 0, c.width, c.height);
    this._silhouetteCache = c;
    this._silhouetteRev = this._workRev;
    return c;
  }

  /** 沿光源反方向的地面投影：剪影从角色脚底锚点向背光侧展开、压扁、模糊 */
  _drawShadow(ctx, W, H) {
    const L = this.light;
    if (L.shadowStrength <= 0) return;
    const sil = this._silhouette();
    const s = this._charScale();
    const { x: Lx } = lightVector(L.angle);
    const len = L.shadowLength / 100;
    const shear = -Lx * 1.1 * len;
    const flatten = Math.max(0.18, 0.5 - len * 0.3);
    ctx.save();
    ctx.globalAlpha = (L.shadowStrength / 100) * 0.55;
    ctx.filter = `blur(${Math.max(2, H * 0.006 * (0.6 + len)).toFixed(1)}px)`;
    ctx.translate(this.char.x * W, this.char.y * H + (sil.height * s) / 2);
    ctx.scale(s, s);
    ctx.transform(1, 0, shear, flatten, 0, 0);
    ctx.drawImage(sil, -sil.width / 2, 0);
    ctx.restore();
  }

  _drawChar(ctx, W, H) {
    const layer = this._charLayer();
    const s = this._charScale();
    this._drawShadow(ctx, W, H);
    ctx.save();
    ctx.globalAlpha = this.char.opacity;
    ctx.translate(this.char.x * W, this.char.y * H);
    if (this.char.rotation) ctx.rotate((this.char.rotation * Math.PI) / 180);
    ctx.scale(this.char.flipX ? -s : s, s);
    ctx.drawImage(layer, -layer.width / 2, -layer.height / 2);
    ctx.restore();
  }

  /** 满分辨率导出，返回 Blob。 */
  exportBlob(type = 'image/png', quality = 0.92) {
    const c = document.createElement('canvas');
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const ctx = c.getContext('2d');
    if (type === 'image/jpeg') {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
    }
    if (this.scene) ctx.drawImage(this._sceneLayer(), 0, 0);
    if (this.charWork) this._drawChar(ctx, c.width, c.height);
    return new Promise((res) => c.toBlob(res, type, quality));
  }

  // ── 交互 ────────────────────────────
  _toCanvas(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) * this.canvas.width) / rect.width,
      y: ((e.clientY - rect.top) * this.canvas.height) / rect.height,
    };
  }

  zoomAt(px, py, factor) {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const cx = this.char.x * W;
    const cy = this.char.y * H;
    const scale2 = clamp(this.char.scale * factor, 0.05, 8);
    const ratio = scale2 / this.char.scale;
    this.char.scale = scale2;
    this.char.x = clamp((px + (cx - px) * ratio) / W, -0.5, 1.5);
    this.char.y = clamp((py + (cy - py) * ratio) / H, -0.5, 1.5);
    this.scheduleRender();
    this.dispatchEvent(new Event('transform'));
  }

  attachInteraction() {
    const cv = this.canvas;

    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const { x, y } = this._toCanvas(e);
      if (this.brush && this.charWork) {
        if (this.brush.tool === 'wand') {
          this.wandAt(x, y);
        } else {
          this._brushing = true;
          try {
            cv.setPointerCapture(e.pointerId);
          } catch { /* 合成事件或指针已失效时无法捕获 */ }
          this._lastBrush = { x, y };
          this._brushStamp(x, y, x, y);
        }
        e.preventDefault();
        return;
      }
      if (this.charWork && this.hitChar(x, y)) {
        this._dragging = true;
        cv.classList.add('dragging');
        try {
          cv.setPointerCapture(e.pointerId);
        } catch {
          // 合成事件或指针已失效时无法捕获，拖拽仍可在画布内进行
        }
        this._dragStart = { px: x, py: y, cx: this.char.x, cy: this.char.y };
        e.preventDefault();
      }
    });

    cv.addEventListener('pointermove', (e) => {
      const { x, y } = this._toCanvas(e);
      if (this._brushing) {
        this._brushStamp(this._lastBrush.x, this._lastBrush.y, x, y);
        this._lastBrush = { x, y };
      } else if (this._dragging) {
        const W = cv.width;
        const H = cv.height;
        this.char.x = clamp(this._dragStart.cx + (x - this._dragStart.px) / W, -0.5, 1.5);
        this.char.y = clamp(this._dragStart.cy + (y - this._dragStart.py) / H, -0.5, 1.5);
        this.scheduleRender();
      }
    });

    const end = () => {
      if (this._dragging) this.dispatchEvent(new Event('transform'));
      this._dragging = false;
      this._brushing = false;
      cv.classList.remove('dragging');
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);

    cv.addEventListener('wheel', (e) => {
      if (!this.charWork) return;
      e.preventDefault();
      const { x, y } = this._toCanvas(e);
      const factor = clamp(Math.exp(-e.deltaY * 0.0015), 0.8, 1.25);
      this.zoomAt(x, y, factor);
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      if (!this.charWork || this._brushing) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const step = e.shiftKey ? 10 : 1;
      let dx = 0;
      let dy = 0;
      if (e.key === 'ArrowLeft') dx = -step;
      else if (e.key === 'ArrowRight') dx = step;
      else if (e.key === 'ArrowUp') dy = -step;
      else if (e.key === 'ArrowDown') dy = step;
      else return;
      e.preventDefault();
      const W = cv.width;
      const H = cv.height;
      this.char.x = clamp(this.char.x + dx / W, -0.5, 1.5);
      this.char.y = clamp(this.char.y + dy / H, -0.5, 1.5);
      this.scheduleRender();
      this.dispatchEvent(new Event('transform'));
    });
  }
}
