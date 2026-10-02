// 咪咕歌单 —— 搜索（search_all.do songlist 开关）、曲目（MIGUM3.0 playlist/song/v2.0）、
// 分类（静态关键词表，上游同款，平台未提供分类接口）、链接解析
// 上游对应：music-lib/migu/playlist.go
import {
  buildUrl, convertItemToSong, firstNonEmpty, miguGet, miguPlaylistLink,
  pickMiguImage, type MiguImageItem, type MiguSong, type MiguSongItem,
} from './util.ts'
import { searchAll } from './musicSearch.ts'

interface MiguPlaylistItem {
  id?: string
  name?: string
  musicNum?: string
  userName?: string
  ownerName?: string
  musicListPicUrl?: string
  playNum?: string
  resourceType?: string
  imgItems?: MiguImageItem[]
}

const toPlaylist = (item: MiguPlaylistItem, categoryId?: string) => {
  const playlistID = String(item.id ?? '').trim()
  const name = String(item.name ?? '').trim()
  if (!playlistID || !name) return null
  return {
    id: playlistID,
    name,
    cover: firstNonEmpty(item.musicListPicUrl, pickMiguImage(item.imgItems)),
    trackCount: parseInt(String(item.musicNum ?? ''), 10) || 0,
    playCount: parseInt(String(item.playNum ?? ''), 10) || 0,
    creator: firstNonEmpty(item.userName, item.ownerName),
    link: miguPlaylistLink(playlistID),
    source: 'migu' as const,
    ...(categoryId ? { categoryId } : {}),
  }
}

/** 歌单搜索（上游 searchPlaylists）；分类歌单也用同一接口，关键词即分类名 */
export const searchPlaylist = async(keyword: string, page = 1, limit = 20) => {
  const body = await searchAll(keyword, 'songlist', page, limit)
  const result: MiguPlaylistItem[] = body?.songListResultData?.result ?? []
  const list = result.map(item => toPlaylist(item)).filter(Boolean)
  return { list, source: 'migu' as const, page, limit, total: list.length }
}

/** 静态分类（上游 miguPlaylistCategoryKeywords） */
const CATEGORY_KEYWORDS = [
  { name: '华语', group: '语种', hot: true },
  { name: '欧美', group: '语种', hot: true },
  { name: '日语', group: '语种' },
  { name: '韩语', group: '语种' },
  { name: '粤语', group: '语种' },
  { name: '流行', group: '风格', hot: true },
  { name: '摇滚', group: '风格', hot: true },
  { name: '民谣', group: '风格', hot: true },
  { name: '电子', group: '风格' },
  { name: '说唱', group: '风格' },
  { name: '古风', group: '风格' },
  { name: '轻音乐', group: '风格' },
  { name: '影视', group: '场景', hot: true },
  { name: 'ACG', group: '场景' },
  { name: '治愈', group: '场景' },
  { name: '运动', group: '场景' },
  { name: '学习', group: '场景' },
  { name: '睡前', group: '场景' },
]

export const getCategories = () => ({
  source: 'migu' as const,
  list: [
    { id: '', name: '全部', group: '全部' },
    ...CATEGORY_KEYWORDS.map(c => ({ id: c.name, name: c.name, group: c.group, hot: Boolean(c.hot) })),
  ],
})

export const getCategoryPlaylists = async(categoryId: string, page = 1, limit = 20) => {
  const keyword = String(categoryId ?? '').trim() || '华语'
  const { list } = await searchPlaylist(keyword, page, limit)
  return { list: list.map(p => toPlaylist(p as any, keyword)).filter(Boolean), source: 'migu' as const, page, limit }
}

/** 歌单曲目（每页 50 全量翻页 + 去重；上游 GetPlaylistSongs） */
export const fetchPlaylistSongs = async(playlistId: string): Promise<{ songs: MiguSong[], total: number }> => {
  const playlistID = String(playlistId ?? '').trim()
  if (!playlistID) throw new Error('migu 歌单 id 为空')
  const pageSize = 50
  const seen = new Set<string>()
  const songs: MiguSong[] = []
  let totalCount = 0

  for (let pageNo = 1; ; pageNo++) {
    const body = await miguGet(buildUrl('https://app.c.nf.migu.cn/MIGUM3.0/resource/playlist/song/v2.0', {
      pageNo, pageSize, playlistId: playlistID,
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

  if (!songs.length) throw new Error('migu 歌单没有可播放歌曲')
  return { songs, total: totalCount || songs.length }
}

export const getPlaylistDetail = async(id: string, page = 1, limit = 50) => {
  const playlistID = String(id ?? '').trim()
  const { songs, total } = await fetchPlaylistSongs(playlistID)
  const start = (page - 1) * limit
  return {
    source: 'migu' as const,
    info: { name: playlistID, img: songs[0]?.img ?? '', desc: '', author: '' },
    list: songs.slice(start, start + limit),
    page,
    limit,
    total: total || songs.length,
  }
}

export const getPlaylistSongs = async(id: string) => (await fetchPlaylistSongs(id)).songs

const PLAYLIST_PATTERNS = [
  /playlistId=(\d+)/,
  /musicListId=(\d+)/,
  /(?:playlist|songlist)\/(\d+)/,
]

export const parsePlaylistLink = async(link: string) => {
  const raw = String(link ?? '')
  for (const pattern of PLAYLIST_PATTERNS) {
    const m = raw.match(pattern)
    if (m) return getPlaylistDetail(m[1]!)
  }
  if (raw && !raw.includes('/')) return getPlaylistDetail(raw)
  throw new Error('无效的咪咕歌单链接')
}

export default { searchPlaylist, getPlaylistDetail, getPlaylistSongs, getCategories, getCategoryPlaylists, parsePlaylistLink }
