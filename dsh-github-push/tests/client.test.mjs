/**
 * 浏览器半侧 bundle 测试：用手搓的 React / DOM / slots 桩执行 client.js，
 * 验证它注册了「设置 → GitHub」页、注入样式，并且首屏能正常渲染不抛错。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

function createFakeReact() {
  class Component {
    constructor(props) {
      this.props = props
    }
  }
  Component.prototype.isReactComponent = true

  return {
    createElement(type, props, ...children) {
      const merged = Object.assign({}, props || {})
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      return { type, props: merged }
    },
    Component,
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect() {},
  }
}

function renderToText(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child) => renderToText(child)).join('')
  if (typeof node !== 'object') return ''
  const type = node.type
  const props = node.props || {}
  if (typeof type === 'function') {
    if (type.prototype !== undefined && type.prototype !== null && type.prototype.isReactComponent) {
      const instance = new type(props)
      instance.state = { error: null }
      return renderToText(instance.render())
    }
    return renderToText(type(props))
  }
  if (typeof type === 'string') return renderToText(props.children)
  return ''
}

test('client bundle 注册设置页并渲染首屏', async () => {
  let registration = null
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        registration = definition
      },
    },
  }
  const appended = []
  globalThis.document = {
    head: {
      appendChild(node) {
        appended.push(node)
      },
    },
    createElement() {
      return { id: '', textContent: '' }
    },
    getElementById(id) {
      return appended.find((node) => node.id === id) || null
    },
  }

  // 执行 bundle（它只调用 window.__ModuleLoader__.load 注册工厂）
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', source)(globalThis.window, globalThis.document)
  assert.ok(registration !== null, 'bundle 应该注册到 __ModuleLoader__')
  assert.equal(registration.id, 'dsh-github-push')

  const React = createFakeReact()
  const module = registration.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  })

  assert.equal(module.name, 'github-push')
  assert.deepEqual(module.inject, ['slots'])
  assert.equal(typeof module.apply, 'function')

  const sections = []
  const ctx = {
    effect(fn) {
      return fn()
    },
    slots: {
      inject(name, factory) {
        assert.equal(name, 'settings.section')
        return factory()
      },
      register(config, component) {
        sections.push({ config, component })
        return () => {}
      },
    },
  }
  module.apply(ctx)

  assert.equal(appended.length, 1, '应注入一份样式')
  assert.ok(String(appended[0].textContent).includes('.ghp-card'))

  assert.equal(sections.length, 1)
  assert.equal(sections[0].config.id, 'github')
  assert.equal(sections[0].config.order, 48)
  assert.equal(sections[0].config.label(), 'GitHub')

  const text = renderToText(sections[0].component({}))
  assert.match(text, /GitHub 代码上传/)
  assert.match(text, /Access token/)
  assert.match(text, /保存并测试连接/)
  assert.match(text, /去 GitHub 生成/)
})
