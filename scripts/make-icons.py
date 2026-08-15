# -*- coding: utf-8 -*-
"""用 OpenCV 将鲸鱼娘原图裁剪、居中裁方并缩放为应用图标。

产出:
  build/icon.png  512x512 RGBA（窗口/加载动画/图标源图）
  build/icon.ico  多尺寸 ICO（16/24/32/48/64/128/256）
"""
import os
import cv2
import numpy as np
from PIL import Image

SRC = os.path.join('assets', 'whale-girl-source.png')
OUT_DIR = 'assets'
OUT_PNG = os.path.join(OUT_DIR, 'icon.png')
OUT_ICO = os.path.join(OUT_DIR, 'icon.ico')
SIZE = 512

os.makedirs(OUT_DIR, exist_ok=True)

# ---- 读取（IMREAD_UNCHANGED 保留 alpha）----
img = cv2.imread(SRC, cv2.IMREAD_UNCHANGED)  # BGRA
if img is None:
    raise SystemExit(f'无法读取 {SRC}')
h, w = img.shape[:2]

# ---- 原图即方形（984x984），整体等比缩放到 512x512，不裁剪 ----
resized = cv2.resize(img, (SIZE, SIZE), interpolation=cv2.INTER_AREA)

# ---- 去白色雾边：半透明白色像素（白底上的抗锯齿边缘）在深色背景下
#      会混合成可见灰边。按白度压低低 alpha 像素的不透明度，主体
#      （alpha=255 的白色区域）不受影响。 ----
rgba = resized.astype(np.float32)
alpha = rgba[..., 3]
white = rgba[..., :3].min(axis=-1) / 255.0  # 1=纯白
low_a = alpha < 230
rgba[..., 3] = np.where(low_a, alpha * (1.0 - 0.95 * white * low_a.astype(np.float32)), alpha)
resized = np.clip(rgba, 0, 255).astype(np.uint8)

# ---- 输出 PNG ----
cv2.imwrite(OUT_PNG, resized)

# ---- 输出多尺寸 ICO ----
im = Image.open(OUT_PNG)
im.save(OUT_ICO, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

print(f'原图 {w}x{h} 整体缩放到 {SIZE}x{SIZE}，未裁剪')
print(f'已生成 {OUT_PNG} ({SIZE}x{SIZE}) 与 {OUT_ICO}')
