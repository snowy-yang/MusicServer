// Bilibili 搜索（上游 bilibili/song.go 的 `Search`）
// 接口: https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=&page=&page_size=
// 上游对每个搜索结果再调 x/web-interface/view 取首个分P的 cid/时长（B 站取流必须 cid），本移植保持一致，
// 只是把逐个串行改成了 4 并发；单条 view 失败按上游语义跳过该条。
// 实测（2026-10-02）：带 Referer/UA + 匿名（或登录）Cookie 可返回 code 0；风控时返回 -412/-352，会抛错由路由兜底。
import { apiGet, cleanTitle, fetchView, makeSong, mapLimit } from './util.ts'

const SEARCH_URL = 'https://api.bilibili.com/x/web-interface/search/type'

export const search = async(keyword: string, page = 1, limit = 20) => {
  const p = Math.max(1, Number(page) || 1)
  const l = Math.min(Math.max(1, Number(limit) || 20), 50)
  const url = `${SEARCH_URL}?search_type=video&keyword=${encodeURIComponent(keyword)}&page=${p}&page_size=${l}`
  const { statusCode, body } = await apiGet(url)
  if (statusCode !== 200 || !body || typeof body !== 'object') {
    throw new Error(`B站搜索失败（HTTP ${statusCode}）`)
  }
  if (body.code !== 0) {
    throw new Error(`B站搜索失败（${body.code}${body.message ? `: ${body.message}` : ''}）`)
  }

  const items: any[] = body.data?.result ?? []
  const songs = await mapLimit(items, 4, async(item: any) => {
    if (!item?.bvid) return null
    const view = await fetchView(item.bvid)
    const pages: any[] = view?.pages ?? []
    if (!pages.length) return null
    const first = pages[0]
    const rootTitle = cleanTitle(item.title)
    let displayTitle = first.part || ''
    if (!displayTitle) displayTitle = rootTitle
    else if (displayTitle !== rootTitle) displayTitle = `${rootTitle} - ${displayTitle}`
    return makeSong({
      bvid: item.bvid,
      cid: first.cid,
      name: displayTitle,
      artist: item.author || view?.owner?.name || '',
      album: item.bvid,
      duration: first.duration,
      cover: item.pic || view?.pic || '',
      page: 1,
    })
  })

  const list = songs.filter(Boolean)
  const total = Number(body.data?.numResults) || list.length
  const numPages = Number(body.data?.numPages) || 0
  return {
    list,
    allPage: numPages || p + (list.length >= l ? 1 : 0),
    total,
    limit: l,
    source: 'bili' as const,
  }
}

export default { search }
