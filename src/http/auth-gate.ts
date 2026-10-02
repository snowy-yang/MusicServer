// 全局调用秘钥鉴权 —— AUTH_KEY 环境变量启用（未设置则完全不鉴权）
// 客户端携带方式（任一即可）：
//   Authorization: Bearer <AUTH_KEY>（也接受裸值不带 Bearer 前缀）
//   X-Api-Key: <AUTH_KEY>
//   ?key=<AUTH_KEY>（查询参数，兼容播放器/下载器直接拉流无法带自定义头的场景）
// 豁免：/health、文档（/、/docs*、/redoc、/openapi.json）与 CORS 预检
import crypto from 'node:crypto'
import type { FastifyRequest, FastifyReply } from 'fastify'

// 无敏感信息且会被监控系统高频探测的路径豁免鉴权
const PUBLIC_PATHS = [/^\/health$/, /^\/$/, /^\/docs(\/|$)/, /^\/redoc$/, /^\/openapi\.json$/]

const safeEqual = (a: string, b: string) => {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB)
}

export const registerAuth = (fastify: any, authKey: string) => {
  fastify.addHook('onRequest', async(request: FastifyRequest, reply: FastifyReply) => {
    if (request.method === 'OPTIONS') return
    const pathname = new URL(request.url, 'http://localhost').pathname
    if (PUBLIC_PATHS.some(re => re.test(pathname))) return

    const authorization = String(request.headers.authorization || '')
    const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : authorization.trim()
    const provided = [
      bearer,
      String(request.headers['x-api-key'] || ''),
      String((request.query as any)?.key || ''),
    ].find(Boolean)

    if (!provided || !safeEqual(provided, authKey)) {
      return reply.code(401).send({
        code: 401,
        msg: '无效或缺少调用秘钥：请在 Authorization: Bearer <key>、X-Api-Key 头或 ?key= 参数中携带',
      })
    }
  })
}
