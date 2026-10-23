"""酷狗通用请求封装与签名（对应 sdk/kg/util.ts + sdk/auth/kg.ts 的设备/签名部分）。

`app/sdk/auth/kg.py` 仍是登录流程的 stub（禁止修改），因此设备指纹与 android/web
签名在这里单独实现：取流（apis/kg.py）与取流兜底都要用同一套指纹，放这里避免重复。
"""

from __future__ import annotations

import hashlib
import uuid
from typing import Any
from urllib.parse import quote

from app.sdk.auth_store import get_credentials, set_credentials
from app.sdk.common.request import http_fetch
from app.sdk.common.utils import to_md5

ANDROID_SALT = "OIlwieks28dk2k092lksi2UIkp"
WEB_SALT = "NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt"

_RANDOM_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789"


def signature_params(params: str, platform: str = "android", body: str = "") -> str:
    """按 key 排序拼接后以盐包裹取 MD5（android 与 web 只是盐不同）。"""
    key = WEB_SALT if platform == "web" else ANDROID_SALT
    items = params.split("&")
    items.sort()
    return to_md5(f"{key}{''.join(items)}{body}{key}")


def android_sign(params: dict[str, Any], data: str = "") -> str:
    """网关签名：`${ANDROID_SALT}排序后的k=v拼接${data}${ANDROID_SALT}` 的 MD5。"""
    import json

    parts = []
    for key in sorted(params):
        value = params[key]
        # JSON.stringify 是紧凑格式（无空格），登录/注册签名依赖逐字节一致
        encoded = (
            json.dumps(value, ensure_ascii=False, separators=(",", ":")) if isinstance(value, (dict, list)) else value
        )
        parts.append(f"{key}={encoded}")
    return to_md5(f"{ANDROID_SALT}{''.join(parts)}{data}{ANDROID_SALT}")


def encode_uri_component(value: Any) -> str:
    """对齐 JS 的 encodeURIComponent（不编码 !'()*，Python 的 quote 会编码它们）。"""
    return quote(str(value), safe="!~*'()")


def random_string(n: int) -> str:
    import random

    return "".join(_RANDOM_CHARS[random.randrange(len(_RANDOM_CHARS))] for _ in range(n))


def pkcs7_pad(data: bytes, block: int = 16) -> bytes:
    """PKCS#7 填充 —— Node 的 createCipheriv 会自动补，cryptography 不会。"""
    remain = block - (len(data) % block)
    return data + bytes([remain]) * remain


def pkcs7_unpad(data: bytes, block: int = 16) -> bytes:
    """PKCS#7 去填充（对应 Node createDecipheriv 的自动 unpad）。"""
    if not data:
        return data
    remain = data[-1]
    if remain < 1 or remain > block or len(data) < remain:
        return data
    return data[:-remain]


def get_device() -> dict[str, Any]:
    """设备指纹持久化：guid/mid/dfid 稳定复用（取流与登录共用同一指纹）。"""
    dev = get_credentials("_kg_device")
    if not dev:
        dev = {"guid": str(uuid.uuid4()), "mid": "", "dfid": random_string(24)}
    if not dev.get("mid"):
        dev["mid"] = str(int(hashlib.md5(str(dev.get("guid") or "").encode()).hexdigest(), 16))
        set_credentials("_kg_device", dev)
    if not dev.get("dfid"):
        dev["dfid"] = random_string(24)
    return dev


async def create_http_fetch(url: str, options: dict[str, Any] | None = None, retry_num: int = 0) -> Any:
    """带重试的请求：非 200 或 errcode 非 0 一律重试（最多 3 次）。

    成功时按原实现的取值优先级返回：body.data → body.info(数组时返回整 body) → body.info。
    """
    if retry_num > 2:
        raise RuntimeError("try max num")
    try:
        result = await http_fetch(url, **(options or {}))
    except Exception as err:  # noqa: BLE001 - 可降级失败：换一次请求重试
        print(f"[kg] 请求失败将重试({retry_num + 1}/3) {url}: {err}")
        return await create_http_fetch(url, options, retry_num + 1)
    body = result.body if isinstance(result.body, dict) else {}
    err_code = body.get("error_code", body.get("errcode", body.get("err_code")))
    if result.status_code != 200 or err_code != 0:
        return await create_http_fetch(url, options, retry_num + 1)
    if body.get("data"):
        return body["data"]
    if isinstance(body.get("info"), list):
        return body
    return body.get("info")
