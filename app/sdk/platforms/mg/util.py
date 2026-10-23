"""咪咕音乐公共层（对应 sdk/mg/util.ts）。

常量、请求封装、条目 → 歌曲的统一转换、档位/扩展名工具与 Z3D 解密。
上游对应 music-lib/migu/migu.go（convertItemToSong*、collectMiguFormats、pickMiguImage 等）。

匿名态 listen-url 仅放行 PQ(128k mp3)；HQ/SQ/ZQ 各档需携带登录 Cookie
（接口返回「登录后免费试听」）。

Z3D 解密与 `app/http/mg_stream.py` 的流式实现同源：那边服务 /stream/mg 代理，
这里供取流探测阶段校验候选是否真能解出音频，两处算法必须逐字一致。
"""

from __future__ import annotations

import hashlib
import math
import re
from typing import Any
from urllib.parse import urlencode

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from app.sdk.auth_store import get_cookie
from app.sdk.common.request import http_fetch

# ---------------- 常量 ----------------

#: 咪咕 toneFlag → 平台音质标签（types 展示与取流返回共用）
TONE_QUALITY: dict[str, str] = {
    "LQ": "64k",
    "PQ": "128k",
    "HQ": "320k",
    "SQ": "flac",
    "ZQ": "flac24bit",
    "ZQ24": "flac24bit",
    "ZQ32": "wav",
    "Z3D": "wav",
    "I3D": "flac24bit",
    "3D60": "wav",
}

#: tone → 明文容器扩展名（取流侧判定档位与扩展名共用）
TONE_EXT: dict[str, str] = {
    "LQ": "mp3",
    "PQ": "mp3",
    "HQ": "mp3",
    "SQ": "flac",
    "ZQ": "flac",
    "ZQ24": "flac",
    "ZQ32": "wav",
    "Z3D": "wav",
    "I3D": "m4a",
    "3D60": "wav",
}

USER_AGENT = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 9_1 like Mac OS X) AppleWebKit/601.1.46 "
    "(KHTML, like Gecko) Version/9.0 Mobile/13B143 Safari/601.1"
)
REFERER = "http://music.migu.cn/"

#: listen-url 走 Android 客户端 UA/头，与网页通道不同 UA
ANDROID_UA = "Android_migu/7.41.13 okhttp/3.12.13"
ANDROID_CHANNEL = "0146832"
ANDROID_VERSION = "7.41.13"

SONG_DETAIL_URL = "http://c.musicapp.migu.cn/MIGUM2.0/v1.0/content/resourceinfo.do"

# Z3D 加密流的 app code 密文（AES-128-CBC，key 为 AppKey 前 16 字符）
_ANDROID_APP_KEY = b"308202333082019c"
_ENCRYPTED_APP_CODE = bytes(
    [
        0xAE, 0xEA, 0xC7, 0x17, 0x05, 0xA6, 0x89, 0x55,
        0xA9, 0x31, 0xA6, 0xFE, 0x01, 0xE7, 0x28, 0xFF,
        0xF6, 0x49, 0x71, 0xE6, 0x1C, 0xEA, 0xF0, 0x0A,
        0xE3, 0xEA, 0x43, 0xC3, 0xE0, 0x58, 0x33, 0x83,
    ]
)  # fmt: skip
_Z3D_IV = bytes(range(16))

_INT_PREFIX = re.compile(r"[+-]?\d+")


# ---------------- 请求 ----------------


def get_migu_cookie() -> str:
    return get_cookie("mg").strip()


async def migu_get(url: str, extra_headers: dict[str, str] | None = None) -> Any:
    """带 Referer/UA/Cookie 的 GET，返回解析后的 body（JSON 已解析）。"""
    headers: dict[str, str] = {"User-Agent": USER_AGENT, "Referer": REFERER, **(extra_headers or {})}
    cookie = get_migu_cookie()
    if cookie:
        headers["Cookie"] = cookie
    resp = await http_fetch(url, headers=headers, timeout=20_000)
    if resp.status_code != 200:
        raise RuntimeError(f"migu http {resp.status_code}")
    return resp.body


def build_url(base: str, params: dict[str, Any]) -> str:
    """URLSearchParams 语义：值统一 String 后 form-urlencoded。"""
    return f"{base}?{urlencode([(key, str(value)) for key, value in params.items()])}"


# ---------------- 工具函数（1:1 对应上游） ----------------


def parse_int(value: Any) -> int:
    """JS parseInt 语义：取前导整数，解析不出返回 0。"""
    match = _INT_PREFIX.match(str(value if value is not None else "").strip())
    return int(match.group()) if match else 0


def to_number(value: Any) -> float:
    """JS Number() 语义：不可解析或非有限值归零（分页 totalCount / 体积等字段用）。"""
    try:
        number = float(str(value if value is not None else "").strip())
    except (TypeError, ValueError):
        return 0.0
    return number if math.isfinite(number) else 0.0


def first_non_empty(*values: Any) -> str:
    for value in values:
        if value is None:
            continue
        if str(value).strip():
            return str(value)
    return ""


def first_non_zero_string(*values: Any) -> str:
    for value in values:
        text = str(value if value is not None else "").strip()
        if text and text != "0":
            return text
    return ""


def pick_migu_image(items: Any) -> str:
    """按 02/01/03 的尺寸优先级取图，都没有则取第一张非空。"""
    if not isinstance(items, list):
        return ""
    for preferred in ("02", "01", "03"):
        for item in items:
            entry = item if isinstance(item, dict) else {}
            if entry.get("imgSizeType") == preferred and str(entry.get("img") or "").strip():
                return str(entry.get("img"))
    for item in items:
        entry = item if isinstance(item, dict) else {}
        if str(entry.get("img") or "").strip():
            return str(entry.get("img"))
    return ""


def normalize_migu_image_url(image: Any) -> str:
    url = str(image if image is not None else "").strip()
    if not url:
        return ""
    if url.startswith(("http://", "https://")):
        return url
    if url.startswith("//"):
        return f"https:{url}"
    if url.startswith("/"):
        return f"https://d.musicapp.migu.cn{url}"
    return url


def collect_migu_artist_names(item: dict[str, Any]) -> list[str]:
    names: list[str] = []
    seen: set[str] = set()

    def append(name: Any) -> None:
        text = str(name if name is not None else "").strip()
        if not text or text in seen:
            return
        seen.add(text)
        names.append(text)

    for group in ("singers", "singerList", "artists"):
        for singer in item.get(group) or []:
            append((singer or {}).get("name") if isinstance(singer, dict) else None)
    if not names:
        for name in str(item.get("singer") or "").split("|"):
            append(name)
    return names


_Z3D_CODE_KEYS = (
    "formatType",
    "resourceType",
    "size",
    "androidSize",
    "isize",
    "asize",
    "fileType",
    "androidFileType",
    "iformat",
    "aformat",
    "price",
)


def collect_migu_formats(item: dict[str, Any]) -> list[dict[str, Any]]:
    """汇总三组 rateFormats + z3dCode，按 formatType|resourceType 去重。"""
    groups: list[list[dict[str, Any]]] = []
    for key in ("newRateFormats", "rateFormats", "audioFormats"):
        group = item.get(key)
        if isinstance(group, list):
            groups.append([entry for entry in group if isinstance(entry, dict)])
    code = item.get("z3dCode")
    if isinstance(code, dict) and code.get("formatType"):
        groups.append([{key: code.get(key) for key in _Z3D_CODE_KEYS}])

    formats: list[dict[str, Any]] = []
    seen: set[str] = set()
    for group in groups:
        for fmt in group:
            key = f"{str(fmt.get('formatType') or '').strip().upper()}|{str(fmt.get('resourceType') or '').strip()}"
            if key == "|" or key in seen:
                continue
            seen.add(key)
            formats.append(fmt)
    return formats


_FORMAT_RANK: dict[str, int] = {
    "ZQ32": 80,
    "ZQ": 75,
    "ZQ24": 75,
    "SQ": 70,
    "HQ": 60,
    "I3D": 50,
    "Z3D": 50,
    "3D60": 40,
    "PQ": 30,
    "LQ": 20,
}


def migu_format_rank(format_type: Any = "") -> int:
    return _FORMAT_RANK.get(str(format_type or "").strip().upper(), 10)


def migu_format_ext(format_type: Any = "", format_code: Any = "") -> str:
    tone = str(format_type or "").strip().upper()
    code = str(format_code or "").strip()
    if tone in ("SQ", "ZQ", "ZQ24"):
        return "flac"
    if tone in ("ZQ32", "Z3D", "3D60"):
        return "wav"
    if tone == "I3D":
        return "m4a"
    if tone in ("PQ", "HQ", "LQ"):
        return "mp3"
    return "flac" if code.startswith("011") else "mp3"


def normalize_tone(value: Any = "") -> str:
    """取流档位归一：去掉前导点、大写，只认 TONE_EXT 里已知的 toneFlag。"""
    text = str(value if value is not None else "").strip()
    if text.startswith("."):
        text = text[1:]
    text = text.upper()
    return text if text in TONE_EXT else ""


def migu_album_link(album_id: str) -> str:
    return f"https://music.migu.cn/v3/music/album/{album_id}"


def migu_playlist_link(playlist_id: str) -> str:
    return f"https://music.migu.cn/v5/#/playlist?playlistId={playlist_id}&playlistType=ordinary"


def migu_song_link(content_id: str) -> str:
    return f"https://music.migu.cn/v3/music/song/{content_id}"


def format_seconds(seconds: float) -> str:
    minutes = math.floor(seconds / 60)
    secs = math.floor(seconds % 60)
    return f"{minutes:02d}:{secs:02d}"


# ---------------- 条目 → 歌曲（上游 convertItemToSongWithOption） ----------------


def _seconds_from_size(size: int, bitrate: int) -> int:
    return math.floor(size * 8 / bitrate) if bitrate > 0 else 0


def convert_item_to_song(item: dict[str, Any], allow_paid: bool = True) -> dict[str, Any] | None:
    artist_names = collect_migu_artist_names(item)
    song_name = first_non_empty(item.get("name"), item.get("songName"))
    album_name = str(item.get("album") or "").strip()
    albums = item.get("albums") or []
    if isinstance(albums, list) and albums:
        first_album = albums[0] if isinstance(albums[0], dict) else {}
        if str(first_album.get("name") or "").strip():
            album_name = str(first_album.get("name")).strip()

    formats = collect_migu_formats(item)
    if not formats:
        return None

    duration = to_number(item.get("duration"))
    download_tags = [str(tag or "").strip().lower() for tag in (item.get("downloadTags") or [])]
    candidates: list[dict[str, Any]] = []

    for index, fmt in enumerate(formats):
        size_text = first_non_zero_string(fmt.get("androidSize"), fmt.get("asize"), fmt.get("size"), fmt.get("isize"))
        size_value = parse_int(size_text)
        ext = first_non_empty(fmt.get("androidFileType"), fmt.get("fileType"))
        if not ext:
            ext = migu_format_ext(fmt.get("formatType"), first_non_empty(fmt.get("aformat"), fmt.get("iformat")))

        if not duration and size_value > 0:
            bitrate = {"PQ": 128_000, "HQ": 320_000, "LQ": 64_000}.get(str(fmt.get("formatType") or ""), 0)
            if bitrate > 0:
                duration = _seconds_from_size(size_value, bitrate)

        price_value = parse_int(fmt.get("price"))
        show_tags = fmt.get("showTag")
        tags = show_tags if isinstance(show_tags, list) and show_tags else (fmt.get("showTags") or [])
        is_vip_tag = any(str(tag or "").strip().lower() == "vip" for tag in tags)
        if not is_vip_tag:
            is_vip_tag = "vip" in download_tags
        hidden_paid = item.get("chargeAuditions") == "1" and price_value >= 200

        if allow_paid or (not is_vip_tag and not hidden_paid):
            candidates.append(
                {
                    "index": index,
                    "size": size_value,
                    "ext": ext,
                    "rank": migu_format_rank(fmt.get("formatType")),
                    "vip": is_vip_tag or hidden_paid,
                    "tone": str(fmt.get("formatType") or ""),
                }
            )

    if not candidates:
        return None

    candidates.sort(key=lambda entry: (-entry["rank"], -entry["size"]))
    best = candidates[0]
    best_format = formats[best["index"]]

    cover_url = normalize_migu_image_url(
        first_non_empty(
            pick_migu_image(item.get("imgItems")),
            pick_migu_image(item.get("albumImgs")),
            item.get("img1"),
            item.get("img2"),
            item.get("img3"),
        )
    )
    # albums 数组是搜索响应的专辑来源（顶层 albumId 常为空），与上游 Extra 的 album_id 同义
    album_id = first_non_empty(item.get("albumId"), (albums[0] if albums else {}).get("id"))
    link_id = first_non_empty(item.get("contentId"), item.get("copyrightId"))

    resource_type = best_format.get("resourceType")
    format_type = best_format.get("formatType")
    extra: dict[str, str] = {
        "content_id": str(item.get("contentId") or ""),
        # 注意：extra 用空串兜底，songmid 用 '2' 兜底（与原文两处写法不同）
        "resource_type": str(resource_type if resource_type is not None else ""),
        "format_type": str(format_type if format_type is not None else ""),
    }
    if item.get("copyrightId"):
        extra["copyright_id"] = str(item["copyrightId"])
    if item.get("songId"):
        extra["song_id"] = str(item["songId"])
    if album_id:
        extra["album_id"] = album_id

    is_vip = item.get("chargeAuditions") == "1" or bool(best["vip"])
    songmid = f"{item.get('contentId') or ''}|{resource_type if resource_type is not None else '2'}|{format_type or ''}"

    # 各档位可用性（供前端展示）；实际可取档位由取流接口的探测结果决定
    types = [{"type": TONE_QUALITY.get(entry["tone"], "128k"), "size": str(entry["size"])} for entry in candidates]

    return {
        "songmid": songmid,
        "name": song_name,
        "singer": " / ".join(artist_names),
        "albumId": album_id,
        "albumName": album_name,
        "interval": format_seconds(duration) if duration else "0",
        "img": cover_url or None,
        "lrc": None,
        "types": types,
        "_types": {},
        "payPlay": is_vip,
        # 路由/取流需要 content_id|resource_type|format_type 三元组与版权号，放在 extra 里
        "extra": {**extra, "link": migu_song_link(link_id)},
        "source": "mg",
    }


# ---------------- 歌曲详情 ----------------


async def fetch_song_detail(content_id: str) -> dict[str, Any]:
    url = build_url(SONG_DETAIL_URL, {"resourceType": "2", "resourceId": content_id})
    body = await migu_get(url)
    resource = body.get("resource") if isinstance(body, dict) else None
    if not resource:
        raise RuntimeError("migu 歌曲详情为空")
    return resource[0]


# ---------------- Z3D 解密（上游 DecryptAudio / miguZ3DStreamKey） ----------------


def is_migu_audio_magic(data: bytes) -> bool:
    """判断是否明文音频：fLaC / RIFF-WAVE / OggS / ID3 / MP4(ftyp) / MP3 帧同步。"""
    if not data or len(data) < 4:
        return False
    if data[:4] in (b"fLaC", b"OggS"):
        return True
    if data[:4] == b"RIFF" and len(data) >= 12 and data[8:12] == b"WAVE":
        return True
    if data[:3] == b"ID3":
        return True
    if len(data) >= 12 and data[4:8] == b"ftyp":
        return True
    return data[0] == 0xFF and (data[1] & 0xE0) == 0xE0


def migu_z3d_stream_key(file_key: str) -> bytes:
    """streamKey = MD5(解密后的 appCode + fileKey) 的大写十六进制（32 字节 ASCII）。"""
    key = str(file_key or "").strip()
    if not key:
        raise RuntimeError("空的 z3d fileKey")
    # Go 的 CryptBlocks 按块解密不做 PKCS#7 去填充，这里同样禁用填充，否则尾块校验失败
    decryptor = Cipher(algorithms.AES(_ANDROID_APP_KEY), modes.CBC(_Z3D_IV)).decryptor()
    app_code = decryptor.update(_ENCRYPTED_APP_CODE) + decryptor.finalize()
    digest = hashlib.md5(app_code + key.encode("utf-8")).hexdigest().upper()
    return digest.encode("ascii")


def decrypt_z3d(data: bytes, file_key: str) -> bytes:
    """Z3D 流解密：逐字节 `plain[i] = cipher[i] - key[i % 32]`；已是明文则原样返回。"""
    if not data:
        raise RuntimeError("空的 z3d 数据")
    if is_migu_audio_magic(data):
        return data
    payload = data[3:] if data[:3] == b"Z3D" else data
    if not payload:
        raise RuntimeError("剥离 Z3D 魔数后无数据")
    stream_key = migu_z3d_stream_key(file_key)
    plain = bytes((byte - stream_key[index & 31]) & 0xFF for index, byte in enumerate(payload))
    if not is_migu_audio_magic(plain):
        raise RuntimeError("z3d 解密后不是有效音频")
    return plain
