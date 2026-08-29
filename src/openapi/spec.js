// OpenAPI 3.1 文档生成 —— 从路由元数据构建 /openapi.json，供 Swagger UI（/docs）与 ReDoc（/redoc）使用

const json = (schema) => ({ 'application/json': { schema } })
const ref = (name) => ({ $ref: `#/components/schemas/${name}` })

/** 200 响应体：统一信封 { code: 0, data } */
const okResponse = (dataSchema, description) => ({
  description: description || '成功',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          code: { type: 'integer', description: '0 表示成功', example: 0 },
          data: dataSchema ? ref(dataSchema) : { description: '响应数据，结构由接口决定' },
        },
        required: ['code', 'data'],
      },
    },
  },
})

const errorResponse = (description) => ({
  description,
  content: json(ref('ErrorEnvelope')),
})

const buildParameters = (meta) => {
  const parameters = []
  for (const [name, def] of Object.entries(meta.pathParams || {})) {
    parameters.push({
      name,
      in: 'path',
      required: true,
      description: def.description,
      schema: paramSchema(def),
      example: def.example,
    })
  }
  for (const [name, def] of Object.entries(meta.queryParams || {})) {
    parameters.push({
      name,
      in: 'query',
      required: Boolean(def.required),
      description: def.description,
      schema: paramSchema(def),
      example: def.example,
    })
  }
  return parameters
}

const paramSchema = (def) => {
  const schema = { type: def.enum ? 'string' : (def.type || 'string') }
  if (def.enum) schema.enum = def.enum
  if (def.default !== undefined) schema.default = def.default
  if (def.minimum !== undefined) schema.minimum = def.minimum
  if (def.maximum !== undefined) schema.maximum = def.maximum
  return schema
}

/** 领域模型（components/schemas），与 musicSdk/types.ts 的运行时数据形状对应 */
export const COMPONENT_SCHEMAS = {
  ErrorEnvelope: {
    type: 'object',
    properties: {
      code: { type: 'integer', description: '与 HTTP 状态码一致', example: 422 },
      msg: { type: 'string', description: '错误描述' },
      detail: { description: '可选的结构化错误详情' },
    },
    required: ['code', 'msg'],
  },
  QualityInfo: {
    type: 'object',
    properties: { size: { type: 'string', example: '9.8M' } },
  },
  SongType: {
    type: 'object',
    properties: {
      type: { type: 'string', example: '320k', enum: ['128k', '320k', 'flac', 'flac24bit'] },
      size: { type: 'string', example: '9.8M' },
    },
  },
  SongInfo: {
    type: 'object',
    properties: {
      songmid: { type: 'string', description: '平台歌曲 id（kg 平台为 hash）' },
      hash: { type: 'string', description: 'kg 平台的歌曲 hash' },
      copyrightId: { type: 'string', description: 'mg 平台的版权 id' },
      albumId: { type: 'string' },
      name: { type: 'string', description: '歌名' },
      singer: { type: 'string', description: '歌手' },
      source: { type: 'string', description: '来源平台 id' },
      interval: { type: 'string', description: '时长，格式 mm:ss' },
      albumName: { type: 'string' },
      img: { type: ['string', 'null'], description: '封面地址' },
      types: { type: 'array', items: ref('SongType'), description: '可用音质列表' },
      _types: { type: 'object', additionalProperties: ref('QualityInfo') },
      typeUrl: { type: 'object' },
    },
  },
  SearchResult: {
    type: 'object',
    properties: {
      source: { type: 'string', description: '来源平台 id，聚合搜索时为 all' },
      list: { type: 'array', items: ref('SongInfo') },
      page: { type: 'integer' },
      limit: { type: 'integer' },
    },
  },
  FindResult: {
    type: 'object',
    properties: {
      list: { type: 'array', items: ref('SongInfo'), description: '按匹配度排序的歌曲列表' },
    },
  },
  MusicUrlResult: {
    type: 'object',
    properties: {
      type: { type: 'string', example: '320k' },
      url: { type: 'string', description: '播放地址' },
    },
  },
  LyricInfo: {
    type: 'object',
    properties: {
      lyric: { type: 'string', description: '原文歌词（LRC）' },
      tlyric: { type: 'string', description: '翻译歌词' },
      rlyric: { type: 'string', description: '罗马音歌词（部分平台）' },
      lxlyric: { type: 'string', description: '逐字歌词（部分平台）' },
    },
    required: ['lyric', 'tlyric'],
  },
  PicResult: {
    type: 'object',
    properties: { url: { type: 'string', description: '封面地址' } },
  },
  BoardItem: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '榜单 id，用于榜单详情接口' },
      name: { type: 'string' },
      bangid: { type: 'string', description: '平台原始榜单 id' },
    },
  },
  BoardListResult: {
    type: 'object',
    properties: { list: { type: 'array', items: ref('BoardItem') } },
  },
  SongItem: {
    type: 'object',
    properties: {
      singer: { type: 'string' },
      name: { type: 'string' },
      albumName: { type: 'string' },
      albumId: { type: 'string' },
      source: { type: 'string' },
      interval: { type: 'string' },
      songmid: { type: 'string' },
      hash: { type: 'string' },
      img: { type: 'string' },
      types: { type: 'array', items: ref('SongType') },
    },
  },
  BoardDetailResult: {
    type: 'object',
    properties: {
      list: { type: 'array', items: ref('SongItem') },
      total: { type: 'integer' },
      page: { type: 'integer' },
      limit: { type: 'integer' },
      source: { type: 'string' },
    },
  },
  HotSearchResult: {
    type: 'object',
    properties: {
      source: { type: 'string' },
      list: { type: 'array', items: { type: 'string' } },
    },
  },
  SongListSummary: {
    type: 'object',
    properties: {
      play_count: { type: 'string', description: '播放量（已格式化）' },
      id: { type: 'string', description: '歌单 id' },
      author: { type: 'string' },
      name: { type: 'string' },
      time: { type: 'string' },
      img: { type: 'string' },
      total: { type: 'integer', description: '歌曲数' },
      desc: { type: 'string' },
      source: { type: 'string' },
    },
  },
  SongListResult: {
    type: 'object',
    properties: {
      list: { type: 'array', items: ref('SongListSummary') },
      total: { type: 'integer' },
      page: { type: 'integer' },
      limit: { type: 'integer' },
      source: { type: 'string' },
    },
  },
  SourceInfo: {
    type: 'object',
    properties: {
      id: { type: 'string', example: 'kw' },
      name: { type: 'string', example: '酷我音乐' },
      qualities: { type: 'array', items: { type: 'string' }, description: '支持的音质' },
      capabilities: {
        type: 'object',
        properties: {
          search: { type: 'boolean' },
          url: { type: 'boolean' },
          lyric: { type: 'boolean' },
          pic: { type: 'boolean' },
          boards: { type: 'boolean' },
          hotSearch: { type: 'boolean' },
          songList: { type: 'boolean' },
        },
      },
    },
  },
  SourcesResult: {
    type: 'object',
    properties: {
      platforms: { type: 'array', items: ref('SourceInfo') },
    },
  },
  HealthResult: {
    type: 'object',
    properties: {
      status: { type: 'string', example: 'ok' },
      uptime: { type: 'integer', description: '运行秒数' },
      platforms: { type: 'integer', description: '已接入平台数' },
    },
  },
}

/**
 * 从路由元数据构建 OpenAPI 3.1 文档
 * @param {import('../http/router.js').Router} router
 */
export const buildOpenApi = (router, { title, description, version }) => {
  const paths = {}
  for (const route of router.routes) {
    if (route.meta.hide) continue
    const item = paths[route.pattern] || (paths[route.pattern] = {})
    const meta = route.meta
    item[route.method.toLowerCase()] = {
      summary: meta.summary || route.pattern,
      ...(meta.description ? { description: meta.description } : {}),
      tags: meta.tags || ['其他'],
      ...(meta.deprecated ? { deprecated: true } : {}),
      parameters: buildParameters(meta),
      responses: meta.rawResponses || {
        '200': okResponse(meta.dataSchema, meta.responseDescription),
        '422': errorResponse('参数校验失败'),
        ...(meta.possible404 ? { '404': errorResponse('不支持的平台') } : {}),
        ...(meta.possible502 ? { '502': errorResponse('上游平台请求失败') } : {}),
      },
    }
  }

  return {
    openapi: '3.1.0',
    info: { title, description, version },
    servers: [{ url: '/', description: '当前服务器' }],
    tags: [
      { name: '搜索', description: '歌曲搜索与跨平台匹配' },
      { name: '歌曲资源', description: '播放地址、歌词、封面' },
      { name: '榜单', description: '排行榜' },
      { name: '歌单', description: '歌单与热搜' },
      { name: '系统', description: '健康检查、平台信息、文档' },
    ],
    paths,
    components: { schemas: COMPONENT_SCHEMAS },
  }
}
