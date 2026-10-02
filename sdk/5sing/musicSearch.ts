// 5sing 歌曲搜索（上游 fivesing/song.go 的 Search 移植）
// 接口: GET http://search.5sing.kugou.com/home/json?keyword=&sort=1&page=&filter=0&type=0
//   返回 { list: [...], type, pageInfo: { cur, totalCount, totalPages } }，每页 10 条（服务端固定）。
// 内容种类：typeEname = yc(原创) / fc(翻唱) / bz(伴奏)，中文名在 typeName；上游以 typeEname 入 ID/Extra，
//   本移植把它作为统一种类字段 songType 暴露（songmid 约定仍为 "<songId>|<typeEname>"）。
// 上游 Search() 无 page 参数（硬编码 page=1）；本移植按契约透传 page（实测 page 参数有效，pageInfo 可用于翻页）。
// 时长：上游用 songSize 估算（songSize*8/320000 秒）；实测多数条目 songSize=0 → interval 返回 0。

import { formatPlayTime } from '../common/utils.ts'
import { SEARCH_API, fetch5singJson, removeEmTags, unescapeHtml, buildSongLink, estimateDuration, kindName } from './util.ts'

/** 上游 Search 的 list 项 → 统一 Song 形状（source 统一 '5sing'） */
export const mapSearchSong = (item: any) => {
  const songType = String(item?.typeEname ?? '')
  const duration = estimateDuration(Number(item?.songSize) || 0)
  return {
    songmid: `${item?.songId ?? ''}|${songType}`,
    name: removeEmTags(unescapeHtml(item?.songName)),
    singer: removeEmTags(unescapeHtml(item?.singer ?? item?.nickName)),
    albumId: '',
    albumName: '',
    interval: duration > 0 ? formatPlayTime(duration) : 0,
    img: null,
    lrc: null,
    types: [],
    _types: {},
    // 统一种类字段（上游 typeEname / typeName）
    songType,
    typeName: String(item?.typeName ?? kindName(songType)),
    size: Number(item?.songSize) || 0,
    link: buildSongLink(songType, item?.songId),
    source: '5sing' as const,
  }
}

export const search = async(keyword: string, page = 1, limit = 20) => {
  const word = String(keyword ?? '').trim()
  const pageNo = Math.max(1, Number(page) || 1)
  const pageSize = Math.max(1, Number(limit) || 20)
  const empty = { list: [] as any[], allPage: 0, total: 0, limit: pageSize, source: '5sing' as const }
  if (!word) return empty

  const url = `${SEARCH_API}?keyword=${encodeURIComponent(word)}&sort=1&page=${pageNo}&filter=0&type=0`
  const { statusCode, body } = await fetch5singJson(url)
  if (statusCode != 200) throw new Error(`5sing 搜索失败（HTTP ${statusCode}）`)

  const rawList: any[] = Array.isArray(body?.list) ? body.list : []
  const list = rawList.slice(0, pageSize).map(mapSearchSong)
  const pageInfo = body?.pageInfo ?? {}
  const total = Number(pageInfo.totalCount) || list.length
  // 服务端每页 10 条（固定），allPage 直接用 pageInfo.totalPages
  const allPage = Number(pageInfo.totalPages) || (list.length >= pageSize ? pageNo + 1 : pageNo)
  return { list, allPage, total, limit: pageSize, source: '5sing' as const }
}

export default { search }
