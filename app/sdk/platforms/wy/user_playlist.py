"""网易云个人歌单（移植自 sdk/wy/userPlaylist.ts，上游 music-lib/netease/user_playlist.go）。

需登录 cookie MUSIC_U（app/sdk/auth_store.py 的 get_credentials('wy')）：
未登录直接抛清晰错误，不返回空列表 —— 空列表会被前端当成「用户没有歌单」。
  1) weapi/nuser/account/get → 当前用户 userId
  2) weapi/user/playlist    → 用户歌单列表（分页 limit/offset）
"""

from __future__ import annotations

from typing import Any

from app.sdk.auth_store import get_credentials, get_wy_cookie
from app.sdk.common.request import http_fetch
from app.sdk.common.utils import format_play_count
from app.sdk.platforms.wy.utils import UA_LINUX_CHROME
from app.sdk.platforms.wy.utils.crypto import weapi

PLAYLIST_LINK = "https://music.163.com/#/playlist?id={}"


def playlist_link(playlist_id: str) -> str:
    return PLAYLIST_LINK.format(playlist_id)


def read_cookie() -> str:
    """优先用 musicU 拼 MUSIC_U，其次退回已存 cookie / 通用 cookie。"""
    cred = get_credentials("wy") or {}
    music_u = str(cred.get("musicU") or "").strip()
    if music_u:
        return f"MUSIC_U={music_u}"
    return str(cred.get("cookie") or get_wy_cookie()).strip()


async def _weapi_post(url: str, data: dict[str, Any], cookie: str) -> dict[str, Any]:
    resp = await http_fetch(
        url,
        method="post",
        headers={
            "User-Agent": UA_LINUX_CHROME,
            "Referer": "https://music.163.com/",
            "origin": "https://music.163.com",
            "Content-Type": "application/x-www-form-urlencoded",
            "Cookie": cookie,
        },
        form=weapi(data),
        timeout=15000,
    )
    body = resp.body
    if resp.status_code != 200 or not isinstance(body, dict):
        raise RuntimeError("wy 个人歌单接口请求失败")
    return body


async def get_list(page: int = 1, limit: int = 30) -> dict[str, Any]:
    """个人歌单列表。未登录 / 登录态失效抛 RuntimeError，不返回空列表。"""
    cookie = read_cookie()
    if not cookie:
        raise RuntimeError("wy 个人歌单需要登录 cookie（MUSIC_U），请先登录网易云")

    safe_page = max(1, int(page or 1))
    safe_limit = int(limit or 30)
    if safe_limit <= 0:
        safe_limit = 30
    if safe_limit > 100:
        safe_limit = 100

    account = await _weapi_post("https://music.163.com/weapi/nuser/account/get", {"csrf_token": ""}, cookie)
    profile = account.get("profile") or {}
    if account.get("code") != 200 or not profile.get("userId"):
        raise RuntimeError(f"wy 登录态无效或已过期 (code {account.get('code', 'unknown')})")
    uid = profile.get("userId")
    nickname = profile.get("nickname") or ""

    body = await _weapi_post(
        "https://music.163.com/weapi/user/playlist",
        {
            "uid": uid,
            "limit": safe_limit,
            "offset": (safe_page - 1) * safe_limit,
            "includeVideo": True,
            "csrf_token": "",
        },
        cookie,
    )
    if body.get("code") != 200:
        raise RuntimeError(f"wy 个人歌单获取失败 (code {body.get('code')})")

    rows: list[dict[str, Any]] = []
    for item in body.get("playlist") or []:
        if not isinstance(item, dict):
            continue
        id_ = str(item.get("id") or "").strip()
        if not id_:
            continue
        play_count = int(item.get("playCount") or 0)
        creator = str((item.get("creator") or {}).get("nickname") or "").strip() or nickname
        rows.append(
            {
                "id": id_,
                "name": item.get("name") or "",
                "cover": item.get("coverImgUrl") or "",
                "trackCount": int(item.get("trackCount") or 0),
                "playCount": play_count,
                "play_count": format_play_count(play_count),
                "creator": creator,
                "description": item.get("description") or "",
                "subscribed": bool(item.get("subscribed")),
                "link": playlist_link(id_),
                "source": "wy",
            }
        )

    return {"list": rows, "page": safe_page, "limit": safe_limit, "total": len(rows), "source": "wy"}


get_user_playlists = get_list
