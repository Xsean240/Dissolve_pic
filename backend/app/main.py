"""Dissolve Pic MVP 后端：提供抠图 API，并托管 frontend/ 静态站点。

启动：.venv/bin/python -m uvicorn backend.app.main:app --port 8000
"""
from __future__ import annotations

import io
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from PIL import Image

from .matting import SUPPORTED_MODELS, matting_service

MAX_UPLOAD_BYTES = 20 * 1024 * 1024  # 20 MB
MAX_SIDE = 2048


class NoCacheStaticFiles(StaticFiles):
    """本地工具：静态资源每次协商缓存，避免改动后浏览器用旧文件。"""

    def file_response(self, *args, **kwargs):
        resp = super().file_response(*args, **kwargs)
        resp.headers["Cache-Control"] = "no-cache"
        return resp


app = FastAPI(title="Dissolve Pic API", version="0.1.0")

matting_service.start_preload("isnet-anime")


@app.get("/api/health")
def health():
    return {"status": "ok", "models": matting_service.status()}


@app.post("/api/segment")
async def segment(
    image: UploadFile = File(...),
    model: str = Form("isnet-anime"),
    cleanup: bool = Form(True),
):
    """上传角色图片，返回去掉背景、裁剪过透明边的 PNG（带 alpha）。

    cleanup=True 时额外做后处理：剔除小碎片、清除与边框连通的背景色残留。
    """
    if model not in SUPPORTED_MODELS:
        raise HTTPException(status_code=400, detail=f"不支持的模型：{model}")
    data = await image.read()
    if not data:
        raise HTTPException(status_code=400, detail="上传内容为空")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="图片超过 20MB 限制")
    try:
        Image.open(io.BytesIO(data))
    except Exception:
        raise HTTPException(status_code=422, detail="无法解析的图片文件")
    try:
        png = matting_service.remove_background(
            data, model, max_side=MAX_SIDE, cleanup=cleanup
        )
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=f"抠图失败：{exc}（首次使用需下载模型，可能耗时数分钟，请重试）",
        )
    return Response(
        content=png,
        media_type="image/png",
        headers={"Cache-Control": "no-store"},
    )


# 静态站点必须最后挂载，避免 "/" 前缀吞掉 /api 路由
_FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"
app.mount(
    "/",
    NoCacheStaticFiles(directory=_FRONTEND_DIR, html=True),
    name="frontend",
)
