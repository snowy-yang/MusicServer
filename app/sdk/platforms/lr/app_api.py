"""懒人听书 App API（对应 sdk/lr/appApi.ts，dapis.mting.info）—— 搜索通道（游客 token 匿名可用）。

签名（移植 loyalflower/lrts_download download.go）：
  sc = md5(urlPath + "?" + <按 key 排序的 query(不含 sc) 拼接> + secret)，secret = "iJ0DgxmdC83#I&j@iwg"
  头：UA Android13/yyting/... / Referer yytingting.com / ClientVersion 6.3.4.0
端点：/yyting/search/searchBatch.action（q=2150）

注意：章节/取流 App 端点（q=1930/2224）游客 token 已失效（482 请登录），取流走 web 通道（见 apis/lr.py）。
"""

from __future__ import annotations

import hashlib
from typing import Any
from urllib.parse import quote

from app.sdk.common.request import http_fetch

DOMAIN = "http://dapis.mting.info"
SECRET = "iJ0DgxmdC83#I&j@iwg"
GUEST_TOKEN = "OqzlvCxt2i_P1SZKF6GjFg**_lK0uCQpm5tN-P6XdFZYawCDKSgeC4anU"
GUEST_IMEI = "MDI6MDA6MDA6MDA6MDA6DDA="

APP_HEADERS = {
    "User-Agent": "Android13/yyting/vivo/V2133A/ch_uc_beta/167/Android",
    "Referer": "yytingting.com",
    "ClientVersion": "6.3.4.0",
}


def encode_uri_component(value: Any) -> str:
    return quote(str(value), safe="!~*'()")


def signed(path: str, params: dict[str, str]) -> str:
    query: dict[str, str] = {"token": GUEST_TOKEN, "imei": GUEST_IMEI, "nwt": "1", **params}
    qs = "&".join(f"{key}={query[key]}" for key in sorted(query))
    query["sc"] = hashlib.md5(f"{path}?{qs}{SECRET}".encode()).hexdigest()
    return f"{DOMAIN}{path}?" + "&".join(f"{key}={encode_uri_component(value)}" for key, value in query.items())


async def app_api_get(path: str, params: dict[str, str]) -> dict[str, Any]:
    """App API GET（游客态，仅搜索可用；章节/取流会 482 需登录）。"""
    resp = await http_fetch(signed(path, params), headers=APP_HEADERS, timeout=15_000)
    if resp.status_code != 200:
        raise RuntimeError(f"懒人 App API HTTP {resp.status_code}")
    return resp.body if isinstance(resp.body, dict) else {}
