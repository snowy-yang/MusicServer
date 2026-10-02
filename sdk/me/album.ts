// 猫耳FM 广播剧集列表（web 通道，匿名免签）
// 接口: https://www.missevan.com/dramaapi/getdramaepisodes?drama_id=&season=&page=&order=0&pageSize=
// 结果在 info.episodes.episode[]（name/sound_id/pay_type/vip）；剧名在 info.drama.name
// 注意：getdrama（不带 episodes）必须带 type=2 且 seasons 只含各季首集，列表用本接口
import { httpFetch } from '../request.ts'
import { formatPlayTime } from '../index.ts'

const EPISODES_URL = 'https://www.missevan.com/dramaapi/getdramaepisodes'

export const getAlbumDetail = async(dramaId: string, page = 1, limit = 30) => {
  const { statusCode, body } = await httpFetch(
    `${EPISODES_URL}?drama_id=${dramaId}&season=1&page=${page}&order=0&pageSize=${Math.max(30, limit)}`,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        Referer: `https://www.missevan.com/mdrama/drama/${dramaId}`,
        Accept: 'application/json',
      },
      timeout: 15000,
    },
  ).promise as any
  if (statusCode != 200 || body?.success === false) {
    throw new Error(body?.info || `获取剧集失败（HTTP ${statusCode}）`)
  }
  const info = body?.info ?? {}
  const drama = info.drama ?? {}
  const episodes = info.episodes?.episode ?? []
  return {
    info: { name: drama.name || String(dramaId), total: episodes.length },
    list: episodes.slice(0, limit).map((item: any) => ({
      songmid: String(item.sound_id),
      name: item.name || '',
      singer: drama.name || '',
      albumId: String(dramaId),
      albumName: drama.name || '',
      interval: item.duration ? formatPlayTime(Math.round(Number(item.duration) / 1000)) : 0,
      payPlay: Number(item.pay_type) > 0,
      img: drama.cover || null,
      lrc: '',
      lrcx: '',
      types: [],
      _types: {},
      disabled: false,
    })),
    total: episodes.length,
    limit,
    allPage: 1,
    source: 'me' as const,
  }
}

export default { getAlbumDetail }
