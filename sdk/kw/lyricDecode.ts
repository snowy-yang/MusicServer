// 酷我歌词解码（原主进程 IPC 处理器的纯 JS 实现）
// - 酷我歌词（inflate + yeelion XOR + gb18030）
//   算法来源: kw 桌面端歌词解码实现

import zlib from 'node:zlib'
import iconv from 'iconv-lite'

const handleInflate = (data: Buffer): Promise<Buffer> => new Promise((resolve, reject) => {
  zlib.inflate(data, (err, result) => {
    if (err) return reject(err)
    resolve(result)
  })
})

const buf_key = Buffer.from('yeelion')
const buf_key_len = buf_key.length

const decodeKwLyric = async(buf, isGetLyricx) => {
  if (buf.toString('utf8', 0, 10) != 'tp=content') return ''
  const lrcData = await handleInflate(buf.subarray(buf.indexOf('\r\n\r\n') + 4))

  if (!isGetLyricx) return iconv.decode(lrcData, 'gb18030')

  const buf_str = Buffer.from(lrcData.toString(), 'base64')
  const buf_str_len = buf_str.length
  const output = new Uint8Array(buf_str_len)
  let i = 0
  while (i < buf_str_len) {
    let j = 0
    while (j < buf_key_len && i < buf_str_len) {
      output[i] = buf_str[i] ^ buf_key[j]
      i++
      j++
    }
  }

  return iconv.decode(Buffer.from(output), 'gb18030')
}

/**
 * 酷我歌词解码
 * @param {{ lrcBase64: string, isGetLyricx: boolean }} params
 * @returns {Promise<string>} 解码后歌词的 base64
 */
export const handleKwDecodeLyric = async({ lrcBase64, isGetLyricx }) => {
  const lrc = await decodeKwLyric(Buffer.from(lrcBase64, 'base64'), isGetLyricx)
  return Buffer.from(lrc).toString('base64')
}
