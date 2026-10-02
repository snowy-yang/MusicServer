// 喜马拉雅 URL 获取（PC 桌面端 baseInfo 通道）
// 链路：makeXmSign(hdaa 上报) → baseInfo device=win(带 PC 设备 Cookie) → playUrlList
//   → decodeWinUrl(AES-ECB, 客户端 4.0.14 asar 密钥) → a.xmcdn.com 带签名直链
// 实测（2026-10-02）匿名免费曲目 HTTP 200 audio/mp4 可播；付费/VIP 曲 ret=1001（需登录，暂未接）
// 档位命名如 M4A_64/MP3_64/M4A_24/MP3_32/AAC_24（音乐内容另有 MP3_128/M4A_128）；
// 喜马拉雅以有声内容为主，码率低于音乐平台，音质映射到 '64k'/'128k' 桶
// 统一接口约定：apis('xm').getMusicUrl(songInfo, type) → { promise, cancelHttp }
// promise resolve → { type, url }（type 为实际命中档位，可能低于请求值）

import { getTrackInfo } from '../xm/musicInfo.ts'
import { decodeWinUrl } from '../xm/decoder.ts'

// 优先 M4A（同码率体积更小），128 档优先 MP3_128
const QUALITY_PREFERENCE: Record<string, string[]> = {
  '128k': ['MP3_128', 'M4A_128', 'M4A_64', 'MP3_64', 'M4A_24', 'MP3_32', 'AAC_24'],
  '64k': ['M4A_64', 'MP3_64', 'M4A_24', 'MP3_32', 'AAC_24'],
}
export const supportQualitys = ['64k', '128k']

const bitrateOf = (type: string): number => Number(/(\d+)/.exec(type)?.[1] ?? 0) || 0
const bucketOf = (bitrate: number): string => (bitrate >= 128 ? '128k' : '64k')

export const getMusicUrl = (songInfo, type) => {
  const requestObj = { cancelHttp() {}, promise: null as any }
  const trackId = String(songInfo.songmid ?? '')

  requestObj.promise = (async() => {
    const trackInfo = await getTrackInfo(trackId)
    const playList: any[] = trackInfo.playUrlList ?? []
    if (!playList.length) throw new Error('无可用播放资源（付费/版权内容需登录）')

    const preference = QUALITY_PREFERENCE[type] ?? QUALITY_PREFERENCE['128k']
    let picked: { type: string, url: string } | null = null
    for (const want of preference) {
      const hit = playList.find(item => item?.type === want && item.url)
      if (hit) {
        picked = { type: hit.type, url: hit.url.startsWith('http') ? hit.url : decodeWinUrl(hit.url) }
        break
      }
    }
    if (!picked) {
      // 兜底：未知档位命名时取码率最高的一条
      const best = [...playList].filter(item => item?.url).sort((a, b) => bitrateOf(b.type) - bitrateOf(a.type))[0]
      if (!best) throw new Error('无可用播放资源')
      picked = { type: best.type, url: best.url.startsWith('http') ? best.url : decodeWinUrl(best.url) }
    }
    return { type: bucketOf(bitrateOf(picked.type)), url: picked.url }
  })()
  return requestObj
}

export default { getMusicUrl }
