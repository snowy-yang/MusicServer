// 千千音乐单曲信息（/v1/song/info）
// 接口返回 data[]：title/albumTitle/albumAssetCode/pic/duration/artist/lyric（歌词文本 URL）
import { APP_ID, apiGet, apiOk, mapTrack } from './util.ts'

/** 由 TSID 取单曲信息（归一为 Song 形状，并附 lyricUrl） */
export const getSongInfo = async(tsid: string) => {
  const id = String(tsid ?? '').trim()
  if (!id) throw new Error('千千歌曲 id（TSID）为空')
  const body = await apiGet('/v1/song/info', { TSID: id, appid: APP_ID })
  if (!apiOk(body) && !Array.isArray(body?.data)) {
    throw new Error(body?.errmsg || `千千歌曲信息获取失败（errno ${body?.errno}）`)
  }
  const item = Array.isArray(body?.data) ? body.data[0] : null
  if (!item) throw new Error('千千歌曲不存在或已下架')

  const song = mapTrack(item)
  return {
    ...song,
    // 以入参 id 兜底（song/info 的 TSID 字段缺失时仍可继续取流/歌词）
    songmid: song.songmid || id,
    lyricUrl: String(item?.lyric ?? '').trim(),
    raw: item,
  }
}

export default { getSongInfo }
