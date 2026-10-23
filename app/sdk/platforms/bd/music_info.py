"""千千音乐单曲信息（对应 sdk/bd/musicInfo.ts）。

接口返回 `data[]`：title/albumTitle/albumAssetCode/pic/duration/artist/lyric（歌词文本 URL）。
"""

from __future__ import annotations

from typing import Any

from app.sdk.platforms.bd.util import APP_ID, api_get, api_ok, error_text, map_track


async def get_song_info(tsid: str) -> dict[str, Any]:
    """由 TSID 取单曲信息（归一为 Song 形状，并附 lyricUrl）。"""
    id = str(tsid if tsid is not None else "").strip()
    if not id:
        raise RuntimeError("千千歌曲 id（TSID）为空")
    body = await api_get("/v1/song/info", {"TSID": id, "appid": APP_ID})
    data = body.get("data") if isinstance(body, dict) else None
    if not api_ok(body) and not isinstance(data, list):
        raise RuntimeError(error_text(body, "千千歌曲信息获取失败"))

    item = data[0] if isinstance(data, list) and data else None
    if not isinstance(item, dict):
        raise RuntimeError("千千歌曲不存在或已下架")

    song = map_track(item)
    return {
        **song,
        # 以入参 id 兜底（song/info 的 TSID 字段缺失时仍可继续取流/歌词）
        "songmid": song["songmid"] or id,
        "lyricUrl": str(item.get("lyric") or "").strip(),
        "raw": item,
    }
