// 冒烟测试 —— 验证服务器各接口与各平台功能
// 运行：pnpm test（Node 22.18+ 直接以类型剥离方式运行 .ts）
//
// 覆盖：搜索（各平台 + 聚合）、URL（kw/wy/tx）、歌词、封面、榜单详情、热搜、歌单、
//       跨平台匹配 /find、歌手/专辑、路径参数风格路由、标准 HTTP 语义（404/405/422/302）、
//       文档页、旧 query 路由移除回归

import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'

// 端口策略：默认在随机空闲端口自起独立实例（避免连到 16688 等常驻实例——
// 旧代码会让新用例误报失败）；显式设置 BASE_URL 时测试该外部实例、不再自动启动
const PORT = Number(process.env.PORT || 0)
let BASE = process.env.BASE_URL || ''
const externalServer = Boolean(BASE)
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
 * 启动本地服务器（指定端口，可覆盖环境变量）并返回进程句柄
 */
const startLocalServer = (port: number, envExtra: Record<string, string> = {}) => new Promise((resolve, reject) => {
  const proc = spawn(process.execPath, ['src/server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), ...envExtra },
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
    // 启用 AUTH_KEY 的实例全路径要求秘钥，探活也须携带
    const headers = envExtra.AUTH_KEY ? { 'X-Server-Key': envExtra.AUTH_KEY } : {}
    http.get(`http://localhost:${port}/health`, { headers }, res => {
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
if (externalServer) {
  console.log(`测试外部实例 ${BASE}\n`)
} else {
  // 未显式指定 BASE_URL/PORT 时取随机空闲端口
  const freePort = await new Promise<number>(resolve => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as any).port
      srv.close(() => resolve(p))
    })
  })
  const port = PORT || freePort
  BASE = `http://localhost:${port}`
  localServer = await startLocalServer(port)
  console.log(`本地服务器已启动（:${port}）\n`)
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

// xm 匿名免费曲直链（12096669 = 苏荷酒吧我爱的人，免费，2026-10-02 实测可用）
await test('URL xm 免费曲', async() => {
  const r = await get('/url/xm/12096669?quality=128k')
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.url || !/xmcdn\.com/.test(r.data.url)) throw new Error('非 xmcdn 直链')
  return `${r.data.type} ${r.data.url.slice(0, 60)}`
})

// me 匿名免费声音明文直链（1557130 = 穿堂惊掠琵琶声·总预告，App API 签名通道，2026-10-02 实测可用）
await test('URL me 免费声音', async() => {
  const r = await get('/url/me/1557130?quality=128k')
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.url || !/maoercdn\.com/.test(r.data.url)) throw new Error('非 maoercdn 直链')
  return `${r.data.type} ${r.data.url.slice(0, 60)}`
})

// qt 匿名节目直链（304214:12302057 = 诡吹灯续·片花，audiostream 签名通道，2026-10-02 实测可用）
await test('URL qt 免费节目', async() => {
  const r = await get('/url/qt/304214:12302057?quality=64k')
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.url || !/audiostream\/redirect/.test(r.data.url)) throw new Error('非 audiostream 签名直链')
  return `${r.data.type} ${r.data.url.slice(0, 70)}`
})

// qt/lr 直查 + 聚合排除
await test('搜索 qt 直查', async() => {
  const r = await get(`/search?source=qt&name=${encodeURIComponent('郭德纲')}&limit=3`)
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.list?.length) throw new Error('响应不完整')
  return `首条 ${r.data.list[0].name}`
})

await test('搜索 lr 直查', async() => {
  const r = await get(`/search?source=lr&name=${encodeURIComponent('三体')}&limit=3`)
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.list?.length) throw new Error('响应不完整')
  return `首条 ${r.data.list[0].name}`
})

// lr 未登录取流应返回明确错误（502 上游）
await test('URL lr 未登录 → 明确错误', async() => {
  const r = await getRaw('/url/lr/50678018:1?quality=64k')
  if (r.status !== 502) throw new Error(`期望 502，实际 ${r.status}`)
  if (!JSON.parse(r.body).msg.includes('/login/lr')) throw new Error(`错误信息应引导登录，实际 ${JSON.parse(r.body).msg}`)
  return JSON.parse(r.body).msg.slice(0, 40)
})

// me 有声内容：直查可用、聚合排除
await test('搜索 me 直查', async() => {
  const r = await get(`/search?source=me&name=${encodeURIComponent('伪装学渣')}&limit=10`)
  if (r.code != 0) throw new Error(r.msg)
  const list = r.data?.list ?? []
  if (!list.length) throw new Error('响应不完整')
  // 搜索结构对齐网页版：正剧（dramaapi/search 的 d: 前缀条目）应置顶
  if (!String(list[0].songmid).startsWith('d:') || !String(list[0].name).includes('伪装学渣')) {
    throw new Error(`首条应为正剧条目，实际 ${JSON.stringify(list[0]?.songmid)} ${list[0]?.name}`)
  }
  return `首条 ${list[0].name}（d: 剧条目置顶）`
})

// me 剧条目 d:<id> 取流：自动选首个免费集（58262 = 伪装学渣第一季，2026-10-02 实测可用）
await test('URL me 剧条目 d: 前缀', async() => {
  const r = await get('/url/me/d:58262?quality=128k')
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.url || !/maoercdn\.com/.test(r.data.url)) throw new Error('非 maoercdn 直链')
  return `${r.data.type} ${r.data.url.slice(0, 60)}`
})

// xm 有声内容：直查可用、聚合排除
await test('搜索 xm 直查', async() => {
  const r = await get(`/search?source=xm&name=${encodeURIComponent('郭德纲')}&limit=3`)
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.list?.length) throw new Error('响应不完整')
  return `首条 ${r.data.list[0].name}`
})

await test('聚合搜索排除 xm', async() => {
  const r = await get(`/search?name=${encodeURIComponent('郭德纲')}&limit=2`)
  if (r.code != 0) throw new Error(r.msg)
  if (r.data?.list?.some((item: any) => ['xm', 'me', 'qt', 'lr'].includes(item.source))) throw new Error('聚合结果不应包含有声平台')
  return 'ok'
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

// xm 专辑（3595841 = 苏荷酒吧专辑，2026-10-02 实测可用）
await test('专辑详情 /album/xm', async() => {
  const r = await get('/album/xm/3595841')
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.info?.name || !r.data?.list?.length) throw new Error('响应不完整')
  return `${r.data.info.name}（${r.data.info.total} 集）`
})

// me 剧集（25276 = 穿堂惊掠琵琶声，2026-10-02 实测可用）
await test('专辑详情 /album/me', async() => {
  const r = await get('/album/me/25276')
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.info?.name || !r.data?.list?.length) throw new Error('响应不完整')
  return `${r.data.info.name}（${r.data.info.total} 集）`
})

// qt 频道（304214 = 诡吹灯续，2026-10-02 实测可用）
await test('专辑详情 /album/qt', async() => {
  const r = await get('/album/qt/304214')
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.list?.length || !String(r.data.list[0].songmid).includes(':')) throw new Error('响应不完整或缺少复合 id')
  return `${r.data.list.length} 节目，首条 ${r.data.list[0].name}`
})

// lr 书籍章节（50678018 = 三体广播剧，2026-10-02 实测可用）
await test('专辑详情 /album/lr', async() => {
  const r = await get('/album/lr/50678018')
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.list?.length || !String(r.data.list[0].songmid).includes(':')) throw new Error('响应不完整或缺少复合 id')
  return `${r.data.info.total} 节`
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

// xm cookie 绑定校验（缺 1&_token 拒绝）
await test('xm 坏 cookie 拒绝 POST /login/xm', async() => {
  const r = await postJson('/login/xm', { cookie: 'foo=bar; baz=1' })
  if (r.status !== 422) throw new Error(`期望 422，实际 ${r.status}`)
  return `status ${r.status}`
})

// me cookie 绑定校验（缺 token 拒绝）
await test('me 坏 cookie 拒绝 POST /login/me', async() => {
  const r = await postJson('/login/me', { cookie: 'foo=bar; baz=1' })
  if (r.status !== 422) throw new Error(`期望 422，实际 ${r.status}`)
  return `status ${r.status}`
})

// xm 登录状态展示
await test('登录状态含 xm 字段', async() => {
  const r = await get('/login/status')
  if (r.code != 0) throw new Error(r.msg)
  if (!('xm' in (r.data ?? {})) || !('logged' in r.data.xm)) throw new Error('xm 登录状态缺失')
  return `xm.logged=${r.data.xm.logged}`
})

// ---- 调用秘钥鉴权 + 限流（独立实例带 AUTH_KEY/RATE_LIMIT 起测；主实例未设时本组自动跳过）----
if (!externalServer && !process.env.AUTH_KEY) {
  const AUTH_TEST_KEY = 'smoke-test-secret-key'
  const authPort = await new Promise<number>(resolve => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as any).port
      srv.close(() => resolve(p))
    })
  })
  const authBase = `http://localhost:${authPort}`
  const authServer: any = await startLocalServer(authPort, { AUTH_KEY: AUTH_TEST_KEY })
  const authFetch = (path: string, init: RequestInit = {}) => fetch(authBase + path, init)
  const keyHeaders = { 'X-Server-Key': AUTH_TEST_KEY }

  await test('AUTH_KEY 无秘钥 → 401', async() => {
    const r = await authFetch('/sources')
    if (r.status !== 401) throw new Error(`期望 401，实际 ${r.status}`)
    return 'ok'
  })
  await test('AUTH_KEY 旧方式(Bearer/X-Api-Key)不再生效 → 401', async() => {
    const r = await authFetch('/sources', { headers: { Authorization: `Bearer ${AUTH_TEST_KEY}`, 'X-Api-Key': AUTH_TEST_KEY } })
    if (r.status !== 401) throw new Error(`期望 401（只认 X-Server-Key），实际 ${r.status}`)
    return 'ok'
  })
  await test('AUTH_KEY X-Server-Key 通过', async() => {
    const r = await authFetch('/sources', { headers: keyHeaders })
    if (r.status !== 200) throw new Error(`期望 200，实际 ${r.status}`)
    return 'ok'
  })
  // 防扫描：全部页面（含文档/健康检查/不存在的路径）无秘钥一律 401，无法探测接口存在性
  for (const path of ['/health', '/docs', '/openapi.json', '/redoc', '/not-exist-path', '/login/status']) {
    const r = await authFetch(path)
    if (r.status !== 401) throw new Error(`${path} 期望 401，实际 ${r.status}（应全路径要求秘钥）`)
  }
  await test('AUTH_KEY 全路径防扫（文档/health/404 均 401）', async() => 'ok')
  // /stream/* 流代理额外接受 ?key=（播放器拉流兼容），其它路径 ?key= 无效
  await test('AUTH_KEY ?key= 仅限 /stream/*', async() => {
    const normal = await authFetch(`/sources?key=${AUTH_TEST_KEY}`)
    if (normal.status !== 401) throw new Error(`普通路径 ?key= 应 401，实际 ${normal.status}`)
    const stream = await authFetch(`/stream/qs/123?key=${AUTH_TEST_KEY}`)
    // 带对 key 的 stream 请求应通过鉴权（后续业务可能 502，但不能是 401）
    if (stream.status === 401) throw new Error('stream ?key= 应通过鉴权')
    return `stream 状态 ${stream.status}（过鉴权）`
  })

  // 限流（独立低阈值实例验证 429）
  const rlPort = authPort + 1
  const rlBase = `http://localhost:${rlPort}`
  const rlServer: any = await startLocalServer(rlPort, { AUTH_KEY: AUTH_TEST_KEY, RATE_LIMIT: '3' })
  await test('RATE_LIMIT 超限 → 429', async() => {
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) {
      const r = await fetch(`${rlBase}/sources`, { headers: { 'X-Server-Key': AUTH_TEST_KEY } })
      statuses.push(r.status)
    }
    if (!statuses.some(s => s === 429)) throw new Error(`6 连发应触发 429，实际 ${statuses.join(',')}`)
    return `状态序列 ${statuses.join(',')}`
  })

  rlServer.kill()
  authServer.kill()
}

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
