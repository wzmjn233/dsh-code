/**
 * dsh-bili —— 会话与待登录状态的本地存储
 *
 * 安全约定（整个插件一致）：
 *   · cookie 只落盘到 $DSH_HOME/bili/session.json，权限 0600
 *   · 任何返回给模型/界面的结构都不含 cookie 原值
 *   · 报错信息统一脱敏
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DIR = path.join(DSH_HOME, 'bili')
const SESSION_PATH = path.join(DIR, 'session.json')
const PENDING_PATH = path.join(DIR, 'login-pending.json')
const CACHE_PATH = path.join(DIR, 'cache.json')

export const paths = { dir: DIR, session: SESSION_PATH, pending: PENDING_PATH, cache: CACHE_PATH }

function ensureDir() {
  try { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }) } catch { /* ignore */ }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function writeJson(file, value) {
  ensureDir()
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), { mode: 0o600 })
  try { fs.chmodSync(tmp, 0o600) } catch { /* ignore */ }
  fs.renameSync(tmp, file)
}

export function loadSession() {
  const s = readJson(SESSION_PATH)
  if (!s || !s.cookies || typeof s.cookies.SESSDATA !== 'string' || !s.cookies.SESSDATA) return null
  return s
}

export function saveSession(cookies, profile) {
  const clean = {}
  for (const [k, v] of Object.entries(cookies || {})) {
    if (typeof v === 'string' && v !== '') clean[k] = v
  }
  const session = {
    savedAt: Date.now(),
    cookies: clean,
    profile: profile || {},
  }
  writeJson(SESSION_PATH, session)
  return session
}

export function clearSession() {
  try { fs.rmSync(SESSION_PATH, { force: true }) } catch { /* ignore */ }
}

/** 拼 Cookie 请求头。只在发请求时用，绝不外泄。 */
export function cookieHeader(session) {
  return Object.entries(session.cookies || {})
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
}

/** 可安全返回给模型的状态描述（不含任何凭据值）。 */
export function describeSession(session) {
  if (!session) return { loggedIn: false }
  const savedAt = session.savedAt || 0
  return {
    loggedIn: true,
    mid: session.profile?.mid || session.cookies?.DedeUserID || null,
    uname: session.profile?.uname || null,
    avatar: session.profile?.avatar || null,
    savedAt,
    savedAtText: savedAt ? new Date(savedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : null,
    ageHours: savedAt ? Math.round((Date.now() - savedAt) / 3600000) : null,
    cookieNames: Object.keys(session.cookies || {}),
  }
}

export function loadPending() { return readJson(PENDING_PATH) }

export function savePending(pending) { writeJson(PENDING_PATH, pending) }

export function clearPending() {
  try { fs.rmSync(PENDING_PATH, { force: true }) } catch { /* ignore */ }
}

export function loadCache() { return readJson(CACHE_PATH) }

export function saveCache(value) {
  try { writeJson(CACHE_PATH, value) } catch { /* ignore */ }
}

/** 把可能出现的凭据从任意文本里抹掉。 */
export function scrub(text, session) {
  let out = String(text == null ? '' : text)
  const values = []
  if (session?.cookies) values.push(...Object.values(session.cookies))
  try {
    const p = loadSession()
    if (p?.cookies) values.push(...Object.values(p.cookies))
  } catch { /* ignore */ }
  for (const v of values) {
    if (typeof v === 'string' && v.length > 8) out = out.split(v).join('***')
  }
  return out
}
