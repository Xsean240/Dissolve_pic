"""rembg 抠图服务：模型懒加载、会话缓存、透明边裁剪。

模型文件（~176MB）在首次使用时由 rembg 自动下载到 ~/.u2net/，
下载完成前所有请求会在锁上排队等待。
"""
from __future__ import annotations

import io
import threading
import traceback

import numpy as np
from PIL import Image

SUPPORTED_MODELS = {
    "isnet-anime": "动漫角色（默认）",
    "u2net_human_seg": "真人/半身像",
    "isnet-general-use": "通用物体",
}

# alpha 高于此值的像素视为前景，用于裁掉全透明边框
_ALPHA_THRESHOLD = 8
_TRIM_PADDING = 8


class MattingService:
    def __init__(self) -> None:
        self._sessions: dict[str, object] = {}
        self._errors: dict[str, str] = {}
        self._loading: set[str] = set()
        self._locks: dict[str, threading.Lock] = {}
        self._registry_lock = threading.Lock()

    def status(self) -> dict:
        return {
            name: {
                "loaded": name in self._sessions,
                "loading": name in self._loading,
                "error": self._errors.get(name),
                "label": label,
            }
            for name, label in SUPPORTED_MODELS.items()
        }

    def start_preload(self, model: str) -> None:
        """服务启动后后台预下载默认模型，失败不影响运行（请求时会重试）。"""
        threading.Thread(target=self._preload, args=(model,), daemon=True).start()

    def _preload(self, model: str) -> None:
        try:
            self._session(model)
        except Exception:
            pass

    def _session(self, model: str):
        with self._registry_lock:
            lock = self._locks.setdefault(model, threading.Lock())
        with lock:
            if model in self._sessions:
                return self._sessions[model]
            self._errors.pop(model, None)
            self._loading.add(model)
            try:
                from rembg import new_session

                self._sessions[model] = new_session(model)
            except Exception:
                self._errors[model] = traceback.format_exc(limit=3)
                raise
            finally:
                self._loading.discard(model)
            return self._sessions[model]

    def remove_background(
        self,
        data: bytes,
        model: str,
        max_side: int,
        cleanup: bool = True,
    ) -> bytes:
        """输入任意图片字节，返回裁剪过透明边、带 alpha 通道的 PNG 字节。"""
        image = Image.open(io.BytesIO(data)).convert("RGBA")
        image = _downscale(image, max_side)
        buf = io.BytesIO()
        image.save(buf, format="PNG")

        session = self._session(model)
        from rembg import remove

        cut = remove(buf.getvalue(), session=session)

        result = Image.open(io.BytesIO(cut)).convert("RGBA")
        result = _trim_transparent(result)
        if cleanup:
            result = _remove_specks(result)
            result = _cleanup_residuals(result)
            result = _trim_transparent(result)
        out = io.BytesIO()
        result.save(out, format="PNG")
        return out.getvalue()


def _downscale(image: Image.Image, max_side: int) -> Image.Image:
    w, h = image.size
    side = max(w, h)
    if side <= max_side:
        return image
    ratio = max_side / side
    return image.resize(
        (max(1, round(w * ratio)), max(1, round(h * ratio))), Image.LANCZOS
    )


def _trim_transparent(image: Image.Image) -> Image.Image:
    alpha = np.asarray(image)[:, :, 3]
    ys, xs = np.where(alpha > _ALPHA_THRESHOLD)
    if ys.size == 0:
        return image
    pad = _TRIM_PADDING
    top = max(int(ys.min()) - pad, 0)
    left = max(int(xs.min()) - pad, 0)
    bottom = min(int(ys.max()) + pad + 1, image.height)
    right = min(int(xs.max()) + pad + 1, image.width)
    return image.crop((left, top, right, bottom))


def _import_cv2():
    try:
        import cv2

        return cv2
    except ImportError:  # opencv 不可用时跳过后处理，不影响主流程
        return None


def _remove_specks(image: Image.Image) -> Image.Image:
    """剔除与主体不相连的小块残留（模型误判的零散前景碎片）。"""
    cv2 = _import_cv2()
    if cv2 is None:
        return image
    arr = np.asarray(image)
    binary = (arr[:, :, 3] > 10).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    if n <= 2:
        return image
    areas = stats[:, cv2.CC_STAT_AREA]
    largest = 1 + int(np.argmax(areas[1:]))
    keep = {largest}
    keep.update(i for i in range(1, n) if areas[i] > 0.02 * areas[largest])
    kill = [i for i in range(1, n) if i not in keep]
    if not kill:
        return image
    out = arr.copy()
    out[..., 3][np.isin(labels, kill)] = 0
    return Image.fromarray(out, "RGBA")


def _cleanup_residuals(image: Image.Image, tol: int = 42) -> Image.Image:
    """清除与外部背景连通的背景色残留（如人物双腿间、手臂与身体间的缝隙）。

    在「alpha≈0 或 颜色≈背景主色」的联合空间里从图片边框泛洪：
    - 真实外部背景（alpha≈0）必然与边框连通，泛洪可穿过缝隙进入
      双腿间等封闭残留区，把其中背景色的不透明像素一并清掉；
    - 角色身上与背景同色的部分（如白裙）被深色描边隔开、漫不进去，不受影响。
    保险丝：若清除面积超过不透明前景的 60%，视为异常，整体放弃。
    """
    cv2 = _import_cv2()
    if cv2 is None:
        return image
    arr = np.asarray(image)
    rgb = arr[:, :, :3].astype(np.int32)
    alpha = arr[:, :, 3]
    h, w = alpha.shape

    band = max(2, min(h, w) // 50)
    ring = np.zeros((h, w), dtype=bool)
    ring[:band, :] = ring[-band:, :] = True
    ring[:, :band] = ring[:, -band:] = True
    ring_bg = ring & (alpha < 30)
    if int(ring_bg.sum()) < 30:
        return image

    border_px = rgb[ring_bg]
    quant = border_px // 32
    keys = quant[:, 0] * 100000 + quant[:, 1] * 100 + quant[:, 2]
    uniq, counts = np.unique(keys, return_counts=True)
    order = np.argsort(-counts)[:2]
    centers = [border_px[keys == uniq[oi]].mean(axis=0) for oi in order]

    dist2 = np.full((h, w), 1 << 30, dtype=np.int64)
    for c in centers:
        d2 = (
            (rgb - int(c[0])) ** 2
            + (rgb - int(c[1])) ** 2
            + (rgb - int(c[2])) ** 2
        ).sum(axis=2)
        dist2 = np.minimum(dist2, d2)
    bg_colored = dist2 < tol * tol
    joint = ((alpha < 30) | bg_colored).astype(np.uint8)

    n, labels = cv2.connectedComponents(joint, connectivity=8)
    border_labels = np.unique(np.concatenate([
        labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1],
    ]))
    border_labels = border_labels[border_labels != 0]
    if border_labels.size == 0:
        return image
    reached = np.isin(labels, border_labels)
    remove = reached & bg_colored & (alpha > 0)

    fg = int((alpha > 128).sum())
    if fg == 0 or int(remove.sum()) > 0.6 * fg:
        return image
    out = arr.copy()
    out[..., 3][remove] = 0
    return Image.fromarray(out, "RGBA")


matting_service = MattingService()
