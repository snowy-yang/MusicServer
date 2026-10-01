// 简单 API 音源脚本（.mjs）加载器测试 —— 离线运行，不依赖外部平台
// 运行：node test/source-simple-test.ts（已并入 pnpm test）
//
// 覆盖：基本取流（字符串 / {type,url} 返回）、sources 导出限定平台、signal 取消、
//       超时中断、脚本抛错传播、缺少 getMusicUrl 导出报错、候选链失败切换（ivm→simple）

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { createSimpleSource } from '../src/source-simple.ts'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmpDir = path.join(root, 'tmp')
const sourcesDir = path.join(root, 'sources')
fs.mkdirSync(tmpDir, { recursive: true })

const results: { name: string; ok: boolean; detail?: any }[] = []
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

const songInfo = { songmid: '228908', hash: '228908', copyrightId: '228908' }

// 生成临时脚本并返回路径；测试结束后清理
const writeScript = (dir: string, name: string, code: string) => {
  const p = path.join(dir, name)
  fs.writeFileSync(p, code)
  return p
}
const cleanup = (p: string) => { try { fs.unlinkSync(p) } catch {} }

await test('基本取流（返回字符串）', async() => {
  const p = writeScript(tmpDir, 'simple-test-basic.mjs', `
    export async function getMusicUrl({ source, id, quality }) {
      return 'https://example.test/' + source + '/' + id + '/' + quality + '.mp3'
    }
  `)
  try {
    const api = await createSimpleSource({ scriptPath: p })
    const r = await api.kw.getMusicUrl(songInfo, '320k').promise
    assert.equal(r.type, '320k')
    assert.equal(r.url, 'https://example.test/kw/228908/320k.mp3')
    return r.url
  } finally { cleanup(p) }
})

await test('返回 { type, url } 对象', async() => {
  const p = writeScript(tmpDir, 'simple-test-obj.mjs', `
    export async function getMusicUrl({ quality }) {
      return { type: quality, url: 'https://example.test/obj.mp3' }
    }
  `)
  try {
    const api = await createSimpleSource({ scriptPath: p })
    const r = await api.tx.getMusicUrl(songInfo, 'flac').promise
    assert.deepEqual(r, { type: 'flac', url: 'https://example.test/obj.mp3' })
    return r.url
  } finally { cleanup(p) }
})

await test('sources 导出限定平台', async() => {
  const p = writeScript(tmpDir, 'simple-test-sources.mjs', `
    export const sources = ['mg']
    export async function getMusicUrl() { return 'https://example.test/x.mp3' }
  `)
  try {
    const api = await createSimpleSource({ scriptPath: p })
    assert.ok(api.mg, 'mg 应存在')
    assert.ok(!api.kw, 'kw 不应存在')
    const r = await api.mg.getMusicUrl({}, '128k').promise
    assert.equal(r.url, 'https://example.test/x.mp3')
    return '仅 mg'
  } finally { cleanup(p) }
})

await test('cancelHttp 触发 signal', async() => {
  const p = writeScript(tmpDir, 'simple-test-cancel.mjs', `
    export async function getMusicUrl({ signal }) {
      await new Promise((ok, err) => {
        const t = setTimeout(() => ok('late'), 5000)
        signal.addEventListener('abort', () => { clearTimeout(t); err(new Error('已取消')) })
      })
    }
  `)
  try {
    const api = await createSimpleSource({ scriptPath: p })
    const req = api.kw.getMusicUrl(songInfo, '128k')
    setTimeout(() => req.cancelHttp(), 50)
    await assert.rejects(req.promise, /已取消/)
    return 'abort 生效'
  } finally { cleanup(p) }
})

await test('脚本超时中断', async() => {
  const p = writeScript(tmpDir, 'simple-test-timeout.mjs', `
    export const timeout = 50
    export async function getMusicUrl() {
      await new Promise(ok => setTimeout(ok, 300))
      return 'https://example.test/never.mp3'
    }
  `)
  try {
    const api = await createSimpleSource({ scriptPath: p })
    await assert.rejects(api.kw.getMusicUrl(songInfo, '128k').promise, /超时/)
    return 'timeout 生效'
  } finally { cleanup(p) }
})

await test('脚本抛错传播', async() => {
  const p = writeScript(tmpDir, 'simple-test-error.mjs', `
    export async function getMusicUrl() { throw new Error('上游 403') }
  `)
  try {
    const api = await createSimpleSource({ scriptPath: p })
    await assert.rejects(api.kw.getMusicUrl(songInfo, '128k').promise, /上游 403/)
    return '错误传播正常'
  } finally { cleanup(p) }
})

await test('缺少 getMusicUrl 导出报错', async() => {
  const p = writeScript(tmpDir, 'simple-test-bad.mjs', 'export const foo = 1')
  try {
    await assert.rejects(createSimpleSource({ scriptPath: p }), /getMusicUrl/)
    return '校验生效'
  } finally { cleanup(p) }
})

await test('候选链：ivm 脚本失败自动切换到 .mjs', async() => {
  // SOURCE_SCRIPT_PATH 指向不存在的 .js 脚本（加载失败），sources/ 下的临时 .mjs 接管
  cleanup(path.join(sourcesDir, 'zz-test-simple.mjs')) // 清理上次异常退出的残留
  const p = writeScript(sourcesDir, 'zz-test-simple.mjs', `
    export async function getMusicUrl({ source }) {
      return 'https://example.test/chain-' + source + '.mp3'
    }
  `)
  process.env.SOURCE_SCRIPT_PATH = path.join(root, 'nonexistent-source-script.js')
  try {
    const { createApi } = await import('../src/source.ts')
    const r = await createApi('kw').getMusicUrl(songInfo, '128k').promise
    assert.equal(r.url, 'https://example.test/chain-kw.mp3')
    return '切换成功'
  } finally {
    cleanup(p)
    delete process.env.SOURCE_SCRIPT_PATH
  }
})

// 汇总
const passed = results.filter(r => r.ok).length
const failed = results.filter(r => !r.ok)
console.log(`\n===== 结果: ${passed}/${results.length} 通过 =====`)
if (failed.length) {
  console.log('失败项:')
  failed.forEach(f => console.log(`  - ${f.name}: ${f.detail}`))
}
if (failed.length) process.exit(1)
