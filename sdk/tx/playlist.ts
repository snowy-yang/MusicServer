// QQ音乐歌单（上游 music-lib/qq/playlist.go + qq.go 的 fetchPlaylistDetail 移植）
// 搜索/分类复用现有 sdk/tx/songList.ts（handleParseId / getListId / getListDetail / getTag / getList）
// 推荐：musicu.fcg playlist.HotRecommendServer/get_hot_recommend（上游 GetRecommendedPlaylists）
// 链接解析：extractPlaylistId 为上游 extractQQPlaylistID 的 1:1 移植（含单测用例断言）
import { httpFetch } from '../request.ts'
import { formatPlayCount } from '../index.ts'
import songList from './songList.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
// get_category_content 固定页大小（songList.limit_list = 36，运行时读取以避免模块环上的 TDZ）
const apiLimit = () => Number(songList.limit_list) || 36

const playlistLink = (id: string) => `https://y.qq.com/n/ryqq/playlist/${id}`

/** 歌单摘要：兼容既有 songList.filterList/filterList2 字段并补 spec 形状 */
const toSummary = (item: any) => {
  const id = String(item?.id ?? '').trim()
  if (!id) return null
  const cover = String(item?.img ?? item?.cover ?? '')
  const trackCount = Number(item?.total ?? item?.trackCount ?? 0) || 0
  return {
    ...item,
    id,
    name: item?.name ?? '',
    cover,
    trackCount,
    creator: item?.author ?? item?.creator ?? '',
    description: item?.desc ?? item?.description ?? '',
    link: playlistLink(id),
    source: 'tx' as const,
  }
}

/** 歌单搜索（上游 SearchPlaylist；复用 songList.search） */
export const searchPlaylist = async(keyword: string, page = 1, limit = 20) => {
  const result = await songList.search(String(keyword ?? ''), page, limit)
  const list = (result?.list ?? []).map(toSummary).filter(Boolean)
  return { list, page, limit, total: result?.total ?? list.length, source: 'tx' as const }
}

/** 歌单详情（上游 fetchPlaylistDetail；复用 songList.getListDetail，按 page/limit 切片） */
export const getPlaylistDetail = async(id: string, page = 1, limit = 50) => {
  const detail = await songList.getListDetail(String(id ?? ''))
  const start = Math.max(0, (page - 1) * limit)
  return {
    source: 'tx' as const,
    info: detail.info,
    list: detail.list.slice(start, start + limit),
    page,
    limit,
    total: detail.total ?? detail.list.length,
  }
}

/** 歌单曲目全量（上游 GetPlaylistSongs） */
export const getPlaylistSongs = async(id: string) => {
  const detail = await songList.getListDetail(String(id ?? ''))
  return detail.list
}

/** 歌单分类（上游 GetPlaylistCategories；复用 songList.getTag / getHotTag） */
export const getCategories = async() => {
  const [groups, hotTags] = await Promise.all([
    songList.getTag().catch(() => []),
    songList.getHotTag().catch(() => []),
  ])
  const hotSet = new Set((hotTags ?? []).map((item: any) => String(item.id)))
  const list: any[] = [{ id: '', name: '全部', group: '全部' }]
  const seen = new Set<string>([''])
  for (const group of groups ?? []) {
    for (const item of group?.list ?? []) {
      const id = String(item?.id ?? '').trim()
      const name = String(item?.name ?? '').trim()
      if (!id || !name || seen.has(id)) continue
      seen.add(id)
      list.push({ id, name, group: group.name ?? '', hot: hotSet.has(id) })
    }
  }
  return { source: 'tx' as const, list }
}

/** 分类歌单（上游 GetCategoryPlaylists；get_category_content 每页 36 条，按入参 limit 重新切片）
 *  直接解析原始响应：song_cnt/play_cnt（分类）与 song_ids/access_num（全部）在既有
 *  songList.filterList/filterList2 中未完整映射，这里按上游字段补齐后再切片（不改动既有 songList 行为）。
 *  categoryId 为空或 '10000000'（上游「全部」默认值）时走 get_playlist_by_tag 广场分支。 */
export const getCategoryPlaylists = async(categoryId: string, page = 1, limit = 20) => {
  const cat = String(categoryId ?? '').trim()
  const isAll = cat === '' || cat === '10000000'
  const start = Math.max(0, (page - 1) * limit)
  const apiPages = Math.max(1, Math.ceil((start + limit) / apiLimit()))
  const items: any[] = []
  let total = 0
  for (let apiPage = 1; apiPage <= apiPages; apiPage++) {
    const url = isAll ? songList.getListUrl('5', '', apiPage) : songList.getListUrl('5', cat, apiPage)
    const { statusCode, body } = await httpFetch(url, { timeout: 15000 }).promise
    if (statusCode !== 200 || body?.code != 0) throw new Error(`tx 分类歌单获取失败 (code ${body?.code ?? statusCode})`)
    const data = body?.playlist?.data ?? {}
    if (isAll) {
      total = Number(data.total ?? total) || total
      const batch = (data.v_playlist ?? []).map((item: any) => {
        const playCount = Number(item?.access_num ?? 0) || 0
        return {
          id: String(item?.tid ?? '').trim(),
          name: String(item?.title ?? '').trim(),
          cover: String(item?.cover_url_medium || item?.cover_url_big || ''),
          creator: item?.creator_info?.nick ?? '',
          trackCount: Array.isArray(item?.song_ids) ? item.song_ids.length : 0,
          playCount,
          play_count: formatPlayCount(playCount),
          description: String(item?.desc ?? '').replace(/<br>/g, '\n'),
        }
      }).filter((item: any) => item.id && item.name)
      items.push(...batch)
      if (batch.length < apiLimit()) break
    } else {
      const content = data.content
      total = Number(content?.total_cnt ?? total) || total
      const batch = filterCategoryContent(content?.v_item)
      items.push(...batch)
      if (batch.length < apiLimit()) break
    }
  }
  const list = items.slice(start, start + limit).map(toSummary).filter(Boolean)
  return { list, page, limit, total: total || items.length, source: 'tx' as const }
}

/** 上游 filterList2 的字段映射 + song_cnt/play_cnt（trackCount/playCount 数字原值） */
const filterCategoryContent = (raw: any[]) =>
  (raw ?? []).map(({ basic }) => {
    const id = String(basic?.tid ?? '').trim()
    const name = String(basic?.title ?? '').trim()
    if (!id || !name) return null
    const playCount = Number(basic?.play_cnt ?? 0) || 0
    const cover = String(basic?.cover?.medium_url || basic?.cover?.default_url || '')
    return {
      id,
      name,
      img: cover,
      cover,
      author: basic?.creator?.nick ?? '',
      creator: basic?.creator?.nick ?? '',
      play_count: formatPlayCount(playCount),
      playCount,
      trackCount: Number(basic?.song_cnt ?? 0) || 0,
      total: Number(basic?.song_cnt ?? 0) || 0,
      desc: String(basic?.desc ?? '').replace(/<br>/g, '\n'),
      description: String(basic?.desc ?? '').replace(/<br>/g, '\n'),
      source: 'tx' as const,
    }
  }).filter(Boolean)

/** 推荐歌单（上游 GetRecommendedPlaylists：musicu.fcg get_hot_recommend） */
export const getRecommended = async(page = 1, limit = 20) => {
  const { statusCode, body } = await httpFetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'post',
    headers: {
      'User-Agent': UA,
      Referer: 'https://y.qq.com/',
      'Content-Type': 'application/json',
    },
    body: {
      comm: { ct: 24 },
      recomPlaylist: {
        method: 'get_hot_recommend',
        module: 'playlist.HotRecommendServer',
        param: { async: 1, cmd: 2 },
      },
    },
    timeout: 15000,
  }).promise

  if (statusCode !== 200 || body?.code != 0) {
    throw new Error(`tx 推荐歌单获取失败 (code ${body?.code ?? statusCode})`)
  }
  const vHot: any[] = body?.recomPlaylist?.data?.v_hot ?? []
  const list = vHot.map((item: any) => {
    const id = String(item?.content_id ?? item?.dissid ?? item?.id ?? item?.tid ?? '').trim()
    const name = String(item?.title ?? item?.dissname ?? item?.name ?? '').trim()
    if (!id || !name) return null
    const cover = String(item?.cover ?? item?.imgurl ?? '')
    const playCount = Number(item?.listen_num ?? item?.listennum ?? 0) || 0
    return {
      id,
      name,
      cover: cover.startsWith('http://') ? cover.replace('http://', 'https://') : cover,
      trackCount: Number(item?.song_cnt ?? item?.song_count ?? item?.songnum ?? 0) || 0,
      playCount,
      play_count: formatPlayCount(playCount),
      creator: String(item?.username ?? item?.creator?.nick ?? '').trim(),
      description: '',
      link: playlistLink(id),
      source: 'tx' as const,
    }
  }).filter(Boolean)
  if (!list.length) throw new Error('no recommended playlists found')

  const start = Math.max(0, (page - 1) * limit)
  return { list: list.slice(start, start + limit), page, limit, total: list.length, source: 'tx' as const }
}

export const getRecommendedPlaylists = getRecommended

/** 上游 extractQQPlaylistID：支持现代 ryqq 路由 / 老版详情页 id、disstid 查询；拒绝非歌单链接 */
export const extractPlaylistId = (link: string): string | null => {
  const raw = String(link ?? '').trim()
  if (!raw) return null

  try {
    const parsed = new URL(raw)
    const pathValue = parsed.pathname.toLowerCase()
    if (pathValue.includes('playlist')) {
      for (const key of ['id', 'disstid', 'dissid']) {
        const id = normalizePlaylistId(parsed.searchParams.get(key) ?? '')
        if (id) return id
      }
    }
    const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/')
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].toLowerCase() === 'playlist' && i + 1 < parts.length) {
        const id = normalizePlaylistId(parts[i + 1])
        if (id) return id
      }
    }
  } catch {
    // 非 URL（裸 id）走下方兜底
  }

  const match = /(?:^|\/)playlist\/(\d+)(?:[/?#]|$)/.exec(raw)
  if (match) return match[1]
  return null
}

const normalizePlaylistId = (value: string): string => {
  const trimmed = String(value ?? '').trim()
  if (!trimmed || !/^\d+$/.test(trimmed)) return ''
  return trimmed
}

/** 歌单链接解析（上游 ParsePlaylist）：提取 disstid 后取详情；短链走 handleParseId 重定向兜底 */
export const parsePlaylistLink = async(link: string) => {
  const raw = String(link ?? '').trim()
  if (!raw) throw new Error('无效的QQ音乐歌单链接')
  // 明确是歌曲/专辑页时直接拒绝，避免把其中的数字 id 误判为歌单（上游同样拒绝）
  if (!/playlist/i.test(raw) && /(albumDetail|\/album\/|albummid=|songDetail|\/song\/|songmid=|[?&]songid=)/.test(raw)) {
    throw new Error('无效的QQ音乐歌单链接')
  }

  let id = extractPlaylistId(raw)
  if (!id && !/\d/.test(raw)) throw new Error('无效的QQ音乐歌单链接')
  if (!id) {
    // 纯数字裸 id 或短链：复用 songList 的 ID 归一（含 302 兜底）
    try {
      id = await songList.getListId(raw)
    } catch {
      id = ''
    }
  }
  if (!id) throw new Error('无效的QQ音乐歌单链接')
  return getPlaylistDetail(id)
}

export default {
  searchPlaylist,
  getPlaylistDetail,
  getPlaylistSongs,
  getCategories,
  getCategoryPlaylists,
  getRecommended,
  getRecommendedPlaylists,
  parsePlaylistLink,
  extractPlaylistId,
}
