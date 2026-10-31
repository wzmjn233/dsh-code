# dsh-bili

让 DSH 直接连上 B站：**手机扫码登录**，然后聚合分析观看历史。

## 为什么是扫码登录

手机浏览器读不到 `SESSDATA`（HttpOnly），普通 cookie 里也没有它。
扫码登录走的是官方 passport 流程，会话由 B站 服务端下发，插件自己接收并保存 —— 不依赖任何网页 cookie 提取。

## 工具

| 工具 | 作用 |
|---|---|
| `bili_login` | `action=start` 生成登录链接；`action=check` 查结果 |
| `bili_status` | 登录状态（不含凭据） |
| `bili_report` | 观看历史聚合：花时间最多的 UP、完成度分布、分区排名、**看了很多但没关注的人** |
| `bili_history` | 观看历史明细（含每条看了几秒、完成度%） |
| `bili_lists` | 关注列表 / 收藏夹 |
| `bili_logout` | 清除本机会话 |

## 数据与安全

- 只调用只读 GET 接口：登录、资料、历史、关注、收藏。**没有任何写操作。**
- 凭据只存 `$DSH_HOME/bili/session.json`，权限 `0600`。
- 任何工具返回值里都不含 cookie；异常文本统一脱敏。
- 抓取数据缓存 6 小时（`$DSH_HOME/bili/cache.json`），`bili_report(refresh=true)` 可强制刷新。

## 登录流程

1. `bili_login(action=start)` → 返回一个 `account.bilibili.com/h5/...` 链接
2. 手机上打开该链接，B站 App 接管，点「确认登录」
3. `bili_login(action=check)` → 成功则保存会话并显示昵称

## 安装

```bash
# 本地开发方式（把 <path> 换成你克隆下来的目录）
dsh plugin --profile web add link:<path>/dsh-bili
```

或手工：`profiles/web/package.json` 的 `dependencies` 加 `link:` 条目，`dsh.profile.bundles` 加 `dsh-bili`，重启 DSH。

## 已知限制

- 只覆盖「视频」类历史（`type=archive`），直播/专栏不看。
- 完成度用 `progress/duration` 近似「停留」，这是 B站 唯一暴露的进度数据。
- 未做二维码图形渲染：手机上扫自己屏幕没意义，直接给可点击链接更实用。
