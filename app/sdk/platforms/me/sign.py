"""猫耳FM（MissEvan）App API 签名（对应 sdk/me/sign.ts）—— app.missevan.com 域鉴权。

算法（知乎 p/359692208 + zunley/gofm pkg/missevan/utils.go，2026-10-02 实测可用）：
  authorization = "MissEvan " + base64(HMAC-SHA256(appsecret, DATA))
  DATA = METHOD\\n + url(冒号转义%3A)\\n + querystring\\n + equip_id:<id>\\n [+ token:<t>\\n]
         + x-m-date:<UTC毫秒ISO>\\n + x-m-nonce:<uuid>\\n [+ base64(sha256(body))\\n]
  头：User-Agent MissEvanApp、x-m-date、x-m-nonce、Cookie(equip_id[+token])

该通道返回的是免签名 CDN 明文直链（sound-ali*-cdn-cn.maoercdn.com，m4a 原文件/-128k 变体）；
网页版 hls.m3u8 为 Widevine 加密，与此无关。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import uuid
from datetime import UTC, datetime
from typing import Any

from app.sdk.auth_store import get_credentials
from app.sdk.common.request import http_fetch
from app.sdk.common.utils import as_dict

APP_SECRET = "f8Yw1M3u0e5MV7z34PcbY9wgP56YwJ"
APP_UA = "MissEvanApp/4.7.4 (iOS;15.1;iPhone11,6)"
EQUIP_ID = "52e76e9a-7592-43af-ae72-8ec755094e41"


def _utc_millis() -> str:
    """``new Date().toISOString().replace(/\\.\\d+Z$/, '.000Z')`` 的等价实现。"""
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def build_auth(
    method: str,
    url: str,
    query: str,
    *,
    equip_id: str,
    token: str,
    date: str,
    nonce: str,
) -> str:
    """构造 authorization 签名（GET 便捷封装；POST 需补 body 摘要行）。"""
    lines = [
        method,
        url.replace(":", "%3A"),
        query,
        f"equip_id:{equip_id}",
    ]
    if token:
        lines.append(f"token:{token}")
    lines.extend([f"x-m-date:{date}", f"x-m-nonce:{nonce}"])
    digest = hmac.new(APP_SECRET.encode(), ("\n".join(lines) + "\n").encode(), hashlib.sha256).digest()
    return "MissEvan " + base64.b64encode(digest).decode()


def get_me_token() -> str:
    """登录 token（/login/me 绑定的 cookie 中提取；未登录为空）。"""
    cookie = str((get_credentials("me") or {}).get("cookie") or "")
    match = re.search(r"(?:^|;\s*)token=([^;\s]+)", cookie)
    return match.group(1) if match else ""


async def app_api_get(path: str, query: str = "") -> Any:
    """App API GET 请求（自动携带登录态 token）。"""
    full = f"https://app.missevan.com{path}"
    date = _utc_millis()
    nonce = str(uuid.uuid4())
    token = get_me_token()
    cookie = f"equip_id={EQUIP_ID}" + (f"; token={token}" if token else "")
    resp = await http_fetch(
        f"{full}?{query}" if query else full,
        headers={
            "User-Agent": APP_UA,
            "Accept": "application/json",
            "Accept-Language": "zh-Hans-CN;q=1",
            "x-m-date": date,
            "x-m-nonce": nonce,
            "Cookie": cookie,
            "Authorization": build_auth("GET", full, query, equip_id=EQUIP_ID, token=token, date=date, nonce=nonce),
        },
        timeout=15_000,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"猫耳 App API HTTP {resp.status_code}")
    body = as_dict(resp.body)
    code = body.get("code")
    if body.get("success") is False or (code is not None and code != 0):
        raise RuntimeError(str(body.get("info") or f"猫耳 App API code {code}"))
    info = body.get("info")
    return info if info is not None else body


ME_UA = APP_UA
