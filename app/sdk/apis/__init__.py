"""取流接口层（对应原 sdk/apis/*.ts）。

每个模块导出 `SUPPORT_QUALITYS: list[str]` 与 `async def get_music_url(song_info, quality, retry_num=0)`，
返回 `{"type": <实际命中音质>, "url": <播放地址>}`。降级链由各平台自行实现。
"""
