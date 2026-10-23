"""Apple Music 公共工具（对应 sdk/apple/util.ts，上游 music-lib/apple/apple.go 的移植基础层）。

* ``New(cookie)`` → auth_store 的 apple 记录：cookie 支持
  ``"media-user-token=xxx;storefront=cn;token=xxx"`` 形态。
* ``fetch_apple_token``：从 music.apple.com 首页 → index-legacy JS 抓 developer token（amp-api 的 Bearer）。
  当前（2026-10）Apple 下发的 JWT 以 eyJ0eXAi 开头而非上游正则写的 eyJh，
  故这里泛化为任意 JWT（eyJ…）并优先选择 issuer=AMPWebPlay 的 token；带回退与失效重取。
* amp 请求（httpFetch 不自动跟 302，首页跳转用 fetch_follow 手动跟）。
* 模型转换与 ID 提取（字段映射同上游，apple_test.go 的断言逐条保留）。
"""

from __future__ import annotations

import asyncio
import base64
import json
import re
import time
from typing import Any
from urllib.parse import parse_qs, quote, urlencode, urljoin, urlsplit

from app.sdk.auth_store import get_credentials
from app.sdk.common.request import HttpResponse, http_fetch
from app.sdk.common.utils import as_dict, as_list, format_play_time

APPLE_HOMEPAGE_URL = "https://music.apple.com"
APPLE_AMP_API_URL = "https://amp-api.music.apple.com"
DEFAULT_STOREFRONT = "us"
APPLE_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)

#: JWT 自身带 exp（通常数月），这里再加 12h 进程内缓存，避免频繁拉取数 MB 的 JS bundle
TOKEN_CACHE_TTL_MS = 12 * 60 * 60 * 1000

_cached_token = ""
_cached_at = 0.0
#: 显式配置的 token 在 401/403 后不再优先使用，改为回源网页抓取
_bypass_explicit_token = False
_token_lock = asyncio.Lock()


def parse_cookie_parts(cookie: str) -> dict[str, str]:
    """上游 parseCookieParts：按 ';' 拆分 cookie，'k=v' 去空白。"""
    result: dict[str, str] = {}
    for part in str(cookie or "").split(";"):
        trimmed = part.strip()
        idx = trimmed.find("=")
        if idx > 0:
            result[trimmed[:idx].strip()] = trimmed[idx + 1 :].strip()
    return result


def get_apple_config() -> dict[str, str]:
    """读取 apple 平台运行时配置（对应上游 New(cookie)）。"""
    cred = get_credentials("apple") or {}
    parts = parse_cookie_parts(str(cred.get("cookie") or ""))
    storefront = str(cred.get("storefront") or parts.get("storefront") or DEFAULT_STOREFRONT).strip()
    return {
        "storefront": storefront or DEFAULT_STOREFRONT,
        "mediaUserToken": str(cred.get("mediaUserToken") or parts.get("media-user-token") or "").strip(),
        "token": str(cred.get("token") or parts.get("token") or "").strip(),
    }


def decode_apple_token_payload(token: str) -> dict[str, Any]:
    """解码 JWT payload（Apple token 为 ES256 JWT）。"""
    try:
        part = str(token or "").split(".")[1]
        padded = part.replace("-", "+").replace("_", "/")
        padded += "=" * (-len(padded) % 4)
        data = json.loads(base64.b64decode(padded).decode("utf-8"))
        return data if isinstance(data, dict) else {}
    except (IndexError, ValueError, TypeError):
        return {}


def is_apple_token_expired(token: str) -> bool:
    try:
        exp = float(decode_apple_token_payload(token).get("exp") or 0)
    except (TypeError, ValueError):
        exp = 0
    return exp > 0 and exp * 1000 < time.time() * 1000 + 60 * 1000


def extract_apple_tokens(js: str) -> list[str]:
    """从 index JS 中提取所有 JWT 形态的候选 token（含引号前缀的主匹配 + 无前缀回退）。"""
    pattern = r"(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})"
    found: list[str] = []
    found.extend(m.group(1) for m in re.finditer(rf"""(?:=["']){pattern}""", str(js or "")))
    if not found:
        found.extend(m.group(1) for m in re.finditer(pattern, str(js or "")))
    # 去重且保持顺序
    return list(dict.fromkeys(found))


def pick_apple_token(js: str) -> str:
    """选择可用 token：优先 issuer=AMPWebPlay，其次第一个未过期；全部过期视为抓取失败。"""
    tokens = extract_apple_tokens(js)
    if not tokens:
        return ""
    alive = [token for token in tokens if not is_apple_token_expired(token)]
    if not alive:
        return ""
    preferred = next(
        (token for token in alive if str(decode_apple_token_payload(token).get("iss") or "") == "AMPWebPlay"), None
    )
    return preferred or alive[0] or ""


async def fetch_follow(url: str, headers: dict[str, str] | None = None, max_hops: int = 5) -> HttpResponse:
    """手动跟随 3xx（httpFetch 不自动跟跳；Apple 首页 → /cn → /cn/new 有两跳）。"""
    current = str(url)
    response = None
    for _hop in range(max_hops):
        response = await http_fetch(current, headers=headers or {}, timeout=20_000)
        status = response.status_code or 0
        location = response.headers.get("location", "")
        if 300 <= status < 400 and location:
            current = urljoin(current, location)
            continue
        return response
    raise RuntimeError("apple: too many redirects")


def _response_text(response: HttpResponse) -> str:
    if isinstance(response.body, str):
        return response.body
    if response.raw:
        return response.raw.decode("utf-8", errors="replace")
    return str(response.body or "")


async def fetch_apple_token() -> str:
    """上游 fetchAppleToken：首页 → index-legacy JS → bearer token。"""
    home = await fetch_follow(APPLE_HOMEPAGE_URL, {"User-Agent": APPLE_UA})
    if home.status_code != 200:
        raise RuntimeError(f"apple: fetch homepage error: HTTP {home.status_code}")
    html = _response_text(home)

    # 上游：/(assets/index-legacy[~\-][^/"]+\.js)；当前构建为 index-legacy~hash.js（回退主入口 index~hash.js）
    match = re.search(r"/(assets/index-legacy[~-][^/\"']+\.js)", html)
    if not match:
        match = re.search(r"/(assets/index[~-][^/\"']+\.js)", html)
    if not match:
        raise RuntimeError("apple: index.js URI not found")

    js_res = await fetch_follow(f"{APPLE_HOMEPAGE_URL}/{match.group(1)}", {"User-Agent": APPLE_UA})
    if js_res.status_code != 200:
        raise RuntimeError(f"apple: fetch index.js error: HTTP {js_res.status_code}")
    token = pick_apple_token(_response_text(js_res))
    if not token:
        raise RuntimeError("apple: token not found in index.js")
    return token


async def get_apple_token(force: bool = False) -> str:
    """获取 developer token（缓存 + JWT exp 校验 + 并发去重）。"""
    global _cached_token, _cached_at
    cfg = get_apple_config()
    if not force and not _bypass_explicit_token and cfg["token"]:
        return cfg["token"]
    if (
        not force
        and _cached_token
        and time.time() * 1000 - _cached_at < TOKEN_CACHE_TTL_MS
        and not is_apple_token_expired(_cached_token)
    ):
        return _cached_token
    async with _token_lock:
        # 双检：并发调用者拿到锁后直接复用前一次抓取结果
        cfg = get_apple_config()
        if not force and not _bypass_explicit_token and cfg["token"]:
            return cfg["token"]
        if (
            not force
            and _cached_token
            and time.time() * 1000 - _cached_at < TOKEN_CACHE_TTL_MS
            and not is_apple_token_expired(_cached_token)
        ):
            return _cached_token
        token = await fetch_apple_token()
        _cached_token = token
        _cached_at = time.time() * 1000
        return token


def invalidate_apple_token() -> None:
    """清除缓存 token（401/403 时调用，下次请求会回源重取）。"""
    global _cached_token, _cached_at, _bypass_explicit_token
    _cached_token = ""
    _cached_at = 0.0
    _bypass_explicit_token = True


def reset_apple_token_state() -> None:
    """仅测试/调试用：重置内存态。"""
    global _cached_token, _cached_at, _bypass_explicit_token
    _cached_token = ""
    _cached_at = 0.0
    _bypass_explicit_token = False


def apple_amp_headers(token: str) -> dict[str, str]:
    cfg = get_apple_config()
    headers = {
        "Authorization": f"Bearer {token}",
        "Origin": APPLE_HOMEPAGE_URL,
        "Referer": f"{APPLE_HOMEPAGE_URL}/",
        "User-Agent": APPLE_UA,
        "Accept": "application/json",
    }
    # 上游 ampHeaders：cookie 中的 media-user-token 作为 Cookie 携带
    if cfg["mediaUserToken"]:
        headers["Cookie"] = f"media-user-token={cfg['mediaUserToken']}"
    return headers


def build_apple_amp_url(uri: str, params: dict[str, Any] | None = None) -> str:
    """拼接 amp-api URL：支持以 '/' 开头的路径与 next 返回的完整 URL。"""
    raw = str(uri or "")
    if re.match(r"^https?://", raw, re.IGNORECASE):
        base = raw
    elif raw.startswith("/"):
        base = APPLE_AMP_API_URL + raw
    else:
        base = f"{APPLE_AMP_API_URL}/{raw}"
    pairs = [(key, str(value)) for key, value in (params or {}).items() if value is not None and value != ""]
    if not pairs:
        return base
    query = urlencode(pairs)
    return base + ("&" if "?" in base else "?") + query


def _amp_error_detail(response: HttpResponse) -> str:
    body = response.body if isinstance(response.body, dict) else {}
    errors = as_list(body.get("errors"))
    first = as_dict(errors[0]) if errors else {}
    return str(first.get("detail") or first.get("title") or "")


async def apple_amp_get_tracked(uri: str, params: dict[str, Any] | None = None) -> Any:
    """amp-api GET（带 token 失效重取：401/403 时清缓存重试一次）。"""
    url = build_apple_amp_url(uri, params)

    async def attempt() -> HttpResponse:
        token = await get_apple_token()
        return await http_fetch(url, headers=apple_amp_headers(token), timeout=20_000)

    response = await attempt()
    if response.status_code in (401, 403):
        invalidate_apple_token()
        response = await attempt()
    if not (200 <= response.status_code < 300):
        detail = _amp_error_detail(response)
        raise RuntimeError(f"apple amp-api HTTP {response.status_code}{f': {detail}' if detail else ''}")
    return response.body


async def apple_amp_get(uri: str, params: dict[str, Any] | None = None) -> Any:
    return await apple_amp_get_tracked(uri, params)


#: 拉取 relationships.tracks 全部分页时的页数上限（防死循环）
MAX_TRACK_PAGES = 20


async def fetch_all_track_resources(tracks: Any) -> list[Any]:
    """拉取某资源 relationships.tracks 的全部分页（上游 fetchAllTrackResources）。"""
    tracks = as_dict(tracks)
    all_tracks: list[Any] = list(as_list(tracks.get("data")))
    next_uri = str(tracks.get("next") or "").strip()
    page = 0
    while next_uri and page < MAX_TRACK_PAGES:
        body = as_dict(await apple_amp_get_tracked(next_uri))
        all_tracks.extend(as_list(body.get("data")))
        next_uri = str(body.get("next") or "").strip()
        page += 1
    return all_tracks


def apple_artwork_url(artwork: Any, size: int = 600) -> str:
    """上游 appleArtwork.CoverURL(size)：替换 {w}/{h} 占位。"""
    artwork = as_dict(artwork)
    url = str(artwork.get("url") or "")
    if not url:
        return ""
    return url.replace("{w}", str(size)).replace("{h}", str(size))


def _round_number(value: Any) -> int:
    """JS Math.round 的等价实现（.5 向上取整）。"""
    import math

    try:
        number = float(value or 0)
    except (TypeError, ValueError):
        number = 0.0
    return math.floor(number + 0.5)


def apple_song_from_catalog(res: Any, default_album_id: str = "") -> dict[str, Any]:
    """上游 appleSongFromCatalog → 契约 Song 形状。"""
    res = as_dict(res)
    attr = as_dict(res.get("attributes"))
    previews = as_list(attr.get("previews"))
    preview_url = str(as_dict(previews[0]).get("url") or "") if previews else ""
    duration_sec = _round_number(float(attr.get("durationInMillis") or 0) / 1000)
    return {
        "songmid": str(res.get("id") or ""),
        "name": attr.get("name") or "",
        "singer": attr.get("artistName") or "",
        "albumId": str(attr.get("albumId") or default_album_id or ""),
        "albumName": attr.get("albumName") or "",
        "interval": format_play_time(duration_sec),
        "img": apple_artwork_url(attr.get("artwork"), 600) or None,
        "lrc": None,
        "types": [],
        "_types": {},
        "source": "apple",
        "link": attr.get("url") or "",  # music.apple.com 网页地址
        "previewUrl": preview_url,  # 30-90 秒试听片段直链（Apple 不提供完整曲目明文流）
        "duration": duration_sec,
        "isrc": attr.get("isrc") or "",
    }


def apple_album_to_playlist(res: Any) -> dict[str, Any]:
    """上游 appleAlbumToPlaylist → 契约歌单/专辑摘要。"""
    res = as_dict(res)
    attr = as_dict(res.get("attributes"))
    notes = as_dict(attr.get("editorialNotes"))
    return {
        "id": str(res.get("id") or ""),
        "name": attr.get("name") or "",
        "cover": apple_artwork_url(attr.get("artwork"), 300),
        "trackCount": int(attr.get("trackCount") or 0),
        "creator": attr.get("artistName") or "",
        "description": notes.get("short") or "",
        "link": attr.get("url") or "",
        "source": "apple",
        "extra": {
            "release_date": attr.get("releaseDate") or "",
            "record_label": attr.get("recordLabel") or "",
        },
    }


def apple_playlist_to_playlist(res: Any) -> dict[str, Any]:
    """上游 applePlaylistToPlaylist → 契约歌单摘要（description 四级回退同上游）。"""
    res = as_dict(res)
    attr = as_dict(res.get("attributes"))
    description = as_dict(attr.get("description"))
    notes = as_dict(attr.get("editorialNotes"))
    desc = description.get("short") or description.get("standard") or notes.get("short") or notes.get("standard") or ""
    return {
        "id": str(res.get("id") or ""),
        "name": attr.get("name") or "",
        "cover": apple_artwork_url(attr.get("artwork"), 300),
        "trackCount": int(attr.get("trackCount") or 0),
        "creator": attr.get("curatorName") or "",
        "description": desc,
        "link": attr.get("url") or "",
        "source": "apple",
    }


def apple_web_url(kind: str, media_id: str, storefront: str = DEFAULT_STOREFRONT) -> str:
    sf = str(storefront or DEFAULT_STOREFRONT)
    return f"{APPLE_HOMEPAGE_URL}/{sf}/{kind}/{media_id}"


def is_apple_raw_id(value: str, media_type: str) -> bool:
    """上游 isAppleRawID：裸 id 判定（playlist 支持 pl.* / 字母数字，其余要求纯数字）。"""
    if re.search(r"[/?#]", value) or "://" in value:
        return False
    if media_type == "playlist":
        if value.startswith("pl."):
            return re.fullmatch(r"[a-zA-Z0-9._-]+", value) is not None
        return re.fullmatch(r"[a-zA-Z0-9_-]+", value) is not None
    return re.fullmatch(r"\d+", value) is not None


def extract_apple_id_from_path(path: str, media_type: str) -> str:
    """上游 extractAppleIDFromPath：在 path 段中找 <type>/<name>/<id> 或 <type>/<id>。"""
    trimmed = re.sub(r"^/+|/+$", "", str(path or ""))
    if not trimmed:
        return ""
    segments = trimmed.split("/")
    for index, segment in enumerate(segments):
        if segment != media_type and segment != f"{media_type}s":
            continue
        if index + 2 < len(segments):
            return segments[index + 2]
        if index + 1 < len(segments):
            return segments[index + 1]
    return ""


def extract_apple_id(link: str, media_type: str) -> str:
    """上游 extractAppleID：裸 id / 链接（含地区段与 ?i= 单曲参数）/ 正则兜底。"""
    raw = str(link or "").strip()
    if not raw:
        return ""
    if is_apple_raw_id(raw, media_type):
        return raw

    path = ""
    query = ""
    try:
        parts = urlsplit(raw)
        if parts.scheme or parts.netloc:
            path = parts.path or ""
            query = f"?{parts.query}" if parts.query else ""
    except ValueError:
        path, query = "", ""
    if not path:
        idx = raw.find("?")
        path = raw[:idx] if idx >= 0 else raw
        query = raw[idx:] if idx >= 0 else ""

    if path:
        if media_type == "song":
            values = parse_qs(query.lstrip("?"), keep_blank_values=True).get("i")
            song_id = values[0].strip() if values else ""
            if song_id:
                return song_id
        from_path = extract_apple_id_from_path(path, media_type)
        if from_path:
            return from_path

    patterns = [
        rf"{media_type}/[^/]+/(\d+)",
        rf"{media_type}s?/[^/]+/[^/]+/(\d+)",
        r"/(\d+)$",
        r"[?&]i=(\d+)",
    ]
    if media_type == "playlist":
        patterns.extend(
            [
                r"playlists?/[^/?#]+/([a-zA-Z0-9._-]+)",
                r"playlists?/([a-zA-Z0-9._-]+)(?:[?#]|$)",
            ]
        )
    for pattern in patterns:
        match = re.search(pattern, raw)
        if match:
            return match.group(1)
    return ""


async def fetch_apple_song_resource(song_id: str, include: str = "") -> Any:
    """歌曲详情（上游 Parse/GetLyrics/GetDownloadURL 共用的 /v1/catalog/<sf>/songs/<id>）。"""
    cfg = get_apple_config()
    params: dict[str, Any] = {"extend": "extendedAssetUrls"}
    if include:
        params["include"] = include
    body = as_dict(await apple_amp_get(f"/v1/catalog/{cfg['storefront']}/songs/{song_id}", params))
    data = as_list(body.get("data"))
    return data[0] if data else None


def quote_path_segment(value: str) -> str:
    """路径段转义（ID 基本是字母数字，保留以免未来出现特殊字符）。"""
    return quote(str(value), safe="._-")
