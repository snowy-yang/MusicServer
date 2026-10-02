// 千千音乐（music.91q.com / 91q.com）公共请求层
// 上游 music-lib/qianqian 的全部接口都走 /v1/*，参数 = 业务参数 + appid + timestamp + sign：
//   sign = md5(按 key 升序拼接 "k=v&..."（不含 sign）+ Secret)
// 该平台匿名即可搜索 / 查专辑 / 查歌单 / 拿免费曲目直链；cookie 仅影响 VIP、收藏等登录态资源，
// MusicServer 从 sdk/auth/store.ts 的 getCredentials('qian') 读取（可选，未登录留空）。
import crypto from 'node:crypto'
import { httpFetch } from '../request.ts'
import { getCredentials } from '../auth/store.ts'

export const APP_ID = '16073360'
export const SECRET = '0b50b02fd0d73a9c4c8c3a781c30845f'
export const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
export const REFERER = 'https://music.91q.com/player'
export const API_BASE = 'https://music.91q.com'

/** 上游音质档位顺序（3000 = flac，其余为 kbps） */
export const RATE_ORDER = ['3000', '320', '128', '64']

/** 千千平台 cookie（未绑定返回空串；上游所有请求都会带上该 header，此处保持一致） */
export const getQianCookie = (): string => {
  const cred = getCredentials('qian') as { cookie?: string } | null
  return cred?.cookie ? String(cred.cookie) : ''
}

/** 上游 signParams：写入当前秒级时间戳，按 key 字典序拼串后追加 Secret 做 md5 */
export const signParams = (params: Record<string, any>): Record<string, any> => {
  const signed: Record<string, any> = { ...params, timestamp: String(Math.floor(Date.now() / 1000)) }
  const keys = Object.keys(signed).sort()
  const payload = keys.map((key) => `${key}=${signed[key]}`).join('&') + SECRET
  signed.sign = crypto.createHash('md5').update(payload, 'utf8').digest('hex')
  return signed
}

export const signedUrl = (path: string, params: Record<string, any>): string =>
  `${API_BASE}${path}?${new URLSearchParams(signParams(params) as any).toString()}`

export const requestHeaders = (): Record<string, string> => {
  const cookie = getQianCookie()
  return {
    'User-Agent': USER_AGENT,
    Referer: REFERER,
    Accept: 'application/json, text/plain, */*',
    ...(cookie ? { Cookie: cookie } : {}),
  }
}

/** 发起带签名的 GET，返回可取消的请求对象；promise resolve 为响应 JSON body */
export const apiRequest = (path: string, params: Record<string, any>) => {
  const req = httpFetch(signedUrl(path, params), { headers: requestHeaders(), timeout: 15000 })
  req.promise = req.promise.then(({ statusCode, body }: any) => {
    if (statusCode != 200) throw new Error(`千千音乐接口失败（HTTP ${statusCode}）`)
    return body ?? {}
  })
  return req
}

/** 发起带签名的 GET，promise resolve 为响应 JSON body */
export const apiGet = (path: string, params: Record<string, any>): Promise<any> =>
  apiRequest(path, params).promise as Promise<any>

/** 上游状态判定：state=true 或 errno=22000 视为成功 */
export const apiOk = (body: any): boolean => body?.state === true || Number(body?.errno) === 22000

/** tracklink 单档位请求（data 内含 path/format/rate/size；VIP 曲目无 path） */
export const trackLink = (tsid: string, rate: string, register?: (req: any) => void): Promise<any> => {
  const req = apiRequest('/v1/song/tracklink', { TSID: tsid, appid: APP_ID, rate })
  register?.(req)
  return req.promise as Promise<any>
}

/** 时间格式 mm:ss（duration 为秒；0 显示 0） */
export const intervalOf = (duration: any): string | number => {
  const seconds = Number(duration)
  if (!Number.isFinite(seconds) || seconds <= 0) return 0
  const m = Math.trunc(seconds / 60)
  const s = Math.trunc(seconds % 60)
  return `${m < 10 ? '0' + m : m}:${s < 10 ? '0' + s : s}`
}

/** 千千歌手数组 → 展示名（优先 artistType=38 歌手；去重后以 、 连接） */
export const joinArtists = (artists: any): string => {
  if (!Array.isArray(artists) || !artists.length) return ''
  const names: string[] = []
  const seen = new Set<string>()
  const add = (name: any) => {
    const n = String(name ?? '').trim()
    if (!n || seen.has(n)) return
    seen.add(n)
    names.push(n)
  }
  for (const item of artists) if (Number(item?.artistType) === 38) add(item?.name)
  if (!names.length) for (const item of artists) add(item?.name)
  return names.join('、')
}

/** 上游 normalizeQianqianAlbumAssetCode：仅接受 p/P 开头（长度 >=2）并归一为大写 P */
export const normalizeAlbumAssetCode = (id: any): string => {
  const s = String(id ?? '').trim()
  if (s.length < 2) return ''
  return s[0] === 'p' || s[0] === 'P' ? `P${s.slice(1)}` : ''
}

/** 上游 sanitizeQianqianAlbumKeyword：特殊字符替换为空格并折叠空白（服务端 23001 时重试用） */
export const sanitizeAlbumKeyword = (keyword: any): string => {
  const trimmed = String(keyword ?? '').trim()
  if (!trimmed) return ''
  return trimmed
    .replace(/[:："'“”‘’()（）[\]【】,，/\\\-.]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
}

export const firstNonEmpty = (...values: any[]): string => {
  for (const value of values) {
    const s = String(value ?? '').trim()
    if (s) return s
  }
  return ''
}

/** 上游 qianqianReleaseDate：只取前 10 位（YYYY-MM-DD） */
export const releaseDate10 = (raw: any): string => {
  const s = String(raw ?? '').trim()
  return s.length >= 10 ? s.slice(0, 10) : s
}

/** 上游 qianqianRateStats：从 rateFileInfo 取最高可用档位的文件大小与码率（kbps） */
export const rateStats = (rateFileInfo: any, duration: number): { size: number; bitrate: number } => {
  for (const rate of RATE_ORDER) {
    const info = rateFileInfo?.[rate]
    const size = Number(info?.size ?? 0)
    if (!info || !(size > 0)) continue
    if (duration > 0) return { size, bitrate: Math.trunc((size * 8) / 1000 / duration) }
    return { size, bitrate: rate === '3000' ? 800 : Number(rate) }
  }
  return { size: 0, bitrate: 0 }
}

// 千千 rateFileInfo → MusicServer 既有 Quality 桶（64k 不参与 types 展示，仅影响取流回退）
const RATE_LABEL: Record<string, '128k' | '320k' | 'flac'> = { '128': '128k', '320': '320k', '3000': 'flac' }

export const rateTypes = (rateFileInfo: any) => {
  const types: Array<{ type: '128k' | '320k' | 'flac'; size: string }> = []
  const _types: Partial<Record<'128k' | '320k' | 'flac', { size: string }>> = {}
  for (const rate of ['128', '320', '3000']) {
    const info = rateFileInfo?.[rate]
    const size = Number(info?.size ?? 0)
    if (!info || !(size > 0)) continue
    const label = RATE_LABEL[rate]
    const sizeText = sizeMB(size)
    types.push({ type: label, size: sizeText })
    _types[label] = { size: sizeText }
  }
  return { types, _types }
}

const sizeMB = (size: number): string => {
  if (!size) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1024)))
  return `${(size / Math.pow(1024, i)).toFixed(2)} ${units[i]}`
}

export interface MapTrackOptions {
  albumId?: string
  albumName?: string
  img?: string | null
  singer?: string
}

/**
 * 千千曲目字段 → MusicServer 统一 Song 形状
 * 搜索用 TSID/albumAssetCode，专辑详情用 assetId（无 albumAssetCode，需外部补 albumId），
 * 歌单详情用 TSID + albumTitle + pic。
 * 注：上游 Search 会跳过 isVip != 0 的曲目；MusicServer 聚合列表保留它们并标记 payPlay，
 * 取流端对无直链的 VIP 曲目给出明确错误（路由可走外部音源/kw 兜底）。
 */
export const mapTrack = (item: any, opts: MapTrackOptions = {}) => {
  const duration = Number(item?.duration ?? 0)
  const stats = rateStats(item?.rateFileInfo, duration)
  const { types, _types } = rateTypes(item?.rateFileInfo)
  const albumId = firstNonEmpty(normalizeAlbumAssetCode(item?.albumAssetCode), opts.albumId)
  return {
    songmid: firstNonEmpty(item?.TSID, item?.assetId, item?.tsid),
    name: String(item?.title ?? '').trim(),
    singer: firstNonEmpty(joinArtists(item?.artist), opts.singer),
    albumId,
    albumName: firstNonEmpty(item?.albumTitle, opts.albumName),
    interval: intervalOf(duration),
    size: stats.size || 0,
    bitrate: stats.bitrate || 0,
    payPlay: Number(item?.isVip ?? 0) !== 0 || Number(item?.isPaid ?? 0) !== 0,
    img: firstNonEmpty(item?.pic, opts.img) || null,
    lrc: null,
    lrcx: '',
    types,
    _types,
    source: 'qian' as const,
  }
}

export const songLink = (tsid: string): string => `https://music.91q.com/song/${tsid}`
export const albumLink = (id: string): string => `https://music.91q.com/album/${id}`
export const playlistLink = (id: string): string => `https://music.91q.com/songlist/${id}`

export default {
  APP_ID,
  SECRET,
  getUserAgent: () => USER_AGENT,
  getQianCookie,
  signParams,
  signedUrl,
  apiRequest,
  apiOk,
  trackLink,
  mapTrack,
  rateTypes,
  rateStats,
  sanitizeAlbumKeyword,
  normalizeAlbumAssetCode,
}
