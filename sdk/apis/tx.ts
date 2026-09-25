// QQ音乐 URL 获取（直连）
// 接口: https://u.y.qq.com/cgi-bin/musicu.fcg
// 方法: vkey.GetVkeyServer.CgiGetVkey
// 取流方案：
//   按请求音质组 filename 链一次请求（M500{media_mid}.mp3 / M800{media_mid}.mp3 / F000{media_mid}.flac），
//   响应 midurlinfo 与 filename 一一对应，取第一个有 purl 的（即最高可用音质）；
//   始终附带 C400{songmid}.m4a 保底（匿名可取的 128k）。
//   登录 cookie（uin + qm_keyst，见 /login/tx）可解锁 320k/无损。
// 统一接口约定：apis('tx').getMusicUrl(songInfo, type) → { promise, cancelHttp }
// promise resolve → { type, url }（type 为实际命中的音质，可能低于请求值）

import { httpFetch } from '../common/request.ts'
import { getTxAuth } from '../auth/store.ts'

// 音质 → [文件前缀, 扩展名]（flac24bit 暂走 flac 通道，命中即返回）
const prefixMap = {
  '128k': ['M500', 'mp3'],
  '320k': ['M800', 'mp3'],
  flac: ['F000', 'flac'],
  flac24bit: ['F000', 'flac'],
}
// 降级链：高音质无版权/VIP 受限时逐级回退
const chainMap = {
  '128k': ['128k'],
  '320k': ['320k', '128k'],
  flac: ['flac', '320k', '128k'],
  flac24bit: ['flac', '320k', '128k'],
}

export const getMusicUrl = (songInfo, type) => {
  const requestObj = { cancelHttp() {}, promise: null as any }
  const mediaMid = songInfo.strMediaMid || songInfo.songmid
  const entries: any[] = []
  for (const t of chainMap[type] || chainMap['128k']) {
    const [prefix, ext] = prefixMap[t]
    entries.push({ filename: `${prefix}${mediaMid}.${ext}`, type: t })
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
