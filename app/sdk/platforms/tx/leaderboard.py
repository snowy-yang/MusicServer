"""QQ音乐榜单（移植自 sdk/tx/leaderboard.ts）。

榜单列表是硬编码的 25 个（boardList）；详情走 musicu.fcg 的
musicToplist.ToplistInfoServer/GetDetail，period 参数（如 2026_31）从 top.html
按正则抓取并按 bangid 缓存。抓不到就传空串 —— 接口对缺省 period 容忍，
与原文 `info ? info.period : getPeriods(bangid)` 的降级一致。

上游不分页：一次返回 LIMIT 首，page 入参仅为对齐协议。
"""

from __future__ import annotations

import re
from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.common.utils import format_play_time, format_singer_name
from app.sdk.platforms.tx.filter import build_types, song_img
from app.sdk.platforms.tx.utils import MUSICU_URL, UA_MUSICU

LIMIT = 300

BOARD_LIST: list[dict[str, str]] = [
    {"id": "tx__4", "name": "流行指数榜", "bangid": "4"},
    {"id": "tx__26", "name": "热歌榜", "bangid": "26"},
    {"id": "tx__27", "name": "新歌榜", "bangid": "27"},
    {"id": "tx__62", "name": "飙升榜", "bangid": "62"},
    {"id": "tx__58", "name": "说唱榜", "bangid": "58"},
    {"id": "tx__57", "name": "喜力电音榜", "bangid": "57"},
    {"id": "tx__28", "name": "网络歌曲榜", "bangid": "28"},
    {"id": "tx__5", "name": "内地榜", "bangid": "5"},
    {"id": "tx__3", "name": "欧美榜", "bangid": "3"},
    {"id": "tx__59", "name": "香港地区榜", "bangid": "59"},
    {"id": "tx__16", "name": "韩国榜", "bangid": "16"},
    {"id": "tx__60", "name": "抖快榜", "bangid": "60"},
    {"id": "tx__29", "name": "影视金曲榜", "bangid": "29"},
    {"id": "tx__17", "name": "日本榜", "bangid": "17"},
    {"id": "tx__52", "name": "腾讯音乐人原创榜", "bangid": "52"},
    {"id": "tx__36", "name": "K歌金曲榜", "bangid": "36"},
    {"id": "tx__61", "name": "台湾地区榜", "bangid": "61"},
    {"id": "tx__63", "name": "DJ舞曲榜", "bangid": "63"},
    {"id": "tx__64", "name": "综艺新歌榜", "bangid": "64"},
    {"id": "tx__65", "name": "国风热歌榜", "bangid": "65"},
    {"id": "tx__67", "name": "听歌识曲榜", "bangid": "67"},
    {"id": "tx__72", "name": "动漫音乐榜", "bangid": "72"},
    {"id": "tx__73", "name": "游戏音乐榜", "bangid": "73"},
    {"id": "tx__75", "name": "有声榜", "bangid": "75"},
    {"id": "tx__131", "name": "校园音乐人排行榜", "bangid": "131"},
]

_PERIOD_LIST_RXP = re.compile(
    r'<i class="play_cover__btn c_tx_link js_icon_play" data-listkey=".+?" data-listname=".+?" '
    r'data-tid=".+?" data-date=".+?" .+?</i>'
)
_PERIOD_RXP = re.compile(r'data-listname="(.+?)" data-tid=".*?\/(.+?)" data-date="(.+?)" .+?</i>')
PERIOD_URL = "https://c.y.qq.com/node/pc/wk_v15/top.html"

# bangid → {"name", "bangid", "period"}（原 TS 的 periods 对象，模块级缓存）
_periods: dict[str, dict[str, str]] = {}


def filter_data(raw_list: Any) -> list[dict[str, Any]]:
    songs: list[dict[str, Any]] = []
    for item in raw_list or []:
        file = (item or {}).get("file") or {}
        types, _types = build_types(file)
        album = item.get("album") or {}
        album_name = album.get("name") or ""
        album_mid = album.get("mid") or ""
        singers = item.get("singer") or []
        songs.append(
            {
                "singer": format_singer_name(singers, "name"),
                "name": item.get("title"),
                "albumName": album_name,
                "albumId": album_mid,
                "source": "tx",
                "interval": format_play_time(item.get("interval")),
                "songId": item.get("id"),
                "albumMid": album_mid,
                "strMediaMid": file.get("media_mid"),
                "songmid": item.get("mid"),
                "img": song_img("" if album_name in ("", "空") else album_mid, singers),
                "lrc": None,
                "otherSource": None,
                "types": types,
                "_types": _types,
                "typeUrl": {},
            }
        )
    return songs


async def _get_periods(bangid: str) -> str:
    """抓 top.html 填缓存，返回该榜单的 period；抓不到返回空串（不抛错，接口容忍）。"""
    resp = await http_fetch(PERIOD_URL)
    html = resp.body if isinstance(resp.body, str) else ""
    for tag_html in _PERIOD_LIST_RXP.findall(html):
        result = _PERIOD_RXP.search(tag_html)
        if not result:
            continue
        _periods[result.group(2)] = {"name": result.group(1), "bangid": result.group(2), "period": result.group(3)}
    info = _periods.get(bangid)
    return info["period"] if info else ""


async def _list_detail_request(bangid: str, period: str, limit: int) -> dict[str, Any]:
    # topid 必须发数字：传字符串 "4" 服务端会回 toplist.code 10006（无数据），传 4 才返回榜单。
    topid: Any = int(bangid) if str(bangid).isdigit() else bangid
    resp = await http_fetch(
        MUSICU_URL,
        method="post",
        headers={"User-Agent": UA_MUSICU},
        body={
            "toplist": {
                "module": "musicToplist.ToplistInfoServer",
                "method": "GetDetail",
                "param": {"topid": topid, "num": limit, "period": period},
            },
            "comm": {"uin": 0, "format": "json", "ct": 20, "cv": 1859},
        },
    )
    return resp.body if isinstance(resp.body, dict) else {}


async def get_boards() -> dict[str, Any]:
    return {"list": BOARD_LIST, "source": "tx"}


async def get_list(bangid: str, page: int = 1, retry_num: int = 0) -> dict[str, Any]:
    retry_num += 1
    if retry_num > 3:
        raise RuntimeError("try max num")

    bare = str(bangid)
    info = _periods.get(bare)
    period = info["period"] if info else await _get_periods(bare)

    body = await _list_detail_request(bare, period, LIMIT)
    if body.get("code") != 0:
        return await get_list(bangid, page, retry_num)

    info_list = ((body.get("toplist") or {}).get("data") or {}).get("songInfoList") or []
    return {
        "total": len(info_list),
        "list": filter_data(info_list),
        "limit": LIMIT,
        "page": 1,
        "source": "tx",
    }
