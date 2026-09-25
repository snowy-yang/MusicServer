// HTTP 服务器入口（Fastify）—— 多平台音乐聚合 API
// 设计目标：标准 HTTP 语义 + FastAPI 风格的自动文档（校验与文档均由 JSON Schema 驱动）
//
//   GET /search?name=&singer=&source=&page=&limit=   搜索（source 省略时聚合全部平台）
//   GET /find?name=&singer=&albumName=&interval=     跨平台精确匹配
//   GET /url/:source/:id                             播放地址
//   GET /lyric/:source/:id                           歌词
//   GET /pic/:source/:id                             封面
//   GET /boards/:source                              榜单列表
//   GET /boards/:source/:boardId                     榜单详情
//   GET /hot-search/:source                          热搜词
//   GET /song-list/:source                           歌单列表
//   GET /singer/:source/:id                          歌手信息（kg/tx/wy）
//   GET /singer/:source/:id/songs                    歌手歌曲（kg/tx/wy）
//   GET /singer/:source/:id/albums                   歌手专辑（kg/tx/wy）
//   GET /album/:source/:id                           专辑详情+曲目（kg/kw）
//   GET /sources /health              GET /docs /redoc /openapi.json
//
// 状态码语义：200 成功；422 参数校验失败；404 路由或平台不存在；405 方法不允许；502 上游平台失败；500 内部错误
// 响应信封：成功 { code: 0, data }；失败 { code: <HTTP状态码>, msg, detail? }

import Fastify from 'fastify'
import cors from '@fastify/cors'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import musicSdk from '../sdk/index.ts'
import { ApiError } from './http/api-error.ts'
import { musicRoutes } from './routes.ts'
import { loginRoutes } from './routes-login.ts'
import { COMPONENT_SCHEMAS } from './openapi/components.ts'
import { redocHtml } from './openapi/ui.ts'

// 默认端口 16688：本机 TCP 动态端口范围是 1024~15000（出站连接会随机占用低端端口），避开该区间
const PORT = process.env.PORT || 16688
const DOCS_PREFIX = '/docs'
const API_TITLE = 'MusicServer 聚合音乐 API'
const API_DESCRIPTION = '多平台音乐聚合接口：搜索、播放地址、歌词、封面、榜单、歌单。' +
  '支持 kw（酷我）/ kg（酷狗）/ tx（QQ音乐）/ wy（网易云）平台。'

const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'))

const fastify = Fastify({
  logger: false,
  // schema 中的 example 等文档关键字仅供 OpenAPI 使用，关闭 Ajv 严格模式以免校验构建报错
  ajv: { customOptions: { strict: false } },
})
fastify.decorate('musicSdk', musicSdk)

// ---- 共享 schema（领域模型：校验引用与 OpenAPI components 同源） ----
for (const [name, schema] of Object.entries(COMPONENT_SCHEMAS)) {
  fastify.addSchema({ ...schema, $id: name })
}

// ---- 全局中间行为 ----

// 收集全部路由模式（含 :param 参数段），供 not-found 处理器做 405 判定
const routePatterns: { method: any; regex: RegExp }[] = []
fastify.addHook('onRoute', (routeOptions) => {
  if (!routeOptions.url || !routeOptions.method) return
  // :param 段 → [^/]+；通配符 * → .*（如 @fastify/cors 注册的 catch-all 路由）；其余按字面量转义
  const source = routeOptions.url
    .replace(/:[^/]+/g, '\u0000')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\u0000/g, '[^/]+')
    .replace(/\\\*/g, '.*')
  routePatterns.push({ method: routeOptions.method, regex: new RegExp(`^${source}$`) })
})

fastify.register(cors, { origin: '*' })

fastify.addHook('onRequest', async(_request, reply) => {
  reply.header('Cache-Control', 'no-store')
})

fastify.addHook('onResponse', async(request, reply) => {
  console.log(`[${new Date().toISOString()}] ${request.method} ${request.url} → ${reply.statusCode} (${Math.round(reply.elapsedTime)}ms)`)
})

// 成功响应统一包成 { code: 0, data }；文档页/raw 路由与非 200 响应不包。
// @fastify/swagger-ui 的规范端点 {DOCS_PREFIX}/json 由插件内部注册、无法加 raw 标记，
// 必须豁免：Swagger UI 强制从该地址加载规范，包了信封顶层就没有 openapi 字段，页面直接报错
fastify.addHook('preSerialization', async(request, reply, payload) => {
  if (reply.statusCode !== 200) return payload
  if ((request.routeOptions.config as any)?.raw) return payload
  if (request.routeOptions.url === `${DOCS_PREFIX}/json`) return payload
  if (payload === null || typeof payload === 'object') return { code: 0, data: payload }
  return payload
})

// ---- 错误处理 ----

fastify.setErrorHandler((err: any, request, reply) => {
  if (err instanceof ApiError) {
    const payload: Record<string, any> = { code: err.status, msg: err.message }
    if (err.detail !== undefined) payload.detail = err.detail
    return reply.code(err.status).send(payload)
  }
  // JSON Schema 校验失败（FastAPI 同款 422 语义）
  if (err.validation) {
    return reply.code(422).send({ code: 422, msg: err.message, detail: err.validation })
  }
  console.error(`[${new Date().toISOString()}] ${request.method} ${request.url} 内部错误:`, err)
  return reply.code(500).send({ code: 500, msg: '服务器内部错误' })
})

fastify.setNotFoundHandler((request, reply) => {
  // 路径存在但方法不允许 → 405 + Allow 头（Fastify 默认给 404，这里补齐标准语义）
  // 用模式匹配而非 hasRoute：hasRoute 需要精确 URL，匹配不到 /url/:source/:id 这类参数路由
  const pathname = new URL(request.url, 'http://localhost').pathname
  const allowed = [...new Set(
    routePatterns
      .filter(r => r.regex.test(pathname) && r.method !== request.method)
      // OPTIONS/HEAD 是辅助方法（CORS 预检由 @fastify/cors 的通配路由承接），不应计入 405 判定
      .filter(r => r.method !== 'OPTIONS' && r.method !== 'HEAD')
      .map(r => r.method),
  )]
  if (allowed.length) {
    reply.code(405).header('Allow', allowed.join(', '))
    return reply.send({ code: 405, msg: `方法 ${request.method} 不允许，请使用 ${allowed.join(', ')}` })
  }
  reply.code(404).send({ code: 404, msg: `接口不存在: ${request.url}` })
})

// ---- OpenAPI 文档 ----

fastify.register(swagger, {
  // 组件按 addSchema 的 $id 命名（默认 def-1/def-2 不可读）
  refResolver: {
    buildLocalReference: (json: any, _baseUri: any, _fragment: any, i: number) => json.$id || `def-${i}`,
  },
  openapi: {
    openapi: '3.1.0',
    info: {
      title: API_TITLE,
      description: API_DESCRIPTION,
      version: pkg.version,
    },
    servers: [{ url: '/', description: '当前服务器' }],
    tags: [
      { name: '搜索', description: '歌曲搜索与跨平台匹配' },
      { name: '歌曲资源', description: '播放地址、歌词、封面' },
      { name: '榜单', description: '排行榜' },
      { name: '歌单', description: '歌单与热搜' },
      { name: '歌手专辑', description: '歌手信息、歌曲与专辑详情' },
      { name: '登录', description: '账号登录（wy 扫码/手机号、kg token）与状态' },
      { name: '系统', description: '健康检查、平台信息、文档' },
    ],
  },
})

// 注意：插件初始化器会把规范地址强制为 {DOCS_PREFIX}/json（uiConfig 的 url 会被覆盖），
// 真正对外文档化的规范地址是下方带 raw 标记的 /openapi.json
fastify.register(swaggerUi, { routePrefix: DOCS_PREFIX })

fastify.get('/openapi.json', {
  config: { raw: true },
  schema: {
    summary: 'OpenAPI 3.1 规范文档',
    description: '机器可读的接口描述，可用于生成各语言客户端。',
    tags: ['系统'],
  },
}, async() => fastify.swagger())

fastify.get('/redoc', {
  schema: {
    summary: 'ReDoc 阅读版文档',
    tags: ['系统'],
  },
}, async(_request, reply) => reply.type('text/html; charset=utf-8').send(redocHtml({ title: API_TITLE })))

fastify.get('/', {
  schema: {
    summary: 'API 文档入口',
    description: '302 重定向到 Swagger UI 文档页。',
    tags: ['系统'],
  },
}, async(_request, reply) => reply.redirect('/docs'))

// ---- 业务路由 ----

fastify.register(musicRoutes)
fastify.register(loginRoutes)

export const startServer = async(port = PORT) => {
  await fastify.listen({ port: Number(port), host: '0.0.0.0' })
  console.log(`音乐服务器已启动: http://localhost:${port}`)
  console.log(`接口文档:   http://localhost:${port}/docs (Swagger UI)`)
  console.log(`ReDoc 文档: http://localhost:${port}/redoc`)
  console.log(`OpenAPI:    http://localhost:${port}/openapi.json`)
  return fastify
}

const shutdown = (signal) => {
  console.log(`\n收到 ${signal}，正在关闭服务器...`)
  fastify.close().then(() => {
    console.log('服务器已关闭')
    process.exit(0)
  })
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// 直接运行时启动
if (process.argv[1] && (process.argv[1].endsWith('server.ts') || process.argv[1].endsWith('src\\server.ts'))) {
  startServer()
}
