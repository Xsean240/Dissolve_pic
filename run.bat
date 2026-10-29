@echo off
REM Windows 一键启动：自动创建虚拟环境、安装依赖、准备模型，然后起服务
REM 需已安装 Python 3.12（python.org 或 winget）并加入 PATH
setlocal
cd /d %~dp0

if not exist .venv (
  echo [setup] 创建虚拟环境...
  python -m venv .venv
  .venv\Scripts\python -m pip install --upgrade pip -q
  echo [setup] 安装依赖（首次约 2-5 分钟）...
  .venv\Scripts\python -m pip install -r requirements.txt
)

echo [setup] 准备抠图模型（已下载则秒过，首次约 176MB）...
.venv\Scripts\python scripts\download_model.py

echo [run] 服务启动于 http://127.0.0.1:8000  （Ctrl+C 停止）
.venv\Scripts\python -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000
