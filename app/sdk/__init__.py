"""SDK 聚合入口 —— 平台注册表、跨平台搜索与精确匹配。

对应原 sdk/index.ts。平台 id 对外为短码（kw/kg/tx/wy/mg/bd/joox/bili/5sing/apple），
sdk 目录与导入名使用平台名（bd → qian 目录历史已合并，见下）。

各平台包导出 `MODULE`（PlatformModule 实例），能力位按 snake_case 命名：
  music_search / leaderboard / song_list / hot_search / comment / singer /
  album / playlist / parse / user_playlist / get_music_url / get_lyric / get_pic
"""

from __future__ import annotations

import re
from typing import Any

from app.sdk.common.utils import decode_name

# 通用工具函数（平台模块 `from app.sdk import format_play_time` 的解析目标）
__all__ = [
    "SOURCE_MODULES",
    "SUPPORTED_SOURCES",
    "date_format",
    "date_format2",
    "decode_name",
    "find_music",
    "format_play_count",
    "format_play_time",
    "search_music",
    "size_formate",
    "sources",
    "support_quality",
]

from app.sdk.common.utils import (
    date_format,
    date_format2,
    format_play_count,
    format_play_time,
    size_formate,
)

_SINGERS_SEPARATOR = re.compile(r"、|&|;|；|/|,|，|\||\]|\[|!|！")


def _load_platforms() -> list[dict[str, Any]]:
    """按显示顺序加载平台包。导入失败即启动失败（与原 TS 静态导入一致）。"""
    from app.sdk.platforms import apple, bd, bili, fivesing, joox, kg, kw, lr, me, mg, qt, tx, wy, xm

    # no_aggregate：有声/播客类平台不参与聚合搜索与跨平台匹配，仅支持 source 直查
    return [
        {"id": "kw", "name": "酷我音乐", "module": kw.MODULE},
        {"id": "kg", "name": "酷狗音乐", "module": kg.MODULE},
        {"id": "tx", "name": "QQ音乐", "module": tx.MODULE},
        {"id": "wy", "name": "网易音乐", "module": wy.MODULE},
        {"id": "xm", "name": "喜马拉雅", "module": xm.MODULE, "no_aggregate": True},
        {"id": "me", "name": "猫耳FM", "module": me.MODULE, "no_aggregate": True},
        {"id": "qt", "name": "蜻蜓FM", "module": qt.MODULE, "no_aggregate": True},
        {"id": "lr", "name": "懒人听书", "module": lr.MODULE, "no_aggregate": True},
        {"id": "mg", "name": "咪咕音乐", "module": mg.MODULE},
        {"id": "bd", "name": "千千音乐", "module": bd.MODULE},
        {"id": "joox", "name": "JOOX", "module": joox.MODULE},
        {"id": "bili", "name": "哔哩哔哩", "module": bili.MODULE},
        {"id": "5sing", "name": "5sing", "module": fivesing.MODULE},
        # Apple Music 仅提供 preview 试听片段（完整曲为 DRM），不参与跨平台精确匹配
        {"id": "apple", "name": "Apple Music", "module": apple.MODULE, "no_aggregate": True},
    ]


SUPPORTED_SOURCES: list[dict[str, Any]] = _load_platforms()
SOURCE_MODULES: dict[str, Any] = {item["id"]: item["module"] for item in SUPPORTED_SOURCES}

sources: list[dict[str, Any]] = [
    {"id": item["id"], "name": item["name"], **({"noAggregate": True} if item.get("no_aggregate") else {})}
    for item in SUPPORTED_SOURCES
]


def _quality_table() -> dict[str, list[str]]:
    from app.sdk.apis import apple as apple_api
    from app.sdk.apis import bd as bd_api
    from app.sdk.apis import bili as bili_api
    from app.sdk.apis import fivesing as fivesing_api
    from app.sdk.apis import joox as joox_api
    from app.sdk.apis import kg as kg_api
    from app.sdk.apis import kw as kw_api
    from app.sdk.apis import lr as lr_api
    from app.sdk.apis import me as me_api
    from app.sdk.apis import mg as mg_api
    from app.sdk.apis import qt as qt_api
    from app.sdk.apis import tx as tx_api
    from app.sdk.apis import wy as wy_api
    from app.sdk.apis import xm as xm_api

    return {
        "kw": kw_api.SUPPORT_QUALITYS,
        "kg": kg_api.SUPPORT_QUALITYS,
        "tx": tx_api.SUPPORT_QUALITYS,
        "wy": wy_api.SUPPORT_QUALITYS,
        "xm": xm_api.SUPPORT_QUALITYS,
        "me": me_api.SUPPORT_QUALITYS,
        "qt": qt_api.SUPPORT_QUALITYS,
        "lr": lr_api.SUPPORT_QUALITYS,
        "mg": mg_api.SUPPORT_QUALITYS,
        "bd": bd_api.SUPPORT_QUALITYS,
        "joox": joox_api.SUPPORT_QUALITYS,
        "bili": bili_api.SUPPORT_QUALITYS,
        "5sing": fivesing_api.SUPPORT_QUALITYS,
        "apple": apple_api.SUPPORT_QUALITYS,
    }


support_quality: dict[str, list[str]] = _quality_table()


def _trim_str(value: Any) -> Any:
    return value.strip() if isinstance(value, str) else value


def _filter_str(value: Any) -> str:
    if isinstance(value, str):
        return re.sub(r"""\s|'|\.|,|，|&|"|、|\(|\)|（|）|`|~|-|<|>|\||/|\]|\[|!|！""", "", value)
    return "" if value is None else str(value)


def _get_interval_seconds(interval: Any) -> int:
    if not interval:
        return 0
    parts = str(interval).split(":")
    seconds = 0
    unit = 1
    while parts:
        try:
            seconds += int(parts.pop()) * unit
        except ValueError:
            pass
        unit *= 60
    return seconds


def _sort_single(singer: Any) -> str:
    if not singer:
        return ""
    text = str(singer)
    if _SINGERS_SEPARATOR.search(text):
        return "、".join(sorted(_SINGERS_SEPARATOR.split(text)))
    return text


async def search_music(
    *,
    name: str,
    singer: str | None = None,
    source: str | None = None,
    only: str | None = None,
    limit: int = 25,
) -> list[dict[str, Any]]:
    """多平台聚合搜索。

    name 歌名；singer 歌手；source 指定平台时聚合结果跳过该平台；
    only 只搜该平台（与 source 互斥，优先生效）；limit 单平台结果条数。
    """
    import asyncio

    music_name = _trim_str(name)
    tasks = []
    for item in SUPPORTED_SOURCES:
        module = item["module"]
        if getattr(module, "music_search", None) is None:
            continue
        # 有声平台（no_aggregate）仅在显式 only 指定时参与搜索
        if item.get("no_aggregate") and item["id"] != only:
            continue
        if only:
            if item["id"] != only:
                continue
        elif item["id"] == source:
            continue
        keyword = f"{music_name} {singer or ''}".strip()
        tasks.append(_search_one(module, keyword, limit))

    results = await asyncio.gather(*tasks)
    return [item for item in results if item]


async def _search_one(module: Any, keyword: str, limit: int) -> dict[str, Any] | None:
    try:
        return await module.music_search.search(keyword, 1, limit)
    except Exception:  # noqa: BLE001
        return None


async def find_music(
    *,
    name: str,
    singer: str | None = None,
    album_name: str | None = None,
    interval: str | None = None,
    source: str | None = None,
    only: str | None = None,
) -> list[dict[str, Any]]:
    """跨平台精确匹配歌曲（按歌手、歌名、专辑、时长综合排序）。"""
    lists = await search_music(name=name, singer=singer, source=source, only=only, limit=25)

    f_music_name = _filter_str(name).lower()
    f_singer = _filter_str(_sort_single(singer)).lower()
    f_album_name = _filter_str(album_name).lower()
    f_interval = _get_interval_seconds(interval)

    def is_equals_interval(value: int) -> bool:
        return abs((f_interval or value) - (value or f_interval)) < 5

    candidates: list[dict[str, Any]] = []
    for result in lists:
        for item in result.get("list") or []:
            item["name"] = _trim_str(item.get("name"))
            item["singer"] = _trim_str(item.get("singer"))
            item["_f_singer"] = _filter_str(_sort_single(item.get("singer")).lower())
            item["_f_music_name"] = _filter_str(str(item.get("name") or "").lower())
            item["_f_album_name"] = _filter_str(str(item.get("albumName") or "").lower())
            item["_f_interval"] = _get_interval_seconds(item.get("interval"))
            if not is_equals_interval(item["_f_interval"]):
                item["name"] = None
                continue
            candidates.append(item)

    matched_order: list[dict[str, Any]] = []

    def take(predicate) -> None:
        nonlocal candidates
        hit = [item for item in candidates if predicate(item)]
        rest = [item for item in candidates if not predicate(item)]
        matched_order.extend(hit)
        candidates = rest

    take(lambda i: i["_f_singer"] == f_singer and i["_f_music_name"] == f_music_name and i.get("interval") == interval)
    take(
        lambda i: (
            i["_f_music_name"] == f_music_name and i["_f_singer"] == f_singer and i["_f_album_name"] == f_album_name
        )
    )
    take(lambda i: i["_f_singer"] == f_singer and i["_f_music_name"] == f_music_name)
    take(lambda i: i["_f_music_name"] == f_music_name and i.get("interval") == interval)
    take(lambda i: i["_f_singer"] == f_singer and i.get("interval") == interval)
    take(lambda i: i.get("interval") == interval)
    take(lambda i: i["_f_music_name"] == f_music_name)
    take(lambda i: i["_f_singer"] == f_singer)
    take(lambda i: i["_f_album_name"] == f_album_name)

    for item in [*candidates, *matched_order]:
        for key in ("_f_singer", "_f_music_name", "_f_album_name", "_f_interval"):
            item.pop(key, None)

    matched_order.extend(candidates)
    return matched_order
