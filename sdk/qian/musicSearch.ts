// 千千音乐搜索（/v1/search?word=&type=1&pageNo=&pageSize=，appid + 签名）
// 响应 data.typeTrack[]：TSID/title/albumTitle/albumAssetCode/pic/duration/artist/rateFileInfo/isVip
// 注：上游会跳过 isVip != 0 的曲目（VIP 无法匿名取流）；本实现保留并标记 payPlay，
// 以便聚合搜索/顺播时仍能展示（取流失败会返回明确错误，路由可走兜底链路）。
import { APP_ID, apiGet, apiOk, mapTrack } from './util.ts'

export const search = async(keyword: string, page = 1, limit = 20) => {
  const word = String(keyword ?? '').trim()
  const empty = { list: [] as any[], allPage: 1, total: 0, limit, source: 'qian' as const }
  if (!word) return empty

  const body = await apiGet('/v1/search', {
    word,
    type: '1',
    pageNo: String(page),
    pageSize: String(limit),
    appid: APP_ID,
  })
  if (!apiOk(body) && Number(body?.errno) !== 23001) {
    throw new Error(body?.errmsg || `千千搜索失败（errno ${body?.errno}）`)
  }
  const tracks = Array.isArray(body?.data?.typeTrack) ? body.data.typeTrack : []
  const total = Number(body?.data?.total) || tracks.length
  const haveMore = Number(body?.data?.haveMore) === 1

  return {
    list: tracks.map((item: any) => mapTrack(item)).filter((song: any) => song.songmid),
    allPage: haveMore ? page + 1 : Math.max(page, Math.ceil(total / Math.max(1, limit)) || 1),
    total,
    limit,
    source: 'qian' as const,
  }
}

export default { search }
