"""咪咕音乐 取流（对应 sdk/apis/mg.ts）。

候选链：listen-url 多档位请求 → 按档位优先级产出「内嵌加密 / 明文直链 / 档位路径重写」
三类候选 → 逐条 Range 0-63 探测（校验音频魔数，加密流先解密再校验）→ 返回实际命中的最高档位。

匿名态仅 PQ(128k) 可用，HQ/SQ/ZQ 各档需登录 Cookie（接口回「登录后免费试听」）。

加密流：返回 `{"encrypted": True, "fileKey": "..."}`，路由据此改写成 `/stream/mg/<票据>`，
真正的逐字节解密在 `app/http/mg_stream.py`（本模块只负责产出字段与探测阶段的自校验）。

上游对应 music-lib/migu/download.go（GetDownloadInfo / buildMiguDownloadCandidates /
selectHighestValidDownload / rewriteMiguToneURL / embeddedDownloadInfoFromResponse）。
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote, unquote, urlencode, urlsplit, urlunsplit

from app.sdk.common.request import http_fetch
from app.sdk.platforms.mg.util import (
    ANDROID_CHANNEL,
    ANDROID_UA,
    ANDROID_VERSION,
    TONE_EXT,
    TONE_QUALITY,
    decrypt_z3d,
    first_non_empty,
    get_migu_cookie,
    is_migu_audio_magic,
    migu_format_ext,
    normalize_tone,
    parse_int,
)

SUPPORT_QUALITYS: list[str] = ["64k", "128k", "320k", "flac", "flac24bit"]

LISTEN_URL = "https://c.musicapp.migu.cn/MIGUM2.0/v2.1/content/listen-url"

#: 平台档位 → 咪咕 toneFlag（取流请求用）
QUALITY_TONE: dict[str, str] = {
    "64k": "LQ",
    "128k": "PQ",
    "320k": "HQ",
    "flac": "SQ",
    "flac24bit": "ZQ24",
    "wav": "ZQ32",
}

#: 可重写的 tone 路径（上游 miguTonePaths）
TONE_PATHS: dict[str, str] = {
    "LQ": "全曲试听/Mp3_64_22_16",
    "PQ": "标清高清/MP3_128_16_Stero",
    "HQ": "标清高清/MP3_320_16_Stero",
    "SQ": "歌曲下载/flac",
    "ZQ": "歌曲下载/flac_24bit",
    "ZQ24": "歌曲下载/flac_24bit",
    "ZQ32": "歌曲下载/wav_32bit",
}

TONE_PREFERENCE: list[str] = ["ZQ32", "ZQ24", "ZQ", "SQ", "HQ", "Z3D", "I3D", "3D60", "PQ", "LQ"]

#: 档位路径探测顺序（长的在前，避免 `/flac` 抢匹配 `/flac_24bit`）
_TONE_PATH_ORDER = ("ZQ24", "ZQ", "ZQ32", "SQ", "HQ", "LQ", "PQ")

MAX_PROBES = 10


def migu_song_parts(song_info: dict[str, Any]) -> dict[str, str]:
    """songinfo → (contentId, resourceType, formatType)：extra 优先，否则拆 songmid 的 `a|b|c`。"""
    extra = song_info.get("extra") or {}
    extra = extra if isinstance(extra, dict) else {}
    content_id = str(extra.get("content_id") or "").strip()
    resource_type = str(extra.get("resource_type") or "").strip()
    format_type = str(extra.get("format_type") or "").strip()
    if content_id and resource_type and format_type:
        return {"contentId": content_id, "resourceType": resource_type, "formatType": format_type}
    raw_id = str(song_info.get("songmid") or song_info.get("id") or "")
    parts = raw_id.split("|")
    if len(parts) == 3:
        return {"contentId": parts[0].strip(), "resourceType": parts[1].strip(), "formatType": parts[2].strip()}
    if not content_id:
        content_id = raw_id.strip()
    return {"contentId": content_id, "resourceType": resource_type, "formatType": format_type}


async def _fetch_listen_info(
    content_id: str, copyright_id: str, song_id: str, album_id: str, resource_type: str, tone_flag: str
) -> dict[str, Any]:
    """listen-url 请求（Android 客户端头）；失败时抛出带 api 文案的错误。"""
    params: list[tuple[str, str]] = [
        ("netType", "01"),
        ("resourceType", first_non_empty(resource_type, "2")),
        ("contentId", content_id.strip()),
        ("toneFlag", first_non_empty(tone_flag, "PQ")),
    ]
    if copyright_id.strip():
        params.append(("copyrightId", copyright_id.strip()))
    if song_id.strip():
        params.append(("songId", song_id.strip()))
    if album_id.strip():
        params.append(("albumId", album_id.strip()))

    headers: dict[str, str] = {
        "User-Agent": ANDROID_UA,
        "channel": ANDROID_CHANNEL,
        "version": ANDROID_VERSION,
        "Referer": "https://music.migu.cn/",
    }
    cookie = get_migu_cookie()
    if cookie:
        headers["Cookie"] = cookie

    resp = await http_fetch(f"{LISTEN_URL}?{urlencode(params)}", headers=headers, timeout=30_000)
    if resp.status_code < 200 or resp.status_code >= 300:
        raise RuntimeError(f"migu listen endpoint returned status {resp.status_code}")
    result = resp.body if isinstance(resp.body, dict) else {}
    if result.get("code") and result["code"] != "000000":
        raise RuntimeError(f"migu api error: {result.get('info')} (code {result.get('code')})")
    return result


def _normalize_download_url(raw_url: Any) -> str:
    url = str(raw_url if raw_url is not None else "").strip()
    if not url:
        return ""
    if url.startswith("//"):
        url = f"https:{url}"
    prefix = "ftp://218.200.160.122:21/"
    if url.startswith(prefix):
        url = f"https://freetyst.nf.migu.cn/{url[len(prefix) :]}"
    return url


def _direct_download_info(raw_url: str, fmt: str, expected_size: int) -> dict[str, Any] | None:
    url = _normalize_download_url(raw_url)
    if not url:
        return None
    ext = ""
    try:
        path = urlsplit(url).path
        ext = (path.split(".")[-1] or "").lower()
        if not ext or "/" in ext:
            ext = ""
    except ValueError:
        ext = ""
    tone = normalize_tone(fmt)
    if not ext:
        ext = TONE_EXT.get(tone, "")
    if not ext:
        ext = "mp3"
    if not tone:
        # 按扩展名回填档位（上游 formatFromMiguExt）
        tone = {"flac": "SQ", "wav": "ZQ32", "m4a": "I3D"}.get(ext, "PQ")
    return {"url": url, "format": tone, "ext": ext, "encrypted": False, "fileKey": "", "size": expected_size}


def _embedded_download_info(resp: dict[str, Any], target_tone: str, expected_size: int) -> dict[str, Any] | None:
    """z3dCode 内嵌的加密候选（Z3D/I3D/3D60），上游 embeddedDownloadInfoFromResponse。"""
    data = resp.get("data") if isinstance(resp, dict) else None
    song_item = (data or {}).get("songItem") if isinstance(data, dict) else None
    code = (song_item or {}).get("z3dCode") if isinstance(song_item, dict) else None
    if not isinstance(code, dict):
        return None

    def parse_size(value: Any) -> int:
        size = parse_int(value)
        return size if size > 0 else 0

    if target_tone == "Z3D":
        url = _normalize_download_url(first_non_empty(code.get("androidUrl"), code.get("url")))
        file_key = str(code.get("androidFileKey") or "").strip()
        if not url or not file_key:
            return None
        ext = first_non_empty(str(code.get("androidFileType") or "").removeprefix("."), "wav")
        return {
            "url": url,
            "format": "Z3D",
            "ext": ext,
            "encrypted": True,
            "fileKey": file_key,
            "size": parse_size(code.get("androidSize")) or expected_size,
        }
    if target_tone == "I3D":
        url = _normalize_download_url(first_non_empty(code.get("iosUrl"), code.get("url")))
        file_key = str(code.get("iosFileKey") or "").strip()
        if not url or not file_key:
            return None
        ext = first_non_empty(str(code.get("iosFileType") or "").removeprefix("."), "m4a")
        return {
            "url": url,
            "format": "I3D",
            "ext": ext,
            "encrypted": True,
            "fileKey": file_key,
            "size": parse_size(code.get("iosSize")) or expected_size,
        }
    if target_tone == "3D60":
        url = _normalize_download_url(first_non_empty(code.get("url"), code.get("h5Url")))
        if not url:
            return None
        ext = first_non_empty(str(code.get("fileType") or "").removeprefix("."), "wav")
        return {
            "url": url,
            "format": "3D60",
            "ext": ext,
            "encrypted": False,
            "fileKey": "",
            "size": parse_size(code.get("size")) or expected_size,
        }
    return None


def _detect_tone_path(decoded_path: str) -> str:
    for tone in _TONE_PATH_ORDER:
        tone_path = TONE_PATHS.get(tone, "")
        if tone_path and tone_path in decoded_path:
            return tone_path
    return ""


def _rewrite_tone_url(raw_url: str, target_tone: str) -> str | None:
    """把直链路径里的档位段替换为目标档位（上游 rewriteMiguToneURL）。"""
    tone = normalize_tone(target_tone)
    target_path = TONE_PATHS.get(tone)
    target_ext = TONE_EXT.get(tone)
    if not target_path or not target_ext or tone in ("Z3D", "I3D", "3D60"):
        return None
    try:
        parts = urlsplit(_normalize_download_url(raw_url))
    except ValueError:
        return None
    decoded_path = unquote(parts.path)
    source_path = _detect_tone_path(decoded_path)
    if not source_path:
        return None
    new_path = decoded_path.replace(source_path, target_path)
    if new_path == decoded_path:
        return None
    dot_index = new_path.rfind(".")
    if dot_index > new_path.rfind("/"):
        new_path = new_path[:dot_index]
    new_path += f".{target_ext}"
    # JS 的 `parsed.pathname = ...` 会把中文等非 ASCII 重新百分号编码
    return urlunsplit((parts.scheme, parts.netloc, quote(new_path, safe="/"), parts.query, parts.fragment))


def _build_candidates(responses: list[dict[str, Any]], expected_size: int) -> list[dict[str, Any]]:
    """候选链：按档位优先级（high→low）产出直接/内嵌/重写三类候选。"""
    sources: list[dict[str, str]] = []
    seen_sources: set[str] = set()
    for resp in responses:
        data = resp.get("data") if isinstance(resp, dict) else None
        candidate_url = _normalize_download_url((data or {}).get("url") if isinstance(data, dict) else None)
        if not candidate_url:
            continue
        actual_format = normalize_tone((data or {}).get("formatType")) or "PQ"
        key = f"{actual_format}\u0000{candidate_url}"
        if key in seen_sources:
            continue
        seen_sources.add(key)
        sources.append({"url": candidate_url, "format": actual_format})

    candidates: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add(info: dict[str, Any] | None) -> None:
        if not info or not info["url"]:
            return
        key = f"{info['format']}\u0000{info['url']}"
        if key in seen:
            return
        seen.add(key)
        candidates.append(info)

    for tone in TONE_PREFERENCE:
        for resp in responses:
            add(_embedded_download_info(resp, tone, expected_size))
        for source in sources:
            if tone == source["format"]:
                add(_direct_download_info(source["url"], source["format"], expected_size))
                continue
            rewritten = _rewrite_tone_url(source["url"], tone)
            if rewritten:
                add(_direct_download_info(rewritten, tone, 0))
    return candidates


async def _download_info_valid(info: dict[str, Any]) -> bool:
    """探测候选可用性：Range 0-63 校验音频魔数（加密流先解密再校验），并回填真实体积。"""
    try:
        headers: dict[str, str] = {
            "User-Agent": ANDROID_UA,
            "Referer": "https://music.migu.cn/",
            "Range": "bytes=0-63",
        }
        cookie = get_migu_cookie()
        if cookie:
            headers["Cookie"] = cookie
        resp = await http_fetch(info["url"], headers=headers, timeout=10_000)
        if resp.status_code < 200 or resp.status_code >= 300:
            return False
        prefix = resp.raw[:64]
        if not prefix:
            return False
        if info["encrypted"]:
            try:
                decrypt_z3d(prefix, info["fileKey"])
            except Exception:  # noqa: BLE001 - 探测失败即视为该候选不可用
                return False
        elif not is_migu_audio_magic(prefix):
            return False
        content_range = resp.header("content-range")
        slash = content_range.rfind("/")
        if slash >= 0:
            size = parse_int(content_range[slash + 1 :])
            if size > 0:
                info["size"] = size
        return True
    except Exception:  # noqa: BLE001 - 任一候选探测异常都只代表该候选不可用
        return False


async def get_music_url(song_info: dict[str, Any], quality: str, retry_num: int = 0) -> dict[str, Any]:
    """取流入口：候选链 + 逐档探测；返回实际命中的最高档位。"""
    parts = migu_song_parts(song_info)
    content_id = parts["contentId"]
    if not content_id:
        raise RuntimeError("migu 歌曲 id 无效（需 contentId 或 contentId|resourceType|formatType）")
    resource_type = parts["resourceType"] or "2"
    target_tone = (
        normalize_tone(QUALITY_TONE.get(quality, ""))
        or normalize_tone(parts["formatType"])
        or normalize_tone(song_info.get("ext"))
        or "PQ"
    )

    extra = song_info.get("extra") or {}
    extra = extra if isinstance(extra, dict) else {}
    copyright_id = str(extra.get("copyright_id") or "")
    song_id = str(extra.get("song_id") or "")
    album_id = str(extra.get("album_id") or song_info.get("albumId") or "")

    request_tones: list[str] = []
    for tone in ("ZQ32", target_tone, "PQ"):
        if tone not in request_tones:
            request_tones.append(tone)

    responses: list[dict[str, Any]] = []
    fetch_err: Exception | None = None
    for tone in request_tones:
        try:
            responses.append(await _fetch_listen_info(content_id, copyright_id, song_id, album_id, resource_type, tone))
        except Exception as err:  # noqa: BLE001 - 多档位请求，单档失败不影响其它档
            if fetch_err is None:
                fetch_err = err
    if not responses:
        raise fetch_err or RuntimeError("migu listen-url 全部失败")

    expected_size = parse_int(song_info.get("size"))
    candidates = _build_candidates(responses, expected_size)
    for probed, candidate in enumerate(candidates):
        if probed >= MAX_PROBES:
            break
        if await _download_info_valid(candidate):
            result: dict[str, Any] = {
                "type": TONE_QUALITY.get(candidate["format"], quality),
                "url": candidate["url"],
            }
            if candidate["encrypted"]:
                result["encrypted"] = True
                result["fileKey"] = candidate["fileKey"]
            result["ext"] = candidate["ext"] or migu_format_ext(candidate["format"])
            result["size"] = candidate["size"]
            return result

    # 全部候选不可用：优先回传接口文案（如「登录后免费试听」）
    dialog = next(
        (
            str(((resp.get("data") or {}).get("dialogInfo") or {}).get("text") or "").strip()
            for resp in responses
            if str(((resp.get("data") or {}).get("dialogInfo") or {}).get("text") or "").strip()
        ),
        "",
    )
    if dialog:
        raise RuntimeError(f"migu 无可用音频：{dialog}（登录后可解锁更高档位）")
    if fetch_err is not None:
        raise fetch_err
    raise RuntimeError("migu 未返回可访问的音频档位")
