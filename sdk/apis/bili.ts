// Bilibili 取流（上游 bilibili/bilibili.go 的 fetchAudioURL + account.go 的 IsVipAccount）
// 接口: https://api.bilibili.com/x/player/playurl?fnval=&qn=127&bvid=&cid=
//   fnval=80   标准 DASH（匿名可用）
//   fnval=4048 额外请求 FLAC/Hi-Res/Dolby（上游逻辑：大会员才用；实测匿名请求该参数也不报错，只是没有 flac 节点）
// 档位选择沿用上游优先级：Hi-Res FLAC(30251) → Dolby(30250) → DASH 标准最高档(30280/30232/30216) → durl 兜底；
// 仅当显式请求 64k 时优先 30216（上游无此参数意识，移植补的最小档位选择）。
// 302：httpFetch 不跟随重定向，这里用 `GET + Range: bytes=0-0` 手动跟跳最多 3 跳（HEAD 会被 CDN 404，不能用），
//      失败时回退原始地址，保证客户端仍能自行跟跳。
// 参考 Referer/UA 必须携带，否则 CDN 可能 403。

import { httpFetch } from '../common/request.ts'
import { biliHeaders, fetchView, getCookie, parseSongId } from '../bili/util.ts'

// 与 routes.ts 的 QUALITIES 枚举对齐（132k/192k 为 B 站实际档位，命中时按实际返回）
export const supportQualitys = ['64k', '128k', '320k', 'flac', 'flac24bit']

const QUALITY_LABEL: Record<number, string> = {
  30216: '64k',
  30232: '132k',
  30280: '192k',
  30250: 'flac',
  30251: 'flac24bit',
}

let vipCache: { value: boolean, at: number } | null = null

/** 登录态清空/更新后调用，丢弃大会员判断缓存 */
export const resetVipCache = () => {
  vipCache = null
}

/** 上游 IsVipAccount：x/web-interface/nav 的 isLogin + vipStatus + vipType（进程内缓存 5 分钟） */
export const isVipAccount = async(cookie: string): Promise<boolean> => {
  if (!cookie) return false
  if (vipCache && Date.now() - vipCache.at < 5 * 60 * 1000) return vipCache.value
  try {
    const { body } = await httpFetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: biliHeaders(cookie),
      timeout: 15000,
    }).promise as any
    const data = body?.data ?? {}
    const vip = body?.code === 0 && !!data.isLogin && Number(data.vipStatus) === 1 && Number(data.vipType) > 0
    vipCache = { value: vip, at: Date.now() }
    return vip
  } catch {
    return false
  }
}

const pickAudio = (data: any, type: string): { id: number, url: string, label: string } | null => {
  const dash = data?.dash ?? {}
  const flac = dash?.flac?.audio
  const hires = flac && Number(flac.id) === 30251 && flac.baseUrl ? { id: 30251, url: String(flac.baseUrl) } : null
  const dolby = (dash?.dolby?.audio ?? []).find((a: any) => Number(a?.id) === 30250 && a?.baseUrl)
  const standards: any[] = (dash?.audio ?? [])
    .filter((a: any) => a?.baseUrl)
    .sort((a: any, b: any) => Number(b.id) - Number(a.id))

  if (type === '64k') {
    const low = standards.find(a => Number(a.id) === 30216)
    if (low) return { id: 30216, url: String(low.baseUrl), label: QUALITY_LABEL[30216] }
  }

  // 上游优先级：Hi-Res FLAC → Dolby → 最高标准档
  if (hires) return { ...hires, label: QUALITY_LABEL[30251] }
  if (dolby) return { id: 30250, url: String(dolby.baseUrl), label: QUALITY_LABEL[30250] }
  if (standards.length) {
    const best = standards[0]
    return { id: Number(best.id), url: String(best.baseUrl), label: QUALITY_LABEL[Number(best.id)] ?? `audio-${best.id}` }
  }
  const durl = data?.durl?.[0]?.url
  if (durl) return { id: 0, url: String(durl), label: 'durl' }
  return null
}

/** 播放地址 API（上游 fetchAudioURL 的等价实现，返回 { type, url }；不做 CDN 跟跳） */
export const getAudioUrl = async(bvid: string, cid: string | number, type = '128k'): Promise<{ type: string, url: string }> => {
  const cookie = await getCookie()
  const needFlac = type === 'flac' || type === 'flac24bit'
  const vip = await isVipAccount(cookie)
  const fnval = needFlac || vip ? 4048 : 80
  const url = `https://api.bilibili.com/x/player/playurl?fnval=${fnval}&qn=127&bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(String(cid))}`
  const { statusCode, body } = await httpFetch(url, { headers: biliHeaders(cookie), timeout: 15000 }).promise as any
  if (statusCode !== 200 || !body || typeof body !== 'object') throw new Error(`B站取流失败（HTTP ${statusCode}）`)
  if (body.code !== 0) throw new Error(`B站取流失败（${body.code}${body.message ? `: ${body.message}` : ''}）`)
  const picked = pickAudio(body.data, type)
  if (!picked) throw new Error('B站未返回可用音频流')
  return { type: picked.label, url: picked.url }
}

/** 手动跟随 CDN 302（GET + Range 只读首字节；失败回退当前地址） */
const followRedirects = async(url: string, cookie: string, tracker?: { current: any }): Promise<string> => {
  let current = String(url)
  for (let hop = 0; hop < 3; hop++) {
    let response: any
    try {
      const request = httpFetch(current, {
        method: 'get',
        headers: { ...biliHeaders(cookie), Range: 'bytes=0-0' },
        timeout: 15000,
      })
      if (tracker) tracker.current = request
      response = await request.promise
    } catch {
      return current
    }
    const statusCode = Number(response?.statusCode) || 0
    const location = response?.headers?.location
    if (statusCode >= 300 && statusCode < 400 && location) {
      try {
        current = new URL(String(location), current).href
        continue
      } catch {
        return current
      }
    }
    return current
  }
  return current
}

/**
 * 统一取流接口：apis('bili').getMusicUrl(songInfo, type) → { promise, cancelHttp }
 * promise resolve → { type, url }（type 为实际命中档位，可能高于/低于请求档位）
 * songInfo.songmid 约定 `<bvid>|<cid>`；仅给 bvid 时回源 view 取首P cid。
 */
export const getMusicUrl = (songInfo: any, type: string) => {
  const tracker: { current: any } = { current: null }
  const requestObj: any = {
    cancelHttp() {
      try {
        tracker.current?.cancelHttp?.()
      } catch {
        // ignore
      }
    },
    promise: null as any,
  }

  requestObj.promise = (async() => {
    const { bvid, cid } = parseSongId(songInfo?.songmid ?? songInfo?.id)
    if (!bvid) throw new Error('bili songmid 需为 <bvid>|<cid> 格式')
    let realCid = cid
    if (!realCid) {
      const view = await fetchView(bvid)
      realCid = String(view?.pages?.[0]?.cid ?? '')
    }
    if (!realCid) throw new Error('B站未找到视频 cid（可能已失效）')
    const info = await getAudioUrl(bvid, realCid, type)
    const cookie = await getCookie()
    const finalUrl = await followRedirects(info.url, cookie, tracker)
    return { type: info.type, url: finalUrl }
  })()

  return requestObj
}

export default { getMusicUrl }
