// 汽水官方 PC 客户端签名（X-Helios / X-Medusa）—— 可选增强，缺原生模块时整体降级
//
// 原理：直接复用官方客户端自带的原生模块 bdms.node（官方 main 进程就是
//   bdms.init({ deviceId }) → generateHttpSignatureHeaders(url, "名字\r\n值\r\n…")，
//   把返回的 name/value 成对写回请求头）。与 sodahub-org/libmssdk 同一套做法，
//   区别是我们进程内加载，不另起 HTTP 签名服务。
// 官方只对 qishui.com 且 **非** /passport/、非 /ttwid/ 的请求签名 —— 登录链路用不到本模块。
// 签名覆盖 URL + 全部请求头；POST 的 x-ss-stub（body 的 MD5 大写）既是签名输入也要随请求发出。
//
// 原生文件（官方客户端二进制，专有、不入库、不再分发）放置位置任选其一：
//   1) 环境变量 QS_MSSDK_DIR 指向同时含 bdms.node 与 metasecml.dll 的目录
//   2) 仓库根 soda-mssdk/（已 gitignore）
//   3) 本机已安装的官方客户端：%LOCALAPPDATA%\Programs\Soda Music\<版本>\resources\app.asar.unpacked
// 从安装包提取：官方 SodaMusic-v*-official-win32_x64.exe → Bandizip 解 NSIS →
//   $Var31/app.7z → resources/app.asar.unpacked/{bdms.node, metasecml.dll}
import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDeviceIds } from './device.ts'

const require = createRequire(import.meta.url)

const MODULE_NAME = 'bdms.node'
const CLIENT_DIR_NAMES = ['Soda Music', 'SodaMusic', '汽水音乐']
// 仓库根（本文件在 sdk/qs/ 下）——不依赖 process.cwd()，从任何目录启动都能找到
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const findModuleDir = (): string | null => {
  const candidates: string[] = []
  if (process.env.QS_MSSDK_DIR) candidates.push(process.env.QS_MSSDK_DIR)
  candidates.push(join(REPO_ROOT, 'soda-mssdk'))
  const localAppData = process.env.LOCALAPPDATA
  if (localAppData) {
    for (const name of CLIENT_DIR_NAMES) {
      const root = join(localAppData, 'Programs', name)
      if (!existsSync(root)) continue
      try {
        for (const ver of readdirSync(root)) candidates.push(join(root, ver, 'resources', 'app.asar.unpacked'))
      } catch {
        // 读不到目录就跳过
      }
    }
  }
  return candidates.find(dir => dir && existsSync(join(dir, MODULE_NAME))) ?? null
}

interface BdmsModule {
  init: (options: { deviceId: string }) => unknown
  generateHttpSignatureHeaders: (url: string, headersLines: string) => string
}

let signer: { module: BdmsModule; deviceId: string; dir: string } | null | undefined

/** 懒加载官方签名模块（失败只提示一次，之后一律按不可用处理） */
const loadSigner = () => {
  if (signer !== undefined) return signer
  signer = null
  try {
    const dir = findModuleDir()
    if (!dir) return signer
    const mod = require(join(dir, MODULE_NAME)) as BdmsModule
    if (typeof mod?.init !== 'function' || typeof mod?.generateHttpSignatureHeaders !== 'function') {
      console.log(`[qs/mssdk] ${MODULE_NAME} 导出不符合预期，按不可用处理`)
      return signer
    }
    const { deviceId } = getDeviceIds()
    mod.init({ deviceId })
    signer = { module: mod, deviceId, dir }
    console.log(`[qs/mssdk] 官方签名模块已加载: ${dir} (device_id=${deviceId})`)
  } catch (err: any) {
    console.log(`[qs/mssdk] 官方签名模块不可用，降级: ${err?.message ?? err}`)
  }
  return signer
}

/** 官方签名是否可用（不影响主流程，仅决定走 PC 通道还是安卓通道） */
export const mssdkAvailable = (): boolean => Boolean(loadSigner())

/** 签名时绑定的设备（与请求 URL 里的 device_id/iid 必须一致） */
export const mssdkDeviceId = (): string => loadSigner()?.deviceId ?? ''

/**
 * 给一个 qishui.com 请求签名
 * @param headers 必须是「真实要发出去的那一份」（含 cookie / x-ss-stub）
 * @returns 需追加的头；不可用时返回 null（调用方走原通道）
 */
export const signQishuiRequest = (url: string, headers: Record<string, string>): Record<string, string> | null => {
  const current = loadSigner()
  if (!current) return null
  try {
    const lines = Object.entries(headers)
      .filter(([name, value]) => name && value != null)
      .map(([name, value]) => `${name}\r\n${value}`)
      .join('\r\n')
    const fields = String(current.module.generateHttpSignatureHeaders(url, lines)).split('\r\n').filter(Boolean)
    const signed: Record<string, string> = {}
    for (let i = 0; i + 1 < fields.length; i += 2) signed[fields[i]] = fields[i + 1]
    if (!signed['X-Helios'] && !signed['x-helios']) return null
    return signed
  } catch (err: any) {
    console.log(`[qs/mssdk] 签名失败，本次降级: ${err?.message ?? err}`)
    return null
  }
}

/** 官方 PC 端 UA（签名与 UA 绑定同一客户端版本） */
export const PC_UA = 'LunaPC/3.7.0(452316191)'

/** 官方 PC 端公共查询参数（与签名设备成套；track_v2 / search 等 luna_pc 接口共用） */
export const pcCommonParams = (): Record<string, string> => {
  const { deviceId, installId } = getDeviceIds()
  return {
    aid: '386088',
    app_name: 'luna_pc',
    region: 'cn',
    geo_region: 'cn',
    os_region: 'cn',
    sim_region: '',
    device_id: deviceId,
    cdid: '',
    iid: installId,
    version_name: '3.7.0',
    version_code: '30070000',
    channel: 'official',
    build_mode: 'master',
    network_carrier: '',
    ac: 'wifi',
    tz_name: 'Asia/Shanghai',
    resolution: '',
    device_platform: 'windows',
    device_type: 'Windows',
    os_version: 'Windows 11',
    fp: deviceId,
  }
}

export default { mssdkAvailable, mssdkDeviceId, signQishuiRequest, pcCommonParams, PC_UA }
