"""酷我榜单（对应 sdk/kw/leaderboard.ts）。

`get_boards` 直接返回硬编码榜单表（不发请求），id 形如 `kw__93`（路由层会剥掉前缀
再把裸 bangid 传回 `get_list`）。详情走 `wbd.kuwo.cn/api/bd/bang/bang_info`：
请求体整体 AES-128-ECB 加密 + 签名，响应同样是加密体，`util.wbd_*` 负责双向转换。
"""

from __future__ import annotations

import re
from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.common.utils import decode_name, format_play_time
from app.sdk.platforms.kw.util import format_singer, wbd_build_param, wbd_decode_data

LIST_DETAIL_LIMIT = 100

BOARD_LIST: list[dict[str, str]] = [
    {"id": "kw__93", "name": "飙升榜", "bangid": "93"},
    {"id": "kw__17", "name": "新歌榜", "bangid": "17"},
    {"id": "kw__16", "name": "热歌榜", "bangid": "16"},
    {"id": "kw__158", "name": "抖音热歌榜", "bangid": "158"},
    {"id": "kw__292", "name": "铃声榜", "bangid": "292"},
    {"id": "kw__284", "name": "热评榜", "bangid": "284"},
    {"id": "kw__290", "name": "ACG新歌榜", "bangid": "290"},
    {"id": "kw__286", "name": "台湾KKBOX榜", "bangid": "286"},
    {"id": "kw__279", "name": "冬日暖心榜", "bangid": "279"},
    {"id": "kw__281", "name": "巴士随身听榜", "bangid": "281"},
    {"id": "kw__255", "name": "KTV点唱榜", "bangid": "255"},
    {"id": "kw__280", "name": "家务进行曲榜", "bangid": "280"},
    {"id": "kw__282", "name": "熬夜修仙榜", "bangid": "282"},
    {"id": "kw__283", "name": "枕边轻音乐榜", "bangid": "283"},
    {"id": "kw__278", "name": "古风音乐榜", "bangid": "278"},
    {"id": "kw__264", "name": "Vlog音乐榜", "bangid": "264"},
    {"id": "kw__242", "name": "电音榜", "bangid": "242"},
    {"id": "kw__187", "name": "流行趋势榜", "bangid": "187"},
    {"id": "kw__204", "name": "现场音乐榜", "bangid": "204"},
    {"id": "kw__186", "name": "ACG神曲榜", "bangid": "186"},
    {"id": "kw__185", "name": "最强翻唱榜", "bangid": "185"},
    {"id": "kw__26", "name": "经典怀旧榜", "bangid": "26"},
    {"id": "kw__104", "name": "华语榜", "bangid": "104"},
    {"id": "kw__182", "name": "粤语榜", "bangid": "182"},
    {"id": "kw__22", "name": "欧美榜", "bangid": "22"},
    {"id": "kw__184", "name": "韩语榜", "bangid": "184"},
    {"id": "kw__183", "name": "日语榜", "bangid": "183"},
    {"id": "kw__145", "name": "会员畅听榜", "bangid": "145"},
    {"id": "kw__153", "name": "网红新歌榜", "bangid": "153"},
    {"id": "kw__64", "name": "影视金曲榜", "bangid": "64"},
    {"id": "kw__176", "name": "DJ嗨歌榜", "bangid": "176"},
    {"id": "kw__106", "name": "真声音", "bangid": "106"},
    {"id": "kw__12", "name": "Billboard榜", "bangid": "12"},
    {"id": "kw__49", "name": "iTunes音乐榜", "bangid": "49"},
    {"id": "kw__180", "name": "beatport电音榜", "bangid": "180"},
    {"id": "kw__13", "name": "英国UK榜", "bangid": "13"},
    {"id": "kw__164", "name": "百大DJ榜", "bangid": "164"},
    {"id": "kw__246", "name": "YouTube音乐排行榜", "bangid": "246"},
    {"id": "kw__265", "name": "韩国Genie榜", "bangid": "265"},
    {"id": "kw__14", "name": "韩国M-net榜", "bangid": "14"},
    {"id": "kw__8", "name": "香港电台榜", "bangid": "8"},
    {"id": "kw__15", "name": "日本公信榜", "bangid": "15"},
    {"id": "kw__151", "name": "腾讯音乐人原创榜", "bangid": "151"},
]

BANG_API = "https://wbd.kuwo.cn/api/bd/bang/bang_info"

_BITRATE_QUALITY = {"4000": "flac24bit", "2000": "flac", "320": "320k", "128": "128k"}
# 榜单列表按音质等级升序排列（128k → 320k → flac → flac24bit）
_QUALITY_RANK = {"flac24bit": 4, "flac": 3, "320k": 2, "128k": 1}

_MININFO_RE = re.compile(r"level:(\w+),bitrate:(\d+),format:(\w+),size:([\w.]+)")


def _filter_data(raw_list: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for item in raw_list:
        types: list[dict[str, str]] = []
        _types: dict[str, dict[str, str]] = {}
        seen: set[str] = set()
        for entry in str(item.get("n_minfo") or "").split(";"):
            match = _MININFO_RE.search(entry)
            if match is None:
                continue
            bitrate = match.group(2)
            if bitrate in seen:
                continue
            seen.add(bitrate)
            quality = _BITRATE_QUALITY.get(bitrate)
            if quality is None:
                continue
            # 原实现 types 留原样、_types 转大写，两者不完全一致
            types.append({"type": quality, "size": match.group(4)})
            _types[quality] = {"size": match.group(4).upper()}
        types.sort(key=lambda entry: _QUALITY_RANK[entry["type"]])

        result.append(
            {
                "singer": format_singer(decode_name(item.get("artist"))),
                "name": decode_name(item.get("name")),
                "albumName": decode_name(item.get("album")),
                "albumId": item.get("albumId"),
                "songmid": item.get("id"),
                "source": "kw",
                "interval": format_play_time(_to_int(item.get("duration"))),
                "img": item.get("pic"),
                "lrc": None,
                "otherSource": None,
                "types": types,
                "_types": _types,
                "typeUrl": {},
            }
        )
    return result


def _to_int(value: Any) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


async def get_boards() -> dict[str, Any]:
    return {"list": BOARD_LIST, "source": "kw"}


async def get_list(board_id: str, page: int = 1, retry_num: int = 0) -> dict[str, Any]:
    retry_num += 1
    if retry_num > 3:
        raise RuntimeError("try max num")

    body = {
        "uid": "",
        "devId": "",
        "sFrom": "kuwo_sdk",
        "user_type": "AP",
        "carSource": "kwplayercar_ar_6.0.1.0_apk_keluze.apk",
        "id": board_id,
        "pn": page - 1,
        "rn": LIST_DETAIL_LIMIT,
    }
    resp = await http_fetch(f"{BANG_API}?{wbd_build_param(body)}")
    # 原实现直接调 decodeData，解密失败即 reject、不重试，这里保持一致
    raw_data = wbd_decode_data(resp.body) if isinstance(resp.body, str) else {}
    data = raw_data.get("data") or {}
    if resp.status_code != 200 or raw_data.get("code") != 200 or not data.get("musiclist"):
        return await get_list(board_id, page, retry_num)

    return {
        "total": _to_int(data.get("total")),
        "list": _filter_data(data["musiclist"]),
        "limit": LIST_DETAIL_LIMIT,
        "page": page,
        "source": "kw",
    }
