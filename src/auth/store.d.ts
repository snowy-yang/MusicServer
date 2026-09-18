// src/auth/store.js 的类型声明（实现为同目录 store.js）
export interface WyCredentials {
  cookie: string
  musicU: string
  userid?: number
  nickname?: string | null
  avatar?: string | null
  vipType?: number | null
  updatedAt?: string
}

export interface KgCredentials {
  token: string
  userid: number | string
  nickname?: string | null
  updatedAt?: string
}

interface KgDevice {
  guid: string
  mid: string
  dfid: string
}

export declare function getCredentials(platform: 'wy' | 'kg' | '_kg_device'): WyCredentials | KgCredentials | KgDevice | null
export declare function setCredentials(platform: 'wy' | 'kg' | '_kg_device', credentials: object): void
export declare function clearCredentials(platform: 'wy' | 'kg' | '_kg_device'): void
export declare function getWyCookie(): string
export declare function getKgAuth(): { token: string; userid: number | string } | null
