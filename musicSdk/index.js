import kw from './kw/index.js'
import kg from './kg/index.js'
import tx from './tx/index.js'
import wy from './wy/index.js'
import mg from './mg/index.js'
import bd from './bd/index.js'
import xm from './xm.js'
import { supportQuality } from './api-source.js'
import {
  sizeFormate,
  formatPlayTime,
  dateFormat,
  dateFormat2,
  formatPlayCount,
  decodeName,
} from '../src/index.js'

// 通用工具函数（SDK 内 `import { ... } from '../index.js'` 的解析目标）
export { sizeFormate, formatPlayTime, dateFormat, dateFormat2, formatPlayCount, decodeName }

const SINGERS_SEPARATOR = /、|&|;|；|\/|,|，|\||\]|\[|!|！/g
const SUPPORTED_SOURCES = [
  { id: 'kw', name: '酷我音乐', module: kw },
  { id: 'kg', name: '酷狗音乐', module: kg },
  { id: 'tx', name: 'QQ音乐', module: tx },
  { id: 'wy', name: '网易音乐', module: wy },
  { id: 'mg', name: '咪咕音乐', module: mg },
  { id: 'xm', name: '虾米音乐', module: xm },
  // { id: 'bd', name: '百度音乐', module: bd },
]

const SOURCE_MODULES = Object.fromEntries(SUPPORTED_SOURCES.map((s) => [s.id, s.module]))

export const sources = SUPPORTED_SOURCES.map(({ id, name }) => ({ id, name }))

export const init = () =>
  Promise.all(SUPPORTED_SOURCES.map((s) => s.module.init?.()).filter(Boolean))

export { supportQuality }

const trimStr = (str) => (typeof str === 'string' ? str.trim() : str)

const filterStr = (str) =>
  typeof str === 'string'
    ? str.replace(/\s|'|\.|,|，|&|"|、|\(|\)|（|）|`|~|-|<|>|\||\/|\]|\[|!|！/g, '')
    : String(str ?? '')

const getIntervalSeconds = (interval) => {
  if (!interval) return 0
  const parts = String(interval).split(':')
  let seconds = 0
  let unit = 1
  while (parts.length) {
    seconds += parseInt(parts.pop()) * unit
    unit *= 60
  }
  return seconds
}

const sortSingle = (singer) => {
  if (!singer) return ''
  return SINGERS_SEPARATOR.test(singer)
    ? singer.split(SINGERS_SEPARATOR).sort((a, b) => a.localeCompare(b)).join('、')
    : singer
}

/**
 * 多平台聚合搜索
 * @param {object} params
 * @param {string} params.name
 * @param {string} [params.singer]
 * @param {string} [params.source] 指定平台时，聚合结果会跳过该平台
 * @param {number} [params.limit=25]
 */
export const searchMusic = async ({ name, singer, source: excludeSource, limit = 25 }) => {
  const musicName = trimStr(name)
  const tasks = []
  for (const source of SUPPORTED_SOURCES) {
    if (
      source.id === 'xm' ||
      source.id === excludeSource ||
      !source.module.musicSearch
    )
      continue
    tasks.push(
      source.module.musicSearch
        .search(`${musicName} ${singer || ''}`.trim(), 1, limit)
        .catch(() => null)
    )
  }
  return (await Promise.all(tasks)).filter(Boolean)
}

const pickMatching = (items, predicate) => {
  const matched = []
  const rest = []
  for (const item of items) {
    if (predicate(item)) matched.push(item)
    else rest.push(item)
  }
  return { matched, rest }
}

/**
 * 跨平台精确匹配歌曲（按歌手、歌名、专辑、时长综合排序）
 */
export const findMusic = async ({ name, singer, albumName, interval, source: s }) => {
  const lists = await searchMusic({ name, singer, source: s, limit: 25 })

  const fMusicName = filterStr(name).toLowerCase()
  const fSinger = filterStr(sortSingle(singer)).toLowerCase()
  const fAlbumName = filterStr(albumName).toLowerCase()
  const fInterval = getIntervalSeconds(interval)

  const isEqualsInterval = (intv) =>
    Math.abs((fInterval || intv) - (intv || fInterval)) < 5
  const isIncludesName = (n) => fMusicName.includes(n) || n.includes(fMusicName)
  const isIncludesSinger = (sng) =>
    fSinger ? fSinger.includes(sng) || sng.includes(fSinger) : true
  const isEqualsAlbum = (alb) => (fAlbumName ? fAlbumName === alb : true)

  let candidates = []
  for (const source of lists) {
    for (const item of source.list) {
      item.name = trimStr(item.name)
      item.singer = trimStr(item.singer)
      item.fSinger = filterStr(sortSingle(item.singer).toLowerCase())
      item.fMusicName = filterStr(String(item.name ?? '').toLowerCase())
      item.fAlbumName = filterStr(String(item.albumName ?? '').toLowerCase())
      item.fInterval = getIntervalSeconds(item.interval)
      if (!isEqualsInterval(item.fInterval)) {
        item.name = null
        continue
      }
      candidates.push(item)
    }
  }

  const result = []
  const take = (predicate) => {
    const { matched, rest } = pickMatching(candidates, predicate)
    result.push(...matched)
    candidates = rest
  }

  take((item) => item.fSinger === fSinger && item.fMusicName === fMusicName && item.interval === interval)
  take((item) => item.fMusicName === fMusicName && item.fSinger === fSinger && item.fAlbumName === fAlbumName)
  take((item) => item.fSinger === fSinger && item.fMusicName === fMusicName)
  take((item) => item.fMusicName === fMusicName && item.interval === interval)
  take((item) => item.fSinger === fSinger && item.interval === interval)
  take((item) => item.interval === interval)
  take((item) => item.fMusicName === fMusicName)
  take((item) => item.fSinger === fSinger)
  take((item) => item.fAlbumName === fAlbumName)

  for (const item of candidates) {
    delete item.fSinger
    delete item.fMusicName
    delete item.fAlbumName
    delete item.fInterval
  }
  for (const item of result) {
    delete item.fSinger
    delete item.fMusicName
    delete item.fAlbumName
    delete item.fInterval
  }

  result.push(...candidates)
  return result
}

export default {
  sources,
  ...SOURCE_MODULES,
  init,
  supportQuality,
  searchMusic,
  findMusic,
}
