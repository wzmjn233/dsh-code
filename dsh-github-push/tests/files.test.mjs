/**
 * 文件收集与路径规则的单元测试。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  collectFiles,
  createExcludeMatcher,
  joinRepoPath,
  normalizeBranch,
  normalizeRepoDir,
} from '../lib/files.js'

async function makeSource(files) {
  const root = await mkdtemp(join(tmpdir(), 'ghp-src-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content)
  }
  return root
}

test('normalizeRepoDir 只接受仓库内相对路径', () => {
  assert.equal(normalizeRepoDir(''), '')
  assert.equal(normalizeRepoDir('.'), '')
  assert.equal(normalizeRepoDir('./src/'), 'src')
  assert.equal(normalizeRepoDir('src\\lib'), 'src/lib')
  assert.equal(normalizeRepoDir('a/b'), 'a/b')
  assert.throws(() => normalizeRepoDir('/etc'), /相对路径/)
  assert.throws(() => normalizeRepoDir('a/../b'), /\.\./)
  assert.throws(() => normalizeRepoDir('C:\\temp'), /相对路径/)
})

test('normalizeBranch 拒绝不安全分支名', () => {
  assert.equal(normalizeBranch('main'), 'main')
  assert.equal(normalizeBranch('feature/x'), 'feature/x')
  assert.equal(normalizeBranch(''), '')
  assert.throws(() => normalizeBranch('bad branch'), /不支持的字符/)
  assert.throws(() => normalizeBranch('a//b'), /不合法/)
  assert.throws(() => normalizeBranch('..'), /不合法/)
  assert.throws(() => normalizeBranch('/main'), /不合法/)
})

test('排除规则支持文件名与路径两种写法', () => {
  const matched = createExcludeMatcher(['node_modules', '*.log', '.env', 'dist/**'])
  assert.equal(matched('src/node_modules/x.js', 'x.js'), true)
  assert.equal(matched('logs/a.log', 'a.log'), true)
  assert.equal(matched('.env', '.env'), true)
  assert.equal(matched('dist/bundle.js', 'bundle.js'), true)
  assert.equal(matched('src/index.js', 'index.js'), false)
})

test('collectFiles 遍历目录并按规则排除', async () => {
  const dir = await makeSource({
    'README.md': 'hello',
    'src/a.js': 'console.log(1)',
    'src/node_modules/dep/index.js': 'dep',
    '.env': 'SECRET=1',
    '.env.example': 'SECRET=',
    'dist/out.js': 'out',
  })
  const collected = collectFiles(dir, { exclude: ['.git', 'node_modules', '.env', 'dist'] })
  const rels = collected.files.map((file) => file.rel).sort()
  assert.deepEqual(rels, ['.env.example', 'README.md', 'src/a.js'])
  assert.equal(collected.skipped.length, 0)
  assert.equal(collected.truncated, false)
  assert.ok(collected.totalBytes > 0)
})

test('collectFiles 支持单个文件（不套用排除规则）', async () => {
  const dir = await makeSource({ '.env': 'SECRET=1' })
  const collected = collectFiles(join(dir, '.env'), { exclude: ['.env'] })
  assert.equal(collected.kind, 'file')
  assert.equal(collected.files.length, 1)
  assert.equal(collected.files[0].rel, '.env')
})

test('collectFiles 超过文件数上限时截断并记录', async () => {
  const files = {}
  for (let index = 0; index < 5; index += 1) files[`f${index}.txt`] = `content-${index}`
  const dir = await makeSource(files)
  const collected = collectFiles(dir, { maxFiles: 2 })
  assert.equal(collected.files.length, 2)
  assert.equal(collected.truncated, true)
  assert.ok(collected.skipped.length > 0)
})

test('collectFiles 对不存在的路径给出明确错误', async () => {
  assert.throws(() => collectFiles(join(tmpdir(), 'ghp-does-not-exist-xyz')), /路径不存在/)
})

test('joinRepoPath 拼接仓库路径', () => {
  assert.equal(joinRepoPath('', 'a/b.txt'), 'a/b.txt')
  assert.equal(joinRepoPath('pkg', 'a/b.txt'), 'pkg/a/b.txt')
  assert.equal(joinRepoPath('pkg', '\\a\\b.txt'), 'pkg/a/b.txt')
})
