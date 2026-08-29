// 路由表 —— 接口定义 + OpenAPI 元数据 + 处理函数
// 处理函数返回普通对象 → 200 { code: 0, data }
// 抛出 ApiError → 对应 HTTP 状态码；抛出其他错误 → 500
// 返回 { __raw: true, status, headers, body } → 原样输出（文档页/重定向用）

import { invalidParam, notFound, upstream } from './http/api-error.js'

const QUALITIES = ['128k', '320k', 'flac', 'flac24bit']

/** 统一解包 SDK 返回值：{ promise, cancelHttp } 结构或裸 Promise 兼容 */
const unwrap = (result) => (
  result && typeof result.promise !== 'undefined' && typeof result.cancelHttp === 'function'
    ? result.promise
    : result
)

const required = (query, names) => {
  const missing = names.filter(n => !query[n])
  if (missing.length) throw invalidParam(`缺少参数: ${missing.join(', ')}`, { missing })
}

const toInt = (value, name, { min = 1, max = Infinity, def }) => {
  const n = parseInt(value ?? def, 10)
  if (Number.isNaN(n) || n < min || n > max) throw invalidParam(`参数 ${name} 需为 ${min}~${max} 的整数`)
  return n
}

const getSource = (musicSdk, name, capability) => {
  const m = musicSdk[name]
  if (!m || (capability && !m[capability])) throw notFound(`不支持的平台: ${name}`)
  return m
}

// 常用查询参数元数据（多接口复用）
const pSource = (capability, description) => ({
  description: description || `平台 id（见 /sources）${capability ? `，需支持 ${capability} 能力` : ''}`,
  example: 'kw',
})
const pPage = { type: 'integer', default: 1, minimum: 1, description: '页码' }
const pLimit = { type: 'integer', default: 20, minimum: 1, maximum: 100, description: '每页条数' }
const pQuality = {
  enum: QUALITIES,
  default: '128k',
  description: '音质',
}

/**
 * 注册全部业务路由
 * @param {import('./http/router.js').Router} router
 * @param {object} musicSdk 聚合 SDK
 */
export const registerRoutes = (router, musicSdk) => {
  // ---------- 搜索 ----------

  router.get('/search', {
    summary: '搜索歌曲',
    description: 'source 省略时聚合全部平台（排除 xm）搜索，失败的平台会被跳过。',
    tags: ['搜索'],
    queryParams: {
      name: { required: true, description: '歌名（可附带歌手，空格分隔）', example: '稻香 周杰伦' },
      singer: { description: '歌手名', example: '周杰伦' },
      source: pSource('search'),
      page: pPage,
      limit: pLimit,
    },
    dataSchema: 'SearchResult',
    possible502: true,
  }, async({ query }) => {
    required(query, ['name'])
    const name = query.name
    const singer = query.singer
    const page = toInt(query.page, 'page', { def: 1 })
    const limit = toInt(query.limit, 'limit', { def: 20, max: 100 })

    const doSearch = (id) => musicSdk[id].musicSearch
      .search(`${name} ${singer || ''}`.trim(), page, limit)
      .then(r => r.list)

    if (query.source) {
      getSource(musicSdk, query.source, 'musicSearch')
      try {
        return { source: query.source, list: await doSearch(query.source), page, limit }
      } catch (err) {
        throw upstream(err.message)
      }
    }

    const lists = await Promise.all(
      musicSdk.sources
        .filter(s => s.id !== 'xm' && musicSdk[s.id]?.musicSearch)
        .map(s => doSearch(s.id).catch(() => [])),
    )
    return { source: 'all', list: lists.flat(), page, limit }
  })

  router.get('/find', {
    summary: '跨平台精确匹配歌曲',
    description: '按歌手、歌名、专辑、时长综合排序，返回最匹配的歌曲列表。',
    tags: ['搜索'],
    queryParams: {
      name: { required: true, description: '歌名', example: '稻香' },
      singer: { description: '歌手名', example: '周杰伦' },
      albumName: { description: '专辑名', example: '魔杰座' },
      interval: { description: '时长（mm:ss），用于时长校验', example: '03:43' },
      excludeSource: { description: '聚合结果中跳过该平台', example: 'kw' },
    },
    dataSchema: 'FindResult',
    possible502: true,
  }, async({ query }) => {
    required(query, ['name'])
    try {
      return {
        list: await musicSdk.findMusic({
          name: query.name,
          singer: query.singer,
          albumName: query.albumName,
          interval: query.interval,
          source: query.excludeSource,
        }),
      }
    } catch (err) {
      throw upstream(err.message)
    }
  })

  // ---------- 歌曲资源（路径参数风格，含旧 query 风格别名） ----------

  const urlHandler = ({ source, id, quality, albumId }) => {
    if (!QUALITIES.includes(quality)) throw invalidParam(`不支持的音质: ${quality}`, { enum: QUALITIES })
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
      throw err instanceof Error && err.status ? err : upstream(err.message)
    })
  }

  router.get('/url/:source/:id', {
    summary: '获取播放地址',
    description: 'id 为平台歌曲 id：kw/tx/wy/mg 用 songmid，kg 用 hash。',
    tags: ['歌曲资源'],
    pathParams: {
      source: pSource('url'),
      id: { description: '平台歌曲 id', example: '28423286' },
    },
    queryParams: {
      quality: pQuality,
      albumId: { description: '专辑 id（部分平台获取封面时需要）' },
    },
    dataSchema: 'MusicUrlResult',
    possible404: true,
    possible502: true,
  }, ({ params, query }) => urlHandler({
    source: params.source, id: params.id, quality: query.quality || '128k', albumId: query.albumId,
  }))

  router.get('/url', {
    summary: '获取播放地址（旧版 query 风格）',
    tags: ['歌曲资源'],
    deprecated: true,
    queryParams: {
      source: { ...pSource('url'), required: true },
      id: { required: true, description: '平台歌曲 id' },
      quality: pQuality,
      albumId: { description: '专辑 id' },
    },
    dataSchema: 'MusicUrlResult',
    possible404: true,
    possible502: true,
  }, ({ query }) => urlHandler({
    source: query.source, id: query.id, quality: query.quality || '128k', albumId: query.albumId,
  }))

  const lyricHandler = ({ source, id, name, interval }) => {
    const m = getSource(musicSdk, source, 'getLyric')
    let result
    try {
      result = unwrap(m.getLyric({ songmid: id, hash: id, copyrightId: id, name: name || '', interval: interval || '' }))
    } catch (err) {
      throw upstream(err.message)
    }
    return result.then(res => (res || { lyric: '', tlyric: '' })).catch(err => {
      throw err instanceof Error && err.status ? err : upstream(err.message)
    })
  }

  router.get('/lyric/:source/:id', {
    summary: '获取歌词',
    tags: ['歌曲资源'],
    pathParams: {
      source: pSource('lyric'),
      id: { description: '平台歌曲 id', example: '28423286' },
    },
    queryParams: {
      name: { description: '歌名（部分平台搜索歌词时需要）' },
      interval: { description: '时长（mm:ss），部分平台搜索歌词时需要' },
    },
    dataSchema: 'LyricInfo',
    possible404: true,
    possible502: true,
  }, ({ params, query }) => lyricHandler({
    source: params.source, id: params.id, name: query.name, interval: query.interval,
  }))

  router.get('/lyric', {
    summary: '获取歌词（旧版 query 风格）',
    tags: ['歌曲资源'],
    deprecated: true,
    queryParams: {
      source: { ...pSource('lyric'), required: true },
      id: { required: true, description: '平台歌曲 id' },
      name: { description: '歌名' },
      interval: { description: '时长（mm:ss）' },
    },
    dataSchema: 'LyricInfo',
    possible404: true,
    possible502: true,
  }, ({ query }) => lyricHandler({
    source: query.source, id: query.id, name: query.name, interval: query.interval,
  }))

  const picHandler = ({ source, id, albumId }) => {
    const m = getSource(musicSdk, source, 'getPic')
    let result
    try {
      result = unwrap(m.getPic({ songmid: id, hash: id, copyrightId: id, albumId: albumId || '' }))
    } catch (err) {
      throw upstream(err.message)
    }
    return result.then(url => ({ url })).catch(err => {
      throw err instanceof Error && err.status ? err : upstream(err.message)
    })
  }

  router.get('/pic/:source/:id', {
    summary: '获取封面',
    tags: ['歌曲资源'],
    pathParams: {
      source: pSource('pic'),
      id: { description: '平台歌曲 id', example: '28423286' },
    },
    queryParams: {
      albumId: { description: '专辑 id（kg 平台需要）' },
    },
    dataSchema: 'PicResult',
    possible404: true,
    possible502: true,
  }, ({ params, query }) => picHandler({
    source: params.source, id: params.id, albumId: query.albumId,
  }))

  router.get('/pic', {
    summary: '获取封面（旧版 query 风格）',
    tags: ['歌曲资源'],
    deprecated: true,
    queryParams: {
      source: { ...pSource('pic'), required: true },
      id: { required: true, description: '平台歌曲 id' },
      albumId: { description: '专辑 id' },
    },
    dataSchema: 'PicResult',
    possible404: true,
    possible502: true,
  }, ({ query }) => picHandler({
    source: query.source, id: query.id, albumId: query.albumId,
  }))

  // ---------- 榜单 ----------

  const boardsHandler = (source) => {
    const m = getSource(musicSdk, source, 'leaderboard')
    return m.leaderboard.getBoards().catch(err => { throw upstream(err.message) })
  }

  router.get('/boards/:source', {
    summary: '获取榜单列表',
    tags: ['榜单'],
    pathParams: { source: pSource('boards') },
    dataSchema: 'BoardListResult',
    possible404: true,
    possible502: true,
  }, ({ params }) => boardsHandler(params.source))

  router.get('/boards', {
    summary: '获取榜单列表（旧版 query 风格）',
    tags: ['榜单'],
    deprecated: true,
    queryParams: { source: { ...pSource('boards'), required: true } },
    dataSchema: 'BoardListResult',
    possible404: true,
    possible502: true,
  }, ({ query }) => {
    required(query, ['source'])
    return boardsHandler(query.source)
  })

  const boardHandler = ({ source, id, page }) => {
    const m = getSource(musicSdk, source, 'leaderboard')
    return m.leaderboard.getList(id, page).catch(err => { throw upstream(err.message) })
  }

  router.get('/boards/:source/:boardId', {
    summary: '获取榜单详情',
    tags: ['榜单'],
    pathParams: {
      source: pSource('boards'),
      boardId: { description: '榜单 id（来自榜单列表接口）', example: 'tx__26' },
    },
    queryParams: { page: pPage },
    dataSchema: 'BoardDetailResult',
    possible404: true,
    possible502: true,
  }, ({ params, query }) => boardHandler({
    source: params.source, id: params.boardId, page: toInt(query.page, 'page', { def: 1 }),
  }))

  router.get('/board', {
    summary: '获取榜单详情（旧版 query 风格）',
    tags: ['榜单'],
    deprecated: true,
    queryParams: {
      source: { ...pSource('boards'), required: true },
      id: { required: true, description: '榜单 id' },
      page: pPage,
    },
    dataSchema: 'BoardDetailResult',
    possible404: true,
    possible502: true,
  }, ({ query }) => {
    required(query, ['source', 'id'])
    return boardHandler({
      source: query.source, id: query.id, page: toInt(query.page, 'page', { def: 1 }),
    })
  })

  // ---------- 歌单 & 热搜 ----------

  const hotSearchHandler = (source) => {
    const m = getSource(musicSdk, source, 'hotSearch')
    return m.hotSearch.getList().catch(err => { throw upstream(err.message) })
  }

  router.get('/hot-search/:source', {
    summary: '获取热搜词',
    tags: ['歌单'],
    pathParams: { source: pSource('hotSearch') },
    dataSchema: 'HotSearchResult',
    possible404: true,
    possible502: true,
  }, ({ params }) => hotSearchHandler(params.source))

  router.get('/hotSearch', {
    summary: '获取热搜词（旧版 query 风格）',
    tags: ['歌单'],
    deprecated: true,
    queryParams: { source: { ...pSource('hotSearch'), required: true } },
    dataSchema: 'HotSearchResult',
    possible404: true,
    possible502: true,
  }, ({ query }) => {
    required(query, ['source'])
    return hotSearchHandler(query.source)
  })

  const songListHandler = ({ source, page, sortId, tagId }) => {
    const m = getSource(musicSdk, source, 'songList')
    return m.songList.getList(sortId ?? 3, tagId ?? 0, page).catch(err => { throw upstream(err.message) })
  }

  router.get('/song-list/:source', {
    summary: '获取歌单列表',
    tags: ['歌单'],
    pathParams: { source: pSource('songList') },
    queryParams: {
      page: pPage,
      sortId: { type: 'integer', default: 3, description: '排序 id（平台相关）' },
      tagId: { type: 'integer', default: 0, description: '标签 id，0 为全部' },
    },
    dataSchema: 'SongListResult',
    possible404: true,
    possible502: true,
  }, ({ params, query }) => songListHandler({
    source: params.source,
    page: toInt(query.page, 'page', { def: 1 }),
    sortId: query.sortId === undefined ? undefined : toInt(query.sortId, 'sortId', { min: 0 }),
    tagId: query.tagId === undefined ? undefined : toInt(query.tagId, 'tagId', { min: 0 }),
  }))

  router.get('/songList', {
    summary: '获取歌单列表（旧版 query 风格）',
    tags: ['歌单'],
    deprecated: true,
    queryParams: {
      source: { ...pSource('songList'), required: true },
      page: pPage,
      sortId: { type: 'integer', default: 3, description: '排序 id（平台相关）' },
      tagId: { type: 'integer', default: 0, description: '标签 id' },
    },
    dataSchema: 'SongListResult',
    possible404: true,
    possible502: true,
  }, ({ query }) => {
    required(query, ['source'])
    return songListHandler({
      source: query.source,
      page: toInt(query.page, 'page', { def: 1 }),
      sortId: query.sortId === undefined ? undefined : toInt(query.sortId, 'sortId', { min: 0 }),
      tagId: query.tagId === undefined ? undefined : toInt(query.tagId, 'tagId', { min: 0 }),
    })
  })

  // ---------- 系统 ----------

  router.get('/health', {
    summary: '健康检查',
    tags: ['系统'],
    dataSchema: 'HealthResult',
  }, () => ({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    platforms: musicSdk.sources.length,
  }))

  router.get('/sources', {
    summary: '获取支持的平台',
    description: '返回各平台的音质支持与能力（search/url/lyric/pic/boards/hotSearch/songList）。',
    tags: ['系统'],
    dataSchema: 'SourcesResult',
  }, () => ({
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
