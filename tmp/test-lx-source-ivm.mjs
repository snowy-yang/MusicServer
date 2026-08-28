// isolated-vm 加载器测试（离线，不真实联网）
// 运行：node tmp/test-lx-source-ivm.mjs
import { createIvmLxSource } from '../src/apis/lx-source-ivm.js'

let failed = 0
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failed++
}

const makeMock = () => {
  const seenUrls = []
  const mock = (url) => {
    seenUrls.push(url)
    return {
      promise: Promise.resolve({
        statusCode: 200, statusMessage: 'OK',
        headers: { 'content-type': 'application/json' },
        body: { code: 0, msg: 'success', data: 'https://example.com/fake.mp3' },
      }),
      cancelHttp() {},
    }
  }
  mock.seenUrls = seenUrls
  return mock
}

// ===== 常规流程（默认白名单：脚本 apiUrl 同源放行）=====
const mock = makeMock()
const lx = await createIvmLxSource({ http: mock })

check('脚本 inited 上报', !!lx.inited, JSON.stringify(lx.inited?.sources ? Object.keys(lx.inited.sources) : null))
check('scriptInfo 解析', lx.scriptInfo.version === '5', JSON.stringify(lx.scriptInfo))
check('白名单来自脚本声明', lx.allowedOrigins.includes('https://88.lxmusic.xn--fiqs8s'), lx.allowedOrigins.join(','))

// hash 优先
const r1 = lx.apis.kw.getMusicUrl({ songmid: '28423286', hash: 'fakehash123' }, '320k')
const u1 = await r1.promise
check('musicUrl hash 优先', u1.url === 'https://example.com/fake.mp3', u1.url)
check('取流路径/hash', mock.seenUrls.some(u => u.includes('/v4s/url/kw/fakehash123/320k')), mock.seenUrls.at(-1)?.split('?')[0])

// songmid 兜底
const r2 = lx.apis.tx.getMusicUrl({ songmid: '003C9fBv2K4x8b' }, '128k')
const u2 = await r2.promise
check('musicUrl songmid 兜底', u2.url === 'https://example.com/fake.mp3', u2.url)
check('取流路径/songmid', mock.seenUrls.some(u => u.includes('/v4s/url/tx/003C9fBv2K4x8b/128k')))

// 签名参数齐全
const lastUrl = mock.seenUrls.at(-1)
check('签名参数齐全', ['e=', 'to=', 'fp=', 's2=', 'v=5', 'si=', 's3='].every(k => lastUrl.includes(k)))

// rconfig 心跳（脚本加载时自动发出，走白名单放行）
check('启动 rconfig 心跳放行', mock.seenUrls.some(u => u.includes('/rconfig?')))

// ===== HTTP 默认阻止：白名单置空，脚本请求全部拦截 =====
const mockBlocked = makeMock()
const lb = await createIvmLxSource({ http: mockBlocked, allowedOrigins: [], initTimeout: 8000, log: false })
let blockedBehavior = 'init-failed'
try {
  const rb = lb.apis.kw.getMusicUrl({ songmid: '28423286' }, '128k')
  await rb.promise
  blockedBehavior = 'unexpected-success'
} catch (e) {
  blockedBehavior = `rejected: ${e.message}`
}
check('白名单置空后请求被拦截', !mockBlocked.seenUrls.length, `mock 被调用 ${mockBlocked.seenUrls.length} 次; ${blockedBehavior}`)
await lb.destroy()

// ===== 失败路径：code != 0 → 脚本内部错误码映射后 reject =====
let errSeen = ''
const mockFail = () => ({ promise: Promise.resolve({ statusCode: 200, statusMessage: 'OK', headers: {}, body: { code: 1, msg: '签名过期' } }), cancelHttp() {} })
const lx2 = await createIvmLxSource({ http: mockFail, log: false })
try {
  await lx2.apis.kg.getMusicUrl({ hash: 'abc' }, 'flac').promise
} catch (e) { errSeen = e.message }
check('code!=0 reject（脚本错误映射）', !!errSeen && errSeen !== 'undefined', errSeen)
await lx2.destroy()

await lx.destroy()
console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
