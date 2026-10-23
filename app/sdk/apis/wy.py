"""网易云音乐 取流接口（移植自 sdk/apis/wy.ts）。

接口: https://interface3.music.163.com/eapi/song/enhance/player/url/v1（eapi 加密请求，响应为明文 JSON）
音质: 128k → standard, 320k → exhigh, flac → lossless, flac24bit → hires
未登录时不带 cookie 走匿名通道（音质上限由服务端决定），与原实现一致。
"""

from __future__ import annotations

from typing import Any

from app.sdk.auth_store import get_wy_cookie
from app.sdk.common.request import http_fetch
from app.sdk.platforms.wy.utils import UA_WIN_CHROME
from app.sdk.platforms.wy.utils.crypto import eapi

LEVEL_MAP = {
    "128k": "standard",
    "320k": "exhigh",
    "flac": "lossless",
    "flac24bit": "hires",
}

# 官方直连接口支持的音质（sdk/__init__.py 汇总为 support_quality）
SUPPORT_QUALITYS: list[str] = ["128k", "320k", "flac", "flac24bit"]

URL_HOST = "https://interface3.music.163.com/eapi/song/enhance/player/url/v1"


async def get_music_url(song_info: dict[str, Any], quality: str, retry_num: int = 0) -> dict[str, Any]:
    """取流。失败抛 RuntimeError（文案与原文一致：获取失败）。"""
    data = {
        "ids": f"[{song_info.get('songmid')}]",
        "level": LEVEL_MAP.get(quality, "standard"),
        "encodeType": "flac",
    }
    headers = {"User-Agent": UA_WIN_CHROME, "origin": "https://music.163.com"}
    cookie = get_wy_cookie()
    if cookie:
        headers["cookie"] = cookie

    resp = await http_fetch(
        URL_HOST,
        method="post",
        headers=headers,
        form=eapi("/api/song/enhance/player/url/v1", data),
        timeout=15000,
    )
    body = resp.body if isinstance(resp.body, dict) else {}
    if resp.status_code != 200 or body.get("code") != 200:
        raise RuntimeError("获取失败")
    items = body.get("data") or []
    item = items[0] if items else None
    if not isinstance(item, dict) or not item.get("url"):
        raise RuntimeError("获取失败")
    return {"type": quality, "url": item["url"]}
