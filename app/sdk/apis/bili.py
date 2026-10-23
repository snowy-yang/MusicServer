"""Bilibili 取流（对应 sdk/apis/bili.ts，上游 bilibili/bilibili.go 的 fetchAudioURL + account.go 的 IsVipAccount）。

接口: x/player/playurl?fnval=&qn=127&bvid=&cid=
  * fnval=80   标准 DASH（匿名可用）
  * fnval=4048 额外请求 FLAC/Hi-Res/Dolby（上游逻辑：大会员才用；匿名请求该参数也不报错，只是没有 flac 节点）

档位选择沿用上游优先级：Hi-Res FLAC(30251) → Dolby(30250) → DASH 标准最高档(30280/30232/30216) → durl 兜底；
仅当显式请求 64k 时优先 30216（上游无此参数意识，移植补的最小档位选择）。

CDN 选址（2026-10-04 实测定稿）：playurl 的 baseUrl 大概率落在 PCDN——京东云无线宝 mcdn.bilivideo.cn:8082、
迅雷 edge.mountaintoys.cn:4483、节点之家 szbdyd.com、派欧云 nexusedgeio.com——单节点、丢包严重，是点歌卡死的根源；
正规 CDN 为 upos-*.bilivideo.com（腾讯/金山/白山/华为）与 upos-*.akamaized.net（Akamai，境外），
cn-*.bilivideo.com 是 B站自建/地区 CDN（同省同运营商单节点，无稳定性问题）。
因此候选集 = 命中档位节点的 baseUrl + backupUrl，按 host 分级排序（upos/akamaized > bilivideo.com 系 > PCDN），
逐个探测、命中即返回；全部失败时回退分级后的最优候选，客户端仍可自行跟跳。
参考 Referer/UA 必须携带，否则 CDN 可能 403；CDN 直链自带签名参数，不带也不应带 Cookie（避免登录态泄给第三方 PCDN 域名）。
"""

from __future__ import annotations

import time
from typing import Any
from urllib.parse import urljoin, urlsplit

from app.sdk.common.request import http_fetch, http_probe
from app.sdk.platforms.bili.util import (
    as_dict,
    as_list,
    bili_headers,
    encode_uri_component,
    fetch_view,
    get_cookie,
    parse_song_id,
)

SUPPORT_QUALITYS: list[str] = ["64k", "128k", "320k", "flac", "flac24bit"]

QUALITY_LABEL: dict[int, str] = {
    30216: "64k",
    30232: "132k",
    30280: "192k",
    30250: "flac",
    30251: "flac24bit",
}

#: CDN 探测预算：单跳最长 8s，全部候选合计不超过 20s（超时即回退最优候选，不再无限等）
PROBE_HOP_TIMEOUT = 8.0
PROBE_TOTAL_BUDGET = 20.0
PROBE_MAX_CANDIDATES = 3

_vip_cache: dict[str, Any] = {"value": False, "at": 0.0}


def reset_vip_cache() -> None:
    """登录态清空/更新后调用，丢弃大会员判断缓存。"""
    _vip_cache["value"] = False
    _vip_cache["at"] = 0.0


async def is_vip_account(cookie: str) -> bool:
    """上游 IsVipAccount：x/web-interface/nav 的 isLogin + vipStatus + vipType（进程内缓存 5 分钟）。"""
    if not cookie:
        return False
    if _vip_cache["at"] and time.time() - _vip_cache["at"] < 5 * 60:
        return bool(_vip_cache["value"])
    try:
        resp = await http_fetch(
            "https://api.bilibili.com/x/web-interface/nav", headers=bili_headers(cookie), timeout=15_000
        )
        body = resp.body if isinstance(resp.body, dict) else {}
        data = as_dict(body.get("data"))
        vip = (
            body.get("code") == 0
            and bool(data.get("isLogin"))
            and int(data.get("vipStatus") or 0) == 1
            and int(data.get("vipType") or 0) > 0
        )
        _vip_cache["value"] = vip
        _vip_cache["at"] = time.time()
        return vip
    except Exception:  # noqa: BLE001 - 判断失败按非会员处理
        return False


def host_rank(url: str) -> int:
    """CDN host 分级：0=正规 CDN（upos-*.bilivideo.com / *.akamaized.net，多地节点）
    1=B站系（cn-* 自建地区 CDN 及其它 bilivideo.com） 2=PCDN（mcdn.bilivideo.cn、mountaintoys、szbdyd 等第三方）"""
    try:
        host = (urlsplit(str(url or "")).hostname or "").lower()
    except ValueError:
        return 2
    if not host:
        return 2
    if host.endswith(".akamaized.net"):
        return 0
    if host.endswith(".bilivideo.com"):
        return 0 if host.startswith("upos-") else 1
    return 2


def node_urls(node: Any) -> list[str]:
    """节点地址收集：baseUrl + backupUrl（去重前的原始序）。"""
    if not isinstance(node, dict):
        return []
    backups: list[Any] = []
    if isinstance(node.get("backupUrl"), list):
        backups.extend(node["backupUrl"])
    if isinstance(node.get("backup_url"), list):
        backups.extend(node["backup_url"])
    urls = [node.get("baseUrl"), *backups]
    return [str(url) for url in urls if url]


def rank_candidates(urls: list[str]) -> list[str]:
    """候选排序：host 分级升序，同级保持原始顺序（baseUrl 官方序优先）。"""
    seen: set[str] = set()
    uniq: list[str] = []
    for url in urls:
        text = str(url or "")
        if not text or text in seen:
            continue
        seen.add(text)
        uniq.append(text)
    ranked = sorted(enumerate(uniq), key=lambda pair: (host_rank(pair[1]), pair[0]))
    return [url for _, url in ranked]


def _pick_audio(data: Any, quality: str) -> dict[str, Any] | None:
    data = as_dict(data)
    dash = as_dict(data.get("dash"))
    flac_info = as_dict(dash.get("flac"))
    flac = as_dict(flac_info.get("audio"))
    hires = flac if int(flac.get("id") or 0) == 30251 and flac.get("baseUrl") else None

    dolby_list = as_list(as_dict(dash.get("dolby")).get("audio"))
    dolby = None
    for item in dolby_list:
        if isinstance(item, dict) and int(item.get("id") or 0) == 30250 and item.get("baseUrl"):
            dolby = item
            break

    audio_list = as_list(dash.get("audio"))
    standards = sorted(
        [item for item in audio_list if isinstance(item, dict) and item.get("baseUrl")],
        key=lambda item: -int(item.get("id") or 0),
    )

    node: dict[str, Any] | None = None
    label = ""
    if quality == "64k":
        low = next((item for item in standards if int(item.get("id") or 0) == 30216), None)
        if low:
            node = low
            label = QUALITY_LABEL[30216]
    # 上游优先级：Hi-Res FLAC → Dolby → 最高标准档
    if node is None and hires:
        node = hires
        label = QUALITY_LABEL[30251]
    if node is None and dolby:
        node = dolby
        label = QUALITY_LABEL[30250]
    if node is None and standards:
        node = standards[0]
        label = QUALITY_LABEL.get(int(node.get("id") or 0), f"audio-{int(node.get('id') or 0)}")
    if node is not None:
        return {"id": int(node.get("id") or 0), "label": label, "urls": rank_candidates(node_urls(node))}

    durl = as_list(data.get("durl"))
    durl_node = durl[0] if durl and isinstance(durl[0], dict) else None
    if durl_node and durl_node.get("url"):
        return {"id": 0, "label": "durl", "urls": rank_candidates(node_urls(durl_node))}
    return None


async def get_audio_url(bvid: str, cid: str | int, quality: str = "128k") -> dict[str, Any]:
    """播放地址 API（上游 fetchAudioURL 的等价实现，返回 ``{"type", "urls"}``；urls 已分级排序，[0] 为最优）。"""
    cookie = await get_cookie()
    need_flac = quality in ("flac", "flac24bit")
    vip = await is_vip_account(cookie)
    fnval = 4048 if (need_flac or vip) else 80
    url = (
        f"https://api.bilibili.com/x/player/playurl?fnval={fnval}&qn=127"
        f"&bvid={encode_uri_component(bvid)}&cid={encode_uri_component(cid)}"
    )
    resp = await http_fetch(url, headers=bili_headers(cookie), timeout=15_000)
    body = resp.body
    if resp.status_code != 200 or not isinstance(body, dict):
        raise RuntimeError(f"B站取流失败（HTTP {resp.status_code}）")
    if body.get("code") != 0:
        message = body.get("message")
        raise RuntimeError(f"B站取流失败（{body.get('code')}{f': {message}' if message else ''}）")
    picked = _pick_audio(body.get("data"), quality)
    if not picked or not picked["urls"]:
        raise RuntimeError("B站未返回可用音频流")
    return {"type": picked["label"], "urls": picked["urls"]}


async def _resolve_url(url: str, deadline: float) -> str:
    """探测单个候选并跟随 302：GET + Range: bytes=0-0，读到响应头即断开。

    HEAD 会被 CDN 404 不能用；也不能等 body 自然结束——CDN 忽略 Range 返回 200 全量时，
    会把整个音频文件下载缓冲完才返回（点歌就卡死在这）。命中 2xx 返回该地址；
    4xx/5xx/超时/网络错误抛错，由调用方换下一候选。
    """
    current = str(url)
    for _hop in range(3):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError("CDN 探测超时（总预算耗尽）")
        timeout_ms = int(min(PROBE_HOP_TIMEOUT, remaining) * 1000)
        status, location = await http_probe(
            current, headers={**bili_headers(), "Range": "bytes=0-0"}, timeout_ms=timeout_ms
        )
        if 300 <= status < 400 and location:
            try:
                current = urljoin(current, location)
                continue
            except ValueError:
                return current
        if 200 <= status < 300:
            return current
        if status >= 400:
            raise RuntimeError(f"CDN 返回 HTTP {status}")
        return current
    return current


async def get_music_url(song_info: dict[str, Any], quality: str, retry_num: int = 0) -> dict[str, Any]:
    """统一取流接口：songmid 约定 ``<bvid>|<cid>``；仅给 bvid 时回源 view 取首P cid。

    CDN 候选按 host 分级探测（upos/cn 正规源优先），全败回退最优候选（fail-soft，客户端可自行跟跳）。
    """
    del retry_num  # 契约参数，B 站按候选链自行兜底
    ids = parse_song_id(song_info.get("songmid") or song_info.get("id"))
    bvid = ids["bvid"]
    if not bvid:
        raise RuntimeError("bili songmid 需为 <bvid>|<cid> 格式")
    real_cid = ids["cid"]
    if not real_cid:
        view = await fetch_view(bvid)
        pages = as_list(view.get("pages"))
        first = pages[0] if pages and isinstance(pages[0], dict) else {}
        real_cid = str(first.get("cid") if first.get("cid") is not None else "")
    if not real_cid:
        raise RuntimeError("B站未找到视频 cid（可能已失效）")
    info = await get_audio_url(bvid, real_cid, quality)

    deadline = time.monotonic() + PROBE_TOTAL_BUDGET
    for candidate in info["urls"][:PROBE_MAX_CANDIDATES]:
        try:
            final_url = await _resolve_url(candidate, deadline)
            return {"type": info["type"], "url": final_url}
        except Exception:  # noqa: BLE001 - 换下一候选
            if time.monotonic() >= deadline:
                break
    # 探测全败（或预算耗尽）：回退分级排序后的最优候选
    return {"type": info["type"], "url": info["urls"][0]}
