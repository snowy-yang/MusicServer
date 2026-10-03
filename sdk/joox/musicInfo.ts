// JOOX 歌曲详情 / 取流通道（openjoox2 v1，web 播放器同款签名接口）
// 端点：GET https://cache.api.joox.com/openjoox2/v1/track/<id>
//       ?country=hk&lang=zh_TW&lyric=1&fs=<0|1>&im=<0|1>[&uid=<wmid>][&usk=<session_key>]&secret=<md5>
// 签名：secret = md5('Jo0x@t3Nc3nT' + 'country=..&lang=..&lyric=1&fs=..&im=..[&uid=..][&usk=..]&id=..')
//   参数按插入序参与签名；id 用 '/' → '_' 替换后的值，且发布 URL 前会从 query 中删除 id。
//   该签名算法由官网 player-d JS bundle 逆向 + 实测比对（见 tmp/joox-test.mjs 断言）。
// 上游 Go 的 api.joox.com/web-fcgi-bin/web_get_songinfo 已于 2026-10 前 404，此文件为其替代。
// fs=1 请求完整曲目（游客仍可能拿到 preview/refrain），im=mobile 标记。
// 返回体含 play_url_list / refrain_url / lrc_content(base64) / qrc_content(base64) /
//   has_hq / has_hifi / vip_flag / node_is_preview 等。

import { httpFetch } from '../common/request.ts'
import {
  jooxHeaders,
  jooxSign,
  jooxLoginCookie,
  cookieValue,
  normalizeJooxID,
  normalizeJooxLang,
} from './util.ts'

export const JOOX_OPENJOOX2 = 'https://cache.api.joox.com/openjoox2/v1'

interface TrackOptions {
  country?: string
  lang?: string
  /** true 请求完整曲目（fs=1），false 预览（fs=0） */
  fullSong?: boolean
  isMobile?: boolean
}

/** 构造 openjoox2 歌曲详情 URL（含签名；登录态自动带 uid/usk） */
export const buildTrackUrl = (rawId: unknown, options: TrackOptions = {}): string => {
  const id = String(normalizeJooxID(rawId)).replace(/\//g, '_')
  const country = options.country || 'hk'
  const lang = normalizeJooxLang(options.lang || 'zh_TW')
  const params: Record<string, any> = {
    country,
    lang,
    lyric: 1,
    fs: options.fullSong ? 1 : 0,
    im: options.isMobile ? 1 : 0,
  }
  // 仅绑定登录凭据后才带 uid/usk（游客态与官网播放器一致，不带这两项）
  const loginCookie = jooxLoginCookie()
  const uid = loginCookie ? cookieValue(loginCookie, 'wmid') : ''
  const usk = loginCookie ? cookieValue(loginCookie, 'session_key') : ''
  if (uid) params.uid = uid
  if (usk) params.usk = usk
  // 签名时包含 id（与 web 播放器一致），发布 query 时再删除
  const secret = jooxSign({ ...params, id })
  const query = Object.entries({ ...params, secret })
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join('&')
  return `${JOOX_OPENJOOX2}/track/${id}?${query}`
}

/** 歌曲详情（openjoox2；上游 fetchSongInfo 的替代实现） */
export const getTrackDetail = async (rawId: unknown, options: TrackOptions = {}): Promise<any> => {
  const id = normalizeJooxID(rawId)
  if (!id) throw new Error('joox 歌曲 id 无效')
  const url = buildTrackUrl(id.replace(/\//g, '_'), options)
  const { statusCode, body } = await httpFetch(url, { headers: jooxHeaders(), timeout: 20000 }).promise as any
  if (statusCode != 200 || !body || typeof body !== 'object' || body.code) {
    const msg = body?.msg || body?.message || `HTTP ${statusCode}`
    throw new Error(`joox 歌曲详情获取失败：${msg}`)
  }
  return body
}

/** 从详情里挑选可播放地址：play_url_list 优先，refrain_url 兜底；并还原 &amp; 实体 */
export const pickTrackUrl = (detail: any): string => {
  const clean = (value: any) => String(value ?? '').replace(/&amp;/g, '&')
  const urls: any[] = Array.isArray(detail?.play_url_list) ? detail.play_url_list : []
  for (const url of urls) {
    const text = clean(url)
    if (text.startsWith('http')) return text
  }
  const refrain = clean(detail?.refrain_url)
  return refrain.startsWith('http') ? refrain : ''
}

export default { buildTrackUrl, getTrackDetail, pickTrackUrl }
