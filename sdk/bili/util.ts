// Bilibili 公共请求助手（上游 music-lib/bilibili 的 bilibili.go/song.go/playlist.go 共享逻辑）
// 与上游的差异（2026-10-02 实测）：
// 1) 上游硬编码的默认 cookie（buvid3=2E109C72-...; SESSDATA=your_sessdata;）当前会被 B 站风控：
//    带上它请求 x/player/playurl 直接返回 HTTP 412（HTML 拦截页），不带 Cookie 反而正常。
//    因此无登录凭据时不照抄那个默认串，而是先请求一次 www.bilibili.com 首页取新鲜的
//    buvid3/b_nut（进程内缓存）；首页获取失败则不带 Cookie（实测匿名搜索/取流均可用）。
// 2) httpFetch 不跟随 302，取流的手动跟跳在 sdk/apis/bili.ts 内处理。
// 3) 上游 New(cookie) 的登录凭据来自 sdk/auth/store.ts 的 bili 记录（扫码登录写入）。

import { httpFetch } from '../common/request.ts'
import { getCredentials } from '../auth/store.ts'
import { formatPlayTime } from '../common/utils.ts'

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0'
export const REFERER = 'https://www.bilibili.com/'

const HOME_URL = 'https://www.bilibili.com/'

/** 上游 UserAgent/Referer 组合（所有接口统一携带） */
export const biliHeaders = (cookie = ''): Record<string, string> => ({
  'User-Agent': UA,
  Referer: REFERER,
  Accept: 'application/json, text/plain, */*',
  ...(cookie ? { Cookie: cookie } : {}),
})

/** 已保存的登录 Cookie（未登录返回空串） */
export const getLoginCookie = (): string => String((getCredentials('bili') as any)?.cookie || '')

const cookieMapFromHeaders = (headers: any): Record<string, string> => {
  const raw = headers?.['set-cookie']
  const values: string[] = Array.isArray(raw) ? raw : raw ? [String(raw)] : []
  const jar: Record<string, string> = {}
  for (const value of values) {
    const pair = String(value).split(';')[0].trim()
    const idx = pair.indexOf('=')
    if (idx > 0) jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim()
  }
  return jar
}

let anonCookie = ''
let anonCookiePromise: Promise<string> | null = null

/** 请求用 Cookie：登录态优先；否则懒加载一份匿名 buvid3（内存缓存，不落盘） */
export const getCookie = async(): Promise<string> => {
  const saved = getLoginCookie()
  if (saved) return saved
  if (anonCookie) return anonCookie
  if (!anonCookiePromise) {
    anonCookiePromise = (async() => {
      try {
        const { headers } = await httpFetch(HOME_URL, { headers: biliHeaders(), timeout: 15000 }).promise as any
        const jar = cookieMapFromHeaders(headers)
        anonCookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ')
      } catch {
        // 拿不到就用无 Cookie 请求（实测同样可用）
      }
      return anonCookie
    })()
  }
  return anonCookiePromise
}

/** 带 B 站请求头的 GET（cookie 省略时自动取登录态/匿名 buvid3；显式传 '' 表示匿名） */
export const apiGet = async(url: string, cookie?: string): Promise<{ statusCode: number, headers: any, body: any }> => {
  const ck = cookie === undefined ? await getCookie() : cookie
  return httpFetch(url, { headers: biliHeaders(ck), timeout: 15000 }).promise as any
}

/** 封面协议补全（上游 normalizeCover） */
export const normalizeCover = (cover: string): string => {
  if (!cover) return ''
  return cover.startsWith('//') ? `https:${cover}` : cover
}

/** 搜索标题去高亮标签（上游 cleanTitle） */
export const cleanTitle = (title: string): string => {
  if (!title) return ''
  return String(title).replace(/<em class="keyword">/g, '').replace(/<\/em>/g, '')
}

/** songmid 约定：`<bvid>|<cid>`（与上游 ID 格式一致） */
export const parseSongId = (songmid: any): { bvid: string, cid: string } => {
  const raw = String(songmid ?? '')
  const idx = raw.indexOf('|')
  if (idx < 0) return { bvid: raw, cid: '' }
  return { bvid: raw.slice(0, idx), cid: raw.slice(idx + 1) }
}

/** 从链接/id 提取 BV 号（上游正则 `(BV\w+)` 的等价实现，兼容小写 bv） */
export const extractBvid = (link: string): string => String(link || '').match(/BV[0-9A-Za-z]+/i)?.[0] || ''

/** 从链接提取分P（上游 `[?&]p=(\d+)`） */
export const extractPage = (link: string): number => {
  const m = String(link || '').match(/[?&]p=(\d+)/)
  const p = m ? parseInt(m[1], 10) : 0
  return p > 0 ? p : 1
}

/** 从链接提取 av 号（上游未支持，任务要求兼容） */
export const extractAid = (link: string): string => {
  const m = String(link || '').match(/\bav(\d+)\b/i)
  return m ? m[1] : ''
}

/** 并发映射（限制并发数，单条失败返回 null） */
export const mapLimit = async(items: any[], limit: number, fn: (item: any, index: number) => Promise<any>): Promise<any[]> => {
  const list = Array.isArray(items) ? items : []
  const out: any[] = new Array(list.length).fill(null)
  let next = 0
  const size = Math.max(1, Math.min(Number(limit) || 1, list.length || 1))
  await Promise.all(Array.from({ length: size }, async() => {
    while (next < list.length) {
      const i = next++
      try {
        out[i] = await fn(list[i], i)
      } catch {
        out[i] = null
      }
    }
  }))
  return out
}

/** 统一歌曲形状（对齐 MusicServer 契约；albumId/albumName 沿用上游的 bvid） */
export const makeSong = ({ bvid, cid, name, artist, album, duration, cover, page = 1 }: {
  bvid: string
  cid: string | number
  name?: string
  artist?: string
  album?: string
  duration?: number | string
  cover?: string
  page?: number
}) => {
  const seconds = Number(duration) || 0
  const url = `https://www.bilibili.com/video/${bvid}${page > 1 ? `?p=${page}` : ''}`
  return {
    songmid: `${bvid}|${cid}`,
    name: name || '',
    singer: artist || '',
    albumId: bvid || '',
    albumName: album || bvid || '',
    interval: seconds ? formatPlayTime(seconds) : 0,
    img: normalizeCover(cover || '') || null,
    lrc: null,
    types: [] as any[],
    _types: {} as Record<string, any>,
    source: 'bili' as const,
    bvid,
    cid: String(cid ?? ''),
    page,
    link: url,
  }
}

// ---- 视频/分P/合集接口（上游 bilibili.go 各 fetch* 的对应实现） ----

/** 视频详情（x/web-interface/view）；bvid 或 aid 均可，返回 data 节点 */
export const fetchView = async(id: string): Promise<any> => {
  const raw = String(id || '').trim()
  if (!raw) throw new Error('B站视频 id 为空')
  const query = /^BV/i.test(raw) ? `bvid=${encodeURIComponent(raw)}` : `aid=${encodeURIComponent(raw.replace(/^av/i, ''))}`
  const { statusCode, body } = await apiGet(`https://api.bilibili.com/x/web-interface/view?${query}`)
  if (statusCode !== 200 || !body || body.code !== 0 || !body.data) {
    throw new Error(`B站视频信息获取失败（${body?.code ?? `HTTP ${statusCode}`}${body?.message ? `: ${body.message}` : ''}）`)
  }
  return body.data
}

/** 分P列表（x/player/pagelist），返回 data 数组 */
export const fetchPageList = async(bvid: string): Promise<any[]> => {
  const { statusCode, body } = await apiGet(`https://api.bilibili.com/x/player/pagelist?bvid=${encodeURIComponent(bvid)}`)
  if (statusCode !== 200 || !body || body.code !== 0) {
    throw new Error(`B站分P列表获取失败（${body?.code ?? `HTTP ${statusCode}`}${body?.message ? `: ${body.message}` : ''}）`)
  }
  return body.data ?? []
}

/** 合集归档索引（x/space/ugc/season；上游 fetchSeasonArchiveIndex；该接口现已 404，调用方需容错） */
export const fetchSeasonArchiveIndex = async(mid: string | number, seasonId: string | number): Promise<{ index: Record<string, { title: string, cover: string, duration: number }>, title: string, cover: string }> => {
  if (!mid || !seasonId) throw new Error('合集信息无效')
  const index: Record<string, { title: string, cover: string, duration: number }> = {}
  let seasonTitle = ''
  let seasonCover = ''
  let processed = 0
  let pageNum = 1
  const pageSize = 30
  for (;;) {
    const { body } = await apiGet(`https://api.bilibili.com/x/space/ugc/season?mid=${mid}&season_id=${seasonId}&page_num=${pageNum}&page_size=${pageSize}`)
    if (!body || body.code !== 0) {
      throw new Error(`B站合集信息获取失败（${body?.code ?? '非 JSON 响应'}${body?.message ? `: ${body.message}` : ''}）`)
    }
    if (!seasonTitle) seasonTitle = body.data?.season?.title || ''
    if (!seasonCover) seasonCover = body.data?.season?.cover || ''
    const archives = body.data?.archives ?? []
    if (!archives.length) break
    for (const arc of archives) {
      const meta = { title: arc?.title || '', cover: normalizeCover(arc?.cover || ''), duration: Number(arc?.duration) || 0 }
      if (arc?.bvid) index[`bvid:${arc.bvid}`] = meta
      if (arc?.cid) index[`cid:${arc.cid}`] = meta
    }
    processed += archives.length
    const total = Number(body.data?.page?.total) || 0
    if (!total || processed >= total) break
    pageNum += 1
    if (pageNum > 100) break
  }
  return { index, title: seasonTitle, cover: seasonCover }
}

/** 由分P数组构造歌曲（上游 buildSongsFromPages） */
export const buildSongsFromPages = (bvid: string, rootTitle: string, author: string, cover: string, pages: any[]): any[] => {
  return (pages || []).map((page: any, i: number) => {
    const part = page?.part || ''
    let displayTitle = part
    if (pages.length === 1 && !displayTitle) displayTitle = rootTitle
    else if (displayTitle !== rootTitle) displayTitle = `${rootTitle} - ${displayTitle}`
    return makeSong({
      bvid,
      cid: page?.cid,
      name: displayTitle,
      artist: author,
      album: bvid,
      duration: page?.duration,
      cover,
      page: i + 1,
    })
  })
}

/** 由合集 sections 构造歌曲（上游 buildSongsFromSeasonSections） */
export const buildSongsFromSeasonSections = (
  sections: any[],
  seasonTitle: string,
  seasonCover: string,
  artistName: string,
  archiveIndex: Record<string, { title: string, cover: string, duration: number }> = {},
): any[] => {
  const songs: any[] = []
  const artist = artistName || seasonTitle
  for (const sec of sections || []) {
    for (const ep of sec?.episodes || []) {
      let cover = ep?.cover || ''
      const meta = archiveIndex[`bvid:${ep?.bvid}`] ?? (ep?.cid ? archiveIndex[`cid:${ep.cid}`] : undefined)
      if (!cover) cover = ep?.arc?.pic || ''
      if (!cover) cover = seasonCover || meta?.cover || ''
      let duration = Number(ep?.duration) || 0
      if (!duration) duration = Number(ep?.page?.duration) || 0
      if (!duration) duration = Number(ep?.arc?.duration) || 0
      if (!duration) duration = meta?.duration || 0
      let name = ep?.title || ep?.arc?.title || ep?.page?.part || meta?.title || ''
      songs.push(makeSong({
        bvid: ep?.bvid || '',
        cid: ep?.cid,
        name,
        artist,
        album: ep?.bvid || '',
        duration,
        cover,
        page: 1,
      }))
    }
  }
  return songs
}

/** 合集歌曲（x/space/ugc/season，上游 fetchSeasonSongs；该接口现已 404，调用方需容错） */
export const fetchSeasonSongs = async(mid: string | number, seasonId: string | number): Promise<any[]> => {
  if (!mid || !seasonId) throw new Error('合集信息无效')
  const all: any[] = []
  let processed = 0
  let seasonTitle = ''
  let seasonCover = ''
  let pageNum = 1
  const pageSize = 30
  for (;;) {
    const { body } = await apiGet(`https://api.bilibili.com/x/space/ugc/season?mid=${mid}&season_id=${seasonId}&page_num=${pageNum}&page_size=${pageSize}`)
    if (!body || body.code !== 0) {
      throw new Error(`B站合集列表获取失败（${body?.code ?? '非 JSON 响应'}${body?.message ? `: ${body.message}` : ''}）`)
    }
    if (!seasonTitle) seasonTitle = body.data?.season?.title || ''
    if (!seasonCover) seasonCover = body.data?.season?.cover || ''
    const archives = body.data?.archives ?? []
    if (!archives.length) break
    for (const arc of archives) {
      if (!arc?.cid) continue
      all.push(makeSong({
        bvid: arc?.bvid || '',
        cid: arc.cid,
        name: arc?.title || '',
        artist: '',
        album: seasonTitle || arc?.bvid || '',
        duration: arc?.duration,
        cover: normalizeCover(arc?.cover || seasonCover),
        page: 1,
      }))
    }
    processed += archives.length
    const total = Number(body.data?.page?.total) || 0
    if (!total || processed >= total) break
    pageNum += 1
    if (pageNum > 100) break
  }
  return all
}
