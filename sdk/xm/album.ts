// 喜马拉雅专辑曲目列表（免签匿名接口）
// 接口: https://www.ximalaya.com/revision/album/getTracksList?albumId=&pageNum=&sort=0
// 实测（2026-10-02）匿名可翻全部页（固定每页 30 条）；仅曲目元信息（trackId/title/isPaid），
// 播放地址需另走 baseInfo。注意 v1 版接口（/revision/album/v1/getTracksList）需要 webtk 签名且有风控。
import { httpFetch } from '../common/request.ts'
import { XM_UA } from './sign.ts'

const TRACKS_URL = 'https://www.ximalaya.com/revision/album/getTracksList'
const PAGE_SIZE = 30

/** 抓取专辑第 pageNum 页曲目（返回 { total, tracks }） */
export const getTracksPage = async(albumId: string, pageNum: number) => {
  const { statusCode, body } = await httpFetch(`${TRACKS_URL}?albumId=${albumId}&pageNum=${pageNum}&sort=0`, {
    headers: { 'User-Agent': XM_UA, Referer: `https://www.ximalaya.com/album/${albumId}` },
    timeout: 15000,
  }).promise as any
  if (statusCode != 200 || body?.ret != 200 || !body?.data) {
    throw new Error(body?.msg || `获取专辑曲目失败（ret ${body?.ret ?? statusCode}）`)
  }
  return {
    total: Number(body.data.trackTotalCount ?? 0),
    tracks: body.data.tracks ?? [],
  }
}

/** 专辑详情 + 指定页曲目（/album 路由适配：{ info, list }，接口固定每页 30 条） */
export const getAlbumDetail = async(albumId: string, page = 1, limit = 30) => {
  const { total, tracks } = await getTracksPage(albumId, page)
  let albumName = ''
  const list = tracks.slice(0, limit).map((item: any) => {
    if (!albumName && item.albumTitle) albumName = String(item.albumTitle)
    return {
      songmid: String(item.trackId),
      name: item.title || String(item.trackId),
      singer: item.albumTitle || '',
      albumId: String(albumId),
      albumName: item.albumTitle || '',
      interval: 0,
      payPlay: Boolean(item.isPaid),
      img: null,
      lrc: '',
      lrcx: '',
      types: [],
      _types: {},
      disabled: false,
    }
  })
  return {
    info: { name: albumName || String(albumId), total },
    list,
    total,
    limit,
    allPage: Math.ceil(total / PAGE_SIZE) || page,
    source: 'xm',
  }
}

export default { getTracksPage, getAlbumDetail }
