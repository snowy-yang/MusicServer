// 汽水音乐搜索（App 搜索接口直连）
// 接口: https://api.qishui.com/luna/search/track?<公共参数>&q=<关键词>&cursor=
// 两条通道（同一接口，差在公共参数与签名，返回结构一致）：
//   官方 PC 通道: PC 签名可用（签名服务器或固定值，见 sdk/qs/mssdk.ts）时优先——
//                 luna_pc 参数 + X-Helios/X-Medusa；签名失败/被风控自动降级安卓通道；
//   安卓指纹通道: 静态安卓设备参数，缺参数或用 PC 参数不签名会被静默风控（200 + 空 body）；
//                 被风控时需换新指纹。
import { sizeFormate, formatPlayTime } from '../index.ts'
import { httpFetch } from '../common/request.ts'
import { coverUrl } from './musicInfo.ts'
import { mssdkAvailable, signQishuiRequest, pcCommonParams, PC_UA } from './mssdk.ts'

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
const PC_PAGE_SIZE = 20

// PC 通道必须配 X-Helios/X-Medusa（否则上游 200 + 空 body）；安卓通道用静态设备指纹
const buildSearchUrl = (str: string, cursor: number, count: number, pcChannel: boolean) => {
  const params = pcChannel
    ? new URLSearchParams({
      ...pcCommonParams(),
      q: str,
      cursor: String(cursor),
      search_id: '',
      search_method: 'input',
      debug_params: '',
      from_search_id: '',
      search_scene: 'normal',
      scene_name: 'search',
    })
    : new URLSearchParams({
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
  handleSearchBody(rawBody, cursor, page) {
    const group = rawBody.result_groups.find(g => g?.data?.length) || { data: [], has_more: false }
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
  },
  async search(str, page = 1, limit, retryNum = 0, forceAndroid = false) {
    if (++retryNum > 3) return Promise.reject(new Error('try max num'))
    const pcChannel = !forceAndroid && mssdkAvailable()
    if (pcChannel) {
      // PC 通道每页固定 20 条（上游默认、不接受 count），cursor 必须按 20 步进，否则翻页与 limit 错位重叠
      const pageSize = PC_PAGE_SIZE
      const cursor = pageSize * (page - 1)
      const url = buildSearchUrl(str, cursor, pageSize, true)
      // 签名覆盖真实发出的头：先定头、再签、再发
      const headers: Record<string, string> = { 'User-Agent': PC_UA }
      const fallbackToAndroid = (reason: string) => {
        console.log(`[qs/search] PC 通道${reason}，降级安卓通道`)
        return this.search(str, page, limit, retryNum, true)
      }
      let body: any = null
      try {
        // 签名失败（服务器宕机/固定值被风控）与请求异常都降级安卓通道
        const signed = await signQishuiRequest(url, headers)
        if (!signed) return fallbackToAndroid('签名不可用')
        const searchRequest = await httpFetch(url, { method: 'get', headers: { ...headers, ...signed }, timeout: 15000 }).promise
        body = searchRequest.body
      } catch (err: any) {
        return fallbackToAndroid(`请求失败: ${err?.message ?? err}`)
      }
      // 被风控/无结果时上游不返回 result_groups（200 + {"extra":{"empty_search":1}}）
      if (!body?.result_groups) return fallbackToAndroid('空结果（疑似风控）')
      return this.handleSearchBody(body, cursor, page)
    }
    // 安卓指纹通道：无签名直发，空结果时换 _rticket 重试
    const pageSize = limit ?? this.limit
    const cursor = pageSize * (page - 1)
    const url = buildSearchUrl(str, cursor, pageSize, false)
    const headers: Record<string, string> = { 'User-Agent': SEARCH_UA }
    const { body } = await httpFetch(url, { method: 'get', headers, timeout: 15000 }).promise
    if (!body?.result_groups) return this.search(str, page, limit, retryNum)
    return this.handleSearchBody(body, cursor, page)
  },
}
