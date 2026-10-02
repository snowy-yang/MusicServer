// pnpm dev 的包装：node --watch-path 指向不存在的目录会直接 ENOENT 崩溃。
// sources/ 不入库（第三方音源脚本，gitignore 整目录），新 clone 的仓库里没有它，
// 所以这里只为实际存在的目录注册 watch。
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const watchTargets = ['src', 'sdk', 'sources']
  .map((dir) => join(root, dir))
  .filter((dir) => existsSync(dir))

const child = spawn(
  process.execPath,
  [
    ...watchTargets.flatMap((dir) => ['--watch-path', dir]),
    '--watch',
    '--watch-preserve-output',
    join(root, 'src/server.ts'),
  ],
  { stdio: 'inherit', cwd: root },
)

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
