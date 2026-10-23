"""SDK 共享类型约定。

Python 无编译期类型强制，这里的 TypedDict / Protocol 只作为迁移时的形状文档；
运行时行为与 TS 版一致（普通 dict）。
"""

from __future__ import annotations

from typing import Any, Protocol, TypedDict, runtime_checkable

SOURCE_IDS = (
    "kw",
    "kg",
    "tx",
    "wy",
    "mg",
    "bd",
    "joox",
    "bili",
    "5sing",
    "apple",
    "xm",
    "me",
    "qt",
    "lr",
)

QUALITIES = ("64k", "128k", "320k", "flac", "flac24bit")


class SongType(TypedDict, total=False):
    type: str
    size: str


class QualityInfo(TypedDict, total=False):
    size: str


class SongInfo(TypedDict, total=False):
    songmid: str
    hash: str
    copyrightId: str
    songStringId: str
    albumId: str
    name: str | None
    singer: str
    source: str
    interval: str | int
    albumName: str
    img: str | None
    lrc: str | None
    otherSource: str | None
    types: list[SongType]
    _types: dict[str, QualityInfo]
    typeUrl: dict[str, str]


class MusicUrlResult(TypedDict, total=False):
    type: str
    url: str
    via: str
    encrypted: bool
    fileKey: str


class LyricInfo(TypedDict, total=False):
    lyric: str
    tlyric: str
    rlyric: str
    yrc: str


class SearchResult(TypedDict, total=False):
    list: list[dict[str, Any]]
    allPage: int
    total: int
    limit: int
    source: str


@runtime_checkable
class MusicSearchModule(Protocol):
    async def search(self, keyword: str, page: int = 1, limit: int = 20, retry_num: int = 0) -> SearchResult: ...


async def search(keyword: str, page: int = 1, limit: int = 20) -> SearchResult:
    """占位，供类型检查引用。"""
    raise NotImplementedError


class PlatformModule(Protocol):
    """平台模块契约（对应原 sdk/types.ts 的 PlatformModule）。

    musicSearch / leaderboard / songList / hotSearch / singer / album / playlist /
    parse / userPlaylist 为子模块对象；get_music_url / get_lyric / get_pic 为可等待方法。
    各平台按能力自由实现，缺省表示不支持（/sources 的能力位据此判断）。
    """

    musicSearch: Any
    leaderboard: Any
    songList: Any
    hotSearch: Any
    singer: Any
    album: Any
    playlist: Any
    parse: Any
    userPlaylist: Any


def cap(obj: Any, path: str | None = None) -> Any:
    """按 `album.searchAlbum` 形式的嵌套路径取能力位（None 表示不支持）。"""
    if obj is None:
        return None
    if not path:
        return obj
    cur = obj
    for key in path.split("."):
        cur = getattr(cur, key, None) if not isinstance(cur, dict) else cur.get(key)
        if cur is None:
            return None
    return cur
