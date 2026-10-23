"""Apple Music 歌词（对应 sdk/apple/lyric.ts，上游 apple.go GetLyrics）。

通道：amp-api /v1/catalog/<sf>/songs/<id>?include=lyrics&extend=extendedAssetUrls
  → data[0].relationships.lyrics.data[*].attributes.ttml
上游取到的是 TTML（Apple 逐字歌词格式，非 LRC），原样放入 lyric 字段返回；没有则忠实返回空串。

注意（2026-10 实测）：匿名 developer token 请求时 Apple 不返回 lyrics relationship
（即使 attributes.hasLyrics=true，歌单/搜索接口也一样），歌词需要 media-user-token（订阅态）；
本实现保持上游行为：拿不到就返回 ``{lyric: '', tlyric: ''}``，不抛错。
"""

from __future__ import annotations

from typing import Any

from app.sdk.common.utils import as_dict, as_list
from app.sdk.platforms.apple.util import apple_amp_get_tracked, extract_apple_id, get_apple_config


async def get_lyric(song_info: dict[str, Any]) -> dict[str, str]:
    song_id = extract_apple_id(str(song_info.get("songmid") or song_info.get("id") or ""), "song")
    if not song_id:
        raise RuntimeError("apple 歌曲 id 无效")
    cfg = get_apple_config()
    body = as_dict(
        await apple_amp_get_tracked(
            f"/v1/catalog/{cfg['storefront']}/songs/{song_id}",
            {"include": "lyrics", "extend": "extendedAssetUrls"},
        )
    )
    data = as_list(body.get("data"))
    first = as_dict(data[0]) if data else {}
    relationships = as_dict(first.get("relationships"))
    lyrics = as_list(as_dict(relationships.get("lyrics")).get("data"))
    for rel in lyrics:
        text = str(as_dict(as_dict(rel).get("attributes")).get("ttml") or "")
        if text:
            return {"lyric": text, "tlyric": ""}
    return {"lyric": "", "tlyric": ""}


async def get_lyrics_text(song_id: str) -> str:
    """非取消句柄版：直接返回歌词文本（内部/测试用）。"""
    result = await get_lyric({"songmid": song_id})
    return result.get("lyric") or ""
