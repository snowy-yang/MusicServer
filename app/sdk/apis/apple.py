"""Apple Music 取流（对应 sdk/apis/apple.ts，上游 apple.go GetDownloadURL）。

⚠️ Apple 只提供 **preview 试听片段**（audio-ssl.itunes.apple.com，AAC/m4a，约 30-90 秒），
完整曲目是 FairPlay DRM 加密流（extendedAssetUrls.enhancedHls），需要 gamdl 等外部工具解密，
本 SDK 不提供。因此这里**任何请求档位都返回 type='preview'**，不假装是无损完整曲。

歌曲的 previews[0].url 来自 catalog 歌曲详情（搜索结果缓存里的 previewUrl 也会直接复用）。
统一返回：``{type:'preview', url, ext:'m4a', preview:true, songDuration, isrc}``
（songDuration 是歌曲完整时长，试听片段本身约 30-90 秒）；
type 请求参数不影响结果（只有 preview 一档）；supportQualitys 声明为 ['128k'] 以对齐
/sources 与 /url?quality 枚举，返回的实际档位以 type='preview' 为准。
"""

from __future__ import annotations

import math
from typing import Any

from app.sdk.common.utils import as_dict, as_list
from app.sdk.platforms.apple.util import apple_amp_get_tracked, extract_apple_id, get_apple_config

SUPPORT_QUALITYS: list[str] = ["128k"]


def _is_audio_url(value: Any) -> bool:
    text = str(value if value is not None else "")
    return text.startswith(("http://", "https://"))


def preview_from_attributes(attr: dict[str, Any]) -> dict[str, Any]:
    """详情 → preview 结果（内部/测试用）。"""
    previews = as_list(attr.get("previews"))
    url = str(as_dict(previews[0]).get("url") or "") if previews else ""
    if not url:
        raise RuntimeError("apple music: no preview URL available (完整曲目受 DRM 保护，SDK 仅提供 30-90 秒试听片段)")
    try:
        duration_ms = float(attr.get("durationInMillis") or 0)
    except (TypeError, ValueError):
        duration_ms = 0.0
    return {
        "type": "preview",
        "url": url,
        "ext": "m4a",
        "preview": True,
        # 注意：这是歌曲完整时长（catalog durationInMillis），不是试听片段长度
        "songDuration": math.floor(duration_ms / 1000 + 0.5),
        "isrc": attr.get("isrc") or "",
    }


async def get_preview_url(song_id: str) -> dict[str, Any]:
    """按 song id 拉取 preview（上游 GetDownloadURL → Parse）。"""
    cfg = get_apple_config()
    body = as_dict(
        await apple_amp_get_tracked(
            f"/v1/catalog/{cfg['storefront']}/songs/{song_id}",
            {"extend": "extendedAssetUrls"},
        )
    )
    data = as_list(body.get("data"))
    if not data:
        raise RuntimeError(f"apple song not found: {song_id}")
    return preview_from_attributes(as_dict(as_dict(data[0]).get("attributes")))


async def get_music_url(song_info: dict[str, Any], quality: str, retry_num: int = 0) -> dict[str, Any]:
    """统一取流：preview 直链优先复用，否则按 song id 拉取详情。"""
    del quality, retry_num  # 只有 preview 一档，请求档位不影响结果
    # 上游 GetDownloadURL：Song.URL 已有直链时直接复用（搜索结果里的 previewUrl / 链接解析结果）
    if _is_audio_url(song_info.get("previewUrl")):
        return {"type": "preview", "url": str(song_info["previewUrl"]), "ext": "m4a", "preview": True}
    if _is_audio_url(song_info.get("url")):
        return {"type": "preview", "url": str(song_info["url"]), "ext": "m4a", "preview": True}

    song_id = extract_apple_id(str(song_info.get("songmid") or song_info.get("id") or ""), "song")
    if not song_id:
        raise RuntimeError("apple 歌曲 id 无效（需要数字 song id 或 Apple Music 歌曲链接）")
    return await get_preview_url(song_id)
