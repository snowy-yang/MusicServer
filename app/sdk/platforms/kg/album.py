"""酷狗专辑（对应 sdk/kg/album.ts）。"""

from __future__ import annotations

from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.platforms.kg.music_info import get_music_infos_by_list
from app.sdk.platforms.kg.util import create_http_fetch, encode_uri_component

ALBUM_INFO_URL = (
    "http://kmrserviceretry.kugou.com/container/v1/album"
    "?dfid=1tT5He3kxrNC4D29ad1MMb6F&mid=22945702112173152889429073101964063697&userid=0&appid=1005&clientver=11589"
)

ALBUM_SONG_URL = "http://mobiles.kugou.com/api/v3/album/song"

ALBUM_SEARCH_URL = "http://mobilecdn.kugou.com/api/v3/search/album"

_UA_MOBILE = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1"
)


def _album_cover(url: Any) -> str:
    return str(url or "").replace("{size}", "240")


async def _get_album_info(id: Any) -> dict[str, Any]:
    result = await create_http_fetch(
        ALBUM_INFO_URL,
        {
            "method": "POST",
            "body": {
                "appid": 1005,
                "clienttime": 1681833686,
                "clientver": 11589,
                "data": [{"album_id": id}],
                "fields": (
                    "language,grade_count,intro,mix_intro,heat,category,sizable_cover,cover,album_name,type,"
                    "quality,publish_company,grade,special_tag,author_name,publish_date,language_id,album_id,"
                    "exclusive,is_publish,trans_param,authors,album_tag"
                ),
                "isBuy": 0,
                "key": "e6f3306ff7e2afb494e89fbbda0becbf",
                "mid": "22945702112173152889429073101964063697",
                "show_album_tag": 0,
            },
        },
    )
    if not result:
        raise RuntimeError("get album info failed.")
    info = result[0] if isinstance(result, list) else result
    return {
        "name": info.get("album_name"),
        "image": str(info.get("sizable_cover") or "").replace("{size}", "240"),
        "desc": info.get("intro"),
        "authorName": info.get("author_name"),
    }


async def get_album_detail(album_id: str, page: int = 1, limit: int = 200) -> dict[str, Any]:
    album_list = await create_http_fetch(
        f"{ALBUM_SONG_URL}?version=9108&albumid={album_id}&plat=0&pagesize={limit}"
        f"&area_code=0&page={page}&with_res_tag=0"
    )
    album_list = album_list or {}
    if not album_list.get("info"):
        raise RuntimeError("Get album list failed.")
    songs = await get_music_infos_by_list(album_list.get("info") or [])
    info = await _get_album_info(album_id)
    return {
        "list": songs or [],
        "page": page,
        "limit": limit,
        "total": album_list.get("total"),
        "source": "kg",
        "info": {
            "name": info["name"],
            "img": info["image"],
            "desc": info["desc"],
            "author": info["authorName"],
        },
    }


async def search_album(keyword: str, page: int = 1, limit: int = 10) -> dict[str, Any]:
    word = str(keyword or "").strip()
    if not word:
        return {"source": "kg", "list": [], "page": page, "limit": limit, "total": 0}
    page_no = max(1, int(page or 1))
    page_size = max(1, int(limit or 10))
    url = f"{ALBUM_SEARCH_URL}?keyword={encode_uri_component(word)}&format=json&page={page_no}&pagesize={page_size}"
    resp = await http_fetch(url, headers={"User-Agent": _UA_MOBILE, "Referer": "http://m.kugou.com"}, timeout=15000)
    body = resp.body if isinstance(resp.body, dict) else {}
    if resp.status_code != 200 or body.get("status") != 1 or body.get("errcode") != 0:
        raise RuntimeError(str(body.get("error") or "酷狗专辑搜索失败"))
    data = body.get("data") or {}
    songs: list[dict[str, Any]] = []
    for item in data.get("info") or []:
        album_id = str(item.get("albumid") or "").strip()
        if not album_id or album_id == "0":
            continue
        songs.append(
            {
                "id": album_id,
                "name": str(item.get("albumname") or "").strip(),
                "cover": _album_cover(item.get("imgurl")),
                "trackCount": int(item.get("songcount") or 0) or 0,
                "creator": str(item.get("singername") or "").strip(),
                "description": str(item.get("intro") or "").strip(),
                "publishTime": str(item.get("publishtime") or "").strip(),
                "link": f"https://www.kugou.com/album/{album_id}.html",
                "source": "kg",
                "type": "album",
            }
        )
    return {
        "source": "kg",
        "list": songs,
        "page": page_no,
        "limit": page_size,
        "total": int(data.get("total") or 0) or len(songs),
    }


async def get_album_songs(id: Any) -> list[dict[str, Any]]:
    album_id = str(id or "").strip()
    if not album_id:
        raise RuntimeError("酷狗专辑 id 为空")
    result = await get_album_detail(album_id, 1, 10000)
    return result["list"]


async def parse_album_link(link: str) -> dict[str, Any]:
    """album/single/<id>.html、yy/album/single/<id>.html、album/<id>.html、albumid=<id>。"""
    import re

    raw = str(link or "")
    for pattern in (
        r"album/single/(\d+)\.html",
        r"yy/album/single/(\d+)\.html",
        r"album/(\d+)\.html",
        r"albumid=(\d+)",
    ):
        match = re.search(pattern, raw)
        if match:
            return await get_album_detail(match.group(1), 1)
    raise RuntimeError("无效的酷狗专辑链接")
