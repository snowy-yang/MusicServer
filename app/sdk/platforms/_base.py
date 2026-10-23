"""平台模块契约 —— 各平台包导出 `MODULE = Platform(...)`。

对应原 TS 的 `sdk/<platform>/index.ts` default export 对象：
  const kw = { musicSearch, leaderboard, songList, hotSearch, comment, album, playlist, parse,
               getMusicUrl, getLyric, getPic, handleMusicInfo, getMusicInfo, ... }

Python 侧用 `Platform` 容器承载子模块（属性名 snake_case），能力位缺省为 None 表示不支持，
路由层据此返回 404（与 /sources 的能力位同源）。

子模块协议：
  music_search.search(keyword, page=1, limit=20, retry_num=0) -> {"list": [...], ...}
  leaderboard.get_boards() -> {"list": [{"id", "name", "bangid"}]}
  leaderboard.get_list(bangid, page=1) -> {"list", "total", "page", "limit", "source"}
  song_list.get_list(sort_id, tag_id, page=1) -> {"list", "total", "page", "limit", "source"}
  song_list.sort_list -> [{"id", "name"}]（可选，路由取首项作默认排序）
  hot_search.get_list() -> {"list": [str], "source"}
  singer.get_info(id) / get_song_list(id, page, limit) / get_album_list(id, page, limit)
  album.get_album_detail(id, page, limit) | get_album_list_detail(id, page)
  album.search_album(keyword, page, limit)
  playlist.get_playlist_detail(id, page, limit) | get_playlist_songs(id)
  playlist.search_playlist(keyword, page, limit) | get_categories() | get_category_playlists(id, page, limit)
  parse.parse_song(link) / parse_album(link) / parse_playlist(link)
  user_playlist.get_list(page, limit)

顶层方法（由 Platform 直接持有）：
  get_music_url(song_info, quality, retry_num=0) -> {"type", "url"}
  get_lyric(song_info) -> {"lyric", "tlyric", "rlyric"?, "yrc"?}
  get_pic(song_info) -> str
  get_music_info(song_info) -> dict（可选，酷我兜底等场景需要）
  handle_music_info(song_info) -> dict（可选，补全歌名/歌手/封面）
  get_music_detail_page_url(song_info) -> str（可选）
"""

from __future__ import annotations

from typing import Any

# 能力位名称（/sources 的 capabilities 键 → Platform 属性）
CAPABILITY_ATTRS = {
    "search": "music_search",
    "url": "get_music_url",
    "lyric": "get_lyric",
    "pic": "get_pic",
    "boards": "leaderboard",
    "hotSearch": "hot_search",
    "songList": "song_list",
    "singer": "singer",
    "playlist": "playlist",
    "parse": "parse",
    "userPlaylist": "user_playlist",
    "comment": "comment",
}


class Platform:
    """平台模块容器。只声明属性，不做校验 —— 缺省即不支持。"""

    # 平台短码与中文名（/sources 用）
    id: str = ""
    name: str = ""

    music_search: Any = None
    leaderboard: Any = None
    song_list: Any = None
    hot_search: Any = None
    comment: Any = None
    singer: Any = None
    album: Any = None
    playlist: Any = None
    parse: Any = None
    user_playlist: Any = None

    get_music_url: Any = None
    get_lyric: Any = None
    get_pic: Any = None
    get_music_info: Any = None
    handle_music_info: Any = None
    get_music_urls: Any = None
    get_music_detail_page_url: Any = None

    init: Any = None

    def __init__(self, **kwargs: Any) -> None:
        for key, value in kwargs.items():
            setattr(self, key, value)

    def __repr__(self) -> str:
        caps = [key for key in CAPABILITY_ATTRS.values() if getattr(self, key, None) is not None]
        return f"<Platform {self.id} caps={','.join(caps)}>"


def capability_map(platform: Platform) -> dict[str, bool]:
    """生成 /sources 的 capabilities 字段（键名沿用原 API 的驼峰写法）。"""
    caps: dict[str, bool] = {name: getattr(platform, attr, None) is not None for name, attr in CAPABILITY_ATTRS.items()}
    album = platform.album
    caps["album"] = album is not None and (
        getattr(album, "get_album_detail", None) is not None
        or getattr(album, "get_album_list_detail", None) is not None
    )
    caps["albumSearch"] = album is not None and getattr(album, "search_album", None) is not None
    playlist = platform.playlist
    caps["playlist"] = playlist is not None and getattr(playlist, "get_playlist_detail", None) is not None
    caps["playlistSearch"] = playlist is not None and getattr(playlist, "search_playlist", None) is not None
    caps["playlistCategories"] = playlist is not None and getattr(playlist, "get_categories", None) is not None
    parse = platform.parse
    caps["parse"] = parse is not None and any(
        getattr(parse, f"parse_{kind}", None) is not None for kind in ("song", "album", "playlist")
    )
    caps.pop("comment", None)
    return caps
