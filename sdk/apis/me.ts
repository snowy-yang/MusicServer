// 猫耳FM URL 获取（App API 通道）
// 链路：HMAC-SHA256(appsecret) 签名 → app.missevan.com/sound/sound → 免签名明文直链
//   soundurl/soundurl_64 = 原文件（码率视源，常见 192k AAC）
//   soundurl_128 = 128k m4a；soundurl_32 = 192k 变体（字段命名与实际码率错位，以实测为准）
// 实测（2026-10-02）匿名可取免费声音，直链首字节 ftyp M4A 明文可播；
// 付费声音需 /login/me 绑定含 token 的 cookie 后由服务端携带
// 统一接口约定：apis('me').getMusicUrl(songInfo, type) → { promise, cancelHttp }
// promise resolve → { type, url }（type 为实际命中档位，可能低于请求值）

import { getSoundInfo } from '../me/musicInfo.ts'

// 音质 → 字段优先级（原文件可能高于 128k，128k 档固定 m4a）
const QUALITY_FIELDS: Record<string, string[]> = {
  '128k': ['soundurl_128', 'soundurl', 'soundurl_64', 'soundurl_32'],
  '64k': ['soundurl_64', 'soundurl', 'soundurl_128', 'soundurl_32'],
}
export const supportQualitys = ['64k', '128k']

export const getMusicUrl = (songInfo, type) => {
  const requestObj = { cancelHttp() {}, promise: null as any }
  const soundId = String(songInfo.songmid ?? '')

  requestObj.promise = (async() => {
    const info = await getSoundInfo(soundId)
    const fields = QUALITY_FIELDS[type] ?? QUALITY_FIELDS['128k']
    let url = ''
    for (const field of fields) {
      const v = info?.[field]
      if (v && String(v).startsWith('http')) { url = String(v); break }
    }
    if (!url) throw new Error('无可用音频资源（付费内容需 POST /login/me 绑定 token）')
    // -128k 变体归 128k 桶，原文件按 64k 桶展示（原始码率不固定，多为 192k）
    const hit128 = url.includes('-128k') || type === '128k'
    return { type: hit128 ? '128k' : '64k', url }
  })()
  return requestObj
}

export default { getMusicUrl }
