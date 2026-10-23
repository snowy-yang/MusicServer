"""酷我链接解析（对应 sdk/kw/parse.ts）。

歌曲：`www.kuwo.cn/play_detail/<rid>`、`m.kuwo.cn/h5app/song/<rid>`、
`musicId=<rid>` 或裸 rid（4 位以上数字）。元数据取
`m.kuwo.cn/newh5/singles/songinfoandlrc`，风控时会回 status 301「音乐查询失败」，
按 600ms×(n+1) 退避重试最多 5 次（约 9 秒）。

直链是尽力的：版权/风控导致取流失败时仍返回元数据（与上游 fetchAudioURL 降级一致）。
"""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.common.utils import format_play_time
from app.sdk.platforms.kw import album, playlist
from app.sdk.platforms.kw.util import format_singer

_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"

SONG_PATTERNS = (
    re.compile(r"play_detail/(\d+)"),
    re.compile(r"h5app/song/(\d+)"),
    re.compile(r"musicId=(\d+)"),
    re.compile(r"^\d{4,}$"),
)

META_API = "http://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId={rid}&httpsStatus=1"
MAX_META_RETRY = 5


def extract_song_id(link: Any) -> str:
    raw = str(link if link is not None else "").strip()
    for pattern in SONG_PATTERNS:
        match = pattern.search(raw)
        if match:
            return match.group(1) if match.groups() else raw
    return ""


def _to_int(value: Any) -> int:
    try:
        return int(float(str(value).strip()))
    except (TypeError, ValueError):
        return 0


async def fetch_song_meta(rid: str, retry_num: int = 0) -> dict[str, Any]:
    resp = await http_fetch(
        META_API.format(rid=rid),
        method="get",
        headers={"User-Agent": _UA, "Cookie": "wd=1;vip=0"},
        timeout=15_000,
    )
    data: Any = resp.body
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except ValueError:
            data = None
    songinfo = ((data or {}).get("data") or {}).get("songinfo")
    if not songinfo:
        if retry_num < MAX_META_RETRY:
            await asyncio.sleep(0.6 * (retry_num + 1))
            return await fetch_song_meta(rid, retry_num + 1)
        msg = (data or {}).get("msg") if isinstance(data, dict) else None
        raise RuntimeError(msg or "酷我歌曲不存在或已下架")
    return songinfo


async def parse_song(link: str) -> dict[str, Any]:
    rid = extract_song_id(link)
    if not rid:
        raise RuntimeError("无效的酷我歌曲链接")

    meta = await fetch_song_meta(rid)
    duration = _to_int(meta.get("duration"))
    album_id = meta.get("albumId")
    song: dict[str, Any] = {
        "songmid": rid,
        "name": meta.get("songName") or f"Kuwo_Song_{rid}",
        "singer": format_singer(str(meta.get("artist") or "").strip()),
        "albumName": str(meta.get("album") or "").strip(),
        "albumId": "" if album_id is None else str(album_id),
        "interval": format_play_time(duration) if duration > 0 else "--/--",
        "img": meta.get("pic") or None,
        "lrc": None,
        "otherSource": None,
        "types": [],
        "_types": {},
        "typeUrl": {},
        "source": "kw",
        "extra": {"rid": rid, "link": f"http://www.kuwo.cn/play_detail/{rid}"},
    }

    try:
        from app.sdk.apis.kw import get_music_url

        hit = await get_music_url({"songmid": rid}, "128k")
        if hit.get("url"):
            song["url"] = hit["url"]
            song["type"] = hit["type"]
    except Exception:  # noqa: BLE001 - 版权/风控取流失败时仍返回元数据
        pass
    return song


async def parse_album(link: str) -> dict[str, Any]:
    return await album.parse_album_link(link)


async def parse_playlist(link: str) -> dict[str, Any]:
    return await playlist.parse_playlist_link(link)
