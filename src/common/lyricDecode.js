// 歌词解码（替代原 lx-music 主进程 IPC 处理器）
// - handle_kw_decode_lyric: 酷我歌词（inflate + yeelion XOR + gb18030）
//   算法来源: lx-music-desktop src/main/modules/winMain/rendererEvent/kw_decodeLyric.ts
// - handle_tx_decode_lyric: QQ音乐歌词（qrc 解码：hex → XOR 偏移 → deflate）
//   qrc 算法来源: 开源 qrc 解码器（ZhuYiQing/qrcDecode 纯 JS 版）

import zlib from 'node:zlib'
import iconv from 'iconv-lite'

// ==================== 酷我 ====================

const handleInflate = data => new Promise((resolve, reject) => {
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

// ==================== QQ音乐（qrc） ====================

import { decodeQrc } from './qrcDecode.js'

/**
 * QQ音乐歌词解码
 * @param {{ lrc: string, tlrc: string, rlrc: string }} params 均为十六进制字符串
 * @returns {Promise<{lyric: string, tlyric: string, rlyric: string}>}
 */
export const handleTxDecodeLyric = async({ lrc, tlrc, rlrc }) => {
  const [lyric, tlyric, rlyric] = await Promise.all([decodeQrc(lrc), decodeQrc(tlrc), decodeQrc(rlrc)])
  return { lyric, tlyric, rlyric }
}
