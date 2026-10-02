// 蜻蜓FM 搜索（官网 SSR 频道结果页解析）
// 接口: https://www.qingting.fm/search/channel_ondemand/<keyword>（302 → www.qtfm.cn，见 http.ts）
// 实测（2026-10-02）SSR 渲染且与关键词强相关；?keyword= 混合页的结果区为客户端渲染
// （服务端只吐热门推荐），JSON 搜索端点（webapi/webbff/searchapi）均 404——本页是唯一匿名搜索通道
import { ssrGet } from './http.ts'

export const search = async(keyword: string, page = 1, limit = 20) => {
  const { statusCode, html } = await ssrGet(`https://www.qingting.fm/search/channel_ondemand/${encodeURIComponent(keyword)}?page=${page}`)
  if (statusCode != 200) throw new Error(`搜索失败（HTTP ${statusCode}）`)
  // 结果项：href=/channels/<id> … <span title="<名称>">，封面在随后的 img src
  const items = [...html.matchAll(/href="\/channels\/(\d+)"[\s\S]{0,400}?<span title="([^"]*)">/g)]
  const list = items.map(m => {
    const after = html.slice(m.index ?? 0, (m.index ?? 0) + 700)
    const img = after.match(/<img src="(http[^"]+)"/)?.[1]
    return {
      songmid: m[1],
      name: m[2],
      singer: '',
      albumId: '',
      albumName: '',
      interval: 0,
      img: img ? img.replace('http://', 'https://') : null,
      lrc: '',
      lrcx: '',
      types: [],
      _types: {},
      disabled: false,
    }
  }).filter((item): item is NonNullable<typeof item> => Boolean(item.name)).slice(0, limit)
  return {
    allPage: page + (list.length >= 10 ? 1 : 0),
    total: list.length,
    limit,
    source: 'qt' as const,
    list,
  }
}

export default { search }
