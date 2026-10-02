// 5sing 取流（上游 fivesing/download.go 的 GetDownloadURL + fivesing.go 的 fetchAudioLink 移植）
//
// 链路：GET http://mobileapi.5sing.kugou.com/song/getSongUrl?songid=<id>&songtype=<yc|fc|bz>
//   → { code: 1000, data: { squrl/squrl_backup, hqurl/hqurl_backup, lqurl/lqurl_backup, sqsize/hqsize/lqsize } }
//   直链为 CDN 明文地址（wsaudiobssdlbig.kugou.com，https，无需 Referer/防盗链签名；实测 Range 206 可播）。
// 说明：上游 fivesing 包内没有 base64/加密参数逻辑（不存在 _sign/song_id 签名），取流就是上述明文 GET；
//   数字 userId 的网页链接 302 的问题只影响歌单页，与取流无关。
// 档位：上游固定 sq（最高，常为无损/高码）→ hq → lq，返回首个非空（含 _backup）；
//   本移植默认沿用该顺序，只有显式请求 64k（或 type=lq）时才倒序优先 lq，返回实际命中档位。
// songmid 约定 "<songId>|<songType>"；Parse 出来的歌曲带 url 时直接复用（上游 GetDownloadURL: if s.URL != "" return）。

import { fetchAudioLink } from '../5sing/musicInfo.ts'
import { extractSongId, isForeignSource } from '../5sing/util.ts'

/** 上游只有 sq/hq/lq 三档，实际命中档位以返回 type 为准（sq 常缺，多命中 hq） */
export const supportQualitys = ['sq', 'hq', 'lq']

/** 上游 GetDownloadURL 的等价实现（非取消句柄版）：register 用于取消当前请求 */
export const getDownloadUrl = async(songInfo: any, type?: string, register?: (request: any) => void) => {
  if (isForeignSource(songInfo)) throw new Error('source mismatch')
  // 上游逻辑：Song.URL 已带直链（Parse 场景）直接复用
  if (songInfo?.url) {
    return { type: String(songInfo?.type || type || 'sq'), url: String(songInfo.url) }
  }
  const { songID, songType } = extractSongId(songInfo?.songmid ?? songInfo?.id ?? songInfo?.songid, songInfo?.songType)
  if (!songID || !songType) {
    throw new Error('invalid id structure: 5sing songmid 需为 "<songId>|<songType>"（songType 为 yc/fc/bz）')
  }
  const preferLow = type === '64k' || type === 'lq'
  return fetchAudioLink(songID, songType, register, preferLow)
}

/**
 * 统一取流接口：getMusicUrl(songInfo, type) → { promise, cancelHttp }
 * promise resolve → { type: 'sq'|'hq'|'lq', url }（type 为实际命中档位，可能低于请求档位）
 */
export const getMusicUrl = (songInfo: any, type?: string) => {
  const requestObj: { promise: any, cancelHttp: () => void } = { promise: null, cancelHttp() {} }
  let current: any = null
  requestObj.cancelHttp = () => {
    current?.cancelHttp?.()
    current = null
  }

  requestObj.promise = (async() => {
    const hit = await getDownloadUrl(songInfo, type, (request) => { current = request })
    return { type: hit.type, url: hit.url }
  })()

  return requestObj
}

export default { getMusicUrl, getDownloadUrl, supportQualitys }
