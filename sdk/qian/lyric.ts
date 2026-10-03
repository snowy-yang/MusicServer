// 千千音乐歌词
// 链路：/v1/song/info → data[0].lyric 为歌词文本 URL（static-qianqian.taihe.com/*.txt）→ 直接下载文本。
// 返回 { lyric, tlyric: '' }（千千只有原文歌词，无翻译）。
import { httpFetch } from '../common/request.ts'
import { getSongInfo } from './musicInfo.ts'
import { requestHeaders } from './util.ts'

export const getLyric = (songInfo: any) => {
  const requestObj: any = { promise: null, cancelHttp() {} }
  const tsid = String(songInfo?.songmid ?? songInfo?.TSID ?? '').trim()
  let lyricReq: any = null

  requestObj.cancelHttp = () => {
    lyricReq?.cancelHttp?.()
    lyricReq = null
  }

  requestObj.promise = (async() => {
    if (!tsid) throw new Error('千千歌词需要 songmid（TSID）')
    const info = await getSongInfo(tsid)
    const lyricUrl = info?.lyricUrl
    if (!lyricUrl) throw new Error('千千该歌曲暂无歌词')

    lyricReq = httpFetch(lyricUrl, { headers: requestHeaders(), timeout: 15000 })
    const { statusCode, body, raw } = await lyricReq.promise as any
    if (statusCode != 200) throw new Error(`千千歌词下载失败（HTTP ${statusCode}）`)
    const lyric = typeof body === 'string' ? body : raw?.toString('utf8') ?? ''
    return { lyric, tlyric: '' }
  })()

  return requestObj
}

export default { getLyric }
