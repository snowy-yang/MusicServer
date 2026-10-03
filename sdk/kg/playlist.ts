// 酷狗歌单 —— 搜索 / 详情 / 分类 / 分类歌单 / 推荐 / 链接解析
// 上游对应：music-lib/kugou/playlist.go + kugou.go 的 fetchPlaylistDetail
// 链接解析优先复用既有 sdk/kg/songList.ts 的 getUserListDetail / getListDetailBySpecialId /
// getListInfoByChain / decodeGcid 等能力（覆盖 special/single、songlist/gcid、share chain、
// zlist、global_collection_id 等形态），本模块只做统一形状归一。
import { httpFetch } from '../common/request.ts'
import songList from './songList.ts'

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1'

const firstNonEmpty = (...values: any[]): string => {
  for (const value of values) {
    if (value == null) continue
    const str = String(value).trim()
    if (str) return str
  }
  return ''
}

const playlistCover = (url: any): string => String(url ?? '').replace('{size}', '240')

/** 歌单摘要（对齐契约形状；id 用平台 specialid，link 指向网页版） */
const toSummary = (item: any) => {
  const rawId = firstNonEmpty(item?.specialid, item?.global_specialid, item?.id)
  const id = rawId.replace(/^id_/, '')
  if (!id) return null
  const playCount = Number(item?.playcount)
  return {
    id,
    name: firstNonEmpty(item?.specialname, item?.name),
    cover: playlistCover(firstNonEmpty(item?.imgurl, item?.img)),
    trackCount: Number(item?.songcount ?? item?.total ?? 0) || 0,
    playCount: Number.isFinite(playCount) ? playCount : (item?.play_count ?? 0),
    creator: firstNonEmpty(item?.nickname, item?.username, item?.author),
    description: firstNonEmpty(item?.intro, item?.desc),
    publishTime: String(item?.publishtime ?? item?.time ?? '').trim(),
    link: `https://www.kugou.com/yy/special/single/${id}.html`,
    source: 'kg' as const,
  }
}

/** 歌单搜索（上游 SearchPlaylist；复用 songList.search 的 msearchretry v3 接口） */
export const searchPlaylist = async(keyword: string, page = 1, limit = 20) => {
  const word = String(keyword ?? '').trim()
  if (!word) return { source: 'kg' as const, list: [] as any[], page, limit, total: 0 }
  const res = await songList.search(word, page, limit)
  const list = (res?.list ?? []).map(toSummary).filter(Boolean)
  return {
    source: 'kg' as const,
    list,
    page,
    limit,
    total: Number(res?.total ?? 0) || list.length,
  }
}

/** 数字 id / id_ 前缀 / 链接 → songList.getListDetail 可识别的入参 */
const normalizePlaylistId = (id: any): string => {
  const raw = String(id ?? '').trim()
  if (!raw) return ''
  if (/^\d+$/.test(raw)) return `id_${raw}`
  return raw
}

/**
 * 歌单详情（含元数据与曲目）
 * 委托 songList.getListDetail（special 页 / gcid songlist / share chain / 裸酷狗码等），
 * 平台自身返回全量时按 page/limit 本地开窗。
 */
export const getPlaylistDetail = async(id: string, page = 1, limit = 50) => {
  const requestId = normalizePlaylistId(id)
  if (!requestId) throw new Error('酷狗歌单 id 为空')
  const pageNo = Math.max(1, Number(page) || 1)
  const pageSize = Math.max(1, Number(limit) || 50)

  const res = await songList.getListDetail(requestId, pageNo)
  if (!res) throw new Error('酷狗歌单不存在或解析失败')
  let list: any[] = res.list ?? []
  const total = Number(res.total ?? 0) || list.length
  if (list.length > pageSize) {
    const start = (pageNo - 1) * pageSize
    list = list.slice(start, start + pageSize)
  }

  return {
    source: 'kg' as const,
    info: {
      name: firstNonEmpty(res.info?.name, String(id)),
      img: playlistCover(res.info?.img),
      desc: firstNonEmpty(res.info?.desc),
      author: firstNonEmpty(res.info?.author),
      play_count: res.info?.play_count ?? '',
    },
    list,
    page: pageNo,
    limit: pageSize,
    total,
  }
}

/** 上游 GetPlaylistSongs：只取曲目（复用详情全量） */
export const getPlaylistSongs = async(id: string) => {
  const res = await songList.getListDetail(normalizePlaylistId(id), 1)
  return res?.list ?? []
}

/** 歌单分类（上游 GetPlaylistCategories：tag/list；categoryId 形如 `<id>:<tagId>`） */
export const getCategories = async() => {
  const { statusCode, body } = await httpFetch('http://mobilecdnbj.kugou.com/api/v3/tag/list?pid=0&apiver=2&plat=0', {
    headers: { 'User-Agent': UA, Referer: 'http://m.kugou.com' },
    timeout: 15000,
  }).promise
  if (statusCode !== 200 || body?.status !== 1 || body?.errcode !== 0) {
    throw new Error(body?.error || '酷狗歌单分类获取失败')
  }

  const list: Array<{ id: string, name: string, group: string, hot?: boolean }> = [
    { id: '', name: '全部', group: '全部' },
  ]
  for (const group of body?.data?.info ?? []) {
    const groupName = String(group?.name ?? '').trim()
    const groupID = Number(group?.id ?? 0) || 0
    if (groupID > 0 && groupName) {
      list.push({ id: `${groupID}:0`, name: groupName, group: groupName })
    }
    for (const child of group?.children ?? []) {
      const id = Number(child?.id ?? 0) || 0
      const name = String(child?.name ?? '').trim()
      if (!id || !name) continue
      const tagId = Number(child?.special_tag_id ?? 0) || 0
      list.push({ id: `${id}:${tagId}`, name, group: groupName, hot: Number(child?.is_hot ?? 0) === 1 })
    }
  }
  return { source: 'kg' as const, list }
}

/** categoryId → [id, tagId]；空/dirty 时取分类表首个非空分类 */
const parseCategoryID = (categoryId: any): { id: string, tagId: string } => {
  const parts = String(categoryId ?? '').trim().split(':')
  const id = String(parts[0] ?? '').trim()
  const tagId = String(parts[1] ?? '').trim() || '0'
  return { id, tagId }
}

/** 分类歌单（上游 GetCategoryPlaylists：tag/specialList） */
export const getCategoryPlaylists = async(categoryId: string, page = 1, limit = 20) => {
  const pageNo = Math.max(1, Number(page) || 1)
  const pageSize = Math.max(1, Number(limit) || 20)

  let { id, tagId } = parseCategoryID(categoryId)
  if (!id) {
    const { list } = await getCategories()
    const first = list.find(item => item.id)
    if (!first) throw new Error('酷狗歌单分类为空')
    ;({ id, tagId } = parseCategoryID(first.id))
  }

  const apiURL = 'http://mobilecdnbj.kugou.com/api/v3/tag/specialList?' + [
    'plat=0',
    `page=${pageNo}`,
    `tagid=${tagId}`,
    `pagesize=${pageSize}`,
    'ugc=1',
    `id=${id}`,
    'sort=2',
  ].join('&')
  const { statusCode, body } = await httpFetch(apiURL, {
    headers: { 'User-Agent': UA, Referer: 'http://m.kugou.com' },
    timeout: 15000,
  }).promise
  if (statusCode !== 200 || body?.status !== 1 || body?.errcode !== 0) {
    throw new Error(body?.error || '酷狗分类歌单获取失败')
  }

  const list = (body?.data?.info ?? []).map((item: any) => {
    const summary: any = toSummary(item) ?? toSummary({ ...item, specialid: item?.global_specialid })
    if (!summary) return null
    summary.categoryId = `${id}:${tagId}`
    return summary
  }).filter(Boolean)

  return {
    source: 'kg' as const,
    list,
    page: pageNo,
    limit: pageSize,
    total: Number(body?.data?.total ?? 0) || list.length,
  }
}

/** 推荐歌单（上游 GetRecommendedPlaylists：m.kugou.com/plist/index&json=true） */
export const getRecommended = async(page = 1, limit = 30) => {
  const pageNo = Math.max(1, Number(page) || 1)
  const pageSize = Math.max(1, Number(limit) || 30)
  const { statusCode, body } = await httpFetch(`http://m.kugou.com/plist/index&json=true&page=${pageNo}`, {
    headers: { 'User-Agent': UA, Referer: 'http://m.kugou.com' },
    timeout: 15000,
  }).promise
  if (statusCode !== 200 || typeof body !== 'object' || body == null) {
    throw new Error('酷狗推荐歌单获取失败')
  }
  let list = (body?.plist?.list?.info ?? []).map(toSummary).filter(Boolean)
  if (list.length > pageSize) list = list.slice(0, pageSize)
  return {
    source: 'kg' as const,
    list,
    page: pageNo,
    limit: pageSize,
    total: Number(body?.plist?.list?.total ?? 0) || list.length,
  }
}

/**
 * 上游 ParsePlaylist：
 *   /yy/special/single/<id>.html → special 详情
 *   /songlist/<gcid_xxx>/ → gcid 详情
 * 其余链接形态（share chain、zlist、global_collection_id、裸 id/酷狗码）交给 songList 通用解析。
 */
export const parsePlaylistLink = async(link: string) => {
  const raw = String(link ?? '').trim()
  if (!raw) throw new Error('无效的酷狗歌单链接')
  const special = raw.match(/special\/single\/(\d+)\.html/)
  const gcid = raw.match(/songlist\/(gcid_[A-Za-z0-9]+)/)
  if (special) return getPlaylistDetail(special[1]!, 1)
  if (gcid) return getPlaylistDetail(gcid[1]!, 1)
  return getPlaylistDetail(raw, 1)
}

export default {
  searchPlaylist,
  getPlaylistDetail,
  getPlaylistSongs,
  getCategories,
  getCategoryPlaylists,
  getRecommended,
  parsePlaylistLink,
}
