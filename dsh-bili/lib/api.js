/**
 * dsh-bili —— B站只读接口客户端 + 扫码登录
 *
 * 只调用：
 *   · passport 二维码登录（generate / poll）
 *   · 个人资料的只读 GET 接口
 * 不做任何写操作（不点赞、不投币、不发动态）。
 */

import { cookieHeader } from './store.js'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 简单全局限速：两次请求之间至少间隔 600~1100ms，避免触发风控
let lastAt = 0
async function pace() {
  const wait = Math.max(0, lastAt + 600 + Math.random() * 500 - Date.now())
  if (wait > 0) await sleep(wait)
  lastAt = Date.now()
}

export class BiliError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'BiliError'
    this.code = code
  }
}

function headers(session, extra = {}) {
  const h = {
    'User-Agent': UA,
    Referer: 'https://www.bilibili.com/',
    Origin: 'https://www.bilibili.com',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    ...extra,
  }
  if (session) h.Cookie = cookieHeader(session)
  return h
}

/**
 * 发一次 GET，返回解析后的 json。
 * 对 -412/-352/429/5xx 做退避重试；-101 直接报「未登录」。
 */
export async function get(session, endpoint, params = {}, { retries = 4, signal } = {}) {
  const url = new URL(endpoint)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    await pace()
    let res
    try {
      res = await fetch(url, { headers: headers(session), signal: signal ?? AbortSignal.timeout(20000) })
    } catch (error) {
      if (attempt === retries) throw new BiliError(`网络请求失败：${error?.message || error}`, 'NETWORK')
      await sleep(1200 * (attempt + 1))
      continue
    }

    if (res.status === 412 || res.status === 429) {
      if (attempt === retries) throw new BiliError(`被风控（HTTP ${res.status}），请稍后再试`, 'BLOCKED')
      await sleep(4000 * (attempt + 1))
      continue
    }
    if (res.status >= 500) {
      if (attempt === retries) throw new BiliError(`服务端错误 HTTP ${res.status}`, 'SERVER')
      await sleep(2000 * (attempt + 1))
      continue
    }
    if (!res.ok) throw new BiliError(`HTTP ${res.status}`, 'HTTP')

    let json
    try { json = await res.json() }
    catch { throw new BiliError('返回内容不是 JSON（可能被拦截）', 'PARSE') }

    if (json.code !== 0) {
      if (json.code === -101) throw new BiliError('未登录或登录已失效（-101），请重新执行 bili_login', -101)
      if ((json.code === -352 || json.code === -412) && attempt < retries) {
        await sleep(4000 * (attempt + 1))
        continue
      }
      throw new BiliError(`接口返回 ${json.code} ${json.message || ''}`.trim(), json.code)
    }
    return json
  }
  throw new BiliError('重试次数用尽', 'EXHAUSTED')
}

// ---------------------------------------------------------------------------
// 扫码登录
// ---------------------------------------------------------------------------

/** 生成二维码载荷：返回 { url, key }。url 可以用手机直接打开。 */
export async function qrGenerate() {
  const json = await get(null, 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate')
  const data = json.data || {}
  if (!data.url || !data.qrcode_key) throw new BiliError('二维码生成失败：返回缺少 url/qrcode_key', 'QR')
  return { url: data.url, key: data.qrcode_key }
}

/**
 * 轮询一次扫码状态。
 * 返回 { state: 'waiting'|'scanned'|'expired'|'ok', message, cookies? }
 */
export async function qrPoll(key) {
  await pace()
  const url = new URL('https://passport.bilibili.com/x/passport-login/web/qrcode/poll')
  url.searchParams.set('qrcode_key', key)
  const res = await fetch(url, { headers: headers(null), signal: AbortSignal.timeout(20000) })
  const json = await res.json()
  const data = json.data || {}
  const inner = data.code

  if (inner === 86101) return { state: 'waiting', message: '尚未扫码' }
  if (inner === 86090) return { state: 'scanned', message: '已扫码，请在手机上确认登录' }
  if (inner === 86038) return { state: 'expired', message: '二维码已过期，请重新生成' }
  if (inner !== 0) return { state: 'waiting', message: data.message || `未知状态 ${inner}` }

  // 成功：cookie 在 redirect url 的 query 里，buvid 在 Set-Cookie 里
  const cookies = {}
  try {
    const redirect = new URL(data.url)
    for (const [k, v] of redirect.searchParams) {
      if (/^(SESSDATA|bili_jct|DedeUserID|DedeUserID__ckMd5|sid|buvid3|buvid4)$/.test(k)) cookies[k] = v
    }
  } catch { /* ignore */ }

  try {
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
    for (const line of setCookies) {
      const m = /^([^=]+)=([^;]*)/.exec(line)
      if (m) cookies[m[1].trim()] = m[2].trim()
    }
  } catch { /* ignore */ }

  if (!cookies.SESSDATA) {
    return { state: 'error', message: '登录成功但没拿到 SESSDATA，请重试' }
  }
  return { state: 'ok', message: '登录成功', cookies }
}

// ---------------------------------------------------------------------------
// 只读数据
// ---------------------------------------------------------------------------

export async function fetchNav(session, signal) {
  const json = await get(session, 'https://api.bilibili.com/x/web-interface/nav', {}, { signal })
  const d = json.data || {}
  if (!d.isLogin) throw new BiliError('未登录或登录已失效（isLogin=false），请重新执行 bili_login', -101)
  return {
    mid: d.mid,
    uname: d.uname,
    avatar: d.face,
    level: d.level_info?.current_level ?? null,
    vip: !!d.vipStatus,
    coins: d.money ?? null,
  }
}

/** 观看历史：progress 是「看到第几秒」，duration 是总时长。 */
export async function fetchHistory(session, { limit = 2000, signal } = {}) {
  const out = []
  let cursor = { max: 0, view_at: 0, business: '' }
  let guard = 0
  while (guard++ < 300) {
    const json = await get(
      session,
      'https://api.bilibili.com/x/web-interface/history/cursor',
      { ps: 30, max: cursor.max, view_at: cursor.view_at, business: cursor.business, type: 'archive' },
      { signal },
    )
    const list = json.data?.list || []
    for (const it of list) {
      out.push({
        title: it.title || '',
        bvid: it.history?.bvid || '',
        author: it.author_name || '',
        authorMid: it.author_mid || 0,
        tag: it.tag_name || '',
        progress: it.progress || 0,
        duration: it.duration || 0,
        viewAt: it.view_at || 0,
        finished: !!it.is_finish,
        part: it.history?.part || '',
      })
    }
    const next = json.data?.cursor || {}
    if (!list.length || !next.max) break
    cursor = next
    if (out.length >= limit) break
  }
  return out
}

export async function fetchFollowings(session, mid, { signal } = {}) {
  const out = []
  for (let pn = 1; pn <= 20; pn++) {
    const json = await get(
      session,
      'https://api.bilibili.com/x/relation/followings',
      { vmid: mid, ps: 50, pn, order: 'desc' },
      { signal },
    )
    const list = json.data?.list || []
    for (const u of list) out.push({ mid: u.mid, uname: u.uname, sign: u.sign || '', official: u.official_verify?.type || 0 })
    if (list.length < 50) break
  }
  return out
}

export async function fetchFavorites(session, mid, { maxFolders = 6, signal } = {}) {
  const json = await get(session, 'https://api.bilibili.com/x/v3/fav/folder/created/list-all', { up_mid: mid }, { signal })
  const folders = (json.data?.list || []).slice().sort((a, b) => (b.media_count || 0) - (a.media_count || 0)).slice(0, maxFolders)
  const out = []
  for (const f of folders) {
    const folder = { id: f.id, title: f.title, count: f.media_count || 0, items: [] }
    for (let pn = 1; pn <= 10; pn++) {
      const page = await get(
        session,
        'https://api.bilibili.com/x/v3/fav/resource/list',
        { media_id: f.id, pn, ps: 20, order: 'mtime', type: 0, tid: 0, platform: 'web' },
        { signal },
      )
      const medias = page.data?.medias || []
      for (const m of medias) {
        folder.items.push({
          title: m.title || '',
          bvid: m.bvid || '',
          author: m.upper?.name || '',
          authorMid: m.upper?.mid || 0,
          duration: m.duration || 0,
          favTime: m.fav_time || 0,
        })
      }
      if (!page.data?.has_more) break
    }
    out.push(folder)
  }
  return out
}
