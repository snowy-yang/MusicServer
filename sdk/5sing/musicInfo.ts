// 5sing 歌曲信息 / 取流底层（上游 fivesing/fivesing.go 的 fetchSongInfo / fetchAudioLink 移植）
//
// 链路（实测 2026-10-02 全部可用，无需签名/base64 参数——上游 fivesing 包内没有 _sign/base64 逻辑，
// 仅 playlist 搜索的封面等是 CDN 地址；取流为明文 URL 直出）：
//   取流:  GET {MOBILE_API}/song/getSongUrl?songid=&songtype=  → data.{sq,hq,lq}url(_backup)，code 必须 1000
//   详情:  GET {MOBILE_API}/song/newget?songid=&songtype=      → data.SN / data.user.NN / data.user.I / data.dynamicWords
// 档位字段：squrl（无损/高码）→ hqurl（高）→ lqurl（低），每档有 _backup 备用地址（上游 getFirstValid 取首个非空）。
// 上游固定 sq→hq→lq；本移植按请求档位微调（请求 64k/lq 时倒序），返回实际命中档位。

import { MOBILE_API, fetch5singJson, getFirstValid, kindName, estimateDuration, buildSongLink } from './util.ts'

export type AudioHit = { type: string, url: string }

const QUALITY_TIERS: Array<'sq' | 'hq' | 'lq'> = ['sq', 'hq', 'lq']

/** data 里某档位的可用地址（主地址 → backup，上游 getFirstValid 语义） */
const tierUrl = (data: any, tier: string): string =>
  getFirstValid(data?.[`${tier}url`], data?.[`${tier}url_backup`])

/**
 * 上游 fetchAudioLink：仅获取音频链接。
 * register 用于把当前 httpFetch 对象交给调用方（cancelHttp）。
 * preferLow：请求 64k/lq 时从低档位开始找（上游无该意识，移植补的最小档位选择，默认仍 sq 最高）。
 */
export const fetchAudioLink = async(
  songID: string,
  songType: string,
  register?: (request: any) => void,
  preferLow = false,
): Promise<AudioHit> => {
  const url = `${MOBILE_API}/song/getSongUrl?songid=${encodeURIComponent(songID)}&songtype=${encodeURIComponent(songType)}`
  const { statusCode, body } = await fetch5singJson(url, { register })
  if (statusCode != 200 || !body || typeof body !== 'object') {
    throw new Error(`5sing 取流失败（HTTP ${statusCode}）`)
  }
  if (Number(body.code) !== 1000) {
    // 实测 songtype 缺失/错误时 code=28 message=歌曲不存在
    throw new Error(body.message ? `5sing 取流失败（${body.message}）` : 'api returned error code')
  }
  const data = body.data ?? {}
  const order = preferLow ? [...QUALITY_TIERS].reverse() : QUALITY_TIERS
  for (const tier of order) {
    const hit = tierUrl(data, tier)
    if (hit && /^https?:\/\//i.test(hit)) return { type: tier, url: hit }
  }
  throw new Error('no valid download url found')
}

/** 上游 fetchSongInfo / GetLyrics 使用的 newget 详情（返回 data 对象） */
export const fetchNewGet = async(
  songID: string,
  songType: string,
  register?: (request: any) => void,
): Promise<any> => {
  const url = `${MOBILE_API}/song/newget?songid=${encodeURIComponent(songID)}&songtype=${encodeURIComponent(songType)}`
  const { statusCode, body } = await fetch5singJson(url, { register })
  if (statusCode != 200 || !body || typeof body !== 'object') {
    throw new Error(`5sing 歌曲信息获取失败（HTTP ${statusCode}）`)
  }
  return body.data ?? {}
}

/** 上游 newget 歌词：data.dynamicWords（LRC 文本） */
export const fetchDynamicLyric = async(
  songID: string,
  songType: string,
  register?: (request: any) => void,
): Promise<string> => {
  const data = await fetchNewGet(songID, songType, register)
  return String(data?.dynamicWords ?? '')
}

/**
 * 上游 fetchSongInfo：音频直链 + newget 元数据 → 统一 Song 形状。
 * 取流失败即抛错（与上游 Parse 链路一致）；newget 失败时保留兜底名 5sing_<type>_<id>。
 */
export const fetchSongInfo = async(songID: string, songType: string, register?: (request: any) => void) => {
  const hit = await fetchAudioLink(songID, songType, register)

  let name = ''
  let artist = ''
  let cover = ''
  try {
    const data = await fetchNewGet(songID, songType, register)
    name = String(data?.SN ?? '')
    artist = String(data?.user?.NN ?? '')
    cover = String(data?.user?.I ?? '')
  } catch {
    // 上游 newget 失败时继续（metaBody 为 nil 不阻断）
  }
  if (!name) name = `5sing_${songType}_${songID}`

  return {
    songmid: `${songID}|${songType}`,
    name,
    singer: artist,
    albumId: '',
    albumName: '',
    interval: 0,
    img: cover || null,
    lrc: null,
    types: [],
    _types: {},
    url: hit.url,
    type: hit.type,
    link: buildSongLink(songType, songID),
    songType,
    typeName: kindName(songType),
    source: '5s' as const,
  }
}

/** 时长估算的对外小工具（搜索结果用；上游 Search 的 Duration 公式） */
export const songInterval = (songSize: number): number => estimateDuration(songSize)
