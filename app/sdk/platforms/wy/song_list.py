"""网易云歌单（移植 sdk/wy/songList.ts）。

四条数据源：
  * playlist/list（weapi）        → get_list：分类歌单列表
  * playlist/catalogue + hottags  → get_tag / get_hot_tag：分类与热门标签
  * linux/forward + v3/playlist/detail → get_list_detail：歌单详情与曲目
  * cloudsearch pc（eapi，type=1000） → search：歌单搜索
`getListId` 负责把「歌单链接 / 裸 id / id###token」归一成纯 id。
"""

from __future__ import annotations

import asyncio
import re
from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.common.utils import date_format, format_play_count, format_play_time, format_singer_name, size_formate
from app.sdk.platforms.wy import music_detail
from app.sdk.platforms.wy.utils import UA_LINUX_CHROME, eapi_request, weapi_headers
from app.sdk.platforms.wy.utils.crypto import linuxapi, weapi

LIMIT_LIST = 30
LIMIT_SONG = 100000
SUCCESS_CODE = 200
DEFAULT_COOKIE = "MUSIC_U="

SORT_LIST = [{"name": "最热", "id": "hot"}]
# 路由读 module.song_list.sort_list 取默认排序，必须与路由约定同名（小写）
sort_list = SORT_LIST

RX_LIST_DETAIL_LINK = re.compile(r"^.+(?:\?|&)id=(\d+)(?:&.*$|#.*$|$)")
RX_LIST_DETAIL_LINK2 = re.compile(r"^.+/playlist/(\d+)/\d+/.+$")

# 歌单详情用的 MUSIC_U（原实现把它存在模块状态上：id 里带 ###token 时会被记住）
_state: dict[str, str] = {"cookie": DEFAULT_COOKIE}


async def handle_parse_id(link: str, retry_num: int = 0) -> str:
    """跟随重定向（最多 2 次）后从最终 URL 里取出歌单 id。"""
    if retry_num > 2:
        raise RuntimeError("link try max num")

    resp = await http_fetch(link)
    if resp.status_code > 400:
        return await handle_parse_id(link, retry_num + 1)
    location = resp.header("location")
    url = location if location else link
    if RX_LIST_DETAIL_LINK.match(url):
        return RX_LIST_DETAIL_LINK.sub(r"\1", url)
    return RX_LIST_DETAIL_LINK2.sub(r"\1", url)


async def get_list_id(raw_id: str) -> dict[str, str | None]:
    """把歌单链接/裸 id/`id###token` 归一成 {id, cookie}。"""
    cookie: str | None = None
    id_ = raw_id
    if "###" in id_:
        url, _, token = id_.partition("###")
        id_ = url
        cookie = f"MUSIC_U={token}"
    if re.search(r"[?&:/]", id_):
        if RX_LIST_DETAIL_LINK.match(id_):
            id_ = RX_LIST_DETAIL_LINK.sub(r"\1", id_)
        elif RX_LIST_DETAIL_LINK2.match(id_):
            id_ = RX_LIST_DETAIL_LINK2.sub(r"\1", id_)
        else:
            id_ = await handle_parse_id(id_)
    return {"id": id_, "cookie": cookie}


def _size_of(block: Any) -> str | None:
    if isinstance(block, dict) and block.get("size"):
        return size_formate(block["size"])
    return None


def filter_list_detail(playlist: dict[str, Any], privileges: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """歌单详情曲目 → SongInfo。原实现此处 flac 的 size 恒为 None，保持一样。"""
    tracks = playlist.get("tracks") or []
    rows: list[dict[str, Any]] = []
    for index, item in enumerate(tracks):
        if not isinstance(item, dict):
            continue
        privilege = privileges[index] if index < len(privileges) else None
        if not isinstance(privilege, dict) or privilege.get("id") != item.get("id"):
            privilege = next((p for p in privileges if isinstance(p, dict) and p.get("id") == item.get("id")), None)
        if privilege is None:
            continue

        types, _types = music_detail.build_types(item, privilege, flac_size=False)
        album = item.get("al") or {}
        pc = item.get("pc")
        if pc:
            rows.append(
                {
                    "singer": pc.get("ar") or "",
                    "name": pc.get("sn") or "",
                    "albumName": pc.get("alb") or "",
                    "albumId": album.get("id"),
                    "source": "wy",
                    "interval": format_play_time((item.get("dt") or 0) / 1000),
                    "songmid": item.get("id"),
                    "img": album.get("picUrl") or "",
                    "lrc": None,
                    "otherSource": None,
                    "types": types,
                    "_types": _types,
                    "typeUrl": {},
                }
            )
        else:
            rows.append(
                {
                    "singer": format_singer_name(item.get("ar"), "name"),
                    "name": item.get("name") or "",
                    "albumName": album.get("name"),
                    "albumId": album.get("id"),
                    "source": "wy",
                    "interval": format_play_time((item.get("dt") or 0) / 1000),
                    "songmid": item.get("id"),
                    "img": album.get("picUrl"),
                    "lrc": None,
                    "otherSource": None,
                    "types": types,
                    "_types": _types,
                    "typeUrl": {},
                }
            )
    return rows


async def get_list_detail(raw_id: str, page: int = 1, try_num: int = 0) -> dict[str, Any]:
    """歌单详情（linux/forward 转发 v3/playlist/detail）。失败重试 3 次。"""
    if try_num > 2:
        raise RuntimeError("try max num")

    resolved = await get_list_id(str(raw_id or ""))
    id_ = str(resolved["id"] or "")
    if resolved["cookie"]:
        _state["cookie"] = str(resolved["cookie"])

    headers = {"User-Agent": UA_LINUX_CHROME, "Cookie": _state["cookie"]}
    form = linuxapi(
        {
            "method": "POST",
            "url": "https://music.163.com/api/v3/playlist/detail",
            "params": {"id": id_, "n": LIMIT_SONG, "s": 8},
        }
    )
    resp = await http_fetch("https://music.163.com/api/linux/forward", method="post", headers=headers, form=form)
    body = resp.body if isinstance(resp.body, dict) else {}
    if resp.status_code != 200 or body.get("code") != SUCCESS_CODE:
        return await get_list_detail(id_, page, try_num + 1)

    limit = 1000
    playlist = body.get("playlist") or {}
    track_ids = [track.get("id") for track in playlist.get("trackIds") or [] if isinstance(track, dict)]
    privileges = body.get("privileges") or []

    if len(track_ids) == len(privileges):
        rows = filter_list_detail(playlist, privileges)
    else:
        range_start = (page - 1) * limit
        slice_ids = track_ids[range_start : limit * page]
        try:
            rows = (await music_detail.get_list(slice_ids))["list"]
        except Exception as err:
            print(f"[wy] 歌单歌曲详情获取失败将重试({try_num + 1}): {err}")
            if str(err) == "try max num":
                raise
            return await get_list_detail(id_, page, try_num + 1)

    creator = playlist.get("creator") or {}
    return {
        "list": rows,
        "page": page,
        "limit": limit,
        "total": len(track_ids),
        "source": "wy",
        "info": {
            "play_count": format_play_count(playlist.get("playCount")),
            "name": playlist.get("name"),
            "img": playlist.get("coverImgUrl"),
            "desc": playlist.get("description"),
            "author": creator.get("nickname"),
        },
    }


def filter_list(raw_data: Any) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in raw_data or []:
        if not isinstance(item, dict):
            continue
        creator = item.get("creator") or {}
        rows.append(
            {
                "play_count": format_play_count(item.get("playCount")),
                "id": str(item.get("id")),
                "author": creator.get("nickname"),
                "name": item.get("name"),
                "time": date_format(item.get("createTime"), "Y-M-D") if item.get("createTime") else "",
                "img": item.get("coverImgUrl"),
                "grade": item.get("grade"),
                "total": item.get("trackCount"),
                "desc": item.get("description"),
                "source": "wy",
            }
        )
    return rows


async def get_list(sort_id: Any, tag_id: Any, page: int = 1, try_num: int = 0) -> dict[str, Any]:
    """分类歌单列表（weapi/playlist/list）。失败重试 3 次。"""
    if try_num > 2:
        raise RuntimeError("try max num")

    form = weapi(
        {
            "cat": tag_id or "全部",
            "order": sort_id,
            "limit": LIMIT_LIST,
            "offset": LIMIT_LIST * (page - 1),
            "total": True,
        }
    )
    resp = await http_fetch(
        "https://music.163.com/weapi/playlist/list", method="post", headers=weapi_headers(with_cookie=False), form=form
    )
    body = resp.body if isinstance(resp.body, dict) else {}
    if body.get("code") != SUCCESS_CODE:
        return await get_list(sort_id, tag_id, page, try_num + 1)

    try:
        total = int(body.get("total") or 0)
    except (TypeError, ValueError):
        total = 0
    return {
        "list": filter_list(body.get("playlists")),
        "total": total,
        "page": page,
        "limit": LIMIT_LIST,
        "source": "wy",
    }


def filter_tag_info(body: dict[str, Any]) -> list[dict[str, Any]]:
    categories = body.get("categories") or {}
    grouped: dict[Any, list[dict[str, Any]]] = {}
    for item in body.get("sub") or []:
        if not isinstance(item, dict):
            continue
        category = item.get("category")
        grouped.setdefault(category, []).append(
            {
                "parent_id": categories.get(category),
                "parent_name": categories.get(category),
                "id": item.get("name"),
                "name": item.get("name"),
                "source": "wy",
            }
        )
    return [{"name": categories[key], "list": grouped.get(key), "source": "wy"} for key in categories]


async def get_tag(try_num: int = 0) -> list[dict[str, Any]]:
    """歌单分类树（weapi/playlist/catalogue）。失败重试 3 次。"""
    if try_num > 2:
        raise RuntimeError("try max num")
    resp = await http_fetch(
        "https://music.163.com/weapi/playlist/catalogue",
        method="post",
        headers=weapi_headers(with_cookie=False),
        form=weapi({}),
    )
    body = resp.body if isinstance(resp.body, dict) else {}
    if body.get("code") != SUCCESS_CODE:
        return await get_tag(try_num + 1)
    return filter_tag_info(body)


def filter_hot_tag_info(raw_list: Any) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in raw_list or []:
        tag = (item or {}).get("playlistTag") or {}
        if not tag.get("name"):
            continue
        rows.append({"id": tag.get("name"), "name": tag.get("name"), "source": "wy"})
    return rows


async def get_hot_tag(try_num: int = 0) -> list[dict[str, Any]]:
    """热门标签（weapi/playlist/hottags）。失败重试 3 次。"""
    if try_num > 2:
        raise RuntimeError("try max num")
    resp = await http_fetch(
        "https://music.163.com/weapi/playlist/hottags",
        method="post",
        headers=weapi_headers(with_cookie=False),
        form=weapi({}),
    )
    body = resp.body if isinstance(resp.body, dict) else {}
    if body.get("code") != SUCCESS_CODE:
        # 原实现此处误调 get_tag（返回形状不同），这里同样退回分类接口以保持行为可预期
        return await get_tag(try_num + 1)
    return filter_hot_tag_info(body.get("tags"))


async def get_tags() -> dict[str, Any]:
    tags, hot_tag = await asyncio.gather(get_tag(), get_hot_tag())
    return {"tags": tags, "hotTag": hot_tag, "source": "wy"}


async def get_detail_page_url(raw_id: str) -> str:
    resolved = await get_list_id(str(raw_id or ""))
    return f"https://music.163.com/#/playlist?id={resolved['id']}"


async def search(text: str, page: int = 1, limit: int = 20) -> dict[str, Any]:
    """歌单搜索（eapi cloudsearch pc type=1000）。失败文案与原文一致：filed。"""
    resp = await eapi_request(
        "/api/cloudsearch/pc",
        {"s": text, "type": 1000, "limit": limit, "total": page == 1, "offset": limit * (page - 1)},
    )
    body = resp.body if isinstance(resp.body, dict) else {}
    if body.get("code") != SUCCESS_CODE:
        raise RuntimeError("filed")
    result = body.get("result") or {}
    return {
        "list": filter_list(result.get("playlists")),
        "limit": limit,
        "total": result.get("playlistCount"),
        "source": "wy",
    }
