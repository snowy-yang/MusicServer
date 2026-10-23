"""酷狗歌单广场与歌单解析（对应 sdk/kg/songList.ts，31KB 的最大模块）。

三个入口：
  get_list(sort_id, tag_id, page)  —— 歌单广场（special/getSpecial + 详情 + 推荐）
  get_list_detail(id, page)        —— 歌单解析，覆盖 special/single、酷狗码、gcid、
                                      share chain、zlist、global_collection_id、网页链接
  search(keyword, page, limit)     —— 歌单搜索（msearchretry v3 search/special）

原实现的 `_requestObj*` 取消句柄在 Python 侧无对应物（http_fetch 自身不可取消），
已省略；其余降级链、重试次数、错误文案与原实现保持一致。
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.common.utils import date_format, decode_name, format_play_count, format_play_time, size_formate, to_md5
from app.sdk.platforms.kg.util import create_http_fetch, signature_params

LIST_DETAIL_LIMIT = 10000

SORT_LIST: list[dict[str, str]] = [
    {"name": "推荐", "id": "5"},
    {"name": "最热", "id": "6"},
    {"name": "最新", "id": "7"},
    {"name": "热藏", "id": "3"},
    {"name": "飙升", "id": "8"},
]

_LIST_DATA_EXP = re.compile(r"global\.data = (\[.+\]);")
_LIST_INFO_EXP = re.compile(r'global = {[\s\S]+?name: "(.+)"[\s\S]+?pic: "(.+)"[\s\S]+?};')
_LIST_DETAIL_LINK_EXP = re.compile(r"^.+\/(\d+)\.html(?:\?.*|&.*$|#.*$|$)")

# chain → 分享信息缓存（原实现是 Map，跨请求复用同一进程缓存）
_CACHE: dict[str, Any] = {}
_CURRENT_TAG_INFO: dict[str, Any] = {"id": None, "info": None}


def _handle_signature(id: Any, page: int, limit: int) -> str:
    """H5 签名：业务参数按键排序拼接后以 key 包裹取 MD5（与 signature_params 同构）。"""
    params = {
        "srcappid": "2919",
        "clientver": "20000",
        "clienttime": int(time.time() * 1000),
        "mid": "0",
        "uuid": "0",
        "dfid": "-",
        "appid": 1058,
        "type": 0,
        "module": "playlist",
        "page": page,
        "pagesize": limit,
        "specialid": id,
    }
    key = "NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt"
    sorted_params = "".join(f"{k}={params[k]}" for k in sorted(params))
    return to_md5(f"{key}{sorted_params}{key}")


def parse_html_desc(html: str) -> str | None:
    prefix = '<div class="pc_specail_text pc_singer_tab_content" id="specailIntroduceWrap">'
    index = html.find(prefix)
    if index < 0:
        return None
    after = html[index + len(prefix) :]
    end = after.find("</div>")
    if end < 0:
        return None
    return decode_name(after[:end])


def _filter_info_hot_tag(raw: dict[str, Any]) -> list[dict[str, Any]]:
    if raw.get("status") != 1:
        return []
    return [
        {"id": tag.get("special_id"), "name": tag.get("special_name"), "source": "kg"}
        for tag in (raw.get("data") or {}).values()
    ]


def _filter_tag_info(raw: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {
            "name": name,
            "list": [
                {
                    "parent_id": tag.get("parent_id"),
                    "parent_name": tag.get("pname"),
                    "id": tag.get("id"),
                    "name": tag.get("name"),
                    "source": "kg",
                }
                for tag in (raw[name].get("data") or [])
            ],
        }
        for name in raw
    ]


def _filter_list(raw_data: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "play_count": item.get("total_play_count") or format_play_count(item.get("play_count")),
            "id": "id_" + str(item.get("specialid")),
            "author": item.get("nickname"),
            "name": item.get("specialname"),
            "time": date_format(item.get("publish_time") or item.get("publishtime"), "Y-M-D"),
            "img": item.get("img") or item.get("imgurl"),
            "total": item.get("songcount"),
            "grade": item.get("grade"),
            "desc": item.get("intro"),
            "source": "kg",
        }
        for item in raw_data
    ]


def _create_task_body(hashs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    base = {
        "area_code": "1",
        "show_privilege": 1,
        "show_album_info": "1",
        "is_publish": "",
        "appid": 1005,
        "clientver": 11451,
        "mid": "1",
        "dfid": "-",
        "clienttime": int(time.time() * 1000),
        "key": "OIlwieks28dk2k092lksi2UIkp",
        "fields": "album_info,author_name,audio_info,ori_audio_name,base,songname",
    }
    tasks: list[dict[str, Any]] = []
    rest = list(hashs)
    while rest:
        tasks.append({"data": rest[:100], **base})
        if len(rest) < 100:
            break
        rest = rest[100:]
    return tasks


async def _create_task(hashs: list[dict[str, Any]]) -> list[list[Any]]:
    url = "http://gateway.kugou.com/v2/album_audio/audio"
    headers = {
        "KG-THash": "13a3164",
        "KG-RC": "1",
        "KG-Fake": "0",
        "KG-RF": "00869891",
        "User-Agent": "Android712-AndroidPhone-11451-376-0-FeeCacheUpdate-wifi",
        "x-router": "kmr.service.kugou.com",
    }

    async def one(task: dict[str, Any]) -> list[Any]:
        data = await create_http_fetch(url, {"method": "POST", "body": task, "headers": headers})
        items = data if isinstance(data, list) else []
        return [entry[0] if entry else None for entry in items]

    return await asyncio.gather(*(one(task) for task in _create_task_body(hashs)))


def _de_duplication(datas: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[Any] = set()
    result: list[dict[str, Any]] = []
    for item in datas:
        hash_value = item.get("hash")
        if hash_value in seen:
            continue
        seen.add(hash_value)
        result.append(item)
    return result


async def _get_music_infos(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """hash 列表 → SongInfo（走 v2 album_audio 批量接口，与 musicInfo.ts 的 v3 不同）。"""
    deduped = _de_duplication(items)
    if not deduped:
        return []
    chunks = await _create_task([{"hash": item.get("hash")} for item in deduped])
    return _filter_data2([entry for chunk in chunks for entry in chunk])


def _filter_data2(raw_list: list[Any]) -> list[dict[str, Any]]:
    ids: set[Any] = set()
    result: list[dict[str, Any]] = []

    for item in raw_list:
        if not item:
            continue
        audio = item.get("audio_info") or {}
        if audio.get("audio_id") in ids:
            continue
        ids.add(audio.get("audio_id"))
        types: list[dict[str, Any]] = []
        _types: dict[str, dict[str, Any]] = {}
        for quality, size_key, hash_key in (
            ("128k", "filesize", "hash"),
            ("320k", "filesize_320", "hash_320"),
            ("flac", "filesize_flac", "hash_flac"),
            ("flac24bit", "filesize_high", "hash_high"),
        ):
            if str(audio.get(size_key, "0")) == "0":
                continue
            size = size_formate(int(audio.get(size_key) or 0))
            types.append({"type": quality, "size": size, "hash": audio.get(hash_key)})
            _types[quality] = {"size": size, "hash": audio.get(hash_key)}
        album = item.get("album_info") or {}
        result.append(
            {
                "singer": decode_name(item.get("author_name")),
                "name": decode_name(item.get("songname")),
                "albumName": decode_name(album.get("album_name")),
                "albumId": album.get("album_id"),
                "songmid": audio.get("audio_id"),
                "source": "kg",
                "interval": format_play_time(int(audio.get("timelength") or 0) / 1000),
                "img": None,
                "lrc": None,
                "hash": audio.get("hash"),
                "otherSource": None,
                "types": types,
                "_types": _types,
                "typeUrl": {},
            }
        )
    return result


async def get_list_detail_by_special_id(id: Any, page: int | None = None, try_num: int = 0) -> dict[str, Any]:
    if try_num > 2:
        raise RuntimeError("try max num")
    resp = await http_fetch(get_song_list_detail_url(id))
    html = resp.body if isinstance(resp.body, str) else ""
    list_data = _LIST_DATA_EXP.search(html)
    list_info = _LIST_INFO_EXP.search(html)
    if not list_data:
        return await get_list_detail_by_special_id(id, page, try_num + 1)
    songs = await _get_music_infos(json.loads(list_data.group(1)))
    name = list_info.group(1) if list_info else None
    pic = list_info.group(2) if list_info else None
    return {
        "list": songs,
        "page": 1,
        "limit": LIST_DETAIL_LIMIT,
        "total": len(songs),
        "source": "kg",
        "info": {"name": name, "img": pic, "desc": parse_html_desc(html)},
    }


def get_info_url(tag_id: Any = None) -> str:
    if tag_id:
        return f"http://www2.kugou.kugou.com/yueku/v9/special/getSpecial?is_smarty=1&cdn=cdn&t=5&c={tag_id}"
    return "http://www2.kugou.kugou.com/yueku/v9/special/getSpecial?is_smarty=1&"


def get_song_list_url(sort_id: Any, tag_id: Any, page: int) -> str:
    tag = "" if tag_id is None else tag_id
    return f"http://www2.kugou.kugou.com/yueku/v9/special/getSpecial?is_ajax=1&cdn=cdn&t={sort_id}&c={tag}&p={page}"


def get_song_list_detail_url(id: Any) -> str:
    return f"http://www2.kugou.kugou.com/yueku/v9/special/single/{id}-5-9999.html"


async def _get_song_list(sort_id: Any, tag_id: Any, page: int, try_num: int = 0) -> list[dict[str, Any]]:
    if try_num > 2:
        raise RuntimeError("try max num")
    resp = await http_fetch(get_song_list_url(sort_id, tag_id, page))
    body = resp.body if isinstance(resp.body, dict) else {}
    if not body or body.get("status") != 1:
        return await _get_song_list(sort_id, tag_id, page, try_num + 1)
    return _filter_list(body.get("special_db") or [])


async def _get_song_list_recommend(try_num: int = 0) -> list[dict[str, Any]]:
    if try_num > 2:
        raise RuntimeError("try max num")
    resp = await http_fetch(
        "http://everydayrec.service.kugou.com/guess_special_recommend",
        method="post",
        headers={"User-Agent": "KuGou2012-8275-web_browser_event_handler"},
        body={
            "appid": 1001,
            "clienttime": 1566798337219,
            "clientver": 8275,
            "key": "f1f93580115bb106680d2375f8032d96",
            "mid": "21511157a05844bd085308bc76ef3343",
            "platform": "pc",
            "userid": "262643156",
            "return_min": 6,
            "return_max": 15,
        },
    )
    body = resp.body if isinstance(resp.body, dict) else {}
    if body.get("status") != 1:
        return await _get_song_list_recommend(try_num + 1)
    return _filter_list((body.get("data") or {}).get("special_list") or [])


async def _get_list_info(tag_id: Any, try_num: int = 0) -> dict[str, Any]:
    if try_num > 2:
        raise RuntimeError("try max num")
    resp = await http_fetch(get_info_url(tag_id))
    body = resp.body if isinstance(resp.body, dict) else {}
    if body.get("status") != 1:
        return await _get_list_info(tag_id, try_num + 1)
    params = (body.get("data") or {}).get("params") or {}
    return {
        "limit": params.get("pagesize"),
        "page": params.get("p"),
        "total": params.get("total"),
        "source": "kg",
    }


async def get_list(sort_id: Any, tag_id: Any, page: int = 1) -> dict[str, Any]:
    """歌单广场：首屏（无标签、第 1 页、默认排序）额外混入推荐歌单。"""
    tasks: list[Any] = [_get_song_list(sort_id, tag_id, page)]
    if _CURRENT_TAG_INFO["id"] == tag_id:
        tasks.append(asyncio.sleep(0, result=_CURRENT_TAG_INFO["info"]))
    else:

        async def load_info() -> dict[str, Any]:
            info = await _get_list_info(tag_id)
            _CURRENT_TAG_INFO["id"] = tag_id
            _CURRENT_TAG_INFO["info"] = dict(info)
            return info

        tasks.append(load_info())
    if not tag_id and page == 1 and sort_id == SORT_LIST[0]["id"]:
        tasks.append(_get_song_list_recommend())

    results = await asyncio.gather(*tasks)
    songs: list[dict[str, Any]] = results[0]
    info: dict[str, Any] = results[1]
    if len(results) > 2 and results[2]:
        songs = [*results[2], *songs]
    return {"list": songs, **info}


async def get_tags(try_num: int = 0) -> dict[str, Any]:
    if try_num > 2:
        raise RuntimeError("try max num")
    resp = await http_fetch(get_info_url())
    body = resp.body if isinstance(resp.body, dict) else {}
    if body.get("status") != 1:
        return await get_tags(try_num + 1)
    data = body.get("data") or {}
    return {
        "hotTag": _filter_info_hot_tag(data.get("hotTag") or {}),
        "tags": _filter_tag_info(data.get("tagids") or {}),
        "source": "kg",
    }


def get_detail_page_url(id: Any) -> str:
    value = id
    if isinstance(value, str):
        if re.search(r"^https?://", value):
            return value
        value = value.replace("id_", "")
    return f"https://www.kugou.com/yy/special/single/{value}.html"


async def search(keyword: str, page: int = 1, limit: int = 20) -> dict[str, Any]:
    from app.sdk.platforms.kg.util import encode_uri_component

    url = (
        f"http://msearchretry.kugou.com/api/v3/search/special?keyword={encode_uri_component(keyword)}"
        f"&page={page}&pagesize={limit}&showtype=10&filter=0&version=7910&sver=2"
    )
    resp = await http_fetch(url)
    body = resp.body if isinstance(resp.body, dict) else {}
    if body.get("errcode") != 0:
        raise RuntimeError("filed")
    data = body.get("data") or {}
    return {
        "list": [
            {
                "play_count": format_play_count(item.get("playcount")),
                "id": "id_" + str(item.get("specialid")),
                "author": item.get("nickname"),
                "name": item.get("specialname"),
                "time": date_format(item.get("publishtime"), "Y-M-D"),
                "img": item.get("imgurl"),
                "grade": item.get("grade"),
                "desc": item.get("intro"),
                "total": item.get("songcount"),
                "source": "kg",
            }
            for item in data.get("info") or []
        ],
        "limit": limit,
        "total": data.get("total"),
        "page": page,
        "source": "kg",
    }


# ---- 歌单详情解析链 ----


async def _decode_gcid(gcid: str) -> str | None:
    params = "dfid=-&appid=1005&mid=0&clientver=20109&clienttime=640612895&uuid=-"
    body = {"ret_info": 1, "data": [{"id": gcid, "id_type": 2}]}
    result = await create_http_fetch(
        f"https://t.kugou.com/v1/songlist/batch_decode?{params}"
        f"&signature={signature_params(params, 'android', json.dumps(body, separators=(',', ':')))}",
        {
            "method": "POST",
            "headers": {
                "User-Agent": (
                    "Mozilla/5.0 (Linux; Android 10; HUAWEI HMA-AL00) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/83.0.4103.106 Mobile Safari/537.36"
                ),
                "Referer": "https://m.kugou.com/",
            },
            "body": body,
        },
    )
    items = (result or {}).get("list") or []
    return items[0].get("global_collection_id") if items else None


async def _get_user_list_detail_2(global_collection_id: str) -> dict[str, Any]:
    if len(global_collection_id) > 1000:
        raise RuntimeError("get list error")
    params = (
        "appid=1058&specialid=0&global_specialid="
        + global_collection_id
        + "&format=jsonp&srcappid=2919&clientver=20000&clienttime=1586163242519"
        "&mid=1586163242519&uuid=1586163242519&dfid=-"
    )
    headers = {
        "mid": "1586163242519",
        "Referer": "https://m3ws.kugou.com/share/index.php",
        "User-Agent": (
            "Mozilla/5.0 (iPhone; CPU iPhone OS 11_0 like Mac OS X) AppleWebKit/604.1.38 "
            "(KHTML, like Gecko) Version/11.0 Mobile/15A372 Safari/604.1"
        ),
        "dfid": "-",
        "clienttime": "1586163242519",
    }
    info = await create_http_fetch(
        f"https://mobiles.kugou.com/api/v5/special/info_v2?{params}&signature={signature_params(params, 'web')}",
        {"headers": headers},
    )
    info = info or {}
    total = info.get("songcount") or 0
    tasks: list[Any] = []
    page = 0
    while total:
        limit = 300 if total > 300 else total
        total -= limit
        page += 1
        song_params = (
            f"appid=1058&global_specialid={global_collection_id}&specialid=0&plat=0&version=8000"
            f"&page={page}&pagesize={limit}&srcappid=2919&clientver=20000"
            "&clienttime=1586163263991&mid=1586163263991&uuid=1586163263991&dfid=-"
        )
        tasks.append(
            create_http_fetch(
                f"https://mobiles.kugou.com/api/v5/special/song_v2?{song_params}"
                f"&signature={signature_params(song_params, 'web')}",
                {
                    "headers": {
                        "mid": "1586163263991",
                        "Referer": "https://m3ws.kugou.com/share/index.php",
                        "User-Agent": (
                            "Mozilla/5.0 (iPhone; CPU iPhone OS 11_0 like Mac OS X) AppleWebKit/604.1.38 "
                            "(KHTML, like Gecko) Version/11.0 Mobile/15A372 Safari/604.1"
                        ),
                        "dfid": "-",
                        "clienttime": "1586163263991",
                    }
                },
            )
        )
    song_rows: list[Any] = []
    for chunk in await asyncio.gather(*tasks):
        song_rows.extend((chunk or {}).get("info") or [])
    songs = await _get_music_infos(song_rows)
    img = info.get("imgurl")
    return {
        "list": songs,
        "page": 1,
        "limit": LIST_DETAIL_LIMIT,
        "total": len(songs),
        "source": "kg",
        "info": {
            "name": info.get("specialname"),
            "img": img.replace("{size}", "240") if img else None,
            "desc": info.get("intro"),
            "author": info.get("nickname"),
            "play_count": format_play_count(info.get("playcount")),
        },
    }


async def _get_list_info_by_chain(chain: str) -> Any:
    if chain in _CACHE:
        return _CACHE[chain]
    resp = await http_fetch(
        f"https://m.kugou.com/share/?chain={chain}&id={chain}",
        headers={
            "User-Agent": (
                "Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 "
                "(KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1"
            )
        },
    )
    html = resp.body if isinstance(resp.body, str) else ""
    match = re.search(r"var\sphpParam\s=\s({.+?});", html)
    result = json.loads(match.group(1)) if match else None
    _CACHE[chain] = result
    return result


async def _get_user_list_detail_by_pc_chain(chain: str) -> list[dict[str, Any]]:
    resp = await http_fetch(
        f"http://www.kugou.com/share/{chain}.html",
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/86.0.4240.198 Safari/537.36"
            )
        },
    )
    html = resp.body if isinstance(resp.body, str) else ""
    match = re.search(r"var\sdataFromSmarty\s=\s(\[.+?\])", html)
    result = json.loads(match.group(1)) if match else []
    return await _get_music_infos(result)


async def _get_user_list_detail_by_id(id: Any, page: int, limit: int) -> list[dict[str, Any]]:
    signature = _handle_signature(id, page, limit)
    info = await create_http_fetch(
        "https://pubsongscdn.kugou.com/v2/get_other_list_file?"
        f"srcappid=2919&clientver=20000&appid=1058&type=0&module=playlist"
        f"&page={page}&pagesize={limit}&specialid={id}&signature={signature}",
        {
            "headers": {
                "Referer": "https://m3ws.kugou.com/share/index.php",
                "User-Agent": (
                    "Mozilla/5.0 (iPhone; CPU iPhone OS 11_0 like Mac OS X) AppleWebKit/604.1.38 "
                    "(KHTML, like Gecko) Version/11.0 Mobile/15A372 Safari/604.1"
                ),
                "dfid": "-",
            }
        },
    )
    return await _get_music_infos((info or {}).get("info") or [])


async def _get_user_list_detail_4(song_info: dict[str, Any], chain: str, page: int) -> dict[str, Any]:
    limit = 100
    list_info, songs = await asyncio.gather(
        _get_list_info_by_chain(chain),
        _get_user_list_detail_by_id(song_info.get("id"), page, limit),
    )
    list_info = list_info or {}
    img = list_info.get("imgurl")
    return {
        "list": songs or [],
        "page": page,
        "limit": limit,
        "total": len(songs or []),
        "source": "kg",
        "info": {
            "name": list_info.get("specialname"),
            "img": img.replace("{size}", "240") if img else None,
            "author": list_info.get("nickname"),
        },
    }


async def _get_user_list_detail_5(chain: str) -> dict[str, Any]:
    list_info, songs = await asyncio.gather(_get_list_info_by_chain(chain), _get_user_list_detail_by_pc_chain(chain))
    list_info = list_info or {}
    img = list_info.get("imgurl")
    return {
        "list": songs or [],
        "page": 1,
        "limit": LIST_DETAIL_LIMIT,
        "total": len(songs or []),
        "source": "kg",
        "info": {
            "name": list_info.get("specialname"),
            "img": img.replace("{size}", "240") if img else None,
            "author": list_info.get("nickname"),
        },
    }


async def _get_user_list_detail_3(chain: str, page: int) -> dict[str, Any]:
    song_info = await create_http_fetch(
        f"http://m.kugou.com/schain/transfer?pagesize={LIST_DETAIL_LIMIT}&chain={chain}"
        f"&su=1&page={page}&n=0.7928855356604456",
        {
            "headers": {
                "User-Agent": (
                    "Mozilla/5.0 (iPhone; CPU iPhone OS 9_1 like Mac OS X) AppleWebKit/601.1.46 "
                    "(KHTML, like Gecko) Version/9.0 Mobile/13B143 Safari/601.1"
                )
            }
        },
    )
    song_info = song_info or {}
    if not song_info.get("list"):
        if song_info.get("global_collection_id"):
            return await _get_user_list_detail_2(song_info["global_collection_id"])
        try:
            return await _get_user_list_detail_4(song_info, chain, page)
        except Exception:  # noqa: BLE001 - 降级到 PC 分享页
            return await _get_user_list_detail_5(chain)
    songs = await _get_music_infos(song_info.get("list") or [])
    info = song_info.get("info") or {}
    return {
        "list": songs,
        "page": 1,
        "limit": LIST_DETAIL_LIMIT,
        "total": len(songs),
        "source": "kg",
        "info": {"name": info.get("name"), "img": info.get("img"), "author": info.get("username")},
    }


async def _get_user_list_detail_by_code(id: str) -> dict[str, Any]:
    song_info = await create_http_fetch(
        "http://t.kugou.com/command/",
        {
            "method": "POST",
            "headers": {
                "KG-RC": 1,
                "KG-THash": "network_super_call.cpp:3676261689:379",
                "User-Agent": "",
            },
            "body": {
                "appid": 1001,
                "clientver": 9020,
                "mid": "21511157a05844bd085308bc76ef3343",
                "clienttime": 640612895,
                "key": "36164c4015e704673c588ee202b9ecb8",
                "data": id,
            },
        },
    )
    song_info = song_info or {}
    info = song_info.get("info") or {}
    # type 1 单曲 / 2 歌单 / 3 电台 / 4 酷狗码 / 5 别人的播放队列
    if info.get("type") == 2 and not info.get("global_collection_id"):
        return await get_list_detail_by_special_id(info.get("id"))
    if info.get("global_collection_id"):
        return await _get_user_list_detail_2(info["global_collection_id"])
    song_list: Any = None
    if info.get("userid") is not None:
        song_list = await create_http_fetch(
            "http://www2.kugou.kugou.com/apps/kucodeAndShare/app/",
            {
                "method": "POST",
                "headers": {
                    "KG-RC": 1,
                    "KG-THash": "network_super_call.cpp:3676261689:379",
                    "User-Agent": "",
                },
                "body": {
                    "appid": 1001,
                    "clientver": 9020,
                    "mid": "21511157a05844bd085308bc76ef3343",
                    "clienttime": 640612895,
                    "key": "36164c4015e704673c588ee202b9ecb8",
                    "data": {
                        "id": info.get("id"),
                        "type": 3,
                        "userid": info.get("userid"),
                        "collect_type": 0,
                        "page": 1,
                        "pagesize": info.get("count"),
                    },
                },
            },
        )
    rows = song_list or song_info.get("list") or []
    songs = await _get_music_infos(rows)
    img_size = info.get("img_size")
    return {
        "list": songs,
        "page": 1,
        "limit": info.get("count"),
        "total": len(songs),
        "source": "kg",
        "info": {
            "name": info.get("name"),
            "img": img_size.replace("{size}", "240") if img_size else info.get("img"),
            "author": info.get("username"),
        },
    }


async def _get_user_list_detail_by_link(body: dict[str, Any], link: str) -> dict[str, Any]:
    list_info = (body.get("info") or {}).get("0") or {}
    total = list_info.get("count") or 0
    tasks: list[Any] = []
    page = 0
    while total:
        limit = 90 if total > 90 else total
        total -= limit
        page += 1
        url = re.sub(r"pagesize=\d+", f"pagesize={limit}", link)
        url = re.sub(r"page=\d+", f"page={page}", url)
        tasks.append(
            create_http_fetch(
                url,
                {
                    "headers": {
                        "User-Agent": (
                            "Mozilla/5.0 (iPhone; CPU iPhone OS 9_1 like Mac OS X) AppleWebKit/601.1.46 "
                            "(KHTML, like Gecko) Version/9.0 Mobile/13B143 Safari/601.1"
                        ),
                        "Referer": link,
                    }
                },
            )
        )
    rows: list[Any] = []
    for chunk in await asyncio.gather(*tasks):
        rows.extend(((chunk or {}).get("list") or {}).get("info") or [])
    songs = await _get_music_infos(rows)
    pic = list_info.get("pic")
    return {
        "list": songs,
        "page": page,
        "limit": LIST_DETAIL_LIMIT,
        "total": len(songs),
        "source": "kg",
        "info": {
            "name": list_info.get("name"),
            "img": pic.replace("{size}", "240") if pic else None,
            "author": list_info.get("list_create_username"),
        },
    }


async def _get_user_list_detail(link: str, page: int, retry_num: int = 0) -> dict[str, Any]:
    if retry_num > 3:
        raise RuntimeError("link try max num")
    if "#" in link:
        link = re.sub(r"#.*$", "", link)
    if "global_collection_id" in link:
        return await _get_user_list_detail_2(re.sub(r"^.*?global_collection_id=(\w+)(?:&.*$|#.*$|$)", r"\1", link))
    if "gcid_" in link:
        match = re.search(r"gcid_\w+", link)
        if match:
            gcid_id = await _decode_gcid(match.group(0))
            if gcid_id:
                return await _get_user_list_detail_2(gcid_id)
    if "chain=" in link:
        return await _get_user_list_detail_3(re.sub(r"^.*?chain=(\w+)(?:&.*$|#.*$|$)", r"\1", link), page)
    if ".html" in link:
        if "zlist.html" in link:
            link = re.sub(r"^(.*)zlist\.html", "https://m3ws.kugou.com/zlist/list", link)
            if "pagesize" in link:
                link = link.replace("pagesize=30", f"pagesize={LIST_DETAIL_LIMIT}").replace("page=1", f"page={page}")
            else:
                link += f"&pagesize={LIST_DETAIL_LIMIT}&page={page}"
        elif "song.html" not in link:
            return await _get_user_list_detail_3(re.sub(r".+\/(\w+).html(?:\?.*|&.*$|#.*$|$)", r"\1", link), page)

    resp = await http_fetch(
        link,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (iPhone; CPU iPhone OS 9_1 like Mac OS X) AppleWebKit/601.1.46 "
                "(KHTML, like Gecko) Version/9.0 Mobile/13B143 Safari/601.1"
            ),
            "Referer": link,
        },
    )
    location = resp.header("location") or None
    if resp.status_code > 400:
        return await _get_user_list_detail(link, page, retry_num + 1)
    if location:
        if "global_collection_id" in location:
            return await _get_user_list_detail_2(
                re.sub(r"^.*?global_collection_id=(\w+)(?:&.*$|#.*$|$)", r"\1", location)
            )
        if "gcid_" in location:
            match = re.search(r"gcid_\w+", link)
            if match:
                gcid_id = await _decode_gcid(match.group(0))
                if gcid_id:
                    return await _get_user_list_detail_2(gcid_id)
        if "chain=" in location:
            return await _get_user_list_detail_3(re.sub(r"^.*?chain=(\w+)(?:&.*$|#.*$|$)", r"\1", location), page)
        if ".html" in location:
            if "zlist.html" in location:
                next_link = re.sub(r"^(.*)zlist\.html", "https://m3ws.kugou.com/zlist/list", location)
                if "pagesize" in next_link:
                    next_link = next_link.replace("pagesize=30", f"pagesize={LIST_DETAIL_LIMIT}").replace(
                        "page=1", f"page={page}"
                    )
                else:
                    next_link += f"&pagesize={LIST_DETAIL_LIMIT}&page={page}"
                return await _get_user_list_detail(next_link, page, retry_num + 1)
            return await _get_user_list_detail_3(re.sub(r".+\/(\w+).html(?:\?.*|&.*$|#.*$|$)", r"\1", location), page)
        return await _get_user_list_detail(location, page, retry_num + 1)

    if isinstance(resp.body, str):
        body_text = resp.body
        global_id = re.search(r'"global_collection_id":"(\w+)"', body_text)
        gcid_id = global_id.group(1) if global_id else None
        if not gcid_id:
            match = re.search(r'"encode_gic":"(\w+)"', body_text) or re.search(r'"encode_src_gid":"(\w+)"', body_text)
            if match:
                gcid_id = await _decode_gcid(match.group(1))
        if not gcid_id:
            raise RuntimeError("get list error")
        return await _get_user_list_detail_2(gcid_id)

    body = resp.body if isinstance(resp.body, dict) else {}
    if body.get("errcode") != 0:
        return await _get_user_list_detail(link, page, retry_num + 1)
    return await _get_user_list_detail_by_link(body, link)


async def get_list_detail(id: Any, page: int | None = None) -> dict[str, Any] | None:
    """歌单详情入口：按 id 形态分派到特殊页 / 链接 / 酷狗码。"""
    value = str(id)
    page_no = page or 1
    if "special/single/" in value:
        value = _LIST_DETAIL_LINK_EXP.sub(r"\1", value)
    elif re.search(r"https?:", value):
        # 修复形如 https://www.kugou.com/songlist/xxx/?uid=xxx&cover=http%3A%2F%2F... 的脏链接
        return await _get_user_list_detail(re.sub(r"^.*?http", "http", value), page_no)
    elif re.fullmatch(r"\d+", value):
        return await _get_user_list_detail_by_code(value)
    elif value.startswith("id_"):
        value = value.replace("id_", "")
    return await get_list_detail_by_special_id(value, page_no)
