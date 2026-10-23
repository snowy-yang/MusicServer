"""QQ音乐歌单广场 + 歌单详情（移植自 sdk/tx/songList.ts）。

一个模块承载三件事（原文也是这样，路由按能力位分别用）：
  * song_list —— 分类标签与分类歌单列表（get_tag / get_hot_tag / get_list）
  * playlist  —— 歌单详情（get_list_detail）与歌单搜索（search）
  * parse     —— 歌单链接 → 数字 id 归一（get_list_id，含 302 短链兜底）

分类歌单固定 36 条一页（limit_list），调用方要的 limit 在 playlist 层再切片。
"""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any
from urllib.parse import quote

from app.sdk.common.request import http_fetch
from app.sdk.common.utils import date_format, decode_name, format_play_count, format_play_time, format_singer_name
from app.sdk.platforms.tx.filter import build_types, song_img

LIMIT_LIST = 36
SUCCESS_CODE = 0

SORT_LIST: list[dict[str, Any]] = [
    {"name": "最热", "id": 5},
    {"name": "最新", "id": 2},
]

_HOT_TAG_HTML = re.compile(r'class="c_bg_link js_tag_item" data-id="\w+">.+?</a>')
_HOT_TAG = re.compile(r'data-id="(\w+)">(.+?)</a>')
# https://y.qq.com/n/yqq/playlist/7217720898.html
# https://i.y.qq.com/n2/m/share/details/taoge.html?...&id=7217720898&ADTAG=qfshare
_LIST_DETAIL_LINK = re.compile(r"/playlist/(\d+)")
_LIST_DETAIL_LINK2 = re.compile(r"id=(\d+)")

_BASE_QUERY = (
    "loginUin=0&hostUin=0&format=json&inCharset=utf-8&outCharset=utf-8&notice=0&platform=wk_v15.json&needNewCode=0"
)
TAGS_URL = f"https://u.y.qq.com/cgi-bin/musicu.fcg?{_BASE_QUERY}&data={quote(json.dumps({'tags': {'method': 'get_all_categories', 'param': {'qq': ''}, 'module': 'playlist.PlaylistAllCategoriesServer'}}, ensure_ascii=False, separators=(',', ':')), safe='')}"
HOT_TAG_URL = "https://c.y.qq.com/node/pc/wk_v15/category_playlist.html"
LIST_DETAIL_URL = (
    "https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg"
    "?type=1&json=1&utf8=1&onlysong=0&new_format=1&disstid={playlist_id}"
    "&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0"
    "&platform=yqq.json&needNewCode=0"
)
SEARCH_URL = (
    "http://c.y.qq.com/soso/fcgi-bin/client_music_search_songlist"
    "?page_no={page}&num_per_page={limit}&format=json&query={query}"
    "&remoteplace=txt.yqq.playlist&inCharset=utf8&outCharset=utf-8"
)

_UA_IE = "Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0)"


def get_list_url(sort_id: Any, tag_id: Any, page: int) -> str:
    """分类歌单列表 URL：tagId 非空走分类内容接口，否则走「全部」广场接口。"""
    if tag_id:
        data: dict[str, Any] = {
            "comm": {"cv": 1602, "ct": 20},
            "playlist": {
                "method": "get_category_content",
                "param": {
                    "titleid": int(tag_id),
                    "caller": "0",
                    "category_id": int(tag_id),
                    "size": LIMIT_LIST,
                    "page": page - 1,
                    "use_page": 1,
                },
                "module": "playlist.PlayListCategoryServer",
            },
        }
    else:
        data = {
            "comm": {"cv": 1602, "ct": 20},
            "playlist": {
                "method": "get_playlist_by_tag",
                "param": {
                    "id": 10000000,
                    "sin": LIMIT_LIST * (page - 1),
                    "size": LIMIT_LIST,
                    "order": sort_id,
                    "cur_page": page,
                },
                "module": "playlist.PlayListPlazaServer",
            },
        }
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return f"https://u.y.qq.com/cgi-bin/musicu.fcg?{_BASE_QUERY}&data={quote(payload, safe='')}"


def filter_tag_info(raw_list: Any) -> list[dict[str, Any]]:
    return [
        {
            "name": group.get("group_name"),
            "list": [
                {
                    "parent_id": group.get("group_id"),
                    "parent_name": group.get("group_name"),
                    "id": item.get("id"),
                    "name": item.get("name"),
                    "source": "tx",
                }
                for item in group.get("v_item") or []
            ],
        }
        for group in raw_list or []
    ]


def filter_info_hot_tag(html: Any) -> list[dict[str, Any]]:
    tags: list[dict[str, Any]] = []
    if not isinstance(html, str):
        return tags
    for tag_html in _HOT_TAG_HTML.findall(html):
        result = _HOT_TAG.search(tag_html)
        if not result:
            continue
        try:
            tag_id = int(result.group(1))
        except ValueError:
            continue
        tags.append({"id": tag_id, "name": result.group(2), "source": "tx"})
    return tags


def filter_list(data: dict[str, Any], page: int) -> dict[str, Any]:
    """「全部」广场分支（get_playlist_by_tag）。"""
    return {
        "list": [
            {
                "play_count": format_play_count(item.get("access_num")),
                "id": str(item.get("tid")),
                "author": (item.get("creator_info") or {}).get("nick"),
                "name": item.get("title"),
                "time": date_format(item["modify_time"] * 1000, "Y-M-D") if item.get("modify_time") else "",
                "img": item.get("cover_url_medium"),
                "total": len(item.get("song_ids") or []),
                "desc": decode_name(item.get("desc")).replace("<br>", "\n"),
                "source": "tx",
            }
            for item in data.get("v_playlist") or []
        ],
        "total": data.get("total"),
        "page": page,
        "limit": LIMIT_LIST,
        "source": "tx",
    }


def filter_list2(data: dict[str, Any], page: int) -> dict[str, Any]:
    """分类内容分支（get_category_content）。"""
    content = data.get("content") or {}
    rows: list[dict[str, Any]] = []
    for item in content.get("v_item") or []:
        basic = item.get("basic") or {}
        cover = basic.get("cover") or {}
        rows.append(
            {
                "play_count": format_play_count(basic.get("play_cnt")),
                "id": str(basic.get("tid")),
                "author": (basic.get("creator") or {}).get("nick"),
                "name": basic.get("title"),
                "img": cover.get("medium_url") or cover.get("default_url"),
                "desc": decode_name(basic.get("desc")).replace("<br>", "\n"),
                "source": "tx",
            }
        )
    return {
        "list": rows,
        "total": content.get("total_cnt"),
        "page": page,
        "limit": LIMIT_LIST,
        "source": "tx",
    }


def filter_list_detail(raw_list: Any) -> list[dict[str, Any]]:
    """歌单曲目 → SongInfo（比搜索结果多带 lrc/otherSource 两个空字段，与原文一致）。"""
    songs: list[dict[str, Any]] = []
    for item in raw_list or []:
        file = (item or {}).get("file") or {}
        types, _types = build_types(file)
        album = item.get("album") or {}
        album_name = album.get("name") or ""
        album_mid = album.get("mid") or ""
        songs.append(
            {
                "singer": format_singer_name(item.get("singer"), "name"),
                "name": item.get("title"),
                "albumName": album_name,
                "albumId": album_mid,
                "source": "tx",
                "interval": format_play_time(item.get("interval")),
                "songId": item.get("id"),
                "albumMid": album_mid,
                "strMediaMid": file.get("media_mid"),
                "songmid": item.get("mid"),
                "img": song_img("" if album_name in ("", "空") else album_mid, item.get("singer")),
                "lrc": None,
                "otherSource": None,
                "types": types,
                "_types": _types,
                "typeUrl": {},
            }
        )
    return songs


async def get_tag(retry_num: int = 0) -> list[dict[str, Any]]:
    if retry_num > 2:
        raise RuntimeError("try max num")
    resp = await http_fetch(TAGS_URL)
    body = resp.body if isinstance(resp.body, dict) else {}
    if body.get("code") != SUCCESS_CODE:
        return await get_tag(retry_num + 1)
    return filter_tag_info(((body.get("tags") or {}).get("data") or {}).get("v_group"))


async def get_hot_tag(retry_num: int = 0) -> list[dict[str, Any]]:
    if retry_num > 2:
        raise RuntimeError("try max num")
    resp = await http_fetch(HOT_TAG_URL)
    if resp.status_code != 200:
        return await get_hot_tag(retry_num + 1)
    return filter_info_hot_tag(resp.body)


async def get_tags() -> dict[str, Any]:
    """分类标签 + 热门标签。原 TS 用 Promise.all（任一失败整体失败），
    这里改为独立兜底：分类页少一个分组比整页 404 更有用。"""
    tags, hot_tag = await asyncio.gather(get_tag(), get_hot_tag(), return_exceptions=True)
    return {
        "tags": [] if isinstance(tags, BaseException) else tags,
        "hotTag": [] if isinstance(hot_tag, BaseException) else hot_tag,
        "source": "tx",
    }


async def get_list(sort_id: Any, tag_id: Any, page: int = 1, retry_num: int = 0) -> dict[str, Any]:
    if retry_num > 2:
        raise RuntimeError("try max num")
    resp = await http_fetch(get_list_url(sort_id, tag_id, page))
    body = resp.body if isinstance(resp.body, dict) else {}
    if body.get("code") != SUCCESS_CODE:
        return await get_list(sort_id, tag_id, page, retry_num + 1)
    data = (body.get("playlist") or {}).get("data") or {}
    return filter_list2(data, page) if tag_id else filter_list(data, page)


async def handle_parse_id(link: str, retry_num: int = 0) -> str:
    """短链跟随：请求层不自动跟随重定向，手动读 Location（文案与原文一致：link try max num）。"""
    if retry_num > 2:
        raise RuntimeError("link try max num")
    resp = await http_fetch(link)
    if resp.status_code > 400:
        return await handle_parse_id(link, retry_num + 1)
    return resp.header("location") or link


async def get_list_id(playlist_id: str) -> str:
    """链接/裸 id → 纯数字歌单 id。"""
    if not re.search(r"[?&:/]", playlist_id):
        return playlist_id
    target = playlist_id
    if not _LIST_DETAIL_LINK.search(target):
        target = await handle_parse_id(target)
    result = _LIST_DETAIL_LINK.search(target)
    if not result:
        result = _LIST_DETAIL_LINK2.search(target)
        if not result:
            raise RuntimeError("failed")
    return result.group(1)


async def get_list_detail(playlist_id: str, retry_num: int = 0) -> dict[str, Any]:
    """歌单详情（含全部曲目，不分页）。重试文案与原文一致：try max num。"""
    if retry_num > 2:
        raise RuntimeError("try max num")
    bare = await get_list_id(playlist_id)

    resp = await http_fetch(
        LIST_DETAIL_URL.format(playlist_id=quote(bare, safe="")),
        headers={"Origin": "https://y.qq.com", "Referer": f"https://y.qq.com/n/yqq/playsquare/{bare}.html"},
    )
    body = resp.body if isinstance(resp.body, dict) else {}
    if body.get("code") != SUCCESS_CODE:
        return await get_list_detail(bare, retry_num + 1)

    cdlist = (body.get("cdlist") or [{}])[0]
    songlist = cdlist.get("songlist") or []
    return {
        "list": filter_list_detail(songlist),
        "page": 1,
        "limit": len(songlist) + 1,
        "total": len(songlist),
        "source": "tx",
        "info": {
            "name": cdlist.get("dissname"),
            "img": cdlist.get("logo"),
            "desc": decode_name(cdlist.get("desc")).replace("<br>", "\n"),
            "author": cdlist.get("nickname"),
            "play_count": format_play_count(cdlist.get("visitnum")),
        },
    }


async def search(text: str, page: int = 1, limit: int = 20, retry_num: int = 0) -> dict[str, Any]:
    """歌单搜索。重试上限 5 次（文案与原文一致：max retry）。"""
    if retry_num > 5:
        raise RuntimeError("max retry")
    resp = await http_fetch(
        SEARCH_URL.format(page=page - 1, limit=limit, query=quote(text, safe="")),
        headers={"User-Agent": _UA_IE, "Referer": "http://y.qq.com/portal/search.html"},
    )
    body = resp.body if isinstance(resp.body, dict) else {}
    if body.get("code") != 0:
        return await search(text, page, limit, retry_num + 1)
    data = body.get("data") or {}
    return {
        "list": [
            {
                "play_count": format_play_count(item.get("listennum")),
                "id": str(item.get("dissid")),
                "author": decode_name((item.get("creator") or {}).get("name")),
                "name": decode_name(item.get("dissname")),
                "time": date_format(item.get("createtime"), "Y-M-D"),
                "img": item.get("imgurl"),
                "total": item.get("song_count"),
                "desc": decode_name(decode_name(item.get("introduction"))).replace("<br>", "\n"),
                "source": "tx",
            }
            for item in data.get("list") or []
        ],
        "limit": limit,
        "total": data.get("sum"),
        "source": "tx",
    }


async def get_detail_page_url(playlist_id: str) -> str:
    return f"https://y.qq.com/n/ryqq/playlist/{await get_list_id(playlist_id)}"


sort_list = SORT_LIST
