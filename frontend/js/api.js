// 与后端通信

export async function fetchHealth() {
  const res = await fetch('/api/health');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 上传角色图，返回带 alpha 的 PNG Blob。可能耗时较长（首次需下载模型）。
 * cleanup=true 时服务端额外做残留清理（碎片剔除 + 边框连通背景清除）。 */
export async function segmentImage(file, model, cleanup = true) {
  const form = new FormData();
  form.append('image', file);
  form.append('model', model);
  form.append('cleanup', String(cleanup));
  const res = await fetch('/api/segment', { method: 'POST', body: form });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j.detail) detail = j.detail;
    } catch { /* 非 JSON 响应 */ }
    throw new Error(detail);
  }
  return res.blob();
}
