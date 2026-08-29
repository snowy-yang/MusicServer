// 临时验证脚本 —— 检查 OpenAPI 规范与文档页产出
import { startServer } from '../src/server.js'

const server = startServer(3459)
await new Promise(r => setTimeout(r, 500))

const spec = await fetch('http://localhost:3459/openapi.json').then(r => r.json())
const urlRoute = spec.paths['/url/:source/:id'].get
console.log('openapi:', spec.openapi, '| paths:', Object.keys(spec.paths).length)
console.log('url params:', JSON.stringify(urlRoute.parameters.map(p => `${p.name}:${p.in}${p.required ? '(required)' : ''}`)))
console.log('url responses:', Object.keys(urlRoute.responses).join(', '))
console.log('deprecated routes:', Object.entries(spec.paths).filter(([, v]) => v.get.deprecated).map(([k]) => k).join(', '))
console.log('schemas:', Object.keys(spec.components.schemas).length)

const html = await fetch('http://localhost:3459/docs').then(r => r.text())
console.log('docs page ok:', html.includes('swagger-ui-bundle') && html.includes('/openapi.json'))
const redoc = await fetch('http://localhost:3459/redoc').then(r => r.text())
console.log('redoc page ok:', redoc.includes('redoc'))

const sources = await fetch('http://localhost:3459/sources').then(r => r.json())
console.log('sources:', JSON.stringify(sources.data.platforms.map(p => `${p.id}:${p.qualities.join('/')}`)))
console.log('kw caps:', JSON.stringify(sources.data.platforms.find(p => p.id === 'kw').capabilities))

server.close()
process.exit(0)
