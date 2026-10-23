"""5sing 歌曲搜索（对应 sdk/5sing/musicSearch.ts，上游 fivesing/song.go 的 Search）。

接口: GET http://search.5sing.kugou.com/home/json?keyword=&sort=1&page=&filter=0&type=0
  返回 { list: [...], type, pageInfo: { cur, totalCount, totalPages } }，每页 10 条（服务端固定）。

内容种类：typeEname = yc(原创) / fc(翻唱) / bz(伴奏)，中文名在 typeName；
本移植把它作为统一种类字段 songType 暴露（songmid 约定仍为 "<songId>|<typeEname>"）。
时长：上游用 songSize 估算（songSize*8/320000 秒）；实测多数条目 songSize=0 → interval 返回 0。
"""

from __future__ import annotations

from typing import Any

from app.sdk.common.utils import as_dict, as_list, format_play_time
from app.sdk.platforms.fivesing.util import (
    SEARCH_API,
    build_song_link,
    encode_uri_component,
    estimate_duration,
    fetch_5sing_json,
    kind_name,
    remove_em_tags,
    unescape_html,
)


def map_search_song(item: dict[str, Any]) -> dict[str, Any]:
    """上游 Search 的 list 项 → 统一 Song 形状（source 统一 '5sing'）。"""
    song_type = str(item.get("typeEname") or "")
    duration = estimate_duration(item.get("songSize"))
    return {
        "songmid": f"{item.get('songId', '')}|{song_type}",
        "name": remove_em_tags(unescape_html(item.get("songName"))),
        "singer": remove_em_tags(unescape_html(item.get("singer") or item.get("nickName"))),
        "albumId": "",
        "albumName": "",
        "interval": format_play_time(duration) if duration > 0 else 0,
        "img": None,
        "lrc": None,
        "types": [],
        "_types": {},
        # 统一种类字段（上游 typeEname / typeName）
        "songType": song_type,
        "typeName": str(item.get("typeName") or kind_name(song_type)),
        "size": int(item.get("songSize") or 0),
        "link": build_song_link(song_type, item.get("songId")),
        "source": "5sing",
    }


async def search(keyword: str, page: int = 1, limit: int = 20, retry_num: int = 0) -> dict[str, Any]:
    del retry_num  # 契约参数，重试已在 fetch_5sing_json 内
    word = str(keyword or "").strip()
    page_no = max(1, int(page or 1))
    page_size = max(1, int(limit or 20))
    empty = {"list": [], "allPage": 0, "total": 0, "limit": page_size, "source": "5sing"}
    if not word:
        return empty

    url = f"{SEARCH_API}?keyword={encode_uri_component(word)}&sort=1&page={page_no}&filter=0&type=0"
    resp = await fetch_5sing_json(url)
    if resp.status_code != 200:
        raise RuntimeError(f"5sing 搜索失败（HTTP {resp.status_code}）")

    body = as_dict(resp.body)
    raw_list = as_list(body.get("list"))
    songs = [map_search_song(item) for item in raw_list[:page_size] if isinstance(item, dict)]
    page_info = as_dict(body.get("pageInfo"))
    total = int(page_info.get("totalCount") or 0) or len(songs)
    # 服务端每页 10 条（固定），allPage 直接用 pageInfo.totalPages
    all_page = int(page_info.get("totalPages") or 0) or (page_no + 1 if len(songs) >= page_size else page_no)
    return {"list": songs, "allPage": all_page, "total": total, "limit": page_size, "source": "5sing"}
