// 端到端验证:经 src/apis/lx-source.js 懒加载封装真实取流一次
import lx from '../src/apis/lx-source.js'

const r = lx.kw.getMusicUrl({ songmid: '28423286' }, '320k')
const res = await Promise.race([
  r.promise,
  new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 25s')), 25000)),
])
console.log('[结果]', JSON.stringify(res).slice(0, 160))
process.exit(0)
