/**
 * 推送流程测试：用假 GitHub API 验证「建仓库 → 初始化 → 提交 → 增量更新」。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createFakeGitHub } from './fake-github.mjs'
import { createClient, GitHubError, pushFiles } from '../lib/github.js'
import { collectFiles, joinRepoPath } from '../lib/files.js'

async function makeSource(files) {
  const root = await mkdtemp(join(tmpdir(), 'ghp-src-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content)
  }
  return root
}

async function uploadsOf(dir, targetDir = '', collectOptions = {}) {
  const collected = collectFiles(dir, collectOptions)
  assert.ok(collected.files.length > 0, '测试目录里应该有可上传文件')
  return collected.files.map((file) => ({
    abs: file.abs,
    repoPath: joinRepoPath(targetDir, file.rel),
    size: file.size,
  }))
}

test('首次推送会创建仓库、初始化空仓库并提交文件', async () => {
  const fake = createFakeGitHub()
  const client = createClient({ token: 'test-token', fetchImpl: fake.fetch })
  const dir = await makeSource({ 'hello.js': 'console.log(1)\n', 'lib/a.txt': 'A' })
  const files = await uploadsOf(dir)

  const result = await pushFiles(client, {
    owner: 'tester',
    repo: 'demo',
    files,
    message: 'init',
    createRepo: true,
    privateRepo: true,
  })

  assert.equal(result.repo, 'tester/demo')
  assert.equal(result.branch, 'main')
  assert.equal(result.createdRepo, true)
  assert.equal(result.unchanged, false)
  assert.equal(result.commit.length, 40)

  const repo = fake.repo('tester', 'demo')
  assert.equal(repo.private, true)
  assert.equal(repo.branches.get('main'), result.commit)

  const commit = repo.commits.get(result.commit)
  assert.equal(commit.parents.length, 1, '空仓库初始化后应有一个父提交')
  const tree = repo.trees.get(commit.tree.sha)
  assert.equal(repo.blobs.get(tree.files['hello.js'].sha).toString(), 'console.log(1)\n')
  assert.equal(repo.blobs.get(tree.files['lib/a.txt'].sha).toString(), 'A')
  assert.ok(tree.files['README.md'], '空仓库初始化会写入 README.md')
  assert.ok(result.notes.some((note) => note.includes('README')))
})

test('内容未变化时不再产生提交', async () => {
  const fake = createFakeGitHub()
  const client = createClient({ token: 'test-token', fetchImpl: fake.fetch })
  const dir = await makeSource({ 'hello.js': 'console.log(1)\n' })
  const files = await uploadsOf(dir)
  const options = { owner: 'tester', repo: 'demo', files, message: 'init', createRepo: true }

  const first = await pushFiles(client, options)
  assert.equal(first.unchanged, false)

  const repo = fake.repo('tester', 'demo')
  const commitCount = repo.commits.size
  const second = await pushFiles(client, { ...options, files: await uploadsOf(dir) })
  assert.equal(second.unchanged, true)
  assert.equal(second.commit, '')
  assert.equal(repo.commits.size, commitCount)
  assert.equal(repo.branches.get('main'), first.commit)
})

test('修改文件后产生带父提交的新提交', async () => {
  const fake = createFakeGitHub()
  const client = createClient({ token: 'test-token', fetchImpl: fake.fetch })
  const dir = await makeSource({ 'hello.js': 'console.log(1)\n' })
  const options = { owner: 'tester', repo: 'demo', message: 'init', createRepo: true }

  const first = await pushFiles(client, { ...options, files: await uploadsOf(dir) })
  await writeFile(join(dir, 'hello.js'), 'console.log(2)\n')
  const second = await pushFiles(client, { ...options, message: 'update', files: await uploadsOf(dir) })

  assert.equal(second.unchanged, false)
  const repo = fake.repo('tester', 'demo')
  const commit = repo.commits.get(second.commit)
  assert.deepEqual(commit.parents, [first.commit])
  assert.equal(repo.branches.get('main'), second.commit)
  const tree = repo.trees.get(commit.tree.sha)
  assert.equal(repo.blobs.get(tree.files['hello.js'].sha).toString(), 'console.log(2)\n')
})

test('目标仓库不存在且未允许创建时给出可操作错误', async () => {
  const fake = createFakeGitHub()
  const client = createClient({ token: 'test-token', fetchImpl: fake.fetch })
  const dir = await makeSource({ 'a.txt': 'a' })
  await assert.rejects(
    pushFiles(client, {
      owner: 'tester',
      repo: 'missing',
      files: await uploadsOf(dir),
      message: 'x',
      createRepo: false,
    }),
    /自动创建/,
  )
})

test('token 无效时映射为 401 提示', async () => {
  const fake = createFakeGitHub()
  const client = createClient({ token: 'wrong-token', fetchImpl: fake.fetch })
  await assert.rejects(client.getRepo('tester', 'demo'), (error) => {
    assert.ok(error instanceof GitHubError)
    assert.equal(error.status, 401)
    assert.match(error.message, /token/)
    return true
  })
})

test('没有 token 时创建客户端直接报错', () => {
  const fake = createFakeGitHub()
  assert.throws(() => createClient({ token: '', fetchImpl: fake.fetch }), /缺少 GitHub token/)
})

test('支持含斜杠的分支名（新分支从默认分支展开）', async () => {
  const fake = createFakeGitHub()
  fake.seedRepo('tester', 'demo', { 'README.md': 'hi' }, { branch: 'main' })
  const client = createClient({ token: 'test-token', fetchImpl: fake.fetch })
  const dir = await makeSource({ 'x.txt': 'x' })

  const result = await pushFiles(client, {
    owner: 'tester',
    repo: 'demo',
    branch: 'feature/x',
    files: await uploadsOf(dir, 'app'),
    message: 'feat',
    createRepo: false,
  })

  assert.equal(result.branch, 'feature/x')
  const repo = fake.repo('tester', 'demo')
  assert.equal(repo.branches.get('feature/x'), result.commit)
  const mainCommit = repo.branches.get('main')
  assert.equal(mainCommit, repo.commits.get(mainCommit).sha)
  const commit = repo.commits.get(result.commit)
  assert.deepEqual(commit.parents, [mainCommit])
  const tree = repo.trees.get(commit.tree.sha)
  assert.ok(tree.files['app/x.txt'], 'targetDir 应体现在仓库路径里')
  assert.ok(tree.files['README.md'], 'base_tree 应保留仓库原有文件')
})

test('推送内容与远端完全一致时判定为无变更', async () => {
  const fake = createFakeGitHub()
  fake.seedRepo('tester', 'demo', { 'README.md': 'hi' })
  const client = createClient({ token: 'test-token', fetchImpl: fake.fetch })
  const dir = await makeSource({ 'README.md': 'hi' })

  const result = await pushFiles(client, {
    owner: 'tester',
    repo: 'demo',
    files: await uploadsOf(dir),
    message: 'same',
    createRepo: false,
  })

  assert.equal(result.unchanged, true)
  assert.equal(fake.repo('tester', 'demo').commits.size, 1)
})

test('网络失败时给出中文错误', async () => {
  const client = createClient({
    token: 'test-token',
    fetchImpl: async () => {
      throw new Error('socket hang up')
    },
  })
  await assert.rejects(client.getUser(), /无法连接 GitHub/)
})
