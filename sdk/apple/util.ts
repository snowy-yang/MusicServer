// Apple Music（music.apple.com / amp-api.music.apple.com）公共工具
// 上游 music-lib/apple/apple.go 的移植基础层：
//   - New(cookie) → getCredentials('apple')：cookie 支持 "media-user-token=xxx;storefront=cn;token=xxx"
//   - fetchAppleToken()：从 music.apple.com 首页 → index-legacy JS 抓 developer token（amp-api 的 Bearer）
//     当前（2026-10）Apple 下发的 JWT 以 eyJ0eXAi（{"typ":...}）开头而非上游正则写的 eyJh，
//     故这里泛化为任意 JWT（eyJ…）并优先选择 issuer=AMPWebPlay 的 token；带回退与失效重取见 getAppleToken/invalidateAppleToken。
//   - ampGet/ampHeaders：amp-api 请求（httpFetch 不自动跟 302，首页跳转用 fetchFollow 手动跟）
//   - 模型转换：appleSongFromCatalog / appleAlbumToPlaylist / applePlaylistToPlaylist（字段映射同上游）
//   - ID 提取：extractAppleID / extractAppleIDFromPath / isAppleRawID（apple_test.go 的断言全部逐条保留）
import { httpFetch } from '../request.ts'
import { formatPlayTime } from '../common/utils.ts'
import { getCredentials } from '../auth/store.ts'

export const APPLE_HOMEPAGE_URL = 'https://music.apple.com'
export const APPLE_AMP_API_URL = 'https://amp-api.music.apple.com'
export const DEFAULT_STOREFRONT = 'us'
export const APPLE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

/** 上游 New(cookie) 的等价配置（cookie 字符串解析 + 凭据直填字段） */
export interface AppleRuntimeConfig {
  storefront: string
  /** media-user-token（订阅用户 token；歌词/完整曲目等受限资源需要） */
  mediaUserToken: string
  /** 显式提供的 developer token（上游 cookie 里的 token=），优先于网页抓取 */
  token: string
}

/** 上游 parseCookieParts：按 ';' 拆分 cookie，'k=v' 去空白 */
export const parseCookieParts = (cookie: string): Record<string, string> => {
  const result: Record<string, string> = {}
  for (const part of String(cookie ?? '').split(';')) {
    const trimmed = part.trim()
    const idx = trimmed.indexOf('=')
    if (idx > 0) {
      const key = trimmed.slice(0, idx).trim()
      const val = trimmed.slice(idx + 1).trim()
      result[key] = val
    }
  }
  return result
}

/** 读取 apple 平台运行时配置（对应上游 New(cookie)） */
export const getAppleConfig = (): AppleRuntimeConfig => {
  const cred = (getCredentials('apple') as any) || {}
  const parts = parseCookieParts(String(cred.cookie ?? ''))
  const storefront = String(cred.storefront || parts.storefront || DEFAULT_STOREFRONT).trim()
  return {
    storefront: storefront || DEFAULT_STOREFRONT,
    mediaUserToken: String(cred.mediaUserToken || parts['media-user-token'] || '').trim(),
    token: String(cred.token || parts.token || '').trim(),
  }
}

// ---------------- developer token ----------------

let cachedToken = ''
let cachedAt = 0
let pendingToken: Promise<string> | null = null
// 显式配置的 token 在 401/403 后不再优先使用，改为回源网页抓取
let bypassExplicitToken = false
// JWT 自身带 exp（通常数月），这里再加 12h 进程内缓存，避免频繁拉取数 MB 的 JS bundle
const TOKEN_CACHE_TTL = 12 * 60 * 60 * 1000

/** 解码 JWT payload（Apple token 为 ES256 JWT） */
export const decodeAppleTokenPayload = (token: string): any => {
  try {
    const part = String(token ?? '').split('.')[1] || ''
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    return JSON.parse(json)
  } catch {
    return {}
  }
}

export const isAppleTokenExpired = (token: string): boolean => {
  const exp = Number(decodeAppleTokenPayload(token)?.exp || 0)
  return exp > 0 && exp * 1000 < Date.now() + 60 * 1000
}

/** 从 index JS 中提取所有 JWT 形态的候选 token（含引号/等号前缀的主匹配 + 无前缀回退） */
export const extractAppleTokens = (js: string): string[] => {
  const pattern = '(eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,})'
  const found: string[] = []
  let m: RegExpExecArray | null
  const primary = new RegExp(`(?:=["'])${pattern}`, 'g')
  while ((m = primary.exec(String(js ?? '')))) found.push(m[1])
  if (!found.length) {
    const loose = new RegExp(pattern, 'g')
    while ((m = loose.exec(String(js ?? '')))) found.push(m[1])
  }
  return [...new Set(found)]
}

/** 选择可用 token：优先 issuer=AMPWebPlay（amp-api 使用的那个），其次第一个未过期；全部过期视为抓取失败 */
export const pickAppleToken = (js: string): string => {
  const tokens = extractAppleTokens(js)
  if (!tokens.length) return ''
  const alive = tokens.filter(t => !isAppleTokenExpired(t))
  if (!alive.length) return ''
  const preferred = alive.find(t => String(decodeAppleTokenPayload(t)?.iss || '') === 'AMPWebPlay')
  return preferred || alive[0] || ''
}

/** 手动跟随 3xx（httpFetch 不自动跟跳；Apple 首页 → /cn → /cn/new 有两跳） */
export const fetchFollow = async(url: string, headers: Record<string, string> = {}, maxHops = 5): Promise<any> => {
  let current = String(url)
  for (let hop = 0; hop < maxHops; hop++) {
    const res: any = await httpFetch(current, { headers, timeout: 20000 }).promise
    const code = Number(res?.statusCode) || 0
    const location = res?.headers?.location
    if (code >= 300 && code < 400 && location) {
      current = new URL(String(location), current).href
      continue
    }
    return res
  }
  throw new Error('apple: too many redirects')
}

const responseText = (res: any): string => {
  if (typeof res?.body === 'string') return res.body
  return Buffer.isBuffer(res?.raw) ? res.raw.toString('utf8') : String(res?.body ?? '')
}

/** 上游 fetchAppleToken：首页 → index-legacy JS → bearer token */
export const fetchAppleToken = async(): Promise<string> => {
  const home = await fetchFollow(APPLE_HOMEPAGE_URL, { 'User-Agent': APPLE_UA })
  if (Number(home?.statusCode) !== 200) throw new Error(`apple: fetch homepage error: HTTP ${home?.statusCode}`)
  const html = responseText(home)

  // 上游：/(assets/index-legacy[~\-][^/"]+\.js)；当前构建为 index-legacy~hash.js（回退主入口 index~hash.js）
  let match = /\/(assets\/index-legacy[~-][^/"']+\.js)/.exec(html)
  if (!match) match = /\/(assets\/index[~-][^/"']+\.js)/.exec(html)
  if (!match) throw new Error('apple: index.js URI not found')

  const jsRes = await fetchFollow(`${APPLE_HOMEPAGE_URL}/${match[1]}`, { 'User-Agent': APPLE_UA })
  if (Number(jsRes?.statusCode) !== 200) throw new Error(`apple: fetch index.js error: HTTP ${jsRes?.statusCode}`)
  const token = pickAppleToken(responseText(jsRes))
  if (!token) throw new Error('apple: token not found in index.js')
  return token
}

/**
 * 获取 developer token（缓存 + JWT exp 校验 + 并发去重）
 * force=true 或显式 token 失效（401/403 后）时回源重新抓取
 */
export const getAppleToken = async(force = false): Promise<string> => {
  const cfg = getAppleConfig()
  if (!force && !bypassExplicitToken && cfg.token) return cfg.token
  if (!force && cachedToken && Date.now() - cachedAt < TOKEN_CACHE_TTL && !isAppleTokenExpired(cachedToken)) {
    return cachedToken
  }
  if (!pendingToken) {
    pendingToken = (async() => {
      try {
        const token = await fetchAppleToken()
        cachedToken = token
        cachedAt = Date.now()
        return token
      } finally {
        pendingToken = null
      }
    })()
  }
  return pendingToken
}

/** 清除缓存 token（401/403 时调用，下次请求会回源重取） */
export const invalidateAppleToken = (): void => {
  cachedToken = ''
  cachedAt = 0
  bypassExplicitToken = true
}

/** 仅测试/调试用：重置内存态 */
export const resetAppleTokenState = (): void => {
  cachedToken = ''
  cachedAt = 0
  bypassExplicitToken = false
  pendingToken = null
}

// ---------------- amp-api 请求 ----------------

export const appleAmpHeaders = (token: string): Record<string, string> => {
  const cfg = getAppleConfig()
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Origin: APPLE_HOMEPAGE_URL,
    Referer: `${APPLE_HOMEPAGE_URL}/`,
    'User-Agent': APPLE_UA,
    Accept: 'application/json',
  }
  // 上游 ampHeaders：cookie 中的 media-user-token 作为 Cookie 携带
  if (cfg.mediaUserToken) headers.Cookie = `media-user-token=${cfg.mediaUserToken}`
  return headers
}

/** 拼接 amp-api URL：支持以 '/' 开头的路径与 next 返回的完整 URL */
export const buildAppleAmpUrl = (uri: string, params?: Record<string, any> | URLSearchParams | null): string => {
  const raw = String(uri ?? '')
  const base = /^https?:\/\//i.test(raw)
    ? raw
    : raw.startsWith('/')
      ? APPLE_AMP_API_URL + raw
      : `${APPLE_AMP_API_URL}/${raw}`
  let query = ''
  if (params instanceof URLSearchParams) {
    query = params.toString()
  } else if (params && typeof params === 'object') {
    const search = new URLSearchParams()
    for (const key of Object.keys(params)) {
      const value = params[key]
      if (value == null || value === '') continue
      search.append(key, String(value))
    }
    query = search.toString()
  }
  if (!query) return base
  return base + (base.includes('?') ? '&' : '?') + query
}

const ampErrorDetail = (res: any): string => {
  const first = res?.body?.errors?.[0]
  return String(first?.detail || first?.title || '')
}

/**
 * amp-api GET（带 token 失效重取：401/403 时清缓存重试一次）
 * tracker 用于把内层 httpFetch 请求对象暴露给调用方做 cancelHttp
 */
export const appleAmpGetTracked = async(
  uri: string,
  params: Record<string, any> | URLSearchParams | null | undefined,
  tracker?: { current: any },
): Promise<any> => {
  const url = buildAppleAmpUrl(uri, params)
  const attempt = async(): Promise<any> => {
    const token = await getAppleToken()
    const request = httpFetch(url, { headers: appleAmpHeaders(token), timeout: 20000 })
    if (tracker) tracker.current = request
    return request.promise
  }

  let res: any = await attempt()
  if (res?.statusCode === 401 || res?.statusCode === 403) {
    invalidateAppleToken()
    res = await attempt()
  }
  if (!(res?.statusCode >= 200 && res?.statusCode < 300)) {
    const detail = ampErrorDetail(res)
    throw new Error(`apple amp-api HTTP ${res?.statusCode}${detail ? `: ${detail}` : ''}`)
  }
  return res.body
}

export const appleAmpGet = async(uri: string, params?: Record<string, any> | null): Promise<any> => (
  appleAmpGetTracked(uri, params, { current: null })
)

/** 拉取某资源 relationships.tracks 的全部分页（上游 fetchAllTrackResources；带页数上限防死循环） */
const MAX_TRACK_PAGES = 20
export const fetchAllTrackResources = async(tracks: any): Promise<any[]> => {
  const all: any[] = [...(tracks?.data ?? [])]
  let nextUri = String(tracks?.next ?? '').trim()
  for (let page = 0; nextUri && page < MAX_TRACK_PAGES; page++) {
    const body: any = await appleAmpGetTracked(nextUri, null, undefined)
    all.push(...(body?.data ?? []))
    nextUri = String(body?.next ?? '').trim()
  }
  return all
}

// ---------------- 模型转换（字段映射同上游） ----------------

/** 上游 appleArtwork.CoverURL(size)：替换 {w}/{h} 占位 */
export const appleArtworkURL = (artwork: any, size = 600): string => {
  const url = String(artwork?.url ?? '')
  if (!url) return ''
  return url.replace(/\{w\}/g, String(size)).replace(/\{h\}/g, String(size))
}

/** 上游 appleSongFromCatalog → 契约 Song 形状 */
export const appleSongFromCatalog = (res: any, defaultAlbumId = ''): any => {
  const attr = res?.attributes ?? {}
  const previewURL = Array.isArray(attr.previews) && attr.previews.length ? String(attr.previews[0]?.url ?? '') : ''
  const durationSec = Math.round(Number(attr.durationInMillis ?? 0) / 1000)
  return {
    songmid: String(res?.id ?? ''),
    name: attr.name || '',
    singer: attr.artistName || '',
    albumId: String(attr.albumId || defaultAlbumId || ''),
    albumName: attr.albumName || '',
    interval: formatPlayTime(durationSec),
    img: appleArtworkURL(attr.artwork, 600) || null,
    lrc: null,
    types: [],
    _types: {},
    source: 'apple' as const,
    link: attr.url || '', // music.apple.com 网页地址
    previewUrl: previewURL, // 30-90 秒试听片段直链（Apple 不提供完整曲目明文流）
    duration: durationSec,
    isrc: attr.isrc || '',
  }
}

/** 上游 appleAlbumToPlaylist → 契约歌单/专辑摘要 */
export const appleAlbumToPlaylist = (res: any): any => {
  const attr = res?.attributes ?? {}
  return {
    id: String(res?.id ?? ''),
    name: attr.name || '',
    cover: appleArtworkURL(attr.artwork, 300),
    trackCount: Number(attr.trackCount ?? 0) || 0,
    creator: attr.artistName || '',
    description: attr.editorialNotes?.short || '',
    link: attr.url || '',
    source: 'apple' as const,
    extra: {
      release_date: attr.releaseDate || '',
      record_label: attr.recordLabel || '',
    },
  }
}

/** 上游 applePlaylistToPlaylist → 契约歌单摘要（description 四级回退同上游） */
export const applePlaylistToPlaylist = (res: any): any => {
  const attr = res?.attributes ?? {}
  const description = attr.description?.short
    || attr.description?.standard
    || attr.editorialNotes?.short
    || attr.editorialNotes?.standard
    || ''
  return {
    id: String(res?.id ?? ''),
    name: attr.name || '',
    cover: appleArtworkURL(attr.artwork, 300),
    trackCount: Number(attr.trackCount ?? 0) || 0,
    creator: attr.curatorName || '',
    description,
    link: attr.url || '',
    source: 'apple' as const,
  }
}

/** 网页地址（搜索结果 link 缺失时的兜底） */
export const appleWebURL = (kind: 'song' | 'album' | 'playlist', id: string, storefront = DEFAULT_STOREFRONT): string => {
  const sf = String(storefront || DEFAULT_STOREFRONT)
  return `${APPLE_HOMEPAGE_URL}/${sf}/${kind}/${id}`
}

// ---------------- ID 提取（上游 extractAppleID/isAppleRawID/extractAppleIDFromPath） ----------------

/** 上游 isAppleRawID：裸 id 判定（playlist 支持 pl.* / 字母数字，其余要求纯数字） */
export const isAppleRawID = (value: string, mediaType: string): boolean => {
  if (/[/?#]/.test(value) || value.includes('://')) return false
  if (mediaType === 'playlist') {
    if (value.startsWith('pl.')) return /^[a-zA-Z0-9._-]+$/.test(value)
    return /^[a-zA-Z0-9_-]+$/.test(value)
  }
  return /^\d+$/.test(value)
}

/** 上游 extractAppleIDFromPath：在 path 段中找 <type>/<name>/<id> 或 <type>/<id> */
export const extractAppleIDFromPath = (path: string, mediaType: string): string => {
  const trimmed = String(path ?? '').replace(/^\/+|\/+$/g, '')
  if (!trimmed) return ''
  const segments = trimmed.split('/')
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    if (segment !== mediaType && segment !== `${mediaType}s`) continue
    if (i + 2 < segments.length) return segments[i + 2]
    if (i + 1 < segments.length) return segments[i + 1]
  }
  return ''
}

/** 上游 extractAppleID：裸 id / 链接（含地区段与 ?i= 单曲参数）/ 正则兜底 */
export const extractAppleID = (link: string, mediaType: string): string => {
  const raw = String(link ?? '').trim()
  if (!raw) return ''

  if (isAppleRawID(raw, mediaType)) return raw

  // 先按 URL 解析（Go url.Parse 的宽松语义：无协议头时把 '?' 前当 path）
  let path = ''
  let query = ''
  try {
    const parsed = new URL(raw)
    path = parsed.pathname || ''
    query = parsed.search || ''
  } catch {
    const idx = raw.indexOf('?')
    path = idx >= 0 ? raw.slice(0, idx) : raw
    query = idx >= 0 ? raw.slice(idx) : ''
  }
  if (path) {
    if (mediaType === 'song') {
      const songID = new URLSearchParams(query).get('i')?.trim()
      if (songID) return songID
    }
    const fromPath = extractAppleIDFromPath(path, mediaType)
    if (fromPath) return fromPath
  }

  const patterns: RegExp[] = [
    new RegExp(`${mediaType}/[^/]+/(\\d+)`),
    new RegExp(`${mediaType}s?/[^/]+/[^/]+/(\\d+)`),
    /\/(\d+)$/,
    /[?&]i=(\d+)/,
  ]
  if (mediaType === 'playlist') {
    patterns.push(
      /playlists?\/[^/?#]+\/([a-zA-Z0-9._-]+)/,
      /playlists?\/([a-zA-Z0-9._-]+)(?:[?#]|$)/,
    )
  }
  for (const pattern of patterns) {
    const match = pattern.exec(raw)
    if (match && match[1] != null) return match[1]
  }
  return ''
}

// ---------------- 共享请求 ----------------

/** 歌曲详情（上游 Parse/GetLyrics/GetDownloadURL 共用的 /v1/catalog/<sf>/songs/<id>） */
export const fetchAppleSongResource = async(songId: string, include = ''): Promise<any> => {
  const cfg = getAppleConfig()
  const params: Record<string, string> = { extend: 'extendedAssetUrls' }
  if (include) params.include = include
  const body: any = await appleAmpGet(`/v1/catalog/${cfg.storefront}/songs/${songId}`, params)
  const data = body?.data ?? []
  return data.length ? data[0] : null
}

export default {
  parseCookieParts,
  getAppleConfig,
  fetchAppleToken,
  getAppleToken,
  invalidateAppleToken,
  appleAmpGet,
  appleAmpGetTracked,
  appleSongFromCatalog,
  appleAlbumToPlaylist,
  applePlaylistToPlaylist,
  extractAppleID,
  isAppleRawID,
  extractAppleIDFromPath,
}
