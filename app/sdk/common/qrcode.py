"""二维码生成 —— 把登录 URL 渲染成 data URL，供 /login/* 的 qrimg 字段直接展示。

对应原 TS 里 `import qrcode from 'qrcode'` 的 `toDataURL` 用法（bili 扫码登录）。
用 Pillow 后端输出 PNG，再 base64 成 data URL，前端 <img src> 可直接用。
"""

from __future__ import annotations

import base64
import io

import qrcode as _qrcode
from qrcode.constants import ERROR_CORRECT_M


def to_data_url(text: str, *, box_size: int = 6, border: int = 2) -> str:
    """生成 `data:image/png;base64,...`。"""
    qr = _qrcode.QRCode(version=None, error_correction=ERROR_CORRECT_M, box_size=box_size, border=border)
    qr.add_data(text)
    qr.make(fit=True)
    image = qr.make_image(fill_color="black", back_color="white")
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def to_png_bytes(text: str, *, box_size: int = 6, border: int = 2) -> bytes:
    """生成 PNG 原始字节（需要直接返回图片响应时用）。"""
    qr = _qrcode.QRCode(version=None, error_correction=ERROR_CORRECT_M, box_size=box_size, border=border)
    qr.add_data(text)
    qr.make(fit=True)
    image = qr.make_image(fill_color="black", back_color="white")
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()
