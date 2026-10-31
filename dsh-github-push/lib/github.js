/**
 * dsh-github-push —— GitHub REST API 客户端 + 「把本地文件变成一个提交」的编排。
 *
 * 为什么走 API 而不是本地 git：
 *   - 手机上不需要装/配 git，也不需要先 clone 一个仓库；
 *   - token 只在内存里用一次 HTTP 请求头，不落到 .git/config 或命令行参数里；
 *   - 仓库不存在时可以顺手创建。
 *
 * 流程：读仓库 → （必要时创建/初始化）→ 逐个文件建 blob → 建 tree（带 base_tree，
 * 不碰其他文件）→ 建 commit → 更新/创建分支 ref。内容与远端一致时不产生提交。
 */

import { readFileSync } from 'node:fs'

const USER_AGENT = 'dsh-github-push'
const DEFAULT_API_BASE = 'https://api.github.com'
const DEFAULT_TIMEOUT_MS = 45_000

/** 带 HTTP 状态码的 GitHub 错误；status=0 表示本地/网络层错误。 */
export class GitHubError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'GitHubError'
    this.status = Number.isInteger(options.status) ? options.status : 0
    this.body = options.body
  }
}

function encodeSegment(value) {
  return encodeURIComponent(String(value))
}

function detailOf(data) {
  if (data === null || typeof data !== 'object') return ''
  const message = typeof data.message === 'string' ? data.message : ''
  const errors = Array.isArray(data.errors)
    ? data.errors
        .map((entry) => {
          if (typeof entry === 'string') return entry
          if (entry !== null && typeof entry === 'object' && typeof entry.message === 'string') {
            const field = typeof entry.field === 'string' ? `${entry.field} ` : ''
            return `${field}${entry.message}`.trim()
          }
          return ''
        })
        .filter((entry) => entry !== '')
        .join('；')
    : ''
  return [message, errors].filter((part) => part !== '').join('：')
}

/** 把 HTTP 失败翻成用户能看懂的中文提示。 */
export function describeFailure(status, data, method = 'GET', path = '') {
  const detail = detailOf(data)
  const tail = detail === '' ? '' : `（${detail}）`
  switch (status) {
    case 401:
      return 'GitHub token 无效或已过期（401）。请到「设置 → GitHub」重新粘贴 token。'
    case 403:
      return `GitHub 拒绝访问（403）：token 权限不足、触发速率限制，或组织策略不允许${tail}。`
    case 404:
      return `GitHub 返回 404：仓库或资源不存在，或当前 token 无权访问${tail}。`
    case 409:
      return `GitHub 返回 409：仓库为空或存在并发写冲突，请重试${tail}。`
    case 422:
      return `GitHub 拒绝了请求内容（422）${tail}。`
    case 429:
      return 'GitHub 请求过于频繁（429），请稍后再试。'
    default:
      if (status >= 500) return `GitHub 服务异常（${status}），请稍后再试${tail}。`
      return `${method} ${path} 失败（${status}）${tail}。`
  }
}

/** 校验 GitHub 用户名/组织名。 */
export function validateOwner(owner) {
  if (typeof owner !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) {
    throw new GitHubError(`GitHub 用户名/组织名不合法：${String(owner)}`)
  }
}

/** 校验仓库名。 */
export function validateRepo(repo) {
  if (typeof repo !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(repo) || repo === '.' || repo === '..') {
    throw new GitHubError(`仓库名不合法：${String(repo)}`)
  }
}

/** 校验 owner/repo 的基本格式（也防止把斜杠塞进 URL 路径里）。 */
export function validateOwnerRepo(owner, repo) {
  validateOwner(owner)
  validateRepo(repo)
}

/** 简单并发闸门：最多 limit 个 worker 同时跑，失败即停。 */
async function mapLimit(items, limit, worker, signal) {
  const results = new Array(items.length)
  let next = 0
  let failed = false
  const run = async () => {
    while (!failed) {
      if (signal !== undefined && signal.aborted) throw signal.reason ?? new Error('操作已取消')
      const index = next
      next += 1
      if (index >= items.length) return
      try {
        results[index] = await worker(items[index], index)
      } catch (error) {
        failed = true
        throw error
      }
    }
  }
  const runners = []
  for (let i = 0; i < Math.min(limit, items.length); i += 1) runners.push(run())
  await Promise.all(runners)
  return results
}

/**
 * 创建一个 GitHub API 客户端。
 * @param {{ token:string, apiBase?:string, fetchImpl?:Function, timeoutMs?:number }} options
 */
export function createClient(options = {}) {
  const token = typeof options.token === 'string' ? options.token.trim() : ''
  if (token === '') {
    throw new GitHubError('缺少 GitHub token：请到「设置 → GitHub」粘贴一个 token。')
  }
  const apiBase = String(options.apiBase || DEFAULT_API_BASE).replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(apiBase)) throw new GitHubError(`apiBase 不是合法的 http(s) URL：${apiBase}`)
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new GitHubError('当前运行环境没有 fetch，无法访问 GitHub。')
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS

  async function request(method, path, requestOptions = {}) {
    const { body, signal, allowStatus = [] } = requestOptions
    const url = `${apiBase}${path}`
    const signals = []
    if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs))
    if (signal !== undefined) signals.push(signal)
    const headers = {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': USER_AGENT,
    }
    if (body !== undefined) headers['content-type'] = 'application/json'
    let response
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
      })
    } catch (error) {
      if (signal !== undefined && signal.aborted) throw signal.reason ?? error
      if (error !== null && typeof error === 'object' && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new GitHubError(`访问 GitHub 超时（${url}），请检查网络后重试。`, { status: 0, cause: error })
      }
      throw new GitHubError(`无法连接 GitHub：${error instanceof Error ? error.message : String(error)}`, { status: 0, cause: error })
    }
    const text = await response.text()
    let data = null
    if (text !== '') {
      try {
        data = JSON.parse(text)
      } catch {
        data = null
      }
    }
    if (!response.ok) {
      if (allowStatus.includes(response.status)) return { status: response.status, data, allowed: true }
      throw new GitHubError(describeFailure(response.status, data, method, path), { status: response.status, body: data })
    }
    return { status: response.status, data, allowed: false }
  }

  const client = {
    async getUser(signal) {
      const result = await request('GET', '/user', { signal })
      return result.data
    },

    /** 读仓库信息；不存在或无权限时返回 null。 */
    async getRepo(owner, repo, signal) {
      validateOwnerRepo(owner, repo)
      const result = await request('GET', `/repos/${encodeSegment(owner)}/${encodeSegment(repo)}`, {
        signal,
        allowStatus: [404],
      })
      return result.status === 200 ? result.data : null
    },

    /** 创建仓库；owner 是自己时建在用户名下，否则按组织建。 */
    async createRepo(owner, repo, { privateRepo = true, signal } = {}) {
      validateOwnerRepo(owner, repo)
      const user = await client.getUser(signal)
      const login = user !== null && typeof user === 'object' && typeof user.login === 'string' ? user.login : ''
      const path = owner.toLowerCase() === login.toLowerCase() ? '/user/repos' : `/orgs/${encodeSegment(owner)}/repos`
      const result = await request('POST', path, {
        signal,
        body: {
          name: repo,
          private: privateRepo !== false,
          auto_init: false,
          description: '由 DSH (dsh-github-push) 创建',
        },
      })
      return result.data
    },

    /** 读分支 head sha；分支/仓库为空时返回 null。 */
    async getBranchHead(owner, repo, branch, signal) {
      const read = async (ref) => {
        const result = await request('GET', `/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/git/ref/${ref}`, {
          signal,
          allowStatus: [404, 409],
        })
        if (result.status !== 200 || result.data === null || typeof result.data !== 'object') return null
        const sha = result.data.object !== undefined && result.data.object !== null ? result.data.object.sha : undefined
        return typeof sha === 'string' && sha !== '' ? sha : null
      }
      const plain = await read(`heads/${branch}`)
      if (plain !== null || !branch.includes('/')) return plain
      // 含斜杠的分支名在某些网关下要编码成 %2F 才能命中
      return read(`heads/${encodeURIComponent(branch)}`)
    },

    /** 读提交详情（含 tree.sha）。 */
    async getCommit(owner, repo, sha, signal) {
      const result = await request('GET', `/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/git/commits/${encodeSegment(sha)}`, { signal })
      return result.data
    },

    /** 创建 blob（base64 编码，二进制安全）。 */
    async createBlob(owner, repo, content, signal) {
      const result = await request('POST', `/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/git/blobs`, {
        signal,
        body: { content: Buffer.from(content).toString('base64'), encoding: 'base64' },
      })
      return result.data
    },

    /** 创建 tree；baseTree 存在时是增量目录树，不会删掉仓库里的其他文件。 */
    async createTree(owner, repo, entries, baseTree, signal) {
      const body = { tree: entries }
      if (typeof baseTree === 'string' && baseTree !== '') body.base_tree = baseTree
      const result = await request('POST', `/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/git/trees`, { signal, body })
      return result.data
    },

    /** 创建 commit。 */
    async createCommit(owner, repo, { message, tree, parents }, signal) {
      const result = await request('POST', `/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/git/commits`, {
        signal,
        body: { message, tree, parents },
      })
      return result.data
    },

    /** 更新已有分支 ref。 */
    async updateRef(owner, repo, branch, sha, signal) {
      const patch = async (ref) =>
        request('PATCH', `/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/git/refs/${ref}`, {
          signal,
          body: { sha, force: false },
          allowStatus: [404],
        })
      let result = await patch(`heads/${branch}`)
      if (result.status === 404 && branch.includes('/')) result = await patch(`heads/${encodeURIComponent(branch)}`)
      if (result.status !== 200) {
        throw new GitHubError(`更新分支 ${branch} 失败：分支不存在或没有写权限。`, { status: result.status, body: result.data })
      }
      return result.data
    },

    /** 创建新分支 ref。 */
    async createRef(owner, repo, branch, sha, signal) {
      const result = await request('POST', `/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/git/refs`, {
        signal,
        body: { ref: `refs/heads/${branch}`, sha },
      })
      return result.data
    },

    /** 用 Contents API 写一个文件（空仓库初始化时用，会顺带建出首个提交）。 */
    async putContents(owner, repo, filePath, message, content, branch, signal) {
      const encodedPath = String(filePath)
        .split('/')
        .map((part) => encodeSegment(part))
        .join('/')
      const body = { message, content: Buffer.from(content).toString('base64') }
      if (typeof branch === 'string' && branch !== '') body.branch = branch
      const result = await request('PUT', `/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/contents/${encodedPath}`, {
        signal,
        body,
      })
      return result.data
    },
  }

  return client
}

/**
 * 把一批本地文件提交到仓库。
 *
 * @param {object} client createClient() 的返回值
 * @param {object} options
 * @param {string} options.owner
 * @param {string} options.repo
 * @param {string} [options.branch] 目标分支；空串表示仓库默认分支
 * @param {Array<{abs:string,repoPath:string,size:number}>} options.files
 * @param {string} options.message 提交说明
 * @param {boolean} [options.createRepo] 仓库不存在时是否创建
 * @param {boolean} [options.privateRepo] 新建仓库是否私有
 * @param {AbortSignal} [options.signal]
 */
export async function pushFiles(client, options) {
  const { owner, repo, files, message, signal } = options
  const branchOption = typeof options.branch === 'string' ? options.branch : ''
  const createRepo = options.createRepo === true
  const privateRepo = options.privateRepo !== false
  if (!Array.isArray(files) || files.length === 0) throw new GitHubError('没有要上传的文件。')

  let repoInfo = await client.getRepo(owner, repo, signal)
  let createdRepo = false
  if (repoInfo === null) {
    if (!createRepo) {
      throw new GitHubError(
        `仓库 ${owner}/${repo} 不存在，或当前 token 无权访问。\n可以打开「仓库不存在时自动创建」，或在调用工具时传 createRepo: true。`,
        { status: 404 },
      )
    }
    try {
      repoInfo = await client.createRepo(owner, repo, { privateRepo, signal })
      createdRepo = true
    } catch (error) {
      if (error instanceof GitHubError && error.status === 422) {
        throw new GitHubError(
          `无法创建仓库 ${owner}/${repo}：同名仓库可能已存在（但当前 token 看不到它），或 token 没有创建仓库的权限。请先在 GitHub 确认仓库名，或换一个有 repo 权限的 classic token。`,
          { status: 422, body: error.body },
        )
      }
      throw error
    }
  }
  if (repoInfo === null || typeof repoInfo !== 'object') {
    throw new GitHubError(`无法确认仓库 ${owner}/${repo} 的信息。`)
  }

  const defaultBranch =
    typeof repoInfo.default_branch === 'string' && repoInfo.default_branch !== '' ? repoInfo.default_branch : 'main'
  const targetBranch = branchOption !== '' ? branchOption : defaultBranch
  const notes = []

  let parentSha = await client.getBranchHead(owner, repo, targetBranch, signal)
  let branchExists = parentSha !== null

  if (parentSha === null && targetBranch !== defaultBranch) {
    const defaultHead = await client.getBranchHead(owner, repo, defaultBranch, signal)
    if (defaultHead !== null) {
      parentSha = defaultHead
      notes.push(`分支 ${targetBranch} 还不存在，将以 ${defaultBranch} 的最新提交为基础新建。`)
    }
  }

  if (parentSha === null) {
    // 完全空的仓库：先用 Contents API 建一个初始提交，避免依赖「无父提交」的边缘行为。
    try {
      await client.putContents(
        owner,
        repo,
        'README.md',
        'chore: initialize repository',
        Buffer.from(`# ${repo}\n\n由 DSH 自动创建。\n`),
        '',
        signal,
      )
      notes.push(`仓库原为空，已自动创建初始 README.md（${defaultBranch}）。`)
    } catch (error) {
      if (!(error instanceof GitHubError) || error.status !== 422) throw error
      notes.push('初始化仓库时检测到已有并发提交，继续以现有提交为基础。')
    }
    parentSha = await client.getBranchHead(owner, repo, defaultBranch, signal)
    if (parentSha === null) {
      throw new GitHubError('仓库初始化失败：读不到默认分支。请到 GitHub 网页手动创建任意一个文件后再试。')
    }
    if (targetBranch === defaultBranch) branchExists = true
  }

  const parentCommit = await client.getCommit(owner, repo, parentSha, signal)
  const baseTree =
    parentCommit !== null && parentCommit !== undefined && parentCommit.tree !== undefined && parentCommit.tree !== null
      ? parentCommit.tree.sha
      : undefined
  if (typeof baseTree !== 'string' || baseTree === '') {
    throw new GitHubError(`无法读取提交 ${parentSha} 的目录树。`)
  }

  let totalBytes = 0
  for (const file of files) {
    if (Number.isFinite(file.size)) totalBytes += file.size
  }

  const entries = await mapLimit(
    files,
    4,
    async (file) => {
      let content
      try {
        content = readFileSync(file.abs)
      } catch (error) {
        throw new GitHubError(`读取文件失败：${file.abs}（${error instanceof Error ? error.message : String(error)}）`)
      }
      const blob = await client.createBlob(owner, repo, content, signal)
      if (blob === null || typeof blob !== 'object' || typeof blob.sha !== 'string') {
        throw new GitHubError(`创建 blob 失败：${file.repoPath}`)
      }
      return { path: file.repoPath, mode: '100644', type: 'blob', sha: blob.sha }
    },
    signal,
  )

  const tree = await client.createTree(owner, repo, entries, baseTree, signal)
  if (tree === null || typeof tree !== 'object' || typeof tree.sha !== 'string') {
    throw new GitHubError('创建目录树失败。')
  }

  const repoUrl =
    typeof repoInfo.html_url === 'string' && repoInfo.html_url !== ''
      ? repoInfo.html_url
      : `https://github.com/${owner}/${repo}`

  if (tree.sha === baseTree) {
    return {
      repo: `${owner}/${repo}`,
      branch: targetBranch,
      unchanged: true,
      commit: '',
      commitUrl: '',
      repoUrl,
      files: files.length,
      bytes: totalBytes,
      createdRepo,
      notes: [...notes, '远端内容与本地一致，没有产生新提交。'],
    }
  }

  const commit = await client.createCommit(
    owner,
    repo,
    { message, tree: tree.sha, parents: parentSha === null ? [] : [parentSha] },
    signal,
  )
  if (commit === null || typeof commit !== 'object' || typeof commit.sha !== 'string') {
    throw new GitHubError('创建提交失败。')
  }

  if (branchExists) {
    try {
      await client.updateRef(owner, repo, targetBranch, commit.sha, signal)
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) {
        await client.createRef(owner, repo, targetBranch, commit.sha, signal)
        branchExists = false
      } else {
        throw error
      }
    }
  } else {
    try {
      await client.createRef(owner, repo, targetBranch, commit.sha, signal)
    } catch (error) {
      if (error instanceof GitHubError && error.status === 422) {
        await client.updateRef(owner, repo, targetBranch, commit.sha, signal)
      } else {
        throw error
      }
    }
  }

  return {
    repo: `${owner}/${repo}`,
    branch: targetBranch,
    unchanged: false,
    commit: commit.sha,
    commitUrl: typeof commit.html_url === 'string' ? commit.html_url : '',
    repoUrl,
    files: files.length,
    bytes: totalBytes,
    createdRepo,
    notes,
  }
}

/** 读连接信息：当前 token 对应账号 + 目标仓库是否存在/可写。 */
export async function inspectConnection(client, { owner, repo, signal } = {}) {
  const user = await client.getUser(signal)
  const login = user !== null && typeof user === 'object' && typeof user.login === 'string' ? user.login : ''
  let repoInfo = null
  if (typeof owner === 'string' && owner !== '' && typeof repo === 'string' && repo !== '') {
    repoInfo = await client.getRepo(owner, repo, signal)
  }
  return {
    login,
    name: user !== null && typeof user === 'object' && typeof user.name === 'string' ? user.name : '',
    repo: repoInfo,
  }
}
