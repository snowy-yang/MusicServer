// Apple Music 歌词（上游 apple.go GetLyrics）
// 通道：amp-api /v1/catalog/<sf>/songs/<id>?include=lyrics&extend=extendedAssetUrls
//   → data[0].relationships.lyrics.data[*].attributes.ttml
// 上游取到的是 TTML（Apple 逐字歌词格式，非 LRC），原样放入 lyric 字段返回；没有则忠实返回空串。
// 注意（2026-10 实测）：匿名 developer token 请求时 Apple 不返回 lyrics relationship
//   （即使 attributes.hasLyrics=true，歌单/搜索接口也一样），歌词接口需要 media-user-token（订阅态）才能拿到；
//   本实现保持上游行为：拿不到就返回 { lyric: '', tlyric: '' }，不抛错。
// 统一接口约定：{ promise, cancelHttp }；promise resolve → { lyric, tlyric }
import { appleAmpGetTracked, extractAppleID, getAppleConfig } from './util.ts'

export const getLyric = (songInfo: any, ..._rest: any[]) => {
  const requestObj: { promise: any, cancelHttp: () => void } = { promise: null, cancelHttp() {} }
  const tracker = { current: null as any }
  requestObj.cancelHttp = () => {
    try {
      tracker.current?.cancelHttp?.()
    } catch {
      // ignore
    }
    tracker.current = null
  }

  const songId = extractAppleID(String(songInfo?.songmid ?? songInfo?.id ?? ''), 'song')

  requestObj.promise = (async() => {
    if (!songId) throw new Error('apple 歌曲 id 无效')
    const cfg = getAppleConfig()
    const body: any = await appleAmpGetTracked(
      `/v1/catalog/${cfg.storefront}/songs/${songId}`,
      { include: 'lyrics', extend: 'extendedAssetUrls' },
      tracker,
    )
    const lyrics = body?.data?.[0]?.relationships?.lyrics?.data ?? []
    for (const rel of lyrics) {
      const text = String(rel?.attributes?.ttml ?? '')
      if (text) return { lyric: text, tlyric: '' }
    }
    return { lyric: '', tlyric: '' }
  })()

  return requestObj
}

/** 非取消句柄版：直接返回歌词文本（内部/测试用） */
export const getLyricsText = async(songId: string): Promise<string> => {
  const result = await getLyric({ songmid: songId }).promise
  return result?.lyric || ''
}

export default { getLyric }
