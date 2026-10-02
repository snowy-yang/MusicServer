// 猫耳FM 搜索（web 通道，匿名免签）
// 接口: https://www.missevan.com/sound/getsearch?s=&p=&type=3&page_size=30&sort=2
// 结果在 data.info.Datas[]（soundstr/username/id/pay_type/front_cover/duration 毫秒）
import { httpFetch } from '../request.ts'
import { formatPlayTime } from '../index.ts'

const SEARCH_URL = 'https://www.missevan.com/sound/getsearch'

export const search = (keyword: string, page = 1, limit = 20) =>
  httpFetch(`${SEARCH_URL}?s=${encodeURIComponent(keyword)}&p=${page}&type=3&page_size=${limit}&sort=2`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      Referer: 'https://www.missevan.com/',
      Accept: 'application/json',
    },
    timeout: 15000,
  }).promise.then(({ statusCode, body }: any) => {
    if (statusCode != 200 || body?.success === false) throw new Error(body?.info || '搜索失败')
    const docs = body?.info?.Datas ?? []
    const total = Number(body?.info?.pagination?.count ?? docs.length)
    return {
      allPage: Math.ceil(total / limit) || page,
      total,
      limit,
      source: 'me' as const,
      list: docs.map((item: any) => ({
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
      })),
    }
  })

export default { search }
