// 喜马拉雅曲目信息（PC 桌面端 baseInfo 通道）
// 接口: https://www.ximalaya.com/mobile-playpage/track/v3/baseInfo/{ms_ts}?device=win&trackId=&trackQualityLevel=1
// 实测（2026-10-02）匿名免费曲目可用，但必须同时满足：
//   1) 携带 PC 设备 Cookie（install_id 与 1&_device 同一 uuid，channel=99&100001，客户端 4.0.14 抓包格式）
//   2) 携带 du_web_sdk 真实 xm-sign（hdaa 上报取 cadd/sid）
//   缺 Cookie 或换 device=www2 均返回 ret=1001 系统繁忙。
// 响应 trackInfo 顶层挂载（playUrlList/title/cover*/duration/isPaid/isAuthorized/isXimiUhqTrack），
// playUrlList[].url 为 AES-ECB 加密地址（key 取自官方客户端 4.0.14 asar），见 decoder.ts
import crypto from 'node:crypto'
import { httpFetch } from '../request.ts'
import { makeXmSign, XM_UA } from './sign.ts'
import { getCredentials } from '../auth/store.ts'

const BASE_INFO_URL = 'https://www.ximalaya.com/mobile-playpage/track/v3/baseInfo/'

// 进程级设备标识（install_id 与 1&_device 共用同一 uuid，稳定复用）
const deviceUuid = crypto.randomUUID()
const PC_DEVICE_COOKIE = `install_id=${deviceUuid}; channel=99&100001; 1&_device=win32&${deviceUuid}&4.0.14`

/** 登录态 Cookie（/login/xm 绑定，须含 1&_token）；与 PC 设备 Cookie 合并后上送 */
export const buildRequestCookie = (): string => {
  const loginCookie = (getCredentials('xm') as any)?.cookie || ''
  return loginCookie ? `${loginCookie}; ${PC_DEVICE_COOKIE}` : PC_DEVICE_COOKIE
}

export const coverUrl = (trackInfo: any): string | null => {
  const path = trackInfo?.coverMiddle || trackInfo?.coverLarge || trackInfo?.coverSmall
  if (!path) return null
  const s = String(path)
  return s.startsWith('http') ? s : `https://imagev2.xmcdn.com/${s}`
}

/** 拉取曲目播放信息（免登免费曲可用；付费/VIP 曲 ret=1001 或 isAuthorized=false） */
export const getTrackInfo = async(trackId: string, trackQualityLevel = 1): Promise<any> => {
  const xmSign = await makeXmSign()
  const { statusCode, body } = await httpFetch(
    `${BASE_INFO_URL}${Date.now()}?device=win&trackId=${trackId}&trackQualityLevel=${trackQualityLevel}`,
    {
      headers: {
        'User-Agent': XM_UA,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Referer: `https://www.ximalaya.com/sound/${trackId}`,
        Origin: 'https://www.ximalaya.com',
        Cookie: buildRequestCookie(),
        'xm-sign': xmSign,
      },
      timeout: 20000,
    },
  ).promise as any
  if (statusCode != 200) throw new Error(`baseInfo HTTP ${statusCode}`)
  const b = body ?? {}
  if (b.ret != 0) {
    // 1001：匿名访问付费内容与风控共用；未登录时优先提示绑定登录
    const logged = Boolean((getCredentials('xm') as any)?.cookie)
    if (b.ret == 1001 && !logged) throw new Error('该内容需要登录（POST /login/xm 绑定 cookie 后重试）')
    throw new Error(b.msg || `baseInfo ret ${b.ret}`)
  }
  const trackInfo = b.trackInfo ?? b.data?.trackInfo
  if (!trackInfo) throw new Error('baseInfo 未返回 trackInfo')
  return trackInfo
}

export default { getTrackInfo, coverUrl }
