// QQ音乐专辑（上游 music-lib/qq/album.go + qq.go 的 fetchAlbumDetail 移植）
// 搜索：c.y.qq.com soso search_for_qq_cp t=8（上游 SearchAlbum）
// 曲目：music.musichallAlbum.AlbumSongList GetAlbumSongList 按 100 一批翻页（上游 fetchAlbumDetail 的曲目段）
// 详情：GetAlbumInfo 详情接口已停用：专辑名取自曲目自带的 album 信息，作者由曲目歌手去重合成，封面走平台固定 URL 规则
// 链接解析：albumDetail/<mid>、album/<mid>、albummid=<mid>（上游 ParseAlbum）
import { httpFetch } from '../common/request.ts'
import { filterMusicInfoItem } from './singer.ts'
import { createMusicuFetch } from './utils/index.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
const ALBUM_BATCH = 100

export const filterSongList = (raw: any[]) =>
  (raw ?? []).map(item => filterMusicInfoItem(item.songInfo))

const albumCover = (mid: string) => `https://y.gtimg.cn/music/photo_new/T002R500x500M000${mid}.jpg`
const albumLink = (mid: string) => `https://y.qq.com/n/ryqq/albumDetail/${mid}`

/** 专辑曲目全量（上游 fetchAlbumDetail 的曲目段：AlbumSongList 100 一批翻页） */
export const fetchAlbumSongs = async(albumId: string) => {
  const albumMid = String(albumId ?? '').trim()
  if (!albumMid) throw new Error('tx 专辑 id 为空')

  const songs: any[] = []
  let totalNum = 0
  for (let begin = 0; ; begin += ALBUM_BATCH) {
    const body = await createMusicuFetch({
      req: {
        module: 'music.musichallAlbum.AlbumSongList',
        method: 'GetAlbumSongList',
        param: { albumMid, begin, num: ALBUM_BATCH, order: 2 },
      },
    })
    if (body.req.code != 0) throw new Error('get album song list faild.')
    const data = body.req.data ?? {}
    const list = data.songList ?? []
    if (!totalNum) totalNum = Number(data.totalNum ?? 0) || 0
    if (!list.length) break
    songs.push(...list)
    if (list.length < ALBUM_BATCH) break
    if (totalNum > 0 && begin + list.length >= totalNum) break
  }
  const meta: any = songs[0]?.songInfo ?? null
  return {
    raw: songs,
    songs: filterSongList(songs),
    total: totalNum || songs.length,
    albumMid,
    albumName: meta?.album?.name ?? null,
  }
}

/**
 * 通过专辑 mid 获取专辑详情与曲目列表
 * @param {*} id 专辑 mid（搜索结果中的 albumId）
 * @param {*} page
 * @param {*} limit
 */
export const getAlbumDetail = async(id: string, page = 1, limit = 100) => {
  const body = await createMusicuFetch({
    req: {
      module: 'music.musichallAlbum.AlbumSongList',
      method: 'GetAlbumSongList',
      // 注意：参数名是驼峰 albumMid，下划线形态会被上游以 104400 拒绝
      param: { albumMid: id, begin: (page - 1) * limit, num: limit },
    },
  })
  if (body.req.code != 0) throw new Error('get album song list faild.')

  const data = body.req.data
  const songList = data.songList ?? []
  // GetAlbumInfo 详情接口已停用：专辑名取自曲目自带的 album 信息，
  // 作者由曲目歌手去重合成，封面用平台固定图片 URL 规则
  const first = songList[0]?.songInfo
  const authors = [...new Set(songList.flatMap(item => item.songInfo?.singer?.map(s => s.name) ?? []))]
  return {
    source: 'tx',
    info: {
      name: first?.album?.name ?? null,
      img: albumCover(String(id)),
      desc: null,
      author: authors.join('、') || null,
    },
    list: filterSongList(songList),
    page,
    limit,
    total: data.totalNum,
  }
}

export const getAlbumSongs = async(id: string) => (await fetchAlbumSongs(id)).songs

/** 专辑搜索（上游 SearchAlbum：search_for_qq_cp t=8） */
export const searchAlbum = async(keyword: string, page = 1, limit = 10) => {
  const url = `http://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?format=json&p=${page}&n=${limit}&w=${encodeURIComponent(String(keyword ?? ''))}&t=8`
  const { statusCode, body } = await httpFetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://y.qq.com/portal/search.html' },
    timeout: 15000,
  }).promise
  if (statusCode !== 200 || !body?.data?.album) throw new Error('tx 专辑搜索失败')

  const rawList: any[] = body.data.album.list ?? []
  const list = rawList.map(item => {
    const mid = String(item?.albumMID ?? '').trim()
    if (!mid) return null
    return {
      id: mid,
      name: String(item?.albumName ?? '').trim(),
      cover: `https://y.gtimg.cn/music/photo_new/T002R300x300M000${mid}.jpg`,
      trackCount: Number(item?.song_count ?? item?.songCount ?? 0) || 0,
      creator: String(item?.singerName ?? '').trim(),
      description: '',
      link: albumLink(mid),
      type: 'album',
      albumId: String(item?.albumID ?? ''),
      publishTime: String(item?.publicTime ?? ''),
      source: 'tx' as const,
    }
  }).filter(Boolean)
  const total = Number(body.data.album.totalnum ?? body.data.album.total ?? list.length) || list.length
  return { list, page, limit, total, source: 'tx' as const }
}

const ALBUM_PATTERNS = [
  /albumDetail\/([A-Za-z0-9]+)/,
  /\/album\/([A-Za-z0-9]+)/,
  /albummid=([A-Za-z0-9]+)/,
]

/** 专辑链接解析（上游 ParseAlbum） */
export const parseAlbumLink = async(link: string) => {
  const raw = String(link ?? '')
  for (const pattern of ALBUM_PATTERNS) {
    const match = pattern.exec(raw)
    if (match) return getAlbumDetail(match[1]!)
  }
  throw new Error('无效的QQ音乐专辑链接')
}

export default {
  getAlbumDetail,
  getAlbumSongs,
  searchAlbum,
  parseAlbumLink,
  fetchAlbumSongs,
  filterSongList,
}
