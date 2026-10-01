// 酷狗音乐 URL 获取（手机客户端通道）
// 接口: https://gateway.kugou.com/v5/url（x-router: trackercdn.kugou.com，android 签名）
// 登录后自动携带 token/userid（见 /login/kg）；匿名仅能获取部分免费资源，
// VIP/受限资源会返回 status:2。quality: 128k→128, 320k→320, flac→flac, flac24bit→high
// 成功响应（status:1）播放地址在顶层 url: string[] 与 backupUrl: string[]（2026-10 实测；
// 旧 data:[{url}] 结构仅作兼容兜底）。album_audio_id 传 NaN 会被网关拒答，必须归零。
// 统一接口约定：apis('kg').getMusicUrl(songInfo, type) → { promise, cancelHttp }
// promise resolve → { type, url }

import crypto from 'node:crypto'
import { httpFetch } from '../common/request.ts'
import { getKgAuth } from '../auth/store.ts'
import { androidSign, getDevice } from '../auth/kg.ts'

const md5 = s => crypto.createHash('md5').update(s).digest('hex')
const SALT_KEY = '57ae12eb6890223e355ccfcb74edf70d'
const APPID = 1005
const CLIENTVER = 11430

const num = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

const qualityMap = { '128k': '128', '320k': '320', flac: 'flac', flac24bit: 'high' }

// 官方直连接口支持的音质（sdk/index.ts 汇总为 supportQuality）
export const supportQualitys = Object.keys(qualityMap)

export const getMusicUrl = (songInfo, type) => {
  const requestObj = { cancelHttp() {}, promise: null as any }
  const hash = (songInfo._types?.[type]?.hash || songInfo.hash || '').toLowerCase()
  if (!hash) {
    requestObj.promise = Promise.reject(new Error('缺少 hash'))
    return requestObj
  }

  requestObj.cancelHttp = () => {} // 单次 GET，无需取消

  requestObj.promise = (async() => {
    const dev = getDevice()
    const auth = getKgAuth()
    const userid = Number(auth?.userid || 0)

    const params: Record<string, any> = {
      dfid: dev.dfid, mid: dev.mid, uuid: '-', appid: APPID, clientver: CLIENTVER,
      clienttime: Math.floor(Date.now() / 1000),
      album_id: num(songInfo.albumId),
      area_code: 1,
      hash,
      ssa_flag: 'is_fromtrack',
      version: CLIENTVER,
      page_id: 151369488,
      quality: qualityMap[type] ?? '128',
      album_audio_id: num(songInfo.songmid),
      behavior: 'play',
      pid: 2,
      cmd: 26,
      pidversion: 3001,
      IsFreePart: 0,
      ppage_id: '463467626,350369493,788954147',
      cdnBackup: 1,
      module: '',
    }
    if (auth) {
      params.token = auth.token
      params.userid = userid
    }
    params.key = md5(`${hash}${SALT_KEY}${APPID}${dev.mid}${userid}`)
    params.signature = androidSign(params)

    const qs = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&')
    const r = await httpFetch(`https://gateway.kugou.com/v5/url?${qs}`, {
      method: 'get',
      headers: {
        dfid: dev.dfid, mid: dev.mid, clienttime: String(params.clienttime),
        'kg-rc': '1', 'kg-thash': '5d816a0', 'kg-rec': '1', 'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
        'x-router': 'trackercdn.kugou.com',
        'User-Agent': 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi',
      },
      timeout: 15000,
    }).promise

    const body = r.body && typeof r.body === 'object' ? r.body : {}
    if (body.status !== 1) {
      throw new Error(body.error || (auth ? `获取失败（status ${body.status ?? '未知'}）` : '获取失败（该资源需要酷狗登录）'))
    }
    let url = ''
    if (Array.isArray(body.url)) url = body.url[0] || ''
    else if (Array.isArray(body.backupUrl)) url = body.backupUrl[0] || ''
    else if (Array.isArray(body.data)) {
      // 旧版 data:[{url, fallback}] 结构兜底
      const item = body.data.find(d => d.url) ?? body.data[0]
      url = item?.url || item?.fallback || ''
    }
    if (!url) throw new Error('获取失败（网关未返回播放地址）')
    return { type, url }
  })()
  return requestObj
}

export default { getMusicUrl }
