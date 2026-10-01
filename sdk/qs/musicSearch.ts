// 汽水音乐搜索（App 搜索接口直连）
// 接口: https://api.qishui.com/luna/search/track?<安卓设备参数>&q=<关键词>&cursor=&count=
// 实测（2026-10-01）匿名可搜索；关键在安卓 App 的设备参数指纹——
// 缺参数或用 PC 端参数（device_platform=windows）上游会静默风控，返回 200 + 空 body
import { sizeFormate, formatPlayTime } from '../index.ts'
import { httpFetch } from '../request.ts'
import { coverUrl } from './musicInfo.ts'

// 安卓 App 设备参数指纹（社区验证可用的静态设备 id，与 musicdl 一致；被风控时需换新）
const SEARCH_DEVICE_PARAMS = {
  device_platform: 'android',
  os: 'android',
  ssmix: 'a',
  cdid: '46556f98-1720-4248-83da-62b74b60b46a',
  channel: 'xiaomi_8478_64',
  aid: '386088',
  app_name: 'luna',
  version_code: '100198030',
  version_name: '19.8.0',
  manifest_version_code: '100198030',
  update_version_code: '100198030',
  resolution: '1080*1920',
  dpi: '480',
  device_type: 'ABR-AL80',
  device_brand: 'HUAWEI',
  language: 'zh',
  os_api: '35',
  os_version: '15',
  ac: 'wifi',
  device_model: 'ABR-AL80',
  save_power: '0',
  font_size: '1.00',
  luna_first_launch_apk_type: 'normal_apk',
  diversion_channel_name: 'xiaomi_8478_64',
  is_car_play: '0',
  battery: '0.99',
  network_speed: '10156',
  hybrid_version_code: '100198030',
  tz_name: 'Asia/Shanghai',
  tz_offset: '28800',
  luna_register_time: '1784311292',
  package: 'com.luna.music',
  charge: '0',
  luna_apk_type: 'normal_apk',
  output_device_type: 'Phone',
  volume: '1.00',
  brightness: '0.08',
  need_personal_recommend: '1',
  is_teen_mode: '0',
  sim_region: 'cn',
  android_device_type: 'default',
  iid: '2204957404569386',
  device_id: '2204957404565290',
}

const SEARCH_UA = 'Luna/19.8.0 (com.luna.music/100198030);Android 15;ABR-AL80'

const buildSearchUrl = (str: string, cursor: number, count: number) => {
  const params = new URLSearchParams({
    ...SEARCH_DEVICE_PARAMS,
    _rticket: String(Date.now()),
    q: str,
    cursor: String(cursor),
    count: String(count),
  })
  return `https://api.qishui.com/luna/search/track?${params.toString()}`
}

export default {
  limit: 30,
  total: 0,
  page: 0,
  allPage: 1,
  getSinger(artists) {
    return (artists || []).map(singer => singer.name).filter(Boolean).join('、')
  },
  handleResult(rawList) {
    if (!rawList) return []
    return rawList.map(item => {
      const track = item?.entity?.track
      if (!track?.id) return null
      // types 反映匿名实际可获取的资源：30 秒试听（preview.bit_rates 为试听码率）
      // track.bit_rates 是完整曲目码率元数据（66k~hi_res），但匿名无权取流，不对外声明
      const previewSize = track.preview?.bit_rates?.[0]?.size
      const size = previewSize ? sizeFormate(previewSize) : null
      const types = [{ type: '128k', size }]
      const _types = { '128k': { size } }
      return {
        singer: this.getSinger(track.artists),
        name: track.name,
        albumName: track.album?.name ?? null,
        albumId: track.album?.id ?? null,
        source: 'qs',
        interval: formatPlayTime(track.duration / 1000),
        songmid: String(track.id),
        img: coverUrl(track.album),
        lrc: null,
        types,
        _types,
        typeUrl: {},
      }
    }).filter(Boolean)
  },
  search(str, page = 1, limit, retryNum = 0) {
    if (++retryNum > 3) return Promise.reject(new Error('try max num'))
    if (limit == null) limit = this.limit
    const cursor = limit * (page - 1)
    const searchRequest = httpFetch(buildSearchUrl(str, cursor, limit), {
      method: 'get',
      headers: { 'User-Agent': SEARCH_UA },
      timeout: 15000,
    })
    return searchRequest.promise.then(({ body }) => {
      // 被风控/无结果时上游不返回 result_groups（200 + {"extra":{"empty_search":1}}），重试
      if (!body?.result_groups) return this.search(str, page, limit, retryNum)
      const group = body.result_groups.find(g => g?.data?.length) || { data: [], has_more: false }
      const list = this.handleResult(group.data)
      const total = group.has_more ? cursor + list.length + 1 : cursor + list.length
      this.total = total
      this.page = page
      this.allPage = group.has_more ? page + 1 : page
      return {
        list,
        allPage: this.allPage,
        limit: this.limit,
        total,
        source: 'qs',
      }
    })
  },
}
