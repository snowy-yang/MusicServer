// 酷狗行为指纹模拟（sid/edt 生成）——移植 MakcRe/KuGouMusicApi util/generate_simulate.js
// 用途：20028 二次验证时替代浏览器 WASM 上报行为数据。
// 协议：明文 = mid=..;userid=..;dfid=..;webgl=..;webdriver=0;ts=..;data=<事件流>
//   edt = AES-128-CBC(明文, key=md5(rand16)[0:16], iv='kugousecurity123') → Base64
//   sid = RSA-OAEP-SHA256(key) → Base64（公钥取自酷狗 WASM 二进制）
// 事件流：贝塞尔曲线鼠标轨迹(type 3) + 滚动(type 5) + 窗口(type 6)，条目间以 : 分隔，
//   每条事件后跟一条哨兵记录（时间差字段替换为接近 0xFFFFFFFF 的随机值）。

import crypto from 'node:crypto'

const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex')

const SIM_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAoW2+Ylo8ALePSQTP0xBF
lFmEOHvBD9tS+s7DBlfKEu3RzzvZTaX1JtYbX4+AVUqj6ARz8IM+CKByqGFvbHN/
W64XxNI+q7z36ajCL3VTJ2W5G9MCJitc6oGbire4NQfhaEq0nC+hxBWQvCbIFflA
2ItrLUbSU7z1bHA/a+jlQm4OWvY+IKnTryOJTPuT1yNOVjbJ8wBLKy2DgQr9pPqW
PmEQtGpR5IM9V8Kao6PaSdKYOWGbX3i2+RzIKhvZUxxtJwdVbqPlDPlW9h4/xIBc
56Lgvr4aIl8nFtwbj4UJVUTFuGrs0tY9H/tXvZ22dUCKuGxW/gW7ZF+gXz6vHtYa
rQIDAQAB
-----END PUBLIC KEY-----`
const SIM_IV = 'kugousecurity123'

const ri = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min
const randomString = (n: number) => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  return Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

let sentinel = 0xffffffff - ri(0, 20)

const f3 = (t: number | string, i: number, x: number, y: number) => `3,${t},${i},${x},${y}`
const f5 = (t: number | string, i: number) => `5,${t},${i}`
const f6 = (t: number | string, i: number, x: number, y: number) => `6,${t},${i},${x},${y}`

// 三阶贝塞尔鼠标轨迹：随机控制点 + 起步抖动大、后程收敛
const bezierPath = (sx: number, sy: number, ex: number, ey: number, n: number) => {
  const c1x = sx + (ex - sx) * 0.3 + ri(-80, 80)
  const c1y = sy + (ey - sy) * 0.2 + ri(-60, 60)
  const c2x = sx + (ex - sx) * 0.7 + ri(-60, 60)
  const c2y = sy + (ey - sy) * 0.8 + ri(-40, 40)
  const pts: Array<{ x: number, y: number }> = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const u = 1 - t
    const x = u * u * u * sx + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * ex
    const y = u * u * u * sy + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ey
    const jitter = Math.max(0.5, 3 - t * 2.5)
    pts.push({ x: x + (Math.random() - 0.5) * jitter, y: y + (Math.random() - 0.5) * jitter })
  }
  return pts
}

const generateEdtData = ({ startX, startY, endX, endY, mousePoints }: {
  startX: number, startY: number, endX: number, endY: number, mousePoints: number
}) => {
  const entries: string[] = []
  let ts = 0
  let ei = 0

  entries.push(f5(0, 0), f5(sentinel, 0), f5(0, 0), f5(sentinel, 0))

  ts += ri(5, 20)
  entries.push(f6(ts, ei, 750, 500), f6(sentinel, ei, 750, 500))
  ei++

  for (let i = 0; i < 3; i++) {
    ts += ri(80, 600)
    entries.push(f5(ts, ei), f5(sentinel, ei))
    ei++
  }

  const path = bezierPath(startX, startY, endX, endY, mousePoints)
  let si = 0
  for (let i = 0; i < path.length; i++) {
    const { x, y } = path[i]
    ts += ri(8, 50)
    const rx = Math.round(x)
    const ry = Math.round(y)
    entries.push(f3(ts, si, rx, ry), f3(sentinel, si, rx, ry))
    if (i > 0 && i % 12 === 0) {
      ts += ri(20, 60)
      entries.push(f5(ts, ei), f5(sentinel, ei))
      ei++
    }
    si = (si + 1) % 2
  }

  ts += ri(5, 30)
  entries.push(f3(ts, 1, Math.round(endX + ri(-5, 5)), Math.round(endY + ri(-5, 5))), f3(sentinel, 1, Math.round(endX), Math.round(endY)))

  return entries.join(':')
}

/** 生成模拟行为指纹（sid/edt），验证接口 /v4/verify_user_info 原样上送 */
export const generateSimulate = (mid: string | number, userid: string | number, dfid: string, webglHash?: string) => {
  sentinel = 0xffffffff - ri(0, 20)
  const key = md5(randomString(16)).slice(0, 16)
  const points = ri(30, 60)
  const startX = ri(200, 600)
  const startY = ri(200, 500)
  const endX = ri(500, 700)
  const endY = ri(80, 150)
  const webgl = webglHash || md5(randomString(32))
  const plaintext = `mid=${mid || 0};userid=${userid || 0};dfid=${dfid || 0};webgl=${webgl};webdriver=0;ts=${Date.now()};data=${generateEdtData({ startX, startY, endX, endY, mousePoints: points })}`

  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(SIM_IV, 'utf8'))
  const edt = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64')
  const sid = crypto.publicEncrypt(
    { key: SIM_PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(key, 'utf8'),
  ).toString('base64')
  return { edt, sid }
}

export default { generateSimulate }
