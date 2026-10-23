"""Bilibili 公共请求助手（对应 sdk/bili/util.ts，上游 music-lib/bilibili 的共享逻辑）。

与上游的差异（2026-10-02 实测）：

1) 上游硬编码的默认 cookie（buvid3=...; SESSDATA=your_sessdata;）当前会被 B 站风控：
   带上它请求 x/player/playurl 直接返回 HTTP 412（HTML 拦截页），不带 Cookie 反而正常。
   因此无登录凭据时不照抄那个默认串，而是先请求一次 www.bilibili.com 首页取新鲜的
   buvid3/b_nut（进程内缓存）；首页获取失败则不带 Cookie（实测匿名搜索/取流均可用）。
2) 请求层不跟随 302，取流的手动跟跳在 ``app/sdk/apis/bili.py`` 内处理。
3) 登录凭据来自 ``app/sdk/auth_store.py`` 的 bili 记录（扫码登录写入）。
"""

from __future__ import annotations

import asyncio
import re
from typing import Any
from urllib.parse import quote

from app.sdk.auth_store import get_credentials
from app.sdk.common.request import HttpResponse, http_fetch
from app.sdk.common.utils import as_dict, as_list, format_play_time

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0"
)
REFERER = "https://www.bilibili.com/"

HOME_URL = "https://www.bilibili.com/"


def encode_uri_component(value: Any) -> str:
    """对齐 JS 的 encodeURIComponent（不编码 !'()*，Python 的 quote 会编码它们）。"""
    return quote(str(value), safe="!~*'()")


def bili_headers(cookie: str = "") -> dict[str, str]:
    """上游 UserAgent/Referer 组合（所有接口统一携带）。"""
    headers = {
        "User-Agent": UA,
        "Referer": REFERER,
        "Accept": "application/json, text/plain, */*",
    }
    if cookie:
        headers["Cookie"] = cookie
    return headers


def get_login_cookie() -> str:
    """已保存的登录 Cookie（未登录返回空串）。"""
    cred = get_credentials("bili") or {}
    return str(cred.get("cookie") or "")


def _cookie_map(cookie_lines: list[str]) -> dict[str, str]:
    jar: dict[str, str] = {}
    for value in cookie_lines:
        pair = str(value).split(";")[0].strip()
        idx = pair.find("=")
        if idx > 0:
            jar[pair[:idx].strip()] = pair[idx + 1 :].strip()
    return jar


async def _fetch_home_cookies() -> str:
    """首页下发的新鲜 Cookie（http_fetch 保留了原始多值 Set-Cookie，同名头不会互相覆盖）。"""
    resp = await http_fetch(HOME_URL, headers=bili_headers(), timeout=15_000)
    jar = _cookie_map(resp.set_cookies)
    return "; ".join(f"{key}={value}" for key, value in jar.items())


_anon_cookie = ""
_anon_lock = asyncio.Lock()


async def get_cookie() -> str:
    """请求用 Cookie：登录态优先；否则懒加载一份匿名 buvid3（内存缓存，不落盘）。"""
    saved = get_login_cookie()
    if saved:
        return saved
    global _anon_cookie
    if _anon_cookie:
        return _anon_cookie
    async with _anon_lock:
        if _anon_cookie:
            return _anon_cookie
        try:
            _anon_cookie = await _fetch_home_cookies()
        except Exception:  # noqa: BLE001 - 拿不到就用无 Cookie 请求（实测同样可用）
            _anon_cookie = ""
    return _anon_cookie


async def api_get(url: str, cookie: str | None = None) -> HttpResponse:
    """带 B 站请求头的 GET（cookie 省略时自动取登录态/匿名 buvid3；显式传 '' 表示匿名）。"""
    ck = await get_cookie() if cookie is None else cookie
    return await http_fetch(url, headers=bili_headers(ck), timeout=15_000)


def normalize_cover(cover: Any) -> str:
    """封面协议补全（上游 normalizeCover）。"""
    text = str(cover or "")
    if not text:
        return ""
    return f"https:{text}" if text.startswith("//") else text


def clean_title(title: Any) -> str:
    """搜索标题去高亮标签（上游 cleanTitle）。"""
    if not title:
        return ""
    return re.sub(r'<em class="keyword">|</em>', "", str(title))


def parse_song_id(songmid: Any) -> dict[str, str]:
    """songmid 约定：``<bvid>|<cid>``（与上游 ID 格式一致）。"""
    raw = str(songmid if songmid is not None else "")
    idx = raw.find("|")
    if idx < 0:
        return {"bvid": raw, "cid": ""}
    return {"bvid": raw[:idx], "cid": raw[idx + 1 :]}


def extract_bvid(link: str) -> str:
    """从链接/id 提取 BV 号（兼容小写 bv）。"""
    match = re.search(r"BV[0-9A-Za-z]+", str(link or ""), re.IGNORECASE)
    return match.group(0) if match else ""


def extract_page(link: str) -> int:
    """从链接提取分P（上游 ``[?&]p=(\\d+)``）。"""
    match = re.search(r"[?&]p=(\d+)", str(link or ""))
    page = int(match.group(1)) if match else 0
    return page if page > 0 else 1


def extract_aid(link: str) -> str:
    """从链接提取 av 号（上游未支持，任务要求兼容）。"""
    match = re.search(r"\bav(\d+)\b", str(link or ""), re.IGNORECASE)
    return match.group(1) if match else ""


def to_number(value: Any) -> float:
    """JS 的 Number(value)：空值/非数字一律 0。"""
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


async def map_limit(items: list[Any], limit: int, fn: Any) -> list[Any]:
    """并发映射（限制并发数，单条失败返回 None）。"""
    source = list(items or [])
    out: list[Any] = [None] * len(source)
    if not source:
        return out
    size = max(1, min(int(limit or 1), len(source)))
    cursor = 0

    async def worker() -> None:
        nonlocal cursor
        while True:
            index = cursor
            cursor += 1
            if index >= len(source):
                return
            try:
                out[index] = await fn(source[index], index)
            except Exception:  # noqa: BLE001 - 单条失败按上游语义跳过
                out[index] = None

    await asyncio.gather(*(worker() for _ in range(size)))
    return out


def make_song(
    *,
    bvid: str,
    cid: Any,
    name: str = "",
    artist: str = "",
    album: str = "",
    duration: Any = 0,
    cover: str = "",
    page: int = 1,
) -> dict[str, Any]:
    """统一歌曲形状（对齐 MusicServer 契约；albumId/albumName 沿用上游的 bvid）。"""
    seconds = to_number(duration)
    link = f"https://www.bilibili.com/video/{bvid}" + (f"?p={page}" if page > 1 else "")
    return {
        "songmid": f"{bvid}|{cid}",
        "name": name or "",
        "singer": artist or "",
        "albumId": bvid or "",
        "albumName": album or bvid or "",
        "interval": format_play_time(seconds) if seconds else 0,
        "img": normalize_cover(cover) or None,
        "lrc": None,
        "types": [],
        "_types": {},
        "source": "bili",
        "bvid": bvid,
        "cid": str(cid if cid is not None else ""),
        "page": page,
        "link": link,
    }


def assert_api_ok(what: str, status_code: int, body: Any) -> None:
    """B 站 API 统一校验：HTTP 200 且业务码 code=0，否则抛带上下文的错误。"""
    if status_code != 200 or not isinstance(body, dict) or body.get("code") != 0:
        code = body.get("code") if isinstance(body, dict) else None
        message = body.get("message") if isinstance(body, dict) else None
        reason = code if code is not None else f"HTTP {status_code}"
        raise RuntimeError(f"B站{what}获取失败（{reason}{f': {message}' if message else ''}）")


async def fetch_view(video_id: Any) -> dict[str, Any]:
    """视频详情（x/web-interface/view）；bvid 或 aid 均可，返回 data 节点。"""
    raw = str(video_id or "").strip()
    if not raw:
        raise RuntimeError("B站视频 id 为空")
    if re.match(r"^BV", raw, re.IGNORECASE):
        query = f"bvid={encode_uri_component(raw)}"
    else:
        query = f"aid={encode_uri_component(re.sub('^av', '', raw, flags=re.IGNORECASE))}"
    resp = await api_get(f"https://api.bilibili.com/x/web-interface/view?{query}")
    assert_api_ok("视频信息", resp.status_code, resp.body)
    data = resp.body.get("data") if isinstance(resp.body, dict) else None
    if not isinstance(data, dict):
        raise RuntimeError("B站视频信息获取失败（data 为空）")
    return data


async def fetch_page_list(bvid: str) -> list[Any]:
    """分P列表（x/player/pagelist），返回 data 数组。"""
    resp = await api_get(f"https://api.bilibili.com/x/player/pagelist?bvid={encode_uri_component(bvid)}")
    assert_api_ok("分P列表", resp.status_code, resp.body)
    data = resp.body.get("data") if isinstance(resp.body, dict) else None
    return data if isinstance(data, list) else []


def _season_page_url(mid: Any, season_id: Any, page_num: int, page_size: int) -> str:
    return (
        "https://api.bilibili.com/x/space/ugc/season?"
        f"mid={mid}&season_id={season_id}&page_num={page_num}&page_size={page_size}"
    )


async def fetch_season_archive_index(mid: Any, season_id: Any) -> dict[str, Any]:
    """合集归档索引（x/space/ugc/season；上游 fetchSeasonArchiveIndex）。

    该接口现已 404，调用方需容错；返回 ``{"index", "title", "cover"}``，
    index 以 ``bvid:<bvid>`` / ``cid:<cid>`` 为键。
    """
    if not mid or not season_id:
        raise RuntimeError("合集信息无效")
    index: dict[str, dict[str, Any]] = {}
    season_title = ""
    season_cover = ""
    processed = 0
    page_num = 1
    page_size = 30
    while True:
        resp = await api_get(_season_page_url(mid, season_id, page_num, page_size))
        assert_api_ok("合集信息", resp.status_code, resp.body)
        data = resp.body.get("data") if isinstance(resp.body, dict) else None
        data = data if isinstance(data, dict) else {}
        season = as_dict(data.get("season"))
        if not season_title:
            season_title = str(season.get("title") or "")
        if not season_cover:
            season_cover = str(season.get("cover") or "")
        archives = as_list(data.get("archives"))
        if not archives:
            break
        for arc in archives:
            if not isinstance(arc, dict):
                continue
            meta = {
                "title": str(arc.get("title") or ""),
                "cover": normalize_cover(arc.get("cover") or ""),
                "duration": to_number(arc.get("duration")),
            }
            if arc.get("bvid"):
                index[f"bvid:{arc['bvid']}"] = meta
            if arc.get("cid"):
                index[f"cid:{arc['cid']}"] = meta
        processed += len(archives)
        page_info = as_dict(data.get("page"))
        total = int(to_number(page_info.get("total")))
        if not total or processed >= total:
            break
        page_num += 1
        if page_num > 100:
            break
    return {"index": index, "title": season_title, "cover": season_cover}


def build_songs_from_pages(
    bvid: str, root_title: str, author: str, cover: str, pages: list[Any]
) -> list[dict[str, Any]]:
    """由分P数组构造歌曲（上游 buildSongsFromPages）。"""
    songs: list[dict[str, Any]] = []
    for i, page in enumerate(pages or []):
        part = str(page.get("part") or "") if isinstance(page, dict) else ""
        display_title = part
        if len(pages) == 1 and not display_title:
            display_title = root_title
        elif display_title != root_title:
            display_title = f"{root_title} - {display_title}"
        songs.append(
            make_song(
                bvid=bvid,
                cid=page.get("cid") if isinstance(page, dict) else None,
                name=display_title,
                artist=author,
                album=bvid,
                duration=page.get("duration") if isinstance(page, dict) else 0,
                cover=cover,
                page=i + 1,
            )
        )
    return songs


def build_songs_from_season_sections(
    sections: list[Any],
    season_title: str,
    season_cover: str,
    artist_name: str,
    archive_index: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """由合集 sections 构造歌曲（上游 buildSongsFromSeasonSections）。"""
    index = archive_index or {}
    songs: list[dict[str, Any]] = []
    artist = artist_name or season_title
    for sec in sections or []:
        if not isinstance(sec, dict):
            continue
        for ep in sec.get("episodes") or []:
            if not isinstance(ep, dict):
                continue
            cover = str(ep.get("cover") or "")
            meta = index.get(f"bvid:{ep.get('bvid')}") or (index.get(f"cid:{ep.get('cid')}") if ep.get("cid") else None)
            if not cover:
                arc = as_dict(ep.get("arc"))
                cover = str(arc.get("pic") or "")
            if not cover:
                cover = season_cover or (meta or {}).get("cover", "")
            duration = to_number(ep.get("duration"))
            if not duration:
                page = as_dict(ep.get("page"))
                duration = to_number(page.get("duration"))
            if not duration:
                arc = as_dict(ep.get("arc"))
                duration = to_number(arc.get("duration"))
            if not duration:
                duration = to_number((meta or {}).get("duration"))
            page = as_dict(ep.get("page"))
            arc = as_dict(ep.get("arc"))
            name = str(ep.get("title") or arc.get("title") or page.get("part") or (meta or {}).get("title") or "")
            songs.append(
                make_song(
                    bvid=str(ep.get("bvid") or ""),
                    cid=ep.get("cid"),
                    name=name,
                    artist=artist,
                    album=str(ep.get("bvid") or ""),
                    duration=duration,
                    cover=cover,
                    page=1,
                )
            )
    return songs


async def fetch_season_songs(mid: Any, season_id: Any) -> list[dict[str, Any]]:
    """合集歌曲（x/space/ugc/season，上游 fetchSeasonSongs；该接口现已 404，调用方需容错）。"""
    if not mid or not season_id:
        raise RuntimeError("合集信息无效")
    all_songs: list[dict[str, Any]] = []
    processed = 0
    season_title = ""
    season_cover = ""
    page_num = 1
    page_size = 30
    while True:
        resp = await api_get(_season_page_url(mid, season_id, page_num, page_size))
        assert_api_ok("合集列表", resp.status_code, resp.body)
        data = resp.body.get("data") if isinstance(resp.body, dict) else None
        data = data if isinstance(data, dict) else {}
        season = as_dict(data.get("season"))
        if not season_title:
            season_title = str(season.get("title") or "")
        if not season_cover:
            season_cover = str(season.get("cover") or "")
        archives = as_list(data.get("archives"))
        if not archives:
            break
        for arc in archives:
            if not isinstance(arc, dict) or not arc.get("cid"):
                continue
            all_songs.append(
                make_song(
                    bvid=str(arc.get("bvid") or ""),
                    cid=arc.get("cid"),
                    name=str(arc.get("title") or ""),
                    artist="",
                    album=season_title or str(arc.get("bvid") or ""),
                    duration=arc.get("duration"),
                    cover=normalize_cover(arc.get("cover") or season_cover),
                    page=1,
                )
            )
        processed += len(archives)
        page_info = as_dict(data.get("page"))
        total = int(to_number(page_info.get("total")))
        if not total or processed >= total:
            break
        page_num += 1
        if page_num > 100:
            break
    return all_songs
