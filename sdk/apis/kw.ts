// 酷我音乐 URL 获取（直连）
// 统一接口约定：apis('kw').getMusicUrl(songInfo, type) → { promise, cancelHttp }
// promise resolve → { type, url }（type 为实际拿到的音质，请求档位缺失时沿降级链回退）
//
// 取流通道（按优先级）：
//   1) http://mobi.kuwo.cn/mobi.s convert_url_with_sign（主通道）
//      source=kwplayer_ar_8.5.5.0_apk_keluze.apk 指纹 + user=0 匿名即可。
//      2026-10-01 实测（含整段 MPEG 帧逐帧校验，非仅看开头）：
//      - 付费/VIP 歌匿名放行真音频：晴天(rid 228908) 拿到 2000k flac 52.83MB（269.7s，fLaC
//        STREAMINFO 校验）与 320k mp3 10.29MB（10329 帧全程 320kbps/44100Hz 对齐），
//        均与搜索接口 N_MINFO 元数据的官方大小逐字节吻合；
//      - hi-res 也可用：起风了(rid 82239887) br=4000kflac → 88.2kHz flac 109.12MB；
//      - 请求档位不存在时会静默降级（2000kflac→48k aac、4000kflac→128k mp3）甚至升级到
//        mgg/mflac 加密格式，因此必须严格校验「返回 bitrate == 请求档位 且 格式为明文音频」，
//        不匹配视为未命中、沿降级链换档重试；
//      - 此前「mobi.s 吐 11 秒蜜罐假 MP3」的结论仅适用于其它 type/source 参数组合，
//        本组合已验证为真音频。
//   2) www.kuwo.cn/api/v1/www/music/playUrl（回退通道，web 端官方接口，需 Secret 签名头）
//      签名：GET https://www.kuwo.cn/ 首页拿动态 cookie（Hm_Iuvt_*，名字与值均随机下发），
//      以「cookie 值为消息、cookie 名为密钥」跑异或哈希得 Secret 头（酷我 web 端算法，
//      参考 qyhqiu/kuwoMusicApi 的 secret.js）。token 会话级缓存，失效自动刷新重试一次。
//      限制：服务器无视 br 参数，匿名恒返回 128k MP3；VIP 歌明确报「该歌曲为付费内容」，
//      不吐假音频（作为 mobi 通道网络故障时的兜底）。
//   - 写死 token（含旧 kw_token cookie）必报 "The request is illegal!"，token 必须动态获取。

import { randomUUID } from 'crypto'
import { httpFetch } from '../common/request.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const MOBI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/537.36'

// 音质 → mobi.s 请求档位（bitrate 为响应必须精确命中的数值）
const qualityTiers: Record<string, { br: string, bitrate: number }> = {
  '128k': { br: '128kmp3', bitrate: 128 },
  '320k': { br: '320kmp3', bitrate: 320 },
  'flac': { br: '2000kflac', bitrate: 2000 },
  'flac24bit': { br: '4000kflac', bitrate: 4000 },
}

// 档位缺失时的降级链（请求档位 → 逐级尝试）
const fallbackChain: Record<string, string[]> = {
  'flac24bit': ['flac', '320k', '128k'],
  'flac': ['320k', '128k'],
  '320k': ['128k'],
  '128k': [],
}

// 明文音频格式白名单；mgg/mflac/mmp4/zp 等为加密格式，拿到也不能播
const plainFormats = new Set(['mp3', 'flac', 'ogg', 'aac', 'm4a'])

// 匿名通道实际可用音质（sdk/index.ts 汇总为 supportQuality）
export const supportQualitys = ['128k', '320k', 'flac', 'flac24bit']

/**
 * mobi.s convert_url_with_sign 取流
 * 未命中（无 url / bitrate 不匹配 / 加密格式）resolve null，由调用方沿降级链换档
 */
const getUrlByMobi = (songmid: string, tier: { br: string, bitrate: number }): Promise<{ url: string } | null> => {
  const requestObj = httpFetch(`http://mobi.kuwo.cn/mobi.s?f=web&user=0&source=kwplayer_ar_8.5.5.0_apk_keluze.apk&type=convert_url_with_sign&br=${tier.br}&rid=${songmid}`, {
    method: 'get',
    headers: {
      'User-Agent': MOBI_UA,
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    timeout: 15000,
  })
  return requestObj.promise.then(({ statusCode, body }) => {
    const data = body?.data
    if (statusCode != 200 || !data?.url) return null
    if (Number(data.bitrate) != tier.bitrate || !plainFormats.has(String(data.format))) return null
    return { url: data.url }
  }).catch(() => null)
}

interface KwToken { name: string, value: string, secret: string }

let token: KwToken | null = null
let tokenPromise: Promise<KwToken> | null = null

/**
 * 酷我 web 端 Secret 头哈希：t 为消息（cookie 值），e 为密钥（cookie 名）
 */
const kwSecret = (t: string, e: string): string => {
  let digits = ''
  for (let i = 0; i < e.length; i++) digits += e.charCodeAt(i).toString()
  const r = Math.floor(digits.length / 5)
  const o = parseInt(digits.charAt(r) + digits.charAt(2 * r) + digits.charAt(3 * r) + digits.charAt(4 * r) + digits.charAt(5 * r))
  const l = Math.ceil(e.length / 2)
  const c = 2 ** 31 - 1
  if (o < 2) throw new Error('酷我 Secret 哈希失败')
  let d = Math.round(1e9 * Math.random()) % 1e8
  digits += d
  while (digits.length > 10) digits = (parseInt(digits.substring(0, 10)) + parseInt(digits.substring(10, digits.length))).toString()
  let n = (o * parseInt(digits) + l) % c
  let out = ''
  for (let i = 0; i < t.length; i++) {
    const x = t.charCodeAt(i) ^ Math.floor(n / c * 255)
    out += x < 16 ? `0${x.toString(16)}` : x.toString(16)
    n = (o * n + l) % c
  }
  let hex = d.toString(16)
  while (hex.length < 8) hex = `0${hex}`
  return out + hex
}

/**
 * 获取会话 token（访问首页，解析动态下发的 Hm_Iuvt_* cookie 名与值）
 */
const getToken = (retryNum = 0): Promise<KwToken> => {
  if (token) return Promise.resolve(token)
  if (tokenPromise) return tokenPromise
  tokenPromise = httpFetch('https://www.kuwo.cn/', {
    method: 'get',
    headers: { 'User-Agent': UA },
    timeout: 15000,
  }).promise.then(({ headers }) => {
    tokenPromise = null
    const cookies = ((headers['set-cookie'] as string[]) || []).map(c => {
      const i = c.indexOf('=')
      return { name: c.slice(0, i).trim(), value: i >= 0 ? c.slice(i + 1).split(';')[0] : '' }
    }).filter(c => /^Hm_Iuvt_\w+$/.test(c.name) && c.value)
    if (!cookies.length) throw new Error('获取酷我token失败')
    token = { name: cookies[0].name, value: cookies[0].value, secret: kwSecret(cookies[0].value, cookies[0].name) }
    return token
  }).catch(err => {
    tokenPromise = null
    if (retryNum > 2) throw err
    return getToken(++retryNum)
  })
  return tokenPromise
}

/**
 * 通过官方 playUrl 接口获取（需 Secret 签名；匿名恒 128k）
 * @param t 本次请求使用的 token（显式传入，避免与并发刷新竞态）
 */
const getUrlByPlayUrl = (songmid: string, t: KwToken, retryNum = 0) => {
  const requestObj = { cancelHttp() {}, promise: null as any }
  requestObj.promise = httpFetch(`https://www.kuwo.cn/api/v1/www/music/playUrl?mid=${songmid}&type=music&httpsStatus=1&plat=web_www&from=&br=128kmp3&reqId=${randomUUID()}`, {
    method: 'get',
    headers: {
      Cookie: `${t.name}=${t.value}`,
      Secret: t.secret,
      Referer: 'https://www.kuwo.cn/',
      'User-Agent': UA,
    },
    timeout: 15000,
  }).promise.then(({ statusCode, body }) => {
    const msg: string = body?.msg || body?.message || ''
    if (statusCode != 200 || !body?.success || !body.data?.url) {
      // 签名/token 失效：刷新后重试一次（VIP 拒绝等其他错误不重试）
      if (retryNum == 0 && /illegal/i.test(msg)) {
        token = null
        return getToken().then(fresh => getUrlByPlayUrl(songmid, fresh, ++retryNum).promise)
      }
      return Promise.reject(new Error(msg || '获取失败'))
    }
    // 服务器无视 br，匿名实际只回 128k，如实上报
    return { type: '128k', url: body.data.url }
  })
  return requestObj
}

export const getMusicUrl = (songInfo, type) => {
  const requestObj = { cancelHttp() {}, promise: null as any }
  const start = qualityTiers[type] ? type : '128k'
  const chain = [start, ...fallbackChain[start]]
  // 逐档尝试 mobi 通道，全未命中再回退 web playUrl（匿名 128k；VIP 歌会被明确拒绝）
  requestObj.promise = chain.reduce(
    (p, tierType) => p.then(res => res ?? getUrlByMobi(songInfo.songmid, qualityTiers[tierType]).then(hit => hit && { type: tierType, url: hit.url })),
    Promise.resolve(null as any),
  ).then(res => res ?? getToken().then(t => getUrlByPlayUrl(songInfo.songmid, t).promise))
  return requestObj
}

export default { getMusicUrl }
