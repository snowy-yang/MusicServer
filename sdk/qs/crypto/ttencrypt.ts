// TT 加密（设备注册请求体）：gzip + SHA512 校验 + AES-128-CBC，magic 头 "tc"
// 移植自 fanqie-assistant src/crypto/ttencrypt.ts（Node crypto 实现）
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { gzipSync } from 'node:zlib'

// 固定盐（base64 常量，社区共知）
const FIXED_STRING = Buffer.from(
  'TdTC5rgxYgkOUrPHpnM7pByyRiuCmrWKGWs521cXdST0m69/COjWjSanLjfBqVovHwWlGJKu8pSXMrYqOKrdWA==',
  'base64',
)

const sha512 = (data: Buffer): Buffer => createHash('sha512').update(data).digest()

export const encryptTT = (data: Buffer): Buffer => {
  const rand = randomBytes(32)
  const hashValue = sha512(Buffer.concat([sha512(rand), FIXED_STRING]))
  const key = hashValue.subarray(0, 16)
  const iv = hashValue.subarray(16, 32)
  const compressed = gzipSync(data)
  const payload = Buffer.concat([sha512(compressed), compressed])
  const cipher = createCipheriv('aes-128-cbc', key, iv)
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()])
  return Buffer.concat([Buffer.from([116, 99, 5, 16, 0, 0]), rand, encrypted])
}

export default { encryptTT }
