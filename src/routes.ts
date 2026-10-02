// 业务路由 —— Fastify 插件形式
// schema（querystring/params）负责参数校验并生成文档；schema.response 负责文档中的响应结构
// 处理函数返回普通对象 → 由服务器的 preSerialization 钩子包成 { code: 0, data }
// 抛出 ApiError → 由全局 setErrorHandler 转为对应 HTTP 状态码

import { notFound, upstream } from './http/api-error.ts'
import { getMusicInfo } from '../sdk/kg/musicInfo.ts'

const QUALITIES = ['64k', '128k', '320k', 'flac', 'flac24bit']

/** 统一解包 SDK 返回值：{ promise, cancelHttp } 结构或裸 Promise 兼容 */
const unwrap = (result: any): any => (
  result && typeof result.promise !== 'undefined' && typeof result.cancelHttp === 'function'
    ? result.promise
    : result
)

const envelope = (dataRef?: string) => ({
  type: 'object',
  properties: {
    code: { type: 'integer', description: '0 表示成功', example: 0 },
    data: dataRef ? { $ref: `${dataRef}#` } : {},
  },
  required: ['code', 'data'],
})

/** 组装路由的 schema.response：200 信封 + 通用错误码文档 */
const responses = (dataRef: any, { notFoundDoc = true, upstreamDoc = true }: { notFoundDoc?: boolean; upstreamDoc?: boolean } = {}) => ({
  '200': envelope(dataRef),
  '422': { $ref: 'ErrorEnvelope#' },
  ...(notFoundDoc ? { '404': { $ref: 'ErrorEnvelope#' } } : {}),
  ...(upstreamDoc ? { '502': { $ref: 'ErrorEnvelope#' } } : {}),
})

// ---- 常用 JSON Schema 片段 ----

const pSource = (capability) => ({
  type: 'string',
  description: `平台 id（见 /sources）${capability ? `，需支持 ${capability} 能力` : ''}`,
  example: 'kw',
})
const pPage = { type: 'integer', default: 1, minimum: 1, description: '页码' }
const pLimit = { type: 'integer', default: 20, minimum: 1, maximum: 100, description: '每页条数' }
const pQuality = { type: 'string', enum: QUALITIES, default: '128k', description: '音质' }
const pId = { type: 'string', description: '平台歌曲 id', example: '28423286' }

const qs = (properties: any, required: string[] = []) => ({ type: 'object', properties, required })
const params = (properties: any, required?: string[]) => qs(properties, required ?? Object.keys(properties))

const getSource = (musicSdk: any, name: string, capability?: string) => {
  const m = musicSdk[name]
  if (!m || (capability && !m[capability])) throw notFound(`不支持的平台: ${name}`)
  return m
}

/**
 * 注册全部业务路由
 * @param {import('fastify').FastifyInstance} fastify
 */
export const musicRoutes = async(fastify: any) => {
  const musicSdk = fastify.musicSdk

  // ---------- 搜索 ----------

  fastify.get('/search', {
    schema: {
      summary: '搜索歌曲',
      description: 'source 省略时聚合全部平台（排除 xm/me/qt/lr 有声平台）搜索，失败的平台会被跳过。',
      tags: ['搜索'],
      querystring: qs({
        name: { type: 'string', description: '歌名', example: '稻香' },
        singer: { type: 'string', description: '歌手名', example: '周杰伦' },
        source: pSource('search'),
        page: pPage,
        limit: pLimit,
      }, ['name']),
      response: responses('SearchResult', { notFoundDoc: false }),
    },
  }, async(request) => {
    const { name, singer, source, page, limit } = request.query

    const doSearch = (id) => musicSdk[id].musicSearch
      .search(`${name} ${singer || ''}`.trim(), page, limit)
      .then(r => r.list)

    if (source) {
      getSource(musicSdk, source, 'musicSearch')
      try {
        return { source, list: await doSearch(source), page, limit }
      } catch (err: any) {
        throw upstream(err.message)
      }
    }

    const lists = await Promise.all(
      musicSdk.sources
        .filter(s => musicSdk[s.id]?.musicSearch && !(s as any).noAggregate)
        .map(s => doSearch(s.id).catch(() => [])),
    )
    return { source: 'all', list: lists.flat(), page, limit }
  })

  fastify.get('/find', {
    schema: {
      summary: '跨平台精确匹配歌曲',
      description: '按歌手、歌名、专辑、时长综合排序，返回最匹配的歌曲列表。',
      tags: ['搜索'],
      querystring: qs({
        name: { type: 'string', description: '歌名', example: '稻香' },
        singer: { type: 'string', description: '歌手名', example: '周杰伦' },
        albumName: { type: 'string', description: '专辑名', example: '魔杰座' },
        interval: { type: 'string', description: '时长（mm:ss），用于时长校验', example: '03:43' },
        excludeSource: { type: 'string', description: '聚合结果中跳过该平台', example: 'kw' },
      }, ['name']),
      response: responses('FindResult', { notFoundDoc: false }),
    },
  }, async(request) => {
    const { name, singer, albumName, interval, excludeSource } = request.query
    try {
      return {
        list: await musicSdk.findMusic({ name, singer, albumName, interval, source: excludeSource }),
      }
    } catch (err: any) {
      throw upstream(err.message)
    }
  })

  // ---------- 歌曲资源（路径参数风格） ----------

  const urlHandler = async(request) => {
    const { source, id } = request.params
    const { quality, albumId, name, singer, interval } = request.query
    const m = getSource(musicSdk, source, 'getMusicUrl')
    const songInfo = { songmid: id, hash: id, copyrightId: id, albumId: albumId || '', _types: {} }

    // 取流链：外部音源脚本（SOURCE_ENABLED 启用时）→ SDK 官方直连 → 酷我兜底（跨平台匹配）
    const finish = (res: any, via: string) => {
      if (!res?.url) throw new Error('获取播放地址失败')
      // qs 解密流等代理地址返回相对路径，按请求的协议与 host 补全（兼容本机/局域网播放器）
      const url = String(res.url).startsWith('/')
        ? `${request.protocol}://${request.headers.host}${res.url}`
        : res.url
      // type 用实际音质（kw 等通道可能降级）；via 标记兜底链中真正命中的通道
      return { type: res.type || quality, url, ...(via !== source ? { via } : {}) }
    }

    const attempts: Array<{ via: string, run: () => Promise<any> }> = []
    if (fastify.sourceApi?.[source]) {
      attempts.push({ via: 'script', run: () => unwrap(fastify.sourceApi[source].getMusicUrl(songInfo, quality)) })
    }
    attempts.push({ via: source, run: () => unwrap(m.getMusicUrl(songInfo, quality)) })

    const errors: string[] = []
    for (const attempt of attempts) {
      try {
        return finish(await attempt.run(), attempt.via)
      } catch (err: any) {
        errors.push(`${attempt.via}: ${err?.message || err}`)
      }
    }

    // 酷我兜底：匿名可拿真无损的通道，按歌名/歌手/时长匹配同一首歌后取流
    if (source !== 'kw') {
      try {
        let meta: { name?: string, singer?: string, interval?: string } | null = name ? { name, singer, interval } : null
        if (!meta && source === 'kg') {
          // kg 的 id 是 hash，可反查出歌名/歌手/时长
          const info = await getMusicInfo(id)
          if (info?.name) meta = { name: String(info.name), singer: info.singer ? String(info.singer) : undefined, interval: info.interval ? String(info.interval) : undefined }
        }
        if (meta?.name) {
          const [best] = await musicSdk.findMusic({ ...meta, only: 'kw' })
          if (best) {
            const res = await unwrap(musicSdk.kw.getMusicUrl({ songmid: best.songmid, hash: best.songmid, _types: {} }, quality))
            return finish(res, 'kw')
          }
          errors.push('kw 兜底: 未匹配到同名歌曲')
        } else {
          errors.push('kw 兜底: 缺少歌名信息（传 name/singer/interval 查询参数可启用）')
        }
      } catch (err: any) {
        errors.push(`kw 兜底: ${err?.message || err}`)
      }
    }
    throw upstream(`取流失败（${errors.join('；')}）`)
  }

  fastify.get('/url/:source/:id', {
    schema: {
      summary: '获取播放地址',
      description: 'id 为平台歌曲 id：kw/tx/wy 用 songmid，kg 用 hash，qs/xm/me 用声音 id，qt 为 <channelId>:<programId>（见 /album/qt），lr 为 <bookId>:<section>（见 /album/lr）。' +
        '取流按「外部音源脚本（SOURCE_ENABLED 启用时）→ SDK 官方直连 → 酷我兜底」顺序尝试，' +
        '酷我兜底按歌名/歌手/时长匹配同一首歌（匿名可用无损），kg 可由 hash 反查歌曲信息，' +
        '其它平台需要兜底时传 name/singer/interval。响应中的 via 字段标记实际命中通道（仅兜底时出现）。',
      tags: ['歌曲资源'],
      params: params({
        source: pSource('url'),
        id: pId,
      }),
      querystring: qs({
        quality: pQuality,
        albumId: { type: 'string', description: '专辑 id' },
        name: { type: 'string', description: '歌名（酷我兜底匹配用）' },
        singer: { type: 'string', description: '歌手名（酷我兜底匹配用）' },
        interval: { type: 'string', description: '时长 mm:ss（酷我兜底匹配用）', example: '04:17' },
      }),
      response: responses('MusicUrlResult'),
    },
  }, urlHandler)

  // qs 解密流代理：登录态取流返回 /stream/qs/:id 相对地址，本端点完成"签名 track_v2 →
  // 密音频下载 → spade key + AES-CTR 解密 → 回明文流"。raw 豁免 { code, data } 信封包装
  fastify.get('/stream/qs/:id', {
    config: { raw: true },
    schema: {
      summary: '汽水音乐解密流代理',
      description: '登录态取流地址（/url/qs 返回的相对地址）。服务端完成 track_v2 签名请求与 cenc-aes-ctr 本地解密，返回明文音频。',
      tags: ['歌曲资源'],
      params: params({ id: pId }),
    },
  }, async(request, reply) => {
    const { id } = request.params
    try {
      const entry = await fastify.musicSdk.qs.getStreamBuffer(id)
      reply.type(entry.contentType || 'audio/mp4')
      reply.header('Accept-Ranges', 'none')
      reply.header('Content-Length', entry.buffer.length)
      return reply.send(entry.buffer)
    } catch (err: any) {
      throw upstream(err.message)
    }
  })

  const lyricHandler = async(request) => {
    const { source, id } = request.params
    const { name, interval } = request.query
    const m = getSource(musicSdk, source, 'getLyric')
    let result
    try {
      result = unwrap(m.getLyric({ songmid: id, hash: id, copyrightId: id, name: name || '', interval: interval || '' }))
    } catch (err: any) {
      throw upstream(err.message)
    }
    return result.then(res => (res || { lyric: '', tlyric: '' })).catch(err => {
      throw err.status ? err : upstream(err.message)
    })
  }

  fastify.get('/lyric/:source/:id', {
    schema: {
      summary: '获取歌词',
      tags: ['歌曲资源'],
      params: params({ source: pSource('lyric'), id: pId }),
      querystring: qs({
        name: { type: 'string', description: '歌名（部分平台搜索歌词时需要）' },
        interval: { type: 'string', description: '时长（mm:ss），部分平台搜索歌词时需要' },
      }),
      response: responses('LyricInfo'),
    },
  }, lyricHandler)

  const picHandler = async(request) => {
    const { source, id } = request.params
    const { albumId } = request.query
    const m = getSource(musicSdk, source, 'getPic')
    let result
    try {
      result = unwrap(m.getPic({ songmid: id, hash: id, copyrightId: id, albumId: albumId || '' }))
    } catch (err: any) {
      throw upstream(err.message)
    }
    return result.then(url => ({ url })).catch(err => {
      throw err.status ? err : upstream(err.message)
    })
  }

  fastify.get('/pic/:source/:id', {
    schema: {
      summary: '获取封面',
      tags: ['歌曲资源'],
      params: params({ source: pSource('pic'), id: pId }),
      querystring: qs({ albumId: { type: 'string', description: '专辑 id（kg 平台需要）' } }),
      response: responses('PicResult'),
    },
  }, picHandler)

  // ---------- 榜单 ----------

  fastify.get('/boards/:source', {
    schema: {
      summary: '获取榜单列表',
      tags: ['榜单'],
      params: params({ source: pSource('boards') }),
      response: responses('BoardListResult'),
    },
  }, async(request) => {
    const m = getSource(musicSdk, request.params.source, 'leaderboard')
    return m.leaderboard.getBoards().catch(err => { throw upstream(err.message) })
  })

  const boardHandler = (source, id, page) => {
    const m = getSource(musicSdk, source, 'leaderboard')
    // 榜单列表返回的 id 带平台前缀（如 kw__93），详情接口需要裸 bangid（93），这里做归一化
    const boardId = String(id).replace(new RegExp(`^${source}__`), '')
    return m.leaderboard.getList(boardId, page).catch(err => { throw upstream(err.message) })
  }

  fastify.get('/boards/:source/:boardId', {
    schema: {
      summary: '获取榜单详情',
      tags: ['榜单'],
      params: params({
        source: pSource('boards'),
        boardId: { type: 'string', description: '榜单 id，兼容榜单列表返回的带前缀 id（kw__93）与裸 bangid（93）', example: 'kw__93' },
      }),
      querystring: qs({ page: pPage }),
      response: responses('BoardDetailResult'),
    },
  }, async(request) => boardHandler(
    request.params.source, request.params.boardId, request.query.page,
  ))

  // ---------- 歌单 & 热搜 ----------

  fastify.get('/hot-search/:source', {
    schema: {
      summary: '获取热搜词',
      tags: ['歌单'],
      params: params({ source: pSource('hotSearch') }),
      response: responses('HotSearchResult'),
    },
  }, async(request) => {
    const m = getSource(musicSdk, request.params.source, 'hotSearch')
    return m.hotSearch.getList().catch(err => { throw upstream(err.message) })
  })

  const songListHandler = (source, page, sortId, tagId) => {
    const m = getSource(musicSdk, source, 'songList')
    // sortId 各平台词汇不同（kw 'new'、tx 5、wy 'hot'…），省略时用平台自己声明的默认排序
    return m.songList.getList(sortId ?? m.songList.sortList?.[0]?.id, tagId, page).catch(err => { throw upstream(err.message) })
  }

  fastify.get('/song-list/:source', {
    schema: {
      summary: '获取歌单列表',
      tags: ['歌单'],
      params: params({ source: pSource('songList') }),
      querystring: qs({
        page: pPage,
        sortId: { type: ['integer', 'string'], description: '排序 id（平台相关，见 /sources 对应平台文档；省略时用平台默认）' },
        tagId: { type: ['integer', 'string'], description: '标签 id（平台相关，kw 为 `173-digest` 形态字符串；0 为全部）' },
      }),
      response: responses('SongListResult'),
    },
  }, async(request) => {
    const { page, sortId, tagId } = request.query
    return songListHandler(request.params.source, page, sortId, tagId)
  })

  // ---------- 歌手 & 专辑 ----------

  fastify.get('/singer/:source/:id', {
    schema: {
      summary: '获取歌手信息',
      description: '支持 kg/tx/wy（见 /sources 的 singer 能力位）。',
      tags: ['歌手专辑'],
      params: params({ source: pSource('singer'), id: { type: 'string', description: '平台歌手 id' } }),
      response: responses('SingerInfoResult'),
    },
  }, async(request) => {
    const { source, id } = request.params
    return getSource(musicSdk, source, 'singer').singer
      .getInfo(id).catch(err => { throw upstream(err.message) })
  })

  fastify.get('/singer/:source/:id/songs', {
    schema: {
      summary: '获取歌手歌曲列表',
      description: '支持 kg/tx/wy。',
      tags: ['歌手专辑'],
      params: params({ source: pSource('singer'), id: { type: 'string', description: '平台歌手 id' } }),
      querystring: qs({ page: pPage, limit: pLimit }),
      response: responses('SingerSongListResult'),
    },
  }, async(request) => {
    const { source, id } = request.params
    const { page, limit } = request.query
    return getSource(musicSdk, source, 'singer').singer
      .getSongList(id, page, limit).catch(err => { throw upstream(err.message) })
  })

  fastify.get('/singer/:source/:id/albums', {
    schema: {
      summary: '获取歌手专辑列表',
      description: '支持 kg/tx/wy。',
      tags: ['歌手专辑'],
      params: params({ source: pSource('singer'), id: { type: 'string', description: '平台歌手 id' } }),
      querystring: qs({ page: pPage, limit: pLimit }),
      response: responses('SingerAlbumListResult'),
    },
  }, async(request) => {
    const { source, id } = request.params
    const { page, limit } = request.query
    return getSource(musicSdk, source, 'singer').singer
      .getAlbumList(id, page, limit).catch(err => { throw upstream(err.message) })
  })

  fastify.get('/album/:source/:id', {
    schema: {
      summary: '获取专辑详情与曲目列表',
      description: '支持 kg/kw/tx/xm/me（见 /sources 的 album 能力位）。kw 单页固定 1000 条、xm/me 固定 30 条、limit 不生效。',
      tags: ['歌手专辑'],
      params: params({ source: pSource('album'), id: { type: 'string', description: '平台专辑 id（搜索结果中的 albumId）' } }),
      querystring: qs({ page: pPage, limit: pLimit }),
      response: responses('AlbumDetailResult'),
    },
  }, async(request) => {
    const { source, id } = request.params
    const { page, limit } = request.query
    const album = getSource(musicSdk, source, 'album').album
    // 各平台适配器签名不同：kg 为 getAlbumDetail(id, page, limit)，
    // kw 为 getAlbumListDetail(id, page)——第三参数是 retryNum，不能透传 limit
    if (album.getAlbumDetail) return album.getAlbumDetail(id, page, limit).catch(err => { throw upstream(err.message) })
    return album.getAlbumListDetail(id, page).catch(err => { throw upstream(err.message) })
  })

  // ---------- 系统 ----------

  fastify.get('/health', {
    schema: {
      summary: '健康检查',
      tags: ['系统'],
      response: responses('HealthResult', { notFoundDoc: false, upstreamDoc: false }),
    },
  }, async() => ({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    platforms: musicSdk.sources.length,
  }))

  fastify.get('/sources', {
    schema: {
      summary: '获取支持的平台',
      description: '返回各平台的音质支持与能力（search/url/lyric/pic/boards/hotSearch/songList）。' +
        '音质为 SDK 官方直连接口的支持范围；启用外部音源（SOURCE_ENABLED）时取流由 sources/ 脚本提供，实际可用音质以脚本为准。',
      tags: ['系统'],
      response: responses('SourcesResult', { notFoundDoc: false, upstreamDoc: false }),
    },
  }, async() => ({
    platforms: musicSdk.sources.map(({ id, name }) => {
      const m = musicSdk[id] || {}
      const qualities = musicSdk.supportQuality?.[id] ?? []
      return {
        id,
        name,
        qualities,
        capabilities: {
          search: Boolean(m.musicSearch),
          url: Boolean(m.getMusicUrl),
          lyric: Boolean(m.getLyric),
          pic: Boolean(m.getPic),
          boards: Boolean(m.leaderboard),
          hotSearch: Boolean(m.hotSearch),
          songList: Boolean(m.songList),
          singer: Boolean(m.singer),
          album: Boolean(m.album),
        },
      }
    }),
  }))
}
