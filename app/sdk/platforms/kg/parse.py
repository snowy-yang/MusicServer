"""酷狗链接解析（对应 sdk/kg/parse.ts）。

歌曲：`https://www.kugou.com/song/#hash=<32位hash>`（含 &album_id= 等尾串）或裸 hash。
元数据取 `m.kugou.com/app/i/getSongInfo.php`（songName/author_name/timeLength/album_img/bitRate），
再并发合并音乐信息里的专辑与多档 hash；直链优先用 playInfo 的 url，仍为空时用 apis/kg
签名通道尽力补一次 —— 失败只返回元数据（与上游付费曲语义一致）。
"""

from __future__ import annotations

import re
from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.common.utils import decode_name, format_play_time
from app.sdk.platforms.kg import album, playlist
from app.sdk.platforms.kg.music_info import get_music_info

_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1"
)

HASH_RE = re.compile(r"hash=([a-fA-F0-9]{32})", re.IGNORECASE)
RAW_HASH_RE = re.compile(r"^[a-fA-F0-9]{32}$")


def extract_hash(link: Any) -> str:
    """链接/裸 hash → 32 位小写 hash；都不匹配返回空串。"""
    raw = str(link if link is not None else "").strip()
    match = HASH_RE.search(raw)
    if match:
        return match.group(1).lower()
    return raw.lower() if RAW_HASH_RE.match(raw) else ""


async def _fetch_song_info_php(hash_value: str) -> dict[str, Any] | None:
    resp = await http_fetch(
        f"http://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash={hash_value}",
        method="get",
        headers={"User-Agent": _UA, "Referer": "http://m.kugou.com"},
        timeout=15000,
    )
    if resp.status_code != 200 or not isinstance(resp.body, dict):
        return None
    body = resp.body
    if int(body.get("errcode") or 0) != 0 or not body.get("hash"):
        return None
    return body


async def parse_song(link: str) -> dict[str, Any]:
    import asyncio

    hash_value = extract_hash(link)
    if not hash_value:
        raise RuntimeError("无效的酷狗歌曲链接（未找到 32 位 hash）")

    raw, info = await asyncio.gather(
        _fetch_song_info_php(hash_value), get_music_info(hash_value), return_exceptions=True
    )
    raw = None if isinstance(raw, BaseException) else raw
    info = None if isinstance(info, BaseException) else info
    if not raw and not info:
        raise RuntimeError("酷狗歌曲不存在或已下架")

    raw = raw or {}
    info = info or {}
    file_name = str(raw.get("fileName") or "")
    fallback_name = " - ".join(file_name.split(" - ")[1:]) if " - " in file_name else ""
    name = decode_name(str(raw.get("songName") or "").strip() or fallback_name or info.get("name") or "")
    singer = decode_name(str(raw.get("author_name") or "").strip() or info.get("singer") or "")
    duration = int(raw.get("timeLength") or 0) or 0

    song: dict[str, Any] = {
        "songmid": str(info.get("songmid") or raw.get("audio_id") or "").strip(),
        "hash": str(raw.get("hash") or hash_value).lower(),
        "name": name,
        "singer": singer,
        "albumName": decode_name(str(info.get("albumName") or "").strip()),
        "albumId": str(info.get("albumId") or raw.get("albumid") or raw.get("req_albumid") or "").strip(),
        "interval": format_play_time(duration) if duration > 0 else (info.get("interval") or "--/--"),
        "img": str(raw.get("album_img") or "").replace("{size}", "240") or info.get("img") or None,
        "lrc": None,
        "otherSource": None,
        "types": info.get("types") or [],
        "_types": info.get("_types") or {},
        "typeUrl": {},
        "source": "kg",
        "extra": {
            "hash": str(raw.get("hash") or hash_value).lower(),
            "url": str(raw.get("url") or ""),
            "backup_url": raw.get("backup_url") or [],
            "bitrate": int(raw.get("bitRate") or 0) or 0,
            "link": f"https://www.kugou.com/song/#hash={hash_value}",
        },
    }

    # playInfo 的 url/backup_url 是官方直链（付费曲为空），优先使用
    if not song.get("url"):
        backup = raw.get("backup_url") or []
        raw_url = str(raw.get("url") or "") or str(backup[0] if backup else "")
        if raw_url:
            song["url"] = raw_url
            song["type"] = "320k" if (int(raw.get("bitRate") or 0) or 0) >= 320000 else "128k"
    # 仍无直链时（风控/付费）用签名通道尽力补一次
    if not song.get("url"):
        try:
            from app.sdk.apis.kg import get_music_url

            hit = await get_music_url(
                {
                    "hash": song["hash"],
                    "albumId": song["albumId"],
                    "songmid": song["songmid"],
                    "_types": song["_types"],
                },
                "128k",
            )
            if hit.get("url"):
                song["url"] = hit["url"]
                song["type"] = hit["type"]
        except Exception:  # noqa: BLE001 - 与上游付费曲无直链的失败语义一致：元数据仍返回
            pass
    return song


async def parse_album(link: str) -> dict[str, Any]:
    return await album.parse_album_link(link)


async def parse_playlist(link: str) -> dict[str, Any]:
    return await playlist.parse_playlist_link(link)
