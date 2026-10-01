import kw from './kw/index.ts'
import kg from './kg/index.ts'
import tx from './tx/index.ts'
import wy from './wy/index.ts'
import { supportQualitys as kwQualitys } from './apis/kw.ts'
import { supportQualitys as kgQualitys } from './apis/kg.ts'
import { supportQualitys as txQualitys } from './apis/tx.ts'
import { supportQualitys as wyQualitys } from './apis/wy.ts'
import type { PlatformModule, SearchResult, SongInfo } from './types.ts'
import {
  sizeFormate,
  formatPlayTime,
  dateFormat,
  dateFormat2,
  formatPlayCount,
  decodeName,
} from './common/utils.ts'

// 通用工具函数（SDK 内 `import { ... } from '../index.ts'` 的解析目标）
export { sizeFormate, formatPlayTime, dateFormat, dateFormat2, formatPlayCount, decodeName }

const SINGERS_SEPARATOR = /、|&|;|；|\/|,|，|\||\]|\[|!|！/g
const SUPPORTED_SOURCES: Array<{ id: string; name: string; module: PlatformModule }> = [
  { id: 'kw', name: '酷我音乐', module: kw },
  { id: 'kg', name: '酷狗音乐', module: kg },
  { id: 'tx', name: 'QQ音乐', module: tx },
  { id: 'wy', name: '网易音乐', module: wy },
]

const SOURCE_MODULES = Object.fromEntries(SUPPORTED_SOURCES.map((s) => [s.id, s.module]))

export const sources = SUPPORTED_SOURCES.map(({ id, name }) => ({ id, name }))

export const init = (): Promise<unknown[]> =>
  Promise.all(SUPPORTED_SOURCES.map((s) => s.module.init?.()).filter(Boolean))

// 各平台官方直连接口支持的音质（由取流接口的音质映射推导；
// 外部音源模式下实际可用音质取决于 sources/ 脚本，另行运行时表现）
export const supportQuality: Record<string, string[]> = {
  kw: kwQualitys,
  kg: kgQualitys,
  tx: txQualitys,
  wy: wyQualitys,
}

const trimStr = (str: unknown): string => (typeof str === 'string' ? str.trim() : str as string)

const filterStr = (str: unknown): string =>
  typeof str === 'string'
    ? str.replace(/\s|'|\.|,|，|&|"|、|\(|\)|（|）|`|~|-|<|>|\||\/|\]|\[|!|！/g, '')
    : String(str ?? '')

const getIntervalSeconds = (interval: unknown): number => {
  if (!interval) return 0
  const parts = String(interval).split(':')
  let seconds = 0
  let unit = 1
  while (parts.length) {
    seconds += parseInt(parts.pop()!) * unit
    unit *= 60
  }
  return seconds
}

const sortSingle = (singer: unknown): string => {
  if (!singer) return ''
  const s = String(singer)
  return SINGERS_SEPARATOR.test(s)
    ? s.split(SINGERS_SEPARATOR).sort((a, b) => a.localeCompare(b)).join('、')
    : s
}

interface MatchCandidate extends SongInfo {
  fSinger?: string
  fMusicName?: string
  fAlbumName?: string
  fInterval?: number
}

/**
 * 多平台聚合搜索
 * @param params.name 歌名
 * @param params.singer 歌手
 * @param params.excludeSource 指定平台时，聚合结果会跳过该平台
 * @param params.limit 单平台结果条数
 */
export const searchMusic = async (
  { name, singer, source: excludeSource, limit = 25 }: { name: string; singer?: string; source?: string; limit?: number },
): Promise<Array<SearchResult | null>> => {
  const musicName = trimStr(name)
  const tasks: Array<Promise<SearchResult | null>> = []
  for (const source of SUPPORTED_SOURCES) {
    if (
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

const pickMatching = <T>(items: T[], predicate: (item: T) => boolean): { matched: T[]; rest: T[] } => {
  const matched: T[] = []
  const rest: T[] = []
  for (const item of items) {
    if (predicate(item)) matched.push(item)
    else rest.push(item)
  }
  return { matched, rest }
}

/**
 * 跨平台精确匹配歌曲（按歌手、歌名、专辑、时长综合排序）
 */
export const findMusic = async (
  { name, singer, albumName, interval, source: s }: { name: string; singer?: string; albumName?: string; interval?: string; source?: string },
): Promise<MatchCandidate[]> => {
  const lists = await searchMusic({ name, singer, source: s, limit: 25 })

  const fMusicName = filterStr(name).toLowerCase()
  const fSinger = filterStr(sortSingle(singer)).toLowerCase()
  const fAlbumName = filterStr(albumName).toLowerCase()
  const fInterval = getIntervalSeconds(interval)

  const isEqualsInterval = (intv: number) =>
    Math.abs((fInterval || intv) - (intv || fInterval)) < 5
  const isIncludesName = (n: string) => fMusicName.includes(n) || n.includes(fMusicName)
  const isIncludesSinger = (sng: string) =>
    fSinger ? fSinger.includes(sng) || sng.includes(fSinger) : true
  const isEqualsAlbum = (alb: string) => (fAlbumName ? fAlbumName === alb : true)

  let candidates: MatchCandidate[] = []
  for (const source of lists) {
    if (!source) continue
    for (const item of source.list) {
      const cand = item as MatchCandidate
      cand.name = trimStr(cand.name)
      cand.singer = trimStr(cand.singer)
      cand.fSinger = filterStr(sortSingle(cand.singer).toLowerCase())
      cand.fMusicName = filterStr(String(cand.name ?? '').toLowerCase())
      cand.fAlbumName = filterStr(String(cand.albumName ?? '').toLowerCase())
      cand.fInterval = getIntervalSeconds(cand.interval)
      if (!isEqualsInterval(cand.fInterval)) {
        cand.name = null
        continue
      }
      candidates.push(cand)
    }
  }

  const result: MatchCandidate[] = []
  const take = (predicate: (item: MatchCandidate) => boolean) => {
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

  for (const item of [...candidates, ...result]) {
    delete item.fSinger
    delete item.fMusicName
    delete item.fAlbumName
    delete item.fInterval
  }

  result.push(...candidates)
  return result
}

const musicSdk = {
  sources,
  ...SOURCE_MODULES,
  init,
  supportQuality,
  searchMusic,
  findMusic,
}

export default musicSdk
