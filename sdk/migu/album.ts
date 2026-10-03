// 咪咕专辑 —— 搜索（search_all.do album 开关）+ 曲目（queryAlbumSong，分页聚合去重）+ 详情（resourceinfo 2003）
// 上游对应：music-lib/migu/album.go、migu.go 的 fetchAlbumDetail / fetchAlbumSongs
import {
  buildUrl, convertItemToSong, firstNonEmpty, miguGet, normalizeMiguImageURL,
  pickMiguImage, type MiguImageItem, type MiguSong, type MiguSongItem, miguAlbumLink,
} from './util.ts'
import { searchAll } from './musicSearch.ts'

interface MiguAlbumSearchItem {
  id?: string
  resourceType?: string
  name?: string
  singer?: string
  publishDate?: string
  desc?: string
  imgItems?: MiguImageItem[]
}

export const searchAlbum = async(keyword: string, page = 1, limit = 10) => {
  const body = await searchAll(keyword, 'album', page, limit)
  const result: MiguAlbumSearchItem[] = body?.albumResultData?.result ?? []
  const list = result.map(item => {
    const albumID = String(item.id ?? '').trim()
    if (!albumID) return null
    return {
      id: albumID,
      name: String(item.name ?? '').trim(),
      cover: pickMiguImage(item.imgItems),
      creator: String(item.singer ?? '').trim(),
      description: firstNonEmpty(item.desc, item.publishDate),
      link: miguAlbumLink(albumID),
      source: 'mg' as const,
    }
  }).filter(Boolean)
  return { list, source: 'mg' as const, page, limit, total: list.length }
}

/** 专辑曲目（每页 50 全量翻页 + 去重；上游 fetchAlbumSongs） */
export const fetchAlbumSongs = async(albumId: string): Promise<{ songs: MiguSong[], total: number }> => {
  const albumID = String(albumId ?? '').trim()
  if (!albumID) throw new Error('migu 专辑 id 为空')
  const pageSize = 50
  const seen = new Set<string>()
  const songs: MiguSong[] = []
  let totalCount = 0

  for (let pageNo = 1; ; pageNo++) {
    const body = await miguGet(buildUrl('https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/queryAlbumSong', {
      albumId: albumID, pageNo, pageSize,
    }))
    if (body?.code && body.code !== '000000') throw new Error(`migu api error: ${body.info} (code ${body.code})`)
    const songList: MiguSongItem[] = body?.data?.songList ?? []
    if (!totalCount) totalCount = Number(body?.data?.totalCount ?? 0) || 0
    if (!songList.length) break

    const before = songs.length
    for (const item of songList) {
      const song = convertItemToSong(item, true)
      if (!song) continue
      const key = firstNonEmpty(song.extra.content_id, item.contentId, song.songmid, item.copyrightId)
        || `${song.name}|${song.singer}`
      if (seen.has(key)) continue
      seen.add(key)
      songs.push(song)
    }

    if (songList.length < pageSize) break
    if (totalCount > 0 && songs.length >= totalCount) break
    if (songs.length === before) break
  }

  if (!songs.length) throw new Error('migu 专辑没有可播放歌曲')
  return { songs, total: totalCount || songs.length }
}

/** 专辑详情（曲目 + resourceinfo 2003 的元数据），对齐既有 kg/kw 的 getAlbumDetail 返回形状 */
export const getAlbumDetail = async(id: string, page = 1, limit = 50) => {
  const albumID = String(id ?? '').trim()
  if (!albumID) throw new Error('migu 专辑 id 为空')
  const { songs, total } = await fetchAlbumSongs(albumID)

  let info: { name: string, img: string, desc: string, author: string } = { name: albumID, img: '', desc: '', author: '' }
  try {
    const body = await miguGet(buildUrl('https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/resourceinfo.do', {
      needSimple: '00', resourceType: '2003', resourceId: albumID,
    }))
    if (body?.code && body.code !== '000000') throw new Error(body.info)
    const res = body?.resource?.[0]
    if (res) {
      info = {
        name: String(res.title ?? '').trim() || albumID,
        img: pickMiguImage(res.imgItems),
        desc: String(res.summary ?? '').trim(),
        author: String(res.singer ?? '').trim(),
      }
      if (!info.img && songs[0]?.img) info.img = songs[0].img!
    }
  } catch {
    if (songs[0]?.img) info.img = songs[0].img!
  }

  const start = (page - 1) * limit
  return {
    source: 'mg' as const,
    info,
    list: songs.slice(start, start + limit),
    page,
    limit,
    total: total || songs.length,
  }
}

export const getAlbumSongs = async(id: string) => (await fetchAlbumSongs(id)).songs

const ALBUM_PATTERNS = [
  /music\.migu\.cn\/(?:v3|v5)\/music\/album\/(\d+)/,
  /albumId=(\d+)/,
  /resourceId=(\d+)/,
]

export const parseAlbumLink = async(link: string) => {
  for (const pattern of ALBUM_PATTERNS) {
    const m = String(link ?? '').match(pattern)
    if (m) return getAlbumDetail(m[1]!)
  }
  throw new Error('无效的咪咕专辑链接')
}

export { normalizeMiguImageURL }
export default { searchAlbum, getAlbumDetail, getAlbumSongs, parseAlbumLink }
