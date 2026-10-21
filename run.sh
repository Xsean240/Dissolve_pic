#!/usr/bin/env bash
# 一键启动：自动创建虚拟环境、安装依赖、下载模型，然后起服务
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  echo "[setup] 创建虚拟环境…"
  python3 -m venv .venv
  .venv/bin/pip install -q --upgrade pip
  echo "[setup] 安装依赖…"
  .venv/bin/pip install -q -r requirements.txt
fi

echo "[setup] 准备抠图模型（已下载则秒过）…"
.venv/bin/python scripts/download_model.py

echo "[run] 服务启动于 http://127.0.0.1:8000"
exec .venv/bin/python -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000
