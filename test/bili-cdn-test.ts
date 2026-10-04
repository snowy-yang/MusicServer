// bili 取流 CDN 分级选址回归 —— SDK 层直调（不依赖服务器实例，含真实 B 站上游请求）
// 运行：node test/bili-cdn-test.ts（已并入 pnpm test）
//
// 覆盖：getMusicUrl 返回地址不落在 PCDN（mcdn 无线宝/mountaintoys 迅雷/szbdyd/nexusedgeio），
//       parse 路径填充的 url 同样校验。
// 判定：命中 PCDN 即失败——fail-soft 兜底意味着 upos/cn 候选 20s 探测全败，是真实的选址退化信号
// （smoke 的「URL bili」项走 HTTP 层、只软警告；本文件是 SDK 层的硬断言）。

import biliApi from '../sdk/apis/bili.ts'
import { parseSong } from '../sdk/bili/parse.ts'

/** 与 sdk/apis/bili.ts 的 hostRank 同构：0=正规 CDN 1=B站系 2=PCDN */
const hostRank = (url: string): number => {
  let host = ''
  try { host = new URL(url).hostname.toLowerCase() } catch { return 2 }
  if (host.endsWith('.akamaized.net')) return 0
  if (host.endsWith('.bilivideo.com')) return host.startsWith('upos-') ? 0 : 1
  return 2
}
const LABEL = ['正规CDN', 'B站系', 'PCDN(坏)']

const results: { name: string; ok: boolean; detail?: any }[] = []
const test = async(name: string, fn: () => Promise<any>) => {
  try {
    const result = await fn()
    results.push({ name, ok: true, detail: result })
    console.log(`✅ ${name}${result ? `: ${result}` : ''}`)
  } catch (err: any) {
    results.push({ name, ok: false, detail: err.message })
    console.log(`❌ ${name}: ${err.message}`)
  }
}

// 固定样本（2026-10-04 实测均有多分P候选与 upos 备源）；换样本时优先选多分P、热度中等的稿件
const CASES = ['BV1BZbSzZEGT', 'BV1GJ411x7h7', 'BV1d4411N7zD', 'BV1EC41147U1', 'BV19F5k6VEEp']

for (const bvid of CASES) {
  await test(`取流 ${bvid} 落正规 CDN`, async() => {
    const { promise } = biliApi.getMusicUrl({ songmid: bvid }, '128k')
    const res = await promise
    const rank = hostRank(res.url)
    if (rank === 2) throw new Error(`命中 PCDN：${new URL(res.url).host}（backupUrl 探测疑似全败）`)
    return `${LABEL[rank]} ${new URL(res.url).host}`
  })
}

await test('parse 填充 url 落正规 CDN', async() => {
  const song = await parseSong('https://www.bilibili.com/video/BV1GJ411x7h7')
  if (!song.url) throw new Error('parse 未填充 url')
  const rank = hostRank(String(song.url))
  if (rank === 2) throw new Error(`命中 PCDN：${new URL(String(song.url)).host}`)
  return `${LABEL[rank]} ${new URL(String(song.url)).host}`
})

const failed = results.filter(r => !r.ok).length
console.log(`\n===== 结果: ${results.length - failed}/${results.length} 通过 =====`)
process.exit(failed ? 1 : 0)
