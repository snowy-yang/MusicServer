"""5sing 公共工具（对应 sdk/5sing/util.ts，上游 fivesing/fivesing.go 的等价实现）。

平台 id 统一为 ``5sing``（上游 Go 包名 fivesing，model.Source 用 "fivesing"；本仓库契约要求 5sing）。
上游 ``New(cookie)`` 的 cookie 实际参与请求（搜索 / getSongUrl / newget / 歌单页），
这里从 auth_store 的 ``5sing`` 记录读取（无则匿名）。
"""

from __future__ import annotations

import asyncio
import math
import re
from typing import Any
from urllib.parse import quote

from app.sdk.auth_store import get_credentials
from app.sdk.common.request import http_fetch

UserAgent = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
)

#: 上游 fivesing.go 的常量：手机端 API 主机（http 明文，实测无 302）
MOBILE_API = "http://mobileapi.5sing.kugou.com"
#: 搜索接口（type=0 单曲 / type=1 歌单）
SEARCH_API = "http://search.5sing.kugou.com/home/json"

#: 作品类型（上游 typeEname；yc=原创 fc=翻唱 bz=伴奏）
SONG_KINDS: dict[str, str] = {"yc": "原创", "fc": "翻唱", "bz": "伴奏"}

HTML_ENTITIES: dict[str, str] = {
    "amp": "&",
    "lt": "<",
    "gt": ">",
    "quot": '"',
    "apos": "'",
    "nbsp": " ",
    "copy": "©",
    "reg": "®",
    "hellip": "…",
    "mdash": "—",
    "ndash": "–",
}


def encode_uri_component(value: Any) -> str:
    return quote(str(value), safe="!~*'()")


def get_first_valid(*urls: Any) -> str:
    """上游 getFirstValid：返回第一个非空字符串（空串视为无效）。"""
    for url in urls:
        if url:
            return str(url)
    return ""


def remove_em_tags(text: Any) -> str:
    """去掉搜索结果里 ``<em class="keyword">`` 高亮标签。"""
    return str(text if text is not None else "").replace('<em class="keyword">', "").replace("</em>", "").strip()


def unescape_html(text: Any) -> str:
    """Go html.UnescapeString 的等价实现（常用实体 + 数字实体）。"""
    source = str(text if text is not None else "")

    def repl(match: re.Match[str]) -> str:
        entity = match.group(1)
        try:
            if entity.startswith(("#x", "#X")):
                return chr(int(entity[2:], 16))
            if entity.startswith("#"):
                return chr(int(entity[1:], 10))
        except ValueError:
            return match.group(0)
        return HTML_ENTITIES.get(entity.lower(), match.group(0))

    return re.sub(r"&(#x?[0-9a-fA-F]+|[a-zA-Z]+);", repl, source)


def get_5sing_cookie() -> str:
    """上游 New(cookie)：cookie 仅在有值时随请求发送（匿名可用）。"""
    cred = get_credentials("5sing") or {}
    return str(cred.get("cookie") or "")


def get_status() -> dict[str, Any]:
    """登录态（凭据存在性判断）。"""
    cred = get_credentials("5sing") or {}
    if cred.get("cookie"):
        return {"logged": True, "updatedAt": cred.get("updatedAt")}
    return {"logged": False}


def is_foreign_source(song_info: dict[str, Any]) -> bool:
    """是否显式声明了非本平台的 source（上游 GetLyrics/GetDownloadURL 的 source mismatch 检查）。"""
    source = song_info.get("source")
    return bool(source) and source != "5sing"


async def fetch_5sing(url: str, *, headers: dict[str, str] | None = None, timeout_ms: int = 15_000) -> Any:
    """带 Cookie/UA 的请求；httpFetch 不跟随 302，这里手动跟跳最多 3 次。

    5sing 老链接会 http→https / 数字 userId → 个性域名跳转，必须跟。
    """
    cookie = get_5sing_cookie()
    all_headers = {"User-Agent": UserAgent}
    if cookie:
        all_headers["Cookie"] = cookie
    if headers:
        all_headers.update({str(key): str(value) for key, value in headers.items()})
    current = str(url)
    response = None
    for _hop in range(4):
        response = await http_fetch(current, headers=all_headers, timeout=timeout_ms)
        status = response.status_code or 0
        location = response.headers.get("location", "")
        if 300 <= status < 400 and location:
            from urllib.parse import urljoin

            try:
                current = urljoin(current, location)
            except ValueError:
                return response
            continue
        return response
    return response


async def fetch_5sing_json(url: str, *, headers: dict[str, str] | None = None, timeout_ms: int = 15_000) -> Any:
    """JSON 接口带退避重试（手机端 API 频率控制：code 13 / "操作太频繁"）。"""
    response = None
    for attempt in range(3):
        response = await fetch_5sing(url, headers=headers, timeout_ms=timeout_ms)
        body = response.body if isinstance(response.body, dict) else {}
        try:
            code = int(body.get("code") or 0)
        except (TypeError, ValueError):
            code = 0
        message = str(body.get("message") or "")
        if (code == 13 or "太频繁" in message) and attempt < 2:
            await asyncio.sleep(0.8 * (attempt + 1))
            continue
        return response
    return response


def build_song_link(song_type: str, song_id: Any) -> str:
    """歌曲页链接（上游 Link 拼法）。"""
    return f"http://5sing.kugou.com/{song_type}/{song_id}.html" if song_type and song_id else ""


def build_playlist_link(user_id: Any, playlist_id: str) -> str:
    """歌单页链接（上游 Link 拼法）。"""
    return f"http://5sing.kugou.com/{user_id}/dj/{playlist_id}.html" if user_id and playlist_id else ""


def extract_song_id(songmid: Any, song_type_fallback: Any = None) -> dict[str, str]:
    """解析歌曲的 ``<songid>|<songtype>`` 约定（兼容只给 songType 字段的调用）。"""
    raw = str(songmid if songmid is not None else "")
    parts = raw.split("|")
    id_part = parts[0] if parts else ""
    type_part = parts[1] if len(parts) > 1 else ""
    return {"songID": id_part or "", "songType": str(type_part or song_type_fallback or "")}


def extract_song_link(link: Any) -> dict[str, str] | None:
    """上游 Parse 的正则：5sing.kugou.com/(\\w+)/(\\d+).html（专辑/歌手页不匹配）。"""
    match = re.search(r"5sing\.kugou\.com/(\w+)/(\d+)\.html", str(link if link is not None else ""))
    if not match:
        return None
    return {"songType": match.group(1), "songID": match.group(2)}


def extract_playlist_link(link: Any) -> dict[str, str] | None:
    """歌单链接解析（放宽为任意单段 userId，含个性域名与省略 user 段）。"""
    match = re.search(
        r"5sing\.kugou\.com/(?:([^/?#]+)/)?dj/([a-zA-Z0-9]+)\.html", str(link if link is not None else "")
    )
    if not match:
        return None
    return {"userId": match.group(1) or "", "playlistId": match.group(2)}


def estimate_duration(song_size: Any) -> int:
    """上游 Search 的时长估算：songSize*8/320000（320kbps 假设；0 返回 0）。"""
    try:
        size = float(song_size or 0)
    except (TypeError, ValueError):
        size = 0.0
    return math.trunc((size * 8) / 320000) if size > 0 else 0


def kind_name(song_type: str) -> str:
    """作品类型中文名（typeName 缺失时兜底）。"""
    return SONG_KINDS.get(song_type, "")
