/**
 * 配置读写测试：token 脱敏、环境变量回退、最近推送记录。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'ghp-home-'))
process.env.DSH_HOME = home
delete process.env.GITHUB_TOKEN
delete process.env.GH_TOKEN

const { configPath, loadConfig, maskToken, publicConfig, recordPush, saveConfig, tokenInfo } = await import(
  '../lib/config.js'
)

test('默认配置是一份完整可用的形状', () => {
  const config = loadConfig()
  assert.equal(config.token, '')
  assert.equal(config.owner, '')
  assert.equal(config.repo, '')
  assert.equal(config.autoCreateRepo, true)
  assert.equal(config.privateRepo, true)
  assert.ok(Array.isArray(config.exclude) && config.exclude.includes('node_modules'))
  assert.deepEqual(config.lastPushes, [])
})

test('保存后可读回，且配置文件位于 storages 下', async () => {
  saveConfig({ token: 'ghp_secret_value_1234', owner: 'tester', repo: 'my-code', branch: 'dev', privateRepo: false })
  const config = loadConfig()
  assert.equal(config.token, 'ghp_secret_value_1234')
  assert.equal(config.owner, 'tester')
  assert.equal(config.repo, 'my-code')
  assert.equal(config.branch, 'dev')
  assert.equal(config.privateRepo, false)
  assert.match(configPath(), /storages\/dsh-github-push\/config\.json$/)
  const info = await stat(configPath())
  assert.equal(info.mode & 0o077, 0, '配置文件应对其他用户不可读写')
})

test('对外配置视图永远不含 token', () => {
  const config = loadConfig()
  const view = publicConfig(config)
  assert.equal(Object.hasOwn(view, 'token'), false)
  assert.equal(JSON.stringify(view).includes('ghp_secret_value_1234'), false)
  assert.equal(view.owner, 'tester')
})

test('token 脱敏与来源标记', () => {
  const config = loadConfig()
  const info = tokenInfo(config)
  assert.equal(info.configured, true)
  assert.equal(info.source, 'config')
  assert.equal(info.hint, 'ghp_…1234')
  assert.equal(info.token, 'ghp_secret_value_1234')
  assert.equal(maskToken('short'), '•••rt')
  assert.equal(maskToken(''), '')
})

test('配置文件没有 token 时回退到环境变量', () => {
  saveConfig({ token: '' })
  process.env.GITHUB_TOKEN = 'ghp_from_env_5678'
  try {
    const info = tokenInfo(loadConfig())
    assert.equal(info.configured, true)
    assert.equal(info.source, 'env')
    assert.equal(info.token, 'ghp_from_env_5678')
    assert.equal(info.hint, 'ghp_…5678')
  } finally {
    delete process.env.GITHUB_TOKEN
  }
})

test('最近推送记录只保留最近的条目', () => {
  for (let index = 0; index < 25; index += 1) {
    recordPush({ at: new Date().toISOString(), repo: 'tester/my-code', branch: 'main', commit: `sha${index}`, files: index })
  }
  const config = loadConfig()
  assert.equal(config.lastPushes.length, 20)
  assert.equal(config.lastPushes[0].commit, 'sha24')
  assert.equal(config.lastPushes[19].commit, 'sha5')
})
