/**
 * 宿主插件集成测试：工具注册、设置页 API、工具真实执行（走假 GitHub）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeGitHub } from './fake-github.mjs'

const home = await mkdtemp(join(tmpdir(), 'ghp-index-home-'))
process.env.DSH_HOME = home
delete process.env.GITHUB_TOKEN
delete process.env.GH_TOKEN

const { apply } = await import('../lib/index.js')
const { saveConfig, loadConfig } = await import('../lib/config.js')

function createCtx(cwd) {
  const tools = []
  const routes = []
  const ctx = {
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    effect(fn) {
      return fn()
    },
    get(name) {
      if (name === 'workingDirectory') {
        return { ensure: async () => cwd }
      }
      return undefined
    },
  }
  return { ctx, tools, routes }
}

function makeReq(method, url, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = {}
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
  return req
}

function makeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(statusCode, headers) {
      this.statusCode = statusCode
      this.headers = headers
    },
    end(body) {
      this.body = typeof body === 'string' ? body : String(body)
    },
  }
}

async function callRoute(handler, method, url, body) {
  const res = makeRes()
  await handler(makeReq(method, url, body), res)
  return res
}

const { ctx, tools, routes } = createCtx(home)
apply(ctx)
const route = routes[0]

test('注册三个工具和一条同源 API 路由', () => {
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ['github_config', 'github_push', 'github_status'],
  )
  for (const tool of tools) {
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.description, 'string')
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.output.schema.type, 'object')
    assert.equal(typeof tool.output.render, 'function')
  }
  const push = tools.find((tool) => tool.name === 'github_push')
  assert.equal(push.timeoutMs, 180000)
  assert.equal(push.isConcurrencySafe(), false)

  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/api/github-push')
})

test('GET /state 不泄露 token', async () => {
  saveConfig({ token: '', owner: '', repo: '' })
  const res = await callRoute(route.handler, 'GET', '/api/github-push/state')
  assert.equal(res.statusCode, 200)
  const state = JSON.parse(res.body)
  assert.equal(state.token.configured, false)
  assert.equal(state.config.owner, '')
  assert.equal(res.body.includes('ghp_'), false)
})

test('POST /save 保存 token 与仓库设置，只回显脱敏提示', async () => {
  const res = await callRoute(route.handler, 'POST', '/api/github-push/save', {
    token: 'ghp_abcdefgh1234',
    owner: 'tester',
    repo: 'my-code',
    branch: 'dev',
    privateRepo: false,
    autoCreateRepo: false,
  })
  assert.equal(res.statusCode, 200)
  const state = JSON.parse(res.body)
  assert.equal(state.token.configured, true)
  assert.equal(state.token.source, 'config')
  assert.equal(state.token.hint, 'ghp_…1234')
  assert.equal(state.config.owner, 'tester')
  assert.equal(state.config.repo, 'my-code')
  assert.equal(state.config.branch, 'dev')
  assert.equal(state.config.privateRepo, false)
  assert.equal(state.config.autoCreateRepo, false)
  assert.equal(res.body.includes('ghp_abcdefgh1234'), false)

  const saved = loadConfig()
  assert.equal(saved.token, 'ghp_abcdefgh1234')
  assert.equal(saved.owner, 'tester')
})

test('POST /test 用真实客户端逻辑验证连接（假 GitHub）', async () => {
  const fake = createFakeGitHub()
  fake.seedRepo('tester', 'my-code', { 'README.md': 'hi' })
  saveConfig({ token: 'test-token', owner: 'tester', repo: 'my-code' })

  const originalFetch = globalThis.fetch
  globalThis.fetch = fake.fetch
  try {
    const res = await callRoute(route.handler, 'POST', '/api/github-push/test', {})
    assert.equal(res.statusCode, 200)
    const data = JSON.parse(res.body)
    assert.equal(data.ok, true)
    assert.equal(data.login, 'tester')
    assert.equal(data.repo.fullName, 'tester/my-code')
    assert.equal(data.repo.defaultBranch, 'main')
    assert.equal(data.repo.canPush, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('github_push 工具能把目录变成仓库里的一次提交', async () => {
  const fake = createFakeGitHub()
  fake.seedRepo('tester', 'demo3', { 'README.md': 'seed' })
  saveConfig({
    token: 'test-token',
    owner: 'tester',
    repo: 'demo3',
    branch: '',
    autoCreateRepo: true,
    privateRepo: true,
  })

  const source = await mkdtemp(join(tmpdir(), 'ghp-tool-'))
  await writeFile(join(source, 'hello.txt'), 'hi from dsh')

  const pushTool = tools.find((tool) => tool.name === 'github_push')
  const originalFetch = globalThis.fetch
  globalThis.fetch = fake.fetch
  try {
    const result = await pushTool.execute({ source, targetDir: 'pkg' }, { agent: {}, signal: undefined })
    assert.equal(result.repo, 'tester/demo3')
    assert.equal(result.branch, 'main')
    assert.equal(result.files, 1)
    assert.equal(result.unchanged, false)
    assert.ok(result.commit.length === 40)
    assert.ok(result.commitUrl.includes('github.com'))
    assert.equal(result.message.includes('DSH'), true)

    const repo = fake.repo('tester', 'demo3')
    const commit = repo.commits.get(result.commit)
    const tree = repo.trees.get(commit.tree.sha)
    assert.equal(repo.blobs.get(tree.files['pkg/hello.txt'].sha).toString(), 'hi from dsh')
    assert.equal(repo.branches.get('main'), result.commit)
    assert.ok(Array.isArray(result.notes))
    assert.equal(loadConfig().lastPushes[0].repo, 'tester/demo3')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('github_status 工具报告仓库与账号状态', async () => {
  const fake = createFakeGitHub()
  fake.seedRepo('tester', 'demo3', { 'README.md': 'seed' })
  saveConfig({ token: 'test-token', owner: 'tester', repo: 'demo3', branch: '' })

  const statusTool = tools.find((tool) => tool.name === 'github_status')
  const originalFetch = globalThis.fetch
  globalThis.fetch = fake.fetch
  try {
    const status = await statusTool.execute({}, { agent: {}, signal: undefined })
    assert.equal(status.configured, true)
    assert.equal(status.tokenConfigured, true)
    assert.equal(status.repoExists, true)
    assert.equal(status.login, 'tester')
    assert.equal(status.defaultBranch, 'main')
    assert.equal(status.error, '')
    assert.ok(status.lastPushes.length >= 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})
