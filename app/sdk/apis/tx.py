"""QQ音乐取流（移植自 sdk/apis/tx.ts）。

接口：musicu.fcg 的 vkey.GetVkeyServer/CgiGetVkey。

取流方案（与原文一致）：
  * 一次请求带上整条音质候选链的 filename，命中第一个有 purl 的档位即「最高可用音质」；
  * 始终附带 `C400{songmid}.m4a` 保底 —— 匿名账户唯一能拿到的 128k AAC；
  * 档位前缀：RS01 Hi-Res FLAC > Q000/AI00 大师/臻品母带 FLAC > F000 无损 FLAC >
    M800 320k MP3 > M500 128k MP3 > C400 128k AAC；
  * VIP 档 filename 用 media_mid（songmid ≠ media_mid 时用媒体 id），保底档用 songmid；
  * 登录 cookie（uin + qm_keyst，见 /login/tx）才可能解锁 320k/无损/Hi-Res，
    未登录时高档位 purl 为空，只能落到 C400 或 testfile2g 试听地址。

参数映射：路由的 song_info 只有 {"songmid", "albumId", ...}，没有 media_mid。
因此先查 songmid → media_mid（musicu 的 pf_song_detail_svr），查不到就退回用 songmid
（与原文 `songInfo.strMediaMid || songInfo.songmid` 同义）。
"""

from __future__ import annotations

from typing import Any

from app.sdk.auth_store import get_tx_auth
from app.sdk.common.request import http_fetch
from app.sdk.platforms.tx.utils import MUSICU_URL

# 音质 → 候选档位链（[prefix, ext, 命中后展示的 type]，从高到低逐级回退）
_CANDIDATES: dict[str, list[tuple[str, str, str]]] = {
    "128k": [("M500", "mp3", "128k")],
    "320k": [("M800", "mp3", "320k"), ("M500", "mp3", "128k")],
    "flac": [("F000", "flac", "flac"), ("M800", "mp3", "320k"), ("M500", "mp3", "128k")],
    "flac24bit": [
        ("RS01", "flac", "flac24bit"),
        ("Q000", "flac", "flac24bit"),
        ("AI00", "flac", "flac24bit"),
        ("F000", "flac", "flac"),
        ("M800", "mp3", "320k"),
        ("M500", "mp3", "128k"),
    ],
}

SUPPORT_QUALITYS: list[str] = list(_CANDIDATES)

_UA = "Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0)"

_mid_cache: dict[str, str] = {}


async def _resolve_media_mid(songmid: str) -> str:
    """songmid → media_mid。失败/缺失时返回空串，由调用方退回 songmid。"""
    cached = _mid_cache.get(songmid)
    if cached is not None:
        return cached
    media_mid = ""
    try:
        resp = await http_fetch(
            MUSICU_URL,
            method="post",
            headers={"User-Agent": _UA},
            body={
                "comm": {"ct": "19", "cv": "1859", "uin": "0"},
                "req": {
                    "module": "music.pf_song_detail_svr",
                    "method": "get_song_detail_yqq",
                    "param": {"song_type": 0, "song_mid": songmid},
                },
            },
        )
        body = resp.body if isinstance(resp.body, dict) else {}
        track = ((body.get("req") or {}).get("data") or {}).get("track_info") or {}
        media_mid = str((track.get("file") or {}).get("media_mid") or "")
    except (RuntimeError, OSError, TimeoutError):
        # 查不到不阻塞取流：退回 songmid（无名曲目/接口抖动时的降级行为）
        return ""
    _mid_cache[songmid] = media_mid
    return media_mid


def _build_entries(song_info: dict[str, Any], quality: str, media_mid: str) -> list[dict[str, str]]:
    songmid = str(song_info.get("songmid") or "")
    entries: list[dict[str, str]] = []
    for prefix, ext, hit_type in _CANDIDATES.get(quality) or _CANDIDATES["128k"]:
        entries.append({"filename": f"{prefix}{media_mid}.{ext}", "type": hit_type})
    # 保底：匿名 128k AAC 用 songmid（不是 media_mid）
    entries.append({"filename": f"C400{songmid}.m4a", "type": "128k"})
    return entries


async def get_music_url(song_info: dict[str, Any], quality: str, retry_num: int = 0) -> dict[str, Any]:
    """取流。返回 {"type": 实际命中音质, "url": 播放地址}（type 可能低于请求值）。

    失败文案与原文一致：`获取失败`。
    """
    if retry_num > 2:
        raise RuntimeError("获取失败")

    songmid = str(song_info.get("songmid") or "")
    if not songmid:
        raise RuntimeError("获取失败")

    media_mid = str(song_info.get("strMediaMid") or "") or await _resolve_media_mid(songmid) or songmid
    entries = _build_entries(song_info, quality, media_mid)

    auth = get_tx_auth()
    uin = str(auth.get("uin") or "0") if auth else "0"
    headers = {"User-Agent": _UA, "Referer": "https://y.qq.com/"}
    if auth and auth.get("cookie"):
        headers["cookie"] = str(auth["cookie"])

    data = {
        "comm": {"ct": "19", "cv": "1859", "uin": uin},
        "req": {
            "module": "vkey.GetVkeyServer",
            "method": "CgiGetVkey",
            "param": {
                "guid": "7342827269",
                "songmid": [songmid],
                "filename": [entry["filename"] for entry in entries],
                "songtype": [0],
                "uin": uin,
                "loginflag": 1,
                "platform": "20",
                "needNewCode": 1,
            },
        },
    }

    resp = await http_fetch(MUSICU_URL, method="post", headers=headers, body=data, timeout=15000)
    body = resp.body if isinstance(resp.body, dict) else {}
    req = body.get("req") or {}
    if resp.status_code != 200 or body.get("code") != 0 or req.get("code") != 0:
        return await get_music_url(song_info, quality, retry_num + 1)

    payload = req.get("data") or {}
    sip = (payload.get("sip") or ["http://aqqmusic.tc.qq.com/"])[0]
    infos = payload.get("midurlinfo") or []
    for index, info in enumerate(infos):
        if info.get("purl"):
            hit_type = entries[index]["type"] if index < len(entries) else "128k"
            return {"type": hit_type, "url": f"{sip}{info['purl']}"}

    # 全部受限（VIP 歌匿名）时回退服务器给的 128k m4a 试听文件
    if payload.get("testfile2g"):
        return {"type": "128k", "url": f"{sip}{payload['testfile2g']}"}
    return await get_music_url(song_info, quality, retry_num + 1)
