// JOOX 搜索（上游 joox/song.go Search 移植）
// 端点：GET https://cache.api.joox.com/openjoox/v3/search?country=sg&lang=zh_cn&keyword=<kw>
// 返回 section_list（0 歌曲 / 2 歌手 / 1 专辑 / 3 歌单 / 7 用户），歌曲在 item_list[].song[].song_info。
// 该接口无分页参数（上游也未分页），page 参数仅为统一契约保留；allPage 恒为 1。
// 实测（2026-10-02）：英文/中文关键词均 HTTP 200。

import { httpFetch } from '../common/request.ts'
import { jooxHeaders } from './util.ts'
import { jooxSongFromSearch } from './song.ts'

const SEARCH_URL = 'https://cache.api.joox.com/openjoox/v3/search'

export const search = async(keyword: string, _page = 1, limit = 20) => {
  const url = `${SEARCH_URL}?country=sg&lang=zh_cn&keyword=${encodeURIComponent(String(keyword ?? ''))}`
  const { statusCode, body } = await httpFetch(url, { headers: jooxHeaders(), timeout: 20000 }).promise as any
  if (statusCode != 200 || !body?.section_list) {
    return { list: [], allPage: 0, total: 0, limit, source: 'jx' as const }
  }

  const list: any[] = []
  const seen = new Set<string>()
  for (const section of body.section_list) {
    for (const item of section?.item_list ?? []) {
      for (const entry of item?.song ?? []) {
        const song = jooxSongFromSearch(entry?.song_info)
        if (!song || seen.has(song.songmid)) continue
        seen.add(song.songmid)
        list.push(song)
      }
    }
  }

  return {
    list: list.slice(0, limit),
    allPage: 1,
    total: list.length,
    limit,
    source: 'jx' as const,
  }
}

export default { search }
