/**
 * dsh-github-push —— 宿主半侧。
 *
 * 三件事：
 *   1. 注册模型侧工具：github_push（上传代码）、github_status（自检）、github_config（改仓库设置）；
 *   2. 注册同源 HTTP API（/api/github-push/*），设置页用它读写配置、测试连接；
 *   3. 配置只存在本机 storages 目录，token 不回显、不进日志。
 *
 * 工具定义是手写的 JSON Schema（没有 import defineTool）：插件以 link: 方式安装，
 * 裸包名解析不到 profile 的 node_modules，所以只依赖 node: 内置模块和同目录文件。
 */

import { resolve as nodeResolve } from 'node:path'

import { configPath, loadConfig, publicConfig, recordPush, saveConfig, tokenInfo } from './config.js'
import { collectFiles, formatBytes, joinRepoPath, normalizeBranch, normalizeRepoDir } from './files.js'
import { createClient, inspectConnection, pushFiles, validateOwner, validateOwnerRepo, validateRepo } from './github.js'

export const name = 'github-push'

/** 需要的服务：工具注册 + 同源 HTTP 路由。 */
export const inject = ['tools', 'webServer']

const API_PREFIX = '/api/github-push'
const BUILD = '0.1.0'

// ---------------------------------------------------------------------------
// 工具 schema
// ---------------------------------------------------------------------------

const PUSH_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    source: {
      type: 'string',
      description: '本地文件或目录路径。相对路径按当前会话工作目录解析。',
    },
    targetDir: {
      type: 'string',
      description: '仓库内的目标目录，默认仓库根目录。',
    },
    message: {
      type: 'string',
      description: '提交说明（commit message）；省略时自动生成。',
    },
    branch: {
      type: 'string',
      description: '目标分支；省略时用插件设置里的分支，否则用仓库默认分支。',
    },
    createRepo: {
      type: 'boolean',
      description: '仓库不存在时是否自动创建；省略时用插件设置（默认开启）。',
    },
  },
  required: ['source'],
}

const PUSH_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    repo: { type: 'string', description: 'owner/repo' },
    branch: { type: 'string' },
    unchanged: { type: 'boolean', description: 'true 表示远端内容与本地一致，没有产生新提交' },
    commit: { type: 'string', description: '提交 sha；无新提交时为空串' },
    commitUrl: { type: 'string' },
    repoUrl: { type: 'string' },
    files: { type: 'number' },
    bytes: { type: 'number' },
    createdRepo: { type: 'boolean' },
    message: { type: 'string', description: '本次提交说明' },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'repo',
    'branch',
    'unchanged',
    'commit',
    'commitUrl',
    'repoUrl',
    'files',
    'bytes',
    'createdRepo',
    'message',
    'notes',
  ],
}

const STATUS_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {},
}

const STATUS_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    configured: { type: 'boolean' },
    tokenConfigured: { type: 'boolean' },
    tokenSource: { type: 'string' },
    tokenHint: { type: 'string' },
    owner: { type: 'string' },
    repo: { type: 'string' },
    branch: { type: 'string' },
    repoExists: { type: 'boolean' },
    defaultBranch: { type: 'string' },
    private: { type: 'boolean' },
    canPush: { type: 'boolean' },
    repoUrl: { type: 'string' },
    login: { type: 'string' },
    lastPushes: { type: 'array', items: { type: 'string' } },
    configPath: { type: 'string' },
    error: { type: 'string' },
  },
  required: [
    'configured',
    'tokenConfigured',
    'tokenSource',
    'tokenHint',
    'owner',
    'repo',
    'branch',
    'repoExists',
    'defaultBranch',
    'private',
    'canPush',
    'repoUrl',
    'login',
    'lastPushes',
    'configPath',
    'error',
  ],
}

const CONFIG_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    owner: { type: 'string', description: 'GitHub 用户名或组织名。' },
    repo: { type: 'string', description: '仓库名（不含 owner）。' },
    branch: { type: 'string', description: '默认分支；传空字符串表示跟随仓库默认分支。' },
    privateRepo: { type: 'boolean', description: '自动新建仓库时是否设为私有。' },
    autoCreateRepo: { type: 'boolean', description: '仓库不存在时是否自动创建。' },
  },
}

const CONFIG_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    owner: { type: 'string' },
    repo: { type: 'string' },
    branch: { type: 'string' },
    privateRepo: { type: 'boolean' },
    autoCreateRepo: { type: 'boolean' },
    tokenConfigured: { type: 'boolean' },
    configPath: { type: 'string' },
    note: { type: 'string' },
  },
  required: ['owner', 'repo', 'branch', 'privateRepo', 'autoCreateRepo', 'tokenConfigured', 'configPath', 'note'],
}

// ---------------------------------------------------------------------------
// 渲染（模型看到的工具结果文本）
// ---------------------------------------------------------------------------

function renderPush(value) {
  const lines = []
  if (value.createdRepo) lines.push(`已在 GitHub 创建仓库 ${value.repo}`)
  if (value.unchanged) {
    lines.push(`内容与远端一致，没有产生新提交：${value.repo}@${value.branch}`)
  } else {
    lines.push(`已推送 ${value.files} 个文件（${formatBytes(value.bytes)}）到 ${value.repo}@${value.branch}`)
    if (value.commit !== '') {
      lines.push(`提交：${value.commit.slice(0, 7)}${value.commitUrl === '' ? '' : `\n${value.commitUrl}`}`)
    }
    if (value.message !== '') lines.push(`说明：${value.message}`)
  }
  lines.push(`仓库：${value.repoUrl}`)
  if (Array.isArray(value.notes)) {
    for (const note of value.notes) lines.push(`- ${note}`)
  }
  return lines.join('\n')
}

function renderStatus(value) {
  const lines = []
  lines.push(value.configured ? 'GitHub 已配置' : 'GitHub 尚未配置')
  if (value.tokenConfigured) {
    const source = value.tokenSource === 'env' ? '环境变量' : '配置文件'
    lines.push(`token：已配置（${source}，${value.tokenHint}）`)
  } else {
    lines.push('token：未配置')
  }
  if (value.owner !== '' && value.repo !== '') {
    const branch = value.branch === '' ? `默认分支 ${value.defaultBranch || '(未知)'}` : value.branch
    if (value.repoExists) {
      lines.push(
        `仓库：${value.owner}/${value.repo}（${value.private ? '私有' : '公开'}，${branch}${value.canPush ? '，可写' : '，可能没有写权限'}）`,
      )
      if (value.repoUrl !== '') lines.push(`地址：${value.repoUrl}`)
    } else if (value.error === '') {
      lines.push(`仓库：${value.owner}/${value.repo}（远端暂不可见）`)
    }
  } else {
    lines.push('仓库：未设置')
  }
  if (value.login !== '') lines.push(`账号：${value.login}`)
  if (value.error !== '') lines.push(`问题：${value.error}`)
  if (value.lastPushes.length > 0) {
    lines.push('最近推送：')
    for (const item of value.lastPushes) lines.push(`- ${item}`)
  }
  lines.push(`配置：${value.configPath}`)
  return lines.join('\n')
}

function renderConfig(value) {
  const branch = value.branch === '' ? '跟随仓库默认分支' : value.branch
  return [
    `GitHub 配置已更新：${value.note}`,
    `仓库：${value.owner === '' || value.repo === '' ? '未设置' : `${value.owner}/${value.repo}`}`,
    `分支：${branch}`,
    `自动创建仓库：${value.autoCreateRepo ? '开' : '关'}（新建时${value.privateRepo ? '私有' : '公开'}）`,
    `token：${value.tokenConfigured ? '已配置' : '未配置（请到「设置 → GitHub」粘贴）'}`,
    `配置：${value.configPath}`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// 工具执行
// ---------------------------------------------------------------------------

/** 会话当前目录（拿不到就退回进程 cwd）。 */
async function sessionDirectory(ctx, exec) {
  try {
    const service = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
    if (service !== undefined && service !== null && typeof service.ensure === 'function' && exec.agent !== undefined) {
      const dir = await service.ensure(exec.agent, exec.signal)
      if (typeof dir === 'string' && dir !== '') return dir
    }
  } catch {
    // 工作目录服务不可用时退回进程 cwd
  }
  return process.cwd()
}

function defaultMessage(fileCount, targetDir) {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
  const where = targetDir === '' ? '仓库根目录' : targetDir
  return `chore: 从 DSH 上传 ${fileCount} 个文件到 ${where}（${stamp}）`
}

function requireRepositorySettings(config) {
  if (config.owner === '' || config.repo === '') {
    throw new Error(
      'GitHub 仓库还没有配置：请打开「设置 → GitHub」填写 owner 和 repo（例如 owner=octocat、repo=hello-world），然后再让我上传。',
    )
  }
  validateOwnerRepo(config.owner, config.repo)
}

async function executePush(ctx, args, exec) {
  const config = loadConfig()
  const token = tokenInfo(config)
  if (!token.configured) {
    throw new Error('GitHub 还没有配置 token：请打开「设置 → GitHub」粘贴一个 token（需要 repo 权限），然后再让我上传。')
  }
  requireRepositorySettings(config)

  const sourceArg = typeof args.source === 'string' ? args.source.trim() : ''
  if (sourceArg === '') throw new Error('source 不能为空：请给出要上传的文件或目录路径。')

  const baseDir = await sessionDirectory(ctx, exec)
  const sourcePath = resolveSource(baseDir, sourceArg)
  const collected = collectFiles(sourcePath, {
    exclude: config.exclude,
    maxFiles: config.maxFiles,
    maxFileBytes: config.maxFileBytes,
    maxTotalBytes: config.maxTotalBytes,
  })
  if (collected.files.length === 0) {
    throw new Error(`没有找到可上传的文件：${sourcePath}（目录可能是空的，或全部被排除规则跳过）。`)
  }

  const targetDir = normalizeRepoDir(args.targetDir)
  const wantBranch = typeof args.branch === 'string' && args.branch.trim() !== '' ? args.branch : config.branch
  const branch = normalizeBranch(wantBranch)
  const message =
    typeof args.message === 'string' && args.message.trim() !== ''
      ? args.message.trim().slice(0, 2000)
      : defaultMessage(collected.files.length, targetDir)

  const files = collected.files.map((file) => ({
    abs: file.abs,
    repoPath: joinRepoPath(targetDir, file.rel),
    size: file.size,
  }))

  const client = createClient({ token: token.token, apiBase: config.apiBase })
  const result = await pushFiles(client, {
    owner: config.owner,
    repo: config.repo,
    branch,
    files,
    message,
    createRepo: typeof args.createRepo === 'boolean' ? args.createRepo : config.autoCreateRepo,
    privateRepo: config.privateRepo,
    signal: exec.signal,
  })

  const notes = [...result.notes]
  if (collected.skipped.length > 0) {
    const sample = collected.skipped
      .slice(0, 8)
      .map((item) => `${item.path}（${item.reason}）`)
      .join('、')
    notes.push(`跳过 ${collected.skipped.length} 个文件/目录：${sample}${collected.skipped.length > 8 ? ' 等' : ''}`)
  }
  if (collected.truncated) notes.push('文件数/总大小达到上限，其余文件未上传。')

  recordPush({
    at: new Date().toISOString(),
    repo: result.repo,
    branch: result.branch,
    commit: result.commit,
    url: result.commitUrl,
    files: result.files,
    bytes: result.bytes,
    message,
    unchanged: result.unchanged,
  })

  return { ...result, message, notes }
}

async function executeStatus(ctx, exec) {
  const config = loadConfig()
  const info = tokenInfo(config)
  const value = {
    configured: info.configured && config.owner !== '' && config.repo !== '',
    tokenConfigured: info.configured,
    tokenSource: info.source,
    tokenHint: info.hint,
    owner: config.owner,
    repo: config.repo,
    branch: config.branch,
    repoExists: false,
    defaultBranch: '',
    private: false,
    canPush: false,
    repoUrl: '',
    login: '',
    lastPushes: config.lastPushes.slice(0, 5).map((entry) => {
      const at = typeof entry.at === 'string' ? entry.at.replace('T', ' ').slice(0, 16) : '?'
      const commit = typeof entry.commit === 'string' && entry.commit !== '' ? entry.commit.slice(0, 7) : '无新提交'
      return `${at} · ${String(entry.repo ?? '')}@${String(entry.branch ?? '')} · ${commit} · ${Number(entry.files) || 0} 个文件`
    }),
    configPath: configPath(),
    error: '',
  }

  if (!info.configured) {
    value.error = '还没有配置 token：请打开「设置 → GitHub」粘贴 token。'
    return value
  }
  if (config.owner === '' || config.repo === '') {
    value.error = '还没有配置仓库：请打开「设置 → GitHub」填写 owner 和 repo。'
    return value
  }
  try {
    const client = createClient({ token: info.token, apiBase: config.apiBase })
    const connection = await inspectConnection(client, {
      owner: config.owner,
      repo: config.repo,
      signal: exec.signal,
    })
    value.login = connection.login
    if (connection.repo !== null && typeof connection.repo === 'object') {
      value.repoExists = true
      value.defaultBranch = typeof connection.repo.default_branch === 'string' ? connection.repo.default_branch : ''
      value.private = connection.repo.private === true
      value.repoUrl = typeof connection.repo.html_url === 'string' ? connection.repo.html_url : ''
      value.canPush = connection.repo.permissions !== undefined && connection.repo.permissions !== null && connection.repo.permissions.push === true
    } else {
      value.error = `仓库 ${config.owner}/${config.repo} 不存在或当前 token 无权访问。`
    }
  } catch (error) {
    value.error = error instanceof Error ? error.message : String(error)
  }
  return value
}

async function executeConfig(args) {
  const patch = {}
  const touched = []
  for (const key of ['owner', 'repo', 'branch']) {
    if (typeof args[key] === 'string') {
      patch[key] = args[key].trim()
      touched.push(key)
    }
  }
  if (typeof args.privateRepo === 'boolean') {
    patch.privateRepo = args.privateRepo
    touched.push('privateRepo')
  }
  if (typeof args.autoCreateRepo === 'boolean') {
    patch.autoCreateRepo = args.autoCreateRepo
    touched.push('autoCreateRepo')
  }
  if (touched.length === 0) {
    throw new Error('没有要修改的配置项：至少传 owner、repo、branch、privateRepo、autoCreateRepo 之一。')
  }
  if (typeof patch.owner === 'string' && patch.owner !== '') validateOwner(patch.owner)
  if (typeof patch.repo === 'string' && patch.repo !== '') validateRepo(patch.repo)
  if (typeof patch.branch === 'string' && patch.branch !== '') normalizeBranch(patch.branch)

  const saved = saveConfig(patch)
  const info = tokenInfo(saved)
  return {
    owner: saved.owner,
    repo: saved.repo,
    branch: saved.branch,
    privateRepo: saved.privateRepo,
    autoCreateRepo: saved.autoCreateRepo,
    tokenConfigured: info.configured,
    configPath: configPath(),
    note: `${touched.join('、')} 已更新${info.configured ? '' : '；token 还没配置，请到「设置 → GitHub」粘贴'}`,
  }
}

/** 相对路径按会话目录解析。 */
function resolveSource(baseDir, target) {
  return nodeResolve(baseDir, target)
}

// ---------------------------------------------------------------------------
// 工具注册
// ---------------------------------------------------------------------------

function registerTool(ctx, definition) {
  try {
    ctx.effect(() => ctx.tools.register(definition), `dsh-github-push: ${definition.name}`)
    return true
  } catch (error) {
    if (error instanceof Error && error.message.includes('already registered')) {
      console.warn(`[github-push] 工具 ${definition.name} 已注册，跳过重复注册`)
      return false
    }
    throw error
  }
}

function registerTools(ctx) {
  registerTool(ctx, {
    name: 'github_push',
    description:
      '把本地代码（单个文件或整个目录）上传到用户的 GitHub 仓库：通过 GitHub API 创建一个提交并更新分支，不需要本地 git 仓库，也不需要先 clone。仓库不存在时可以按设置自动创建。相对路径按当前会话工作目录解析。返回提交链接、文件数、是否有实际变更。用户说「把代码传到 GitHub / 上传代码 / 备份到仓库」时用它。',
    parameters: PUSH_PARAMETERS,
    output: {
      schema: PUSH_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: renderPush(value) }],
    },
    timeoutMs: 180_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return executePush(ctx, args, exec)
    },
  })

  registerTool(ctx, {
    name: 'github_status',
    description:
      '检查 GitHub 上传配置与连通性：token 是否已配置、目标仓库是否存在、当前账号是谁、默认分支、最近一次推送。用户问「GitHub 配好了吗 / 能不能上传」时用它。',
    parameters: STATUS_PARAMETERS,
    output: {
      schema: STATUS_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: renderStatus(value) }],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      return executeStatus(ctx, exec)
    },
  })

  registerTool(ctx, {
    name: 'github_config',
    description:
      '修改 GitHub 上传的仓库设置（owner、repo、branch、是否自动创建仓库、新建仓库是否私有）。token 不能通过这个工具改——它只能在本机「设置 → GitHub」里填写。',
    parameters: CONFIG_PARAMETERS,
    output: {
      schema: CONFIG_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: renderConfig(value) }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(args) {
      return executeConfig(args)
    },
  })
}

// ---------------------------------------------------------------------------
// 同源配置 API（设置页用）
// ---------------------------------------------------------------------------

function sendJson(res, status, data) {
  const body = JSON.stringify(data)
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    res.end(body)
  } catch {
    // 客户端已断开，忽略
  }
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        fail(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      const text = chunks.length === 0 ? '' : Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return resolvePromise({})
      try {
        resolvePromise(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', (error) => fail(error))
  })
}

function buildState() {
  const config = loadConfig()
  const info = tokenInfo(config)
  return {
    config: publicConfig(config),
    token: { configured: info.configured, source: info.source, hint: info.hint },
    build: BUILD,
  }
}

async function handleApi(req, res) {
  const rawUrl = typeof req.url === 'string' ? req.url : '/'
  const pathname = rawUrl.split('?')[0]
  const route = pathname.slice(API_PREFIX.length) === '' ? '/' : pathname.slice(API_PREFIX.length)
  try {
    if (route === '/state' && req.method === 'GET') {
      return sendJson(res, 200, buildState())
    }

    if (route === '/save' && req.method === 'POST') {
      const body = await readBody(req)
      const patch = {}
      if (typeof body.token === 'string' && body.token.trim() !== '') patch.token = body.token.trim()
      if (typeof body.owner === 'string') patch.owner = body.owner.trim()
      if (typeof body.repo === 'string') patch.repo = body.repo.trim()
      if (typeof body.branch === 'string') patch.branch = body.branch.trim()
      if (typeof body.privateRepo === 'boolean') patch.privateRepo = body.privateRepo
      if (typeof body.autoCreateRepo === 'boolean') patch.autoCreateRepo = body.autoCreateRepo
      if (body.clearToken === true) patch.token = ''
      if (patch.owner !== undefined && patch.owner !== '') validateOwner(patch.owner)
      if (patch.repo !== undefined && patch.repo !== '') validateRepo(patch.repo)
      if (patch.branch !== undefined && patch.branch !== '') normalizeBranch(patch.branch)
      saveConfig(patch)
      return sendJson(res, 200, buildState())
    }

    if (route === '/test' && req.method === 'POST') {
      const config = loadConfig()
      const info = tokenInfo(config)
      if (!info.configured) {
        return sendJson(res, 400, { ok: false, error: '还没有配置 token：请先粘贴 token 再测试。' })
      }
      const client = createClient({ token: info.token, apiBase: config.apiBase })
      if (config.owner === '' || config.repo === '') {
        const user = await client.getUser()
        return sendJson(res, 200, {
          ok: true,
          login: typeof user.login === 'string' ? user.login : '',
          repo: null,
          message: 'token 有效；还没填写 owner/repo，所以只验证了账号。',
        })
      }
      validateOwnerRepo(config.owner, config.repo)
      const connection = await inspectConnection(client, { owner: config.owner, repo: config.repo })
      const repo = connection.repo
      return sendJson(res, 200, {
        ok: true,
        login: connection.login,
        repo:
          repo === null
            ? null
            : {
                fullName: typeof repo.full_name === 'string' ? repo.full_name : `${config.owner}/${config.repo}`,
                defaultBranch: typeof repo.default_branch === 'string' ? repo.default_branch : '',
                private: repo.private === true,
                canPush: repo.permissions !== undefined && repo.permissions !== null && repo.permissions.push === true,
                htmlUrl: typeof repo.html_url === 'string' ? repo.html_url : '',
              },
        message:
          repo === null
            ? 'token 有效；仓库不存在或当前 token 无权访问（推送时会按设置尝试创建）。'
            : '连接正常。',
      })
    }

    return sendJson(res, 404, { ok: false, error: `未知接口：${route}` })
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

function registerApi(ctx) {
  try {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'prefix',
          path: API_PREFIX,
          handler: handleApi,
        }),
      'dsh-github-push: api',
    )
  } catch (error) {
    if (error instanceof Error && error.message.includes('duplicate')) {
      console.warn('[github-push] 同源 API 路由已注册，跳过重复注册')
      return
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

/**
 * @param {object} ctx cordis 插件上下文
 */
export function apply(ctx) {
  registerTools(ctx)
  registerApi(ctx)
}
