// 千千音乐 URL 获取（/v1/song/tracklink，签名通道）
// 档位：3000=flac / 320 / 128 / 64(aac)。实测（2026-10-02）：
//   - 免费曲目（搜索 isVip=0，如 SSR Beats 特辑）各档位均返回明文直链 data.path（audio0x.dmhmusic.com，CDN 签名 URL）
//   - VIP/版权曲目返回 200/errno 22000 但 data 无 path、无 trail_audio_info，需登录态带会员 cookie 才可能有直链
// 契约：getMusicUrl(songInfo, type) → { promise, cancelHttp }，promise resolve { type, url }（type 为实际命中档位）
import { apiOk, firstNonEmpty, trackLink } from '../bd/util.ts'

// 请求档位 → tracklink rate 尝试链（优先请求档，逐级降级；与上游 3000→320→128→64 的探测顺序一致）
const QUALITY_RATES: Record<string, string[]> = {
  '64k': ['64'],
  '128k': ['128', '64'],
  '320k': ['320', '128', '64'],
  'flac': ['3000', '320', '128', '64'],
  'flac24bit': ['3000', '320', '128', '64'],
}
const DEFAULT_RATES = ['3000', '320', '128', '64']

export const supportQualitys = ['64k', '128k', '320k', 'flac']

/** 命中档位判定：以响应 format/rate/bits 为准（可能低于请求档位） */
const typeOfHit = (requestRate: string, data: any): string => {
  const format = String(data?.format ?? '').toLowerCase()
  const rate = Number(data?.rate ?? 0)
  const bits = Number(data?.bits ?? 0)
  if (format === 'flac' || rate >= 1000) return bits === 24 ? 'flac24bit' : 'flac'
  if (rate >= 320 || requestRate === '320') return '320k'
  if (rate >= 128 || requestRate === '128') return '128k'
  return '64k'
}

/** 逐档请求 tracklink，取首个带 path 的档位；register 用于取流对象取消当前请求 */
export const getDownloadUrl = async(tsid: string, type?: string, register?: (req: any) => void) => {
  const id = String(tsid ?? '').trim()
  if (!id) throw new Error('千千歌曲 id（TSID）为空')
  const rates = QUALITY_RATES[String(type ?? '')] ?? DEFAULT_RATES

  let lastErr: any = null
  for (const rate of rates) {
    try {
      const body = await trackLink(id, rate, register)
      if (!apiOk(body)) {
        lastErr = new Error(body?.errmsg || `千千取流失败（errno ${body?.errno}）`)
        continue
      }
      const data = body?.data ?? {}
      const url = firstNonEmpty(data?.path, data?.trail_audio_info?.path)
      if (url) return { type: typeOfHit(rate, data), url }
      lastErr = new Error('千千该歌曲无可用直链（VIP/版权曲目需登录态，免费曲目可直接取流）')
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr ?? new Error('千千未找到可用音频直链')
}

export const getMusicUrl = (songInfo: any, type?: string) => {
  const requestObj: any = { promise: null, cancelHttp() {} }
  let current: any = null
  requestObj.cancelHttp = () => {
    current?.cancelHttp?.()
    current = null
  }
  requestObj.promise = (async() => {
    // 上游 GetDownloadURL：Song.URL 已有直链时直接复用（Parse 场景）
    if (songInfo?.url) return { type: type || '128k', url: String(songInfo.url) }
    const tsid = firstNonEmpty(songInfo?.songmid, songInfo?.TSID)
    if (!tsid) throw new Error('千千歌曲 id（TSID）为空')
    return getDownloadUrl(tsid, type, (req) => { current = req })
  })()
  return requestObj
}

export default { getMusicUrl, getDownloadUrl, supportQualitys }
