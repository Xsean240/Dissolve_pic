# HANDOFF 交接文档（供新机器上的 AI 阅读）

> 目标读者：在 **Windows 11 + RTX 4070 笔记本（8GB 显存）** 上接手本项目的 AI 助手。
> 你没有任何历史上下文。先读完本文，再按需读 [ARCHITECTURE.md](ARCHITECTURE.md)（架构细节/算法定位/已知缺陷）和 [README.md](README.md)（使用者视角功能说明）。
> 用户用中文交流；偏好：MVP 先行、诚实列出缺点与未验证项、文档写中文。

## 0. 项目一句话与现状

本地 Web 溶图工具：上传二次元角色图 + 现实场景图 → 服务端抠图（rembg + OpenCV 残留清理）→ 浏览器内实时合成（位置/光影/色调调整、擦除/还原/魔棒修图）→ 导出 PNG/JPG。

- **P1（MVP）与 P2（残留清理、手动修图、确定性光影）已完成并通过浏览器端到端验证**，详见 ARCHITECTURE.md 第 6 节的验证清单。
- 前一台机器是纯 CPU Linux，P3（生成式融合）因此未做。**新机器有 4070，这是解锁 P3 的关键**。
- 仓库：`github.com/Xsean240/Dissolve_pic`，main 分支为最新。前端无构建步骤，后端 FastAPI 单进程。

## 1. 新机器环境决策（已替你定好，照做即可）

| 事项 | 决策 | 理由 |
|---|---|---|
| 运行环境 | **原生 Windows + Python 3.12 venv**（不用 WSL2） | ComfyUI portable 与 torch CUDA 的 Windows 轮子都很成熟；笔记本上避免 WSL2 的 GPU/驱动边缘问题。若 pip 装 CUDA 相关包反复报 DLL 错误，再考虑退到 WSL2 |
| Python 来源 | python.org 或 `winget install Python.Python.3.12` | 避免 Store 版路径问题（非硬性） |
| GPU 运行时 | torch 用 cu124 轮子（自带 CUDA 运行时，只需装好 NVIDIA 显卡驱动）；onnxruntime 用 `onnxruntime-gpu` | 驱动去 nvidia.cn 装最新 Game Ready/Studio 即可，**无需单独装 CUDA Toolkit** |
| CUDA DLL 地狱的退路 | `onnxruntime-directml`（走 DX12，零 CUDA 依赖） | 如果 onnxruntime-gpu 报 cuDNN/CUDA DLL 缺失又懒得配，directml 是 Windows 上的免配置替代，推理同样加速 |
| 模型位置 | Windows 下 rembg 用 `C:\Users\<用户名>\.u2net\` | 从旧机拷 `isnet-anime.onnx`（176MB）过去最省事；新网络若快也可让首次请求自动下载 |

## 2. 迁移步骤清单（按序执行）

```bat
:: 1) 取代码（git 或直接整目录拷贝均可）
git clone git@github.com:Xsean240/Dissolve_pic.git   & :: 或 https://github.com/Xsean240/Dissolve_pic.git
cd Dissolve_pic

:: 2) 把旧机的 ~/.u2net/isnet-anime.onnx 拷到 C:\Users\<用户名>\.u2net\（可选，省下载）

:: 3) 一键启动（自动建 venv、装依赖、备模型、起服务）
run.bat
:: 然后浏览器打开 http://127.0.0.1:8000
```

**迁移验证标准（全部达到才算迁移成功）：**

1. `GET /api/health` 返回 `"isnet-anime": {"loaded": true}`（服务启动后 1–2 分钟内，模型预载完成）
2. 前端上传场景图 + 角色图，抠图返回且画面出现角色（CPU 下单张约 4–8 秒属正常，笔记本 CPU 可能慢于台式机）
3. 拖动/滚轮/擦除笔刷/魔棒/光影滑杆全部有视觉响应；保存 PNG 触发下载
4. `nvidia-smi` 在抠图时看不到 GPU 占用（当前是 CPU 版 onnxruntime）——这是正常的，GPU 化是下一节任务

## 3. 新机器任务路线（按优先级，用户已确认方向）

### 任务 1：GPU 化抠图（半小时，先做）

```
.venv\Scripts\pip uninstall -y onnxruntime
.venv\Scripts\pip install onnxruntime-gpu
```

验证：抠图从 ~4s 降到 <1.5s；若报 CUDA DLL 缺失 → 装 `nvidia-cudnn-cu12`（pip）或直接换 `onnxruntime-directml`。把最终选择写回 `requirements.txt`。

### 任务 2：IC-Light 高质量重打光（对画质提升最大的单项）

- **是什么**：开源扩散式重打光模型（SD1.5 级，8GB 显存轻松跑），输入角色抠图 + 光源方位/强度，输出带正确明暗/投影的角色。正好补掉现在"全局线性渐变近似"的最大短板（对照 ARCHITECTURE.md 第 5 节光影缺点）。
- **集成方式**：新端点 `POST /api/relight`（multipart：角色 PNG + angle + strength），后端用 diffusers 跑 `lllyasviel/ic-light`（fc 版）。推理 5–15 秒级 → **必须做异步**：FastAPI 内存任务表 + 前端轮询（现在没有队列基础设施，参考下面任务 4 的队列设计一起做更划算）。
- **前端改动**：「光影融合」面板加"高质量重打光"按钮；现有确定性滑杆保留为实时预览，重打光结果作为定稿替换角色层。GPU 忙/失败时静默回退确定性管线。
- **验收**：同一角色同一光源，IC-Light 输出与确定性管线输出并排截图给用户对比；重打光后角色的手臂下方/裙摆下出现自阴影（现在的管线没有）。

### 任务 3：ComfyUI 节点包（用户明确表示感兴趣，认真做）

**目标**：把本项目的核心管线变成 ComfyUI 自定义节点，借 ComfyUI 生态触达做溶图壁纸的用户群。

**节点设计（第一版 4 个节点）：**

| 节点 | 输入 | 输出 | 复用的现有代码 |
|---|---|---|---|
| `DissolveSegment` | IMAGE（角色图）、model 枚举、cleanup 开关、容差 | IMAGE（带 alpha 抠图） | `backend/app/matting.py` 的 remove_background / _cleanup_residuals / _remove_specks |
| `DissolveColorMatch` | IMAGE（角色）、IMAGE（场景）、strength | IMAGE | 前端 `imageops.js` 的 computeStats/buildMatchLuts 需移植为 numpy（逻辑简单，均值/方差→LUT） |
| `DissolveRelight` | IMAGE、angle、strength、rim、shadow 参数 | IMAGE | `editor.js` 的 lightVector/_applyRelight/_drawShadow 数学移植（overlay 渐变、剪影偏移减影、压扁投影都是 numpy 可表达的） |
| `DissolveCompose` | IMAGE（场景）、IMAGE（角色）、x/y/scale/rotation/opacity | IMAGE | `_drawChar` 的变换合成 |

重打光不必自己做节点——**ComfyUI 内置 IC-Light 节点（ICLightApply）**，下载对应模型即可，让用户把 `DissolveSegment → ComfyUI 内置 IC-Light → DissolveCompose` 串起来。

**关键架构要求（动手前必读）：**
1. **先抽共享核心库**：把 `backend/app/matting.py` 的纯算法部分抽到 `dissolve_core/`（纯函数，PIL/numpy 进出，不依赖 FastAPI），FastAPI 与节点包都 import 它。避免两份实现漂移。
2. **节点包仓库布局**：单独目录 `comfyui_nodes/`（可独立发布），ComfyUI 侧用目录连接挂载调试：`mklink /J <ComfyUI目录>\custom_nodes\dissolve_nodes <本仓库>\comfyui_nodes`
3. ComfyUI 节点输入输出是 torch tensor（BHWC，0–1），注意与 PIL/numpy 的转换封装在一个工具函数里。
4. 首选 **ComfyUI portable** 版做开发调试环境。
5. 发布时写一份节点使用示例工作流 JSON 放进目录（ComfyUI 用户习惯拖工作流）。

**验收**：ComfyUI 里加载一张角色+场景，串完 4 节点输出成品图，与网页端同等参数输出视觉一致。

### 任务 4：生成式 inpaint 融合（P3 主体，8GB 显存要务实）

- 8GB 跑 Flux Kontext / Qwen-Image-Edit 原版显存不够（fp16 需 12–20GB）。**务实路线**：SDXL inpaint 级起步，或经 ComfyUI 跑 Qwen-Image-Edit 的 GGUF Q4 量化版（约 6–7GB，勉强放下但慢、需 `--lowvram`）。
- 工程优先于模型：单卡 = 单 GPU worker + 任务队列（FastAPI `asyncio.Queue` 起步即可，不必上 Celery）；前端统一走"提交任务 → 轮询状态 → 取结果"。
- 策略：只对角色边缘 20–40px 环带 + 接触阴影区低强度重绘（denoise 0.2–0.35），保角色特征；失败/超时回退确定性管线。
- **验收**：固定评测集（见任务 5）上盲测优于现状再合并。

### 任务 5：建固定评测集（半天的投资，长期回报）

收集 10–20 对"角色图 × 场景图"（注意版权：本地自用，勿入库——放 `evalset/` 并加进 .gitignore，只提交清单文件）。此后任何管线改动（清理阈值、IC-Light 参数、inpaint 强度）都跑同一批出图对比。旧机器上所有调参都是肉眼单张判断，这是欠的债。

### 任务 6：工程加固（低优先级，见 ARCHITECTURE.md 第 4 节）

撤销/重做（蒙版快照栈）、工程保存/加载、pytest 自动化测试。做 P3 时顺手把后端算法的 pytest 补上。

## 4. 旧环境踩过的坑（新机器可能复现）

1. **前端改完 JS 不生效**：浏览器启发式缓存。后端已发 no-cache 协商头，但更早的缓存条目没有——改 `index.html` 引用的 `js/app.js` 加 `?v=N` 参数强制刷新，全部确认后再去掉（旧机器上做过多次，见 git log）。
2. **后台/被遮挡标签页渲染滞后**：浏览器对后台页 rAF 和定时器双重节流，代码里已有 250ms 兜底（`editor.js` scheduleRender），但自动化测试采样时要等 2 秒以上再断言，否则误判"功能失效"（旧机器上被坑过两次）。
3. **自动化测试注入文件**：内置浏览器不支持原生文件选择器，用页面内 `fetch 测试图 → File → DataTransfer → dispatch change` 注入（项目 `frontend/test/` 临时放素材，已 gitignore，勿提交版权图）。
4. **GitHub 下载慢**（如果新机器网络同样受限）：模型 md5 `6f184e756bb3bd901c8849220a83e38e`；旧机器用 16 线程分块下载 3 分钟完成，单线程要 2 小时。
5. **Python 3.14**：旧机用的 3.14 没问题，但 torch/onnxruntime-gpu 的 Windows 轮子对新版本跟进慢，**新机按第 1 节用 3.12**，不要照抄旧机版本。

## 5. 给新 AI 的行为约定

- 动手前先跑通第 2 节迁移验证，再从任务 1 开始；每个任务完成后向用户展示验收证据（截图/像素断言数字），不要只说"完成"。
- 改算法参数（清理容差、光影系数等）时跑评测集对比，防回归。
- 用户明确说过：ComfyUI 节点包是移植后优先完成的部分（任务 3，可在任务 2 之后或并行）。
- 提交信息用中文或英文均可，但要描述清楚改了什么；push 前确认 `.gitignore` 生效（`.venv/`、`__pycache__/`、`frontend/test/`、`evalset/` 不入库）。
