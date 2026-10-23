"""业务路由 —— 搜索、取流、歌词、封面、榜单、歌单、歌手专辑、链接解析。

处理函数返回 `ok(data)`，由 main.Envelope 统一包成 { code: 0, data }；
抛出 ApiError 由全局异常处理器转成对应 HTTP 状态码。
"""

from __future__ import annotations

from typing import Any

from app.http.api_error import not_found, upstream
from app.http.envelope import ok
from app.http.mg_stream import (
    Z3DStreamDecoder,
    migu_stream_content_type,
    register_migu_stream,
    stream_decrypted,
    take_migu_stream,
)
from app.http.stream_sign import sign_stream
from app.sdk import SOURCE_MODULES, SUPPORTED_SOURCES, find_music
from app.sdk.types import cap as get_cap
from fastapi import APIRouter, Body, Path, Query, Request
from fastapi.responses import StreamingResponse

router = APIRouter()

QUALITIES = ["64k", "128k", "320k", "flac", "flac24bit"]

# ---- 常用 OpenAPI 响应片段 ----
ENVELOPE_SCHEMA = {
    "type": "object",
    "properties": {
        "code": {"type": "integer", "description": "0 表示成功", "example": 0},
        "data": {"description": "业务数据"},
    },
    "required": ["code", "data"],
}


def envelope_ref(name: str) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "code": {"type": "integer", "description": "0 表示成功", "example": 0},
            "data": {"$ref": f"#/components/schemas/{name}"},
        },
        "required": ["code", "data"],
    }


ERROR_ENVELOPE = {"$ref": "#/components/schemas/ErrorEnvelope"}


def responses_for(
    data_ref: str, *, not_found: bool = True, upstream_doc: bool = True
) -> dict[int | str, dict[str, Any]]:
    docs: dict[int | str, dict[str, Any]] = {
        "200": {"description": "成功", "content": {"application/json": {"schema": envelope_ref(data_ref)}}},
        "422": {"description": "参数校验失败", "content": {"application/json": {"schema": ERROR_ENVELOPE}}},
    }
    if not_found:
        docs["404"] = {"description": "接口或平台不存在", "content": {"application/json": {"schema": ERROR_ENVELOPE}}}
    if upstream_doc:
        docs["502"] = {"description": "上游平台失败", "content": {"application/json": {"schema": ERROR_ENVELOPE}}}
    return docs


def get_source(source: str, capability: str | None = None) -> Any:
    """取平台模块（按能力位校验），不存在或无该能力 → 404。"""
    module = SOURCE_MODULES.get(source)
    if module is None or get_cap(module, capability) is None:
        raise not_found(f"不支持的平台: {source}")
    return module


def platform_path(source: str, capability: str | None = None, description: str = "平台 id（见 /sources）") -> Any:
    return Path(..., description=f"{description}{f'，需支持 {capability} 能力' if capability else ''}", example="kw")


# ---------- 搜索 ----------


async def _search_handler(source: str, keyword: str, page: int, singer: str | None, limit: int) -> Any:
    word = f"{keyword} {singer or ''}".strip()
    if source != "all":
        get_source(source, "music_search")
        result = await search_platform(source, word, page, limit)
        return {"source": source, "list": result, "page": page, "limit": limit}

    # 聚合：排除有声平台，失败的平台跳过
    import asyncio

    targets = [
        item["id"]
        for item in SUPPORTED_SOURCES
        if getattr(item["module"], "music_search", None) is not None and not item.get("no_aggregate")
    ]

    async def one(platform: str):
        try:
            return await search_platform(platform, word, page, limit)
        except Exception:  # noqa: BLE001
            return []

    lists = await asyncio.gather(*(one(platform) for platform in targets))
    return {"source": "all", "list": [song for chunk in lists for song in chunk], "page": page, "limit": limit}


async def search_platform(platform: str, word: str, page: int, limit: int) -> list[dict[str, Any]]:
    try:
        result = await SOURCE_MODULES[platform].music_search.search(word, page, limit)
    except Exception as err:
        raise upstream(str(err)) from err
    return result.get("list") or []


@router.get(
    "/search/{source}/{keyword}",
    summary="搜索歌曲（第 1 页）",
    description="source 为平台 id 或 all（聚合，排除 xm/me/qt/lr 有声平台，失败的平台跳过）。"
    "path 直接跟搜索内容，第 1 页可省略页码段；歌名含空格/斜杠时请拆分——歌手走 singer 查询参数。",
    tags=["搜索"],
    responses=responses_for("SearchResult", not_found=False),
)
async def search_first(
    source: str = platform_path("kw", "search"),
    keyword: str = Path(..., description="搜索关键词（URL 编码的中文可直接使用）", example="稻香"),
    singer: str | None = Query(None, description="歌手名（与关键词拼接搜索）", example="周杰伦"),
    limit: int = Query(20, ge=1, le=100, description="每页条数"),
) -> Any:
    return ok(await _search_handler(source, keyword, 1, singer, limit))


@router.get(
    "/search/{source}/{keyword}/{page}",
    summary="搜索歌曲（指定页）",
    description="同 /search/:source/:keyword，页码作为 path 段。",
    tags=["搜索"],
    responses=responses_for("SearchResult", not_found=False),
)
async def search_page(
    source: str = platform_path("kw", "search"),
    keyword: str = Path(..., description="搜索关键词", example="稻香"),
    page: int = Path(..., ge=1, description="页码"),
    singer: str | None = Query(None, description="歌手名"),
    limit: int = Query(20, ge=1, le=100, description="每页条数"),
) -> Any:
    return ok(await _search_handler(source, keyword, page, singer, limit))


@router.get(
    "/find/{source}/{keyword}",
    summary="精确匹配歌曲",
    description="按歌手、歌名、专辑、时长综合排序的精确匹配。source 为平台 id（只在单平台内匹配）或 all"
    "（跨平台聚合，可用 excludeSource 跳过某平台；聚合自动排除 xm/me/qt/lr 有声平台）。",
    tags=["搜索"],
    responses=responses_for("FindResult", not_found=False),
)
async def find(
    source: str = Path(..., description="平台 id 或 all", example="all"),
    keyword: str = Path(..., description="歌名", example="稻香"),
    singer: str | None = Query(None, description="歌手名", example="周杰伦"),
    albumName: str | None = Query(None, description="专辑名", example="魔杰座"),
    interval: str | None = Query(None, description="时长（mm:ss），用于时长校验", example="03:43"),
    excludeSource: str | None = Query(None, description="source=all 时跳过该平台", example="kw"),
) -> Any:
    kwargs: dict[str, Any] = {
        "name": keyword,
        "singer": singer,
        "album_name": albumName,
        "interval": interval,
    }
    if source != "all":
        kwargs["only"] = source
    elif excludeSource:
        kwargs["source"] = excludeSource
    try:
        return ok({"list": await find_music(**kwargs)})
    except Exception as err:
        raise upstream(str(err)) from err


# ---------- 歌曲资源 ----------


@router.get(
    "/url/{source}/{id}",
    summary="获取播放地址",
    description="id 为平台歌曲 id：kw/tx/wy 用 songmid，kg 用 hash，xm/me 用声音 id，qt 为 <channelId>:<programId>"
    "（见 /album/qt），lr 为 <bookId>:<section>（见 /album/lr）。"
    "取流按「SDK 官方直连 → 酷我兜底」顺序尝试，酷我兜底按歌名/歌手/时长匹配同一首歌（匿名可用无损），"
    "kg 可由 hash 反查歌曲信息，其它平台需要兜底时传 name/singer/interval。"
    "响应中的 via 字段标记实际命中通道（仅兜底时出现）。",
    tags=["歌曲资源"],
    responses=responses_for("MusicUrlResult"),
)
async def music_url(
    request: Request,
    source: str = platform_path("kw", "url"),
    id: str = Path(..., description="平台歌曲 id", example="28423286"),
    quality: str = Query("128k", description="音质"),
    albumId: str | None = Query(None, description="专辑 id"),
    name: str | None = Query(None, description="歌名（酷我兜底匹配用）"),
    singer: str | None = Query(None, description="歌手名（酷我兜底匹配用）"),
    interval: str | None = Query(None, description="时长 mm:ss（酷我兜底匹配用）", example="04:17"),
) -> Any:
    if quality not in QUALITIES:
        from app.http.api_error import ApiError

        raise ApiError(422, f"quality: 不支持的音质 {quality}（可选：{', '.join(QUALITIES)}）")

    module = get_source(source, "get_music_url")
    song_info = {"songmid": id, "hash": id, "copyrightId": id, "albumId": albumId or "", "_types": {}}

    def finish(result: dict[str, Any], via: str) -> dict[str, Any]:
        if not result or not result.get("url"):
            raise RuntimeError("获取播放地址失败")
        raw_url = str(result["url"])
        if result.get("encrypted") and result.get("fileKey"):
            raw_url = f"/stream/mg/{register_migu_stream(raw_url, str(result['fileKey']))}"
        # 相对地址按请求的协议与 host 补全（兼容本机/局域网播放器）
        if raw_url.startswith("/"):
            suffix = ""
            auth_key = getattr(request.app.state, "auth_key", "")
            if auth_key:
                path = raw_url.split("?")[0]
                suffix = f"{'&' if '?' in raw_url else '?'}{sign_stream(auth_key, path)}"
            raw_url = f"{request.url.scheme}://{request.headers.get('host', '')}{raw_url}{suffix}"
        payload: dict[str, Any] = {"type": result.get("type") or quality, "url": raw_url}
        if via != source:
            payload["via"] = via
        return payload

    errors: list[str] = []
    try:
        return ok(finish(await module.get_music_url(song_info, quality), source))
    except Exception as err:  # noqa: BLE001
        errors.append(f"{source}: {err}")

    # 酷我兜底：匿名可拿真无损的通道，按歌名/歌手/时长匹配同一首歌后取流
    if source != "kw":
        try:
            meta: dict[str, Any] | None = {"name": name, "singer": singer, "interval": interval} if name else None
            if not meta and source == "kg":
                # kg 可用 hash 反查歌曲信息，无需调用方额外传参
                kg_module = SOURCE_MODULES.get("kg")
                lookup = getattr(kg_module, "get_music_info", None)
                info = await lookup({"hash": id, "songmid": id}) if lookup else None
                if info and info.get("name"):
                    meta = {
                        "name": str(info["name"]),
                        "singer": str(info["singer"]) if info.get("singer") else None,
                        "interval": str(info["interval"]) if info.get("interval") else None,
                    }
            if meta and meta.get("name"):
                best_list = await find_music(
                    name=str(meta["name"]),
                    singer=meta.get("singer"),
                    interval=meta.get("interval"),
                    only="kw",
                )
                best = best_list[0] if best_list else None
                if best:
                    kw_module = SOURCE_MODULES["kw"]
                    res = await kw_module.get_music_url(
                        {"songmid": best["songmid"], "hash": best["songmid"], "_types": {}}, quality
                    )
                    return ok(finish(res, "kw"))
                errors.append("kw 兜底: 未匹配到同名歌曲")
            else:
                errors.append("kw 兜底: 缺少歌名信息（传 name/singer/interval 查询参数可启用）")
        except Exception as err:  # noqa: BLE001
            errors.append(f"kw 兜底: {err}")

    raise upstream(f"取流失败（{'；'.join(errors)}）")


@router.get(
    "/stream/{source}/{id}",
    summary="加密流解密代理（mg）",
    description="取流响应中返回的相对地址（/url/mg 命中加密流时的地址），服务端下载上游密流并在本地解密后返回明文音频；"
    "不接受客户端自行构造。id 为取流响应 url 中的票据段（票据 10 分钟内有效，过期请重新 /url/mg 取流）。",
    tags=["歌曲资源"],
    response_class=StreamingResponse,
)
async def stream(source: str, id: str) -> Any:
    if source != "mg":
        raise not_found(f"不支持的加密流平台: {source}")
    ticket = take_migu_stream(str(id))
    if not ticket:
        raise not_found("解密票据不存在或已过期（请重新调用 /url/mg 取流）")
    return _stream_response(ticket.url, Z3DStreamDecoder(ticket.file_key))


def _stream_response(url: str, decoder: Z3DStreamDecoder) -> StreamingResponse:
    """异步队列桥接：下载协程生产解密块，StreamingResponse 消费块。

    解密按块增量进行（跨块保持全局偏移），整段音频可达上百 MB，不能读进内存。
    """
    import asyncio

    queue: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=32)

    async def produce() -> None:
        try:
            await stream_decrypted(url, decoder.feed, queue.put_nowait)
        except Exception as err:  # noqa: BLE001 - 响应头已发出，只能中断连接`r`n            # 日志留痕，只能中断连接；把错误留在服务端日志
            print(f"[stream] 上游读取中断: {err!r}")
        finally:
            queue.put_nowait(None)

    async def body():
        task = asyncio.create_task(produce())
        try:
            while True:
                chunk = await queue.get()
                if chunk is None:
                    break
                yield chunk
        finally:
            task.cancel()

    return StreamingResponse(
        body(),
        media_type=migu_stream_content_type(url),
        headers={"Accept-Ranges": "none"},
    )


@router.get(
    "/lyric/{source}/{id}",
    summary="获取歌词",
    tags=["歌曲资源"],
    responses=responses_for("LyricInfo"),
)
async def lyric(
    source: str = platform_path("kw", "lyric"),
    id: str = Path(..., description="平台歌曲 id"),
    name: str | None = Query(None, description="歌名（部分平台搜索歌词时需要）"),
    interval: str | None = Query(None, description="时长（mm:ss），部分平台搜索歌词时需要"),
) -> Any:
    module = get_source(source, "get_lyric")
    try:
        result = await module.get_lyric(
            {"songmid": id, "hash": id, "copyrightId": id, "name": name or "", "interval": interval or ""}
        )
    except Exception as err:
        raise upstream(str(err)) from err
    return ok(result or {"lyric": "", "tlyric": ""})


@router.get(
    "/pic/{source}/{id}",
    summary="获取封面",
    tags=["歌曲资源"],
    responses=responses_for("PicResult"),
)
async def pic(
    source: str = platform_path("kw", "pic"),
    id: str = Path(..., description="平台歌曲 id"),
    albumId: str | None = Query(None, description="专辑 id（kg 平台需要）"),
) -> Any:
    module = get_source(source, "get_pic")
    try:
        url = await module.get_pic({"songmid": id, "hash": id, "copyrightId": id, "albumId": albumId or ""})
    except Exception as err:
        raise upstream(str(err)) from err
    return ok({"url": url})


# ---------- 榜单 ----------


@router.get(
    "/boards/{source}",
    summary="获取榜单列表",
    tags=["榜单"],
    responses=responses_for("BoardListResult"),
)
async def boards(source: str = platform_path("kw", "boards")) -> Any:
    module = get_source(source, "leaderboard")
    try:
        return ok(await module.leaderboard.get_boards())
    except Exception as err:
        raise upstream(str(err)) from err


async def _board_handler(source: str, board_id: str, page: int) -> Any:
    module = get_source(source, "leaderboard")
    # 榜单列表返回的 id 带平台前缀（如 kw__93），详情接口需要裸 bangid（93），这里做归一化
    bare = board_id[len(f"{source}__") :] if board_id.startswith(f"{source}__") else board_id
    try:
        return ok(await module.leaderboard.get_list(bare, page))
    except Exception as err:
        raise upstream(str(err)) from err


@router.get(
    "/boards/{source}/{boardId}",
    summary="获取榜单详情",
    tags=["榜单"],
    responses=responses_for("BoardDetailResult"),
)
async def board_first(
    source: str = platform_path("kw", "boards"),
    boardId: str = Path(
        ..., description="榜单 id，兼容榜单列表返回的带前缀 id（kw__93）与裸 bangid（93）", example="kw__93"
    ),
) -> Any:
    return await _board_handler(source, boardId, 1)


@router.get(
    "/boards/{source}/{boardId}/{page}",
    summary="获取榜单详情（指定页）",
    tags=["榜单"],
    responses=responses_for("BoardDetailResult"),
)
async def board_page(
    source: str = platform_path("kw", "boards"),
    boardId: str = Path(..., description="榜单 id"),
    page: int = Path(..., ge=1, description="页码"),
) -> Any:
    return await _board_handler(source, boardId, page)


# ---------- 热搜 & 歌单列表 ----------


@router.get(
    "/hot-search/{source}",
    summary="获取热搜词",
    tags=["歌单"],
    responses=responses_for("HotSearchResult"),
)
async def hot_search(source: str = platform_path("kw", "hot_search")) -> Any:
    module = get_source(source, "hot_search")
    try:
        return ok(await module.hot_search.get_list())
    except Exception as err:
        raise upstream(str(err)) from err


async def _song_list_handler(source: str, page: int, sort_id: Any, tag_id: Any) -> Any:
    module = get_source(source, "song_list")
    sort_default = module.song_list.sort_list[0]["id"] if getattr(module.song_list, "sort_list", None) else None
    try:
        return ok(await module.song_list.get_list(sort_id if sort_id is not None else sort_default, tag_id, page))
    except Exception as err:
        raise upstream(str(err)) from err


@router.get(
    "/song-list/{source}",
    summary="获取歌单列表",
    tags=["歌单"],
    responses=responses_for("SongListResult"),
)
async def song_list_first(
    source: str = platform_path("kw", "song_list"),
    sortId: str | None = Query(None, description="排序 id（平台相关；省略时用平台默认）"),
    tagId: str | None = Query(None, description="标签 id（平台相关，kw 为 `173-digest` 形态字符串；0 为全部）"),
) -> Any:
    return await _song_list_handler(source, 1, sortId, tagId)


@router.get(
    "/song-list/{source}/{page}",
    summary="获取歌单列表（指定页）",
    tags=["歌单"],
    responses=responses_for("SongListResult"),
)
async def song_list_page(
    source: str = platform_path("kw", "song_list"),
    page: int = Path(..., ge=1, description="页码"),
    sortId: str | None = Query(None, description="排序 id"),
    tagId: str | None = Query(None, description="标签 id"),
) -> Any:
    return await _song_list_handler(source, page, sortId, tagId)


# ---------- 歌手 & 专辑 ----------


@router.get(
    "/singer/{source}/{id}",
    summary="获取歌手信息",
    description="支持 kg/tx/wy（见 /sources 的 singer 能力位）。",
    tags=["歌手专辑"],
    responses=responses_for("SingerInfoResult"),
)
async def singer_info(
    source: str = platform_path("kg", "singer"),
    id: str = Path(..., description="平台歌手 id"),
) -> Any:
    module = get_source(source, "singer")
    try:
        return ok(await module.singer.get_info(id))
    except Exception as err:
        raise upstream(str(err)) from err


@router.get(
    "/singer/{source}/{id}/songs",
    summary="获取歌手歌曲列表",
    description="支持 kg/tx/wy。",
    tags=["歌手专辑"],
    responses=responses_for("SingerSongListResult"),
)
async def singer_songs_first(
    source: str = platform_path("kg", "singer"),
    id: str = Path(..., description="平台歌手 id"),
    limit: int = Query(20, ge=1, le=100, description="每页条数"),
) -> Any:
    return await _singer_songs(source, id, 1, limit)


@router.get(
    "/singer/{source}/{id}/songs/{page}",
    summary="获取歌手歌曲列表（指定页）",
    description="支持 kg/tx/wy。",
    tags=["歌手专辑"],
    responses=responses_for("SingerSongListResult"),
)
async def singer_songs_page(
    source: str = platform_path("kg", "singer"),
    id: str = Path(..., description="平台歌手 id"),
    page: int = Path(..., ge=1, description="页码"),
    limit: int = Query(20, ge=1, le=100, description="每页条数"),
) -> Any:
    return await _singer_songs(source, id, page, limit)


async def _singer_songs(source: str, singer_id: str, page: int, limit: int) -> Any:
    module = get_source(source, "singer")
    try:
        return ok(await module.singer.get_song_list(singer_id, page, limit))
    except Exception as err:
        raise upstream(str(err)) from err


@router.get(
    "/singer/{source}/{id}/albums",
    summary="获取歌手专辑列表",
    description="支持 kg/tx/wy。",
    tags=["歌手专辑"],
    responses=responses_for("SingerAlbumListResult"),
)
async def singer_albums_first(
    source: str = platform_path("kg", "singer"),
    id: str = Path(..., description="平台歌手 id"),
    limit: int = Query(20, ge=1, le=100, description="每页条数"),
) -> Any:
    return await _singer_albums(source, id, 1, limit)


@router.get(
    "/singer/{source}/{id}/albums/{page}",
    summary="获取歌手专辑列表（指定页）",
    description="支持 kg/tx/wy。",
    tags=["歌手专辑"],
    responses=responses_for("SingerAlbumListResult"),
)
async def singer_albums_page(
    source: str = platform_path("kg", "singer"),
    id: str = Path(..., description="平台歌手 id"),
    page: int = Path(..., ge=1, description="页码"),
    limit: int = Query(20, ge=1, le=100, description="每页条数"),
) -> Any:
    return await _singer_albums(source, id, page, limit)


async def _singer_albums(source: str, singer_id: str, page: int, limit: int) -> Any:
    module = get_source(source, "singer")
    try:
        return ok(await module.singer.get_album_list(singer_id, page, limit))
    except Exception as err:
        raise upstream(str(err)) from err


async def _album_detail(source: str, album_id: str, page: int, limit: int) -> Any:
    module = get_source(source, "album")
    album = module.album
    # 各平台适配器签名不同：kg 为 get_album_detail(id, page, limit)，
    # kw 为 get_album_list_detail(id, page)——第三参数是 retryNum，不能透传 limit
    try:
        if hasattr(album, "get_album_detail"):
            return ok(await album.get_album_detail(album_id, page, limit))
        return ok(await album.get_album_list_detail(album_id, page))
    except Exception as err:
        raise upstream(str(err)) from err


@router.get(
    "/album/{source}/{id}",
    summary="获取专辑详情与曲目列表",
    description="支持 kg/kw/tx/wy/xm/me/qt/lr/mg/bd/joox/apple（见 /sources 的 album 能力位）。"
    "kw 单页固定 1000 条、xm/me 固定 30 条、limit 不生效。",
    tags=["歌手专辑"],
    responses=responses_for("AlbumDetailResult"),
)
async def album_first(
    source: str = platform_path("kg", "album"),
    id: str = Path(..., description="平台专辑 id（搜索结果中的 albumId）", example="123456"),
    limit: int = Query(20, ge=1, le=100, description="每页条数"),
) -> Any:
    return await _album_detail(source, id, 1, limit)


@router.get(
    "/album/{source}/{id}/{page}",
    summary="获取专辑详情与曲目列表（指定页）",
    tags=["歌手专辑"],
    responses=responses_for("AlbumDetailResult"),
)
async def album_page(
    source: str = platform_path("kg", "album"),
    id: str = Path(..., description="平台专辑 id"),
    page: int = Path(..., ge=1, description="页码"),
    limit: int = Query(20, ge=1, le=100, description="每页条数"),
) -> Any:
    return await _album_detail(source, id, page, limit)


@router.get(
    "/album/{source}/search/{keyword}",
    summary="搜索专辑",
    description="支持 kg/kw/tx/wy/mg/bd/joox/apple（见 /sources 的 albumSearch 能力位）。",
    tags=["歌手专辑"],
    responses=responses_for("AlbumDetailResult", not_found=False),
)
async def album_search(
    source: str = platform_path("kg", "album.search_album"),
    keyword: str = Path(..., description="专辑名关键词", example="魔杰座"),
    page: int = Query(1, ge=1, description="页码"),
    limit: int = Query(20, ge=1, le=100, description="每页条数"),
) -> Any:
    module = get_source(source, "album.search_album")
    try:
        res = await module.album.search_album(keyword, page, limit)
    except Exception as err:
        raise upstream(str(err)) from err
    if isinstance(res, list):
        return ok({"source": source, "list": res, "page": page, "limit": limit, "total": len(res)})
    return ok({"source": source, **res})


# ---------- 歌单 ----------


@router.get(
    "/playlist/{source}/search/{keyword}",
    summary="搜索歌单",
    description="支持 kg/kw/tx/wy/mg/bd/joox/bili/5sing/apple（见 /sources 的 playlistSearch 能力位）。"
    "部分平台该能力受限（如 bd 歌单搜索接口已下线、bili 需登录），失败时返回 502。",
    tags=["歌单"],
    responses=responses_for("PlaylistSearchResult"),
)
async def playlist_search(
    source: str = platform_path("kw", "playlist.search_playlist"),
    keyword: str = Path(..., description="歌单关键词", example="华语"),
    page: int = Query(1, ge=1, description="页码"),
    limit: int = Query(20, ge=1, le=100, description="每页条数"),
) -> Any:
    module = get_source(source, "playlist.search_playlist")
    try:
        res = await module.playlist.search_playlist(keyword, page, limit)
    except Exception as err:
        raise upstream(str(err)) from err
    if isinstance(res, list):
        return ok({"source": source, "list": res, "page": page, "limit": limit, "total": len(res)})
    return ok({"source": source, **res})


@router.get(
    "/playlist/{source}/categories",
    summary="获取歌单分类",
    description="支持 kw/kg/tx/wy/mg/bd/joox/bili/5sing/apple（见 /sources 的 playlistCategories 能力位）。",
    tags=["歌单"],
    responses=responses_for("PlaylistCategoriesResult"),
)
async def playlist_categories(source: str = platform_path("kw", "playlist.get_categories")) -> Any:
    module = get_source(source, "playlist.get_categories")
    try:
        res = await module.playlist.get_categories()
    except Exception as err:
        raise upstream(str(err)) from err
    # 歌单分类返回形状不一（{list}/裸数组），统一为 { source, list }
    items = res if isinstance(res, list) else (res or {}).get("list") or []
    return ok({"source": source, "list": items})


async def _category_playlists(source: str, category_id: str, page: int, limit: int) -> Any:
    module = get_source(source, "playlist")
    if not hasattr(module.playlist, "get_category_playlists"):
        raise not_found(f"平台 {source} 不支持分类歌单")
    try:
        res = await module.playlist.get_category_playlists(category_id, page, limit)
    except Exception as err:
        raise upstream(str(err)) from err
    if isinstance(res, list):
        return ok({"source": source, "list": res, "page": page, "limit": limit, "total": len(res)})
    return ok({"source": source, **res})


@router.get(
    "/playlist/{source}/categories/{categoryId}",
    summary="获取分类下的歌单",
    description="categoryId 为 /playlist/:source/categories 返回的分类 id（部分平台 id 即分类名）。",
    tags=["歌单"],
    responses=responses_for("PlaylistSearchResult"),
)
async def playlist_category_items(
    source: str = platform_path("kw", "playlist.get_categories"),
    categoryId: str = Path(..., description="分类 id（分类列表返回）", example="华语"),
    page: int = Query(1, ge=1, description="页码"),
    limit: int = Query(20, ge=1, le=100, description="每页条数"),
) -> Any:
    return await _category_playlists(source, categoryId, page, limit)


async def _playlist_detail(source: str, playlist_id: str, page: int, limit: int) -> Any:
    module = get_source(source, "playlist")
    try:
        return ok(await module.playlist.get_playlist_detail(playlist_id, page, limit))
    except Exception as err:  # noqa: BLE001
        # 部分平台详情签名只有 id：退化为取全量后本地切片
        try:
            songs = await module.playlist.get_playlist_songs(playlist_id)
            if not isinstance(songs, list):
                raise err
            start = (page - 1) * limit
            return ok(
                {
                    "source": source,
                    "info": {"name": playlist_id, "img": "", "desc": "", "author": ""},
                    "list": songs[start : start + limit],
                    "page": page,
                    "limit": limit,
                    "total": len(songs),
                }
            )
        except Exception:  # noqa: BLE001
            raise upstream(str(err)) from err


@router.get(
    "/playlist/{source}/{id}",
    summary="获取歌单详情与曲目列表",
    description="id 为歌单 id 或链接（部分平台支持链接/裸 id，如 bili 的 season:<id>:<mid>:<bvid>、"
    "joox/bd/mg 的网页链接）。列表按 page/limit 切片（聚合接口自身分页的平台由平台决定）。",
    tags=["歌单"],
    responses=responses_for("PlaylistDetailResult"),
)
async def playlist_first(
    source: str = platform_path("kw", "playlist"),
    id: str = Path(..., description="歌单 id（或平台歌单链接）", example="123456789"),
    limit: int = Query(20, ge=1, le=100, description="每页条数"),
) -> Any:
    return await _playlist_detail(source, id, 1, limit)


@router.get(
    "/playlist/{source}/{id}/{page}",
    summary="获取歌单详情与曲目列表（指定页）",
    tags=["歌单"],
    responses=responses_for("PlaylistDetailResult"),
)
async def playlist_page(
    source: str = platform_path("kw", "playlist"),
    id: str = Path(..., description="歌单 id"),
    page: int = Path(..., ge=1, description="页码"),
    limit: int = Query(20, ge=1, le=100, description="每页条数"),
) -> Any:
    return await _playlist_detail(source, id, page, limit)


# ---------- 链接解析 ----------


async def _parse_handler(kind: str, source: str, link: str) -> Any:
    module = get_source(source, "parse")
    impl = getattr(module.parse, f"parse_{kind}", None)
    if impl is None:
        raise not_found(f"平台 {source} 不支持解析该类型链接")
    try:
        out = await impl(link)
    except Exception as err:
        raise upstream(str(err)) from err

    if kind == "song":
        if out and (out.get("list") or out.get("songs")):
            songs = out.get("list") or out.get("songs") or []
            return ok(
                {
                    "source": source,
                    "type": "playlist",
                    "playlist": out.get("info") or out.get("playlist"),
                    "list": songs,
                    "total": len(songs),
                }
            )
        return ok({"source": source, "type": "song", "song": out})

    songs = (out or {}).get("list") or (out or {}).get("songs") or []
    return ok(
        {
            "source": source,
            "type": kind,
            "playlist": (out or {}).get("info") or (out or {}).get("playlist") or out,
            "list": songs,
            "total": len(songs),
        }
    )


_PARSE_KINDS = {"song": "歌曲", "album": "专辑", "playlist": "歌单"}


def _register_parse_routes() -> None:
    for kind, label in _PARSE_KINDS.items():

        async def handler(
            source: str = platform_path("kw", "parse.parse_song"),
            link: str = Body(..., embed=True, description="平台链接或裸 id"),
            _kind: str = kind,
        ) -> Any:
            return await _parse_handler(_kind, source, str(link).strip())

        router.add_api_route(
            f"/parse/{kind}/{{source}}",
            handler,
            methods=["POST"],
            summary=f"解析{label}链接",
            description="把平台链接（或裸 id）解析成结构化歌曲/曲目数据。支持平台见 /sources 的 parse 能力位；"
            "5sing 歌曲/歌单、apple/bili/joox/bd/mg 三类、kw/kg/tx/wy 部分支持。",
            tags=["链接解析"],
            responses=responses_for("ParseResult"),
            name=f"parse_{kind}",
        )


_register_parse_routes()


# ---------- 个人歌单 ----------


@router.get(
    "/user-playlist/{source}",
    summary="获取个人歌单列表",
    description="需先登录（见 /login/*）。当前仅 tx/wy 有完整实现（见 /sources 的 userPlaylist 能力位）；"
    "未登录或平台不支持时返回 404/502。",
    tags=["歌单"],
    responses=responses_for("UserPlaylistResult"),
)
async def user_playlist(
    source: str = platform_path("wy", "user_playlist.get_list"),
    page: int = Query(1, ge=1, description="页码"),
    limit: int = Query(20, ge=1, le=100, description="每页条数"),
) -> Any:
    module = get_source(source, "user_playlist.get_list")
    try:
        result = await module.user_playlist.get_list(page, limit)
    except Exception as err:
        raise upstream(str(err)) from err
    items = result if isinstance(result, list) else (result or {}).get("list") or []
    return ok({"source": source, "list": items, "page": page, "limit": limit})
