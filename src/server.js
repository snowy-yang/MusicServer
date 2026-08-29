// HTTP 服务器入口 —— 多平台音乐聚合 API
// 设计目标：标准 HTTP 语义 + FastAPI 风格的自动文档
//
//   规范路由（路径参数风格）           旧版路由（query 风格，保留兼容）
//   GET /search                       （同左）
//   GET /find                         （同左）
//   GET /url/:source/:id              GET /url?source=&id=
//   GET /lyric/:source/:id            GET /lyric?source=&id=
//   GET /pic/:source/:id              GET /pic?source=&id=
//   GET /boards/:source               GET /boards?source=
//   GET /boards/:source/:boardId      GET /board?source=&id=
//   GET /hot-search/:source           GET /hotSearch?source=
//   GET /song-list/:source            GET /songList?source=
//   GET /sources /health              GET /docs /redoc /openapi.json
//
// 状态码语义：200 成功；422 参数校验失败；404 路由或平台不存在；405 方法不允许；502 上游平台失败；500 内部错误
// 响应信封：成功 { code: 0, data }；失败 { code: <HTTP状态码>, msg, detail? }

import http from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { URL } from 'node:url'
import musicSdk from '../musicSdk/index.js'
import { Router } from './http/router.js'
import { ApiError } from './http/api-error.js'
import { registerRoutes } from './routes.js'
import { buildOpenApi } from './openapi/spec.js'
import { swaggerHtml, redocHtml } from './openapi/ui.js'

const PORT = process.env.PORT || 3300
const API_TITLE = 'MusicServer 聚合音乐 API'
const API_DESCRIPTION = '多平台音乐聚合接口：搜索、播放地址、歌词、封面、榜单、歌单。' +
  '支持 kw（酷我）/ kg（酷狗）/ tx（QQ音乐）/ wy（网易云）/ mg（咪咕）平台。'

const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'))

// ---- 路由装配 ----

const router = new Router()
registerRoutes(router, musicSdk)

let specCache = null
const openApiSpec = () => {
  if (!specCache) specCache = buildOpenApi(router, {
    title: API_TITLE,
    description: API_DESCRIPTION,
    version: pkg.version,
  })
  return specCache
}

router.get('/', {
  summary: 'API 文档入口',
  description: '302 重定向到 Swagger UI 文档页。',
  tags: ['系统'],
  rawResponses: { '302': { description: '重定向到 /docs' } },
}, () => ({ __raw: true, status: 302, headers: { Location: '/docs' }, body: '' }))

router.get('/docs', {
  summary: 'Swagger UI 交互文档',
  description: '基于 OpenAPI 规范的交互式文档，可直接在页面上调试接口。',
  tags: ['系统'],
  rawResponses: { '200': { description: 'Swagger UI 页面' } },
}, () => ({
  __raw: true,
  status: 200,
  headers: { 'Content-Type': 'text/html; charset=utf-8' },
  body: swaggerHtml({ title: API_TITLE }),
}))

router.get('/redoc', {
  summary: 'ReDoc 阅读版文档',
  tags: ['系统'],
  rawResponses: { '200': { description: 'ReDoc 页面' } },
}, () => ({
  __raw: true,
  status: 200,
  headers: { 'Content-Type': 'text/html; charset=utf-8' },
  body: redocHtml({ title: API_TITLE }),
}))

router.get('/openapi.json', {
  summary: 'OpenAPI 3.1 规范文档',
  description: '机器可读的接口描述，可用于生成各语言客户端。',
  tags: ['系统'],
  rawResponses: { '200': { description: 'OpenAPI 规范（JSON）' } },
}, () => ({
  __raw: true,
  status: 200,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify(openApiSpec(), null, 2),
}))

// ---- HTTP 处理 ----

const sendJson = (res, status, payload) => {
  if (res.writableEnded) return
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

const logRequest = (req, pathname, search, status, ms) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${pathname}${search} → ${status} (${ms}ms)`)
}

const handler = async(req, res) => {
  const started = Date.now()
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Cache-Control', 'no-store')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    logRequest(req, req.url, '', 204, Date.now() - started)
    return
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const query = Object.fromEntries(url.searchParams.entries())
  let status = 500

  try {
    const matched = router.match(url.pathname, req.method)
    if (!matched) throw new ApiError(404, `接口不存在: ${url.pathname}`)
    if (matched.allowed) {
      res.setHeader('Allow', matched.allowed.join(', '))
      throw new ApiError(405, `方法 ${req.method} 不允许，请使用 ${matched.allowed.join(', ')}`)
    }

    const out = await matched.handler({ req, res, params: matched.params, query })
    if (out && out.__raw) {
      status = out.status || 200
      res.writeHead(status, out.headers)
      res.end(out.body)
    } else {
      status = 200
      sendJson(res, status, { code: 0, data: out })
    }
  } catch (err) {
    if (err instanceof ApiError) {
      status = err.status
      const payload = { code: err.status, msg: err.message }
      if (err.detail !== undefined) payload.detail = err.detail
      sendJson(res, status, payload)
    } else {
      status = 500
      console.error(`[${new Date().toISOString()}] ${req.method} ${url.pathname} 内部错误:`, err)
      sendJson(res, status, { code: 500, msg: '服务器内部错误' })
    }
  }

  logRequest(req, url.pathname, url.search, status, Date.now() - started)
}

export const startServer = (port = PORT) => {
  const server = http.createServer(handler)
  server.listen(port, () => {
    console.log(`音乐服务器已启动: http://localhost:${port}`)
    console.log(`接口文档:   http://localhost:${port}/docs (Swagger UI)`)
    console.log(`ReDoc 文档: http://localhost:${port}/redoc`)
    console.log(`OpenAPI:    http://localhost:${port}/openapi.json`)
  })

  const shutdown = (signal) => {
    console.log(`\n收到 ${signal}，正在关闭服务器...`)
    server.close(() => {
      console.log('服务器已关闭')
      process.exit(0)
    })
    server.closeAllConnections?.()
    setTimeout(() => process.exit(0), 3000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  return server
}

// 直接运行时启动
if (process.argv[1] && (process.argv[1].endsWith('server.js') || process.argv[1].endsWith('src\\server.js'))) {
  startServer()
}
