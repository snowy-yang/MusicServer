"""猫耳FM 曲目信息（对应 sdk/me/musicInfo.ts，App API 通道）。

接口: GET https://app.missevan.com/sound/sound?sound_id=
返回 info 直接是 sound 对象（非 web 版的 info.sound 包装）：
  soundstr/duration(毫秒)/front_cover/soundurl(原文件)/soundurl_64(=原文件)/
  soundurl_128/-192k 变体，均为 maoercdn.com 免签名明文直链。
"""

from __future__ import annotations

from typing import Any

from app.sdk.platforms.me.sign import app_api_get


async def get_sound_info(sound_id: str) -> dict[str, Any]:
    info = await app_api_get("/sound/sound", f"sound_id={sound_id}")
    return info if isinstance(info, dict) else {}
