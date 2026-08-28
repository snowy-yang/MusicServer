// lx-music-source-v5 复现/追踪脚本(与生产加载器 src/apis/lx-source-ivm.js 相互独立)
// 1) 将去混淆脚本末尾的字符串缓存 [] 替换为 LOGCACHE(Proxy),按序记录 JSVMP 解码的全部字符串
// 2) 模拟 lx-music-desktop preload.js 的 globalThis.lx 环境,观察脚本的注册与取流行为
// 运行:node tmp/reproduce-lx-source-v5.mjs
import crypto from 'node:crypto'
import fs from 'node:fs'
import vm from 'node:vm'
import zlib from 'node:zlib'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const inflate = promisify(zlib.inflate)
const deflate = promisify(zlib.deflate)
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex')

const deobPath = fileURLToPath(new URL('../lx-music-source-v5-deobfuscated.js', import.meta.url))
const obfPath = fileURLToPath(new URL('../lx-music-source-v5.js', import.meta.url))

let code = fs.readFileSync(deobPath, 'utf8')

// 字符串缓存:文件末尾 IIFE 最后一个参数 []
const cacheLog = []
const LOGCACHE = new Proxy([], {
  set(t, prop, val) {
    if (typeof val === 'string') cacheLog.push(val)
    t[prop] = val
    return true
  },
})
const idx = code.lastIndexOf(', []);')
code = code.slice(0, idx) + ', LOGCACHE);'

// ---- lx 环境(复刻 preload.js) ----
const handlers = {}
const requestCalls = []
let rconfigBody = process.env.RCONFIG_BODY ?? JSON.stringify({ code: 0, msg: 'success', data: 'https://example.test/fake.mp3' })
const lx = {
  EVENT_NAMES: { request: 'request', inited: 'inited', updateAlert: 'updateAlert' },
  request(url, options = {}, callback) {
    const rec = { url, options: { method: options.method ?? 'get', timeout: options.timeout, headers: options.headers, body: options.body, form: options.form, formData: options.formData } }
    requestCalls.push(rec)
    console.log('[lx.request]', url)
    console.log('  options:', JSON.stringify(rec.options))
    const isRconfig = url.includes('/rconfig')
    const raw = isRconfig ? rconfigBody : JSON.stringify({ code: 0, msg: 'success', data: 'https://example.test/fake.mp3' })
    const parsed = (() => { try { return JSON.parse(raw) } catch { return raw } })()
    setTimeout(() => {
      callback(null, { statusCode: 200, statusMessage: 'OK', headers: { 'content-type': 'application/json' }, raw: Buffer.from(raw), body: parsed }, parsed)
    }, 5)
    return () => {}
  },
  send(eventName, data) {
    console.log('[lx.send]', eventName, JSON.stringify(data))
    return Promise.resolve()
  },
  on(eventName, handler) {
    console.log('[lx.on]', eventName, typeof handler, handler && handler.length)
    handlers[eventName] = handler
    return Promise.resolve()
  },
  utils: {
    crypto: {
      aesEncrypt(b, mode, key, iv) { const c = crypto.createCipheriv(mode, key, iv); return Buffer.concat([c.update(b), c.final()]) },
      rsaEncrypt(b, key) { b = Buffer.concat([Buffer.alloc(128 - b.length), b]); return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_NO_PADDING }, b) },
      randomBytes: (n) => crypto.randomBytes(n),
      md5,
    },
    buffer: { from: (...a) => Buffer.from(...a), bufToString: (b, f) => Buffer.from(b, 'binary').toString(f) },
    zlib: { inflate: (b) => inflate(b), deflate: (d) => deflate(d) },
  },
  currentScriptInfo: { name: '独家音源', description: '', version: '5', author: 'w', homepage: '', rawScript: code },
  version: '2.0.0',
  env: 'desktop',
}

const ctx = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  Promise, Error, TypeError, RangeError, SyntaxError, EvalError, URIError,
  Array, Object, String, Number, Boolean, Date, Math, JSON, RegExp, BigInt, Symbol,
  Function, parseInt, parseFloat, isNaN, isFinite,
  encodeURIComponent, decodeURIComponent, escape, unescape,
  Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array, Float32Array, Float64Array, ArrayBuffer, DataView, Map, Set, WeakMap, WeakSet,
  TextEncoder, TextDecoder, URL, URLSearchParams,
  Buffer,
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  SCRIPT_MD5: md5(fs.readFileSync(obfPath)),
  LOGCACHE,
  lx,
}
ctx.globalThis = ctx
ctx.window = ctx
ctx.self = ctx
ctx.global = ctx

process.on('uncaughtException', (e) => console.error('[uncaught]', e.stack?.split('\n').slice(0, 6).join('\n')))
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.stack?.split('\n').slice(0, 6).join('\n') || e))

const context = vm.createContext(ctx)
console.error('[run]')
try {
  vm.runInContext(code, context, { filename: 'lx-source-v5.js', timeout: 15000 })
  console.error('[run ok]')
} catch (e) {
  console.error('[vm error]', e.stack?.split('\n').slice(0, 8).join('\n'))
}

await new Promise((r) => setTimeout(r, 1500))

console.error('\n===== decoded strings (%d) =====', cacheLog.length)
console.log(cacheLog.map((s, i) => `${i}\t${JSON.stringify(s)}`).join('\n'))

console.error('\n===== summary =====')
console.error('events registered:', Object.keys(handlers))
console.error('requests made:', requestCalls.length)

// 触发 musicUrl 请求
const handler = handlers.request
if (handler) {
  console.error('\n[trigger] musicUrl kw/128k')
  const markBefore = cacheLog.length
  try {
    const p = handler.call(lx, { source: 'kw', action: 'musicUrl', info: { type: '128k', musicInfo: { songmid: '28423286', hash: 'fakehash123', id: 'kw_28423286' } } })
    console.error('[trigger] handler returned:', p && p.constructor?.name)
    if (p && typeof p.then === 'function') {
      const res = await Promise.race([p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, msg: e?.message, name: e?.name })), new Promise((r) => setTimeout(() => r({ timeout: true }), 8000))])
      console.error('[trigger result]', JSON.stringify(res, null, 1))
    }
  } catch (e) {
    console.error('[trigger sync error]', e?.message)
  }
  console.error('\n[strings used during trigger]')
  console.error(cacheLog.slice(markBefore).map((s) => JSON.stringify(s)).join('\n'))
  await new Promise((r) => setTimeout(r, 500))
  console.error('\n[requests during trigger]')
  for (const rc of requestCalls) console.log(rc.url, JSON.stringify(rc.options))
}
fs.writeFileSync(fileURLToPath(new URL('./trace-strings.json', import.meta.url)), JSON.stringify(cacheLog, null, 1))
process.exit(0)
