"""酷我歌单广场与歌单详情（对应 sdk/kw/songList.ts）。

四条互不相同的上游链路，按歌单 id 形态分流（`get_list_detail`）：
  * `digest-<n>__<id>` —— 广场列表返回的内部 id，digest 决定走哪个接口：
      13  → 专辑（转交 album.get_album_list_detail）
      5   → 旧歌单（先 qukudata 查 sourceid，再用 nplserver 取曲目）
      其余 → nplserver 直取
  * `/bodian/` 链接 —— BD 接口（bd-api.kuwo.cn），需要 reqId 与 h5 头
  * 网页链接 —— 正则抽出裸 id 后按 nplserver 取

nplserver 固定 1000 条/页，因此详情类调用都在调用方（playlist.py）做本地开窗。
"""

from __future__ import annotations

import asyncio
import random
import re
from typing import Any
from urllib.parse import quote

from app.sdk.common.request import http_fetch
from app.sdk.common.utils import decode_name, format_play_count, format_play_time
from app.sdk.platforms.kw.util import format_singer, obj_str2json

LIST_LIMIT = 36
SONG_LIMIT = 1000
SUCCESS_CODE = 200

SORT_LIST: list[dict[str, str]] = [
    {"name": "最新", "id": "new"},
    {"name": "最热", "id": "hot"},
]

# 路由层以 `song_list.sort_list[0]["id"]` 取默认排序，名字沿用原 TS 的 sortList
sort_list = SORT_LIST

TAGS_API = (
    "http://wapi.kuwo.cn/api/pc/classify/playlist/getTagList?cmd=rcm_keyword_playlist"
    "&user=0&prod=kwplayer_pc_9.0.5.0&vipver=9.0.5.0&source=kwplayer_pc_9.0.5.0"
    "&loginUid=0&loginSid=0&appUid=76039576"
)
HOT_TAG_API = "http://wapi.kuwo.cn/api/pc/classify/playlist/getRcmTagList?loginUid=0&loginSid=0&appUid=76039576"
RCM_LIST_API = (
    "http://wapi.kuwo.cn/api/pc/classify/playlist/getRcmPlayList?loginUid=0&loginSid=0"
    "&appUid=76039576&&pn={page}&rn={rn}&order={sort}"
)
TAG_LIST_API = (
    "http://wapi.kuwo.cn/api/pc/classify/playlist/getTagPlayList?loginUid=0&loginSid=0"
    "&appUid=76039576&pn={page}&id={id}&rn={rn}"
)
QZ_LIST_API = "http://mobileinterfaces.kuwo.cn/er.s?type=get_pc_qz_data&f=web&id={id}&prod=pc"
LIST_DETAIL_API = (
    "http://nplserver.kuwo.cn/pl.svc?op=getlistinfo&pid={id}&pn={pn}&rn={rn}"
    "&encode=utf8&keyset=pl2012&identity=kuwo&pcmp4=1&vipver=MUSIC_9.0.5.0_W1&newver=1"
)
DIGEST5_INFO_API = "http://qukudata.kuwo.cn/q.k?op=query&cont=ninfo&node={id}&pn=0&rn=1&fmt=json&src=mbox&level=2"
DIGEST5_MUSIC_API = (
    "http://nplserver.kuwo.cn/pl.svc?op=getlistinfo&pid={id}&pn={pn}&rn={rn}"
    "&encode=utf-8&keyset=pl2012&identity=kuwo&pcmp4=1"
)
BD_INFO_API = "https://bd-api.kuwo.cn/api/service/playlist/info/{id}?reqId={req_id}&source={source}"
BD_USER_API = "https://bd-api.kuwo.cn/api/ucenter/users/pub/{id}?reqId={req_id}"
BD_LIST_API = (
    "https://bd-api.kuwo.cn/api/service/playlist/{id}/musicList?reqId={req_id}&source={source}&pn={page}&rn={rn}"
)
SEARCH_API = (
    "http://search.kuwo.cn/r.s?all={keyword}&pn={pn}&rn={rn}&rformat=json&encoding=utf8"
    "&ver=mbox&vipver=MUSIC_8.7.7.0_BCS37&plat=pc&devid=28156413&ft=playlist&pay=0&needliveshow=0"
)

BD_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.198 Safari/537.36"
    ),
    "plat": "h5",
}

_BITRATE_QUALITY = {"4000": "flac24bit", "2000": "flac", "320": "320k", "128": "128k"}
_MININFO_RE = re.compile(r"level:(\w+),bitrate:(\d+),format:(\w+),size:([\w.]+)")
_DETAIL_LINK_RE = re.compile(r"^.+\/playlist(?:_detail)?\/(\d+)(?:\?.*|&.*$|#.*$|$)")
_LINKISH_RE = re.compile(r"[?&:/]")
_DIGEST_RE = re.compile(r"^digest-")
_BD_RE = re.compile(r"/bodian/")
_DIGEST_SPLIT_RE = re.compile(r"__")


def _to_int(value: Any) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def _as_str(value: Any) -> str:
    return "" if value is None else str(value)


def _get_list_url(sort_id: str, playlist_id: str | None, digest: str, page: int) -> str:
    if not playlist_id:
        return RCM_LIST_API.format(page=page, rn=LIST_LIMIT, sort=sort_id)
    if digest == "10000":
        return TAG_LIST_API.format(page=page, id=playlist_id, rn=LIST_LIMIT)
    if digest == "43":
        return QZ_LIST_API.format(id=playlist_id)
    # 原文此处无 return，httpFetch(undefined) 会直接抛错；这里显式抛同样的异常语义
    raise RuntimeError(f"不支持的酷我歌单标签类型: {digest}")


def _filter_list_detail(raw_list: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for item in raw_list:
        types: list[dict[str, str]] = []
        _types: dict[str, dict[str, str]] = {}
        for entry in str(item.get("N_MINFO") or "").split(";"):
            match = _MININFO_RE.search(entry)
            if match is None:
                continue
            quality = _BITRATE_QUALITY.get(match.group(2))
            if quality is None:
                continue
            types.append({"type": quality, "size": match.group(4)})
            _types[quality] = {"size": match.group(4).upper()}
        types.reverse()

        result.append(
            {
                "singer": format_singer(decode_name(item.get("artist"))),
                "name": decode_name(item.get("name")),
                "albumName": decode_name(item.get("album")),
                "albumId": item.get("albumid"),
                "songmid": item.get("id"),
                "source": "kw",
                "interval": format_play_time(_to_int(item.get("duration"))),
                "img": None,
                "lrc": None,
                "otherSource": None,
                "types": types,
                "_types": _types,
                "typeUrl": {},
            }
        )
    return result


def _filter_list(raw_list: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "play_count": format_play_count(_to_int(item.get("listencnt"))),
            "id": f"digest-{item.get('digest')}__{item.get('id')}",
            "author": item.get("uname"),
            "name": item.get("name"),
            "total": item.get("total"),
            "img": item.get("img"),
            "grade": _to_int(item.get("favorcnt")) / 10,
            "desc": item.get("desc"),
            "source": "kw",
        }
        for item in raw_list
    ]


def _filter_list2(raw_data: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """qz_data 接口返回按 label 分组的二维结构，逐组展开成一维。

    原实现用 `a && f(b)` 做兜底：条件为真才格式化，否则原样返回条件值。
    play_count 用 `item.play_count` 作条件却格式化 `item.listencnt`，逐个照搬。
    """
    result: list[dict[str, Any]] = []
    for group in raw_data:
        if not group.get("label"):
            continue
        for item in group.get("list") or []:
            raw_play = item.get("play_count")
            raw_favor = item.get("favorcnt")
            result.append(
                {
                    "play_count": format_play_count(_to_int(item.get("listencnt"))) if raw_play else (raw_play or 0),
                    "id": f"digest-{item.get('digest')}__{item.get('id')}",
                    "author": item.get("uname"),
                    "name": item.get("name"),
                    "total": item.get("total"),
                    "img": item.get("img"),
                    "grade": _to_int(raw_favor) / 10 if raw_favor else (raw_favor or 0),
                    "desc": item.get("desc"),
                    "source": "kw",
                }
            )
    return result


def _detail_info(body: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": body.get("title"),
        "img": body.get("pic"),
        "desc": body.get("info"),
        "author": body.get("uname"),
        "play_count": format_play_count(_to_int(body.get("playnum"))),
    }


async def get_tag(retry_num: int = 0) -> list[dict[str, Any]]:
    if retry_num > 2:
        raise RuntimeError("try max num")
    resp = await http_fetch(TAGS_API)
    body = resp.body if isinstance(resp.body, dict) else {}
    if body.get("code") != SUCCESS_CODE:
        return await get_tag(retry_num + 1)
    return [
        {
            "name": group.get("name"),
            "list": [
                {
                    "parent_id": group.get("id"),
                    "parent_name": group.get("name"),
                    "id": f"{item.get('id')}-{item.get('digest')}",
                    "name": item.get("name"),
                    "source": "kw",
                }
                for item in group.get("data") or []
            ],
        }
        for group in body.get("data") or []
    ]


async def get_hot_tag(retry_num: int = 0) -> list[dict[str, Any]]:
    if retry_num > 2:
        raise RuntimeError("try max num")
    resp = await http_fetch(HOT_TAG_API)
    body = resp.body if isinstance(resp.body, dict) else {}
    if body.get("code") != SUCCESS_CODE:
        return await get_hot_tag(retry_num + 1)
    groups = body.get("data") or [{}]
    return [
        {"id": f"{item.get('id')}-{item.get('digest')}", "name": item.get("name"), "source": "kw"}
        for item in (groups[0] or {}).get("data") or []
    ]


async def get_tags() -> dict[str, Any]:
    tags, hot_tag = await asyncio.gather(get_tag(), get_hot_tag())
    return {"tags": tags, "hotTag": hot_tag, "source": "kw"}


async def get_list(sort_id: str, tag_id: str | None = None, page: int = 1, retry_num: int = 0) -> dict[str, Any]:
    if retry_num > 2:
        raise RuntimeError("try max num")
    playlist_id: str | None = None
    digest = ""
    if tag_id:
        parts = tag_id.split("-")
        playlist_id = parts[0]
        digest = parts[1] if len(parts) > 1 else ""

    url = _get_list_url(sort_id, playlist_id, digest, page)
    resp = await http_fetch(url)
    body = resp.body

    if not playlist_id or digest == "10000":
        if not isinstance(body, dict) or body.get("code") != SUCCESS_CODE:
            return await get_list(sort_id, tag_id, page, retry_num + 1)
        data = body.get("data") or {}
        return {
            "list": _filter_list(data.get("data") or []),
            "total": data.get("total"),
            "page": data.get("pn"),
            "limit": data.get("rn"),
            "source": "kw",
        }
    if not isinstance(body, list) or not body:
        return await get_list(sort_id, tag_id, page, retry_num + 1)
    return {"list": _filter_list2(body), "total": SONG_LIMIT, "page": page, "limit": SONG_LIMIT, "source": "kw"}


async def get_list_detail_digest8(playlist_id: str, page: int, retry_num: int = 0) -> dict[str, Any]:
    if retry_num > 2:
        raise RuntimeError("try max num")
    resp = await http_fetch(LIST_DETAIL_API.format(id=playlist_id, pn=page - 1, rn=SONG_LIMIT))
    body = resp.body if isinstance(resp.body, dict) else {}
    if body.get("result") != "ok":
        return await get_list_detail(playlist_id, page, retry_num + 1)
    return {
        "list": _filter_list_detail(body.get("musiclist") or []),
        "page": page,
        "limit": body.get("rn"),
        "total": body.get("total"),
        "source": "kw",
        "info": _detail_info(body),
    }


async def get_list_detail_digest5_info(playlist_id: str, retry_num: int = 0) -> str | None:
    """digest=5 的歌单 id 不能直接给 nplserver，要先查出真正的 sourceid。"""
    if retry_num > 2:
        raise RuntimeError("try max num")
    resp = await http_fetch(DIGEST5_INFO_API.format(id=playlist_id))
    body = resp.body if isinstance(resp.body, dict) else {}
    children = body.get("child")
    if resp.status_code != 200 or not children:
        return await get_list_detail_digest5_info(playlist_id, retry_num + 1)
    return str(children[0].get("sourceid")) if children else None


async def get_list_detail_digest5_music(playlist_id: str, page: int, retry_num: int = 0) -> dict[str, Any]:
    if retry_num > 2:
        raise RuntimeError("try max num")
    resp = await http_fetch(DIGEST5_MUSIC_API.format(id=playlist_id, pn=page - 1, rn=SONG_LIMIT))
    body = resp.body if isinstance(resp.body, dict) else {}
    if body.get("result") != "ok":
        return await get_list_detail(playlist_id, page, retry_num + 1)
    return {
        "list": _filter_list_detail(body.get("musiclist") or []),
        "page": page,
        "limit": body.get("rn"),
        "total": body.get("total"),
        "source": "kw",
        "info": _detail_info(body),
    }


async def get_list_detail_digest5(playlist_id: str, page: int, retry_num: int = 0) -> dict[str, Any]:
    detail_id = await get_list_detail_digest5_info(playlist_id, retry_num)
    if detail_id is None:
        raise RuntimeError("failed")
    return await get_list_detail_digest5_music(detail_id, page, retry_num)


def _filter_bd_list_detail(raw_list: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for item in raw_list:
        types: list[dict[str, Any]] = []
        _types: dict[str, dict[str, Any]] = {}
        for audio in item.get("audios") or []:
            size = _as_str(audio.get("size")).upper() if audio.get("size") is not None else None
            quality = _BITRATE_QUALITY.get(_as_str(audio.get("bitrate")))
            if quality is None:
                continue
            types.append({"type": quality, "size": size})
            _types[quality] = {"size": size}
        types.reverse()

        result.append(
            {
                "singer": "、".join(_as_str(s.get("name")) for s in item.get("artists") or []),
                "name": item.get("name"),
                "albumName": item.get("album"),
                "albumId": item.get("albumId"),
                "songmid": item.get("id"),
                "source": "kw",
                "interval": format_play_time(_to_int(item.get("duration"))),
                "img": item.get("albumPic"),
                "releaseDate": item.get("releaseDate"),
                "lrc": None,
                "otherSource": None,
                "types": types,
                "_types": _types,
                "typeUrl": {},
            }
        )
    return result


def _get_req_id() -> str:
    """BD 接口的 reqId：八段随机 16 进制。

    原实现 `(65536 * (1 + Math.random()) | 0).toString(16).substring(1)`：
    值落在 [0x10000, 0x1ffff]，固定 5 位 16 进制，去掉首位后取 4 位。
    """

    def segment() -> str:
        return f"{int(65536 * (1 + random.random())):05x}"[1:]

    return "".join(segment() for _ in range(8))


async def _bd_playlist_info(playlist_id: str, source: str) -> dict[str, Any] | None:
    resp = await http_fetch(BD_INFO_API.format(id=playlist_id, req_id=_get_req_id(), source=source), headers=BD_HEADERS)
    body = resp.body if isinstance(resp.body, dict) else {}
    if body.get("code") != 200:
        return None
    data = body.get("data") or {}
    return {
        "name": data.get("name"),
        "img": data.get("pic"),
        "desc": data.get("description"),
        "author": data.get("creatorName"),
        "play_count": data.get("playNum"),
    }


async def _bd_user_pub_info(user_id: str) -> dict[str, Any] | None:
    resp = await http_fetch(BD_USER_API.format(id=user_id, req_id=_get_req_id()), headers=BD_HEADERS)
    body = resp.body if isinstance(resp.body, dict) else {}
    if body.get("code") != 200:
        return None
    info = (body.get("data") or {}).get("userInfo") or {}
    nickname = _as_str(info.get("nickname"))
    return {
        "name": nickname + "喜欢的音乐",
        "img": info.get("headImg"),
        "desc": "",
        "author": nickname,
        "play_count": "",
    }


async def _bd_playlist_songs(playlist_id: str, source: str, page: int, retry_num: int = 0) -> dict[str, Any]:
    try:
        resp = await http_fetch(
            BD_LIST_API.format(id=playlist_id, req_id=_get_req_id(), source=source, page=page, rn=SONG_LIMIT),
            headers=BD_HEADERS,
        )
    except Exception as err:
        if retry_num > 2:
            raise RuntimeError("try max num") from err
        return await _bd_playlist_songs(playlist_id, source, page, retry_num + 1)
    body = resp.body if isinstance(resp.body, dict) else {}
    if body.get("code") != 200:
        raise RuntimeError("failed")
    data = body.get("data") or {}
    return {
        "list": _filter_bd_list_detail(data.get("list") or []),
        "page": page,
        "limit": data.get("pageSize"),
        "total": data.get("total"),
        "source": "kw",
    }


def _match_group(link: str, pattern: str) -> str | None:
    found = re.search(pattern, link)
    return found.group(1) if found else None


async def _get_list_detail_by_bd(raw_id: str, page: int) -> dict[str, Any]:
    """bodian 分享链接：uid/playlistId/source 都在 query 里，缺 source 时按原实现拼字面量。"""
    uid = _match_group(raw_id, r"uid=(\d+)")
    playlist_id = _match_group(raw_id, r"playlistId=(\d+)")
    source = _match_group(raw_id, r"source=(\d+)") or "undefined"
    if not playlist_id:
        raise RuntimeError("failed")

    tasks: list[Any] = [_bd_playlist_songs(playlist_id, source, page)]
    if source == "4":
        tasks.append(_bd_playlist_info(playlist_id, source))
    elif source == "5":
        tasks.append(_bd_user_pub_info(uid or playlist_id))
    results = await asyncio.gather(*tasks)
    list_data = results[0]
    info = results[1] if len(results) > 1 else None
    list_data["info"] = info or {"name": "", "img": "", "desc": "", "author": "", "play_count": ""}
    return list_data


async def get_list_detail(playlist_id: str, page: int = 1, retry_num: int = 0) -> dict[str, Any]:
    if _BD_RE.search(playlist_id):
        return await _get_list_detail_by_bd(playlist_id, page)
    if _LINKISH_RE.search(playlist_id):
        playlist_id = _DETAIL_LINK_RE.sub(r"\1", playlist_id)
    elif _DIGEST_RE.search(playlist_id):
        parts = _DIGEST_SPLIT_RE.split(playlist_id)
        digest = parts[0].replace("digest-", "")
        playlist_id = parts[1] if len(parts) > 1 else ""
        if digest == "13":
            from app.sdk.platforms.kw import album

            return await album.get_album_list_detail(playlist_id, page, retry_num)
        # 原文 switch 里只有 '8' 会 break 落到 digest8，其余（含 '5' 与未知 digest）全走 digest5
        if digest == "8":
            return await get_list_detail_digest8(playlist_id, page, retry_num)
        return await get_list_detail_digest5(playlist_id, page, retry_num)
    return await get_list_detail_digest8(playlist_id, page, retry_num)


async def search(keyword: str, page: int = 1, limit: int = 20) -> dict[str, Any]:
    resp = await http_fetch(SEARCH_API.format(keyword=quote(keyword, safe=""), pn=page - 1, rn=limit))
    body = obj_str2json(resp.raw.decode("utf-8", errors="replace"))
    return {
        "list": [
            {
                "play_count": format_play_count(_to_int(item.get("playcnt"))),
                "id": _as_str(item.get("playlistid")),
                "author": decode_name(item.get("nickname")),
                "name": decode_name(item.get("name")),
                "total": item.get("songnum"),
                "img": item.get("pic"),
                "desc": decode_name(item.get("intro")),
                "source": "kw",
            }
            for item in body.get("abslist") or []
        ],
        "limit": limit,
        "total": _to_int(body.get("TOTAL")),
        "source": "kw",
    }


def get_detail_page_url(playlist_id: str) -> str:
    if _LINKISH_RE.search(playlist_id):
        playlist_id = _DETAIL_LINK_RE.sub(r"\1", playlist_id)
    elif _DIGEST_RE.search(playlist_id):
        parts = playlist_id.split("__")
        playlist_id = parts[1] if len(parts) > 1 else ""
    return f"http://www.kuwo.cn/playlist_detail/{playlist_id}"


__all__ = [
    "SORT_LIST",
    "get_detail_page_url",
    "get_hot_tag",
    "get_list",
    "get_list_detail",
    "get_tag",
    "get_tags",
    "search",
]
