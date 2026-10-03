// 咪咕音乐搜索 —— search_all.do（Android_migu 参数），searchSwitch 控制返回类别
// 上游对应：music-lib/migu/migu.go 的 (*Migu).Search
import { buildUrl, convertItemToSong, miguGet, type MiguSongItem } from './util.ts'

export const SEARCH_ALL_URL = 'http://pd.musicapp.migu.cn/MIGUM2.0/v1.0/content/search_all.do'

/** 搜索开关：只开某一类（song/album/songlist），bestShow 保留最优推荐 */
export const searchSwitch = (kind: 'song' | 'album' | 'songlist'): string => JSON.stringify({
  song: kind === 'song' ? 1 : 0,
  album: kind === 'album' ? 1 : 0,
  singer: 0,
  tagSong: 0,
  mvSong: 0,
  songlist: kind === 'songlist' ? 1 : 0,
  bestShow: 1,
})

export const searchAll = async(text: string, kind: 'song' | 'album' | 'songlist', page = 1, limit = 20): Promise<any> => {
  const url = buildUrl(SEARCH_ALL_URL, {
    ua: 'Android_migu',
    version: '5.0.1',
    text,
    pageNo: page,
    pageSize: limit,
    searchSwitch: searchSwitch(kind),
  })
  return miguGet(url)
}

export const search = async(keyword: string, page = 1, limit = 20) => {
  const body = await searchAll(keyword, 'song', page, limit)
  const result: MiguSongItem[] = body?.songResultData?.result ?? []
  const list = result.map(item => convertItemToSong(item, true)).filter((s): s is NonNullable<typeof s> => s != null)
  const total = parseInt(String(body?.songResultData?.totalCount ?? list.length), 10) || list.length
  return {
    list,
    allPage: Math.max(1, Math.ceil(total / limit)),
    total,
    limit,
    source: 'mg' as const,
  }
}

export default { search }
