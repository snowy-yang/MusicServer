"""QQ音乐歌手（移植自 sdk/tx/singer.ts）。

上游歌手详情接口（musichallSinger.GetSingerDetail 等）已停用（104403），这里按原文的
合成路径取信息：
  * 歌手名 —— 从 GetSingerSongList 第一条曲目的 singer 数组里按 mid 反查（找不到取首位）
  * 作品数 —— GetSingerSongList 的 totalNum
  * 专辑数 —— GetAlbumList 的 total
  * 头像/性别 —— 头像走固定 URL 规则（T001），性别接口已无可信来源，返回 null
"""

from __future__ import annotations

import asyncio
from typing import Any

from app.sdk.platforms.tx.filter import album_img, music_info_item
from app.sdk.platforms.tx.utils import create_musicu_fetch

SONG_LIST_MODULE = "musichall.song_list_server"
ALBUM_LIST_MODULE = "music.musichallAlbum.AlbumListServer"


def filter_song_list(raw: Any) -> list[dict[str, Any]]:
    """GetSingerSongList 的 songList（每项包一层 {songInfo}）→ SongInfo 列表。"""
    return [music_info_item((item or {}).get("songInfo")) for item in raw or []]


def filter_album_list(raw: Any) -> list[dict[str, Any]]:
    return [
        {
            "id": item.get("albumID"),
            "mid": item.get("albumMid"),
            "count": item.get("totalNum"),
            "info": {
                "name": item.get("albumName"),
                "author": item.get("singerName"),
                "img": album_img(item.get("albumMid")),
                "desc": None,
            },
        }
        for item in raw or []
        if isinstance(item, dict)
    ]


async def get_info(id: str) -> dict[str, Any]:
    """歌手信息：歌曲数与专辑数并发取，任一失败整体失败（与原文 Promise.all 一致）。"""
    song_body, album_body = await asyncio.gather(
        create_musicu_fetch(
            {
                "req": {
                    "module": SONG_LIST_MODULE,
                    "method": "GetSingerSongList",
                    "param": {"singerMid": id, "order": 1, "begin": 0, "num": 1},
                }
            }
        ),
        create_musicu_fetch(
            {
                "req": {
                    "module": ALBUM_LIST_MODULE,
                    "method": "GetAlbumList",
                    "param": {"singerMid": id, "order": 0, "begin": 0, "num": 1, "songNumTag": 0, "singerID": 0},
                }
            }
        ),
    )
    song_req = song_body.get("req") or {}
    album_req = album_body.get("req") or {}
    if song_req.get("code") != 0 or album_req.get("code") != 0:
        raise RuntimeError("get singer info faild.")

    song_data = song_req.get("data") or {}
    album_data = album_req.get("data") or {}
    # 详情接口停用：歌手名从歌曲条目反查
    first_song = (song_data.get("songList") or [{}])[0] or {}
    singers = (first_song.get("songInfo") or {}).get("singer") or []
    self_info = next((s for s in singers if isinstance(s, dict) and s.get("mid") == id), None)
    if self_info is None:
        self_info = singers[0] if singers and isinstance(singers[0], dict) else {}
    return {
        "source": "tx",
        "id": id,
        "info": {
            "name": self_info.get("name") or "",
            "desc": None,
            "avatar": f"https://y.gtimg.cn/music/photo_new/T001R500x500M000{id}.jpg",
            "gender": None,
        },
        "count": {
            "music": song_data.get("totalNum"),
            "album": album_data.get("total"),
        },
    }


async def get_song_list(id: str, page: int = 1, limit: int = 100) -> dict[str, Any]:
    body = await create_musicu_fetch(
        {
            "req": {
                "module": SONG_LIST_MODULE,
                "method": "GetSingerSongList",
                "param": {"singerMid": id, "order": 1, "begin": (page - 1) * limit, "num": limit},
            }
        }
    )
    req = body.get("req") or {}
    if req.get("code") != 0:
        raise RuntimeError("get singer song list faild.")
    data = req.get("data") or {}
    return {
        "source": "tx",
        "list": filter_song_list(data.get("songList")),
        "limit": limit,
        "page": page,
        "total": data.get("totalNum"),
    }


async def get_album_list(id: str, page: int = 1, limit: int = 10) -> dict[str, Any]:
    body = await create_musicu_fetch(
        {
            "req": {
                "module": ALBUM_LIST_MODULE,
                "method": "GetAlbumList",
                "param": {
                    "singerMid": id,
                    "order": 0,
                    "begin": (page - 1) * limit,
                    "num": limit,
                    "songNumTag": 0,
                    "singerID": 0,
                },
            }
        }
    )
    req = body.get("req") or {}
    if req.get("code") != 0:
        raise RuntimeError("get singer album faild.")
    data = req.get("data") or {}
    return {
        "source": "tx",
        "list": filter_album_list(data.get("albumList")),
        "limit": limit,
        "page": page,
        "total": data.get("total"),
    }
