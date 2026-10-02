// 5sing 歌词（上游 fivesing/lyric.go 的 GetLyrics 移植）
// 接口: GET http://mobileapi.5sing.kugou.com/song/newget?songid=&songtype=
//   → data.dynamicWords 即 LRC 文本（实测为 "[00:31.76]..." 格式，逐字/滚动歌词同源）。
// 上游 ID 约定：model.Song.ID = "<songid>|<songtype>"，Extra.songid/songtype 优先；
//   本移植从 songmid 的 "|" 拆分（路由层只透传 songmid），也接受 songInfo.songType 字段。
// 统一接口约定：{ promise, cancelHttp }；promise resolve → { lyric, tlyric: '' }（5sing 无翻译歌词）。

import { isForeignSource, extractSongId } from './util.ts'
import { fetchDynamicLyric } from './musicInfo.ts'

/** 非取消句柄版（测试/内部用）：直接返回歌词文本 */
export const getLyricText = async(songID: string, songType: string): Promise<string> => {
  const lyric = await fetchDynamicLyric(songID, songType)
  if (!lyric) throw new Error('lyrics not found')
  return lyric
}

export const getLyric = (songInfo: any, ..._rest: any[]) => {
  const requestObj: { promise: any, cancelHttp: () => void } = { promise: null, cancelHttp() {} }
  let current: any = null
  requestObj.cancelHttp = () => {
    current?.cancelHttp?.()
    current = null
  }

  requestObj.promise = (async() => {
    if (isForeignSource(songInfo)) throw new Error('source mismatch')
    const { songID, songType } = extractSongId(songInfo?.songmid ?? songInfo?.id ?? songInfo?.songid, songInfo?.songType)
    if (!songID) throw new Error('invalid id')
    const lyric = await fetchDynamicLyric(songID, songType, (request) => { current = request })
    if (!lyric) throw new Error('lyrics not found')
    return { lyric, tlyric: '' }
  })()

  return requestObj
}

export default { getLyric, getLyricText }
