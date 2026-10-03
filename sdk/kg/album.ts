import { getMusicInfosByList } from './musicInfo.ts'
import { createHttpFetch } from './util.ts'
import { httpFetch } from '../common/request.ts'

const albumCover = (url: any): string => String(url ?? '').replace('{size}', '240')

export default {
  /**
   * 通过AlbumId获取专辑信息
   * @param {*} id
   */
  async getAlbumInfo(id) {
    const albumInfoRequest = await createHttpFetch('http://kmrserviceretry.kugou.com/container/v1/album?dfid=1tT5He3kxrNC4D29ad1MMb6F&mid=22945702112173152889429073101964063697&userid=0&appid=1005&clientver=11589', {
      method: 'POST',
      body: {
        appid: 1005,
        clienttime: 1681833686,
        clientver: 11589,
        data: [{ album_id: id }],
        fields: 'language,grade_count,intro,mix_intro,heat,category,sizable_cover,cover,album_name,type,quality,publish_company,grade,special_tag,author_name,publish_date,language_id,album_id,exclusive,is_publish,trans_param,authors,album_tag',
        isBuy: 0,
        key: 'e6f3306ff7e2afb494e89fbbda0becbf',
        mid: '22945702112173152889429073101964063697',
        show_album_tag: 0,
      },
    })
    if (!albumInfoRequest) return Promise.reject(new Error('get album info failed.'))
    const albumInfo = albumInfoRequest[0]

    return {
      name: albumInfo.album_name,
      image: albumInfo.sizable_cover.replace('{size}', 240),
      desc: albumInfo.intro,
      authorName: albumInfo.author_name,
      // play_count: this.formatPlayCount(info.count),
    }
  },
  /**
   * 通过AlbumId获取专辑
   * @param {*} id
   * @param {*} page
   */
  async getAlbumDetail(id, page = 1, limit = 200) {
    const albumList = await createHttpFetch(`http://mobiles.kugou.com/api/v3/album/song?version=9108&albumid=${id}&plat=0&pagesize=${limit}&area_code=0&page=${page}&with_res_tag=0`)
    if (!albumList.info) return Promise.reject(new Error('Get album list failed.'))

    let result = await getMusicInfosByList(albumList.info)

    const info = await this.getAlbumInfo(id)

    return {
      list: result || [],
      page,
      limit,
      total: albumList.total,
      source: 'kg',
      info: {
        name: info.name,
        img: info.image,
        desc: info.desc,
        author: info.authorName,
        // play_count: this.formatPlayCount(info.count),
      },
    }
  },
  /**
   * 专辑搜索（上游 kugou SearchAlbum：mobilecdn v3 search/album）
   * 返回摘要统一形状（对齐契约：id/name/cover/trackCount/creator/description/link/source）
   */
  async searchAlbum(keyword, page = 1, limit = 10) {
    const word = String(keyword ?? '').trim()
    if (!word) return { source: 'kg', list: [], page, limit, total: 0 }
    const pageNo = Math.max(1, Number(page) || 1)
    const pageSize = Math.max(1, Number(limit) || 10)
    const apiURL = `http://mobilecdn.kugou.com/api/v3/search/album?keyword=${encodeURIComponent(word)}&format=json&page=${pageNo}&pagesize=${pageSize}`
    const { statusCode, body } = await httpFetch(apiURL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1',
        Referer: 'http://m.kugou.com',
      },
      timeout: 15000,
    }).promise
    if (statusCode !== 200 || body?.status !== 1 || body?.errcode !== 0) {
      throw new Error(body?.error || '酷狗专辑搜索失败')
    }
    const list = (body?.data?.info ?? []).map((item: any) => {
      const albumID = String(item?.albumid ?? '').trim()
      if (!albumID || albumID === '0') return null
      return {
        id: albumID,
        name: String(item?.albumname ?? '').trim(),
        cover: albumCover(item?.imgurl),
        trackCount: Number(item?.songcount ?? 0) || 0,
        creator: String(item?.singername ?? '').trim(),
        description: String(item?.intro ?? '').trim(),
        publishTime: String(item?.publishtime ?? '').trim(),
        link: `https://www.kugou.com/album/${albumID}.html`,
        source: 'kg',
        type: 'album',
      }
    }).filter(Boolean)
    return { source: 'kg', list, page: pageNo, limit: pageSize, total: Number(body?.data?.total ?? 0) || list.length }
  },
  /** 上游 GetAlbumSongs：复用 getAlbumDetail 拉全量曲目 */
  async getAlbumSongs(id) {
    const albumID = String(id ?? '').trim()
    if (!albumID) throw new Error('酷狗专辑 id 为空')
    const { list } = await this.getAlbumDetail(albumID, 1, 10000)
    return list
  },
  /** 上游 ParseAlbum：album/single/<id>.html、album/<id>.html、albumid=<id> */
  async parseAlbumLink(link) {
    const raw = String(link ?? '')
    const patterns = [
      /album\/single\/(\d+)\.html/,
      /yy\/album\/single\/(\d+)\.html/,
      /album\/(\d+)\.html/,
      /albumid=(\d+)/,
    ]
    for (const pattern of patterns) {
      const match = raw.match(pattern)
      if (match) return this.getAlbumDetail(match[1], 1)
    }
    throw new Error('无效的酷狗专辑链接')
  },
}
