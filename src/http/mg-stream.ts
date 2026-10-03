// 咪咕加密流票据 —— /url/mg 命中 Z3D/I3D 加密候选时登记，/stream/mg/:id 凭票解密
// （统一入口为 /stream/:source/:id，source=mg 时 id 即此处返回的票据）。
// 不把上游 URL 塞进播放地址（Fastify path 参数限长，且 URL 含时效签名与中文路径），
// 票据短时有效（10 分钟，够播放器起播），进程内存储、不落盘。
import { randomUUID } from 'node:crypto'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'

interface MiguStreamTicket {
  url: string
  fileKey: string
  createdAt: number
}

const TTL_MS = 10 * 60 * 1000
const STREAM_CACHE_LIMIT = 200
const tickets = new Map<string, MiguStreamTicket>()

const prune = () => {
  const now = Date.now()
  for (const [id, ticket] of tickets) {
    if (now - ticket.createdAt > TTL_MS) tickets.delete(id)
  }
  // 超出容量时按插入顺序淘汰最旧票据
  while (tickets.size > STREAM_CACHE_LIMIT) {
    const oldest = tickets.keys().next().value
    if (oldest == null) break
    tickets.delete(oldest)
  }
}

/** 登记一条加密流，返回可直接放入 /stream/mg/:id 的短票据 id */
export const registerMiguStream = (url: string, fileKey: string): string => {
  prune()
  const id = randomUUID().replace(/-/g, '')
  tickets.set(id, { url, fileKey, createdAt: Date.now() })
  return id
}

/** 取出票据（过期返回 null） */
export const takeMiguStream = (id: string): MiguStreamTicket | null => {
  const ticket = tickets.get(id)
  if (!ticket) return null
  if (Date.now() - ticket.createdAt > TTL_MS) {
    tickets.delete(id)
    return null
  }
  return ticket
}

const MIGU_STREAM_UA = 'Android_migu/7.41.13 okhttp/3.12.13'

/** 按扩展名推断明文的 content-type */
export const miguStreamContentType = (url: string): string => {
  if (url.includes('.flac')) return 'audio/flac'
  if (url.includes('.wav')) return 'audio/wav'
  if (url.includes('.m4a')) return 'audio/mp4'
  return 'audio/mpeg'
}

/**
 * 流式下载密流并逐块解密后写入响应。
 * 咪咕 Z3D 的解密是逐字节 `plain[i] = cipher[i] - streamKey[i % 32]`，
 * 因此可按块处理（保持全局偏移），无需把整段音频（可达上百 MB，超过 httpFetch 的缓冲上限）读进内存。
 * @param decryptChunk 处理单块（参数：密文块、块在流中的起始偏移），返回明文块
 */
export const pipeDecryptedMiguStream = (
  url: string,
  transform: (chunk: Buffer, offset: number) => Buffer,
  onChunk: (plain: Buffer, offset: number) => void,
  redirectsLeft = 3,
): Promise<void> => new Promise((resolve, reject) => {
  const get = url.startsWith('https:') ? httpsGet : httpGet
  // 只 settle 一次：异常后不再 resolve/reject，避免二次结算被忽略或覆盖真实错误
  let settled = false
  const settle = (fn: () => void) => {
    if (settled) return
    settled = true
    fn()
  }
  const req = get(url, {
    headers: { 'User-Agent': MIGU_STREAM_UA, Referer: 'https://music.migu.cn/' },
  }, (res: any) => {
    const status = res.statusCode ?? 0
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume()
      if (redirectsLeft <= 0) return settle(() => reject(new Error('重定向次数过多')))
      const next = new URL(res.headers.location, url).toString()
      return pipeDecryptedMiguStream(next, transform, onChunk, redirectsLeft - 1).then(
        () => settle(resolve),
        err => settle(() => reject(err)),
      )
    }
    if (status !== 200) {
      res.resume()
      return settle(() => reject(new Error(`上游返回 ${status}`)))
    }
    let offset = 0
    // transform/onChunk 由调用方提供（路由层会在解密结果非音频时 throw）。
    // 它们在 data 事件回调里同步执行：若直接抛出会逃逸成 uncaughtException 并终止整个进程，
    // 因此必须就地捕获、转成 reject，并 destroy 上游停止后续读取。
    const fail = (err: unknown) => settle(() => {
      res.destroy()
      reject(err)
    })
    res.on('data', (chunk: Buffer) => {
      if (settled) return
      try {
        const plain = transform(chunk, offset)
        offset += chunk.length
        onChunk(plain, offset - plain.length)
      } catch (err) {
        fail(err)
      }
    })
    res.on('end', () => settle(resolve))
    res.on('error', fail)
  })
  req.on('error', (err: unknown) => settle(() => reject(err)))
})
