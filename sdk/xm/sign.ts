// 喜马拉雅 xm-sign 生成 —— 移植 Ximalaya-Downloader-Next / easy-sign 的 du_web_sdk 签名链
// 协议：device_info → JSON → URL 编码字节 → zlib(level 6) → AES-128-ECB(PKCS7, KEY) →
//   POST https://hdaa.shuzilm.cn/report?v=1.2.0&e=1&c=1&r=<uuid>（octet-stream）→
//   Base64 响应 → AES-ECB 解密 → JSON 取 cadd/sid → xm-sign = "{cadd}&&{sid}"
// KEY 为 du_web_sdk _getDeviceKey(0) 的硬编码密钥；每次签名都重新上报（不缓存）。
// 模板为纯 ASCII（Base64/十六进制字段），latin1 取字节与参考实现的 charCode 语义一致。

import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { httpFetch } from '../request.ts'
import { DEVICE_INFO } from './deviceInfo.ts'

const SIGN_KEY = 'm9ZtRrz:qujT8@da'
const REPORT_URL = 'https://hdaa.shuzilm.cn/report?v=1.2.0&e=1&c=1&r='
// 与 device_info.ew1.yV2（Chrome 125 模板）保持一致
export const XM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

const aesEcb = (data: Buffer, decrypt: boolean) => {
  const key = Buffer.from(SIGN_KEY, 'utf8')
  const cipher = decrypt
    ? crypto.createDecipheriv('aes-128-ecb', key, null)
    : crypto.createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(data), cipher.final()])
}

/** 生成 xm-sign（形如 "cadd&&sid"）；每次调用重新上报设备指纹 */
export const makeXmSign = async(): Promise<string> => {
  const info = { ...DEVICE_INFO, Zf5: Date.now() }
  const compressed = zlib.deflateSync(Buffer.from(JSON.stringify(info), 'latin1'), { level: 6 })
  const payload = aesEcb(compressed, false)

  const { statusCode, body, raw } = await httpFetch(`${REPORT_URL}${crypto.randomUUID()}`, {
    method: 'post',
    headers: {
      'Content-Type': 'application/octet-stream',
      'User-Agent': XM_UA,
      Host: 'hdaa.shuzilm.cn',
    },
    body: payload,
    timeout: 15000,
  }).promise as any
  const respText = raw ? raw.toString('utf8') : String(body ?? '')
  if (statusCode != 200) throw new Error(`xm-sign 上报失败: HTTP ${statusCode}`)

  const decrypted = aesEcb(Buffer.from(respText, 'base64'), true).toString('utf8')
  const obj = JSON.parse(decrypted)
  const cadd = String(obj.cadd || '')
  const sid = String(obj.sid || '')
  if (!cadd || !sid) throw new Error('xm-sign 上报响应缺少 cadd/sid')
  return `${cadd}&&${sid}`
}

export default { makeXmSign, XM_UA }
