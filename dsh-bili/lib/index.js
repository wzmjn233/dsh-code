/**
 * dsh-bili —— 让 DSH 直接连上 B站（扫码登录 + 只读数据）
 *
 * 提供的工具：
 *   bili_login    开始扫码登录 / 查询登录结果
 *   bili_status   登录状态（不含任何凭据）
 *   bili_report   观看历史聚合分析（看得最多的 UP、完成度、分区、值得关注但未关注）
 *   bili_history  原始观看历史（可分页/按天数过滤）
 *   bili_lists    关注列表 / 收藏夹
 *   bili_logout   清除本机会话
 *
 * 设计约束：
 *   · 只做只读请求，任何写操作都不提供
 *   · cookie 只落盘 $DSH_HOME/bili/session.json（0600），工具返回值里永远没有 cookie
 *   · 所有异常文本经过 scrub() 脱敏
 */

import {
  clearPending,
  clearSession,
  describeSession,
  loadCache,
  loadPending,
  loadSession,
  paths,
  saveCache,
  savePending,
  saveSession,
  scrub,
} from './store.js'
import { BiliError, fetchFavorites, fetchFollowings, fetchHistory, fetchNav, qrGenerate, qrPoll } from './api.js'
import { analyze } from './report.js'

export const name = 'bili'

export const inject = ['tools']

const CACHE_MAX_AGE_MS = 6 * 3600 * 1000

// ---------------------------------------------------------------------------
// schema 片段
// ---------------------------------------------------------------------------

const EMPTY_PARAMS = { type: 'object', additionalProperties: false, properties: {} }

function textOut(description) {
  return {
    schema: { type: 'object', description, properties: {}, additionalProperties: true },
    render: (_args, value) => {
      const text = typeof value === 'string' ? value : value?.markdown || JSON.stringify(value, null, 2)
      return [{ type: 'text', text }]
    },
  }
}

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------

function requireSession() {
  const session = loadSession()
  if (!session) {
    throw new Error('还没有登录。先调用 bili_login（action=start）拿到登录链接，在手机上确认后再调用 bili_login（action=check）。')
  }
  return session
}

async function executeLogin(args, ctx) {
  const action = args?.action === 'check' ? 'check' : 'start'
  const signal = ctx?.signal

  if (action === 'start') {
    const { url, key } = await qrGenerate()
    savePending({ key, url, createdAt: Date.now() })
    return {
      state: 'waiting',
      url,
      expiresInSeconds: 180,
      markdown: [
        '## 扫码登录 B站',
        '',
        '**在手机上打开下面这个链接，B站 App 会接管并弹出「确认登录」：**',
        '',
        url,
        '',
        '确认之后再让我调用一次 `bili_login`（action=check）即可完成登录。',
        '',
        `- 二维码有效期约 3 分钟`,
        `- 登录凭据只会保存到本机 ${paths.session}`,
      ].join('\n'),
    }
  }

  const pending = loadPending()
  if (!pending?.key) {
    return { state: 'none', markdown: '当前没有进行中的登录。先执行 `bili_login`（action=start）。' }
  }

  const polled = await qrPoll(pending.key)
  if (polled.state === 'ok') {
    const session = saveSession(polled.cookies, {})
    clearPending()
    let nav = null
    try {
      nav = await fetchNav(session, signal)
      session.profile = { mid: nav.mid, uname: nav.uname, avatar: nav.avatar }
      saveSession(session.cookies, session.profile)
    } catch (error) {
      // 登录成功但资料没取到，不影响使用
      nav = null
    }
    return {
      state: 'ok',
      mid: nav?.mid ?? session.cookies?.DedeUserID ?? null,
      uname: nav?.uname ?? null,
      markdown: [
        '## 登录成功',
        '',
        nav ? `账号：**${nav.uname}**（mid ${nav.mid}）` : '已拿到会话，但昵称没取到（不影响使用）',
        '',
        `凭据已保存到 \`${paths.session}\`（权限 0600），不会出现在任何工具返回值里。`,
        '',
        '接下来可以直接用 `bili_report` 出分析。',
      ].join('\n'),
    }
  }

  if (polled.state === 'expired') clearPending()
  return {
    state: polled.state,
    markdown: [
      `## 登录状态：${polled.message}`,
      '',
      polled.state === 'expired'
        ? '二维码已过期。重新调用 `bili_login`（action=start）生成新的。'
        : '在手机上完成确认后，再调用一次 `bili_login`（action=check）。',
    ].join('\n'),
  }
}

async function executeStatus(_args, ctx) {
  const session = loadSession()
  const base = describeSession(session)
  if (!session) {
    return { ...base, markdown: '未登录。调用 `bili_login`（action=start）开始扫码登录。' }
  }
  let nav = null
  let liveError = null
  try {
    nav = await fetchNav(session, ctx?.signal)
    session.profile = { mid: nav.mid, uname: nav.uname, avatar: nav.avatar }
    saveSession(session.cookies, session.profile)
  } catch (error) {
    liveError = scrub(error?.message || error, session)
  }
  return {
    ...base,
    live: !!nav,
    uname: nav?.uname ?? base.uname,
    mid: nav?.mid ?? base.mid,
    level: nav?.level ?? null,
    vip: nav?.vip ?? null,
    error: liveError,
    markdown: [
      '## 登录状态',
      '',
      nav ? `✅ 在线有效 — **${nav.uname}**（mid ${nav.mid}，Lv${nav.level ?? '?'}${nav.vip ? '，大会员' : ''}）` : `⚠️ 本地有会话但接口验证失败：${liveError}`,
      '',
      `- 保存时间：${base.savedAtText}`,
      `- 凭据文件：\`${paths.session}\``,
      `- 包含字段：${base.cookieNames.join('、')}`,
      nav ? '' : '\n需要重新登录的话，执行 `bili_login`（action=start）。',
    ].join('\n'),
  }
}

async function gather(ctx, { refresh = false } = {}) {
  const session = requireSession()
  const cached = loadCache()
  if (!refresh && cached && Date.now() - (cached.fetchedAt || 0) < CACHE_MAX_AGE_MS) {
    return { session, data: cached, fromCache: true }
  }
  const nav = await fetchNav(session, ctx?.signal).catch(() => null)
  const mid = nav?.mid || session.profile?.mid || session.cookies?.DedeUserID
  const history = await fetchHistory(session, { signal: ctx?.signal })
  const followings = mid ? await fetchFollowings(session, mid, { signal: ctx?.signal }).catch(() => []) : []
  const favorites = mid ? await fetchFavorites(session, mid, { signal: ctx?.signal }).catch(() => []) : []
  const data = { fetchedAt: Date.now(), mid, profile: nav, history, followings, favorites }
  saveCache(data)
  return { session, data, fromCache: false }
}

async function executeReport(args, ctx) {
  const { data, fromCache } = await gather(ctx, { refresh: args?.refresh === true })
  const { summary, markdown } = analyze({
    history: data.history,
    followings: data.followings,
    favorites: data.favorites,
    now: data.fetchedAt,
  })
  const head = [
    `> 数据抓取于 ${new Date(data.fetchedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}${fromCache ? '（命中本地缓存，6 小时内不重复抓）' : ''}`,
    '',
  ].join('\n')
  return {
    videos: summary.videos,
    totalHours: summary.totalHours,
    finishedRate: summary.finishedRate,
    topUps: summary.topUps,
    notFollowed: summary.notFollowed,
    topTags: summary.topTags,
    markdown: head + markdown,
  }
}

async function executeHistory(args, ctx) {
  const { data } = await gather(ctx, {})
  const limit = Math.min(Math.max(Number(args?.limit) || 100, 1), 2000)
  const sinceDays = Number(args?.sinceDays) || 0
  const cutoff = sinceDays > 0 ? data.fetchedAt / 1000 - sinceDays * 86400 : 0
  const list = data.history
    .filter((h) => !cutoff || (h.viewAt || 0) >= cutoff)
    .slice(0, limit)
    .map((h) => ({
      title: h.title,
      author: h.author,
      tag: h.tag,
      watchedSeconds: h.progress,
      durationSeconds: h.duration,
      completionPercent: h.duration ? Math.round((h.progress / h.duration) * 100) : null,
      viewAtText: h.viewAt ? new Date(h.viewAt * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : null,
    }))
  const lines = [`## 观看历史（${list.length} / 共 ${data.history.length} 条）`, '']
  for (const h of list) {
    lines.push(`- [${h.completionPercent ?? '?'}%] **${h.author}** — ${h.title}（${h.tag || '未知分区'}，${h.viewAtText || ''}）`)
  }
  return { total: data.history.length, returned: list.length, items: list, markdown: lines.join('\n') }
}

async function executeLists(args, ctx) {
  const kind = args?.kind === 'favorites' ? 'favorites' : 'followings'
  const { data } = await gather(ctx, {})
  if (kind === 'followings') {
    const lines = [`## 关注（${data.followings.length} 个）`, '']
    for (const u of data.followings) lines.push(`- ${u.uname}（mid ${u.mid}）${u.sign ? ' — ' + u.sign : ''}`)
    return { kind, count: data.followings.length, items: data.followings, markdown: lines.join('\n') }
  }
  const lines = [`## 收藏夹（${data.favorites.length} 个）`, '']
  for (const f of data.favorites) {
    lines.push(`### ${f.title}（${f.items.length} / ${f.count} 条）`)
    for (const m of f.items.slice(0, 50)) lines.push(`- **${m.author}** — ${m.title}`)
    lines.push('')
  }
  return { kind, count: data.favorites.reduce((s, f) => s + f.items.length, 0), folders: data.favorites, markdown: lines.join('\n') }
}

function executeLogout() {
  const had = describeSession(loadSession()).loggedIn
  clearSession()
  clearPending()
  return {
    ok: true,
    had,
    markdown: had
      ? '已清除本机会话。想彻底作废这个登录态，去 bilibili.com 安全中心「退出所有设备」。'
      : '本来就没有登录会话。',
  }
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

const LOGIN_PARAMS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['start', 'check'],
      description: 'start=生成登录链接；check=查询上一次生成的结果。默认 start。',
    },
  },
}

const REPORT_PARAMS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    refresh: {
      type: 'boolean',
      description: '为 true 时忽略 6 小时本地缓存，重新抓取全部数据。',
    },
  },
}

const HISTORY_PARAMS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'number', description: '返回多少条，默认 100，上限 2000。' },
    sinceDays: { type: 'number', description: '只返回最近 N 天的记录；省略或 0 = 全部。' },
  },
}

const LISTS_PARAMS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['followings', 'favorites'], description: 'followings=关注列表；favorites=收藏夹。默认 followings。' },
  },
}

function wrap(fn) {
  return async (args, exec) => {
    try {
      return await fn(args, exec)
    } catch (error) {
      if (error instanceof BiliError) {
        throw new Error(scrub(error.message))
      }
      throw new Error(scrub(error?.message || String(error)))
    }
  }
}

const TOOLS = [
  {
    name: 'bili_login',
    description:
      '登录 B站。action=start 生成扫码登录链接（用户在手机 B站 App 里确认）；action=check 查询是否已确认。凭据只存本机，不会出现在返回值里。',
    parameters: LOGIN_PARAMS,
    output: textOut('登录状态与下一步说明'),
    isConcurrencySafe: () => false,
    timeoutMs: 60_000,
    execute: wrap(executeLogin),
  },
  {
    name: 'bili_status',
    description: '检查 B站登录状态：是否已登录、昵称、mid、等级、凭据保存时间。返回值不含任何 cookie。',
    parameters: EMPTY_PARAMS,
    output: textOut('登录状态'),
    isConcurrencySafe: () => true,
    timeoutMs: 30_000,
    execute: wrap(executeStatus),
  },
  {
    name: 'bili_report',
    description:
      '抓取并分析你的 B站观看历史：实际花时间最多的 UP 主、完成度分布、内容分区排名，以及「看了很多但还没关注」的 UP 主（这就是最靠谱的推荐）。结果缓存 6 小时。',
    parameters: REPORT_PARAMS,
    output: textOut('观看数据聚合报告'),
    isConcurrencySafe: () => false,
    timeoutMs: 180_000,
    execute: wrap(executeReport),
  },
  {
    name: 'bili_history',
    description: '列出观看历史明细，含每条看了多少秒、完成度百分比、UP 主与分区。可按天数过滤。',
    parameters: HISTORY_PARAMS,
    output: textOut('观看历史明细'),
    isConcurrencySafe: () => true,
    timeoutMs: 120_000,
    execute: wrap(executeHistory),
  },
  {
    name: 'bili_lists',
    description: '列出关注列表或收藏夹内容。',
    parameters: LISTS_PARAMS,
    output: textOut('关注或收藏清单'),
    isConcurrencySafe: () => true,
    timeoutMs: 120_000,
    execute: wrap(executeLists),
  },
  {
    name: 'bili_logout',
    description: '清除本机保存的 B站登录凭据。',
    parameters: EMPTY_PARAMS,
    output: textOut('退出结果'),
    isConcurrencySafe: () => false,
    timeoutMs: 10_000,
    execute: wrap(async () => executeLogout()),
  },
]

export function apply(ctx) {
  for (const definition of TOOLS) {
    try {
      ctx.effect(() => ctx.tools.register(definition), `dsh-bili: ${definition.name}`)
    } catch (error) {
      if (error instanceof Error && /already registered/i.test(error.message)) {
        console.warn(`[bili] 工具 ${definition.name} 已注册，跳过`)
      } else {
        console.error(`[bili] 注册工具 ${definition.name} 失败：${error?.message || error}`)
      }
    }
  }
}
