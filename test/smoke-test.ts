// 冒烟测试 —— 验证服务器各接口与各平台功能
// 运行：pnpm test（Node 22.18+ 直接以类型剥离方式运行 .ts）
//
// 覆盖：搜索（各平台 + 聚合）、URL（kw/wy/tx）、歌词、封面、榜单详情、热搜、歌单、
//       跨平台匹配 /find、歌手/专辑、路径参数风格路由、标准 HTTP 语义（404/405/422/302）、
//       文档页、旧 query 路由移除回归

import http from 'node:http'
import { spawn } from 'node:child_process'

// 本地默认 16688（避开 1024~15000 的动态端口冲突区），可用 PORT/BASE_URL 覆盖
const PORT = process.env.PORT || 16688
const BASE = process.env.BASE_URL || `http://localhost:${PORT}`
const results: { name: string; ok: boolean; detail?: any }[] = []

const get = (path: string): Promise<any> => new Promise((resolve, reject) => {
  http.get(`${BASE}${path}`, res => {
    let data = ''
    res.on('data', c => { data += c })
    res.on('end', () => {
      try { resolve(JSON.parse(data)) } catch { reject(new Error(`JSON parse failed: ${data.slice(0, 100)}`)) }
    })
  }).on('error', reject)
})

// 原始响应（不解析 JSON，用于 HTML 页与状态码断言）
const getRaw = (path: string): Promise<any> => new Promise((resolve, reject) => {
  http.get(`${BASE}${path}`, res => {
    let data = ''
    res.on('data', c => { data += c })
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
  }).on('error', reject)
})

const postRaw = (path: string): Promise<any> => new Promise((resolve, reject) => {
  const req = http.request(`${BASE}${path}`, { method: 'POST' }, res => {
    let data = ''
    res.on('data', c => { data += c })
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
  })
  req.on('error', reject)
  req.end()
})

// JSON POST（登录等写入接口）
const postJson = (path: string, body: any): Promise<any> => new Promise((resolve, reject) => {
  const payload = JSON.stringify(body)
  const req = http.request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
  }, res => {
    let data = ''
    res.on('data', c => { data += c })
    res.on('end', () => resolve({
      status: res.statusCode,
      body: (() => { try { return JSON.parse(data) } catch { return null } })(),
    }))
  })
  req.on('error', reject)
  req.write(payload)
  req.end()
})

const test = async(name: string, fn: () => Promise<any>) => {
  try {
    const result = await fn()
    results.push({ name, ok: true, detail: result })
    console.log(`✅ ${name}`)
  } catch (err: any) {
    results.push({ name, ok: false, detail: err.message })
    console.log(`❌ ${name}: ${err.message}`)
  }
}

/**
 * 检查本地服务器是否已在运行
 */
const isServerRunning = () => new Promise(resolve => {
  if (!BASE.startsWith('http://localhost:') && !BASE.startsWith('http://127.0.0.1:')) return resolve(true)
  const req = http.get(`${BASE}/health`, res => {
    res.resume()
    resolve(res.statusCode === 200)
  })
  req.on('error', () => resolve(false))
  req.setTimeout(2000, () => { req.destroy(); resolve(false) })
})

/**
 * 启动本地服务器并返回关闭句柄
 */
const startLocalServer = () => new Promise((resolve, reject) => {
  const proc = spawn(process.execPath, ['src/server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  proc.stdout.on('data', d => { stdout += d })
  proc.stderr.on('data', d => { stdout += d })

  const timer = setTimeout(() => {
    proc.kill()
    reject(new Error('启动本地服务器超时'))
  }, 10000)

  const check = () => {
    http.get(`${BASE}/health`, res => {
      res.resume()
      if (res.statusCode === 200) {
        clearTimeout(timer)
        resolve(proc)
      } else {
        setTimeout(check, 200)
      }
    }).on('error', () => setTimeout(check, 200))
  }
  setTimeout(check, 300)
})

let localServer: any = null
const running = await isServerRunning()
if (!running) {
  console.log('本地服务器未运行，正在自动启动...')
  localServer = await startLocalServer()
  console.log('本地服务器已启动\n')
} else {
  console.log('使用已运行的服务器\n')
}

// 搜索
for (const source of ['kw', 'kg', 'tx', 'wy', 'qs']) {
  await test(`搜索 ${source}`, async() => {
    const r = await get(`/search?source=${source}&name=${encodeURIComponent('稻香')}&limit=2`)
    if (r.code != 0) throw new Error(r.msg)
    if (!r.data?.list?.length) throw new Error('空列表')
    return `${r.data.list[0].name} / ${r.data.list[0].singer}`
  })
}

await test('聚合搜索', async() => {
  const r = await get(`/search?name=${encodeURIComponent('稻香')}&limit=2`)
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.list?.length) throw new Error('空列表')
  return `${r.data.list.length} 条结果`
})

// URL（用已知歌曲 id，路径参数风格）
// kw 匿名通道 2026-10-01 接入 mobi.s convert_url_with_sign 主通道后：
// 免费歌全档位可用，VIP 歌也放行真音频（320k/flac 实测与 N_MINFO 元数据逐字节吻合），
// web playUrl 仅作回退（匿名恒 128k）
await test('URL kw 128k 免费歌', async() => {
  const r = await get('/url/kw/151826618?quality=128k')
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.url) throw new Error('无 url')
  if (r.data.via !== undefined) throw new Error(`直接命中不应有 via 字段，实际 ${r.data.via}`)
  return r.data.url.slice(0, 60)
})

await test('URL kw VIP 歌 320k（mobi 通道真音频）', async() => {
  const r = await get('/url/kw/28423286?quality=320k')
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.url) throw new Error('无 url')
  // mobi 通道严格校验 bitrate==320 才放行，url 必然是 320k 档
  return r.data.url.slice(0, 60)
})

await test('URL kw VIP 歌 flac 降级链', async() => {
  const r = await get('/url/kw/228908?quality=flac24bit')
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.url) throw new Error('无 url')
  // 晴天无 hi-res 档，应逐级降级命中 2000k flac 而非报错
  return r.data.url.slice(0, 60)
})

await test('URL wy 128k', async() => {
  const r = await get('/url/wy/3357698666?quality=128k')
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.url) throw new Error('无 url')
  return r.data.url.slice(0, 60)
})

await test('URL tx 320k', async() => {
  const r = await get('/url/tx/003C9fBv2K4x8b?quality=320k')
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.url) throw new Error('无 url')
  return r.data.url.slice(0, 60)
})

// qs 匿名只有 30 秒试听（7079108541549643812 = 陈粒《小半》，2026-10-01 实测可用）
await test('URL qs 试听 128k', async() => {
  const r = await get('/url/qs/7079108541549643812?quality=128k')
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.url) throw new Error('无 url')
  return r.data.url.slice(0, 60)
})

// 取流链兜底：平台直连失败后按 name/singer 匹配酷我（via=kw 标记实际命中通道）
await test('URL wy 坏 id → 酷我兜底（via=kw）', async() => {
  const r = await get('/url/wy/not-exist-id?quality=128k&name=晴天&singer=周杰伦&interval=04:29')
  if (r.code != 0) throw new Error(r.msg)
  if (r.data?.via !== 'kw') throw new Error(`期望 via=kw，实际 ${JSON.stringify(r.data)}`)
  if (!r.data?.url) throw new Error('无 url')
  return r.data.url.slice(0, 60)
})

// 坏 id 且未传歌名：kg hash 反查也失败时，应返回聚合各阶段错误的 502 而非裸错误
await test('URL kg 坏 hash 无歌名 → 502 聚合错误', async() => {
  const r = await getRaw('/url/kg/00000000000000000000000000000000?quality=128k')
  if (r.status !== 502) throw new Error(`期望 502，实际 ${r.status}`)
  const msg = JSON.parse(r.body).msg
  if (!msg.includes('取流失败')) throw new Error(`错误信息应为取流失败聚合，实际 ${msg}`)
  return msg
})

// 歌词
await test('歌词 kw', async() => {
  const r = await get('/lyric/kw/28423286')
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.lyric) throw new Error('无歌词')
  return `${r.data.lyric.slice(0, 30)}...`
})

await test('歌词 qs', async() => {
  const r = await get('/lyric/qs/7079108541549643812')
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.lyric) throw new Error('无歌词')
  return `${r.data.lyric.slice(0, 30)}...`
})

// 封面
await test('封面 kw', async() => {
  const r = await get('/pic/kw/28423286')
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.url) throw new Error('无 url')
  return r.data.url.slice(0, 60)
})

await test('封面 qs', async() => {
  const r = await get('/pic/qs/7079108541549643812')
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.url) throw new Error('无 url')
  return r.data.url.slice(0, 60)
})

// 榜单 & 热搜
for (const source of ['kw', 'kg', 'tx', 'wy']) {
  await test(`榜单 ${source}`, async() => {
    const r = await get(`/boards/${source}`)
    if (r.code != 0) throw new Error(r.msg)
    if (!r.data?.list?.length) throw new Error('空列表')
    return `${r.data.list.length} 个榜单`
  })
}

await test('热搜 kw', async() => {
  const r = await get('/hot-search/kw')
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.list?.length) throw new Error('空列表')
  return r.data.list[0]
})

// ---- 标准 HTTP 语义与文档 ----

await test('平台列表 /sources', async() => {
  const r = await get('/sources')
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.platforms?.length) throw new Error('空平台列表')
  const kw = r.data.platforms.find(p => p.id === 'kw')
  if (!kw?.capabilities?.search) throw new Error('kw 缺少 search 能力')
  return `${r.data.platforms.length} 个平台`
})

await test('榜单详情 路径风格 /boards/:source/:boardId', async() => {
  // 用列表返回的带前缀 id（回归：详情接口应自动归一化为裸 bangid）
  const r = await get('/boards/kw/kw__93?page=1')
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.list?.length) throw new Error('空列表')
  return `${r.data.list.length} 首`
})

await test('跨平台匹配 /find', async() => {
  const r = await get(`/find?name=${encodeURIComponent('稻香')}&singer=${encodeURIComponent('周杰伦')}`)
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.list?.length) throw new Error('空列表')
  return `${r.data.list[0].name} / ${r.data.list[0].singer}`
})

await test('歌单 路径风格 /song-list/:source', async() => {
  const r = await get('/song-list/kg?page=1')
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.list?.length) throw new Error('空列表')
  return `${r.data.list.length} 个歌单`
})

await test('歌单 默认排序 /song-list/kw', async() => {
  const r = await get('/song-list/kw?page=1')
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.list?.length) throw new Error('空列表（sortId 默认值未适配平台）')
  return `${r.data.list.length} 个歌单`
})

// ---- 歌手 & 专辑 ----

await test('歌手信息 /singer/kg', async() => {
  const r = await get('/singer/kg/3062')
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.info?.name) throw new Error('无歌手名')
  return r.data.info.name
})

await test('歌手信息 /singer/wy', async() => {
  const r = await get('/singer/wy/3684')
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.info?.name) throw new Error('无歌手名')
  return r.data.info.name
})

await test('歌手信息 /singer/tx', async() => {
  const r = await get('/singer/tx/0025NhlN2yWrP4')
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.info?.name) throw new Error('无歌手名')
  return r.data.info.name
})

await test('歌手歌曲 /singer/tx/:id/songs', async() => {
  const r = await get('/singer/tx/0025NhlN2yWrP4/songs?page=1&limit=3')
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.list?.length) throw new Error('空列表')
  return `${r.data.list.length} 首 / 共 ${r.data.total}`
})

await test('歌手专辑 /singer/kg/:id/albums', async() => {
  const r = await get('/singer/kg/3062/albums?page=1&limit=3')
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.list?.length) throw new Error('空列表')
  return `${r.data.list.length} 张`
})

await test('专辑详情 /album/kg', async() => {
  const r = await get('/album/kg/171089481')
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.info?.name || !r.data?.list) throw new Error('响应不完整')
  return `${r.data.info.name}（${r.data.list.length} 首）`
})

await test('专辑详情 /album/kw', async() => {
  const r = await get('/album/kw/29218')
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.info?.name || !r.data?.list?.length) throw new Error('响应不完整')
  return `${r.data.info.name}（${r.data.list.length} 首）`
})

await test('专辑详情 /album/tx', async() => {
  const r = await get('/album/tx/000MkMni19ClKG')
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.info?.name || !r.data?.list?.length) throw new Error('响应不完整')
  return `${r.data.info.name}（${r.data.list.length} 首）`
})

await test('参数校验 422（缺少 name）', async() => {
  const r = await getRaw('/search')
  if (r.status !== 422) throw new Error(`期望 422，实际 ${r.status}`)
  const body = JSON.parse(r.body)
  if (body.code !== 422 || !body.msg) throw new Error('响应体格式错误')
  return body.msg
})

await test('参数校验 422（非法音质）', async() => {
  const r = await getRaw('/url/kw/28423286?quality=999k')
  if (r.status !== 422) throw new Error(`期望 422，实际 ${r.status}`)
  return JSON.parse(r.body).msg
})

await test('404 未知接口', async() => {
  const r = await getRaw('/not-exist')
  if (r.status !== 404) throw new Error(`期望 404，实际 ${r.status}`)
  return JSON.parse(r.body).msg
})

await test('旧 query 路由已移除（404）', async() => {
  const r = await getRaw('/url?source=kw&id=28423286')
  if (r.status !== 404) throw new Error(`期望 404，实际 ${r.status}`)
  const body = JSON.parse(r.body)
  if (!/接口不存在/.test(body.msg)) throw new Error(`响应异常: ${body.msg}`)
  return body.msg
})

await test('405 方法不允许（静态路由）', async() => {
  const r = await postRaw('/search')
  if (r.status !== 405) throw new Error(`期望 405，实际 ${r.status}`)
  if (!r.headers.allow) throw new Error('缺少 Allow 头')
  return `Allow: ${r.headers.allow}`
})

await test('405 方法不允许（参数路由）', async() => {
  const r = await postRaw('/url/kw/28423286')
  if (r.status !== 405) throw new Error(`期望 405，实际 ${r.status}`)
  if (!r.headers.allow || !r.headers.allow.includes('GET')) throw new Error(`Allow 头异常: ${r.headers.allow}`)
  return `Allow: ${r.headers.allow}`
})

await test('根路径 302 → /docs', async() => {
  const r = await getRaw('/')
  if (r.status !== 302) throw new Error(`期望 302，实际 ${r.status}`)
  if (r.headers.location !== '/docs') throw new Error(`期望 /docs，实际 ${r.headers.location}`)
  return r.headers.location
})

await test('Swagger UI 文档页 /docs', async() => {
  const r = await getRaw('/docs')
  if (r.status !== 200) throw new Error(`期望 200，实际 ${r.status}`)
  if (!r.body.includes('swagger-ui')) throw new Error('页面内容异常')
  return 'Swagger UI'
})

await test('OpenAPI 规范 /openapi.json', async() => {
  const r = await getRaw('/openapi.json')
  if (r.status !== 200) throw new Error(`期望 200，实际 ${r.status}`)
  const spec = JSON.parse(r.body)
  if (!spec.openapi?.startsWith('3.')) throw new Error(`openapi 版本异常: ${spec.openapi}`)
  if (!spec.paths?.['/search']) throw new Error('缺少 /search 定义')
  if (!spec.paths?.['/url/{source}/{id}']) throw new Error('缺少路径参数路由定义')
  return `${Object.keys(spec.paths).length} 个路径`
})

await test('Swagger UI 规范端点 /docs/json（不可包信封）', async() => {
  const r = await getRaw('/docs/json')
  if (r.status !== 200) throw new Error(`期望 200，实际 ${r.status}`)
  const spec = JSON.parse(r.body)
  // Swagger UI 强制从该地址加载规范：若被全局信封钩子包成 { code, data }，顶层无 openapi 字段，文档页直接报错
  if (!spec.openapi?.startsWith('3.')) throw new Error(`顶层缺少 openapi 字段（疑似被信封包裹）: ${r.body.slice(0, 80)}`)
  return spec.openapi
})

// ---- 登录 ----

await test('登录状态 /login/status', async() => {
  const r = await get('/login/status')
  if (r.code != 0) throw new Error(r.msg)
  if (typeof r.data.wy?.logged !== 'boolean' || typeof r.data.kg?.logged !== 'boolean' || typeof r.data.tx?.logged !== 'boolean') {
    throw new Error('响应不完整')
  }
  return `wy:${r.data.wy.logged} kg:${r.data.kg.logged} tx:${r.data.tx.logged}`
})

await test('登录态续期 POST /login/refresh', async() => {
  const r = await postJson('/login/refresh', {})
  if (r.status !== 200 || r.body?.code !== 0) throw new Error(r.body?.msg ?? `HTTP ${r.status}`)
  // 各平台结果为 skipped（未登录）/ refreshed（续期成功）/ error（网关拒绝）之一
  const valid = (v: any) => v && (v.skipped || v.refreshed || v.error)
  if (!valid(r.body.data?.kg) || !valid(r.body.data?.tx)) throw new Error(`响应结构异常: ${JSON.stringify(r.body.data)}`)
  const brief = (v: any) => v.skipped ? 'skipped' : v.refreshed ? 'refreshed' : `error(${v.error})`
  return `kg:${brief(r.body.data.kg)} tx:${brief(r.body.data.tx)}`
})

await test('扫码二维码创建 POST /login/wy/qr', async() => {
  const r = await postJson('/login/wy/qr', {})
  if (r.status !== 200 || r.body?.code !== 0) throw new Error(r.body?.msg ?? `HTTP ${r.status}`)
  if (!r.body.data?.key || !r.body.data?.qrurl || !r.body.data?.qrimg) throw new Error('响应不完整')
  return r.body.data.key.slice(0, 18) + '…'
})

await test('扫码二维码创建 POST /login/qs/qr', async() => {
  const r = await postJson('/login/qs/qr', {})
  if (r.status !== 200 || r.body?.code !== 0) throw new Error(r.body?.msg ?? `HTTP ${r.status}`)
  if (!r.body.data?.token || !r.body.data?.qrimg?.startsWith('data:image/')) throw new Error('响应不完整')
  return `scanApp=${r.body.data.scanApp || '?'}`
})

await test('kg 假 token 拒绝 POST /login/kg', async() => {
  const r = await postJson('/login/kg', { token: 'smoke_fake_token', userid: 0 })
  if (r.status !== 401) throw new Error(`期望 401，实际 ${r.status}`)
  return r.body?.msg
})

// 汇总
const passed = results.filter(r => r.ok).length
const failed = results.filter(r => !r.ok)
console.log(`\n===== 结果: ${passed}/${results.length} 通过 =====`)
if (failed.length) {
  console.log('失败项:')
  failed.forEach(f => console.log(`  - ${f.name}: ${f.detail}`))
}

if (localServer) {
  console.log('\n正在关闭本地服务器...')
  localServer.kill()
  await new Promise(resolve => { localServer.on('exit', resolve) })
}

if (failed.length) process.exit(1)
