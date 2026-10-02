// 猫耳FM 搜索（双通道聚合，与网页版对齐）
// 广播剧（置顶）: https://www.missevan.com/dramaapi/search?s=&page= → info.Datas[]（id/name/author/cover/abstract）
//   ——网页版搜索排前面的正剧来自这里；getsearch 的 type 参数只有 1UP主/2音单/3声音/4声优，没有剧集类型
// 声音（补足）:   https://www.missevan.com/sound/getsearch?s=&p=&type=3&page_size=&sort=2 → info.Datas[]
// 剧条目 songmid 用 "d:<drama_id>" 前缀（取流时自动取首个免费集，见 apis/me.ts）；声音条目为裸 sound_id
import { httpFetch } from '../request.ts'
import { formatPlayTime } from '../index.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
const H = { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://www.missevan.com/sound/search' }

const searchDramas = async(keyword: string, page: number, limit: number) => {
  const { statusCode, body } = await httpFetch(`https://www.missevan.com/dramaapi/search?s=${encodeURIComponent(keyword)}&page=${page}`, { headers: H, timeout: 15000 }).promise as any
  if (statusCode != 200 || body?.success === false) return []
  return (body?.info?.Datas ?? []).slice(0, limit).map((item: any) => ({
    songmid: `d:${item.id}`,
    name: item.name || '',
    singer: item.author || '',
    albumId: String(item.id),
    albumName: item.name || '',
    interval: 0,
    payPlay: true,
    img: item.cover || null,
    lrc: '',
    lrcx: '',
    types: [],
    _types: {},
    disabled: false,
  }))
}

const searchSounds = async(keyword: string, page: number, limit: number) => {
  const { statusCode, body } = await httpFetch(
    `https://www.missevan.com/sound/getsearch?s=${encodeURIComponent(keyword)}&p=${page}&type=3&page_size=${limit}&sort=2`,
    { headers: H, timeout: 15000 },
  ).promise as any
  if (statusCode != 200 || body?.success === false) return []
  return (body?.info?.Datas ?? []).map((item: any) => ({
    songmid: String(item.id),
    name: item.soundstr || '',
    singer: item.username || '',
    albumId: '',
    albumName: '',
    interval: item.duration ? formatPlayTime(Math.round(Number(item.duration) / 1000)) : 0,
    payPlay: Number(item.pay_type) > 0,
    img: item.front_cover || null,
    lrc: '',
    lrcx: '',
    types: [],
    _types: {},
    disabled: false,
  }))
}

export const search = async(keyword: string, page = 1, limit = 20) => {
  // 剧优先置顶（约六成配额），零散声音补足；剧集翻页直接传 page
  const [dramas, sounds] = await Promise.all([
    searchDramas(keyword, page, Math.max(4, Math.floor(limit * 0.6))).catch(() => []),
    searchSounds(keyword, page, limit).catch(() => []),
  ])
  const list = [...dramas, ...sounds].slice(0, limit)
  return {
    allPage: page + (list.length >= limit ? 1 : 0),
    total: dramas.length + sounds.length,
    limit,
    source: 'me' as const,
    list,
  }
}

export default { search }
