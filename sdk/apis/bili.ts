// Bilibili 取流（上游 bilibili/bilibili.go 的 fetchAudioURL + account.go 的 IsVipAccount）
// 接口: https://api.bilibili.com/x/player/playurl?fnval=&qn=127&bvid=&cid=
//   fnval=80   标准 DASH（匿名可用）
//   fnval=4048 额外请求 FLAC/Hi-Res/Dolby（上游逻辑：大会员才用；实测匿名请求该参数也不报错，只是没有 flac 节点）
// 档位选择沿用上游优先级：Hi-Res FLAC(30251) → Dolby(30250) → DASH 标准最高档(30280/30232/30216) → durl 兜底；
// 仅当显式请求 64k 时优先 30216（上游无此参数意识，移植补的最小档位选择）。
//
// CDN 选址（2026-10-04 实测定稿）：playurl 的 baseUrl 大概率落在 PCDN——京东云无线宝 mcdn.bilivideo.cn:8082、
// 迅雷 edge.mountaintoys.cn:4483、节点之家 szbdyd.com、派欧云 nexusedgeio.com——单节点、丢包严重，是点歌卡死的根源；
// 正规 CDN 为 upos-*.bilivideo.com（腾讯/金山/白山/华为）与 upos-*.akamaized.net（Akamai，境外），
// cn-*.bilivideo.com 是 B站自建/地区 CDN（同省同运营商单节点，无稳定性问题）。
// 因此候选集 = 命中档位节点的 baseUrl + backupUrl，按 host 分级排序（upos/akamaized > bilivideo.com 系 > PCDN），
// 逐个探测、命中即返回；全部失败时回退分级后的最优候选，客户端仍可自行跟跳。
// 参考 Referer/UA 必须携带，否则 CDN 可能 403；CDN 直链自带签名参数，不带也不应带 Cookie（避免登录态泄给第三方 PCDN 域名）。

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

// CDN 探测预算：单跳最长 8s，全部候选合计不超过 20s（超时即回退最优候选，不再无限等）
const PROBE_HOP_TIMEOUT = 8000
const PROBE_TOTAL_BUDGET = 20000
const PROBE_MAX_CANDIDATES = 3

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

/** CDN host 分级：0=正规 CDN（upos-*.bilivideo.com / upos-*.akamaized.net，多地节点）
 *  1=B站系（cn-* 自建地区 CDN 及其它 bilivideo.com） 2=PCDN（mcdn.bilivideo.cn、mountaintoys、szbdyd 等第三方） */
const hostRank = (url: string): number => {
  let host = ''
  try { host = new URL(url).hostname.toLowerCase() } catch { return 2 }
  if (host.endsWith('.akamaized.net')) return 0
  if (host.endsWith('.bilivideo.com')) return host.startsWith('upos-') ? 0 : 1
  return 2
}

/** 节点地址收集：baseUrl + backupUrl（去重） */
const nodeUrls = (node: any): string[] => {
  const backups = [
    ...(Array.isArray(node?.backupUrl) ? node.backupUrl : []),
    ...(Array.isArray(node?.backup_url) ? node.backup_url : []),
  ]
  return [node?.baseUrl, ...backups].filter(Boolean).map(String)
}

/** 候选排序：host 分级升序，同级保持原始顺序（baseUrl 官方序优先） */
const rankCandidates = (urls: string[]): string[] => {
  const seen = new Set<string>()
  const uniq: string[] = []
  for (const url of urls) {
    const u = String(url || '')
    if (!u || seen.has(u)) continue
    seen.add(u)
    uniq.push(u)
  }
  return uniq
    .map((u, i) => ({ u, i, rank: hostRank(u) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map(x => x.u)
}

const pickAudio = (data: any, type: string): { id: number, label: string, urls: string[] } | null => {
  const dash = data?.dash ?? {}
  const flac = dash?.flac?.audio
  const hires = flac && Number(flac.id) === 30251 && flac.baseUrl ? flac : null
  const dolby = (dash?.dolby?.audio ?? []).find((a: any) => Number(a?.id) === 30250 && a?.baseUrl)
  const standards: any[] = (dash?.audio ?? [])
    .filter((a: any) => a?.baseUrl)
    .sort((a: any, b: any) => Number(b.id) - Number(a.id))

  let node: any = null
  let label = ''
  if (type === '64k') {
    const low = standards.find(a => Number(a.id) === 30216)
    if (low) { node = low; label = QUALITY_LABEL[30216] }
  }
  // 上游优先级：Hi-Res FLAC → Dolby → 最高标准档
  if (!node && hires) { node = hires; label = QUALITY_LABEL[30251] }
  if (!node && dolby) { node = dolby; label = QUALITY_LABEL[30250] }
  if (!node && standards.length) {
    node = standards[0]
    label = QUALITY_LABEL[Number(standards[0].id)] ?? `audio-${standards[0].id}`
  }
  if (node) return { id: Number(node.id) || 0, label, urls: rankCandidates(nodeUrls(node)) }

  const durlNode = data?.durl?.[0]
  if (durlNode?.url) return { id: 0, label: 'durl', urls: rankCandidates(nodeUrls(durlNode)) }
  return null
}

/** 播放地址 API（上游 fetchAudioURL 的等价实现，返回 { type, urls }；urls 已按 CDN 分级排序，[0] 为最优） */
export const getAudioUrl = async(bvid: string, cid: string | number, type = '128k'): Promise<{ type: string, urls: string[] }> => {
  const cookie = await getCookie()
  const needFlac = type === 'flac' || type === 'flac24bit'
  const vip = await isVipAccount(cookie)
  const fnval = needFlac || vip ? 4048 : 80
  const url = `https://api.bilibili.com/x/player/playurl?fnval=${fnval}&qn=127&bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(String(cid))}`
  const { statusCode, body } = await httpFetch(url, { headers: biliHeaders(cookie), timeout: 15000 }).promise as any
  if (statusCode !== 200 || !body || typeof body !== 'object') throw new Error(`B站取流失败（HTTP ${statusCode}）`)
  if (body.code !== 0) throw new Error(`B站取流失败（${body.code}${body.message ? `: ${body.message}` : ''}）`)
  const picked = pickAudio(body.data, type)
  if (!picked || !picked.urls.length) throw new Error('B站未返回可用音频流')
  return { type: picked.label, urls: picked.urls }
}

/**
 * 探测单个候选并跟随 302：GET + Range: bytes=0-0，读到响应头即断开 body。
 * HEAD 会被 CDN 404 不能用；也不能等 body 自然结束——CDN 忽略 Range 返回 200 全量时，
 * 会把整个音频文件下载缓冲完才返回（点歌就卡死在这）。
 * 命中 2xx/206 返回该地址；4xx/5xx/超时/网络错误抛错，由调用方换下一候选。
 */
const resolveUrl = async(url: string, tracker: { current: any, cancelled?: boolean }, deadline: number): Promise<string> => {
  let current = String(url)
  for (let hop = 0; hop < 3; hop++) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('CDN 探测超时（总预算耗尽）')
    const controller = new AbortController()
    tracker.current = controller
    const timer = setTimeout(() => controller.abort(new Error('CDN 探测超时')), Math.min(PROBE_HOP_TIMEOUT, remaining))
    timer.unref?.()
    let resp: Response
    try {
      resp = await fetch(current, {
        method: 'get',
        headers: { ...biliHeaders(), Range: 'bytes=0-0' },
        redirect: 'manual',
        signal: controller.signal,
      })
    } catch (err: any) {
      if (tracker.cancelled) { err.canceled = true; throw err }
      throw err
    } finally {
      clearTimeout(timer)
    }
    // 拿到响应头即断开，不消费 body
    await resp.body?.cancel().catch(() => {})
    const status = resp.status
    const location = resp.headers.get('location')
    if (status >= 300 && status < 400 && location) {
      try {
        current = new URL(location, current).href
        continue
      } catch {
        return current
      }
    }
    if (status >= 200 && status < 300) return current
    if (status >= 400) throw new Error(`CDN 返回 HTTP ${status}`)
    return current
  }
  return current
}

/**
 * 统一取流接口：apis('bili').getMusicUrl(songInfo, type) → { promise, cancelHttp }
 * promise resolve → { type, url }（type 为实际命中档位，可能高于/低于请求档位）
 * songInfo.songmid 约定 `<bvid>|<cid>`；仅给 bvid 时回源 view 取首P cid。
 * CDN 候选按 host 分级探测（upos/cn 正规源优先），全败回退最优候选（fail-soft，客户端可自行跟跳）。
 */
export const getMusicUrl = (songInfo: any, type: string) => {
  const tracker: { current: any, cancelled?: boolean } = { current: null }
  const requestObj: any = {
    cancelHttp() {
      tracker.cancelled = true
      try {
        tracker.current?.abort?.(new Error('Canceled'))
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

    const deadline = Date.now() + PROBE_TOTAL_BUDGET
    for (const candidate of info.urls.slice(0, PROBE_MAX_CANDIDATES)) {
      try {
        const finalUrl = await resolveUrl(candidate, tracker, deadline)
        return { type: info.type, url: finalUrl }
      } catch (err: any) {
        if (err?.canceled || tracker.cancelled) throw new Error('canceled')
        if (Date.now() >= deadline) break
      }
    }
    // 探测全败（或预算耗尽）：回退分级排序后的最优候选
    return { type: info.type, url: info.urls[0] }
  })()

  return requestObj
}

export default { getMusicUrl }
