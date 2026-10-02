// 网易云专辑（上游 music-lib/netease/album.go + netease.go 的 fetchAlbumDetail 移植）
// 搜索：cloudsearch pc type=10（eapi 通道，与现有 songList.search 同一通路）
// 详情/曲目：weapi/v1/album/<id>（匿名可用；登录 cookie 可选）
// 链接解析：#/album?id= / /album?id= / /album/<id>（上游 parseNeteaseLink）
import { httpFetch } from '../request.ts'
import { weapi } from './utils/crypto.ts'
import { formatPlayTime, sizeFormate } from '../index.ts'
import { formatSingerName } from '../utils.ts'
import { getWyCookie } from '../auth/store.ts'
import { eapiRequest } from './utils/index.ts'
import { parseNeteaseLink } from './link.ts'

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36'

const albumLink = (id: string) => `https://music.163.com/#/album?id=${id}`

/** 网易云歌曲条目 → MusicServer Song 形状（与 wy/songList.filterListDetail 对齐） */
export const convertSong = (item: any) => {
  const types: Array<{ type: string, size: string | null }> = []
  const _types: Record<string, { size: string | null }> = {}
  const push = (type: string, sizeRaw: any) => {
    const size = typeof sizeRaw === 'number' && sizeRaw > 0 ? sizeFormate(sizeRaw) : null
    if (!size) return
    types.push({ type, size })
    _types[type] = { size }
  }
  push('128k', item?.l?.size)
  push('320k', item?.h?.size)
  push('flac', item?.sq?.size)
  push('flac24bit', item?.hr?.size)

  return {
    singer: formatSingerName(item?.ar, 'name'),
    name: item?.name ?? '',
    albumName: item?.al?.name ?? '',
    albumId: item?.al?.id ?? item?.album?.id,
    source: 'wy' as const,
    interval: formatPlayTime((item?.dt ?? 0) / 1000),
    songmid: item?.id,
    img: item?.al?.picUrl ?? item?.album?.picUrl ?? '',
    lrc: null,
    otherSource: null,
    types,
    _types,
    typeUrl: {},
  }
}

/** 专辑详情 + 曲目（上游 fetchAlbumDetail：weapi/v1/album/<id>） */
export const fetchAlbumDetail = async(albumId: string) => {
  const albumID = String(albumId ?? '').trim()
  if (!albumID) throw new Error('wy 专辑 id 为空')
  const cookie = getWyCookie()
  const { statusCode, body } = await httpFetch(`https://music.163.com/weapi/v1/album/${encodeURIComponent(albumID)}`, {
    method: 'post',
    headers: {
      'User-Agent': UA,
      Referer: 'https://music.163.com/',
      origin: 'https://music.163.com',
      ...(cookie ? { cookie } : {}),
    },
    form: weapi({ csrf_token: '' }),
    timeout: 15000,
  }).promise
  if (statusCode !== 200 || body?.code != 200) {
    throw new Error(`wy 专辑详情获取失败 (code ${body?.code ?? statusCode})`)
  }

  const album = body.album ?? {}
  const artistName = album.artist?.name
    || (album.artists ?? []).map((a: any) => a.name).filter(Boolean).join('、')
  const songs = (body.songs ?? []).map(convertSong)
  return {
    source: 'wy' as const,
    info: {
      name: album.name ?? '',
      img: album.picUrl ?? '',
      desc: album.description || album.briefDesc || '',
      author: artistName ?? '',
      albumId: String(album.id ?? albumID),
      publishTime: album.publishTime ?? null,
      company: album.company ?? '',
    },
    list: songs,
    total: Number(album.size ?? 0) || songs.length,
  }
}

/** 专辑详情（分页切片，对齐 spec { source, info, list, page, limit, total }） */
export const getAlbumDetail = async(id: string, page = 1, limit = 50) => {
  const detail = await fetchAlbumDetail(id)
  const start = Math.max(0, (page - 1) * limit)
  return {
    source: 'wy' as const,
    info: detail.info,
    list: detail.list.slice(start, start + limit),
    page,
    limit,
    total: detail.total || detail.list.length,
  }
}

/** 专辑曲目全量（上游 GetAlbumSongs） */
export const getAlbumSongs = async(id: string) => (await fetchAlbumDetail(id)).list

/** 专辑搜索（上游 SearchAlbum：cloudSearch type=10） */
export const searchAlbum = async(keyword: string, page = 1, limit = 10) => {
  const req = eapiRequest('/api/cloudsearch/pc', {
    s: String(keyword ?? ''),
    type: 10,
    limit,
    total: page === 1,
    offset: limit * (page - 1),
  })
  const { statusCode, body } = await req.promise
  if (statusCode !== 200 || body?.code != 200) throw new Error(`wy 专辑搜索失败 (code ${body?.code ?? statusCode})`)

  const albums: any[] = body?.result?.albums ?? []
  const list = albums.map(item => {
    const id = String(item?.id ?? '').trim()
    if (!id) return null
    const artistName = item?.artist?.name
      || (item?.artists ?? []).map((a: any) => a?.name).filter(Boolean).join('、')
    return {
      id,
      name: item?.name ?? '',
      cover: item?.picUrl ?? '',
      trackCount: Number(item?.size ?? 0) || 0,
      creator: artistName ?? '',
      description: item?.description || item?.briefDesc || '',
      link: albumLink(id),
      type: 'album',
      company: item?.company ?? '',
      publishTime: item?.publishTime ?? null,
      source: 'wy' as const,
    }
  }).filter(Boolean)
  const total = Number(body?.result?.albumCount ?? list.length) || list.length
  return { list, page, limit, total, source: 'wy' as const }
}

/** 专辑链接解析（上游 ParseAlbum） */
export const parseAlbumLink = async(link: string) => {
  const raw = String(link ?? '').trim()
  // 裸数字 id 兜底（上游 ParseAlbum 只接受链接）
  if (/^\d+$/.test(raw)) return getAlbumDetail(raw)
  const { kind, id } = parseNeteaseLink(raw)
  if (kind !== 'album') throw new Error('无效的网易云专辑链接')
  return getAlbumDetail(id)
}

export default { getAlbumDetail, getAlbumSongs, searchAlbum, parseAlbumLink, fetchAlbumDetail }
