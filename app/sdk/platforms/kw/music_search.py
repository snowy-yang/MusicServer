"""酷我搜索（对应 sdk/kw/musicSearch.ts）。

搜索接口 `search.kuwo.cn/r.s` 返回的是带单引号的 JS 对象字面量，必须走
`util.obj_str2json` 而不能直接 json.loads。音质清单在 `N_MINFO` 字段里，
`;` 分隔多档、每档形如 `level:ff,bitrate:2000,format:flac,size:32.43Mb`；
`mflac`/`mgg`/`mmp4`/`zp` 等加密码流的 bitrate 是 20000+ 的随机值，不在
4000/2000/320/128 四档之内，天然被过滤掉。
"""

from __future__ import annotations

import math
import re
from typing import Any
from urllib.parse import quote

from app.sdk.common.request import http_fetch
from app.sdk.common.utils import decode_name, format_play_time
from app.sdk.platforms.kw.util import format_singer, obj_str2json

DEFAULT_LIMIT = 30

SEARCH_API = (
    "http://search.kuwo.cn/r.s?client=kt&all={keyword}&pn={pn}&rn={rn}"
    "&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newver=1"
    "&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1&issubtitle=1"
)

# bitrate 精确值 → 对外音质名。只认这四档，加密档位一律丢弃。
_BITRATE_QUALITY = {"4000": "flac24bit", "2000": "flac", "320": "320k", "128": "128k"}

_MINFO_RE = re.compile(r"level:(\w+),bitrate:(\d+),format:(\w+),size:([\w.]+)")


def _handle_result(raw_list: list[dict[str, Any]]) -> list[dict[str, Any]] | None:
    """`N_MINFO` 缺失时返回 None（原文用 console.log 提示后触发重试）。"""
    result: list[dict[str, Any]] = []
    for info in raw_list:
        n_minfo = info.get("N_MINFO")
        if not n_minfo:
            return None

        types: list[dict[str, Any]] = []
        _types: dict[str, dict[str, Any]] = {}
        for entry in str(n_minfo).split(";"):
            match = _MINFO_RE.search(entry)
            if match is None:
                continue
            quality = _BITRATE_QUALITY.get(match.group(2))
            if quality is None:
                continue
            size = match.group(4)
            types.append({"type": quality, "size": size})
            _types[quality] = {"size": size.upper()}
        # 原文按 N_MINFO 的书写顺序收集后整体反转（加密档在前，明文档在后）
        types.reverse()

        interval = _to_int(info.get("DURATION"))
        result.append(
            {
                "name": decode_name(info.get("SONGNAME")),
                "singer": format_singer(decode_name(info.get("ARTIST"))),
                "source": "kw",
                "songmid": str(info.get("MUSICRID") or "").replace("MUSIC_", ""),
                "albumId": decode_name(info.get("ALBUMID") or ""),
                "interval": format_play_time(interval),
                "albumName": decode_name(info.get("ALBUM")) if info.get("ALBUM") else "",
                "lrc": None,
                "img": None,
                "otherSource": None,
                "types": types,
                "_types": _types,
                "typeUrl": {},
            }
        )
    return result


def _to_int(value: Any) -> int:
    try:
        return int(float(str(value).strip()))
    except (TypeError, ValueError):
        return 0


async def search(keyword: str, page: int = 1, limit: int | None = None, retry_num: int = 0) -> dict[str, Any]:
    if retry_num > 2:
        raise RuntimeError("try max num")
    page_size = DEFAULT_LIMIT if limit is None else limit
    url = SEARCH_API.format(keyword=quote(keyword, safe=""), pn=page - 1, rn=page_size)
    resp = await http_fetch(url)
    # 上游偶发返回非 JSON（风控页）；原文靠 `!result` 兜住并重试
    result = resp.body
    if isinstance(result, str):
        # rformat=json 正常回合法 JSON，但风控页/旧版接口会回单引号伪 JSON
        try:
            result = obj_str2json(result)
        except ValueError:
            return await search(keyword, page, limit, retry_num + 1)
    if not isinstance(result, dict):
        return await search(keyword, page, limit, retry_num + 1)
    if result.get("TOTAL") != "0" and result.get("SHOW") == "0":
        return await search(keyword, page, limit, retry_num + 1)

    songs = _handle_result(result.get("abslist") or [])
    if songs is None:
        return await search(keyword, page, limit, retry_num + 1)

    total = _to_int(result.get("TOTAL"))
    return {
        "list": songs,
        "allPage": math.ceil(total / page_size) if page_size else 1,
        "total": total,
        "limit": page_size,
        "source": "kw",
    }
