// OpenAPI 领域模型 —— 注册为 Fastify 共享 schema（fastify.addSchema）
// 路由的 response schema 通过 `名称#` 形式的 $ref 引用；
// @fastify/swagger 生成文档时会自动映射到 components/schemas/名称
// 注：additionalProperties: true 保证运行时序列化不剥离未声明字段

const ref = (name) => ({ $ref: `${name}#` })

export const COMPONENT_SCHEMAS = {
  ErrorEnvelope: {
    type: 'object',
    properties: {
      code: { type: 'integer', description: '与 HTTP 状态码一致', example: 422 },
      msg: { type: 'string', description: '错误描述' },
    },
    additionalProperties: true,
    required: ['code', 'msg'],
  },
  QualityInfo: {
    type: 'object',
    properties: { size: { type: 'string', example: '9.8M' } },
    additionalProperties: true,
  },
  SongType: {
    type: 'object',
    properties: {
      type: { type: 'string', example: '320k', enum: ['128k', '320k', 'flac', 'flac24bit'] },
      size: { type: 'string', example: '9.8M' },
    },
    additionalProperties: true,
  },
  SongInfo: {
    type: 'object',
    properties: {
      songmid: { type: 'string', description: '平台歌曲 id（kg 平台为 hash）' },
      hash: { type: 'string', description: 'kg 平台的歌曲 hash' },
      copyrightId: { type: 'string', description: '平台版权 id（原 mg 平台使用）' },
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
    additionalProperties: true,
  },
  SearchResult: {
    type: 'object',
    properties: {
      source: { type: 'string', description: '来源平台 id，聚合搜索时为 all' },
      list: { type: 'array', items: ref('SongInfo') },
      page: { type: 'integer' },
      limit: { type: 'integer' },
    },
    additionalProperties: true,
  },
  FindResult: {
    type: 'object',
    properties: {
      list: { type: 'array', items: ref('SongInfo'), description: '按匹配度排序的歌曲列表' },
    },
    additionalProperties: true,
  },
  MusicUrlResult: {
    type: 'object',
    properties: {
      type: { type: 'string', example: '320k' },
      url: { type: 'string', description: '播放地址' },
    },
    additionalProperties: true,
  },
  LyricInfo: {
    type: 'object',
    properties: {
      lyric: { type: 'string', description: '原文歌词（LRC）' },
      tlyric: { type: 'string', description: '翻译歌词' },
      rlyric: { type: 'string', description: '罗马音歌词（部分平台）' },
      yrc: { type: 'string', description: '逐字歌词（部分平台）' },
    },
    additionalProperties: true,
    required: ['lyric', 'tlyric'],
  },
  PicResult: {
    type: 'object',
    properties: { url: { type: 'string', description: '封面地址' } },
    additionalProperties: true,
  },
  BoardItem: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '榜单 id，用于榜单详情接口' },
      name: { type: 'string' },
      bangid: { type: 'string', description: '平台原始榜单 id' },
    },
    additionalProperties: true,
  },
  BoardListResult: {
    type: 'object',
    properties: { list: { type: 'array', items: ref('BoardItem') } },
    additionalProperties: true,
  },
  SingerInfo: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '歌手名' },
      desc: { type: ['string', 'null'], description: '歌手简介' },
      avatar: { type: ['string', 'null'], description: '头像地址' },
      gender: { type: ['string', 'null'], description: '性别（man/woman）' },
    },
    additionalProperties: true,
  },
  SingerInfoResult: {
    type: 'object',
    properties: {
      source: { type: 'string' },
      id: { type: 'string', description: '平台歌手 id' },
      info: ref('SingerInfo'),
      count: {
        type: 'object',
        properties: {
          music: { type: ['integer', 'null'], description: '歌曲数' },
          album: { type: ['integer', 'null'], description: '专辑数' },
        },
        additionalProperties: true,
      },
    },
    additionalProperties: true,
  },
  SingerAlbumItem: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '专辑 id，可用于 /album/:source/:id' },
      mid: { type: 'string', description: 'tx 平台专辑 mid' },
      count: { type: ['integer', 'null'], description: '专辑曲目数' },
      info: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          author: { type: ['string', 'null'] },
          img: { type: ['string', 'null'] },
          desc: { type: ['string', 'null'] },
        },
        additionalProperties: true,
      },
    },
    additionalProperties: true,
  },
  SingerAlbumListResult: {
    type: 'object',
    properties: {
      source: { type: 'string' },
      list: { type: 'array', items: ref('SingerAlbumItem') },
      page: { type: 'integer' },
      limit: { type: 'integer' },
      total: { type: ['integer', 'string', 'null'] },
    },
    additionalProperties: true,
  },
  SingerSongListResult: {
    type: 'object',
    properties: {
      source: { type: 'string' },
      list: { type: 'array', items: ref('SongInfo') },
      page: { type: 'integer' },
      limit: { type: 'integer' },
      total: { type: ['integer', 'string', 'null'] },
    },
    additionalProperties: true,
  },
  AlbumInfo: {
    type: 'object',
    properties: {
      name: { type: ['string', 'null'], description: '专辑名' },
      img: { type: ['string', 'null'], description: '专辑封面' },
      desc: { type: ['string', 'null'], description: '专辑简介' },
      author: { type: ['string', 'null'], description: '专辑作者' },
    },
    additionalProperties: true,
  },
  AlbumDetailResult: {
    type: 'object',
    properties: {
      source: { type: 'string' },
      info: ref('AlbumInfo'),
      list: { type: 'array', items: ref('SongInfo'), description: '专辑曲目' },
      page: { type: 'integer' },
      limit: { type: ['integer', 'string', 'null'] },
      total: { type: ['integer', 'string', 'null'] },
    },
    additionalProperties: true,
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
    additionalProperties: true,
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
    additionalProperties: true,
  },
  HotSearchResult: {
    type: 'object',
    properties: {
      source: { type: 'string' },
      list: { type: 'array', items: { type: 'string' } },
    },
    additionalProperties: true,
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
    additionalProperties: true,
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
    additionalProperties: true,
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
          singer: { type: 'boolean', description: '支持歌手接口（/singer/:source/:id）' },
          album: { type: 'boolean', description: '支持专辑接口（/album/:source/:id）' },
        },
        additionalProperties: true,
      },
    },
    additionalProperties: true,
  },
  SourcesResult: {
    type: 'object',
    properties: {
      platforms: { type: 'array', items: ref('SourceInfo') },
    },
    additionalProperties: true,
  },
  HealthResult: {
    type: 'object',
    properties: {
      status: { type: 'string', example: 'ok' },
      uptime: { type: 'integer', description: '运行秒数' },
      platforms: { type: 'integer', description: '已接入平台数' },
    },
    additionalProperties: true,
  },
}
