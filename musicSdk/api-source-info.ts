// 接口源声明：id 与 api-source.ts 中 allApi 的 `<id>_<source>` 键对应
// Support qualitys: 128k 320k flac wav

interface ApiSourceInfo {
  id: string
  name: string
  disabled: boolean
  supportQualitys: Partial<Record<'kw' | 'kg' | 'tx' | 'wy' | 'mg' | 'bd', string[]>>
}

const sources: ApiSourceInfo[] = [
  // {
  //   id: 'test',
  //   name: '测试接口',
  //   disabled: false,
  //   supportQualitys: {
  //     kw: ['128k'],
  //     kg: ['128k'],
  //     tx: ['128k'],
  //     wy: ['128k'],
  //     mg: ['128k'],
  //     // bd: ['128k'],
  //   },
  // },
  {
    id: 'source',
    name: '外部聚合音源',
    disabled: false,
    supportQualitys: {
      kw: ['128k', '320k', 'flac'],
      kg: ['128k', '320k', 'flac'],
      tx: ['128k', '320k', 'flac'],
      wy: ['128k', '320k', 'flac'],
      mg: ['128k', '320k', 'flac'],
      // bd: ['128k', '320k', 'flac'],
    },
  },
]

export default sources
