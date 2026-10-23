"""喜马拉雅 xm-sign 生成（对应 sdk/xm/sign.ts）—— du_web_sdk 签名链。

协议：device_info → JSON → URL 编码字节 → zlib(level 6) → AES-128-ECB(PKCS7, KEY) →
  POST https://hdaa.shuzilm.cn/report?v=1.2.0&e=1&c=1&r=<uuid>（octet-stream）→
  Base64 响应 → AES-ECB 解密 → JSON 取 cadd/sid → xm-sign = "{cadd}&&{sid}"

KEY 为 du_web_sdk _getDeviceKey(0) 的硬编码密钥；每次签名都重新上报（不缓存）。
模板为纯 ASCII（Base64/十六进制字段），latin1 取字节与参考实现的 charCode 语义一致。
"""

from __future__ import annotations

import base64
import json
import time
import uuid
import zlib
from typing import Any

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from app.sdk.common.request import http_fetch
from app.sdk.platforms.kg.util import pkcs7_pad, pkcs7_unpad
from app.sdk.platforms.xm.device_info import DEVICE_INFO

SIGN_KEY = b"m9ZtRrz:qujT8@da"
REPORT_URL = "https://hdaa.shuzilm.cn/report?v=1.2.0&e=1&c=1&r="
#: 与 device_info.ew1.yV2（Chrome 125 模板）保持一致
XM_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)


def _aes_ecb(data: bytes, decrypt: bool) -> bytes:
    cipher = Cipher(algorithms.AES(SIGN_KEY), modes.ECB())
    if decrypt:
        decryptor = cipher.decryptor()
        return pkcs7_unpad(decryptor.update(data) + decryptor.finalize())
    encryptor = cipher.encryptor()
    return encryptor.update(pkcs7_pad(data)) + encryptor.finalize()


async def make_xm_sign() -> str:
    """生成 xm-sign（形如 "cadd&&sid"）；每次调用重新上报设备指纹。"""
    info: dict[str, Any] = {**DEVICE_INFO, "Zf5": int(time.time() * 1000)}
    raw = json.dumps(info, ensure_ascii=False, separators=(",", ":")).encode("latin-1")
    payload = _aes_ecb(zlib.compress(raw, 6), False)

    resp = await http_fetch(
        f"{REPORT_URL}{uuid.uuid4()}",
        method="POST",
        headers={
            "Content-Type": "application/octet-stream",
            "User-Agent": XM_UA,
            "Host": "hdaa.shuzilm.cn",
        },
        body=payload,
        timeout=15_000,
    )
    text = resp.raw.decode("utf-8", errors="replace") if resp.raw else str(resp.body or "")
    if resp.status_code != 200:
        raise RuntimeError(f"xm-sign 上报失败: HTTP {resp.status_code}")

    decrypted = _aes_ecb(base64.b64decode(text), True).decode("utf-8", errors="replace")
    obj = json.loads(decrypted)
    cadd = str(obj.get("cadd") or "")
    sid = str(obj.get("sid") or "")
    if not cadd or not sid:
        raise RuntimeError("xm-sign 上报响应缺少 cadd/sid")
    return f"{cadd}&&{sid}"
