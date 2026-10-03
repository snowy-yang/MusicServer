// 通用工具函数

import crypto from 'node:crypto'

/** MD5 十六进制串 */
export const toMD5 = str => crypto.createHash('md5').update(str).digest('hex')

/**
 * 将大小格式化为可读字符串
 * @param {number} size 字节数
 */
export const sizeFormate = size => {
  // https://gist.github.com/thomseddon/3511330
  if (!size) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const number = Math.floor(Math.log(size) / Math.log(1024))
  return `${(size / Math.pow(1024, Math.floor(number))).toFixed(2)} ${units[number]}`
}

/**
 * 将秒数格式化为 mm:ss
 * @param {number} time 秒
 */
export const formatPlayTime = time => {
  if (Number.isNaN(time) || time < 0) time = 0
  const m = Math.trunc(time / 60)
  const s = Math.trunc(time % 60)
  return m == 0 && s == 0 ? '--/--' : `${m < 10 ? '0' + m : m}:${s < 10 ? '0' + s : s}`
}

/**
 * 将时间对象/时间戳转成日期字符串
 * @param {Date|number|string} _date 时间
 * @param {string} [format='Y-M-D h:m:s'] 格式模板（Y/M/D/h/m/s）
 */
export const dateFormat = (_date, format = 'Y-M-D h:m:s') => {
  if (!_date) return ''
  let date
  switch (typeof _date) {
    case 'string':
      if (!_date.includes('T')) _date = _date.split('.')[0].replace(/-/g, '/')
      // fallthrough
    case 'number':
      date = new Date(_date)
      break
    case 'object':
      date = _date
      break
    default:
      return ''
  }
  const numFix = n => n < 10 ? '0' + n : String(n)
  return format
    .replace('Y', date.getFullYear().toString())
    .replace('M', numFix(date.getMonth() + 1))
    .replace('D', numFix(date.getDate()))
    .replace('h', numFix(date.getHours()))
    .replace('m', numFix(date.getMinutes()))
    .replace('s', numFix(date.getSeconds()))
}

/**
 * 相对时间格式化（用于评论时间）
 * @param {number} time 毫秒时间戳
 */
export const dateFormat2 = time => {
  const differ = Math.trunc((Date.now() - time) / 1000)
  if (differ < 60) return `${differ}秒前`
  if (differ < 3600) return `${Math.trunc(differ / 60)}分钟前`
  if (differ < 86400) return `${Math.trunc(differ / 3600)}小时前`
  if (differ < 2592000) return `${Math.trunc(differ / 86400)}天前`
  return dateFormat(time)
}

/**
 * 格式化播放量
 * @param {number} num
 */
export const formatPlayCount = num => {
  if (num > 100000000) return `${Math.trunc(num / 10000000) / 10}亿`
  if (num > 10000) return `${Math.trunc(num / 1000) / 10}万`
  return String(num)
}

/**
 * 解码 HTML 实体
 * @param {string} str
 */
export const decodeName = (str = '') => {
  if (!str) return ''
  if (typeof str !== 'string') str = String(str)
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num)))
}
