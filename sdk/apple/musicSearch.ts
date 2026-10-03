// Apple Music 搜索（上游 apple.go 的 Search / SearchAlbum / SearchPlaylist）
// 通道：amp-api /v1/catalog/<storefront>/search（Bearer developer token，见 util.ts）
// 单次请求上限 25 条，page/limit 用 offset 翻页；响应没有 total，
// 因此 total = 已翻过的条数 + 本页条数（下一页是否存在由 next 决定，allPage=页码+1）。
import {
  appleAmpGet,
  appleSongFromCatalog,
  appleAlbumToPlaylist,
  applePlaylistToPlaylist,
  getAppleConfig,
} from './util.ts'

/** amp-api search 单页硬上限 */
export const SEARCH_PAGE_MAX = 25

const catalogSearch = async(keyword: string, types: string, page: number, limit: number) => {
  const word = String(keyword ?? '').trim()
  const p = Math.max(1, Number(page) || 1)
  const l = Math.min(Math.max(1, Number(limit) || 20), 100)
  if (!word) return { body: null, page: p, limit: l }
  const cfg = getAppleConfig()
  const body: any = await appleAmpGet(`/v1/catalog/${cfg.storefront}/search`, {
    term: word,
    types,
    limit: Math.min(l, SEARCH_PAGE_MAX),
    offset: (p - 1) * l,
  })
  return { body, page: p, limit: l }
}

/** 上游 Search：搜索歌曲 */
export const search = async(keyword: string, page = 1, limit = 20) => {
  const { body, page: p, limit: l } = await catalogSearch(keyword, 'songs', page, limit)
  const bucket = body?.results?.songs ?? {}
  const list = (bucket.data ?? []).map((item: any) => appleSongFromCatalog(item))
  const hasNext = Boolean(bucket.next)
  return {
    list,
    allPage: hasNext ? p + 1 : p,
    total: (p - 1) * l + list.length,
    limit: l,
    source: 'ap' as const,
  }
}

/** 上游 SearchAlbum：搜索专辑（返回歌单摘要形状） */
export const searchAlbum = async(keyword: string, page = 1, limit = 20) => {
  const { body, page: p, limit: l } = await catalogSearch(keyword, 'albums', page, limit)
  const items = body?.results?.albums?.data ?? []
  const list = items.map((item: any) => appleAlbumToPlaylist(item))
  return {
    list,
    total: (p - 1) * l + list.length,
    page: p,
    limit: l,
    source: 'ap' as const,
  }
}

/** 上游 SearchPlaylist：搜索歌单 */
export const searchPlaylist = async(keyword: string, page = 1, limit = 20) => {
  const { body, page: p, limit: l } = await catalogSearch(keyword, 'playlists', page, limit)
  const items = body?.results?.playlists?.data ?? []
  const list = items.map((item: any) => applePlaylistToPlaylist(item))
  return {
    list,
    total: (p - 1) * l + list.length,
    page: p,
    limit: l,
    source: 'ap' as const,
  }
}

export default { search, searchAlbum, searchPlaylist }
