// JOOX 专辑（上游 joox/album.go 移植 + 新版 openjoox2 通道）
// 搜索：GET https://cache.api.joox.com/openjoox/v3/search（section_type=1 专辑区，item.type=2 专辑）
// 曲目：GET https://cache.api.joox.com/openjoox2/v1/album/<id>/tracks?country=hk&lang=zh_TW&index=&num=&secret=
//       （web 播放器通道，需 md5 签名；实测 2026-10-02 HTTP 200）
// 兜底：www.joox.com/<region>/album/<id> SSR __NEXT_DATA__.props.pageProps.albumData（上游做法，需 X-Forwarded-For）
// 链接解析：ParseAlbum 的正则与裸 ID 规则同上游。

import { httpFetch } from '../request.ts'
import {
  jooxHeaders,
  jooxSign,
  jooxAlbumLink,
  normalizeJooxID,
  normalizeJooxLang,
  pickJooxImage,
  jooxArtists,
  firstNonEmpty,
  firstNonZero,
  extractJooxNextData,
  fetchJooxPage,
} from './util.ts'
import { JOOX_OPENJOOX2 } from './musicInfo.ts'
import { jooxSongFromTrack } from './song.ts'

const SEARCH_URL = 'https://cache.api.joox.com/openjoox/v3/search'

/** openjoox2 专辑曲目（含专辑元信息） */
const fetchAlbumTracks = async(albumId: string, page: number, limit: number) => {
  const country = 'hk'
  const lang = normalizeJooxLang('zh_hk')
  const index = Math.max(0, (page - 1) * limit)
  const params = { country, lang, index, num: limit }
  const url = `${JOOX_OPENJOOX2}/album/${albumId}/tracks?country=${country}&lang=${lang}&index=${index}&num=${limit}&secret=${jooxSign(params)}`
  const { statusCode, body } = await httpFetch(url, { headers: jooxHeaders(), timeout: 20000 }).promise as any
  if (statusCode != 200 || !body || body.code) return null

  const tracks: any[] = body?.tracks?.items ?? []
  const list = tracks.map(item => jooxSongFromTrack(item, body?.name, pickJooxImage(body?.images), albumId)).filter(Boolean)
  if (!list.length) return null

  const total = firstNonZero(body?.tracks?.total_count, body?.tracks?.list_count, list.length)
  return {
    source: 'jx' as const,
    info: {
      name: String(firstNonEmpty(body?.name, albumId)),
      img: pickJooxImage(body?.images) || null,
      desc: String(firstNonEmpty(body?.description, body?.publish_date)),
      author: jooxArtists(body?.artist_list),
    },
    list,
    page,
    limit,
    total,
  }
}

/** SSR 页面专辑数据（上游 fetchAlbumPageData + fetchAlbumDetail 的 data 部分） */
const fetchAlbumPageData = async(albumId: string) => {
  const { body: html } = await fetchJooxPage(jooxAlbumLink(albumId))
  const nextData = extractJooxNextData(html)
  const pageProps = nextData?.props?.pageProps
  const albumData = pageProps?.albumData
  if (normalizeJooxID(albumData?.id)) return albumData
  const nested = pageProps?.content?.page?.albumData
  if (normalizeJooxID(nested?.id)) return nested
  throw new Error('joox 专辑页数据不存在')
}

/** 专辑详情（openjoox2 优先，SSR 页兜底） */
export const getAlbumDetail = async(rawId: string, page = 1, limit = 50) => {
  const albumId = normalizeJooxID(rawId)
  if (!albumId) throw new Error('joox 专辑 id 无效')
  try {
    const detail = await fetchAlbumTracks(albumId, page, limit)
    if (detail) return detail
  } catch {
    // 通道不可用时走页面兜底
  }
  return getAlbumDetailFromPage(albumId, page, limit)
}

/** 专辑详情（SSR 网页兜底通道，上游 fetchAlbumDetail 的页面路径） */
export const getAlbumDetailFromPage = async(rawId: string, page = 1, limit = 50) => {
  const albumId = normalizeJooxID(rawId)
  if (!albumId) throw new Error('joox 专辑 id 无效')
  const albumData = await fetchAlbumPageData(albumId)
  const items: any[] = albumData?.trackList?.items ?? []
  const pageStart = Math.max(0, (page - 1) * limit)
  const pageItems = items.slice(pageStart, pageStart + limit)
  const cover = String(firstNonEmpty(pickJooxImage(albumData?.images), albumData?.imgSrc))
  const list = pageItems
    .map(item => jooxSongFromTrack(item, albumData?.title, cover, albumId))
    .filter(Boolean)
  if (!list.length) throw new Error('joox 专辑无歌曲')

  const total = firstNonZero(albumData?.trackList?.total_count, albumData?.trackList?.list_count, items.length)
  return {
    source: 'jx' as const,
    info: {
      name: String(firstNonEmpty(albumData?.title, albumId)),
      img: cover || null,
      desc: String(firstNonEmpty(albumData?.description, albumData?.publishDate)),
      author: jooxArtists(albumData?.artistList),
    },
    list,
    page,
    limit,
    total,
  }
}

/** 专辑曲目（上游 GetAlbumSongs：仅曲目列表） */
export const getAlbumSongs = async(id: string, page = 1, limit = 50) => {
  const { list } = await getAlbumDetail(id, page, limit)
  return list
}

/** 专辑搜索（上游 SearchAlbum） */
export const searchAlbum = async(keyword: string, page = 1, limit = 20) => {
  const url = `${SEARCH_URL}?country=sg&lang=zh_cn&keyword=${encodeURIComponent(String(keyword ?? ''))}`
  const { statusCode, body } = await httpFetch(url, { headers: jooxHeaders(), timeout: 20000 }).promise as any
  if (statusCode != 200 || !body?.section_list) {
    return { list: [], total: 0, page, limit, source: 'jx' as const }
  }

  const list: any[] = []
  const seen = new Set<string>()
  for (const section of body.section_list) {
    if (Number(section?.section_type) !== 1) continue
    for (const item of section?.item_list ?? []) {
      if (Number(item?.type) !== 2) continue
      const album = item?.album ?? {}
      const id = normalizeJooxID(album.id)
      if (!id || seen.has(id)) continue
      seen.add(id)
      list.push({
        id,
        name: String(album.name ?? ''),
        cover: pickJooxImage(album.images) || null,
        creator: jooxArtists(album.artist_list),
        description: String(album.publish_date ?? '').trim(),
        publishDate: String(album.publish_date ?? '').trim(),
        trackCount: 0,
        link: jooxAlbumLink(id),
        source: 'jx' as const,
      })
    }
  }

  return { list: list.slice(0, limit), total: list.length, page, limit, source: 'jx' as const }
}

/** 专辑链接解析（上游 ParseAlbum） */
export const parseAlbum = async(link: string) => {
  const patterns = [
    /joox\.com\/.*\/album\/([^/?#]+)/,
    /h_activity_id=([^&]+)/,
    /albumid=([^&]+)/,
  ]
  for (const pattern of patterns) {
    const m = pattern.exec(String(link ?? ''))
    if (m) return getAlbumDetail(m[1])
  }
  const raw = String(link ?? '').trim()
  if (raw.length > 10 && !raw.includes('/')) return getAlbumDetail(raw)
  throw new Error('invalid joox album link')
}

export default { getAlbumDetail, getAlbumSongs, searchAlbum, parseAlbum }
