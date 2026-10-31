/**
 * dsh-bili —— 观看历史聚合分析
 *
 * 核心指标：
 *   · 每条 progress/duration = 完成度（真正的「停留」近似）
 *   · 按 UP 主累计观看秒数 = 「你实际在谁身上花时间」
 *   · 排除已关注的 UP = 值得推荐的新 UP
 */

const HOUR = 3600

function hours(sec) { return Math.round((sec / HOUR) * 10) / 10 }

function bucketOf(ratio) {
  if (ratio < 0.1) return 'justOpened'
  if (ratio < 0.5) return 'skimmed'
  if (ratio < 0.9) return 'halfway'
  return 'nearlyDone'
}

const BUCKET_LABEL = {
  justOpened: '刚点开（<10%）',
  skimmed: '浅看（10–50%）',
  halfway: '过半（50–90%）',
  nearlyDone: '基本看完（>90%）',
}

export function analyze({ history = [], followings = [], favorites = [], now = Date.now() } = {}) {
  const withDuration = history.filter((h) => h.duration > 0)
  const totalSeconds = history.reduce((s, h) => s + (h.progress || 0), 0)

  // 完成度分布
  const buckets = { justOpened: 0, skimmed: 0, halfway: 0, nearlyDone: 0 }
  for (const h of withDuration) buckets[bucketOf(h.progress / h.duration)] += 1

  // 按 UP 聚合
  const upMap = new Map()
  for (const h of history) {
    if (!h.author) continue
    const key = String(h.authorMid || h.author)
    const cur = upMap.get(key) || {
      uname: h.author,
      mid: h.authorMid || 0,
      seconds: 0,
      videos: 0,
      finished: 0,
      completionSum: 0,
      lastViewAt: 0,
      tags: new Map(),
    }
    cur.seconds += h.progress || 0
    cur.videos += 1
    if (h.duration > 0) {
      const r = h.progress / h.duration
      cur.completionSum += Math.min(1, r)
      if (r >= 0.9) cur.finished += 1
    }
    cur.lastViewAt = Math.max(cur.lastViewAt, h.viewAt || 0)
    if (h.tag) cur.tags.set(h.tag, (cur.tags.get(h.tag) || 0) + 1)
    upMap.set(key, cur)
  }

  const topUps = [...upMap.values()]
    .map((u) => ({
      uname: u.uname,
      mid: u.mid,
      hours: hours(u.seconds),
      seconds: u.seconds,
      videos: u.videos,
      finished: u.finished,
      avgCompletion: u.videos ? Math.round((u.completionSum / u.videos) * 100) : 0,
      lastViewAt: u.lastViewAt,
      topTag: [...u.tags.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '',
    }))
    .sort((a, b) => b.seconds - a.seconds)

  // 分区聚合
  const tagMap = new Map()
  for (const h of history) {
    if (!h.tag) continue
    const cur = tagMap.get(h.tag) || { tag: h.tag, seconds: 0, videos: 0 }
    cur.seconds += h.progress || 0
    cur.videos += 1
    tagMap.set(h.tag, cur)
  }
  const topTags = [...tagMap.values()]
    .map((t) => ({ tag: t.tag, hours: hours(t.seconds), videos: t.videos }))
    .sort((a, b) => b.hours - a.hours)

  // 已关注集合 → 找「看了很多但还没关注」的 UP
  const followedMids = new Set(followings.map((u) => String(u.mid)))
  const followedNames = new Set(followings.map((u) => u.uname))
  const notFollowed = topUps
    .filter((u) => u.videos >= 2)
    .filter((u) => !(u.mid && followedMids.has(String(u.mid))) && !followedNames.has(u.uname))
    .slice(0, 20)

  // 近期 vs 早期
  const monthAgo = now / 1000 - 30 * 86400
  const recent = history.filter((h) => (h.viewAt || 0) >= monthAgo)
  const older = history.filter((h) => (h.viewAt || 0) < monthAgo)
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((s, h) => s + (h.duration || 0), 0) / arr.length) : 0)
  const shortShare = history.length
    ? Math.round((history.filter((h) => h.duration > 0 && h.duration < 60).length / history.length) * 100)
    : 0

  const summary = {
    videos: history.length,
    totalHours: hours(totalSeconds),
    avgWatchSeconds: history.length ? Math.round(totalSeconds / history.length) : 0,
    finishedRate: withDuration.length
      ? Math.round((withDuration.filter((h) => h.progress / h.duration >= 0.9).length / withDuration.length) * 100)
      : 0,
    buckets: Object.fromEntries(Object.entries(BUCKET_LABEL).map(([k, label]) => [label, buckets[k]])),
    followingsCount: followings.length,
    favoritesCount: favorites.reduce((s, f) => s + (f.items?.length || 0), 0),
    topUps: topUps.slice(0, 25),
    topTags: topTags.slice(0, 12),
    notFollowed,
    recentVideos: recent.length,
    recentAvgDurationSeconds: avg(recent),
    olderAvgDurationSeconds: avg(older),
    shortVideoSharePercent: shortShare,
  }

  return { summary, markdown: renderMarkdown(summary) }
}

function fmtTime(ts) {
  if (!ts) return ''
  return new Date(ts * 1000).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })
}

function renderMarkdown(s) {
  const L = []
  L.push('## 观看数据总览')
  L.push('')
  L.push(`- 历史记录 **${s.videos}** 条，累计约 **${s.totalHours} 小时**`)
  L.push(`- 平均每条看 **${Math.round(s.avgWatchSeconds / 60)} 分钟**，看完率 **${s.finishedRate}%**`)
  L.push(`- 关注 **${s.followingsCount}** 个 UP，收藏 **${s.favoritesCount}** 条`)
  L.push(`- 近期 30 天 **${s.recentVideos}** 条；短视频（<1分钟）占 **${s.shortVideoSharePercent}%**`)
  if (s.olderAvgDurationSeconds) {
    L.push(`- 时长对比：近 30 天平均 ${Math.round(s.recentAvgDurationSeconds / 60)} 分钟 vs 更早 ${Math.round(s.olderAvgDurationSeconds / 60)} 分钟`)
  }
  L.push('')
  L.push('## 完成度分布')
  L.push('')
  L.push('| 区间 | 条数 |')
  L.push('|---|---|')
  for (const [k, v] of Object.entries(s.buckets)) L.push(`| ${k} | ${v} |`)
  L.push('')
  L.push('## 你实际花时间最多的 UP 主')
  L.push('')
  L.push('| UP 主 | 观看时长 | 条数 | 看完 | 平均完成度 | 主要分区 | 最近 |')
  L.push('|---|---|---|---|---|---|---|')
  for (const u of s.topUps) {
    L.push(`| ${u.uname} | ${u.hours}h | ${u.videos} | ${u.finished} | ${u.avgCompletion}% | ${u.topTag || '-'} | ${fmtTime(u.lastViewAt)} |`)
  }
  L.push('')
  L.push('## 内容分区（按时长）')
  L.push('')
  L.push('| 分区 | 时长 | 条数 |')
  L.push('|---|---|---|')
  for (const t of s.topTags) L.push(`| ${t.tag} | ${t.hours}h | ${t.videos} |`)
  L.push('')
  if (s.notFollowed.length) {
    L.push('## 值得关注但还没关注（看了 ≥2 条）')
    L.push('')
    L.push('| UP 主 | 观看时长 | 条数 | 平均完成度 | mid |')
    L.push('|---|---|---|---|---|')
    for (const u of s.notFollowed) {
      L.push(`| ${u.uname} | ${u.hours}h | ${u.videos} | ${u.avgCompletion}% | ${u.mid} |`)
    }
    L.push('')
  }
  return L.join('\n')
}
