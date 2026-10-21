"""预下载抠图模型，避免首次请求时等待。可重复执行（已存在则秒过）。"""
from rembg import new_session

print("正在准备模型 isnet-anime（首次运行需下载约 176MB）…")
new_session("isnet-anime")
print("模型就绪。")
