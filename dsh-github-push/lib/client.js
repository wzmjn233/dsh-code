/**
 * dsh-github-push —— 浏览器半侧（手写 __ModuleLoader__ bundle，无需构建工具）。
 *
 * 在「设置」里注册一个 GitHub 页：填 token / owner / repo / 分支，测试连接，
 * 查看最近推送。与宿主端只走同源 HTTP（/api/github-push/*），不碰 RPC。
 *
 * 这个文件是「手写 bundle」：包在 window.__ModuleLoader__.load 里，只 require
 * 宿主已提供的模块表（react）。改完用 `node --check lib/client.js` 验语法。
 */

window.__ModuleLoader__.load({
  id: 'dsh-github-push',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement

    var API = '/api/github-push'

    // ---- 同源 API ---------------------------------------------------------

    function fetchJson(url, options) {
      return fetch(url, options).then(function (res) {
        return res.text().then(function (text) {
          var data = null
          try {
            data = text === '' ? null : JSON.parse(text)
          } catch (e) {
            data = null
          }
          if (!res.ok) {
            var message = data && data.error ? data.error : 'HTTP ' + res.status
            var error = new Error(message)
            error.status = res.status
            throw error
          }
          return data
        })
      })
    }

    function postJson(path, body) {
      return fetchJson(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
    }

    // ---- 小工具 -----------------------------------------------------------

    function timeLabel(iso) {
      if (typeof iso !== 'string' || iso === '') return '—'
      var date = new Date(iso)
      if (isNaN(date.getTime())) return iso
      var pad = function (value) {
        return value < 10 ? '0' + value : String(value)
      }
      return (
        date.getFullYear() +
        '-' +
        pad(date.getMonth() + 1) +
        '-' +
        pad(date.getDate()) +
        ' ' +
        pad(date.getHours()) +
        ':' +
        pad(date.getMinutes())
      )
    }

    function repoLabel(config) {
      if (!config || !config.owner || !config.repo) return '未设置'
      return config.owner + '/' + config.repo
    }

    function tokenSourceLabel(source) {
      if (source === 'env') return '环境变量'
      if (source === 'config') return '配置文件'
      return '未配置'
    }

    // ---- 页面 -------------------------------------------------------------

    function GitHubSection() {
      var [state, setState] = React.useState(null)
      var [error, setError] = React.useState('')
      var [notice, setNotice] = React.useState('')
      var [busy, setBusy] = React.useState('')
      var [testResult, setTestResult] = React.useState(null)
      var [showToken, setShowToken] = React.useState(false)
      var [form, setForm] = React.useState({
        token: '',
        owner: '',
        repo: '',
        branch: '',
        privateRepo: true,
        autoCreateRepo: true,
      })

      function applyState(data) {
        setState(data)
        setForm({
          token: '',
          owner: (data && data.config && data.config.owner) || '',
          repo: (data && data.config && data.config.repo) || '',
          branch: (data && data.config && data.config.branch) || '',
          privateRepo: !data || !data.config || data.config.privateRepo !== false,
          autoCreateRepo: !data || !data.config || data.config.autoCreateRepo !== false,
        })
      }

      function load() {
        setError('')
        fetchJson(API + '/state')
          .then(function (data) {
            applyState(data)
          })
          .catch(function (err) {
            setError(err && err.message ? err.message : String(err))
          })
      }

      React.useEffect(load, [])

      function update(field, value) {
        setForm(function (prev) {
          var next = {}
          for (var key in prev) next[key] = prev[key]
          next[field] = value
          return next
        })
        setNotice('')
        setError('')
      }

      function save() {
        setBusy('save')
        setError('')
        setNotice('')
        setTestResult(null)
        var body = {
          owner: form.owner.trim(),
          repo: form.repo.trim(),
          branch: form.branch.trim(),
          privateRepo: form.privateRepo,
          autoCreateRepo: form.autoCreateRepo,
        }
        if (form.token.trim() !== '') body.token = form.token.trim()
        return postJson('/save', body)
          .then(function (data) {
            applyState(data)
            setNotice('已保存')
            setBusy('')
            return data
          })
          .catch(function (err) {
            setError(err && err.message ? err.message : String(err))
            setBusy('')
            throw err
          })
      }

      function test() {
        setBusy('test')
        setError('')
        setNotice('')
        setTestResult(null)
        return postJson('/test', {})
          .then(function (data) {
            setTestResult(data)
            setNotice(data && data.message ? data.message : '连接正常')
            setBusy('')
            return data
          })
          .catch(function (err) {
            setError(err && err.message ? err.message : String(err))
            setBusy('')
            throw err
          })
      }

      function saveAndTest() {
        save()
          .then(function () {
            return test()
          })
          .catch(function () {
            // 错误已经在 save/test 里展示
          })
      }

      var hasToken = state !== null && state.token !== null && state.token.configured === true
      var tokenPlaceholder = hasToken
        ? '已保存（' + state.token.hint + '），留空表示不修改'
        : 'ghp_… 或 github_pat_…'
      var disabled = busy !== ''

      return h(
        'div',
        { className: 'ghp' },
        h(
          'div',
          { className: 'ghp-head' },
          h('div', { className: 'ghp-title' }, 'GitHub 代码上传'),
          h(
            'div',
            { className: 'ghp-sub' },
            '配置一次，之后在对话里说「把代码传到 GitHub」，模型就会调用 github_push 工具把文件提交到仓库。',
          ),
        ),
        error !== '' ? h('div', { className: 'ghp-err' }, error) : null,
        notice !== '' ? h('div', { className: 'ghp-ok' }, notice) : null,
        h(
          'div',
          { className: 'ghp-card' },
          h(
            'div',
            { className: 'ghp-field' },
            h(
              'div',
              { className: 'ghp-label-row' },
              h('span', { className: 'ghp-label' }, 'Access token'),
              h(
                'a',
                {
                  className: 'ghp-link',
                  href: 'https://github.com/settings/tokens/new?scopes=repo&description=DSH%20github-push',
                  target: '_blank',
                  rel: 'noreferrer',
                },
                '去 GitHub 生成',
              ),
            ),
            h(
              'div',
              { className: 'ghp-inline' },
              h('input', {
                className: 'ghp-input',
                type: showToken ? 'text' : 'password',
                value: form.token,
                placeholder: tokenPlaceholder,
                autoComplete: 'off',
                spellCheck: false,
                onChange: function (event) {
                  update('token', event.target.value)
                },
              }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ghp-mini',
                  onClick: function () {
                    setShowToken(!showToken)
                  },
                },
                showToken ? '隐藏' : '显示',
              ),
            ),
            h(
              'div',
              { className: 'ghp-hint' },
              '建议用 classic token，勾选 `repo` 权限（要自动建私有仓库也需要它）。token 只保存在本机，不会回显。',
            ),
          ),
          h(
            'div',
            { className: 'ghp-grid' },
            h(
              'div',
              { className: 'ghp-field' },
              h('div', { className: 'ghp-label' }, 'Owner'),
              h('input', {
                className: 'ghp-input',
                value: form.owner,
                placeholder: 'GitHub 用户名或组织名',
                autoComplete: 'off',
                spellCheck: false,
                onChange: function (event) {
                  update('owner', event.target.value)
                },
              }),
            ),
            h(
              'div',
              { className: 'ghp-field' },
              h('div', { className: 'ghp-label' }, 'Repo'),
              h('input', {
                className: 'ghp-input',
                value: form.repo,
                placeholder: '仓库名，例如 my-code',
                autoComplete: 'off',
                spellCheck: false,
                onChange: function (event) {
                  update('repo', event.target.value)
                },
              }),
            ),
            h(
              'div',
              { className: 'ghp-field' },
              h('div', { className: 'ghp-label' }, '分支'),
              h('input', {
                className: 'ghp-input',
                value: form.branch,
                placeholder: '留空 = 仓库默认分支',
                autoComplete: 'off',
                spellCheck: false,
                onChange: function (event) {
                  update('branch', event.target.value)
                },
              }),
            ),
          ),
          h(
            'div',
            { className: 'ghp-switches' },
            h(
              'label',
              { className: 'ghp-switch' },
              h('input', {
                type: 'checkbox',
                checked: form.autoCreateRepo,
                onChange: function (event) {
                  update('autoCreateRepo', event.target.checked)
                },
              }),
              '仓库不存在时自动创建',
            ),
            h(
              'label',
              { className: 'ghp-switch' },
              h('input', {
                type: 'checkbox',
                checked: form.privateRepo,
                onChange: function (event) {
                  update('privateRepo', event.target.checked)
                },
              }),
              '新建仓库设为私有',
            ),
          ),
          h(
            'div',
            { className: 'ghp-actions' },
            h(
              'button',
              { type: 'button', className: 'ghp-btn primary', disabled: disabled, onClick: save },
              busy === 'save' ? '保存中…' : '保存',
            ),
            h(
              'button',
              { type: 'button', className: 'ghp-btn', disabled: disabled, onClick: saveAndTest },
              busy === 'test' ? '测试中…' : '保存并测试连接',
            ),
            h('button', { type: 'button', className: 'ghp-btn ghost', disabled: disabled, onClick: load }, '刷新'),
          ),
        ),
        state !== null
          ? h(
              'div',
              { className: 'ghp-card' },
              h('div', { className: 'ghp-card-title' }, '当前状态'),
              h(
                'div',
                { className: 'ghp-status' },
                h(
                  'div',
                  { className: 'ghp-status-row' },
                  h('span', { className: 'ghp-status-key' }, 'token'),
                  h(
                    'span',
                    { className: hasToken ? 'ghp-status-val ok' : 'ghp-status-val warn' },
                    hasToken
                      ? '已配置 · ' + tokenSourceLabel(state.token.source) + ' · ' + state.token.hint
                      : '未配置',
                  ),
                ),
                h(
                  'div',
                  { className: 'ghp-status-row' },
                  h('span', { className: 'ghp-status-key' }, '仓库'),
                  h(
                    'span',
                    { className: repoLabel(state.config) === '未设置' ? 'ghp-status-val warn' : 'ghp-status-val' },
                    repoLabel(state.config) +
                      (state.config.branch !== '' ? '@' + state.config.branch : ''),
                  ),
                ),
                h(
                  'div',
                  { className: 'ghp-status-row' },
                  h('span', { className: 'ghp-status-key' }, '自动创建'),
                  h(
                    'span',
                    { className: 'ghp-status-val' },
                    state.config.autoCreateRepo ? '开' : '关',
                    ' · ',
                    state.config.privateRepo ? '私有' : '公开',
                  ),
                ),
              ),
              testResult !== null
                ? h(
                    'div',
                    { className: 'ghp-test' },
                    h('div', { className: 'ghp-test-title' }, '连接测试通过'),
                    h('div', { className: 'ghp-test-line' }, '账号：' + (testResult.login || '未知')),
                    h(
                      'div',
                      { className: 'ghp-test-line' },
                      testResult.repo === null
                        ? '仓库：远端不可见（不存在或 token 无权限，推送时会按设置尝试创建）'
                        : '仓库：' +
                            testResult.repo.fullName +
                            '（' +
                            (testResult.repo.private ? '私有' : '公开') +
                            '，默认分支 ' +
                            (testResult.repo.defaultBranch || '未知') +
                            (testResult.repo.canPush ? '，可写' : '，可能没有写权限') +
                            '）',
                    ),
                    testResult.repo !== null && testResult.repo.htmlUrl
                      ? h(
                          'a',
                          { className: 'ghp-link', href: testResult.repo.htmlUrl, target: '_blank', rel: 'noreferrer' },
                          '打开仓库',
                        )
                      : null,
                  )
                : null,
              h('div', { className: 'ghp-card-title', style: { marginTop: '14px' } }, '最近推送'),
              state.config.lastPushes.length === 0
                ? h('div', { className: 'ghp-empty' }, '还没有推送记录。')
                : h(
                    'div',
                    { className: 'ghp-pushes' },
                    state.config.lastPushes.slice(0, 5).map(function (entry, index) {
                      return h(
                        'div',
                        { className: 'ghp-push', key: String(index) + String(entry.at || '') },
                        h(
                          'div',
                          { className: 'ghp-push-main' },
                          timeLabel(entry.at) +
                            ' · ' +
                            String(entry.repo || '') +
                            '@' +
                            String(entry.branch || ''),
                        ),
                        h(
                          'div',
                          { className: 'ghp-push-meta' },
                          String(entry.files || 0) +
                            ' 个文件' +
                            (entry.unchanged
                              ? ' · 无新提交'
                              : entry.commit
                                ? ' · ' + String(entry.commit).slice(0, 7)
                                : ''),
                          entry.url
                            ? h(
                                'a',
                                { className: 'ghp-link', href: String(entry.url), target: '_blank', rel: 'noreferrer' },
                                '  打开提交',
                              )
                            : null,
                        ),
                      )
                    }),
                  ),
              h('div', { className: 'ghp-foot' }, '配置文件：' + state.config.configPath),
            )
          : null,
        h('div', { className: 'ghp-foot' }, '用法：在对话里说「把这份代码传到 GitHub」，模型会调用 github_push（可以在后面加「传到 xxx 目录」）。'),
      )
    }

    /** 错误边界：设置页崩了也要看得见原因，而不是整块白屏。 */
    function GitHubErrorBoundary(props) {
      return h(GitHubBoundaryInner, null, props.children)
    }

    class GitHubBoundaryInner extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error: error }
      }

      componentDidCatch(error, info) {
        if (typeof console !== 'undefined') console.error('[github-push] settings render failed', error, info)
      }

      render() {
        if (this.state.error !== null) {
          var message = this.state.error && this.state.error.message
          return h('div', { className: 'ghp-err' }, 'GitHub 设置页渲染失败：' + String(message || this.state.error))
        }
        return this.props.children
      }
    }

    var CSS = [
      '.ghp{display:flex;flex-direction:column;gap:14px;padding:2px;max-width:100%;box-sizing:border-box;',
      'font-family:var(--dsw-font-family-sans,var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif));',
      'color:var(--dsw-alias-label-primary,#1f1c18);}',
      '.ghp-head{display:flex;flex-direction:column;gap:4px;}',
      '.ghp-title{font-size:15px;font-weight:600;}',
      '.ghp-sub{font-size:12.5px;color:var(--dsw-alias-label-secondary,#6f6558);line-height:1.6;}',
      '.ghp-card{display:flex;flex-direction:column;gap:12px;padding:14px;border-radius:12px;',
      'background:var(--dsw-alias-bg-layer-1,#fffdf8);border:1px solid var(--dsw-alias-border-l1,#ece5d8);}',
      '.ghp-card-title{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-secondary,#6f6558);}',
      '.ghp-field{display:flex;flex-direction:column;gap:6px;min-width:0;}',
      '.ghp-label{font-size:12px;color:var(--dsw-alias-label-secondary,#6f6558);}',
      '.ghp-label-row{display:flex;align-items:center;justify-content:space-between;gap:8px;}',
      '.ghp-inline{display:flex;align-items:center;gap:8px;}',
      '.ghp-input{flex:1 1 auto;min-width:0;font:inherit;font-size:12.5px;padding:7px 10px;border-radius:8px;',
      'border:1px solid var(--dsw-alias-border-l2,#e3daca);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2,#fbf7ef));',
      'color:var(--dsw-alias-label-primary,#1f1c18);outline:none;}',
      '.ghp-input:focus{border-color:var(--dsw-alias-brand-primary,var(--dsw-alias-button-primary-fill,#1f1c18));}',
      '.ghp-mini{flex:0 0 auto;font:inherit;font-size:12px;padding:6px 10px;border-radius:8px;cursor:pointer;',
      'border:1px solid var(--dsw-alias-border-l2,#e3daca);background:transparent;color:var(--dsw-alias-label-secondary,#6f6558);}',
      '.ghp-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-dimmed,#8a7f6e));line-height:1.6;}',
      '.ghp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;}',
      '.ghp-switches{display:flex;flex-wrap:wrap;gap:14px 22px;}',
      '.ghp-switch{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;',
      'color:var(--dsw-alias-label-secondary,#6f6558);cursor:pointer;}',
      '.ghp-switch input{accent-color:var(--dsw-alias-brand-primary,#1f1c18);cursor:pointer;}',
      '.ghp-actions{display:flex;flex-wrap:wrap;gap:8px;}',
      '.ghp-btn{font:inherit;font-size:12.5px;padding:7px 14px;border-radius:8px;cursor:pointer;',
      'border:1px solid var(--dsw-alias-border-l2,#e3daca);background:var(--dsw-alias-bg-layer-2,#f4efe4);',
      'color:var(--dsw-alias-label-primary,#1f1c18);}',
      '.ghp-btn.primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#1f1c18));',
      'border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fffdf8);font-weight:600;}',
      '.ghp-btn.ghost{background:transparent;}',
      '.ghp-btn:disabled{opacity:.55;cursor:default;}',
      '.ghp-err{border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#a83a2c) 35%,transparent);',
      'background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#a83a2c) 10%,transparent);',
      'color:var(--dsw-alias-state-error-primary,#a83a2c);font-size:12px;border-radius:10px;padding:9px 12px;line-height:1.6;white-space:pre-wrap;}',
      '.ghp-ok{border:1px solid color-mix(in srgb,var(--dsw-alias-state-success-primary,#2f6b46) 35%,transparent);',
      'background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2f6b46) 10%,transparent);',
      'color:var(--dsw-alias-state-success-primary,#2f6b46);font-size:12px;border-radius:10px;padding:9px 12px;line-height:1.6;}',
      '.ghp-status{display:flex;flex-direction:column;gap:7px;}',
      '.ghp-status-row{display:flex;gap:10px;align-items:baseline;font-size:12.5px;flex-wrap:wrap;}',
      '.ghp-status-key{color:var(--dsw-alias-label-tertiary,#8a7f6e);flex:0 0 auto;min-width:64px;}',
      '.ghp-status-val{word-break:break-all;}',
      '.ghp-status-val.ok{color:var(--dsw-alias-state-success-primary,#2f6b46);}',
      '.ghp-status-val.warn{color:var(--dsw-alias-state-warn-primary,#8a6a2f);}',
      '.ghp-test{border:1px solid var(--dsw-alias-border-l1,#ece5d8);border-radius:10px;padding:10px 12px;',
      'display:flex;flex-direction:column;gap:5px;background:var(--dsw-alias-bg-layer-2,#f4efe4);}',
      '.ghp-test-title{font-size:12.5px;font-weight:600;color:var(--dsw-alias-state-success-primary,#2f6b46);}',
      '.ghp-test-line{font-size:12px;color:var(--dsw-alias-label-secondary,#6f6558);line-height:1.6;word-break:break-all;}',
      '.ghp-pushes{display:flex;flex-direction:column;gap:8px;}',
      '.ghp-push{display:flex;flex-direction:column;gap:3px;padding:8px 10px;border-radius:8px;',
      'background:var(--dsw-alias-bg-layer-2,#f4efe4);}',
      '.ghp-push-main{font-size:12px;color:var(--dsw-alias-label-primary,#1f1c18);word-break:break-all;}',
      '.ghp-push-meta{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a7f6e);}',
      '.ghp-empty{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a7f6e);}',
      '.ghp-foot{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a7f6e);line-height:1.6;word-break:break-all;}',
      '.ghp-link{color:var(--dsw-alias-brand-primary,#1f1c18);text-decoration:underline;font-size:12px;}',
    ].join('')

    function apply(ctx) {
      ctx.effect(function () {
        var id = 'dsh-github-push-styles'
        if (document.getElementById(id) === null) {
          var style = document.createElement('style')
          style.id = id
          style.textContent = CSS
          document.head.appendChild(style)
        }
        return function () {
          var element = document.getElementById(id)
          if (element !== null && element.parentNode !== null) element.parentNode.removeChild(element)
        }
      }, 'dsh-github-push: styles')

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: 'github',
            order: 48,
            label: function () {
              return 'GitHub'
            },
          },
          function (props) {
            return h(GitHubErrorBoundary, null, h(GitHubSection, props || {}))
          },
        )
      })
    }

    module.exports = {
      name: 'github-push',
      inject: ['slots'],
      apply: apply,
    }
    return module.exports
  },
})
