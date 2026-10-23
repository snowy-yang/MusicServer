# 平台移植契约

本文件是 TypeScript → Python 迁移的唯一契约来源。每个平台包都必须按此实现，
**不要把 TS 机械直译**：各平台方法签名差异很大（见「签名差异」一节），逐个核对。

## 1. 目录与命名

| TypeScript | Python |
| --- | --- |
| `sdk/kw/index.ts` | `app/sdk/platforms/kw/__init__.py` |
| `sdk/kw/musicSearch.ts` | `app/sdk/platforms/kw/music_search.py` |
| `sdk/kw/hotSearch.ts` | `app/sdk/platforms/kw/hot_search.py` |
| `sdk/kw/songList.ts` | `app/sdk/platforms/kw/song_list.py` |
| `sdk/apis/kw.ts` | `app/sdk/apis/kw.py` |
| `sdk/5sing/*` | `app/sdk/platforms/fivesing/*` |
| `sdk/auth/wy.ts` | `app/sdk/auth/wy.py` |
| `sdk/bili/login.ts` | `app/sdk/auth/bili.py` |

命名规则：文件名/属性名 camelCase → snake_case；类名保持 PascalCase。
平台 id 对外仍是两字母短码（`kw kg tx wy mg bd joox bili 5sing apple` + 有声 `xm me qt lr`），
包目录名用 `fivesing`（Python 标识符不能以数字开头），但 `MODULE.id` 必须是 `"5sing"`。

## 2. 平台模块入口

每个 `app/sdk/platforms/<pkg>/__init__.py` 导出 `MODULE`：

```python
from app.sdk.platforms._base import Platform
from app.sdk.platforms.kw import album, hot_search, leaderboard, lyric, music_search, pic, playlist, song_list

MODULE = Platform(
    id="kw",
    name="酷我音乐",
    music_search=music_search,  # 子模块对象（有 .search 方法）
    leaderboard=leaderboard,  # .get_boards() / .get_list(bangid, page)
    song_list=song_list,  # .get_list(sort_id, tag_id, page) / .sort_list
    hot_search=hot_search,  # .get_list()
    album=album,
    playlist=playlist,
    get_lyric=lyric.get_lyric,  # 顶层方法直接挂函数
    get_pic=pic.get_pic,
)
```

`get_music_url` **不要**挂在平台模块上，它属于 `app/sdk/apis/<pkg>.py`；
`app/sdk/__init__.py` 的 `_quality_table()` 从 apis 模块读 `SUPPORT_QUALITYS`。
若平台需要对外暴露 `get_music_url`（如 `/sources` 的 `url` 能力位），
在 `Platform(...)` 里传 `get_music_url=apis.get_music_url`。

**缺省即不支持**：没有的成员不要写 `None` 占位，直接省略。`/sources` 与路由 404 都据此判断。

## 3. 子模块协议

```python
# music_search
async def search(keyword: str, page: int = 1, limit: int = 20, retry_num: int = 0) -> dict
# → {"list": [SongInfo, ...], "total": int|None, "limit": int, "source": str, "allPage": int|None}

# leaderboard
async def get_boards() -> dict            # → {"list": [{"id", "name", "bangid"}]}
async def get_list(bangid: str, page: int = 1) -> dict
# → {"list": [SongInfo], "total": int|str|None, "page": int, "limit": int, "source": str}

# song_list
async def get_list(sort_id, tag_id, page: int = 1) -> dict
sort_list: list[dict]                     # 可选：[{"id","name"}]，路由取首项作默认排序

# hot_search
async def get_list() -> dict              # → {"list": [str], "source": str}

# singer
async def get_info(singer_id: str) -> dict
async def get_song_list(singer_id: str, page: int = 1, limit: int = 20) -> dict
async def get_album_list(singer_id: str, page: int = 1, limit: int = 20) -> dict

# album
async def get_album_detail(album_id: str, page: int = 1, limit: int = 20) -> dict   # 优先
async def get_album_list_detail(album_id: str, page: int = 1) -> dict              # kw 用这个（第 2 参是页码，第 3 参是重试次数，不要透传 limit）
async def search_album(keyword: str, page: int = 1, limit: int = 20) -> dict | list

# playlist
async def get_playlist_detail(playlist_id: str, page: int = 1, limit: int = 20) -> dict
async def get_playlist_songs(playlist_id: str) -> list                             # 可选，详情签名不支持分页时的兜底
async def search_playlist(keyword: str, page: int = 1, limit: int = 20) -> dict | list
async def get_categories() -> dict | list
async def get_category_playlists(category_id: str, page: int = 1, limit: int = 20) -> dict | list

# parse
async def parse_song(link: str) -> dict
async def parse_album(link: str) -> dict
async def parse_playlist(link: str) -> dict

# user_playlist
async def get_list(page: int = 1, limit: int = 20) -> dict | list
```

返回裸数组也可以（路由会把 `list` 与 `total` 补齐），但**能返回完整结构就返回完整结构**。

## 4. 顶层方法

```python
async def get_music_url(song_info: dict, quality: str, retry_num: int = 0) -> dict
# → {"type": <实际命中音质>, "url": <播放地址>}
# 可选附加：{"encrypted": True, "fileKey": "..."} —— mg 的 Z3D/I3D 加密流

async def get_lyric(song_info: dict) -> dict     # → {"lyric", "tlyric", "rlyric"?, "yrc"?}
async def get_pic(song_info: dict) -> str        # → 封面 URL
async def get_music_info(song_info: dict) -> dict        # 可选
async def handle_music_info(song_info: dict) -> dict     # 可选：补全 name/singer/img/albumName
```

`song_info` 是普通 dict，路由传入的关键字段：
`{"songmid": id, "hash": id, "copyrightId": id, "albumId": album_id or "", "name": ..., "singer": ..., "interval": ..., "_types": {}}`。
平台按需读取，缺失就用空值兜底，**不要假设字段一定存在**（原 TS 同样如此）。

## 5. 请求层用法

```python
from app.sdk.common.request import http_fetch

resp = await http_fetch(url, headers={...})  # 默认 GET
resp = await http_fetch(url, method="POST", form={...})  # urlencoded
resp = await http_fetch(url, method="POST", body={...})  # JSON
resp = await http_fetch(url, timeout=10_000)  # 毫秒，与原文一致

resp.status_code  # int（Node 的 statusCode）
resp.body  # 已解析：JSON → dict/list，否则 str
resp.raw  # 原始 bytes
resp.header("set-cookie")
```

与 TS 的差异（迁移时必改）：

| TS 写法 | Python 写法 |
| --- | --- |
| `const { promise, cancelHttp } = httpFetch(...)` `await promise` | `await http_fetch(...)` |
| `.then(({ body }) => ...)` | `resp = await http_fetch(...)`; 用 `resp.body` |
| `new Promise(...)` 包一层 | 直接 `async def` |
| `Promise.all(tasks)` | `await asyncio.gather(*tasks)` |
| `Promise.allSettled` | `asyncio.gather(..., return_exceptions=True)` |
| `setTimeout` | `await asyncio.sleep(ms / 1000)` |
| `Buffer.from(x, 'hex')` | `bytes.fromhex(x)` |
| `Buffer.from(x).toString('base64')` | `base64.b64encode(x).decode()` |
| `crypto.createHash('md5')` | `hashlib.md5(...).hexdigest()` |
| `crypto.createHmac('sha256', k)` | `hmac.new(k.encode(), msg.encode(), hashlib.sha256)` |
| `crypto.createDecipheriv('aes-128-ecb')` | `from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes` |
| `crypto.randomUUID()` | `uuid.uuid4().hex` / `str(uuid.uuid4())` |
| `zlib.inflateSync/inflateRawSync` | `zlib.decompress(data, 15 + 32)` / `zlib.decompress(data, -15)` |
| `iconv-lite.decode(buf, 'gbk')` | `buf.decode('gbk', errors='replace')` |
| `qrcode` 生成二维码 | `app/sdk/common/qrcode.py` 的 `to_data_url(text)` |
| `Date.now()` | `int(time.time() * 1000)` |
| `Math.random()` | `random.random()` |
| `JSON.stringify(x)` | `json.dumps(x, ensure_ascii=False, separators=(",", ":"))` |
| `Object.keys(a).sort().join('&')` | `"&".join(f"{k}={v}" for k, v in sorted(a.items()))` |

**Node 内置模块只有这四处**，其余平台不需要额外依赖：
`crypto`（`apis/kw.ts`、`kw/util.ts`、`wy/utils/crypto.ts`、`sdk/utils.ts`）、
`zlib`（`tx/qrcDecode.ts`）、`iconv-lite`（`kw/lyricDecode.ts`）、`qrcode`（`bili/login.ts`）。

## 6. 工具函数

`app/sdk/common/utils.py`：`size_formate` / `format_play_time` / `date_format` / `date_format2` /
`format_play_count` / `decode_name` / `format_singer_name` / `pick` / `to_md5`。

平台模块里 `import { sizeFormate } from '../common/utils.ts'` 对应：

```python
from app.sdk.common.utils import size_formate
```

`sdk/utils.ts` 里的 `formatSinger` 对应 `format_singer_name`（签名：`(singers, name_key="name", join="、")`）。

## 7. 凭据

```python
from app.sdk.auth_store import get_credentials, set_credentials, get_kg_auth, get_tx_auth, get_cookie

get_cookie("xm")  # 空字符串表示未登录
get_kg_auth()  # {"token", "userid"} 或 None
get_tx_auth()  # {"cookie", "uin"} 或 None
```

## 8. 错误

平台内部抛 `RuntimeError("上游返回: ...")` 即可，路由层统一转 502。
**不要抛 `ApiError`**（那是路由层的），除非确需指定状态码（如登录失效 401）。

平台内部对「可降级的失败」（换音质档、换接口、换 CDN）必须自己 catch 后重试，
不要让它冒泡成 502 —— 与原始实现的降级链一致。

## 9. 签名差异（逐个核对，别批量替换）

| 平台 | 取流 id | 特别之处 |
| --- | --- | --- |
| kw | `songmid` | `apis/kw.py` 双通道：mobi.s（主，需校验 bitrate 精确命中 + 公开格式白名单）→ web playUrl（需动态 cookie 算 Secret 头）。CDN 返回的 query 用 `$` 顶替 `=`，必须还原。 |
| kg | `hash` | 取流需 `encode_album_audio_id`；有 `login.token` 时走 VIP 通道。歌词是 KRC 需解密（`krcDecode.ts`）。 |
| tx | `songmid` → 需先查 `songmid → media_mid` | 音质候选表 + 登录态分支；歌词 QRC 需解密（`qrcDecode.ts`，zlib inflate）。 |
| wy | `songmid` | 取流需 eapi 加密（`wy/utils/crypto.ts`）；未登录走匿名接口。 |
| mg | `copyrightId` | 加密流：返回 `{"encrypted": True, "fileKey": ...}`，路由转 `/stream/mg/<票据>`。解密逐字节 `plain[i] = cipher[i] - key[i % 32]`。 |
| bd | `songmid` | 多 CDN 轮询（失败换下一个）。 |
| joox | `songmid` | 需 JOOX 客户端签名头。 |
| bili | `bvid` / `aid` | 取流需 `cid`，且必须带 Referer/UA。音质档位是 `qn` 整数（不是字符串）。 |
| 5sing | `songId` + `songType` | `songType`：`fc`=翻唱、`yc`=原唱、`bz`=伴奏。音质是 `sq/hq/lq` 不是 `flac/320k/128k`。 |
| apple | `songmid` | 只有 preview 试听片段（完整曲 DRM）。 |
| xm | `trackId` | 需设备指纹 + 签名（`xm/sign.ts`）。付费内容需 cookie。 |
| me | `soundId` | App API 签名（`me/sign.ts`），cookie 里的 `token` 自动带入签名。 |
| qt | `channelId:programId` 复合 id | 见 `/album/qt` 返回的 id。 |
| lr | `bookId:section` 复合 id | 见 `/album/lr` 返回的 id。必须登录态，免费章节也需要。 |

## 10. 验收要求

每个平台移植完成后，**必须真实联网验证**（不靠 mock）：

```bash
uv run python -c "
import asyncio
from app.sdk.platforms.kw import MODULE
async def main():
    r = await MODULE.music_search.search('稻香', 1, 5)
    print(len(r['list']), r['list'][0])
asyncio.run(main())
"
```

至少覆盖：搜索 → 取流 → 歌词 → 封面；有榜单/歌单/专辑能力的再各验一次。
取流验证要打印 URL 并实际 `GET` 前 4 字节确认是音频（`ID3`/`fLaC`/`OggS`/`ftyp`）。
上游接口失效时如实报告并写进注释，**不要用假数据强行通过**。

## 11. 规范

改完必须两条都过：

```bash
uv run ruff check app && uv run ruff format --check app
uv run pyright app/sdk/platforms/<pkg> app/sdk/apis/<pkg>.py
```

`ruff` 规则启用 `E,F,W,I,UP,B,ASYNC,RUF`，行宽 120，双引号，`target-version = py312`。
注释用中文，与既有代码风格一致；只保留解释「为什么」的注释，不复述代码。
