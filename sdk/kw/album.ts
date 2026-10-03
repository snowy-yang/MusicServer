import { httpFetch } from '../common/request.ts'
import { decodeName } from '../index.ts'
import { formatSinger, objStr2JSON } from './util.ts'
import type { Quality } from '../types.ts'

const firstNonEmpty = (...values: any[]): string => {
  for (const value of values) {
    if (value == null) continue
    const str = String(value).trim()
    if (str) return str
  }
  return ''
}

// let requestObj_list
export default {
  limit_list: 36,
  limit_song: 1000,
  filterListDetail(rawList, albumName, albumId) {
    return rawList.map(item => {
      let formats = item.formats.split('|')
      let types: Array<{ type: Quality; size: string | null }> = []
      let _types: Partial<Record<Quality, { size: string | null }>> = {}
      if (formats.includes('MP3128')) {
        types.push({ type: '128k', size: null })
        _types['128k'] = {
          size: null,
        }
      }
      // if (formats.includes('MP3192')) {
      //   types.push({ type: '192k', size: null })
      //   _types['192k'] = {
      //     size: null,
      //   }
      // }
      if (formats.includes('MP3H')) {
        types.push({ type: '320k', size: null })
        _types['320k'] = {
          size: null,
        }
      }
      // if (formats.includes('AL')) {
      //   types.push({ type: 'ape', size: null })
      //   _types.ape = {
      //     size: null,
      //   }
      // }
      if (formats.includes('ALFLAC')) {
        types.push({ type: 'flac', size: null })
        _types.flac = {
          size: null,
        }
      }
      if (formats.includes('HIRFLAC')) {
        types.push({ type: 'flac24bit', size: null })
        _types.flac24bit = {
          size: null,
        }
      }
      // types.reverse()
      return {
        singer: formatSinger(decodeName(item.artist)),
        name: decodeName(item.name),
        albumName,
        albumId,
        songmid: item.id,
        source: 'kw',
        interval: null,
        img: item.pic,
        lrc: null,
        otherSource: null,
        types,
        _types,
        typeUrl: {},
      }
    })
  },
  /**
   * 格式化播放数量
   * @param {*} num
   */
  formatPlayCount(num: any) {
    if (num > 100000000) return parseInt((num / 10000000) as any) / 10 + '亿'
    if (num > 10000) return parseInt((num / 1000) as any) / 10 + '万'
    return num
  },
  getAlbumListDetail(id, page, retryNum = 0) {
    if (retryNum > 2) return Promise.reject(new Error('try max num'))
    const requestObj_listDetail = httpFetch(`http://search.kuwo.cn/r.s?pn=${page - 1}&rn=${this.limit_song}&stype=albuminfo&albumid=${id}&show_copyright_off=0&encoding=utf&vipver=MUSIC_9.1.0`)
    return requestObj_listDetail.promise.then(({ statusCode, body }) => {
      if (statusCode !== 200) return this.getAlbumListDetail(id, page, ++retryNum)
      body = objStr2JSON(body)
      if (!body.musiclist) return this.getAlbumListDetail(id, page, ++retryNum)
      body.name = decodeName(body.name)
      return {
        list: this.filterListDetail(body.musiclist, body.name, body.albumid),
        page,
        limit: this.limit_song,
        total: parseInt(body.songnum),
        source: 'kw',
        info: {
          name: body.name,
          img: body.img || body.hts_img,
          desc: decodeName(body.info),
          author: decodeName(body.artist),
          // play_count: this.formatPlayCount(body.playnum),
        },
      }
    })
  },
  /**
   * 专辑详情（统一形状；服务端 1000 条/页，limit 更小时本地按 page/limit 开窗）
   * 上游对应：kuwo.go fetchAlbumDetail（legacy API 部分）
   */
  async getAlbumDetail(id: string, page = 1, limit = 1000) {
    const albumID = String(id ?? '').trim()
    if (!albumID) throw new Error('酷我专辑 id 为空')
    const pageNo = Math.max(1, Number(page) || 1)
    const pageSize = Math.max(1, Number(limit) || this.limit_song)
    if (pageSize >= this.limit_song) return this.getAlbumListDetail(albumID, pageNo)

    const start = (pageNo - 1) * pageSize
    let serverPage = Math.floor(start / this.limit_song) + 1
    let skip = start % this.limit_song
    const list: any[] = []
    let info: any = null
    let total = 0
    while (list.length < pageSize && serverPage <= 50) {
      const res = await this.getAlbumListDetail(albumID, serverPage)
      if (!res) break
      if (!info) info = res.info ?? null
      total = Number(res.total ?? 0) || total
      const rawList: any[] = res.list ?? []
      if (!rawList.length) break
      list.push(...rawList.slice(skip, skip + (pageSize - list.length)))
      skip = 0
      if (rawList.length < this.limit_song) break
      if (total > 0 && list.length >= total) break
      serverPage += 1
    }
    return {
      source: 'kw',
      info: info ?? { name: albumID, img: '', desc: '', author: '' },
      list,
      page: pageNo,
      limit: pageSize,
      total: total || list.length,
    }
  },
  /** 上游 GetAlbumSongs：聚合全部分页曲目（去重） */
  async getAlbumSongs(id: string) {
    const albumID = String(id ?? '').trim()
    if (!albumID) throw new Error('酷我专辑 id 为空')
    const songs: any[] = []
    const seen = new Set<string>()
    for (let page = 1; page <= 50; page++) {
      const res = await this.getAlbumListDetail(albumID, page)
      const rawList: any[] = res?.list ?? []
      for (const song of rawList) {
        const key = String(song?.songmid ?? '')
        if (key && seen.has(key)) continue
        if (key) seen.add(key)
        songs.push(song)
      }
      const total = Number(res?.total ?? 0) || 0
      if (rawList.length < this.limit_song) break
      if (total > 0 && songs.length >= total) break
    }
    return songs
  },
  /**
   * 专辑搜索（上游 SearchAlbum，legacy r.s ft=album 路由；返回歌单/专辑统一摘要形状）
   */
  async searchAlbum(keyword: string, page = 1, limit = 10) {
    const word = String(keyword ?? '').trim()
    if (!word) return { source: 'kw' as const, list: [] as any[], page, limit, total: 0 }
    const pageNo = Math.max(1, Number(page) || 1)
    const pageSize = Math.max(1, Number(limit) || 10)
    const apiURL = 'http://search.kuwo.cn/r.s?' + [
      `all=${encodeURIComponent(word)}`,
      'ft=album',
      'itemset=web_2013',
      'client=kt',
      'pcmp4=1',
      'geo=c',
      'vipver=1',
      `pn=${pageNo - 1}`,
      `rn=${pageSize}`,
      'rformat=json',
      'encoding=utf8',
    ].join('&')

    const { statusCode, body } = await httpFetch(apiURL).promise
    if (statusCode !== 200) throw new Error('酷我专辑搜索失败')
    const data = typeof body === 'string' ? (() => { try { return objStr2JSON(body) } catch { return null } })() : body
    if (!data?.albumlist) throw new Error('酷我专辑搜索失败')

    const list = (data.albumlist as any[]).map(item => {
      const albumID = firstNonEmpty(item.albumid, item.id)
      if (!albumID) return null
      return {
        id: albumID,
        name: decodeName(String(item.name ?? '').trim()),
        cover: firstNonEmpty(item.hts_img, item.img),
        trackCount: parseInt(String(item.musiccnt ?? ''), 10) || 0,
        playCount: parseInt(String(item.PLAYCNT ?? item.playcnt ?? ''), 10) || 0,
        creator: decodeName(firstNonEmpty(item.aartist, item.artist)),
        description: decodeName(String(item.info ?? '').trim()),
        link: `http://www.kuwo.cn/album_detail/${albumID}`,
        source: 'kw' as const,
        type: 'album',
        company: decodeName(String(item.company ?? '').trim()),
        publishTime: String(item.pub ?? '').trim(),
      }
    }).filter(Boolean)

    return {
      source: 'kw' as const,
      list,
      page: pageNo,
      limit: pageSize,
      total: parseInt(String(data.TOTAL ?? data.total ?? ''), 10) || list.length,
    }
  },
  /** 上游 ParseAlbum：album_detail/<id>、album/<id>、albumid=<id> */
  async parseAlbumLink(link: string) {
    const raw = String(link ?? '')
    const patterns = [/album_detail\/(\d+)/, /album\/(\d+)/, /albumid=(\d+)/]
    for (const pattern of patterns) {
      const match = raw.match(pattern)
      if (match) return this.getAlbumDetail(match[1]!, 1)
    }
    throw new Error('无效的酷我专辑链接')
  },
}
