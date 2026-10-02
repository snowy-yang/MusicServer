// 汽水音乐设备注册 —— i.snssdk.com 统一设备服务（按 body 里的 aid 分 app）
// 接口: POST https://i.snssdk.com/service/2/device_register/?tt_data=a（TT 加密 body，免签名）
// 实测（2026-10-01）aid=386088 可注册成功，返回 device_id/install_id/device_token。
// 设备身份持久化于 data/auth.json 的 _qs_device 字段（复用注册=同一台"设备"，避免重复注册）
import { httpFetch } from '../common/request.ts'
import { getCredentials, setCredentials } from '../auth/store.ts'
import { encryptTT } from './crypto/ttencrypt.ts'

const REGISTER_URL = 'https://i.snssdk.com/service/2/device_register/?tt_data=a'

// 与签名查询参数一致的设备画像（注册后不再变化）
const DEVICE_FINGERPRINT = {
  device_type: 'ABR-AL80',
  device_brand: 'HUAWEI',
  device_model: 'ABR-AL80',
  os_version: '15',
  os_api: 35,
  resolution: '1080*1920',
  dpi: 480,
  channel: 'xiaomi_8478_64',
}

const ANDROID_VERSIONS = ['10', '11', '12', '13', '14']
const HEX_LOW = '0123456789abcdef'
const pick = (list: readonly string[]) => list[Math.floor(Math.random() * list.length)]
const randomHex = (k: number) => Array.from({ length: k }, () => HEX_LOW[Math.floor(Math.random() * 16)]).join('')
const uuid = () => crypto.randomUUID()

export interface QsDevice {
  device_id: string
  install_id: string
  device_token?: string
  device_type: string
  device_brand: string
  device_model: string
  os_version: string
  channel: string
  openudid: string
  cdid: string
  registeredAt?: string
}

const buildRequestBody = () => {
  const osVersion = pick(ANDROID_VERSIONS)
  const genTime = Date.now()
  return {
    magic_tag: 'ss_app_log',
    header: {
      display_name: '汽水音乐',
      aid: 386088,
      channel: DEVICE_FINGERPRINT.channel,
      package: 'com.luna.music',
      sdk_version: '3.7.0-rc.25-luna-music',
      sdk_target_version: 29,
      git_hash: '711d1a7',
      density_dpi: DEVICE_FINGERPRINT.dpi,
      display_density: 'xhdpi',
      resolution: DEVICE_FINGERPRINT.resolution,
      language: 'zh',
      timezone: 8,
      access: 'wifi',
      not_request_sender: 0,
      carrier: 'CHINA MOBILE',
      mcc_mnc: '46000',
      region: 'CN',
      tz_name: 'Asia/Shanghai',
      tz_offset: 28800,
      sim_region: 'cn',
      sim_serial_number: [],
      oaid_may_support: false,
      device_platform: 'android',
      custom: { host_bit: 32 },
      pre_installed_channel: '',
      is_system_app: 0,
      sdk_flavor: 'china',
      guest_mode: 0,
      os: 'Android',
      os_version: osVersion,
      os_api: DEVICE_FINGERPRINT.os_api,
      device_model: DEVICE_FINGERPRINT.device_model,
      device_brand: DEVICE_FINGERPRINT.device_brand,
      device_manufacturer: DEVICE_FINGERPRINT.device_brand,
      cpu_abi: 'arm64-v8a',
      release_build: randomHex(7),
      cdid: uuid(),
      sig_hash: 'a4a27c2633195374c15651ffc3c4a497',
      openudid: randomHex(20),
      clientudid: uuid(),
      req_id: uuid(),
      rom: randomHex(14).toUpperCase(),
      apk_first_install_time: genTime - Math.floor(Math.random() * 365) * 86_400_000,
      ipv6_list: [
        { type: 'client_anpi', value: '::1' },
        { type: 'client_anpi', value: 'fd9d:8e11:8c31:2a2c:0:0:0:1' },
      ],
    },
    _gen_time: genTime,
  }
}

/** 注册新设备并持久化 */
export const registerDevice = async (): Promise<QsDevice> => {
  const body = buildRequestBody()
  const encrypted = encryptTT(Buffer.from(JSON.stringify(body)))
  const request = httpFetch(REGISTER_URL, {
    method: 'post',
    headers: {
      'User-Agent': 'okhttp/4.10.0',
      'Content-Type': 'application/octet-stream; tt-data=a',
    },
    body: encrypted,
    timeout: 15000,
  })
  const { statusCode, body: resBody } = await request.promise
  const data = resBody as any
  if (statusCode != 200 || !data?.device_id_str || !data?.install_id_str) {
    throw new Error(`设备注册失败: HTTP ${statusCode} ${JSON.stringify(data).slice(0, 120)}`)
  }
  const device: QsDevice = {
    device_id: String(data.device_id_str),
    install_id: String(data.install_id_str),
    device_token: data.device_token ? String(data.device_token) : '',
    device_type: DEVICE_FINGERPRINT.device_type,
    device_brand: DEVICE_FINGERPRINT.device_brand,
    device_model: DEVICE_FINGERPRINT.device_model,
    os_version: DEVICE_FINGERPRINT.os_version,
    channel: DEVICE_FINGERPRINT.channel,
    openudid: body.header.openudid,
    cdid: body.header.cdid,
  }
  setCredentials('_qs_device', device as any)
  console.log(`[qs/device] 设备注册成功: device_id=${device.device_id}`)
  return device
}

let cachedDevice: QsDevice | null = null

/** 取当前设备（无则注册并持久化） */
export const getDevice = async (): Promise<QsDevice> => {
  if (cachedDevice) return cachedDevice
  const stored = getCredentials('_qs_device') as QsDevice | null
  if (stored?.device_id && stored?.install_id) {
    cachedDevice = stored
    return cachedDevice
  }
  cachedDevice = await registerDevice()
  return cachedDevice
}

/** 设备是否已注册（不触发注册） */
export const hasDevice = (): boolean =>
  Boolean(cachedDevice || (getCredentials('_qs_device') as QsDevice | null)?.device_id)

/**
 * 设备身份（同步读，不触发注册）：已注册设备优先；尚未注册时用独立生成的
 * `_qs_passport_device`，避免覆盖注册记录。护照/签名模块共用，保证「同一设备」。
 */
export const getDeviceIds = (): { deviceId: string; installId: string } => {
  const registered = getCredentials('_qs_device') as QsDevice | null
  if (registered?.device_id && registered?.install_id) {
    return { deviceId: String(registered.device_id), installId: String(registered.install_id) }
  }
  const existing = getCredentials('_qs_passport_device') as { deviceId?: string; installId?: string } | null
  if (existing?.deviceId && existing.installId) return { deviceId: String(existing.deviceId), installId: String(existing.installId) }
  const now = Date.now()
  const ids = { deviceId: String(now), installId: String(now + 1) }
  setCredentials('_qs_passport_device', ids)
  return ids
}

export default { registerDevice, getDevice, hasDevice, getDeviceIds }
