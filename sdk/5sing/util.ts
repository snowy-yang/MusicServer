// 5sing 公共工具（上游 fivesing/fivesing.go 的 getFirstValid / removeEmTags 等移植）
// 平台 id 统一为 '5sing'（上游包名 fivesing，Go 源码 model.Source 用 "fivesing"；
// 本仓库契约要求 id 为 5sing，故所有对外 source 字段均为 '5sing'。
// 上游 New(cookie) 的 cookie 实际参与请求（搜索/getSongUrl/newget/歌单页），
// 这里按约定从 sdk/auth/store.ts 的 getCredentials('5sing') 读取（无则匿名）。

import { httpFetch } from '../common/request.ts'
import { getCredentials } from '../auth/store.ts'

export const UserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'

/** 上游 fivesing.go 的常量：手机端 API 主机（http 明文，实测无 302） */
export const MOBILE_API = 'http://mobileapi.5sing.kugou.com'
/** 搜索接口（type=0 单曲 / type=1 歌单） */
export const SEARCH_API = 'http://search.5sing.kugou.com/home/json'

/** 作品类型（上游 typeEname；yc=原创 fc=翻唱 bz=伴奏） */
export const SONG_KINDS: Record<string, string> = {
  yc: '原创',
  fc: '翻唱',
  bz: '伴奏',
}

/** 上游 getFirstValid：返回第一个非空字符串（空串视为无效） */
export const getFirstValid = (...urls: Array<string | null | undefined>): string => {
  for (const u of urls) {
    if (u) return String(u)
  }
  return ''
}

/** 上游 removeEmTags：去掉搜索结果里 <em class="keyword"> 高亮标签 */
export const removeEmTags = (s: any): string =>
  String(s ?? '')
    .replaceAll('<em class="keyword">', '')
    .replaceAll('</em>', '')
    .trim()

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  hellip: '…',
  mdash: '—',
  ndash: '–',
}

/** Go html.UnescapeString 的等价实现（常用实体 + 数字实体） */
export const unescapeHtml = (s: any): string =>
  String(s ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return HTML_ENTITIES[entity.toLowerCase()] ?? match
  })

/** 上游 New(cookie)：cookie 仅在有值时随请求发送（匿名可用） */
export const get5singCookie = (): string => String((getCredentials('5sing') as { cookie?: string } | null)?.cookie ?? '')

/** 登录态（凭据存在性判断，与 me 平台 status 对齐） */
export const getStatus = () => {
  const cred = getCredentials('5sing') as { cookie?: string, updatedAt?: string } | null
  return cred?.cookie ? { logged: true, updatedAt: cred.updatedAt } : { logged: false }
}

/** 是否显式声明了非本平台的 source（上游 GetLyrics/GetDownloadURL 的 source mismatch 检查） */
export const isForeignSource = (songInfo: any): boolean =>
  Boolean(songInfo?.source) && songInfo.source !== '5sing'

/**
 * 带 Cookie/UA 的请求（上游 utils.Get + http.Client 自动跟跳的等价实现）
 * httpFetch 不跟随 302：这里手动跟跳最多 3 次（5sing 老链接 http→https / 数字 userId→个性域名）。
 */
export const fetch5sing = async(
  url: string,
  options: { headers?: Record<string, any>, timeout?: number, register?: (request: any) => void } = {},
): Promise<any> => {
  const cookie = get5singCookie()
  const headers = {
    'User-Agent': UserAgent,
    ...(cookie ? { Cookie: cookie } : {}),
    ...(options.headers || {}),
  }
  let current = String(url)
  let response: any = null
  for (let hop = 0; hop <= 3; hop++) {
    const request = httpFetch(current, { headers, timeout: options.timeout ?? 15000 })
    options.register?.(request)
    response = await request.promise
    const status = Number(response?.statusCode) || 0
    const location = response?.headers?.location
    if (status >= 300 && status < 400 && location) {
      try {
        current = new URL(String(location), current).href
      } catch {
        return response
      }
      continue
    }
    return response
  }
  return response
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 5sing 手机端 API 有频率控制（实测连续请求会返回 { code: 13, message: "操作太频繁", data: [] }），
 * 上游 Go 无重试；本移植对 JSON 接口做最多 2 次退避重试，保证搜索/取流/歌词/歌单在突发请求下稳定。
 */
export const fetch5singJson = async(
  url: string,
  options: { headers?: Record<string, any>, timeout?: number, register?: (request: any) => void } = {},
): Promise<any> => {
  let response: any = null
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await fetch5sing(url, options)
    const code = Number(response?.body?.code)
    const message = String(response?.body?.message ?? '')
    if ((code === 13 || message.includes('太频繁')) && attempt < 2) {
      await sleep(800 * (attempt + 1))
      continue
    }
    return response
  }
  return response
}

/** 歌曲页链接（上游 Link 拼法：http://5sing.kugou.com/{typeEname}/{songId}.html） */
export const buildSongLink = (songType: string, songId: string | number): string =>
  songType && songId ? `http://5sing.kugou.com/${songType}/${songId}.html` : ''

/** 歌单页链接（上游 Link 拼法：http://5sing.kugou.com/{userId}/dj/{playlistId}.html） */
export const buildPlaylistLink = (userId: string | number, playlistId: string): string =>
  userId && playlistId ? `http://5sing.kugou.com/${userId}/dj/${playlistId}.html` : ''

/**
 * 解析歌曲的 <songid>|<songtype> 约定（上游 model.Song.ID: "123|yc" + Extra{songid,songtype}）
 * 兼容只给了 songType 字段（路由层只透传 songmid 时用 `|` 分隔）。
 */
export const extractSongId = (
  songmid: any,
  songTypeFallback?: any,
): { songID: string, songType: string } => {
  const raw = String(songmid ?? '')
  const [idPart = '', typePart = ''] = raw.split('|')
  return {
    songID: idPart || '',
    songType: String(typePart || songTypeFallback || ''),
  }
}

/** 上游 Parse 的正则：5sing.kugou.com/(\w+)/(\d+).html（专辑/歌手页不匹配） */
export const extractSongLink = (link: any): { songType: string, songID: string } | null => {
  const match = /5sing\.kugou\.com\/(\w+)\/(\d+)\.html/.exec(String(link ?? ''))
  if (!match) return null
  return { songType: match[1], songID: match[2] }
}

/**
 * 上游 ParsePlaylist 的正则增强：
 * 原正则 `5sing\.kugou\.com/(?:(\d+)/)?dj/([a-zA-Z0-9]+)\.html` 只认数字 userId，
 * 个性域名（如 /yeluoluo/dj/xxx.html）与省略 user 段的链接会漏；userId 本身不参与请求（API 反查更准），故放宽为任意单段。
 */
export const extractPlaylistLink = (link: any): { userId: string, playlistId: string } | null => {
  const match = /5sing\.kugou\.com\/(?:([^/?#]+)\/)?dj\/([a-zA-Z0-9]+)\.html/.exec(String(link ?? ''))
  if (!match) return null
  return { userId: match[1] || '', playlistId: match[2] }
}

/** 上游 Search 的时长估算：songSize*8/320000（320kbps 假设；songSize 为 0 时返回 0） */
export const estimateDuration = (songSize: number): number => {
  const size = Number(songSize) || 0
  return size > 0 ? Math.trunc((size * 8) / 320000) : 0
}

/** 作品类型中文名（typeName 缺失时兜底） */
export const kindName = (songType: string): string => SONG_KINDS[songType] ?? ''
