// 业务路由 —— Fastify 插件形式
// schema（querystring/params）负责参数校验并生成文档；schema.response 负责文档中的响应结构
// 处理函数返回普通对象 → 由服务器的 preSerialization 钩子包成 { code: 0, data }
// 抛出 ApiError → 由全局 setErrorHandler 转为对应 HTTP 状态码

import { notFound, upstream } from './http/api-error.js'

const QUALITIES = ['128k', '320k', 'flac', 'flac24bit']

/** 统一解包 SDK 返回值：{ promise, cancelHttp } 结构或裸 Promise 兼容 */
const unwrap = (result) => (
  result && typeof result.promise !== 'undefined' && typeof result.cancelHttp === 'function'
    ? result.promise
    : result
)

const envelope = (dataRef) => ({
  type: 'object',
  properties: {
    code: { type: 'integer', description: '0 表示成功', example: 0 },
    data: dataRef ? { $ref: `${dataRef}#` } : {},
  },
  required: ['code', 'data'],
})

/** 组装路由的 schema.response：200 信封 + 通用错误码文档 */
const responses = (dataRef, { notFoundDoc = true, upstreamDoc = true } = {}) => ({
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

const qs = (properties, required = []) => ({ type: 'object', properties, required })
const params = (properties, required) => qs(properties, required ?? Object.keys(properties))

const getSource = (musicSdk, name, capability) => {
  const m = musicSdk[name]
  if (!m || (capability && !m[capability])) throw notFound(`不支持的平台: ${name}`)
  return m
}

/**
 * 注册全部业务路由
 * @param {import('fastify').FastifyInstance} fastify
 */
export const musicRoutes = async(fastify) => {
  const musicSdk = fastify.musicSdk

  // ---------- 搜索 ----------

  fastify.get('/search', {
    schema: {
      summary: '搜索歌曲',
      description: 'source 省略时聚合全部平台（排除 xm）搜索，失败的平台会被跳过。',
      tags: ['搜索'],
      querystring: qs({
        name: { type: 'string', description: '歌名（可附带歌手，空格分隔）', example: '稻香 周杰伦' },
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
      } catch (err) {
        throw upstream(err.message)
      }
    }

    const lists = await Promise.all(
      musicSdk.sources
        .filter(s => musicSdk[s.id]?.musicSearch)
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
    } catch (err) {
      throw upstream(err.message)
    }
  })

  // ---------- 歌曲资源（路径参数风格） ----------

  const urlHandler = async(request) => {
    const { source, id } = request.params
    const { quality, albumId } = request.query
    const m = getSource(musicSdk, source, 'getMusicUrl')
    const songInfo = { songmid: id, hash: id, copyrightId: id, albumId: albumId || '', _types: {} }
    let result
    try {
      result = unwrap(m.getMusicUrl(songInfo, quality))
    } catch (err) {
      throw upstream(err.message)
    }
    return result.then(res => {
      if (!res?.url) throw upstream('获取播放地址失败')
      return { type: quality, url: res.url }
    }).catch(err => {
      throw err.status ? err : upstream(err.message)
    })
  }

  fastify.get('/url/:source/:id', {
    schema: {
      summary: '获取播放地址',
      description: 'id 为平台歌曲 id：kw/tx/wy/mg 用 songmid，kg 用 hash。',
      tags: ['歌曲资源'],
      params: params({
        source: pSource('url'),
        id: pId,
      }),
      querystring: qs({ quality: pQuality, albumId: { type: 'string', description: '专辑 id' } }),
      response: responses('MusicUrlResult'),
    },
  }, urlHandler)

  const lyricHandler = async(request) => {
    const { source, id } = request.params
    const { name, interval } = request.query
    const m = getSource(musicSdk, source, 'getLyric')
    let result
    try {
      result = unwrap(m.getLyric({ songmid: id, hash: id, copyrightId: id, name: name || '', interval: interval || '' }))
    } catch (err) {
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
    } catch (err) {
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
      description: '返回各平台的音质支持与能力（search/url/lyric/pic/boards/hotSearch/songList）。',
      tags: ['系统'],
      response: responses('SourcesResult', { notFoundDoc: false, upstreamDoc: false }),
    },
  }, async() => ({
    platforms: musicSdk.sources.map(({ id, name }) => {
      const m = musicSdk[id] || {}
      const qualities = [...new Set(
        Object.values(musicSdk.supportQuality || {})
          .map(q => q[id])
          .filter(Boolean)
          .flat(),
      )]
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
        },
      }
    }),
  }))
}
