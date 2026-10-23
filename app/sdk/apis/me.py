"""猫耳FM URL 获取（对应 sdk/apis/me.ts，App API 通道）。

链路：HMAC-SHA256(appsecret) 签名 → app.missevan.com/sound/sound → 免签名明文直链
  soundurl/soundurl_64 = 原文件（码率视源，常见 192k AAC）
  soundurl_128 = 128k m4a；soundurl_32 = 192k 变体（字段命名与实际码率错位，以实测为准）

实测（2026-10-02）匿名可取免费声音，直链首字节 ftyp M4A 明文可播；
付费声音需 /login/me 绑定含 token 的 cookie 后由服务端携带。

songmid 约定：裸 id = 声音 id（声音搜索/剧集列表产出）；
  "d:<drama_id>" = 广播剧（剧搜索产出）——取流时自动选剧的首个免费集（预告/第一集）。
"""

from __future__ import annotations

import re
from typing import Any

from app.sdk.common.request import http_fetch
from app.sdk.common.utils import as_dict, as_list
from app.sdk.platforms.me.music_info import get_sound_info

#: 音质 → 字段优先级（原文件可能高于 128k，128k 档固定 m4a）
QUALITY_FIELDS: dict[str, list[str]] = {
    "128k": ["soundurl_128", "soundurl", "soundurl_64", "soundurl_32"],
    "64k": ["soundurl_64", "soundurl", "soundurl_128", "soundurl_32"],
}
SUPPORT_QUALITYS: list[str] = ["64k", "128k"]


def pick_url(info: dict[str, Any], quality: str) -> dict[str, str]:
    fields = QUALITY_FIELDS.get(quality, QUALITY_FIELDS["128k"])
    url = ""
    for field in fields:
        value = info.get(field)
        if value and str(value).startswith("http"):
            url = str(value)
            break
    if not url:
        raise RuntimeError("无可用音频资源（付费内容需 POST /login/me 绑定 token）")
    hit_128 = "-128k" in url or quality == "128k"
    return {"type": "128k" if hit_128 else "64k", "url": url}


async def _resolve_drama_first_free(drama_id: str) -> str:
    """剧条目 "d:<drama_id>" → 首个免费集的 sound_id（getdrama episodes.episode[]）。"""
    resp = await http_fetch(
        f"https://www.missevan.com/dramaapi/getdrama?drama_id={drama_id}",
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
            ),
            "Accept": "application/json",
            "Referer": f"https://www.missevan.com/mdrama/{drama_id}",
        },
        timeout=15_000,
    )
    info = as_dict(resp.body).get("info") if resp.status_code == 200 else None
    episodes = as_list(as_dict(as_dict(info).get("episodes")).get("episode"))
    if not episodes:
        raise RuntimeError("剧集列表为空或已下线")
    first = next((item for item in episodes if int(as_dict(item).get("pay_type") or 0) == 0), episodes[0])
    return str(as_dict(first).get("sound_id"))


async def get_music_url(song_info: dict[str, Any], quality: str, retry_num: int = 0) -> dict[str, Any]:
    del retry_num  # 契约参数，无重试语义
    songmid = str(song_info.get("songmid") or "")
    sound_id = songmid
    if songmid.startswith("d:"):
        if not re.fullmatch(r"\d+", songmid[2:]):
            raise RuntimeError("剧 id 无效")
        sound_id = await _resolve_drama_first_free(songmid[2:])
    elif not re.fullmatch(r"\d+", sound_id):
        raise RuntimeError("me id 需为声音 id 或 d:<剧id>（见 /search?source=me 与 /album/me）")
    info = await get_sound_info(sound_id)
    return pick_url(info, quality)
