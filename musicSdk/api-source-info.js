// Support qualitys: 128k 320k flac wav

const sources = [
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
  // {
  //   id: 'temp',
  //   name: '临时接口',
  //   disabled: false,
  //   supportQualitys: {
  //     kw: ['128k'],
  //   },
  // },
  {
    id: 'v5',
    name: 'lx-music-source-v5 聚合源',
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
