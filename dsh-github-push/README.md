# dsh-github-push

把 DSH 写好的代码直接提交到你的 GitHub 仓库的 DSH 插件。

- **模型侧工具**：`github_push`（上传代码）、`github_status`（自检）、`github_config`（改仓库设置）；
- **设置页**：`设置 → GitHub`，粘贴 token、填 owner/repo、测试连接、看最近推送；
- **不需要本地 git**：直接走 GitHub REST API（blob → tree → commit → ref），手机上也一样用；
- **不只是"上传文件"**：每次推送就是一个正常的 commit，带提交说明和提交链接；
- **仓库不存在可以自动创建**（默认私有），空仓库会自动补一个 README 作为初始提交。

## 安装

插件源码在本机：

```
<DSH_HOME>/plugins/dsh-github-push
```

已经通过 `plugin_manager` 以 `link:` 方式装入 `web` profile。重新安装/更新：

```bash
dsh plugin --profile web add link:/path/to/dsh-github-push
```

插件安装后会即时加载（工具与设置页立刻可用）。**修改插件源码后**需要重启一次 DSH Web
（App 里：设置 → 重启引擎）才会加载新代码。

## 配置

打开 **设置 → GitHub**：

1. **Access token**：点「去 GitHub 生成」，创建一个 **classic token**，勾选 `repo` 权限。
   （要自动创建私有仓库必须是 classic token；fine-grained token 建仓库受账号/组织策略限制。）
2. **Owner / Repo**：例如 `octocat` / `hello-world`。仓库不存在也没关系，默认会自动建。
3. **分支**：留空 = 跟随仓库默认分支。
4. 点「保存并测试连接」，看到账号和仓库信息就配置好了。

token 只保存在本机 `storages/dsh-github-push/config.json`（权限 600），
设置页只显示 `ghp_…abcd` 这样的脱敏提示，任何接口都不会回显明文。
也可以用环境变量 `GITHUB_TOKEN` / `GH_TOKEN` 提供 token（配置文件留空时生效）。

## 用法

配置好之后，直接在对话里说：

> 把这份代码传到 GitHub
> 把 src/ 传到 my-repo 的 app 目录，提交说明写 "feat: 登录页"

模型会调用：

```json
github_push({
  "source": "src",          // 本地文件或目录；相对路径按会话工作目录解析
  "targetDir": "app",       // 可选：仓库内目标目录
  "message": "feat: 登录页", // 可选：不填自动生成
  "branch": "dev",          // 可选：不填用设置里的分支/默认分支
  "createRepo": true        // 可选：不填用设置里的开关
})
```

想检查配置是否可用：

> GitHub 配好了吗？能不能上传？

模型会调用 `github_status`，返回 token 来源、账号、仓库是否存在/可写、默认分支、最近推送。

## 行为细节

| 行为 | 说明 |
| --- | --- |
| 单提交 | 一次 `github_push` 只产生一个 commit（blob/tree/commit/ref 一次完成） |
| 不误删 | 用 `base_tree` 做增量树：只覆盖本次上传的路径，仓库里其他文件原样保留 |
| 无变更不提交 | 上传内容与远端一致时直接返回 `unchanged: true`，不产生空提交 |
| 空仓库 | 自动用 Contents API 写一个 README 作为初始提交，再叠加本次文件 |
| 新分支 | 目标分支不存在时，从默认分支最新提交展开；分支名支持 `feature/x` |
| 默认排除 | `.git`、`node_modules`、`__pycache__`、`.venv`、`.idea`、缓存目录、`.env*` 等 |
| 限额 | 默认 500 个文件、单文件 10 MB、总大小 25 MB（可在配置文件里改） |
| 错误提示 | 401/403/404/422/超时都翻成中文，并说明下一步怎么做 |

排除规则里的单个文件是**不生效**的——显式传一个 `.env` 路径仍然会上传；只有遍历目录时才套用排除规则。

## 安全

- token 只存在本机配置文件（600），不进日志、不进 commit、不通过设置页 API 回显；
- 所有网络请求只发往 `https://api.github.com`（可在配置里改 `apiBase`，用于 GHE）；
- 推送是显式的工具调用，不会在你没要求时自动上传。

## 开发与测试

```bash
cd <DSH_HOME>/plugins/dsh-github-push
node --test tests/*.test.mjs
```

测试用假 GitHub API（`tests/fake-github.mjs`）覆盖：首次推送、空仓库初始化、增量提交、
内容未变化、分支含斜杠、targetDir、排除规则、401、网络失败、设置页 API、工具真实执行。

## 已知限制

- 只做上传（新增/覆盖），不做删除、回滚、拉取；
- 不解析 `.gitignore`，用内置/自定义排除规则代替；
- 不在本地保留 git 历史，每次都是直接对远端建提交；
- 大文件不适合（GitHub 单文件 >100 MB 会拒绝，插件默认 10 MB 就跳过）。

## 结构

```
lib/config.js   配置读写、token 脱敏、最近推送
lib/files.js    文件收集、排除规则、仓库路径校验
lib/github.js   GitHub API 客户端 + 推送编排
lib/index.js    工具注册 + 设置页同源 API
lib/client.js   设置页（手写 __ModuleLoader__ bundle）
tests/          假 GitHub + 单元/集成测试
```
