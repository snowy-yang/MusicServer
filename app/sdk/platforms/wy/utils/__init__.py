"""网易云 eapi 请求通道（移植自 sdk/wy/utils/index.ts）。

登录后携带 MUSIC_U（见 app/sdk/auth/wy.py），未登录不附加 —— 匿名接口同样要求
eapi 签名，区别只在 cookie 决定的可访问范围/音质。

`weapi_headers(with_cookie=False)` 用于原实现里本就不带 cookie 的 weapi 请求
（playlist/list、catalogue、hottags、comment、toplist），避免登录态意外改变返回内容。
"""

from __future__ import annotations

from typing import Any

from app.sdk.auth_store import get_wy_cookie
from app.sdk.common.request import HttpResponse, http_fetch
from app.sdk.platforms.wy.utils.crypto import eapi

UA_LINUX_CHROME = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36"
)
UA_WIN_CHROME = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


def weapi_headers(referer: str = "https://music.163.com/", *, with_cookie: bool = True) -> dict[str, str]:
    headers = {
        "User-Agent": UA_LINUX_CHROME,
        "Referer": referer,
        "origin": "https://music.163.com",
    }
    if with_cookie:
        cookie = get_wy_cookie()
        if cookie:
            headers["cookie"] = cookie
    return headers


async def eapi_request(
    url: str,
    data: dict[str, Any],
    *,
    host: str = "https://interface.music.163.com/eapi/batch",
    timeout_ms: int = 60_000,
    headers: dict[str, str] | None = None,
) -> HttpResponse:
    """POST 到 eapi 通道。`url` 是业务路径（如 /api/song/enhance/player/url/v1）。"""
    merged = {"User-Agent": UA_LINUX_CHROME, "origin": "https://music.163.com"}
    cookie = get_wy_cookie()
    if cookie:
        merged["cookie"] = cookie
    if headers:
        merged.update(headers)
    return await http_fetch(host, method="post", headers=merged, form=eapi(url, data), timeout=timeout_ms)
