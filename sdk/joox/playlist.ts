// JOOX 歌单（上游 joox/playlist.go 移植：OpenJOOX 接口 + 网页数据兜底两条路）
// 搜索：GET https://cache.api.joox.com/openjoox/v3/search（item.type=1 editor_playlist）
// 曲目：GET https://cache.api.joox.com/openjoox2/v1/playlist/<id>/tracks?...&secret=  ← 新版 web 播放器通道
//       （上游 playlist.go 里的 openjoox/v3/playlist 已 404；网页兜底仍保留）
// 兜底：www.joox.com/{id,sg,hk}/playlist/<id> SSR __NEXT_DATA__
//       props.pageProps.allPlaylistTracks / playlistDetailList（含 content.page 嵌套变体）
// 分类：www.joox.com/sg/playlist（302 → /<region> 首页）__NEXT_DATA__.props.pageProps.mlList
// 链接解析：joox.com/{region}/playlist/<id>、playlistid/id 查询参数、裸 ID

import { httpFetch } from '../request.ts'
import {
  jooxHeaders,
  jooxSign,
  jooxPlaylistLink,
  jooxPlaylistLinks,
  normalizeJooxID,
  normalizeJooxLang,
  pickJooxImage,
  firstNonEmpty,
  firstNonZero,
  decodeJooxBase64Text,
  extractJooxNextData,
  fetchJooxPage,
} from './util.ts'
import { JOOX_OPENJOOX2 } from './musicInfo.ts'
import { jooxSongFromTrack } from './song.ts'

const SEARCH_URL = 'https://cache.api.joox.com/openjoox/v3/search'
const CATEGORY_PAGE = 'https://www.joox.com/sg/playlist'

const mapPlaylistSummary = (item: any) => {
  const id = normalizeJooxID(item?.id)
  if (!id) return null
  return {
    id,
    name: String(item?.name ?? ''),
    cover: pickJooxImage(item?.images) || null,
    trackCount: 0,
    creator: '',
    description: '',
    link: jooxPlaylistLink(id),
    source: 'jx' as const,
  }
}

/** openjoox2 歌单曲目（含歌单元信息） */
const fetchPlaylistTracks = async(playlistId: string, page: number, limit: number) => {
  const country = 'hk'
  const lang = normalizeJooxLang('zh_hk')
  const index = Math.max(0, (page - 1) * limit)
  const params = { country, lang, index, num: limit }
  const url = `${JOOX_OPENJOOX2}/playlist/${playlistId}/tracks?country=${country}&lang=${lang}&index=${index}&num=${limit}&secret=${jooxSign(params)}`
  const { statusCode, body } = await httpFetch(url, { headers: jooxHeaders(), timeout: 20000 }).promise as any
  if (statusCode != 200 || !body || body.code) return null

  const list = (body?.tracks?.items ?? [])
    .map(item => jooxSongFromTrack(item, String(body?.name ?? ''), pickJooxImage(body?.images)))
    .filter(Boolean)
  if (!list.length) return null

  const total = firstNonZero(body?.tracks?.total_count, body?.tracks?.list_count, body?.track_count, list.length)
  return {
    source: 'jx' as const,
    info: {
      name: String(firstNonEmpty(body?.name, playlistId)),
      img: pickJooxImage(body?.images) || null,
      desc: String(firstNonEmpty(body?.description, body?.publish_date)),
      author: '',
    },
    list,
    page,
    limit,
    total,
  }
}

/** 网页兜底：解析歌单 SSR 数据（上游 fetchPlaylistPageDataFromURL 的移植） */
const parsePlaylistPageData = (nextData: any, pageUrl: string) => {
  const pageProps = nextData?.props?.pageProps ?? {}
  let detail: any = pageProps.playlistDetailList ?? {}
  let tracks: any[] = pageProps.allPlaylistTracks?.tracks?.items ?? []
  let trackCount = firstNonZero(
    pageProps.allPlaylistTracks?.tracks?.total_count,
    pageProps.allPlaylistTracks?.tracks?.totalCount,
    pageProps.allPlaylistTracks?.tracks?.list_count,
  )
  if (!tracks.length) {
    tracks = detail?.trackList ?? []
    trackCount = firstNonZero(trackCount, detail?.trackCount, detail?.totalCount, detail?.total_count, detail?.list_count)
  }
  if (!tracks.length) {
    detail = pageProps.content?.page?.playlistDetailList ?? {}
    tracks = pageProps.content?.page?.allPlaylistTracks?.tracks?.items ?? []
    trackCount = firstNonZero(
      pageProps.content?.page?.allPlaylistTracks?.tracks?.total_count,
      pageProps.content?.page?.allPlaylistTracks?.tracks?.totalCount,
      pageProps.content?.page?.allPlaylistTracks?.tracks?.list_count,
      trackCount,
    )
    if (!tracks.length) {
      tracks = detail?.trackList ?? []
      trackCount = firstNonZero(trackCount, detail?.trackCount, detail?.totalCount, detail?.total_count, detail?.list_count)
    }
  }
  if (!tracks.length) return null

  const id = normalizeJooxID(firstNonEmpty(detail?.id, detail?.listId, detail?.playlistId))
  const name = String(firstNonEmpty(detail?.name, detail?.title, detail?.playlistName, id))
  const cover = String(firstNonEmpty(detail?.imgSrc, detail?.cover, detail?.image, detail?.pic))
  const creator = firstNonEmpty(
    detail?.creator, detail?.creatorName, detail?.userName, detail?.nickName, detail?.ownerName,
    detail?.author, detail?.authorName,
    detail?.user?.name, detail?.user?.userName, detail?.user?.nickName, detail?.user?.nick,
    detail?.owner?.name, detail?.owner?.userName, detail?.owner?.nickName, detail?.owner?.nick,
    detail?.creatorInfo?.name, detail?.creatorInfo?.userName, detail?.creatorInfo?.nickName, detail?.creatorInfo?.nick,
  )
  const description = firstNonEmpty(detail?.description, detail?.intro, detail?.desc)
  return { id, name, cover, creator, description, trackCount, tracks, pageUrl }
}

/** 网页兜底：逐个区域尝试歌单页（上游 fetchPlaylistPageData / ParsePlaylist 的页面路径） */
export const getPlaylistDetailFromPage = async(rawId: string) => {
  const playlistId = normalizeJooxID(rawId)
  if (!playlistId) throw new Error('joox 歌单 id 无效')
  let lastErr: any = null
  for (const pageUrl of jooxPlaylistLinks(playlistId)) {
    try {
      const { body: html } = await fetchJooxPage(pageUrl)
      const nextData = extractJooxNextData(html)
      const parsed = parsePlaylistPageData(nextData, pageUrl)
      if (!parsed) throw new Error('joox 歌单页数据不存在')
      const pageId = normalizeJooxID(parsed.id) || playlistId
      const cover = String(parsed.cover || '')
      const list = parsed.tracks
        .map(item => jooxSongFromTrack(item, parsed.name, cover))
        .filter(Boolean)
      if (!list.length) throw new Error('joox 歌单无歌曲')
      return {
        source: 'jx' as const,
        info: {
          name: String(parsed.name || pageId),
          img: cover || null,
          desc: String(parsed.description || ''),
          author: String(parsed.creator || ''),
        },
        list,
        page: 1,
        limit: list.length,
        total: firstNonZero(parsed.trackCount, list.length),
      }
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr ?? new Error('joox 歌单页数据不存在')
}

/** 歌单详情：openjoox2 通道优先，网页兜底（上游两条路都保留） */
export const getPlaylistDetail = async(rawId: string, page = 1, limit = 50) => {
  const playlistId = normalizeJooxID(rawId)
  if (!playlistId) throw new Error('joox 歌单 id 无效')
  try {
    const detail = await fetchPlaylistTracks(playlistId, page, limit)
    if (detail) return detail
  } catch {
    // 通道不可用时走网页兜底
  }
  return getPlaylistDetailFromPage(playlistId)
}

/** 歌单曲目（上游 GetPlaylistSongs：仅曲目列表；v3 接口 404 时用网页兜底） */
export const getPlaylistSongs = async(id: string, page = 1, limit = 50) => {
  try {
    const detail = await fetchPlaylistTracks(normalizeJooxID(id), page, limit)
    if (detail) return detail.list
  } catch {
    // 走网页兜底
  }
  const { list } = await getPlaylistDetailFromPage(normalizeJooxID(id))
  return list
}

/** 歌单搜索（上游 SearchPlaylist） */
export const searchPlaylist = async(keyword: string, page = 1, limit = 20) => {
  const url = `${SEARCH_URL}?country=sg&lang=zh_cn&keyword=${encodeURIComponent(String(keyword ?? ''))}`
  const { statusCode, body } = await httpFetch(url, { headers: jooxHeaders(), timeout: 20000 }).promise as any
  if (statusCode != 200 || !body?.section_list) {
    return { list: [], total: 0, page, limit, source: 'jx' as const }
  }

  const list: any[] = []
  const seen = new Set<string>()
  for (const section of body.section_list) {
    for (const item of section?.item_list ?? []) {
      if (Number(item?.type) !== 1) continue
      const summary = mapPlaylistSummary(item?.editor_playlist)
      if (!summary || seen.has(summary.id)) continue
      seen.add(summary.id)
      list.push(summary)
    }
  }

  return { list: list.slice(0, limit), total: list.length, page, limit, source: 'jx' as const }
}

/** 歌单分类页原始数据（上游 fetchJooxPlaylistCategoriesPage） */
const fetchPlaylistCategoriesPage = async() => {
  const { body: html } = await fetchJooxPage(CATEGORY_PAGE)
  const nextData = extractJooxNextData(html)
  const mlList = nextData?.props?.pageProps?.mlList
  if (!mlList?.category?.length) throw new Error('joox 歌单分类不存在')
  return mlList
}

/** 分类 id：上游 jooxCategoryPlaylistID（数字/字符串都归一） */
const categoryPlaylistId = (value: unknown): string => {
  if (value == null) return ''
  if (typeof value === 'number') return String(Math.trunc(value))
  return normalizeJooxID(value)
}

/** 分类列表（上游 GetPlaylistCategories；首个为「全部」） */
export const getCategories = async() => {
  const data = await fetchPlaylistCategoriesPage()
  const list: any[] = [{ id: '', name: '全部', group: '全部', hot: false }]
  data.category.forEach((category: any, index: number) => {
    const name = decodeJooxBase64Text(category?.title)
    const items: any[] = category?.itemlist ?? []
    if (!name || !items.length) return
    list.push({ id: String(index), name, group: 'JOOX', hot: false, count: items.length })
  })
  if (list.length === 1) throw new Error('joox 歌单分类不存在')
  return { source: 'jx' as const, list }
}

/** 分类下歌单（上游 GetCategoryPlaylists） */
export const getCategoryPlaylists = async(categoryId = '', page = 1, limit = 20) => {
  const data = await fetchPlaylistCategoriesPage()
  const cid = String(categoryId ?? '').trim()
  let items: any[] = []
  let categoryName = '全部'

  if (!cid) {
    const seen = new Set<string>()
    for (const category of data.category) {
      for (const item of category?.itemlist ?? []) {
        const id = categoryPlaylistId(item?.id)
        if (!id || seen.has(id)) continue
        seen.add(id)
        items.push(item)
      }
    }
  } else {
    for (let index = 0; index < data.category.length; index++) {
      const category = data.category[index]
      const name = decodeJooxBase64Text(category?.title)
      if (String(index) === cid || (name && name.toLowerCase() === cid.toLowerCase())) {
        items = category?.itemlist ?? []
        categoryName = name
        break
      }
    }
    if (!items.length) throw new Error('joox 歌单分类不存在')
  }

  const start = Math.max(0, (page - 1) * limit)
  if (start >= items.length) throw new Error('joox 分类下无歌单')
  const pageItems = items.slice(start, start + limit)

  const list = pageItems
    .map(item => {
      const id = categoryPlaylistId(item?.id)
      const name = decodeJooxBase64Text(item?.title)
      if (!id || !name) return null
      return {
        id,
        name,
        cover: String(item?.picurl ?? '').replace('%d', '300') || null,
        trackCount: 0,
        creator: '',
        description: '',
        link: jooxPlaylistLink(id),
        categoryId: cid,
        categoryName,
        source: 'jx' as const,
      }
    })
    .filter(Boolean)
  if (!list.length) throw new Error('joox 分类下无歌单')

  return { list, total: items.length, page, limit, source: 'jx' as const }
}

/** 歌单链接解析（上游 ParsePlaylist） */
export const parsePlaylist = async(link: string) => {
  const patterns = [
    /joox\.com\/.*\/playlist\/([^/?#]+)/,
    /(?:playlistid|playlist_id|id)=([^&]+)/,
  ]
  for (const pattern of patterns) {
    const m = pattern.exec(String(link ?? ''))
    if (m) return getPlaylistDetail(m[1])
  }
  const raw = String(link ?? '').trim()
  if (raw.length > 8 && !raw.includes('/')) return getPlaylistDetail(raw)
  throw new Error('invalid joox playlist link')
}

export default {
  getPlaylistDetail,
  getPlaylistSongs,
  searchPlaylist,
  getCategories,
  getCategoryPlaylists,
  parsePlaylist,
}
