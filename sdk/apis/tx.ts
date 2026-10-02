// QQ音乐 URL 获取（直连）
// 接口: https://u.y.qq.com/cgi-bin/musicu.fcg
// 方法: vkey.GetVkeyServer.CgiGetVkey
// 取流方案：
//   按请求音质组 filename 候选链一次请求（命中第一个有 purl 的档位即最高可用音质）；
//   始终附带 C400{songmid}.m4a 保底（匿名可取的 128k）。
//   档位前缀（社区资料 2026-10 核对）：RS01 Hi-Res FLAC > Q000/AI00 大师/臻品母带 FLAC >
//   F000 无损 FLAC > M800 320k MP3 > M500 128k MP3 > C400 128k AAC；
//   VIP 档 filename 用 media_mid（非 songmid）。
//   登录 cookie（uin + qm_keyst，见 /login/tx）可解锁 320k/无损/Hi-Res。
// 统一接口约定：apis('tx').getMusicUrl(songInfo, type) → { promise, cancelHttp }
// promise resolve → { type, url }（type 为实际命中的音质，可能低于请求值）

import { httpFetch } from '../common/request.ts'
import { getTxAuth } from '../auth/store.ts'

// 音质 → 候选档位链（[prefix, ext, 命中后展示的 type]，从高到低逐级回退）
const candidateMap: Record<string, Array<[string, string, string]>> = {
  '128k': [['M500', 'mp3', '128k']],
  '320k': [['M800', 'mp3', '320k'], ['M500', 'mp3', '128k']],
  flac: [['F000', 'flac', 'flac'], ['M800', 'mp3', '320k'], ['M500', 'mp3', '128k']],
  flac24bit: [
    ['RS01', 'flac', 'flac24bit'],
    ['Q000', 'flac', 'flac24bit'],
    ['AI00', 'flac', 'flac24bit'],
    ['F000', 'flac', 'flac'],
    ['M800', 'mp3', '320k'],
    ['M500', 'mp3', '128k'],
  ],
}
// 官方直连接口支持的音质（sdk/index.ts 汇总为 supportQuality）
export const supportQualitys = Object.keys(candidateMap)

export const getMusicUrl = (songInfo, type) => {
  const requestObj = { cancelHttp() {}, promise: null as any }
  const mediaMid = songInfo.strMediaMid || songInfo.songmid
  const entries: any[] = []
  for (const [prefix, ext, hitType] of candidateMap[type] || candidateMap['128k']) {
    entries.push({ filename: `${prefix}${mediaMid}.${ext}`, type: hitType })
  }
  entries.push({ filename: `C400${songInfo.songmid}.m4a`, type: '128k' })

  const auth = getTxAuth()
  const uin = auth?.uin || '0'
  const data = {
    comm: { ct: '19', cv: '1859', uin },
    req: {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param: {
        guid: '7342827269',
        songmid: [songInfo.songmid],
        filename: entries.map(e => e.filename),
        songtype: [0],
        uin,
        loginflag: 1,
        platform: '20',
        needNewCode: 1,
      },
    },
  }

  requestObj.promise = httpFetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'post',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0)',
      Referer: 'https://y.qq.com/',
      ...(auth ? { cookie: auth.cookie } : {}),
    },
    body: data,
    timeout: 15000,
  }).promise.then(({ statusCode, body }) => {
    if (statusCode != 200 || body.code != 0 || body.req?.code != 0) {
      return Promise.reject(new Error('获取失败'))
    }
    const data = body.req.data
    const sip = data.sip?.[0] || 'http://aqqmusic.tc.qq.com/'
    const infos = data.midurlinfo || []
    const idx = infos.findIndex(info => info.purl)
    if (idx >= 0) {
      return { type: entries[idx]?.type || '128k', url: `${sip}${infos[idx].purl}` }
    }
    // 全部受限（VIP 歌匿名）时回退试听地址（服务器返回的 128k m4a 试听文件）
    if (data.testfile2g) return { type: '128k', url: `${sip}${data.testfile2g}` }
    return Promise.reject(new Error('获取失败'))
  })
  return requestObj
}

export default { getMusicUrl }
