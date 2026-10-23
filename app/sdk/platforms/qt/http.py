"""蜻蜓FM SSR 请求助手（对应 sdk/qt/http.ts）。

域名迁移（www.qingting.fm → www.qtfm.cn）伴随华为 WAF 会话：
302 时需带上 Set-Cookie 的 HWWAFSESID/HWWAFSESTIME 再请求 Location，否则可能被 WAF 拦。
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urljoin

from app.sdk.common.request import http_fetch

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"


async def ssr_get(url: str) -> dict[str, Any]:
    """GET 并跟随最多 3 跳重定向（累计收集 Cookie 回带），返回最终响应 ``{statusCode, html}``。"""
    current = url
    cookie = ""
    for _hop in range(4):
        headers: dict[str, str] = {
            "User-Agent": UA,
            "Referer": "https://www.qtfm.cn/",
            "Accept": "text/html,application/xhtml+xml",
        }
        if cookie:
            headers["Cookie"] = cookie
        resp = await http_fetch(current, headers=headers, timeout=15_000)
        pairs = [item.split(";")[0].strip() for item in resp.set_cookies]
        pairs = [pair for pair in pairs if pair]
        if pairs:
            cookie = "; ".join([part for part in cookie.split("; ") if part] + pairs)

        if 300 <= resp.status_code < 400:
            location = str(resp.headers.get("location") or "")
            if location:
                current = location if location.startswith("http") else urljoin(current, location)
                continue
        return {
            "statusCode": resp.status_code,
            "html": resp.raw.decode("utf-8", errors="replace") if resp.raw else str(resp.body or ""),
        }
    raise RuntimeError("重定向次数过多")
