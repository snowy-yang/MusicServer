"""千千音乐（music.91q.com / 91q.com）公共请求层（对应 sdk/bd/util.ts）。

上游全部接口都走 `/v1/*`，参数 = 业务参数 + appid + timestamp + sign：

    sign = md5(按 key 升序拼接 "k=v&..."（不含 sign）+ Secret)

匿名即可搜索 / 查专辑 / 查歌单 / 拿免费曲目直链；cookie 只影响 VIP、收藏等登录态资源。

**签名串与 query 必须分开编码**：sign 用参数原值拼接（服务端拿收到的参数值重算），
query 用 `URLSearchParams` 序列化。两者共用同一份 `sign_params` 结果，且 URL 拼好后
直接交给 `http_fetch`（不再二次序列化），这是历史上「签名串 ≠ 实际 body」踩过的坑。
"""

from __future__ import annotations

import hashlib
import math
import re
import time
from typing import Any

from app.sdk.auth_store import get_cookie
from app.sdk.common.request import http_fetch
from app.sdk.common.utils import size_formate

APP_ID = "16073360"
SECRET = "0b50b02fd0d73a9c4c8c3a781c30845f"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"
)
REFERER = "https://music.91q.com/player"
API_BASE = "https://music.91q.com"

# 上游音质档位顺序（3000 = flac，其余为 kbps）
RATE_ORDER = ["3000", "320", "128", "64"]

# URLSearchParams 不编码的字符集。与 Python quote 的默认安全字符不同：
# URLSearchParams 保留 `*` 却编码 `~`，差一个字符服务端就验签失败，故自行实现。
_FORM_SAFE = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789*-._")

# rateFileInfo 档位 → MusicServer 既有 Quality 桶（64k 不参与 types 展示，仅影响取流回退）
_RATE_LABEL = {"128": "128k", "320": "320k", "3000": "flac"}

# 上游 sanitizeQianqianAlbumKeyword 的特殊字符集
_ALBUM_KEYWORD_SPECIALS = re.compile(r"""[:："'“”‘’()（）\[\]【】,，/\\\-.]""")


def to_number(value: Any) -> float:
    """JS `Number()` 语义：None(undefined) 与不可解析 → NaN，bool → 1/0，空串 → 0。"""
    if value is None:
        return math.nan
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    if not text:
        return 0.0
    try:
        return float(text)
    except ValueError:
        return math.nan


def num_or_zero(value: Any) -> float:
    """`Number(value ?? 0)` 语义：缺失（null/undefined）视作 0，不可解析才是 NaN。"""
    return 0.0 if value is None else to_number(value)


def to_int(value: Any, fallback: int = 0) -> int:
    """`Number(value) || fallback` 语义：0 / NaN / 不可解析都落到 fallback。"""
    number = to_number(value)
    if not number or math.isnan(number):
        return fallback
    return int(number)


def form_encode(value: Any) -> str:
    """`new URLSearchParams(...).toString()` 的逐字节等价实现（空格写 `+`，其余按 UTF-8 编码）。"""
    out: list[str] = []
    for byte in str(value).encode("utf-8"):
        char = chr(byte)
        if char in _FORM_SAFE:
            out.append(char)
        elif char == " ":
            out.append("+")
        else:
            out.append(f"%{byte:02X}")
    return "".join(out)


def get_qian_cookie() -> str:
    """千千平台 cookie（未绑定返回空串；上游所有请求都会带上该 header，此处保持一致）。"""
    return get_cookie("bd")


def request_headers() -> dict[str, str]:
    headers = {
        "User-Agent": USER_AGENT,
        "Referer": REFERER,
        "Accept": "application/json, text/plain, */*",
    }
    cookie = get_qian_cookie()
    if cookie:
        headers["Cookie"] = cookie
    return headers


def sign_params(params: dict[str, Any]) -> dict[str, Any]:
    """写入当前秒级时间戳，按 key 字典序拼串后追加 Secret 做 md5。"""
    signed: dict[str, Any] = {str(key): value for key, value in params.items()}
    signed["timestamp"] = str(int(time.time()))
    payload = "&".join(f"{key}={signed[key]}" for key in sorted(signed)) + SECRET
    signed["sign"] = hashlib.md5(payload.encode("utf-8")).hexdigest()
    return signed


def signed_url(path: str, params: dict[str, Any]) -> str:
    """签名后的完整 URL：签名用原值，query 用 URLSearchParams 等价编码。"""
    query = "&".join(f"{key}={form_encode(value)}" for key, value in sign_params(params).items())
    return f"{API_BASE}{path}?{query}"


async def api_get(path: str, params: dict[str, Any]) -> Any:
    """发起带签名的 GET，返回响应 JSON body（非 200 按原文案抛错）。"""
    resp = await http_fetch(signed_url(path, params), method="get", headers=request_headers(), timeout=15000)
    if resp.status_code != 200:
        raise RuntimeError(f"千千音乐接口失败（HTTP {resp.status_code}）")
    return resp.body if resp.body is not None else {}


def api_ok(body: Any) -> bool:
    """上游状态判定：state=true 或 errno=22000 视为成功。"""
    if not isinstance(body, dict):
        return False
    return body.get("state") is True or to_number(body.get("errno")) == 22000


def error_text(body: Any, prefix: str) -> str:
    """上游错误文案：errmsg 优先，缺失时拼 errno（两种文案都逐字沿用原实现）。"""
    if not isinstance(body, dict):
        return prefix
    message = str(body.get("errmsg") or "").strip()
    if message:
        return message
    return f"{prefix}（errno {body.get('errno')}）"


async def track_link(tsid: str, rate: str) -> Any:
    """tracklink 单档位请求（data 内含 path/format/rate/size；VIP 曲目无 path）。"""
    return await api_get("/v1/song/tracklink", {"TSID": tsid, "appid": APP_ID, "rate": rate})


def interval_of(duration: Any) -> str | int:
    """时间格式 mm:ss（duration 为秒；无效或 <=0 显示 0）。"""
    seconds = to_number(duration)
    if math.isnan(seconds) or seconds <= 0:
        return 0
    return f"{int(seconds // 60):02d}:{int(seconds % 60):02d}"


def join_artists(artists: Any) -> str:
    """千千歌手数组 → 展示名（优先 artistType=38 歌手；去重后以 、 连接）。"""
    if not isinstance(artists, list) or not artists:
        return ""
    names: list[str] = []
    seen: set[str] = set()

    def add(name: Any) -> None:
        text = "" if name is None else str(name).strip()
        if not text or text in seen:
            return
        seen.add(text)
        names.append(text)

    for item in artists:
        if isinstance(item, dict) and to_number(item.get("artistType")) == 38:
            add(item.get("name"))
    if not names:
        for item in artists:
            if isinstance(item, dict):
                add(item.get("name"))
    return "、".join(names)


def normalize_album_asset_code(id: Any) -> str:
    """上游 normalizeQianqianAlbumAssetCode：仅接受 p/P 开头（长度 >=2）并归一为大写 P。"""
    text = ("" if id is None else str(id)).strip()
    if len(text) < 2:
        return ""
    return f"P{text[1:]}" if text[0] in ("p", "P") else ""


def sanitize_album_keyword(keyword: Any) -> str:
    """上游 sanitizeQianqianAlbumKeyword：特殊字符替换为空格并折叠空白（23001 时重试用）。"""
    trimmed = ("" if keyword is None else str(keyword)).strip()
    if not trimmed:
        return ""
    return " ".join(part for part in _ALBUM_KEYWORD_SPECIALS.sub(" ", trimmed).split() if part)


def first_non_empty(*values: Any) -> str:
    for value in values:
        text = "" if value is None else str(value).strip()
        if text:
            return text
    return ""


def release_date10(raw: Any) -> str:
    """上游 qianqianReleaseDate：只取前 10 位（YYYY-MM-DD）。"""
    text = ("" if raw is None else str(raw)).strip()
    return text[:10] if len(text) >= 10 else text


def rate_stats(rate_file_info: Any, duration: float) -> dict[str, int]:
    """上游 qianqianRateStats：从 rateFileInfo 取最高可用档位的文件大小与码率（kbps）。"""
    for rate in RATE_ORDER:
        info = rate_file_info.get(rate) if isinstance(rate_file_info, dict) else None
        if not isinstance(info, dict):
            continue
        size = to_number(info.get("size"))
        if not size > 0:
            continue
        if duration > 0:
            return {"size": int(size), "bitrate": int(size * 8 / 1000 / duration)}
        return {"size": int(size), "bitrate": 800 if rate == "3000" else int(rate)}
    return {"size": 0, "bitrate": 0}


def rate_types(rate_file_info: Any) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    """rateFileInfo → 既有 Quality 桶的 types / _types。"""
    types: list[dict[str, Any]] = []
    type_map: dict[str, dict[str, Any]] = {}
    for rate in ("128", "320", "3000"):
        info = rate_file_info.get(rate) if isinstance(rate_file_info, dict) else None
        if not isinstance(info, dict):
            continue
        size = to_number(info.get("size"))
        if not size > 0:
            continue
        label = _RATE_LABEL[rate]
        size_text = size_formate(int(size))
        types.append({"type": label, "size": size_text})
        type_map[label] = {"size": size_text}
    return types, type_map


def map_track(
    item: Any,
    *,
    album_id: str = "",
    album_name: str = "",
    img: str | None = None,
    singer: str = "",
) -> dict[str, Any]:
    """千千曲目字段 → MusicServer 统一 Song 形状。

    搜索用 TSID/albumAssetCode，专辑详情用 assetId（无 albumAssetCode，需外部补 albumId），
    歌单详情用 TSID + albumTitle + pic。
    注：上游 Search 会跳过 isVip != 0 的曲目；本实现保留它们并标记 payPlay，
    取流端对无直链的 VIP 曲目给出明确错误（路由可走外部音源/kw 兜底）。
    """
    source = item if isinstance(item, dict) else {}
    duration = num_or_zero(source.get("duration"))
    stats = rate_stats(source.get("rateFileInfo"), duration)
    types, type_map = rate_types(source.get("rateFileInfo"))
    return {
        "songmid": first_non_empty(source.get("TSID"), source.get("assetId"), source.get("tsid")),
        "name": str(source.get("title") or "").strip(),
        "singer": first_non_empty(join_artists(source.get("artist")), singer),
        "albumId": first_non_empty(normalize_album_asset_code(source.get("albumAssetCode")), album_id),
        "albumName": first_non_empty(source.get("albumTitle"), album_name),
        "interval": interval_of(duration),
        "size": stats["size"] or 0,
        "bitrate": stats["bitrate"] or 0,
        "payPlay": num_or_zero(source.get("isVip")) != 0 or num_or_zero(source.get("isPaid")) != 0,
        "img": first_non_empty(source.get("pic"), img) or None,
        "lrc": None,
        "lrcx": "",
        "types": types,
        "_types": type_map,
        "source": "bd",
    }


def song_link(tsid: str) -> str:
    return f"https://music.91q.com/song/{tsid}"


def album_link(id: str) -> str:
    return f"https://music.91q.com/album/{id}"


def playlist_link(id: str) -> str:
    return f"https://music.91q.com/songlist/{id}"
