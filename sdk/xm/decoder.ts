// 喜马拉雅 www2 播放地址解码 —— 移植 Ximalaya-Downloader-Next adapters/decoder.py
// 算法：URL-safe Base64 → 尾 16 字节为 IV，正文先查 S-Box 置换表，
//   再按 16 字节块与 IV 异或、按 32 字节块与固定密钥异或，还原明文 URL。
// PC 桌面端（device=win）另有 AES-ECB 变体（密钥取自官方客户端 4.0.14 asar）。

import crypto from 'node:crypto'

// S-Box 置换表（www2/mweb2 设备类型）
const PERMUTATION_TABLE_O = [
  183, 174, 108, 16, 131, 159, 250, 5, 239, 110, 193, 202, 153, 137, 251, 176,
  119, 150, 47, 204, 97, 237, 1, 71, 177, 42, 88, 218, 166, 82, 87, 94,
  14, 195, 69, 127, 215, 240, 225, 197, 238, 142, 123, 44, 219, 50, 190, 29,
  181, 186, 169, 98, 139, 185, 152, 13, 141, 76, 6, 157, 200, 132, 182, 49,
  20, 116, 136, 43, 155, 194, 101, 231, 162, 242, 151, 213, 53, 60, 26, 134,
  211, 56, 28, 223, 107, 161, 199, 15, 229, 61, 96, 41, 66, 158, 254, 21,
  165, 253, 103, 89, 3, 168, 40, 246, 81, 95, 58, 31, 172, 78, 99, 45,
  148, 187, 222, 124, 55, 203, 235, 64, 68, 149, 180, 35, 113, 207, 118, 111,
  91, 38, 247, 214, 7, 212, 209, 189, 241, 18, 115, 173, 25, 236, 121, 249,
  75, 57, 216, 10, 175, 112, 234, 164, 70, 206, 198, 255, 140, 230, 12, 32,
  83, 46, 245, 0, 62, 227, 72, 191, 156, 138, 248, 114, 220, 90, 84, 170,
  128, 19, 24, 122, 146, 80, 39, 37, 8, 34, 22, 11, 93, 130, 63, 154,
  244, 160, 144, 79, 23, 133, 92, 54, 102, 210, 65, 67, 27, 196, 201, 106,
  143, 52, 74, 100, 217, 179, 48, 233, 126, 117, 184, 226, 85, 171, 167, 86,
  2, 147, 17, 135, 228, 252, 105, 30, 192, 129, 178, 120, 36, 145, 51, 163,
  77, 205, 73, 4, 188, 125, 232, 33, 243, 109, 224, 104, 208, 221, 59, 9,
]

const XOR_KEY_A = [
  204, 53, 135, 197, 39, 73, 58, 160, 79, 24, 12, 83, 180, 250, 101, 60,
  206, 30, 10, 227, 36, 95, 161, 16, 135, 150, 235, 116, 242, 116, 165, 171,
]

// PC 桌面端 playUrlList 的 AES-ECB 密钥（客户端 4.0.14 asar Gt 函数提取）
const WIN_AES_KEY = Buffer.from('aaad3e4fd540b0f79dca95606e72bf93', 'hex')

const b64urlToBuf = (s: string) => {
  const cleaned = s.replace(/_/g, '/').replace(/-/g, '+')
  return Buffer.from(cleaned + '='.repeat((4 - cleaned.length % 4) % 4), 'base64')
}

/** www2/mweb2 加密 URL → 明文 URL */
export const decodeWww2Url = (encrypted: string): string => {
  if (!encrypted) return ''
  if (encrypted.startsWith('http')) return encrypted
  const decoded = b64urlToBuf(encrypted)
  if (decoded.length < 16) throw new Error('密文长度不足（缺少 IV）')
  const body = Uint8Array.from(decoded.subarray(0, decoded.length - 16))
  const iv = decoded.subarray(decoded.length - 16)

  for (let i = 0; i < body.length; i++) body[i] = PERMUTATION_TABLE_O[body[i]]
  for (let i = 0; i < body.length; i += 16) {
    const n = Math.min(16, body.length - i)
    for (let j = 0; j < n; j++) body[i + j] ^= iv[j]
  }
  for (let i = 0; i < body.length; i += 32) {
    const n = Math.min(32, body.length - i)
    for (let j = 0; j < n; j++) body[i + j] ^= XOR_KEY_A[j]
  }
  return Buffer.from(body).toString('utf8')
}

/** PC 桌面端（device=win）AES-ECB 加密 URL → 明文 URL（解出的是带签名付费地址） */
export const decodeWinUrl = (encrypted: string): string => {
  if (!encrypted) return ''
  if (encrypted.startsWith('http')) return encrypted
  const d = crypto.createDecipheriv('aes-128-ecb', WIN_AES_KEY, null)
  const plain = Buffer.concat([d.update(b64urlToBuf(encrypted)), d.final()])
  return plain.toString('utf8')
}

export default { decodeWww2Url, decodeWinUrl }
