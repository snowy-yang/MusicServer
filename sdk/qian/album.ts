// 千千音乐专辑
// 搜索：/v1/search?type=3（特殊字符触发 errno 23001 时用清洗后的关键词重试，见 searchAlbumItems）
// 详情：/v1/album/info?albumAssetCode=P...（P 码可直接用；纯数字旧 id 走 /v1/album/albumid2psid 转换）
// 专辑链接：https://music.91q.com/album/<albumAssetCode>
import { APP_ID, apiGet, apiOk, joinArtists, normalizeAlbumAssetCode, mapTrack, releaseDate10, sanitizeAlbumKeyword, albumLink } from './util.ts'

export interface QianAlbumSearchItem {
  albumAssetCode?: string
  title?: string
  pic?: string
  introduce?: string
  releaseDate?: string
  genre?: string
  lang?: string
  artist?: any[]
  trackList?: any[]
}

const mapAlbumSummary = (item: QianAlbumSearchItem) => {
  const id = normalizeAlbumAssetCode(item?.albumAssetCode)
  return {
    id,
    name: String(item?.title ?? '').trim(),
    cover: String(item?.pic ?? '').trim(),
    trackCount: Array.isArray(item?.trackList) ? item.trackList.length : 0,
    creator: joinArtists(item?.artist),
    description: String(item?.introduce ?? '').trim(),
    releaseDate: releaseDate10(item?.releaseDate),
    genre: String(item?.genre ?? '').trim(),
    lang: String(item?.lang ?? '').trim(),
    link: id ? albumLink(id) : '',
    source: 'bd' as const,
  }
}

/** 单次专辑搜索；23001（词非法）时抛出带 retryWithSanitized 标记的错误 */
const searchAlbumOnce = async(word: string, page = 1, limit = 10) => {
  const body = await apiGet('/v1/search', {
    word,
    type: '3',
    pageNo: String(Math.max(1, page)),
    pageSize: String(Math.max(1, limit)),
    appid: APP_ID,
  })
  if (!apiOk(body)) {
    const err: any = new Error(body?.errmsg || `千千专辑搜索失败（errno ${body?.errno}）`)
    err.retryWithSanitized = Number(body?.errno) === 23001
    throw err
  }
  const list = body?.data?.typeAlbum
  return Array.isArray(list) ? (list as QianAlbumSearchItem[]) : []
}

/** 上游 searchAlbumItems：原词失败（23001）时用 sanitizeQianqianAlbumKeyword 清洗后重试一次 */
export const searchAlbumItems = async(keyword: string, page = 1, limit = 10): Promise<QianAlbumSearchItem[]> => {
  const words = [String(keyword ?? '').trim()]
  const sanitized = sanitizeAlbumKeyword(keyword)
  if (sanitized && sanitized !== words[0]) words.push(sanitized)

  let lastErr: Error | null = null
  for (const word of words) {
    try {
      return await searchAlbumOnce(word, page, limit)
    } catch (err: any) {
      lastErr = err
      // 仅 23001 允许换清洗后的词重试；其余错误（网络/服务端）直接上抛
      if (!err?.retryWithSanitized) break
    }
  }
  if (lastErr) throw lastErr
  return []
}

/** 搜索专辑（返回歌单/专辑统一摘要形状） */
export const searchAlbum = async(keyword: string, page = 1, limit = 10) => {
  const word = String(keyword ?? '').trim()
  const empty = { source: 'bd' as const, list: [] as any[], total: 0, page, limit }
  if (!word) return empty

  const items = await searchAlbumItems(word, page, limit)
  const list = items
    .map(mapAlbumSummary)
    .filter((album) => album.id)
    .slice(0, limit)
  return { source: 'bd' as const, list, total: items.length, page, limit }
}

/** 旧数字专辑 id → PSID（P 码）；已是 P 码则原样返回 */
export const resolveAlbumAssetCode = async(id: string): Promise<string> => {
  const raw = String(id ?? '').trim()
  if (!raw) throw new Error('千千专辑 id 为空')

  const normalized = normalizeAlbumAssetCode(raw)
  if (normalized) return normalized

  const body = await apiGet('/v1/album/albumid2psid', { albumid: raw, appid: APP_ID })
  if (!apiOk(body)) throw new Error(body?.errmsg || `千千专辑 id 转换失败（errno ${body?.errno}）`)
  for (const item of Array.isArray(body?.data) ? body.data : []) {
    const psid = normalizeAlbumAssetCode(item?.psid)
    if (psid) return psid
  }
  throw new Error('千千专辑 asset code 未找到')
}

const fetchAlbumInfo = async(id: string) => {
  const albumId = await resolveAlbumAssetCode(id)
  const body = await apiGet('/v1/album/info', { albumAssetCode: albumId, appid: APP_ID })
  if (!apiOk(body)) throw new Error(body?.errmsg || `千千专辑详情获取失败（errno ${body?.errno}）`)
  const data = body?.data ?? {}
  if (!normalizeAlbumAssetCode(data?.albumAssetCode)) throw new Error('千千专辑不存在或已下架')
  return { albumId, data }
}

/** 专辑详情（MusicServer 统一形状；album/info 一次返回全部曲目，这里按 page/limit 切片） */
export const getAlbumDetail = async(id: string, page = 1, limit = 30) => {
  const { albumId, data } = await fetchAlbumInfo(id)
  const title = String(data?.title ?? '').trim()
  const cover = String(data?.pic ?? '').trim()
  const creator = joinArtists(data?.artist)
  const all = Array.isArray(data?.trackList) ? data.trackList : []

  const list = all
    .map((item: any) => {
      const song = mapTrack(item, { albumId, albumName: title, img: cover, singer: creator })
      return {
        ...song,
        // 专辑内曲目补上时长/序号（上游 Extra.track / sort）
        track: Number(item?.sort) > 0 ? Number(item.sort) : undefined,
      }
    })
    .filter((song: any) => song.songmid)

  const start = (Math.max(1, page) - 1) * Math.max(1, limit)
  const paged = list.slice(start, start + Math.max(1, limit))

  const albumInfo = {
    id: albumId,
    name: title,
    img: cover,
    desc: String(data?.introduce ?? '').trim(),
    author: creator,
    releaseDate: releaseDate10(data?.releaseDate),
    genre: String(data?.genre ?? '').trim(),
    lang: String(data?.lang ?? '').trim(),
    total: list.length,
  }

  return {
    source: 'bd' as const,
    info: albumInfo,
    list: paged,
    page,
    limit,
    total: list.length,
    allPage: Math.ceil(list.length / Math.max(1, limit)) || 1,
  }
}

/** 上游 GetAlbumSongs：只取曲目列表 */
export const getAlbumSongs = async(id: string) => {
  const { list } = await getAlbumDetail(id, 1, 10000)
  return list
}

/** 上游 ParseAlbum：支持 P 码链接 / albumAssetCode= / albumid= 三种形态 */
export const parseAlbumLink = async(link: string) => {
  const raw = String(link ?? '').trim()
  const patterns = [
    /music\.91q\.com\/album\/([A-Za-z0-9]+)/,
    /albumAssetCode=([A-Za-z0-9]+)/,
    /albumid=(\d+)/,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(raw)
    if (match) return getAlbumDetail(match[1])
  }
  throw new Error('无效的千千专辑链接')
}

export default { searchAlbum, searchAlbumItems, getAlbumDetail, getAlbumSongs, parseAlbumLink, resolveAlbumAssetCode }
