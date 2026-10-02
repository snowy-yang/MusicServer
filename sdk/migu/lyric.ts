// 咪咕歌词 —— resourceinfo.do 取 lrcUrl/lyricUrl 再下载文本
// 上游对应：music-lib/migu/lyric.go
import { buildUrl, fetchSongDetail, miguGet, UserAgent } from './util.ts'
import { httpFetch } from '../request.ts'

const LRC_REFERER = 'https://y.migu.cn/'
const LRC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'

/** 从 songmid（contentId|resourceType|formatType）或 extra 取 contentId */
export const contentIdOf = (songInfo: any): string => {
  const extra = songInfo?.extra ?? {}
  if (extra.content_id) return String(extra.content_id)
  const id = String(songInfo?.songmid ?? songInfo?.id ?? '')
  return id.split('|')[0] ?? ''
}

export const getLyric = (songInfo: any) => {
  const requestObj = { cancelHttp() {}, promise: null as any }
  const contentID = contentIdOf(songInfo)
  requestObj.promise = (async() => {
    if (!contentID) throw new Error('migu 歌曲 id 无效')
    const body = await miguGet(buildUrl('http://c.musicapp.migu.cn/MIGUM2.0/v1.0/content/resourceinfo.do', {
      resourceId: contentID,
      resourceType: '2',
    }))
    const resource = body?.resource ?? []
    if (!resource.length) throw new Error('migu 歌词资源不存在')
    let lrcUrl = String(resource[0]?.lrcUrl ?? '') || String(resource[0]?.lyricUrl ?? '')
    if (!lrcUrl) return { lyric: '', tlyric: '' }
    lrcUrl = lrcUrl.replace(/^http:\/\//, 'https://')
    const { statusCode, body: lrc } = await httpFetch(lrcUrl, {
      headers: { 'User-Agent': LRC_UA, Referer: LRC_REFERER },
      timeout: 20000,
    }).promise
    if (statusCode !== 200) throw new Error(`migu 歌词下载失败 ${statusCode}`)
    return { lyric: typeof lrc === 'string' ? lrc : '', tlyric: '' }
  })()
  return requestObj
}

export { fetchSongDetail }
export default { getLyric }
