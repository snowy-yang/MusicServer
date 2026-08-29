// 极简 HTTP 路由器 —— 路径参数（:name）、405 检测、携带路由元数据（供 OpenAPI 文档生成）

export class Router {
  #routes = []

  get(pattern, meta, handler) {
    this.#add('GET', pattern, meta, handler)
    return this
  }

  #add(method, pattern, meta, handler) {
    const segments = pattern.replace(/^\/+|\/+$/g, '').split('/')
    this.#routes.push({ method, pattern, segments, meta: meta || {}, handler })
  }

  /**
   * 匹配路由
   * @returns {null | { handler: Function, meta: object, params: Record<string,string> } | { allowed: string[] }}
   *   - null：无匹配路由（404）
   *   - { allowed }：路径存在但方法不符（405）
   */
  match(pathname, method) {
    const parts = pathname.replace(/^\/+|\/+$/g, '').split('/')
    const allowed = new Set()
    for (const route of this.#routes) {
      const params = matchSegments(route.segments, parts)
      if (!params) continue
      if (route.method !== method) {
        allowed.add(route.method)
        continue
      }
      return { handler: route.handler, meta: route.meta, params }
    }
    if (allowed.size) return { allowed: [...allowed] }
    return null
  }

  /** 路由表（OpenAPI 文档生成用） */
  get routes() {
    return this.#routes
  }
}

const matchSegments = (defined, actual) => {
  if (defined.length !== actual.length) return null
  const params = {}
  for (let i = 0; i < defined.length; i++) {
    const seg = defined[i]
    if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(actual[i])
    else if (seg !== actual[i]) return null
  }
  return params
}
