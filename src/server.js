// HTTP 服务器 —— 多平台音乐聚合 API
// 接口设计参考 lx-music-api-server 的路径约定：
//   GET  /search?name=&singer=&source=&page=&limit=      搜索（source 省略则聚合多平台）
//   GET  /find?name=&singer=&albumName=&interval=        精确匹配搜索（跨平台去重排序）
//   GET  /url?source=&id=&quality=                       获取播放地址（id 为平台歌曲 id，如 songmid/hash/copyrightId）
//   GET  /lyric?source=&id=&trans=0                      获取歌词
//   GET  /pic?source=&id=                                获取封面
//   GET  /boards?source=                                 榜单列表
//   GET  /board?source=&id=&page=                         榜单详情
//   GET  /hotSearch?source=                              热搜
//   GET  /songList?source=&page=                         歌单列表
//   GET  /health                                         健康检查
// 返回格式：{ code: 0, data: ... } 或 { code: 非0, msg: ... }

import http from 'node:http'
import { URL } from 'node:url'
import musicSdk from '../musicSdk/index.js'

const PORT = process.env.PORT || 3300

// 统一响应
const setJsonHeaders = (res, status = 200) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
}

const ok = (res, data) => {
  if (res.writableEnded) return
  setJsonHeaders(res, 200)
  res.end(JSON.stringify({ code: 0, data }))
}
const fail = (res, msg, code = 1) => {
  if (res.writableEnded) return
  setJsonHeaders(res, 200)
  res.end(JSON.stringify({ code, msg: String(msg || '未知错误') }))
}

// 音质映射（SDK 内类型）
const qualitys = ['128k', '320k', 'flac', 'flac24bit']

/**
 * 统一解包 SDK 返回值：getMusicUrl/getLyric/getPic 等返回 { promise, cancelHttp } 结构，
 * 个别平台（如 mg/pic）返回 Promise，兼容两种形态
 */
const unwrap = async(result) => {
  if (result && typeof result.promise !== 'undefined' && typeof result.cancelHttp === 'function') {
    return result.promise
  }
  return result
}

/**
 * 解析搜索/列表结果，得到歌曲对象列表
 * @param {object} source 平台 SDK 对象（musicSdk[kw/kg/tx/wy/mg/bd]）
 * @param {string} name 歌名
 * @param {string} singer 歌手
 * @param {number} page
 * @param {number} limit
 */
const searchSource = async(sourceName, source, name, singer, page, limit) => {
  const result = await source.musicSearch.search(`${name} ${singer || ''}`.trim(), page, limit)
  return result.list
}

const routes = {
  /**
   * 搜索歌曲
   * GET /search?name=xxx&singer=xxx&source=kw&page=1&limit=20
   * source 省略时聚合所有平台（排除 xm）
   */
  async search(req, res, params) {
    const { name, singer } = params
    if (!name) return fail(res, '缺少参数 name')
    const page = parseInt(params.page || 1)
    const limit = parseInt(params.limit || 20)
    const sourceName = params.source

    if (sourceName) {
      const source = musicSdk[sourceName]
      if (!source?.musicSearch) return fail(res, `不支持的平台: ${sourceName}`)
      try {
        const list = await searchSource(sourceName, source, name, singer, page, limit)
        return ok(res, { source: sourceName, list, page, limit })
      } catch (err) {
        return fail(res, err.message)
      }
    }

    // 聚合搜索
    const tasks = []
    for (const s of musicSdk.sources) {
      if (!musicSdk[s.id]?.musicSearch || s.id == 'xm') continue
      tasks.push(searchSource(s.id, musicSdk[s.id], name, singer, page, limit)
        .catch(() => []))
    }
    const lists = await Promise.all(tasks)
    const list = lists.flat()
    return ok(res, { source: 'all', list, page, limit })
  },

  /**
   * 精确匹配搜索（返回最匹配项，跨平台聚合）
   * GET /find?name=xxx&singer=xxx&albumName=xxx&interval=xxx
   */
  async find(req, res, params) {
    if (!params.name) return fail(res, '缺少参数 name')
    try {
      const list = await musicSdk.findMusic(params)
      return ok(res, { list })
    } catch (err) {
      return fail(res, err.message)
    }
  },

  /**
   * 获取播放地址
   * GET /url?source=kw&id=xxx&quality=320k
   * id 为平台歌曲 id（kw/tx/wy/mg/bd 用 songmid，kg 用 hash）
   */
  async url(req, res, params) {
    const { source, id } = params
    if (!source || !id) return fail(res, '缺少参数 source 或 id')
    const quality = qualitys.includes(params.quality) ? params.quality : '128k'
    const sourceObj = musicSdk[source]
    if (!sourceObj?.getMusicUrl) return fail(res, `不支持的平台: ${source}`)

    const songInfo = { songmid: id, hash: id, copyrightId: id, albumId: params.albumId || '', _types: {} }
    try {
      const result = await unwrap(sourceObj.getMusicUrl(songInfo, quality))
      if (!result?.url) return fail(res, '获取失败')
      return ok(res, { type: quality, url: result.url })
    } catch (err) {
      return fail(res, err.message)
    }
  },

  /**
   * 获取歌词
   * GET /lyric?source=kw&id=xxx&trans=0
   * id 为平台歌曲 id
   */
  async lyric(req, res, params) {
    const { source, id } = params
    if (!source || !id) return fail(res, '缺少参数 source 或 id')
    const sourceObj = musicSdk[source]
    if (!sourceObj?.getLyric) return fail(res, `不支持的平台: ${source}`)
    try {
      const result = await unwrap(sourceObj.getLyric({ songmid: id, hash: id, copyrightId: id, name: params.name || '', interval: params.interval || '' }))
      return ok(res, result || { lyric: '', tlyric: '' })
    } catch (err) {
      return fail(res, err.message)
    }
  },

  /**
   * 获取封面
   * GET /pic?source=kw&id=xxx
   */
  async pic(req, res, params) {
    const { source, id } = params
    if (!source || !id) return fail(res, '缺少参数 source 或 id')
    const sourceObj = musicSdk[source]
    if (!sourceObj?.getPic) return fail(res, `不支持的平台: ${source}`)
    try {
      const url = await unwrap(sourceObj.getPic({ songmid: id, hash: id, copyrightId: id, albumId: params.albumId || '' }))
      return ok(res, { url })
    } catch (err) {
      return fail(res, err.message)
    }
  },

  /**
   * 获取榜单列表
   * GET /boards?source=kw
   */
  async boards(req, res, params) {
    const { source } = params
    if (!source) return fail(res, '缺少参数 source')
    const sourceObj = musicSdk[source]
    if (!sourceObj?.leaderboard) return fail(res, `不支持的平台: ${source}`)
    try {
      const result = await sourceObj.leaderboard.getBoards()
      return ok(res, result)
    } catch (err) {
      return fail(res, err.message)
    }
  },

  /**
   * 获取榜单详情
   * GET /board?source=kw&id=xxx&page=1
   */
  async board(req, res, params) {
    const { source, id } = params
    if (!source || !id) return fail(res, '缺少参数 source 或 id')
    const sourceObj = musicSdk[source]
    if (!sourceObj?.leaderboard) return fail(res, `不支持的平台: ${source}`)
    try {
      const page = parseInt(params.page || 1)
      const result = await sourceObj.leaderboard.getList(id, page)
      return ok(res, result)
    } catch (err) {
      return fail(res, err.message)
    }
  },

  /**
   * 获取热搜
   * GET /hotSearch?source=kw
   */
  async hotSearch(req, res, params) {
    const { source } = params
    if (!source) return fail(res, '缺少参数 source')
    const sourceObj = musicSdk[source]
    if (!sourceObj?.hotSearch) return fail(res, `不支持的平台: ${source}`)
    try {
      const result = await sourceObj.hotSearch.getList()
      return ok(res, result)
    } catch (err) {
      return fail(res, err.message)
    }
  },

  /**
   * 歌单列表
   * GET /songList?source=kw&page=1
   */
  async songList(req, res, params) {
    const { source } = params
    if (!source) return fail(res, '缺少参数 source')
    const sourceObj = musicSdk[source]
    if (!sourceObj?.songList) return fail(res, `不支持的平台: ${source}`)
    try {
      const page = parseInt(params.page || 1)
      const result = await sourceObj.songList.getList(params.sortId || 3, params.tagId || 0, page)
      return ok(res, result)
    } catch (err) {
      return fail(res, err.message)
    }
  },

  /** 健康检查 */
  async health(req, res) {
    return ok(res, { status: 'ok' })
  },
}

const handler = async(req, res) => {
  // OPTIONS 预检请求快速响应
  if (req.method === 'OPTIONS') {
    setJsonHeaders(res, 204)
    res.end()
    return
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const path = parsedUrl.pathname.replace(/^\/+|\/+$/g, '')
  const params = Object.fromEntries(parsedUrl.searchParams.entries())

  const route = routes[path]
  if (!route) {
    setJsonHeaders(res, 404)
    res.end(JSON.stringify({ code: 404, msg: 'Not Found' }))
    return
  }
  try {
    await route(req, res, params)
  } catch (err) {
    if (process.env.DEBUG) {
      console.error('[route error]', req.url, err?.message, err?.stack?.split('\n').slice(0, 4).join('\n'))
    }
    fail(res, err.message)
  }
}

export const startServer = (port = PORT) => {
  const server = http.createServer(handler)
  server.listen(port, () => {
    console.log(`音乐服务器已启动: http://localhost:${port}`)
    console.log('可用接口: /search /find /url /lyric /pic /boards /board /hotSearch /songList /health')
  })

  // 优雅关闭
  const shutdown = (signal) => {
    console.log(`\n收到 ${signal}，正在关闭服务器...`)
    server.close(() => {
      console.log('服务器已关闭')
      process.exit(0)
    })
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  return server
}

// 直接运行时启动
if (process.argv[1] && (process.argv[1].endsWith('server.js') || process.argv[1].endsWith('src\\server.js'))) {
  startServer()
}
