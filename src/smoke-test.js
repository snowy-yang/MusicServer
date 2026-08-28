// 冒烟测试 —— 验证服务器各接口与各平台功能
// 运行：node src/smoke-test.js
//
// 覆盖：搜索（各平台 + 聚合）、URL（kw/wy/tx）、歌词（kw）、封面、榜单、热搜

import http from 'node:http'
import { spawn } from 'node:child_process'

const BASE = process.env.BASE_URL || 'http://localhost:3300'
const results = []

const get = (path) => new Promise((resolve, reject) => {
  http.get(`${BASE}${path}`, res => {
    let data = ''
    res.on('data', c => { data += c })
    res.on('end', () => {
      try { resolve(JSON.parse(data)) } catch { reject(new Error(`JSON parse failed: ${data.slice(0, 100)}`)) }
    })
  }).on('error', reject)
})

const test = async(name, fn) => {
  try {
    const result = await fn()
    results.push({ name, ok: true, detail: result })
    console.log(`✅ ${name}`)
  } catch (err) {
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
  const proc = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
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

let localServer = null
const running = await isServerRunning()
if (!running) {
  console.log('本地服务器未运行，正在自动启动...')
  localServer = await startLocalServer()
  console.log('本地服务器已启动\n')
} else {
  console.log('使用已运行的服务器\n')
}

// 搜索
for (const source of ['kw', 'kg', 'tx', 'wy', 'mg']) {
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

// URL（用已知歌曲 id）
await test('URL kw 320k', async() => {
  const r = await get('/url?source=kw&id=28423286&quality=320k')
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.url) throw new Error('无 url')
  return r.data.url.slice(0, 60)
})

await test('URL wy 128k', async() => {
  const r = await get('/url?source=wy&id=3357698666&quality=128k')
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.url) throw new Error('无 url')
  return r.data.url.slice(0, 60)
})

await test('URL tx 320k', async() => {
  const r = await get('/url?source=tx&id=003C9fBv2K4x8b&quality=320k')
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.url) throw new Error('无 url')
  return r.data.url.slice(0, 60)
})

// 歌词
await test('歌词 kw', async() => {
  const r = await get('/lyric?source=kw&id=28423286')
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.lyric) throw new Error('无歌词')
  return `${r.data.lyric.slice(0, 30)}...`
})

// 封面
await test('封面 kw', async() => {
  const r = await get('/pic?source=kw&id=28423286')
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.url) throw new Error('无 url')
  return r.data.url.slice(0, 60)
})

// 榜单 & 热搜
for (const source of ['kw', 'kg', 'tx', 'wy', 'mg']) {
  await test(`榜单 ${source}`, async() => {
    const r = await get(`/boards?source=${source}`)
    if (r.code != 0) throw new Error(r.msg)
    if (!r.data?.list?.length) throw new Error('空列表')
    return `${r.data.list.length} 个榜单`
  })
}

await test('热搜 kw', async() => {
  const r = await get('/hotSearch?source=kw')
  if (r.code != 0) throw new Error(r.msg)
  if (!r.data?.list?.length) throw new Error('空列表')
  return r.data.list[0]
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
