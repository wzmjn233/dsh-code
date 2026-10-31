/**
 * 一个够真的假 GitHub REST API，用来在离线环境里测通推送流程。
 * 覆盖：token 校验、仓库创建、空仓库初始化（Contents API）、blob/tree/commit/ref、
 * 分支名含斜杠、tree 内容一致性（sha 相同时客户端应判定「无新提交」）。
 */

import { createHash } from 'node:crypto'

function hash(...parts) {
  const digest = createHash('sha1')
  for (const part of parts) digest.update(String(part))
  return digest.digest('hex')
}

function respond(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    async text() {
      return data === undefined ? '' : JSON.stringify(data)
    },
  }
}

export function createFakeGitHub({ token = 'test-token' } = {}) {
  const store = {
    repos: new Map(),
    calls: [],
    users: { tester: { login: 'tester', name: 'Tester', html_url: 'https://github.com/tester' } },
  }

  function repoOf(owner, name) {
    return store.repos.get(`${owner}/${name}`)
  }

  function repoView(repo) {
    return {
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      private: repo.private,
      default_branch: repo.default_branch,
      html_url: repo.html_url,
      permissions: { push: true, admin: true, pull: true },
    }
  }

  function treeShaOf(files) {
    const key = Object.keys(files)
      .sort()
      .map((path) => `${path}:${files[path].sha}`)
      .join('|')
    return hash('tree', key)
  }

  function ensureRepo(owner, name, options = {}) {
    const key = `${owner}/${name}`
    if (store.repos.has(key)) throw new Error(`repo ${key} already exists`)
    const repo = {
      owner,
      name,
      private: options.private === true,
      default_branch: options.default_branch || 'main',
      html_url: `https://github.com/${key}`,
      branches: new Map(),
      commits: new Map(),
      trees: new Map(),
      blobs: new Map(),
    }
    store.repos.set(key, repo)
    return repo
  }

  /** 直接写入一个提交（测试播种用）。 */
  function seedRepo(owner, name, files = {}, { branch = 'main', message = 'seed', private: isPrivate = false } = {}) {
    let repo = repoOf(owner, name)
    if (repo === undefined) repo = ensureRepo(owner, name, { private: isPrivate, default_branch: branch })
    const fileMap = {}
    for (const [path, content] of Object.entries(files)) {
      const buffer = Buffer.from(content)
      const blobSha = hash('blob', buffer.toString('base64'))
      repo.blobs.set(blobSha, buffer)
      fileMap[path] = { mode: '100644', type: 'blob', sha: blobSha }
    }
    const treeSha = treeShaOf(fileMap)
    repo.trees.set(treeSha, { sha: treeSha, files: fileMap })
    const commitSha = hash('commit', message, treeSha, '')
    repo.commits.set(commitSha, {
      sha: commitSha,
      tree: { sha: treeSha },
      parents: [],
      message,
      html_url: `https://github.com/${owner}/${name}/commit/${commitSha}`,
    })
    repo.branches.set(branch, commitSha)
    return { repo, commit: commitSha, tree: treeSha }
  }

  async function fetchImpl(input, init = {}) {
    const url = new URL(String(input))
    const method = String(init.method || 'GET').toUpperCase()
    const path = url.pathname
    const body = typeof init.body === 'string' && init.body !== '' ? JSON.parse(init.body) : undefined
    store.calls.push({ method, path, body })

    const headers = init.headers || {}
    const authorization = headers.authorization || headers.Authorization || ''
    if (authorization !== `Bearer ${token}`) return respond(401, { message: 'Bad credentials' })

    if (method === 'GET' && path === '/user') return respond(200, store.users.tester)

    const repoMatch = /^\/repos\/([^/]+)\/([^/]+)$/.exec(path)
    if (repoMatch !== null) {
      const owner = decodeURIComponent(repoMatch[1])
      const name = decodeURIComponent(repoMatch[2])
      const repo = repoOf(owner, name)
      if (repo === undefined) return respond(404, { message: 'Not Found' })
      return respond(200, repoView(repo))
    }

    if (method === 'POST' && (path === '/user/repos' || /^\/orgs\/[^/]+\/repos$/.test(path))) {
      const owner = path === '/user/repos' ? 'tester' : decodeURIComponent(path.split('/')[2])
      if (repoOf(owner, body.name) !== undefined) {
        return respond(422, {
          message: 'Repository creation failed.',
          errors: [{ field: 'name', message: 'name already exists on this account' }],
        })
      }
      const repo = ensureRepo(owner, body.name, { private: body.private === true })
      return respond(201, repoView(repo))
    }

    const refMatch = /^\/repos\/([^/]+)\/([^/]+)\/git\/ref\/(.*)$/.exec(path)
    if (refMatch !== null) {
      const repo = repoOf(decodeURIComponent(refMatch[1]), decodeURIComponent(refMatch[2]))
      if (repo === undefined) return respond(404, { message: 'Not Found' })
      const ref = decodeURIComponent(refMatch[3])
      if (!ref.startsWith('heads/')) return respond(404, { message: 'Not Found' })
      const branch = ref.slice('heads/'.length)
      if (method === 'GET') {
        const sha = repo.branches.get(branch)
        if (sha === undefined) return respond(404, { message: 'Not Found' })
        return respond(200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } })
      }
    }

    const refsMatch = /^\/repos\/([^/]+)\/([^/]+)\/git\/refs\/(.*)$/.exec(path)
    if (refsMatch !== null) {
      const repo = repoOf(decodeURIComponent(refsMatch[1]), decodeURIComponent(refsMatch[2]))
      if (repo === undefined) return respond(404, { message: 'Not Found' })
      const ref = decodeURIComponent(refsMatch[3])
      if (!ref.startsWith('heads/')) return respond(404, { message: 'Not Found' })
      const branch = ref.slice('heads/'.length)
      if (method === 'PATCH') {
        if (!repo.branches.has(branch)) return respond(404, { message: 'Not Found' })
        repo.branches.set(branch, body.sha)
        return respond(200, { ref: `refs/heads/${branch}`, object: { sha: body.sha } })
      }
    }

    if (method === 'POST' && /\/git\/refs$/.test(path)) {
      const repo = repoOf(decodeURIComponent(path.split('/')[2]), decodeURIComponent(path.split('/')[3]))
      if (repo === undefined) return respond(404, { message: 'Not Found' })
      if (!body.ref.startsWith('refs/heads/')) return respond(422, { message: 'bad ref' })
      const branch = body.ref.slice('refs/heads/'.length)
      if (repo.branches.has(branch)) return respond(422, { message: 'Reference already exists' })
      if (!repo.commits.has(body.sha)) return respond(422, { message: 'Object does not exist' })
      repo.branches.set(branch, body.sha)
      return respond(201, { ref: body.ref, object: { sha: body.sha } })
    }

    const commitMatch = /^\/repos\/([^/]+)\/([^/]+)\/git\/commits\/([^/]+)$/.exec(path)
    if (commitMatch !== null && method === 'GET') {
      const repo = repoOf(decodeURIComponent(commitMatch[1]), decodeURIComponent(commitMatch[2]))
      if (repo === undefined) return respond(404, { message: 'Not Found' })
      const commit = repo.commits.get(decodeURIComponent(commitMatch[3]))
      if (commit === undefined) return respond(404, { message: 'Not Found' })
      return respond(200, commit)
    }

    if (method === 'POST' && /\/git\/commits$/.test(path)) {
      const repo = repoOf(decodeURIComponent(path.split('/')[2]), decodeURIComponent(path.split('/')[3]))
      if (repo === undefined) return respond(404, { message: 'Not Found' })
      if (!repo.trees.has(body.tree)) return respond(422, { message: 'Tree not found' })
      const parents = Array.isArray(body.parents) ? body.parents : []
      if (parents.length === 0) {
        return respond(422, { message: 'Git Repository is empty.', errors: [{ field: 'parents', code: 'missing' }] })
      }
      for (const parent of parents) {
        if (!repo.commits.has(parent)) return respond(422, { message: 'parent commit not found' })
      }
      const sha = hash('commit', body.message, body.tree, parents.join(','))
      const commit = {
        sha,
        tree: { sha: body.tree },
        parents,
        message: body.message,
        html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
      }
      repo.commits.set(sha, commit)
      return respond(201, commit)
    }

    if (method === 'POST' && /\/git\/blobs$/.test(path)) {
      const repo = repoOf(decodeURIComponent(path.split('/')[2]), decodeURIComponent(path.split('/')[3]))
      if (repo === undefined) return respond(404, { message: 'Not Found' })
      if (body.encoding !== 'base64') return respond(422, { message: 'encoding must be base64' })
      const buffer = Buffer.from(body.content, 'base64')
      const sha = hash('blob', buffer.toString('base64'))
      repo.blobs.set(sha, buffer)
      return respond(201, { sha })
    }

    if (method === 'POST' && /\/git\/trees$/.test(path)) {
      const repo = repoOf(decodeURIComponent(path.split('/')[2]), decodeURIComponent(path.split('/')[3]))
      if (repo === undefined) return respond(404, { message: 'Not Found' })
      const files = {}
      if (body.base_tree !== undefined) {
        const base = repo.trees.get(body.base_tree)
        if (base === undefined) return respond(404, { message: 'Not Found' })
        for (const [filePath, entry] of Object.entries(base.files)) files[filePath] = entry
      }
      for (const entry of body.tree) files[entry.path] = { mode: entry.mode, type: entry.type, sha: entry.sha }
      const sha = treeShaOf(files)
      repo.trees.set(sha, { sha, files })
      return respond(201, { sha, tree: body.tree })
    }

    const contentsMatch = /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/.exec(path)
    if (contentsMatch !== null && method === 'PUT') {
      const repo = repoOf(decodeURIComponent(contentsMatch[1]), decodeURIComponent(contentsMatch[2]))
      if (repo === undefined) return respond(404, { message: 'Not Found' })
      if (repo.branches.size > 0) {
        return respond(422, { message: 'Invalid request.', errors: [{ field: 'sha', message: "sha wasn't supplied" }] })
      }
      const filePath = contentsMatch[3]
        .split('/')
        .map((part) => decodeURIComponent(part))
        .join('/')
      const buffer = Buffer.from(body.content, 'base64')
      const blobSha = hash('blob', buffer.toString('base64'))
      repo.blobs.set(blobSha, buffer)
      const files = { [filePath]: { mode: '100644', type: 'blob', sha: blobSha } }
      const treeSha = treeShaOf(files)
      repo.trees.set(treeSha, { sha: treeSha, files })
      const commitSha = hash('commit', body.message, treeSha, '')
      repo.commits.set(commitSha, {
        sha: commitSha,
        tree: { sha: treeSha },
        parents: [],
        message: body.message,
        html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${commitSha}`,
      })
      repo.branches.set(repo.default_branch, commitSha)
      return respond(201, { content: { path: filePath }, commit: { sha: commitSha } })
    }

    return respond(404, { message: `fake GitHub: no route for ${method} ${path}` })
  }

  return { fetch: fetchImpl, store, seedRepo, repo: repoOf, ensureRepo }
}
