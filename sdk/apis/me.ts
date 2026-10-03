// 猫耳FM URL 获取（App API 通道）
// 链路：HMAC-SHA256(appsecret) 签名 → app.missevan.com/sound/sound → 免签名明文直链
//   soundurl/soundurl_64 = 原文件（码率视源，常见 192k AAC）
//   soundurl_128 = 128k m4a；soundurl_32 = 192k 变体（字段命名与实际码率错位，以实测为准）
// 实测（2026-10-02）匿名可取免费声音，直链首字节 ftyp M4A 明文可播；
// 付费声音需 /login/me 绑定含 token 的 cookie 后由服务端携带
// songmid 约定：裸 id = 声音 id（声音搜索/剧集列表产出）；
//   "d:<drama_id>" = 广播剧（剧搜索产出）——取流时自动选剧的首个免费集（预告/第一集）
// 统一接口约定：apis('me').getMusicUrl(songInfo, type) → { promise, cancelHttp }
// promise resolve → { type, url }（type 为实际命中档位，可能低于请求值）

import { getSoundInfo } from '../me/musicInfo.ts'

// 音质 → 字段优先级（原文件可能高于 128k，128k 档固定 m4a）
const QUALITY_FIELDS: Record<string, string[]> = {
  '128k': ['soundurl_128', 'soundurl', 'soundurl_64', 'soundurl_32'],
  '64k': ['soundurl_64', 'soundurl', 'soundurl_128', 'soundurl_32'],
}
export const supportQualitys = ['64k', '128k']

const pickUrl = (info: any, type: string) => {
  const fields = QUALITY_FIELDS[type] ?? QUALITY_FIELDS['128k']
  let url = ''
  for (const field of fields) {
    const v = info?.[field]
    if (v && String(v).startsWith('http')) { url = String(v); break }
  }
  if (!url) throw new Error('无可用音频资源（付费内容需 POST /login/me 绑定 token）')
  const hit128 = url.includes('-128k') || type === '128k'
  return { type: hit128 ? '128k' : '64k', url }
}

/** 剧条目 "d:<drama_id>" → 首个免费集的 sound_id（getdrama episodes.episode[]） */
const resolveDramaFirstFree = async(dramaId: string): Promise<string> => {
  const { httpFetch } = await import('../common/request.ts')
  const { statusCode, body } = await httpFetch(`https://www.missevan.com/dramaapi/getdrama?drama_id=${dramaId}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      Accept: 'application/json',
      Referer: `https://www.missevan.com/mdrama/${dramaId}`,
    },
    timeout: 15000,
  }).promise as any
  const episodes = (statusCode == 200 ? body?.info?.episodes?.episode : null) ?? []
  if (!episodes.length) throw new Error('剧集列表为空或已下线')
  const first = episodes.find((e: any) => Number(e.pay_type) === 0) ?? episodes[0]
  return String(first.sound_id)
}

export const getMusicUrl = (songInfo, type) => {
  const requestObj = { cancelHttp() {}, promise: null as any }
  const songmid = String(songInfo.songmid ?? '')

  requestObj.promise = (async() => {
    let soundId = songmid
    if (songmid.startsWith('d:')) {
      if (!/^\d+$/.test(songmid.slice(2))) throw new Error('剧 id 无效')
      soundId = await resolveDramaFirstFree(songmid.slice(2))
    } else if (!/^\d+$/.test(soundId)) {
      throw new Error('me id 需为声音 id 或 d:<剧id>（见 /search?source=me 与 /album/me）')
    }
    const info = await getSoundInfo(soundId)
    return pickUrl(info, type)
  })()
  return requestObj
}

export default { getMusicUrl }
