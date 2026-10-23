"""Bilibili 链接解析（对应 sdk/bili/parse.ts，上游 bilibili/song.go 的 ``Parse``）。

支持 https://www.bilibili.com/video/BVxxx?p=2 与 av 号（上游只认 BV，任务要求兼容 av）；
与上游一致：合集（ugc_season）或多分P链接会被判定为歌单并抛错，请改用 playlist.parse_playlist_link。
上游 Parse 会顺带填入下载地址，这里同样 best-effort 填充 url（失败不影响元数据返回）。
"""

from __future__ import annotations

from typing import Any

from app.sdk.platforms.bili.playlist import parse_playlist_link
from app.sdk.platforms.bili.util import (
    as_dict,
    as_list,
    extract_aid,
    extract_bvid,
    extract_page,
    fetch_page_list,
    fetch_view,
    make_song,
    normalize_cover,
)


async def parse_song(link: str) -> dict[str, Any]:
    raw = str(link or "").strip()
    bvid = extract_bvid(raw)
    aid = extract_aid(raw)
    if not bvid and not aid:
        raise RuntimeError("无效的B站链接：未找到 BV/av 号")

    view = await fetch_view(bvid or aid)
    pages = as_list(view.get("pages"))

    # 上游：合集或多分P视为歌单链接（Parse 只处理单P）
    if view.get("ugc_season") or len(pages) > 1:
        raise RuntimeError("该链接是合集/多分P视频，请使用歌单解析（parsePlaylistLink）")
    if len(pages) <= 1:
        try:
            page_list = await fetch_page_list(view.get("bvid") or bvid)
            if len(page_list) > 1:
                raise RuntimeError("该链接是合集/多分P视频，请使用歌单解析（parsePlaylistLink）")
        except Exception as err:
            if "歌单解析" in str(err):
                raise
            # 分P列表接口失败时按上游语义忽略
    if not pages:
        raise RuntimeError("未找到视频分P")

    page = extract_page(raw)
    if page > len(pages):
        page = 1
    target = pages[page - 1] if isinstance(pages[page - 1], dict) else {}

    root_title = str(view.get("title") or "")
    display_title = str(target.get("part") or "")
    if len(pages) == 1 and not display_title:
        display_title = root_title
    elif display_title != root_title:
        display_title = f"{root_title} - {display_title}"

    owner = as_dict(view.get("owner"))
    cid = str(target.get("cid") if target.get("cid") is not None else "")
    song = make_song(
        bvid=str(view.get("bvid") or bvid),
        cid=cid,
        name=display_title,
        artist=str(owner.get("name") or ""),
        album=str(view.get("bvid") or bvid),
        duration=target.get("duration"),
        cover=normalize_cover(view.get("pic") or ""),
        page=page,
    )

    # 上游 Parse 会立即填充音频地址（失败忽略）；urls 已按 CDN 分级排序，取最优候选
    if cid:
        try:
            from app.sdk.apis.bili import get_audio_url

            audio = await get_audio_url(str(song["bvid"]), cid)
            urls = audio.get("urls") or []
            if urls:
                song["url"] = urls[0]
                song["type"] = audio.get("type")
        except Exception:  # noqa: BLE001 - 忽略：元数据仍可返回
            pass
    return song


async def parse_playlist(link: str) -> dict[str, Any]:
    """歌单/合集链接解析（上游 bilibili/playlist.go 的 ``ParsePlaylist``）。"""
    return await parse_playlist_link(link)
