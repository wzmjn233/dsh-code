/**
 * dsh-github-push —— 配置读写（token / 仓库设置 / 最近推送记录）。
 *
 * 配置文件放在 <DSH_HOME>/storages/dsh-github-push/config.json：
 *   - token 是唯一敏感的字段，写入时 chmod 600，任何对外接口都不会回显它；
 *   - 其余字段（owner/repo/branch 等）设置页可改，模型侧 github_config 工具也能改。
 *
 * 本文件刻意只 import node: 内置模块：插件用 link: 方式安装时，Node 按真实路径
 * 解析本文件，沿目录向上找不到 profile 的 node_modules，裸包名会解析失败。
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** DSH 家目录。 */
export function dshHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh')
}

/** 本插件的状态目录：<DSH_HOME>/storages/dsh-github-push。 */
export function stateDir() {
  return join(dshHome(), 'storages', 'dsh-github-push')
}

/** 配置文件路径。 */
export function configPath() {
  return join(stateDir(), 'config.json')
}

/**
 * 目录遍历时默认跳过的名字/模式。
 * 前一组是依赖/缓存目录，后一组是容易泄露密钥的环境变量文件（单个文件显式指定
 * 上传时不受排除规则影响，所以 .env 仍然可以按需上传）。
 */
export const DEFAULT_EXCLUDES = [
  '.git',
  'node_modules',
  '.DS_Store',
  'Thumbs.db',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.pytest_cache',
  '.mypy_cache',
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
]

/** 默认配置（也是配置文件的形状）。 */
export const DEFAULT_CONFIG = {
  token: '',
  owner: '',
  repo: '',
  branch: '',
  privateRepo: true,
  autoCreateRepo: true,
  apiBase: 'https://api.github.com',
  exclude: [...DEFAULT_EXCLUDES],
  maxFiles: 500,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 25 * 1024 * 1024,
  lastPushes: [],
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function asBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function asPositiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

/** 读配置。坏文件/坏字段一律回默认值——配置坏了不能让插件整个失效。 */
export function loadConfig() {
  let raw = null
  try {
    raw = JSON.parse(readFileSync(configPath(), 'utf8'))
  } catch {
    raw = null
  }
  const config = {
    ...DEFAULT_CONFIG,
    exclude: [...DEFAULT_EXCLUDES],
    lastPushes: [],
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return config

  config.token = asString(raw.token).trim()
  config.owner = asString(raw.owner).trim()
  config.repo = asString(raw.repo).trim()
  config.branch = asString(raw.branch).trim()
  config.privateRepo = asBool(raw.privateRepo, DEFAULT_CONFIG.privateRepo)
  config.autoCreateRepo = asBool(raw.autoCreateRepo, DEFAULT_CONFIG.autoCreateRepo)
  const apiBase = asString(raw.apiBase, DEFAULT_CONFIG.apiBase).trim()
  config.apiBase = apiBase === '' ? DEFAULT_CONFIG.apiBase : apiBase.replace(/\/+$/, '')
  config.exclude = Array.isArray(raw.exclude)
    ? raw.exclude.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
    : [...DEFAULT_EXCLUDES]
  config.maxFiles = asPositiveInt(raw.maxFiles, DEFAULT_CONFIG.maxFiles)
  config.maxFileBytes = asPositiveInt(raw.maxFileBytes, DEFAULT_CONFIG.maxFileBytes)
  config.maxTotalBytes = asPositiveInt(raw.maxTotalBytes, DEFAULT_CONFIG.maxTotalBytes)
  config.lastPushes = Array.isArray(raw.lastPushes)
    ? raw.lastPushes.filter((item) => item !== null && typeof item === 'object').slice(0, 20)
    : []
  return config
}

/**
 * 保存配置（增量合并）。
 *
 * - patch.token 为字符串时覆盖（空字符串 = 清除），为 undefined 时保持原值；
 * - 采用「临时文件 + rename」原子发布，写失败不会留下半截配置；
 * - 权限收紧到 600（token 在文件里）。
 */
export function saveConfig(patch = {}) {
  const current = loadConfig()
  const next = { ...current }
  if (typeof patch.token === 'string') next.token = patch.token.trim()
  if (typeof patch.owner === 'string') next.owner = patch.owner.trim()
  if (typeof patch.repo === 'string') next.repo = patch.repo.trim()
  if (typeof patch.branch === 'string') next.branch = patch.branch.trim()
  if (typeof patch.privateRepo === 'boolean') next.privateRepo = patch.privateRepo
  if (typeof patch.autoCreateRepo === 'boolean') next.autoCreateRepo = patch.autoCreateRepo
  if (typeof patch.apiBase === 'string' && patch.apiBase.trim() !== '') {
    next.apiBase = patch.apiBase.trim().replace(/\/+$/, '')
  }
  if (Array.isArray(patch.exclude)) {
    next.exclude = patch.exclude.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
  }
  if (Array.isArray(patch.lastPushes)) next.lastPushes = patch.lastPushes.slice(0, 20)

  mkdirSync(stateDir(), { recursive: true })
  const file = configPath()
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, file)
  try {
    chmodSync(file, 0o600)
  } catch {
    // 权限收紧失败不影响功能，忽略
  }
  return loadConfig()
}

/** 记录一次成功推送（最多保留 20 条）。 */
export function recordPush(entry) {
  const config = loadConfig()
  const list = Array.isArray(config.lastPushes) ? config.lastPushes : []
  list.unshift(entry)
  try {
    saveConfig({ lastPushes: list.slice(0, 20) })
  } catch {
    // 记录失败绝不影响推送本身
  }
}

/**
 * token 解析：配置文件优先，其次环境变量 GITHUB_TOKEN / GH_TOKEN。
 * @returns {{ token: string, configured: boolean, source: 'config'|'env'|'none', hint: string }}
 */
export function tokenInfo(config) {
  const configToken = typeof config.token === 'string' ? config.token.trim() : ''
  let envName = ''
  let envToken = ''
  if (configToken === '') {
    for (const name of ['GITHUB_TOKEN', 'GH_TOKEN']) {
      const value = typeof process.env[name] === 'string' ? process.env[name].trim() : ''
      if (value !== '') {
        envName = name
        envToken = value
        break
      }
    }
  }
  const token = configToken !== '' ? configToken : envToken
  return {
    token,
    configured: token !== '',
    source: configToken !== '' ? 'config' : envToken !== '' ? 'env' : 'none',
    hint: maskToken(token),
  }
}

/** 脱敏：只露前 4 位与后 4 位，长度不足时只露末位。 */
export function maskToken(token) {
  const value = typeof token === 'string' ? token : ''
  if (value === '') return ''
  if (value.length <= 10) return `${'•'.repeat(Math.max(0, value.length - 2))}${value.slice(-2)}`
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}

/** 对外可见的配置视图（永远不含 token 明文）。 */
export function publicConfig(config) {
  return {
    owner: config.owner,
    repo: config.repo,
    branch: config.branch,
    privateRepo: config.privateRepo,
    autoCreateRepo: config.autoCreateRepo,
    apiBase: config.apiBase,
    exclude: config.exclude,
    maxFiles: config.maxFiles,
    maxFileBytes: config.maxFileBytes,
    maxTotalBytes: config.maxTotalBytes,
    lastPushes: config.lastPushes,
    configPath: configPath(),
  }
}
