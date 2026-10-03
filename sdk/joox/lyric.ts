// JOOX 歌词（上游 joox/lyric.go 移植）
// 端点：GET https://api.joox.com/web-fcgi-bin/web_lyric?musicid=<id>&country=sg&lang=zh_cn
//   响应形如 MusicJsonCallback({"code":0,"lyric":"<base64>"})，lyric 为 base64 UTF-8 歌词。
//   实测（2026-10-02）该旧接口仍可用（web_get_songinfo 已 404，但 web_lyric 未下线）。
// 兜底：openjoox2 /track 详情的 lrc_content（同为 base64），旧接口失败时使用。
// 解码：base64 → UTF-8 → HTML 实体（&amp; 等）→ { lyric, tlyric: '' }
// 统一接口约定：{ promise, cancelHttp }；promise resolve → { lyric, tlyric }

import { httpFetch } from '../common/request.ts'
import { jooxHeaders, decodeJooxLyric, normalizeJooxID, firstNonEmpty } from './util.ts'
import { buildTrackUrl } from './musicInfo.ts'

export const LEGACY_LYRIC_URL = 'https://api.joox.com/web-fcgi-bin/web_lyric'

/** 解析 MusicJsonCallback(...) / 裸 JSON 包裹 */
export const parseLyricPayload = (body: any): any => {
  if (body && typeof body === 'object') return body
  let text = String(body ?? '')
  const idx = text.indexOf('MusicJsonCallback(')
  if (idx >= 0) {
    text = text.slice(idx + 'MusicJsonCallback('.length)
    text = text.replace(/\)\s*;?\s*$/, '')
  }
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** 上游 GetLyrics 的纯逻辑部分：web_lyric 响应体 → 歌词文本 */
export const parseLegacyLyric = (statusCode: number, body: any): string => {
  if (statusCode != 200) throw new Error(`joox 歌词获取失败（HTTP ${statusCode}）`)
  const payload = parseLyricPayload(body)
  if (!payload) throw new Error('joox 歌词解析失败')
  const raw = String(firstNonEmpty(payload.lyric, ''))
  if (Number(payload.code ?? 0) !== 0 || !raw) throw new Error('joox 歌词不存在或为空')
  return decodeJooxLyric(raw)
}

/** 上游 GetLyrics 通道（非取消句柄版，测试/内部用） */
export const getLegacyLyric = async(songId: string): Promise<string> => {
  const url = `${LEGACY_LYRIC_URL}?musicid=${encodeURIComponent(songId)}&country=sg&lang=zh_cn`
  const { statusCode, body } = await httpFetch(url, { headers: jooxHeaders(), timeout: 20000 }).promise as any
  return parseLegacyLyric(statusCode, body)
}

export const getLyric = (songInfo: any, ..._rest: any[]) => {
  const requestObj: { promise: any, cancelHttp: () => void } = { promise: null, cancelHttp() {} }
  let current: any = null
  requestObj.cancelHttp = () => {
    if (current?.cancelHttp) current.cancelHttp()
  }

  const songId = normalizeJooxID(songInfo?.songmid ?? songInfo?.id ?? songInfo?.songid ?? '')

  requestObj.promise = (async() => {
    if (!songId) throw new Error('joox 歌曲 id 无效')

    // 1) 上游 web_lyric 通道
    let legacyErr: any = null
    try {
      current = httpFetch(
        `${LEGACY_LYRIC_URL}?musicid=${encodeURIComponent(songId)}&country=sg&lang=zh_cn`,
        { headers: jooxHeaders(), timeout: 20000 },
      )
      const { statusCode, body } = await current.promise
      return { lyric: parseLegacyLyric(statusCode, body), tlyric: '' }
    } catch (err) {
      legacyErr = err
    }

    // 2) 兜底：openjoox2 详情 lrc_content（base64）
    current = httpFetch(buildTrackUrl(songId), { headers: jooxHeaders(), timeout: 20000 })
    const { statusCode, body } = await current.promise as any
    const raw = String(firstNonEmpty(body?.lrc_content, ''))
    if (statusCode != 200 || !raw) throw legacyErr ?? new Error('joox 歌词不存在或为空')
    return { lyric: decodeJooxLyric(raw), tlyric: '' }
  })()

  return requestObj
}

export default { getLyric, getLegacyLyric, parseLyricPayload, parseLegacyLyric }
