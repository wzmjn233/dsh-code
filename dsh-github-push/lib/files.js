/**
 * dsh-github-push —— 本地文件收集。
 *
 * 把「一个文件 / 一个目录」展开成待上传清单：
 *   - 只收普通文件（符号链接、设备文件跳过并记录原因）；
 *   - 目录遍历按默认/自定义排除规则跳过依赖、缓存、.env 之类；
 *   - 有文件数、单文件大小、总大小三道闸，超出部分记进 skipped，不静默丢；
 *   - 相对路径转成仓库内的 POSIX 路径（targetDir 只允许仓库内相对路径）。
 */

import { readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'

/** 平台分隔符 → POSIX 斜杠。 */
export function toPosix(path) {
  return String(path).split(sep).join('/')
}

/** 把 glob 模式编译成正则：`**` 跨目录，`*` 不跨，`?` 单字符。 */
function globToRegExp(pattern) {
  let out = '^'
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*'
        i += 1
      } else {
        out += '[^/]*'
      }
    } else if (char === '?') {
      out += '[^/]'
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`${out}$`)
}

/**
 * 排除规则匹配器。规则语法：
 *   - `node_modules` / `*.log` / `.env.*`：按文件名（或任一目录段）匹配；
 *   - `src/cache/**`：按仓库内相对路径匹配。
 * @param {string[]} patterns 排除规则
 * @returns {(relPath: string, baseName: string) => boolean}
 */
export function createExcludeMatcher(patterns) {
  const entries = (Array.isArray(patterns) ? patterns : [])
    .map((raw) => {
      const normalized = String(raw)
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\.\/+/, '')
        .replace(/\/+$/, '')
      if (normalized === '') return null
      return { normalized, regex: globToRegExp(normalized), pathScoped: normalized.includes('/') }
    })
    .filter((entry) => entry !== null)

  return function matched(relPath, baseName) {
    for (const entry of entries) {
      if (entry.pathScoped) {
        if (entry.regex.test(relPath)) return true
      } else if (entry.regex.test(baseName) || relPath.split('/').some((segment) => entry.regex.test(segment))) {
        return true
      }
    }
    return false
  }
}

/**
 * 校验并规范化仓库内目标目录。
 * 空串表示仓库根；只接受相对路径，拒绝 `..` 与绝对路径。
 */
export function normalizeRepoDir(dir) {
  const raw = typeof dir === 'string' ? dir.trim().replace(/\\/g, '/') : ''
  if (raw === '' || raw === '.') return ''
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    throw new Error(`targetDir 必须是仓库内的相对路径：${dir}`)
  }
  const parts = raw.split('/').filter((part) => part !== '' && part !== '.')
  if (parts.some((part) => part === '..')) {
    throw new Error(`targetDir 不能包含 ".."：${dir}`)
  }
  return parts.join('/')
}

/** 仓库内路径拼接。 */
export function joinRepoPath(targetDir, relPath) {
  const rel = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '')
  return targetDir === '' ? rel : `${targetDir}/${rel}`
}

/**
 * 校验分支名（GitHub 引用名的一个安全子集）。
 * 允许字母、数字、`. _ - /`；拒绝首尾斜杠、连续斜杠和 `..`。
 */
export function normalizeBranch(branch) {
  const value = typeof branch === 'string' ? branch.trim() : ''
  if (value === '') return ''
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) {
    throw new Error(`分支名包含不支持的字符（仅支持字母、数字、. _ - /）：${value}`)
  }
  if (value.startsWith('/') || value.endsWith('/') || value.includes('//') || value.includes('..')) {
    throw new Error(`分支名不合法：${value}`)
  }
  return value
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/**
 * 收集待上传文件。
 *
 * @param {string} source 本地文件或目录（绝对路径）
 * @param {object} [options]
 * @param {string[]} [options.exclude] 排除规则；只对目录遍历生效
 * @param {number} [options.maxFiles] 文件数上限
 * @param {number} [options.maxFileBytes] 单文件大小上限
 * @param {number} [options.maxTotalBytes] 总大小上限
 * @returns {{ kind:'file'|'dir', root:string, files:Array<{abs:string,rel:string,size:number}>, skipped:Array<{path:string,reason:string}>, totalBytes:number, truncated:boolean }}
 */
export function collectFiles(source, options = {}) {
  const root = resolve(String(source))
  let info
  try {
    info = statSync(root)
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error(`路径不存在：${root}`)
    }
    throw new Error(`无法读取路径 ${root}：${error instanceof Error ? error.message : String(error)}`)
  }

  const maxFiles = Number.isInteger(options.maxFiles) && options.maxFiles > 0 ? options.maxFiles : 500
  const maxFileBytes = Number.isInteger(options.maxFileBytes) && options.maxFileBytes > 0 ? options.maxFileBytes : 10 * 1024 * 1024
  const maxTotalBytes = Number.isInteger(options.maxTotalBytes) && options.maxTotalBytes > 0 ? options.maxTotalBytes : 25 * 1024 * 1024

  if (info.isFile()) {
    if (info.size > maxFileBytes) {
      throw new Error(`文件太大（${formatBytes(info.size)}），超过单文件上限 ${formatBytes(maxFileBytes)}：${root}`)
    }
    return {
      kind: 'file',
      root: dirname(root),
      files: [{ abs: root, rel: basename(root), size: info.size }],
      skipped: [],
      totalBytes: info.size,
      truncated: false,
    }
  }
  if (!info.isDirectory()) {
    throw new Error(`不是普通文件或目录：${root}`)
  }

  const matched = createExcludeMatcher(options.exclude)
  const files = []
  const skipped = []
  let totalBytes = 0
  let truncated = false

  const walk = (dir, relDir, depth) => {
    if (truncated) return
    if (depth > 32) {
      skipped.push({ path: relDir === '' ? '.' : relDir, reason: '目录层级过深' })
      return
    }
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      skipped.push({
        path: relDir === '' ? '.' : relDir,
        reason: `无法读取目录：${error instanceof Error ? error.message : String(error)}`,
      })
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (truncated) return
      if (files.length >= maxFiles) {
        truncated = true
        skipped.push({ path: relDir === '' ? entry.name : `${relDir}/${entry.name}`, reason: `超过文件数上限 ${maxFiles}` })
        return
      }
      const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`
      if (entry.isDirectory()) {
        if (entry.name === '.git' || matched(relPath, entry.name)) continue
        walk(join(dir, entry.name), relPath, depth + 1)
        continue
      }
      if (!entry.isFile()) {
        skipped.push({ path: relPath, reason: '不是普通文件（符号链接或特殊文件）' })
        continue
      }
      if (matched(relPath, entry.name)) continue
      let size
      try {
        size = statSync(join(dir, entry.name)).size
      } catch {
        skipped.push({ path: relPath, reason: '读取文件大小失败' })
        continue
      }
      if (size > maxFileBytes) {
        skipped.push({ path: relPath, reason: `文件过大（${formatBytes(size)}）` })
        continue
      }
      if (totalBytes + size > maxTotalBytes) {
        skipped.push({ path: relPath, reason: `超过总大小上限 ${formatBytes(maxTotalBytes)}` })
        truncated = true
        return
      }
      files.push({ abs: join(dir, entry.name), rel: relPath, size })
      totalBytes += size
    }
  }

  walk(root, '', 0)
  return { kind: 'dir', root, files, skipped, totalBytes, truncated }
}

export { formatBytes }
