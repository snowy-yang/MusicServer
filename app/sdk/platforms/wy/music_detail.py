"""歌曲详情与音质档位换算（移植自 sdk/wy/musicDetail.ts）。

上游 weapi/v3/song/detail 返回 songs + privileges，音质档位由 privilege.maxbr/maxBrLevel 决定，
档位声明顺序与 TS 版一致（flac24bit 先 push，switch 里依次追加，最后 reverse）。
"""

from __future__ import annotations

from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.common.utils import format_play_time, size_formate
from app.sdk.platforms.wy.utils import UA_LINUX_CHROME, weapi_headers
from app.sdk.platforms.wy.utils.crypto import weapi


def _size_of(block: Any) -> str | None:
    """{size: N} → '1.23 MB'；缺块返回 None（与 TS 的 `item.x ? sizeFormate(item.x.size) : null` 一致）。"""
    if isinstance(block, dict) and block.get("size"):
        return size_formate(block["size"])
    return None


def build_types(item: dict[str, Any], privilege: dict[str, Any], *, flac_size: bool = True) -> tuple[list[dict], dict]:
    """按 privilege 生成 types/_types。`flac_size=False` 用于歌单详情（原实现那里 flac 的 size 恒为 null）。"""
    types: list[dict[str, Any]] = []
    _types: dict[str, dict[str, Any]] = {}

    if privilege.get("maxBrLevel") == "hires":
        size = _size_of(item.get("hr"))
        types.append({"type": "flac24bit", "size": size})
        _types["flac24bit"] = {"size": size}

    maxbr = privilege.get("maxbr")
    # 无 break 的 switch 直落是有意为之：高码率同时声明向下兼容的档位
    if maxbr in (999000, 320000, 192000, 128000):
        if maxbr == 999000:
            size = _size_of(item.get("sq")) if flac_size else None
            types.append({"type": "flac", "size": size})
            _types["flac"] = {"size": size}
        if maxbr in (999000, 320000):
            size = _size_of(item.get("h"))
            types.append({"type": "320k", "size": size})
            _types["320k"] = {"size": size}
        size = _size_of(item.get("l"))
        types.append({"type": "128k", "size": size})
        _types["128k"] = {"size": size}

    types.reverse()
    return types, _types


def _match_privilege(privileges: list[dict[str, Any]], item: dict[str, Any], index: int) -> dict[str, Any] | None:
    """优先按下标取，id 不符时按 id 查；都找不到返回 None（原实现会跳过该曲目）。"""
    candidate = privileges[index] if index < len(privileges) else None
    if isinstance(candidate, dict) and candidate.get("id") == item.get("id"):
        return candidate
    for privilege in privileges:
        if isinstance(privilege, dict) and privilege.get("id") == item.get("id"):
            return privilege
    return None


def get_singer(singers: Any) -> str:
    return "、".join(str(singer.get("name")) for singer in singers or [] if isinstance(singer, dict))


def filter_list(songs: list[dict[str, Any]], privileges: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """song/detail 响应 → SongInfo 列表。"""
    rows: list[dict[str, Any]] = []
    for index, item in enumerate(songs):
        if not isinstance(item, dict):
            continue
        privilege = _match_privilege(privileges, item, index)
        if privilege is None:
            continue
        types, _types = build_types(item, privilege)
        album = item.get("al") or {}
        pc = item.get("pc")
        if pc:
            # 云盘/翻唱曲目走 pc 字段（歌手/歌名/专辑为纯文本）
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
                    "singer": get_singer(item.get("ar")),
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


async def get_list(ids: list[Any] | None = None, retry_num: int = 0) -> dict[str, Any]:
    """按 id 批量取歌曲详情（weapi/v3/song/detail）。"""
    ids = ids or []
    if retry_num > 2:
        raise RuntimeError("try max num")

    form = weapi(
        {
            "c": "[" + ",".join('{"id":' + str(id_) + "}" for id_ in ids) + "]",
            "ids": "[" + ",".join(str(id_) for id_ in ids) + "]",
        }
    )
    resp = await http_fetch(
        "https://music.163.com/weapi/v3/song/detail",
        method="post",
        headers={**weapi_headers(with_cookie=False), "User-Agent": UA_LINUX_CHROME},
        form=form,
    )
    body = resp.body if isinstance(resp.body, dict) else {}
    if resp.status_code != 200 or body.get("code") != 200:
        raise RuntimeError("获取歌曲详情失败")
    return {"source": "wy", "list": filter_list(body.get("songs") or [], body.get("privileges") or [])}
