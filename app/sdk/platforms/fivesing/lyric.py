"""5sing 歌词（对应 sdk/5sing/lyric.ts，上游 fivesing/lyric.go 的 GetLyrics）。

接口: GET http://mobileapi.5sing.kugou.com/song/newget?songid=&songtype=
  → data.dynamicWords 即 LRC 文本。

上游 ID 约定：model.Song.ID = "<songid>|<songtype>"，从 songmid 的 "|" 拆分
（路由层只透传 songmid），也接受 songInfo.songType 字段。
统一接口：返回 ``{lyric, tlyric: ''}``（5sing 无翻译歌词）。

实况（2026-10-23 匿名实测）：newget 响应不再包含 dynamicWords（搜索前 10 条与多个关键词均如此，
TS 版同样结果），因此此刻匿名取歌词会如实抛 "lyrics not found"；绑定 cookie 后是否有变化尚未验证。
"""

from __future__ import annotations

from typing import Any

from app.sdk.platforms.fivesing.music_info import fetch_dynamic_lyric
from app.sdk.platforms.fivesing.util import extract_song_id, is_foreign_source


async def get_lyric_text(song_id: str, song_type: str) -> str:
    """直接返回歌词文本（内部/测试用）。"""
    lyric = await fetch_dynamic_lyric(song_id, song_type)
    if not lyric:
        raise RuntimeError("lyrics not found")
    return lyric


async def get_lyric(song_info: dict[str, Any]) -> dict[str, str]:
    if is_foreign_source(song_info):
        raise RuntimeError("source mismatch")
    ids = extract_song_id(
        song_info.get("songmid") or song_info.get("id") or song_info.get("songid"), song_info.get("songType")
    )
    if not ids["songID"]:
        raise RuntimeError("invalid id")
    lyric = await fetch_dynamic_lyric(ids["songID"], ids["songType"])
    if not lyric:
        raise RuntimeError("lyrics not found")
    return {"lyric": lyric, "tlyric": ""}
