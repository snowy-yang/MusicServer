"""OpenAPI 领域模型 —— 注册为 FastAPI 共享 components schema。

路由的 response 通过 `{$ref: "#/components/schemas/名称"}` 引用。
注：additionalProperties: true 保证序列化时不剥离未声明字段。
"""

from __future__ import annotations

from typing import Any


def ref(name: str) -> dict[str, Any]:
    return {"$ref": f"#/components/schemas/{name}"}


COMPONENT_SCHEMAS: dict[str, Any] = {
    "ErrorEnvelope": {
        "type": "object",
        "properties": {
            "code": {"type": "integer", "description": "与 HTTP 状态码一致", "example": 422},
            "msg": {"type": "string", "description": "错误描述"},
        },
        "additionalProperties": True,
        "required": ["code", "msg"],
    },
    "QualityInfo": {
        "type": "object",
        "properties": {"size": {"type": "string", "example": "9.8M"}},
        "additionalProperties": True,
    },
    "SongType": {
        "type": "object",
        "properties": {
            "type": {"type": "string", "example": "320k", "enum": ["128k", "320k", "flac", "flac24bit"]},
            "size": {"type": "string", "example": "9.8M"},
        },
        "additionalProperties": True,
    },
    "SongInfo": {
        "type": "object",
        "properties": {
            "songmid": {"type": "string", "description": "平台歌曲 id（kg 平台为 hash）"},
            "hash": {"type": "string", "description": "kg 平台的歌曲 hash"},
            "copyrightId": {"type": "string", "description": "平台版权 id（原 mg 平台使用）"},
            "albumId": {"type": "string"},
            "name": {"type": "string", "description": "歌名"},
            "singer": {"type": "string", "description": "歌手"},
            "source": {"type": "string", "description": "来源平台 id"},
            "interval": {"type": "string", "description": "时长，格式 mm:ss"},
            "albumName": {"type": "string"},
            "img": {"type": ["string", "null"], "description": "封面地址"},
            "types": {"type": "array", "items": ref("SongType"), "description": "可用音质列表"},
            "_types": {"type": "object", "additionalProperties": ref("QualityInfo")},
            "typeUrl": {"type": "object"},
        },
        "additionalProperties": True,
    },
    "SearchResult": {
        "type": "object",
        "properties": {
            "source": {"type": "string", "description": "来源平台 id，聚合搜索时为 all"},
            "list": {"type": "array", "items": ref("SongInfo")},
            "page": {"type": "integer"},
            "limit": {"type": "integer"},
        },
        "additionalProperties": True,
    },
    "FindResult": {
        "type": "object",
        "properties": {
            "list": {"type": "array", "items": ref("SongInfo"), "description": "按匹配度排序的歌曲列表"},
        },
        "additionalProperties": True,
    },
    "MusicUrlResult": {
        "type": "object",
        "properties": {
            "type": {"type": "string", "example": "320k", "description": "实际命中的音质（降级链可能低于请求音质）"},
            "url": {"type": "string", "description": "播放地址"},
            "via": {
                "type": "string",
                "example": "kw",
                "description": "实际命中通道：平台 id / kw=酷我兜底；直接命中时不返回该字段",
            },
        },
        "additionalProperties": True,
    },
    "LyricInfo": {
        "type": "object",
        "properties": {
            "lyric": {"type": "string", "description": "原文歌词（LRC）"},
            "tlyric": {"type": "string", "description": "翻译歌词"},
            "rlyric": {"type": "string", "description": "罗马音歌词（部分平台）"},
            "yrc": {"type": "string", "description": "逐字歌词（部分平台）"},
        },
        "additionalProperties": True,
        "required": ["lyric", "tlyric"],
    },
    "PicResult": {
        "type": "object",
        "properties": {"url": {"type": "string", "description": "封面地址"}},
        "additionalProperties": True,
    },
    "BoardItem": {
        "type": "object",
        "properties": {
            "id": {"type": "string", "description": "榜单 id，用于榜单详情接口"},
            "name": {"type": "string"},
            "bangid": {"type": "string", "description": "平台原始榜单 id"},
        },
        "additionalProperties": True,
    },
    "BoardListResult": {
        "type": "object",
        "properties": {"list": {"type": "array", "items": ref("BoardItem")}},
        "additionalProperties": True,
    },
    "SingerInfo": {
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "歌手名"},
            "desc": {"type": ["string", "null"], "description": "歌手简介"},
            "avatar": {"type": ["string", "null"], "description": "头像地址"},
            "gender": {"type": ["string", "null"], "description": "性别（man/woman）"},
        },
        "additionalProperties": True,
    },
    "SingerInfoResult": {
        "type": "object",
        "properties": {
            "source": {"type": "string"},
            "id": {"type": "string", "description": "平台歌手 id"},
            "info": ref("SingerInfo"),
            "count": {
                "type": "object",
                "properties": {
                    "music": {"type": ["integer", "null"], "description": "歌曲数"},
                    "album": {"type": ["integer", "null"], "description": "专辑数"},
                },
                "additionalProperties": True,
            },
        },
        "additionalProperties": True,
    },
    "SingerAlbumItem": {
        "type": "object",
        "properties": {
            "id": {"type": "string", "description": "专辑 id，可用于 /album/:source/:id"},
            "mid": {"type": "string", "description": "tx 平台专辑 mid"},
            "count": {"type": ["integer", "null"], "description": "专辑曲目数"},
            "info": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "author": {"type": ["string", "null"]},
                    "img": {"type": ["string", "null"]},
                    "desc": {"type": ["string", "null"]},
                },
                "additionalProperties": True,
            },
        },
        "additionalProperties": True,
    },
    "SingerAlbumListResult": {
        "type": "object",
        "properties": {
            "source": {"type": "string"},
            "list": {"type": "array", "items": ref("SingerAlbumItem")},
            "page": {"type": "integer"},
            "limit": {"type": "integer"},
            "total": {"type": ["integer", "string", "null"]},
        },
        "additionalProperties": True,
    },
    "SingerSongListResult": {
        "type": "object",
        "properties": {
            "source": {"type": "string"},
            "list": {"type": "array", "items": ref("SongInfo")},
            "page": {"type": "integer"},
            "limit": {"type": "integer"},
            "total": {"type": ["integer", "string", "null"]},
        },
        "additionalProperties": True,
    },
    "AlbumInfo": {
        "type": "object",
        "properties": {
            "name": {"type": ["string", "null"], "description": "专辑名"},
            "img": {"type": ["string", "null"], "description": "专辑封面"},
            "desc": {"type": ["string", "null"], "description": "专辑简介"},
            "author": {"type": ["string", "null"], "description": "专辑作者"},
        },
        "additionalProperties": True,
    },
    "AlbumDetailResult": {
        "type": "object",
        "properties": {
            "source": {"type": "string"},
            "info": ref("AlbumInfo"),
            "list": {"type": "array", "items": ref("SongInfo"), "description": "专辑曲目"},
            "page": {"type": "integer"},
            "limit": {"type": ["integer", "string", "null"]},
            "total": {"type": ["integer", "string", "null"]},
        },
        "additionalProperties": True,
    },
    "SongItem": {
        "type": "object",
        "properties": {
            "singer": {"type": "string"},
            "name": {"type": "string"},
            "albumName": {"type": "string"},
            "albumId": {"type": "string"},
            "source": {"type": "string"},
            "interval": {"type": "string"},
            "songmid": {"type": "string"},
            "hash": {"type": "string"},
            "img": {"type": "string"},
            "types": {"type": "array", "items": ref("SongType")},
        },
        "additionalProperties": True,
    },
    "BoardDetailResult": {
        "type": "object",
        "properties": {
            "list": {"type": "array", "items": ref("SongItem")},
            "total": {"type": "integer"},
            "page": {"type": "integer"},
            "limit": {"type": "integer"},
            "source": {"type": "string"},
        },
        "additionalProperties": True,
    },
    "HotSearchResult": {
        "type": "object",
        "properties": {
            "source": {"type": "string"},
            "list": {"type": "array", "items": {"type": "string"}},
        },
        "additionalProperties": True,
    },
    "SongListSummary": {
        "type": "object",
        "properties": {
            "play_count": {"type": "string", "description": "播放量（已格式化）"},
            "id": {"type": "string", "description": "歌单 id"},
            "author": {"type": "string"},
            "name": {"type": "string"},
            "time": {"type": "string"},
            "img": {"type": "string"},
            "total": {"type": "integer", "description": "歌曲数"},
            "desc": {"type": "string"},
            "source": {"type": "string"},
        },
        "additionalProperties": True,
    },
    "SongListResult": {
        "type": "object",
        "properties": {
            "list": {"type": "array", "items": ref("SongListSummary")},
            "total": {"type": "integer"},
            "page": {"type": "integer"},
            "limit": {"type": "integer"},
            "source": {"type": "string"},
        },
        "additionalProperties": True,
    },
    "SourceInfo": {
        "type": "object",
        "properties": {
            "id": {"type": "string", "example": "kw"},
            "name": {"type": "string", "example": "酷我音乐"},
            "qualities": {"type": "array", "items": {"type": "string"}, "description": "支持的音质"},
            "capabilities": {
                "type": "object",
                "properties": {
                    "search": {"type": "boolean"},
                    "url": {"type": "boolean"},
                    "lyric": {"type": "boolean"},
                    "pic": {"type": "boolean"},
                    "boards": {"type": "boolean"},
                    "hotSearch": {"type": "boolean"},
                    "songList": {"type": "boolean"},
                    "singer": {"type": "boolean", "description": "支持歌手接口（/singer/:source/:id）"},
                    "album": {"type": "boolean", "description": "支持专辑接口（/album/:source/:id）"},
                    "albumSearch": {"type": "boolean", "description": "支持专辑搜索（/album/:source/search/:keyword）"},
                    "playlist": {"type": "boolean", "description": "支持歌单详情（/playlist/:source/:id）"},
                    "playlistSearch": {"type": "boolean", "description": "支持歌单搜索"},
                    "playlistCategories": {"type": "boolean", "description": "支持歌单分类"},
                    "parse": {"type": "boolean", "description": "支持链接解析（/parse/:source）"},
                    "userPlaylist": {"type": "boolean", "description": "支持个人歌单（/user-playlist/:source）"},
                },
                "additionalProperties": True,
            },
        },
        "additionalProperties": True,
    },
    "SourcesResult": {
        "type": "object",
        "properties": {"platforms": {"type": "array", "items": ref("SourceInfo")}},
        "additionalProperties": True,
    },
    "PlaylistSummary": {
        "type": "object",
        "properties": {
            "id": {"type": "string", "description": "歌单/专辑 id"},
            "name": {"type": "string"},
            "cover": {"type": "string"},
            "trackCount": {"type": "integer"},
            "playCount": {"type": "integer"},
            "creator": {"type": "string"},
            "description": {"type": "string"},
            "link": {"type": "string"},
            "source": {"type": "string"},
        },
        "additionalProperties": True,
    },
    "PlaylistSearchResult": {
        "type": "object",
        "properties": {
            "list": {"type": "array", "items": ref("PlaylistSummary")},
            "total": {"type": "integer"},
            "page": {"type": "integer"},
            "limit": {"type": "integer"},
            "source": {"type": "string"},
        },
        "additionalProperties": True,
    },
    "PlaylistDetailResult": {
        "type": "object",
        "properties": {
            "source": {"type": "string"},
            "info": ref("AlbumInfo"),
            "list": {"type": "array", "items": ref("SongItem")},
            "page": {"type": "integer"},
            "limit": {"type": ["integer", "string", "null"]},
            "total": {"type": ["integer", "string", "null"]},
        },
        "additionalProperties": True,
    },
    "PlaylistCategoriesResult": {
        "type": "object",
        "properties": {
            "source": {"type": "string"},
            "list": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "name": {"type": "string"},
                        "group": {"type": "string"},
                        "hot": {"type": "boolean"},
                    },
                    "additionalProperties": True,
                },
            },
        },
        "additionalProperties": True,
    },
    "ParseResult": {
        "type": "object",
        "properties": {
            "source": {"type": "string"},
            "type": {"type": "string", "description": "解析类型：song / album / playlist"},
            "song": ref("SongItem"),
            "playlist": ref("PlaylistSummary"),
            "list": {"type": "array", "items": ref("SongItem"), "description": "album/playlist 解析时的曲目"},
            "total": {"type": "integer"},
        },
        "additionalProperties": True,
    },
    "UserPlaylistResult": {
        "type": "object",
        "properties": {
            "list": {"type": "array", "items": ref("PlaylistSummary")},
            "page": {"type": "integer"},
            "limit": {"type": "integer"},
            "total": {"type": "integer"},
            "source": {"type": "string"},
        },
        "additionalProperties": True,
    },
    "HealthResult": {
        "type": "object",
        "properties": {
            "status": {"type": "string", "example": "ok"},
            "uptime": {"type": "integer", "description": "运行秒数"},
            "platforms": {"type": "integer", "description": "已接入平台数"},
        },
        "additionalProperties": True,
    },
}
