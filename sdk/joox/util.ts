// JOOX 平台公共工具：请求头/签名/ID 归一化/链接构造/页面数据提取
// 背景（2026-10-02 实测）：
//   - JOOX 是东南亚服务，www.joox.com 会按来源 IP 重定向到 /intl；上游 Go 通过伪造
//     X-Forwarded-For 为东南亚 IP（36.73.34.109）绕过，本移植保持一致。
//   - 新版 web 播放器走 cache.api.joox.com/openjoox2/v1/*，必须带 secret 签名：
//       secret = md5('Jo0x@t3Nc3nT' + 参数按插入序 k=v&... )（值经 encodeURIComponent），
//     密钥来自官网 JS bundle 常量 secretAPIKey（web 公开常量，非账号密钥）。
//   - 旧接口 api.joox.com/web-fcgi-bin/web_get_songinfo 已 404（取流/歌曲详情改用 openjoox2），
//     但 web_lyric 仍可用（歌词仍走上游接口）。
//   - 上游 New(cookie)：cookie 用于游客态/登录态请求；登录 cookie 里的 wmid/session_key
//     在签名参数里作为 uid/usk 参与（可拿到完整曲目/更高档位）。

import crypto from 'node:crypto'
import { httpFetch } from '../common/request.ts'
import { getCredentials } from '../auth/store.ts'

export const JOOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36'
/** 上游 Go 的默认游客 Cookie（jaox.go 常量 Cookie） */
export const JOOX_DEFAULT_COOKIE = 'wmid=142420656; user_type=1; country=id; session_key=2a5d97d05dc8fe238150184eaf3519ad;'
/** 上游 Go 的 X-Forwarded-For（东南亚 IP，绕过地区重定向） */
export const JOOX_XFF = '36.73.34.109'
/** openjoox2 签名密钥（官网 web bundle 常量 secretAPIKey） */
export const JOOX_SECRET_KEY = 'Jo0x@t3Nc3nT'

export const md5Hex = (str: string): string => crypto.createHash('md5').update(str, 'utf8').digest('hex')

/**
 * openjoox2 签名：md5(secretAPIKey + `k=encodeURIComponent(v)` 按插入序以 & 连接)
 * 注意键序即对象插入序（服务端按同序校验），不要重排参数。
 */
export const jooxSign = (params: Record<string, any>): string =>
  md5Hex(JOOX_SECRET_KEY + Object.keys(params).map(key => `${key}=${encodeURIComponent(String(params[key]))}`).join('&'))

/** 绑定到 sdk/auth/store.ts 的登录 cookie（未登录返回空串，不回退游客 cookie） */
export const jooxLoginCookie = (): string => {
  const cred = getCredentials('joox') as { cookie?: string } | null
  return cred?.cookie || ''
}

/** 请求用 cookie（登录态优先；未登录回退上游游客 cookie） */
export const jooxCookie = (): string => jooxLoginCookie() || JOOX_DEFAULT_COOKIE

/** 从 cookie 串里取一个字段 */
export const cookieValue = (cookie: string, name: string): string => {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(String(cookie ?? ''))
  return m ? m[1].trim() : ''
}

/** 平台公共请求头（含地区伪装与 Cookie） */
export const jooxHeaders = (extra: Record<string, any> = {}): Record<string, any> => ({
  'User-Agent': JOOX_UA,
  Cookie: jooxCookie(),
  'X-Forwarded-For': JOOX_XFF,
  Referer: 'https://www.joox.com/',
  Accept: 'application/json, text/plain, */*',
  ...extra,
})

/** 语言归一（对齐官网 51bm.c：zh_hk/zh_mo → zh_TW，zh_cn → zh_CN） */
export const normalizeJooxLang = (lang?: string): string => {
  if (lang === 'zh_hk' || lang === 'zh_mo') return 'zh_TW'
  if (lang === 'zh_cn') return 'zh_CN'
  return lang || 'zh_TW'
}

/** ID 归一化（上游 normalizeJooxID）：去空白 + 百分号解码（空格还原为 +） */
export const normalizeJooxID = (raw: unknown): string => {
  let id = String(raw ?? '').trim()
  if (!id) return ''
  if (id.includes('%')) {
    try {
      id = decodeURIComponent(id)
    } catch {
      // 上游 PathUnescape/QueryUnescape 失败时保留原值
    }
    id = id.replace(/ /g, '+')
  }
  return id
}

export const jooxSongLink = (id: unknown): string => `https://www.joox.com/hk/single/${normalizeJooxID(id)}`
export const jooxAlbumLink = (id: unknown): string => `https://www.joox.com/hk/album/${normalizeJooxID(id)}`
export const jooxRegionalPlaylistLink = (region: string, id: unknown): string =>
  `https://www.joox.com/${region}/playlist/${normalizeJooxID(id)}`
export const jooxPlaylistLink = (id: unknown): string => jooxRegionalPlaylistLink('id', id)
/** 歌单页候选（上游顺序：id → sg → hk，逐个尝试直到页面数据可用） */
export const jooxPlaylistLinks = (id: unknown): string[] =>
  ['id', 'sg', 'hk'].map(region => jooxRegionalPlaylistLink(region, id))

/** 封面挑选（上游 pickJooxImage：优先 300 → 1000 → 100，再回退首个非空） */
export const pickJooxImage = (images: any[]): string => {
  const list = Array.isArray(images) ? images : []
  for (const width of [300, 1000, 100]) {
    for (const image of list) {
      const url = String(image?.url ?? '').trim()
      if (Number(image?.width) === width && url) return url
    }
  }
  for (const image of list) {
    const url = String(image?.url ?? '').trim()
    if (url) return url
  }
  return ''
}

/** 歌手拼接（上游 joinJooxArtists，分隔符 ' / '） */
export const jooxArtists = (list: any[]): string =>
  (Array.isArray(list) ? list : []).map(a => String(a?.name ?? '').trim()).filter(Boolean).join(' / ')

export const firstNonEmpty = (...values: any[]): any => {
  for (const value of values) {
    if (value != null && String(value).trim() !== '') return value
  }
  return ''
}

export const firstNonZero = (...values: any[]): number => {
  for (const value of values) {
    const n = Number(value)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 0
}

/** base64 文本解码（上游 decodeJooxBase64Text：容忍 URL-safe 与缺失填充） */
export const decodeJooxBase64Text = (value: unknown): string => {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const normalized = raw.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  try {
    const text = Buffer.from(padded, 'base64').toString('utf8')
    // 解码结果是二进制噪声时回退原值（对齐上游 stdout base64 校验语义）
    return text.includes('\uFFFD') ? raw : text.trim()
  } catch {
    return raw
  }
}

/** HTML 实体解码（歌词文本兜底） */
export const decodeHtmlEntities = (text: unknown): string =>
  String(text ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#0*39;/g, "'")
    .replace(/&nbsp;/g, ' ')

/** 歌词解码：base64 → utf8 → HTML 实体（上游 base64 + 常见实体兜底） */
export const decodeJooxLyric = (value: unknown): string => decodeHtmlEntities(decodeJooxBase64Text(value))

/** 从 SSR 页面提取 __NEXT_DATA__ JSON */
export const extractJooxNextData = (html: unknown): any => {
  const m = /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(String(html ?? ''))
  if (!m) return null
  try {
    return JSON.parse(m[1])
  } catch {
    return null
  }
}

/**
 * 拉取页面并手动跟随 3xx（request.ts 不自动跟跳；Go 客户端会自动跟）
 * 返回最终页 HTML（非字符串 body 视为空串）
 */
export const fetchJooxPage = async (url: string, maxRedirect = 3): Promise<{ statusCode: number, body: string, finalUrl: string }> => {
  let current = url
  for (let i = 0; i <= maxRedirect; i++) {
    const res: any = await httpFetch(current, { headers: jooxHeaders(), timeout: 20000 }).promise
    const location = res?.headers?.location
    if (res.statusCode >= 300 && res.statusCode < 400 && location) {
      current = new URL(String(location), current).href
      continue
    }
    return { statusCode: res.statusCode, body: typeof res.body === 'string' ? res.body : '', finalUrl: current }
  }
  throw new Error('joox 页面重定向次数过多')
}
