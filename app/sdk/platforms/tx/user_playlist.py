"""QQ音乐个人歌单（移植自 sdk/tx/userPlaylist.ts）。

需登录 cookie（auth_store.get_tx_auth 返回的 cookie，须含 uin 类字段）：
未登录 / cookie 里取不到 uin 时**抛出清晰错误**，不静默返回空列表（与原文一致）。

三路数据源，结果按 id 去重：
  1) fcg_user_created_diss             → 自建歌单
  2) fcg_get_profile_order_asset reqtype=3 → 收藏歌单
  3) fcg_get_profile_order_asset reqtype=1 → 「我喜欢的歌曲」虚拟歌单摘要（有歌才附上）

虚拟条目 id 固定为 `profile:favorites`（与原文一致），其歌曲需凭 cookie 走同一接口拉取。
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlencode

from app.sdk.auth_store import get_tx_auth
from app.sdk.common.request import http_fetch
from app.sdk.common.utils import format_play_count

_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
FAVORITE_ID = "profile:favorites"
FAVORITE_NAME = "我喜欢的歌曲"

_CREATED_URL = "https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss"
_PROFILE_ASSET_URL = "https://c.y.qq.com/fav/fcgi-bin/fcg_get_profile_order_asset.fcg"

# 上游 normalizeQQUIN 的候选键，按序取第一个非空
_UIN_KEYS = (
    "wxuin",
    "uin",
    "ptui_loginuin",
    "luin",
    "pt2gguin",
    "superuin",
    "p_uin",
    "musicid",
    "userid",
)


def cookie_value(cookie: str, key: str) -> str:
    for part in cookie.split(";"):
        name, sep, value = part.strip().partition("=")
        if sep and name.strip() == key:
            return value.strip()
    return ""


def normalize_qq_uin(cookie: str) -> str:
    """cookie → uin（去前导 `o` 与 `0`，与原文 normalizeQQUIN 一致）。"""
    raw = ""
    for key in _UIN_KEYS:
        value = cookie_value(cookie, key)
        if value:
            raw = value
            break
    return raw.removeprefix("o").lstrip("0").strip()


def _playlist_link(playlist_id: str) -> str:
    return f"https://y.qq.com/n/ryqq/playlist/{playlist_id}"


def _normalize_cover(cover: Any) -> str:
    value = str(cover or "").strip()
    if value.startswith("//"):
        return f"https:{value}"
    if value.startswith("http://"):
        return value.replace("http://", "https://", 1)
    return value


def _make_summary(
    playlist_id: str,
    name: str,
    *,
    cover: Any = "",
    track_count: Any = 0,
    play_count: Any = 0,
    creator: Any = "",
    description: Any = "",
    link: str | None = None,
) -> dict[str, Any]:
    count = int(play_count or 0)
    return {
        "id": playlist_id,
        "name": name,
        "cover": _normalize_cover(cover),
        "trackCount": int(track_count or 0),
        "playCount": count,
        "play_count": format_play_count(count),
        "creator": str(creator or ""),
        "description": str(description or ""),
        "link": link or _playlist_link(playlist_id),
        "source": "tx",
    }


def _profile_asset_url(uin: str, reqtype: str, page: int, limit: int) -> str:
    offset = (max(1, page) - 1) * limit
    query = urlencode(
        {
            "format": "json",
            "inCharset": "utf8",
            "outCharset": "utf-8",
            "platform": "yqq.json",
            "needNewCode": "0",
            "loginUin": uin,
            "hostUin": "0",
            "notice": "0",
            "g_tk": "5381",
            "ct": "20",
            "cid": "205360956",
            "userid": uin,
            "reqtype": reqtype,
            "sin": str(offset),
            "ein": str(offset + limit - 1),
        }
    )
    return f"{_PROFILE_ASSET_URL}?{query}"


async def _fetch_json(url: str, cookie: str) -> dict[str, Any]:
    resp = await http_fetch(
        url,
        headers={"User-Agent": _UA, "Referer": "https://y.qq.com/", "Cookie": cookie},
        timeout=15000,
    )
    body = resp.body if isinstance(resp.body, dict) else None
    if resp.status_code != 200 or body is None:
        raise RuntimeError("tx 个人歌单接口请求失败")
    return body


async def _fetch_created(cookie: str, uin: str, page: int, limit: int) -> list[dict[str, Any]]:
    """自建歌单（fcg_user_created_diss）。id 优先级：dissid > tid > profile:dir:<dirid>。"""
    query = urlencode(
        {
            "hostuin": uin,
            "sin": str((page - 1) * limit),
            "size": str(limit),
            "format": "json",
            "inCharset": "utf8",
            "outCharset": "utf-8",
        }
    )
    body = await _fetch_json(f"{_CREATED_URL}?{query}", cookie)
    if body.get("code") != 0:
        raise RuntimeError(f"tx 自建歌单获取失败: {body.get('message') or ''} (code {body.get('code')})")

    data = body.get("data") or {}
    rows: list[dict[str, Any]] = []
    for item in data.get("disslist") or []:
        if not isinstance(item, dict):
            continue
        diss_id = int(item.get("dissid") or 0)
        tid = int(item.get("tid") or 0)
        dir_id = int(item.get("dirid") or 0)
        if diss_id > 0:
            playlist_id = str(diss_id)
        elif tid > 0:
            playlist_id = str(tid)
        elif dir_id > 0:
            playlist_id = f"profile:dir:{dir_id}"
        else:
            playlist_id = ""
        name = str(item.get("diss_name") or item.get("title") or "").strip()
        if not playlist_id or not name:
            continue
        rows.append(
            _make_summary(
                playlist_id,
                name,
                cover=item.get("diss_cover") or item.get("cover"),
                track_count=item.get("song_count") or item.get("song_num") or item.get("song_cnt") or 0,
                play_count=item.get("listen_num") or item.get("visitnum") or 0,
                creator=uin,
                description=item.get("diss_desc") or item.get("desc") or "",
            )
        )
    for item in data.get("list") or []:
        if not isinstance(item, dict):
            continue
        playlist_id = str(item.get("dissid") or "").strip()
        name = str(item.get("dissname") or "").strip()
        if not playlist_id or not name:
            continue
        rows.append(
            _make_summary(
                playlist_id,
                name,
                cover=item.get("imgurl"),
                track_count=item.get("song_count") or item.get("song_num") or 0,
                play_count=item.get("listennum") or 0,
                creator=uin,
                description=item.get("introduction") or "",
            )
        )
    return rows


async def _fetch_collected(cookie: str, uin: str, page: int, limit: int) -> list[dict[str, Any]]:
    """收藏歌单（fcg_get_profile_order_asset reqtype=3）。code 非 0 时返回空列表（同原文）。"""
    body = await _fetch_json(_profile_asset_url(uin, "3", page, limit), cookie)
    if body.get("code") != 0:
        return []
    rows: list[dict[str, Any]] = []
    for item in (body.get("data") or {}).get("cdlist") or []:
        if not isinstance(item, dict):
            continue
        diss_id = int(item.get("dissid") or 0)
        name = str(item.get("dissname") or "").strip()
        if diss_id <= 0 or not name:
            continue
        rows.append(
            _make_summary(
                str(diss_id),
                name,
                cover=item.get("logo"),
                track_count=item.get("songnum") or 0,
                play_count=item.get("listennum") or 0,
                creator=item.get("nickname") or item.get("uin") or uin,
            )
        )
    return rows


async def _fetch_favorite_summary(cookie: str, uin: str) -> dict[str, Any] | None:
    """「我喜欢的歌曲」摘要（reqtype=1，limit=1）。总数为 0 时返回 None。"""
    body = await _fetch_json(_profile_asset_url(uin, "1", 1, 1), cookie)
    if body.get("code") != 0:
        return None
    data = body.get("data") or {}
    total = int(data.get("totalsong") or 0)
    if total <= 0:
        return None
    first = ((data.get("songlist") or [{}])[0] or {}).get("data") or {}
    album_mid = first.get("albummid") if isinstance(first, dict) else None
    return _make_summary(
        FAVORITE_ID,
        FAVORITE_NAME,
        cover=f"https://y.gtimg.cn/music/photo_new/T002R300x300M000{album_mid}.jpg" if album_mid else "",
        track_count=total,
        creator=uin,
        description="QQ音乐我喜欢的歌曲",
        link="https://y.qq.com/n/ryqq/profile",
    )


async def get_list(page: int = 1, limit: int = 30) -> dict[str, Any]:
    """个人歌单列表。未登录 / 缺 uin 直接抛错，不返回空列表。"""
    auth = get_tx_auth()
    cookie = str((auth or {}).get("cookie") or "").strip()
    if not cookie:
        raise RuntimeError("tx 个人歌单需要登录 cookie（请先登录 QQ音乐）")
    uin = normalize_qq_uin(cookie)
    if not uin:
        raise RuntimeError("tx 个人歌单需要 cookie 中的 uin（当前 cookie 不含 uin/wxuin 等字段）")

    safe_page = max(1, int(page or 1))
    safe_limit = int(limit or 30)
    if safe_limit <= 0:
        safe_limit = 30
    if safe_limit > 100:
        safe_limit = 100

    rows: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add(summary: dict[str, Any] | None) -> None:
        if not summary:
            return
        playlist_id = summary.get("id")
        if not playlist_id or not summary.get("name") or playlist_id in seen:
            return
        seen.add(playlist_id)
        rows.append(summary)

    try:
        add(await _fetch_favorite_summary(cookie, uin))
    except (RuntimeError, OSError, TimeoutError):
        # 摘要失败不阻塞列表（与上游一致）
        pass
    for item in await _fetch_created(cookie, uin, safe_page, safe_limit):
        add(item)
    for item in await _fetch_collected(cookie, uin, safe_page, safe_limit):
        add(item)

    return {"list": rows, "page": safe_page, "limit": safe_limit, "total": len(rows), "source": "tx"}
