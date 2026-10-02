// 全局调用秘钥鉴权 —— AUTH_KEY 环境变量启用（未设置则完全不鉴权）
// 验证头统一为 X-Server-Key: <AUTH_KEY>；全部路径（含文档页/健康检查/404）都要求秘钥，
// 未授权请求一律 401，避免被扫描器区分出接口存在性（404/401 差异）。
// 唯一例外：/stream/* 代理流额外接受 ?key=（播放器直接拉流无法携带自定义头）。
// CORS 预检（OPTIONS）无响应体、不泄露内容，豁免。
import crypto from 'node:crypto'
import type { FastifyRequest, FastifyReply } from 'fastify'

const safeEqual = (a: string, b: string) => {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB)
}

export const registerAuth = (fastify: any, authKey: string) => {
  fastify.addHook('onRequest', async(request: FastifyRequest, reply: FastifyReply) => {
    if (request.method === 'OPTIONS') return
    // /stream/* 流媒体代理：X-Server-Key 或 ?key=（播放器拉流兼容）
    const pathname = new URL(request.url, 'http://localhost').pathname
    const provided = pathname.startsWith('/stream/')
      ? (String(request.headers['x-server-key'] || '') || String((request.query as any)?.key || ''))
      : String(request.headers['x-server-key'] || '')

    if (!provided || !safeEqual(provided, authKey)) {
      // 统一 401 文案（不区分路径存在与否，防扫描探测）
      return reply.code(401).send({ code: 401, msg: '无效或缺少调用秘钥：请在 X-Server-Key 请求头携带（流代理可用 ?key=）' })
    }
  })
}
