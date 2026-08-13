/**
 * Hermes Achievements — desktop plugin (enhanced fork).
 *
 * Fork of asimons81/hermes-desktop-achievements (MIT) by Tony Simons.
 * Extensions on top of the original:
 *   - Unlock notifications: toast + haptic + chime + theme/tier-colored
 *     confetti the moment a new badge lands (poll diff against a persisted
 *     known set), gated by user settings, announced to a Discord webhook.
 *   - Tier-specific sounds: Copper/Silver chime, Gold+ and milestones get a
 *     five-note fanfare.
 *   - Unlock history timeline (recent unlocks with dates and evidence).
 *   - Custom achievements: user-defined personal badges, stored in plugin
 *     storage, celebrated on completion.
 *   - Settings panel: toggles for confetti, sound, haptic, and a Discord
 *     webhook URL.
 *   - "NEW" freshness tag on unlocks from the last 48 hours.
 *   - Search and sort on the grid.
 *   - Weekly mini-stats (unlocks this week, busiest day, tier counts).
 *   - Milestone celebrations at every 10 unlocks.
 *   - Export badges to Markdown or JSON.
 *   - Replay the celebration from any unlocked badge or history entry.
 *   - Smarter statusbar chip tooltip (closest next-up achievement).
 *   - "Next up" strip, per-session context, share cards.
 *
 * Backed by the existing hermes-achievements dashboard plugin API
 * (mounted at /api/plugins/hermes-achievements/). Plain ESM loaded
 * uncompiled: UI is jsx() calls, NOT JSX syntax; only @hermes/plugin-sdk,
 * react, react/jsx-runtime resolve.
 */

import {
  Badge,
  Button,
  cn,
  Codicon,
  EmptyState,
  ErrorState,
  haptic,
  host,
  queryClient,
  relativeTime,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  PALETTE_AREA,
  STATUSBAR_AREAS,
  Skeleton,
  Tip,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useCallback, useEffect, useRef, useState } from 'react'

const ID = 'hermes-achievements'

// Assigned in register(ctx) — components can't see ctx directly.
let rest
let storageRef = null

const TIER_ORDER = ['Copper', 'Silver', 'Gold', 'Diamond', 'Olympian']
const FILTERS = ['badges', 'goals', 'records', 'rewards', 'quests', 'custom', 'history']
// Per-tab accent colors, matching the Command Center colored-tab language:
// each top-level tab carries its own hue, and the active tab becomes a
// solid gradient pill in that hue with white text and a soft glow.
const FILTER_TAB_META = {
  badges: { icon: 'milestone', color: '#7b5fd9' },
  goals: { icon: 'target', color: '#2f9e63' },
  records: { icon: 'history', color: '#2f7fd4' },
  rewards: { icon: 'gift', color: '#b7791f' },
  quests: { icon: 'sparkle', color: '#d4578f' },
  custom: { icon: 'settings', color: '#0f9a9a' },
  history: { icon: 'clock', color: '#8a8f98' }
}
// Badge state sub-filter, shown only inside the Badges tab.
const STATE_FILTERS = ['all', 'unlocked', 'discovered', 'secret']
const UNLOCK_POLL_MS = 15_000

const DEFAULT_SETTINGS = { confetti: true, sound: true, haptic: true, discordWebhook: '', nudges: true }
let _settings = { ...DEFAULT_SETTINGS }

function tierIndex(tier) {
  return tier ? TIER_ORDER.indexOf(tier) : -1
}

function tierBadgeClass(tier) {
  const i = tierIndex(tier)
  if (i < 0) return 'text-(--ui-text-quaternary)'
  if (i >= 4) return 'text-(--ui-accent) font-semibold'
  if (i >= 3) return 'text-(--ui-accent)'
  if (i >= 2) return 'text-(--ui-text-primary)'
  return 'text-(--ui-text-secondary)'
}

function stateBadgeClass(state) {
  if (state === 'unlocked') return 'bg-(--ui-accent-muted) text-(--ui-accent)'
  if (state === 'secret') return 'text-(--ui-text-quaternary)'
  return 'text-(--ui-text-tertiary)'
}

// ── Responsive card columns ─────────────────────────────────────────────────
// Every card strip (Next Up, Recent, grid, Rewards, Records, Goals, Quests)
// must adapt its columns to the ACTUAL SPACE AVAILABLE — not just the window
// width. Users run Hermes across monitors of every size and resolution
// (retina 2x, 4K, ultrawide, small laptops) and with different sidebar/gutter
// widths, so the column count is measured from the card container itself via
// ResizeObserver. That one measurement absorbs: window resizes, monitor size
// and DPI (CSS px are resolution-normalized), sidebar width, preview gutter,
// and zoom. Breakpoints on the container width keep every strip on the same
// rhythm so rows stay aligned with each other at any size.
const COLS_BY_WIDTH = [
  [2000, 6],
  [1500, 5],
  [1200, 4],
  [900, 3],
  [0, 2]
]

function _colsForWidth(w) {
  for (const [min, cols] of COLS_BY_WIDTH) {
    if (w >= min) return cols
  }
  return 2
}

// Returns [ref, cols]. Attach ref to the strip's flex container; cols is the
// column count for that container's measured width. Falls back to
// window.innerWidth when the element isn't mounted yet (early-return strips).
function useCardCols() {
  const [cols, setCols] = useState(() =>
    typeof window !== 'undefined' ? _colsForWidth(window.innerWidth) : 6
  )
  const ref = useRef(null)

  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') {
      // Fallback: no element or no RO support — use window size.
      const onResize = () => setCols(_colsForWidth(window.innerWidth))
      window.addEventListener('resize', onResize)
      return () => window.removeEventListener('resize', onResize)
    }
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        setCols(_colsForWidth(entry.contentRect.width))
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return [ref, cols]
}

// Width for one card in a flex row of `cols` columns separated by `gap` px.
function cardWidth(cols, gap = 8) {
  return `calc((100% - ${(cols - 1) * gap}px) / ${cols})`
}


function progressBarClass(state) {
  if (state === 'unlocked') return 'bg-(--ui-accent)'
  return 'bg-(--ui-text-tertiary)'
}

// Tier identity colors for progress bars and next-tier chips. Distinct hues
// so the grid adds another layer of scanning (Copper → Olympian).
const TIER_HUES = { Copper: 28, Silver: 210, Gold: 45, Diamond: 190, Olympian: 265 }
const TIER_HEX = { Copper: '#b07a3a', Silver: '#7a93b0', Gold: '#b8930a', Diamond: '#1f9d8f', Olympian: '#7a5fb0' }
// Darker tier text shades: pass ~7:1 on the light pastel fills while keeping
// the tier hue. tierBadgeClass alone maps Copper to text-quaternary (too
// faint to read), so tier labels use these instead.
const TIER_TEXT = {
  Copper: '#8a5f2e',
  Silver: '#5e7489',
  Gold: '#8a6d00',
  Diamond: '#0f6f63',
  Olympian: '#5c47a8'
}
function tierTextColor(tier) {
  return TIER_TEXT[tier] || 'var(--ui-text-tertiary)'
}

function tierColor(tier) {
  return TIER_HEX[tier] || null
}

function tierProgressStyle(state, tier) {
  if (state === 'unlocked') return { backgroundColor: 'var(--ui-accent)' }
  const c = tierColor(tier)
  if (c) return { backgroundColor: c }
  return { backgroundColor: 'var(--ui-text-tertiary)' }
}

// Category identity colors. Each category gets a hue so the grid reads as a
// patchwork instead of a wall of identical boxes. Colors are used as:
//   - a 3px left border on every card (categoryColor(cat) → border style)
//   - a soft tinted card background (categoryBg(cat) → rgba fill)
//   - the milestone icon color (text)
// Values stay close to the app's neutral palette but separated per hue.
const CATEGORY_COLORS = {
  'Agent Autonomy': 'hsl(250 55% 58%)',   // violet
  'Debugging Chaos': 'hsl(15 75% 55%)',   // ember orange
  'Hermes Native': 'hsl(205 85% 55%)',    // sky blue
  'Lifestyle': 'hsl(150 55% 45%)',        // green
  'Model Lore': 'hsl(330 70% 55%)',       // magenta
  'Research/Web': 'hsl(275 60% 55%)',     // purple
  'Sets': 'hsl(45 90% 50%)',              // gold
  'Tool Mastery': 'hsl(190 70% 48%)',     // teal
  'Vibe Coding': 'hsl(0 70% 60%)'         // coral red
}
const DEFAULT_CATEGORY_COLOR = 'hsl(220 15% 55%)'

function categoryColor(cat) {
  return CATEGORY_COLORS[cat] || DEFAULT_CATEGORY_COLOR
}

// Soft background tint from a category hue (10% alpha fill).
// hsl(250 55% 58%) → hsl(250 55% 58% / 0.09) via the slash-alpha syntax.
function categoryBg(cat) {
  return categoryColor(cat).replace(')', ' / 0.09)')
}

// Tinted icon color (full alpha).
function categoryIcon(cat) {
  return categoryColor(cat)
}

// ── Celebration: chime + haptic + confetti (settings-gated) ────────────────

let _audioCtx = null

function playChime() {
  try {
    _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)()
    const ctx = _audioCtx
    const now = ctx.currentTime
    ;[660, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      const t = now + i * 0.12
      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14)
      osc.connect(gain).connect(ctx.destination)
      osc.start(t)
      osc.stop(t + 0.16)
    })
  } catch (e) {
    /* audio unavailable — ignore */
  }
}

function playFanfare() {
  try {
    _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)()
    const ctx = _audioCtx
    const now = ctx.currentTime
    ;[523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'triangle'
      osc.frequency.value = freq
      const t = now + i * 0.14
      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.exponentialRampToValueAtTime(0.3, t + 0.03)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2)
      osc.connect(gain).connect(ctx.destination)
      osc.start(t)
      osc.stop(t + 0.22)
    })
  } catch (e) {
    /* audio unavailable — ignore */
  }
}

function postToWebhook(text) {
  const url = _settings.discordWebhook
  if (!url || !/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(url)) return
  try {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text })
    }).catch(() => {})
  } catch (e) {
    /* ignore */
  }
}

function lighten(hex, amt) {
  try {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex))
    if (!m) return hex
    const n = parseInt(m[1], 16)
    const f = c => Math.max(0, Math.min(255, Math.round(c + 255 * amt)))
    const r = f((n >> 16) & 255)
    const g = f((n >> 8) & 255)
    const b = f(n & 255)
    return `rgb(${r},${g},${b})`
  } catch (e) {
    return hex
  }
}

let _confettiCanvas = null
let _confettiRaf = null

const TIER_COLORS = {
  Copper: '#cd7f32',
  Silver: '#c0c0c0',
  Gold: '#ffd700',
  Diamond: '#a5e8ff',
  Olympian: '#c084fc'
}

function drawStar(ctx, cx, cy, spikes, outer, inner) {
  ctx.beginPath()
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? outer : inner
    const ang = (i * Math.PI) / spikes - Math.PI / 2
    const x = cx + Math.cos(ang) * r
    const y = cy + Math.sin(ang) * r
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
}

function spawnConfetti(a, opts) {
  try {
    if (_confettiCanvas) return // one burst at a time
    const isMilestone = !!(opts && opts.milestone)
    const canvas = document.createElement('canvas')
    canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9999'
    canvas.width = window.innerWidth * window.devicePixelRatio
    canvas.height = window.innerHeight * window.devicePixelRatio
    document.body.appendChild(canvas)
    const ctx = canvas.getContext('2d')
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio)

    const cs = getComputedStyle(document.body)
    const get = v => cs.getPropertyValue(v).trim() || null
    const accent = get('--ui-accent') || '#7B2D8E'
    const tier = (a && a.tier) || null
    const tierColor = (tier && TIER_COLORS[tier]) || null
    // Theme accent family + the achievement's tier color + neutrals.
    const base = [
      accent,
      lighten(accent, 0.35),
      lighten(accent, -0.25)
    ]
    if (tierColor) base.push(tierColor, lighten(tierColor, 0.3))
    base.push(get('--ui-text-primary') || '#ffffff', get('--ui-text-secondary') || '#b0b0b0')

    const W = window.innerWidth
    const H = window.innerHeight
    const SHAPES = ['rect', 'rect', 'rect', 'circle', 'triangle', 'star']
    const count = isMilestone
      ? 260 + Math.floor(Math.random() * 60)
      : 120 + Math.floor(Math.random() * 80)
    const DURATION = isMilestone ? 5000 : 3200
    const wind = (Math.random() - 0.5) * 1.4
    const parts = Array.from({ length: count }, () => {
      const color =
        Math.random() < (isMilestone ? 0.4 : 0.25)
          ? `hsl(${Math.floor(Math.random() * 360)}, 85%, 62%)`
          : base[(Math.random() * base.length) | 0]
      return {
        x: W * (0.1 + Math.random() * 0.8),
        y: -20 - Math.random() * H * 0.5,
        w: 5 + Math.random() * 7,
        h: 9 + Math.random() * 9,
        vx: (Math.random() - 0.5) * 2.6 + wind,
        vy: 2.0 + Math.random() * 3.8,
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 0.3,
        color,
        shape: SHAPES[(Math.random() * SHAPES.length) | 0],
        sway: Math.random() * Math.PI * 2,
        swaySpeed: 0.02 + Math.random() * 0.05
      }
    })

    const start = performance.now()

    const drawShape = p => {
      if (p.shape === 'circle') {
        ctx.beginPath()
        ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2)
        ctx.fill()
      } else if (p.shape === 'triangle') {
        ctx.beginPath()
        ctx.moveTo(0, -p.h / 2)
        ctx.lineTo(p.w / 2, p.h / 2)
        ctx.lineTo(-p.w / 2, p.h / 2)
        ctx.closePath()
        ctx.fill()
      } else if (p.shape === 'star') {
        drawStar(ctx, 0, 0, 5, p.w / 1.4, p.w / 3.1)
        ctx.fill()
      } else {
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h)
      }
    }

    const tick = now => {
      const elapsed = now - start
      const t = Math.min(1, elapsed / DURATION)
      ctx.clearRect(0, 0, W, H)
      ctx.globalAlpha = 1 - t * t
      for (const p of parts) {
        p.sway += p.swaySpeed
        p.x += p.vx + Math.sin(p.sway) * 0.9
        p.y += p.vy
        p.rot += p.vr
        ctx.save()
        ctx.translate(p.x, p.y)
        ctx.rotate(p.rot)
        ctx.fillStyle = p.color
        drawShape(p)
        ctx.restore()
      }
      if (t < 1) {
        _confettiRaf = requestAnimationFrame(tick)
      } else {
        ctx.clearRect(0, 0, W, H)
        canvas.remove()
        _confettiCanvas = null
        _confettiRaf = null
      }
    }

    _confettiCanvas = canvas
    _confettiRaf = requestAnimationFrame(tick)
  } catch (e) {
    /* confetti unavailable — ignore */
  }
}

function celebrate(a, opts) {
  const s = _settings
  if (s.haptic) {
    try {
      haptic('tap')
    } catch (e) {
      /* ignore */
    }
  }
  if (s.sound) {
    const isMilestone = !!(opts && opts.milestone)
    const tier = a && a.tier
    if (isMilestone || tier === 'Gold' || tier === 'Diamond' || tier === 'Olympian') playFanfare()
    else playChime()
  }
  if (s.confetti) spawnConfetti(a, opts)
}

// ── Unlock watcher ─────────────────────────────────────────────────────────

let _known = new Map() // id -> { id, name, tier, unlocked_at }
let _baselineSet = false
let _watcherTimer = null
let _lastTotal = null

// Reward unlock moments: the rewards strip is passive until the watcher
// notices a reward flip (locked → unlocked), then celebrates loudly and
// offers to install the theme right away.
let _knownRewards = new Map() // id -> { id, unlocked }
let _rewardsBaseline = false

function celebrateRewardUnlock(r) {
  celebrate({ name: r.name, tier: 'Diamond' }, { milestone: true })
  host.notify({
    kind: 'success',
    message: `🎁 Reward unlocked: ${r.name}! Install it in the Rewards strip or from Appearance.`
  })
  postToWebhook(`🎁 Reward unlocked: ${r.name}!`)
}

function trackRewards(rewards, ctx) {
  if (!rewards || rewards.length === 0) return
  const current = new Map(rewards.map(r => [r.id, r.unlocked]))
  if (!_rewardsBaseline) {
    _knownRewards = current
    _rewardsBaseline = true
    return
  }
  for (const [id, unlocked] of current) {
    const was = _knownRewards.get(id)
    if (was === false && unlocked === true) {
      const r = rewards.find(x => x.id === id)
      if (r) celebrateRewardUnlock(r)
    }
    _knownRewards.set(id, unlocked)
  }
}

// Quest + custom-goal completion moments: same flip detection as rewards.
let _knownQuests = new Map()
let _questsBaseline = false
let _knownGoals = new Map()
let _goalsBaseline = false

function celebrateQuestComplete(q) {
  celebrate({ name: q.name, tier: 'Gold' }, { milestone: true })
  host.notify({ kind: 'success', message: `🎯 Quest complete: ${q.name} (+${q.xp} XP)!` })
  postToWebhook(`🎯 Quest complete: ${q.name} (+${q.xp} XP)!`)
}

function celebrateGoalComplete(g) {
  celebrate({ name: g.name, tier: 'Silver' }, {})
  host.notify({ kind: 'success', message: `✅ Goal complete: ${g.name}!` })
}

function trackQuests(quests) {
  if (!quests || quests.length === 0) return
  const current = new Map(quests.map(q => [q.id, q.done]))
  if (!_questsBaseline) {
    _knownQuests = current
    _questsBaseline = true
    return
  }
  for (const [id, done] of current) {
    const was = _knownQuests.get(id)
    if (was === false && done === true) {
      const q = quests.find(x => x.id === id)
      if (q) celebrateQuestComplete(q)
    }
    _knownQuests.set(id, done)
  }
}

function trackGoals(goals) {
  if (!goals || goals.length === 0) return
  const current = new Map(goals.map(g => [g.id, g.done]))
  if (!_goalsBaseline) {
    _knownGoals = current
    _goalsBaseline = true
    return
  }
  for (const [id, done] of current) {
    const was = _knownGoals.get(id)
    if (was === false && done === true) {
      const g = goals.find(x => x.id === id)
      if (g) celebrateGoalComplete(g)
    }
    _knownGoals.set(id, done)
  }
}

// Session-end recap: unlocks are grouped into "session windows" separated by
// an idle gap. When a window closes (no new unlocks for SESSION_WINDOW_IDLE_MS)
// a recap toast summarizes what the session earned.
const SESSION_WINDOW_IDLE_MS = 20 * 60 * 1000
let _sessionUnlocks = [] // { name, tier, kind }
let _sessionLastUnlock = 0
let _sessionRecapShown = false

function noteSessionUnlock(a) {
  _sessionUnlocks.push({ name: a.name, tier: a.tier, kind: a.kind })
  _sessionLastUnlock = Date.now()
  _sessionRecapShown = false
}

function maybeShowSessionRecap() {
  if (_sessionUnlocks.length === 0 || _sessionRecapShown) return
  if (Date.now() - _sessionLastUnlock < SESSION_WINDOW_IDLE_MS) return
  const count = _sessionUnlocks.length
  const sets = _sessionUnlocks.filter(u => u.kind === 'collection').length
  const tiers = _sessionUnlocks.filter(u => u.tier).length
  const bits = []
  if (sets) bits.push(`${sets} set${sets === 1 ? '' : 's'}`)
  if (tiers) bits.push(`${tiers} tier${tiers === 1 ? '' : 's'}`)
  const detail = bits.length ? ` — ${bits.join(', ')}` : ''
  host.notify({ kind: 'success', message: `Session recap: ${count} unlock${count === 1 ? '' : 's'}${detail}. Nice run.` })
  _sessionRecapShown = true
}

setInterval(() => maybeShowSessionRecap(), 30_000)

// Nudge notifications: when a locked achievement passes NUDGE_PCT progress,
// whisper it once (per app load, per achievement).
const NUDGE_PCT = 90
let _nudged = new Set()

function nudgeIfClose(a) {
  if (!_settings.nudges) return
  if (a.unlocked || a.state === 'secret') return
  if (_nudged.has(a.id)) return
  if ((a.progress_pct ?? 0) < NUDGE_PCT) return
  _nudged.add(a.id)
  const target = a.next_threshold ? ` — ${a.next_threshold - (a.progress || 0)} to go` : ''
  host.notify({ kind: 'info', message: `Almost there: ${a.name} is at ${a.progress_pct}%${target}` })
}

function notifyUnlock(a) {
  // Set-collection completions are bigger moments: full fanfare + milestone
  // confetti, plus a distinct message.
  const isSet = a && a.kind === 'collection'
  celebrate(a, isSet ? { milestone: true } : undefined)
  const tier = a.tier ? ` [${a.tier}]` : ''
  const prefix = isSet ? '🏅 Set complete: ' : 'Achievement unlocked: '
  host.notify({ kind: 'success', message: `${prefix}${a.name}${tier}` })
  postToWebhook(`${isSet ? '🏅 Set complete: ' : '🏆 Achievement unlocked: '}${a.name}${tier}`)
}

async function refreshUnlocks(ctx) {
  try {
    const data = await ctx.rest('/achievements', { timeoutMs: 8000 })
    const unlocked = (data?.achievements || []).filter(a => a.unlocked)
    const totalNow = unlocked.length

    if (!_baselineSet) {
      // First fetch: seed from storage so restarts don't re-toast old unlocks.
      let stored = []
      try {
        stored = (await ctx.storage.get('knownUnlocks')) || []
      } catch (e) {
        /* storage unavailable — treat as empty */
      }
      _known = new Map(stored.map(s => [s.id, s]))
      for (const a of unlocked) {
        if (!_known.has(a.id)) {
          _known.set(a.id, { id: a.id, name: a.name, tier: a.tier || null, unlocked_at: a.unlocked_at || Date.now() / 1000 })
        }
      }
      _baselineSet = true
      _lastTotal = totalNow
      try {
        await ctx.storage.set('knownUnlocks', Array.from(_known.values()))
      } catch (e) {
        /* ignore */
      }
      return
    }

    let changed = false
    for (const a of unlocked) {
      if (!_known.has(a.id)) {
        _known.set(a.id, { id: a.id, name: a.name, tier: a.tier || null, unlocked_at: a.unlocked_at || Date.now() / 1000 })
        noteSessionUnlock(a)
        notifyUnlock(a)
        changed = true
      }
    }

    // Milestone: crossing a multiple of 10 unlocks gets a bigger party.
    if (_lastTotal !== null && totalNow > _lastTotal && totalNow % 10 === 0) {
      celebrate({ name: `${totalNow} achievements`, tier: null }, { milestone: true })
      host.notify({ kind: 'success', message: `Milestone: ${totalNow} achievements unlocked!` })
      postToWebhook(`🎉 Milestone: ${totalNow} achievements unlocked!`)
    }
    _lastTotal = totalNow

    // Reward flips (locked → unlocked) get their own celebration.
    trackRewards(data?.rewards, ctx)

    // Quest + custom-goal completion moments.
    trackQuests(data?.quests)
    trackGoals(data?.custom_goals)

    // Nudge: locked achievements ≥90% whisper once.
    if (_settings.nudges) {
      const locked = (data?.achievements || []).filter(a => !a.unlocked)
      for (const a of locked) nudgeIfClose(a)
    }

    if (changed) {
      try {
        await ctx.storage.set('knownUnlocks', Array.from(_known.values()))
        await queryClient.invalidateQueries({ queryKey: ['hermes-achievements'] })
      } catch (e) {
        /* ignore */
      }
    }
  } catch (e) {
    /* transient — next tick retries */
  }
}

function startUnlockWatcher(ctx) {
  if (_watcherTimer) clearInterval(_watcherTimer)
  refreshUnlocks(ctx)
  _watcherTimer = setInterval(() => refreshUnlocks(ctx), UNLOCK_POLL_MS)
}

// ── Custom achievements ─────────────────────────────────────────────────────

function useCustomAchievements() {
  const [items, setItems] = useState(null)

  const refresh = useCallback(() => {
    let mounted = true
    ;(async () => {
      try {
        const stored = (await storageRef.get('customAchievements')) || []
        if (mounted) setItems(stored)
      } catch (e) {
        if (mounted) setItems([])
      }
    })()
    return () => {
      mounted = false
    }
  }, [])

  useEffect(refresh, [refresh])

  const persist = async next => {
    setItems(next)
    try {
      await storageRef.set('customAchievements', next)
    } catch (e) {
      /* ignore */
    }
  }

  const add = async (name, description) => {
    if (!name || !name.trim()) return
    const item = {
      id: 'custom-' + Date.now(),
      name: name.trim(),
      description: (description || '').trim(),
      completed: false,
      completedAt: null
    }
    await persist([...(items || []), item])
  }

  const remove = async id => {
    await persist((items || []).filter(i => i.id !== id))
  }

  const complete = async item => {
    await persist(
      (items || []).map(i => (i.id === item.id ? { ...i, completed: true, completedAt: Date.now() } : i))
    )
    celebrate({ name: item.name, tier: null })
    host.notify({ kind: 'success', message: `Custom achievement: ${item.name}` })
  }

  return { items: items || [], add, remove, complete }
}

function CustomTab() {
  const { items, add, remove, complete } = useCustomAchievements()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')

  const submitAdd = async () => {
    await add(name, desc)
    setName('')
    setDesc('')
    setAdding(false)
  }

  return jsxs('div', {
    className: 'flex h-full min-h-0 flex-col overflow-y-auto p-6',
    children: [
      jsxs('div', {
        className: 'mb-4 flex items-center justify-between gap-3',
        children: [
          jsx('div', {
            className: 'text-sm text-(--ui-text-tertiary)',
            children: `Your own badges (${items.length}) — make Hermes reward the things you care about.`
          }),
          jsx(Button, {
            variant: 'secondary',
            size: 'sm',
            onClick: () => setAdding(a => !a),
            children: adding ? 'Cancel' : 'Add custom'
          })
        ]
      }),
      adding
        ? jsxs('div', {
            className: 'mb-4 flex flex-col gap-2 rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) p-4',
            children: [
              jsx('input', {
                className:
                  'rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-primary) px-2.5 py-1.5 text-sm outline-none focus:border-(--ui-accent)',
                placeholder: 'Achievement name, e.g. Posted 10 days straight',
                value: name,
                onChange: e => setName(e.target.value),
                onKeyDown: e => {
                  if (e.key === 'Enter') submitAdd()
                }
              }),
              jsx('input', {
                className:
                  'rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-primary) px-2.5 py-1.5 text-sm outline-none focus:border-(--ui-accent)',
                placeholder: 'Description (optional)',
                value: desc,
                onChange: e => setDesc(e.target.value),
                onKeyDown: e => {
                  if (e.key === 'Enter') submitAdd()
                }
              }),
              jsx('div', {
                className: 'flex justify-end',
                children: jsx(Button, { variant: 'primary', size: 'sm', onClick: submitAdd, children: 'Add' })
              })
            ]
          })
        : null,
      items.length === 0
        ? jsx(EmptyState, {
            title: 'No custom achievements',
            description: 'Define your own badges and celebrate what matters to you.'
          })
        : jsxs('div', {
            className: 'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3',
            children: items.map(item =>
              jsxs('div', {
                key: item.id,
                className: cn(
                  'flex flex-col rounded-lg border p-4',
                  item.completed
                    ? 'border-(--ui-stroke-strong) bg-(--ui-bg-tertiary)'
                    : 'border-(--ui-stroke-secondary) bg-(--ui-bg-secondary)'
                ),
                children: [
                  jsxs('div', {
                    className: 'flex items-start justify-between gap-2',
                    children: [
                      jsxs('div', {
                        className: 'flex min-w-0 items-center gap-2',
                        children: [
                          jsx(Codicon, {
                            name: 'sparkle',
                            className: cn('shrink-0', item.completed ? 'text-(--ui-accent)' : 'text-(--ui-text-tertiary)')
                          }),
                          jsx('span', { className: 'truncate text-sm font-medium', children: item.name })
                        ]
                      }),
                      jsx(Badge, {
                        variant: 'outline',
                        className: 'shrink-0 text-[0.6875rem] text-(--ui-text-tertiary)',
                        children: 'Custom'
                      })
                    ]
                  }),
                  item.description
                    ? jsx('p', {
                        className: 'mt-2 line-clamp-2 text-xs leading-relaxed text-(--ui-text-tertiary)',
                        children: item.description
                      })
                    : null,
                  jsxs('div', {
                    className: 'mt-3 flex items-center justify-between gap-2',
                    children: [
                      jsx('span', {
                        className: 'text-[0.6875rem] text-(--ui-text-tertiary)',
                        children: item.completed ? 'Done' : 'Not done yet'
                      }),
                      jsxs('div', {
                        className: 'flex items-center gap-1.5',
                        children: [
                          !item.completed
                            ? jsx(Button, {
                                variant: 'secondary',
                                size: 'sm',
                                onClick: () => complete(item),
                                children: 'Mark done'
                              })
                            : null,
                          jsx('button', {
                            type: 'button',
                            onClick: () => remove(item.id),
                            className:
                              'inline-flex items-center rounded-md border border-(--ui-stroke-secondary) px-1.5 py-0.5 text-[0.6875rem] text-(--ui-text-tertiary) transition-colors hover:text-(--ui-text-primary)',
                            children: 'Delete'
                          })
                        ]
                      })
                    ]
                  })
                ]
              })
            )
          })
    ]
  })
}

// ── Recent achievements (main dashboard) ───────────────────────────────────

// Compact colorful strip of the latest unlocks on the main Badges view.
// Renders the SAME AchievementCard used in the grid below, so the row
// looks identical to the cards under it — same height, same density,
// same 6-column rhythm.
function RecentAchievements() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['hermes-achievements', 'recent'],
    queryFn: () => rest('/recent-unlocks'),
    refetchInterval: 120_000
  })

  const items = (Array.isArray(data) ? data : []).slice(0, 6)
  const [ref, cols] = useCardCols()
  if (isLoading) {
    return jsx('div', {
      ref,
      className: 'flex flex-wrap gap-2 px-6 py-2.5',
      children: Array.from({ length: cols }, () => jsx(Skeleton, { className: 'h-24 rounded-lg', style: { width: cardWidth(cols) } }))
    })
  }
  if (isError || items.length === 0) return null

  return jsx(Section, {
    id: 'recent',
    title: 'Recent achievements',
    extra: 'latest unlocks',
    color: 'hsl(265 70% 55%)',
    children: jsxs('div', {
      ref,
      className: 'flex flex-wrap gap-2 px-6 py-2.5',
      children: items.map((a, i) => {
        // Shape the recent-unlock row into the same item AchievementCard
        // consumes (the grid below), with unlocked_at preserved so the
        // NEW badge and relative time render.
        const item = {
          id: a.id || `recent-${i}`,
          name: a.name || a.id || 'Achievement',
          category: a.category || '',
          tier: a.tier || null,
          state: a.state || 'unlocked',
          unlocked: true,
          unlocked_at: a.unlocked_at,
          description: a.description || 'Recently unlocked achievement.',
          criteria: a.criteria || '',
          progress_pct: 100,
          next_tier: null,
          next_threshold: null
        }
        return jsx('div', {
          key: item.id,
          className: 'relative',
          style: { width: cardWidth(cols), animationDelay: `${i * 35}ms` },
          children: jsx(AchievementCard, { item, showPin: false })
        })
      })
    })
  })
}



function HistoryTab() {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['hermes-achievements', 'recent'],
    queryFn: () => rest('/recent-unlocks'),
    refetchInterval: 120_000
  })

  if (isLoading) {
    return jsx('div', {
      className: 'flex h-full flex-col gap-3 overflow-y-auto p-6',
      children: Array.from({ length: 8 }, () => jsx(Skeleton, { className: 'h-12 w-full rounded-lg' }))
    })
  }

  if (isError || !data) {
    return jsx(ErrorState, {
      title: 'Could not load unlock history',
      description: `${error?.message ?? 'Unknown error'}`,
      children: jsx(Button, { variant: 'secondary', onClick: () => refetch(), children: 'Retry' })
    })
  }

  const items = Array.isArray(data) ? data : []

  if (items.length === 0) {
    return jsx(EmptyState, {
      title: 'Nothing unlocked yet',
      description: 'Your unlock history will appear here as you earn badges.'
    })
  }

  // Group unlocks by relative day so a long history scans quickly.
  const now = Date.now()
  const groups = { Today: [], Yesterday: [], Earlier: [] }
  for (const a of items) {
    const age = a.unlocked_at ? now - a.unlocked_at * 1000 : Infinity
    if (age < 24 * 3600 * 1000) groups.Today.push(a)
    else if (age < 48 * 3600 * 1000) groups.Yesterday.push(a)
    else groups.Earlier.push(a)
  }
  const groupEntries = Object.entries(groups).filter(([, list]) => list.length > 0)
  const [gridRef, cols] = useCardCols()

  const tierChip = t => {
    const c = tierColor(t)
    if (!c) return null
    return jsx('span', {
      className: 'rounded-full px-1.5 py-0.5 text-[0.625rem] font-medium tabular-nums',
      style: { backgroundColor: `color-mix(in srgb, ${c} 12%, transparent)`, color: c },
      children: t
    })
  }

  return jsxs('div', {
    ref: gridRef,
    className: 'flex-1 overflow-y-auto p-6',
    children: groupEntries.map(([label, list]) =>
      jsxs('div', {
        key: label,
        className: 'mb-3',
        children: [
          jsx('div', {
            className: 'mb-1.5 flex items-center gap-2 px-1 text-[0.625rem] font-semibold uppercase tracking-wide',
            style: { color: 'var(--ui-text-secondary)' },
            children: [
              jsx('span', { className: 'h-1.5 w-1.5 rounded-full', style: { backgroundColor: 'var(--ui-accent)' } }),
              label
            ]
          }),
          jsxs('div', {
            className: 'flex flex-wrap gap-2',
            style: { display: 'flex', flexWrap: 'wrap' },
            children: list.map(a =>
              jsx('div', {
                key: a.id,
                className: 'relative',
                style: { width: cardWidth(cols) },
                children: jsxs('div', {
                  className: 'flex flex-col rounded-lg border border-(--ui-stroke-secondary) p-2.5',
                  style: {
                    borderLeft: `3px solid ${categoryColor(a.category)}`,
                    backgroundColor: categoryBg(a.category)
                  },
                  children: [
                    jsxs('div', {
                      className: 'flex items-start justify-between gap-1.5',
                      children: [
                        jsx('span', { className: 'min-w-0 truncate text-[0.8125rem] font-medium', children: a.name }),
                        jsx('button', {
                          type: 'button',
                          onClick: () => celebrate({ name: a.name, tier: a.tier }, {}),
                          className:
                            'inline-flex shrink-0 items-center gap-0.5 rounded-md border border-(--ui-stroke-secondary) px-1 py-0.5 text-[0.625rem] transition-colors hover:text-(--ui-text-primary)',
                          style: { color: 'var(--ui-text-secondary)' },
                          children: jsxs('span', {
                            className: 'inline-flex items-center gap-0.5',
                            children: [jsx(Codicon, { name: 'play', size: '0.625rem' }), 'Replay']
                          })
                        })
                      ]
                    }),
                    jsxs('div', {
                      className: 'mt-1 flex flex-wrap items-center gap-1.5',
                      children: [
                        a.tier ? tierChip(a.tier) : null,
                        jsx('span', {
                          className: 'text-[0.625rem] tabular-nums',
                          style: { color: 'var(--ui-text-secondary)' },
                          children: a.unlocked_at ? relativeTime(a.unlocked_at * 1000) : ''
                        })
                      ]
                    }),
                    a.evidence && a.evidence.title
                      ? jsx('div', {
                          className: 'mt-1 truncate text-[0.625rem]',
                          style: { color: 'var(--ui-text-secondary)' },
                          children: a.evidence.title
                        })
                      : null
                  ]
                })
              })
            )
          })
        ]
      })
    )
  })
}

// ── Settings panel ──────────────────────────────────────────────────────────

function ToggleRow({ label, desc, value, onChange }) {
  return jsxs('div', {
    className: 'flex items-center justify-between gap-4 py-2',
    children: [
      jsxs('div', {
        children: [
          jsx('div', { className: 'text-sm font-medium', children: label }),
          desc ? jsx('div', { className: 'text-xs text-(--ui-text-tertiary)', children: desc }) : null
        ]
      }),
      jsx('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': value,
        onClick: () => onChange(!value),
        className: cn(
          'relative h-5 w-9 shrink-0 rounded-full transition-colors',
          value ? 'bg-(--ui-accent)' : 'bg-(--ui-bg-quaternary)'
        ),
        children: jsx('span', {
          className: cn(
            'absolute top-0.5 h-4 w-4 rounded-full bg-(--ui-text-primary) transition-all',
            value ? 'left-[18px]' : 'left-0.5'
          )
        })
      })
    ]
  })
}

function SettingsPanel({ open, onClose }) {
  const [local, setLocal] = useState({ ..._settings })

  if (!open) return null

  const set = (k, v) => {
    const next = { ...local, [k]: v }
    setLocal(next)
    _settings = next
    try {
      storageRef.set('settings', next)
    } catch (e) {
      /* ignore */
    }
  }

  return jsxs('div', {
    className: 'fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 p-6',
    onClick: onClose,
    children: [
      jsxs('div', {
        className: 'w-[420px] max-w-full rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) p-5 shadow-2xl',
        onClick: e => e.stopPropagation(),
        children: [
          jsx('div', { className: 'mb-3 text-sm font-semibold', children: 'Celebration settings' }),
          jsx(ToggleRow, {
            label: 'Confetti',
            desc: 'Falling celebration on new unlocks',
            value: local.confetti,
            onChange: v => set('confetti', v)
          }),
          jsx(ToggleRow, {
            label: 'Sound',
            desc: 'Two-tone chime on new unlocks',
            value: local.sound,
            onChange: v => set('sound', v)
          }),
          jsx(ToggleRow, {
            label: 'Haptic',
            desc: 'Tap feedback on new unlocks',
            value: local.haptic,
            onChange: v => set('haptic', v)
          }),
          jsx(ToggleRow, {
            label: 'Nudges',
            desc: 'Whisper when a locked achievement passes 90%',
            value: local.nudges,
            onChange: v => set('nudges', v)
          }),
          jsxs('div', {
            className: 'border-t border-(--ui-stroke-secondary) pt-3 mt-1',
            children: [
              jsx('label', {
                className: 'block text-xs font-medium text-(--ui-text-secondary)',
                children: 'Discord webhook'
              }),
              jsx('input', {
                className:
                  'mt-1.5 w-full rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) px-2.5 py-1.5 text-xs outline-none focus:border-(--ui-accent)',
                placeholder: 'https://discord.com/api/webhooks/…',
                value: local.discordWebhook || '',
                onChange: e => set('discordWebhook', e.target.value)
              }),
              jsx('div', {
                className: 'mt-1 text-[0.6875rem] text-(--ui-text-quaternary)',
                children: 'Unlock announcements post here. Create one in Discord: channel settings → Integrations → Webhooks.'
              })
            ]
          }),
          jsx('div', {
            className: 'mt-4 flex justify-end',
            children: jsx(Button, { variant: 'secondary', size: 'sm', onClick: onClose, children: 'Done' })
          })
        ]
      })
    ]
  })
}

// ── Export ─────────────────────────────────────────────────────────────────

// Render the full badge collection to a canvas and download as PNG.
// Mirrors the backend SVG layout: uniform cards, category-tinted fills,
// tier labels, progress bars. Canvas lets us post directly to social.
const CATEGORY_HSL = {
  'Agent Autonomy': '250', 'Debugging Chaos': '15', 'Hermes Native': '205',
  'Lifestyle': '150', 'Model Lore': '330', 'Research/Web': '275',
  'Sets': '45', 'Tool Mastery': '190', 'Vibe Coding': '0'
}

function drawBadgeWallPng(achievements, level) {
  const cols = 8
  const cardW = 150
  const cardH = 92
  const gap = 12
  const pad = 28
  const headerH = 46
  const rows = Math.max(1, Math.ceil(achievements.length / cols))
  const W = pad * 2 + cols * cardW + (cols - 1) * gap
  const H = headerH + pad * 2 + rows * cardH + (rows - 1) * gap

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = '#fafafa'
  ctx.fillRect(0, 0, W, H)

  ctx.fillStyle = '#333'
  ctx.font = '700 15px -apple-system, system-ui, sans-serif'
  ctx.fillText(`Hermes Achievements — ${achievements.filter(a => a.unlocked).length}/${achievements.length} unlocked · Level ${level.level} ${level.name}`, pad, 30)

  const catColor = cat => {
    const h = CATEGORY_HSL[cat] || '220'
    return `hsl(${h} 55% 45%)`
  }

  achievements.forEach((a, idx) => {
    const r = Math.floor(idx / cols)
    const c = idx % cols
    const x = pad + c * (cardW + gap)
    const y = headerH + pad + r * (cardH + gap)
    const color = catColor(a.category || '')
    const name = a.state === 'secret' ? '???' : (a.name || '')
    const tier = a.tier || ''
    const pct = a.unlocked ? 100 : Math.min(100, a.progress_pct || 0)

    const fill = a.kind === 'collection'
      ? 'hsl(45 90% 92%)'
      : a.unlocked ? 'hsl(0 0% 94%)' : 'hsl(220 15% 96%)'

    // Card + accent.
    ctx.fillStyle = fill
    ctx.strokeStyle = color
    ctx.globalAlpha = 0.5
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.roundRect ? ctx.roundRect(x, y, cardW, cardH, 8) : ctx.rect(x, y, cardW, cardH)
    ctx.fill()
    ctx.stroke()
    ctx.globalAlpha = 1
    ctx.fillStyle = color
    ctx.fillRect(x, y, 4, cardH)

    // Name + category.
    ctx.fillStyle = '#333'
    ctx.font = '600 10.5px -apple-system, system-ui, sans-serif'
    ctx.fillText(truncateCanvas(ctx, name, cardW - 22), x + 12, y + 22)
    ctx.fillStyle = '#888'
    ctx.font = '400 7.5px -apple-system, system-ui, sans-serif'
    ctx.fillText(String(a.category || ''), x + 12, y + 38)

    // Progress bar.
    ctx.fillStyle = '#e5e5e5'
    ctx.fillRect(x + 12, y + 46, cardW - 24, 5)
    ctx.fillStyle = color
    ctx.fillRect(x + 12, y + 46, Math.round((cardW - 24) * pct / 100), 5)

    // Tier + pct.
    ctx.fillStyle = color
    ctx.font = '600 8px -apple-system, system-ui, sans-serif'
    ctx.fillText(tier || (a.unlocked ? 'EARNED' : 'locked'), x + 12, y + 70)
    ctx.fillStyle = '#999'
    ctx.textAlign = 'right'
    ctx.fillText(`${pct}%`, x + cardW - 12, y + 70)
    ctx.textAlign = 'left'
  })

  canvas.toBlob(blob => {
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'hermes-achievements-wall.png'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }, 'image/png')
}

function truncateCanvas(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text
  let t = text
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1)
  return t + '…'
}

function downloadText(filename, text) {
  try {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  } catch (e) {
    /* ignore */
  }
}

function buildMarkdown(data) {
  const items = data.achievements || []
  const unlocked = items
    .filter(a => a.unlocked)
    .sort((a, b) => (a.unlocked_at || 0) - (b.unlocked_at || 0))
  const inProgress = items
    .filter(a => !a.unlocked && a.state !== 'secret')
    .sort((a, b) => (b.progress_pct || 0) - (a.progress_pct || 0))
  const lines = []
  lines.push('# Hermes Achievements')
  lines.push('')
  lines.push(`${data.unlocked_count}/${data.total_count} unlocked · generated ${new Date().toLocaleDateString()}`)
  lines.push('')
  lines.push(`## Unlocked (${unlocked.length})`)
  for (const a of unlocked) {
    const tier = a.tier ? ` [${a.tier}]` : ''
    const when = a.unlocked_at ? new Date(a.unlocked_at * 1000).toLocaleDateString() : ''
    lines.push(`- ${a.name}${tier} — ${when}`)
  }
  lines.push('')
  lines.push(`## In progress (${inProgress.length})`)
  for (const a of inProgress.slice(0, 30)) {
    lines.push(`- ${a.name} — ${a.progress_pct ?? 0}%`)
  }
  lines.push('')
  lines.push(`Secrets: ${data.secret_count}`)
  return lines.join('\n')
}

function buildJson(data) {
  return JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      counts: {
        unlocked: data.unlocked_count,
        discovered: data.discovered_count,
        secret: data.secret_count,
        total: data.total_count
      },
      achievements: (data.achievements || []).map(a => ({
        id: a.id,
        name: a.name,
        description: a.description,
        state: a.state,
        unlocked: !!a.unlocked,
        tier: a.tier || null,
        progress_pct: a.progress_pct ?? 0,
        unlocked_at: a.unlocked_at || null,
        evidence: a.evidence || null
      }))
    },
    null,
    2
  )
}

function ExportMenu({ data }) {
  const [open, setOpen] = useState(false)
  const itemClass =
    'block w-full px-3 py-2 text-left text-xs hover:bg-(--ui-bg-quaternary)'

  return jsxs('div', {
    className: 'relative',
    children: [
      jsx('button', {
        type: 'button',
        onClick: () => setOpen(o => !o),
        className:
          'inline-flex h-7 items-center gap-1 rounded-md border border-(--ui-stroke-secondary) px-2 text-xs text-(--ui-text-tertiary) transition-colors hover:text-(--ui-text-primary)',
        children: jsxs('span', {
          className: 'inline-flex items-center gap-1',
          children: [jsx(Codicon, { name: 'download', size: '0.8rem' }), 'Export']
        })
      }),
      open
        ? jsxs('div', {
            className:
              'absolute right-0 top-full z-20 mt-1 w-40 overflow-hidden rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) shadow-xl',
            children: [
              jsx('button', {
                type: 'button',
                onClick: () => {
                  downloadText('hermes-achievements.md', buildMarkdown(data))
                  setOpen(false)
                },
                className: itemClass,
                children: 'Markdown'
              }),
              jsx('button', {
                type: 'button',
                onClick: () => {
                  downloadText('hermes-achievements.json', buildJson(data))
                  setOpen(false)
                },
                className: itemClass,
                children: 'JSON'
              }),
              jsx('button', {
                type: 'button',
                onClick: () => {
                  try {
                    drawBadgeWallPng(data.achievements || [], data.level || { level: 1, name: 'Initiate' })
                    haptic('tap')
                  } catch (e) {
                    host.notify({ kind: 'error', message: `Badge wall PNG failed: ${e?.message ?? e}` })
                  }
                  setOpen(false)
                },
                className: itemClass,
                children: 'Badge wall PNG'
              }),
              jsx('button', {
                type: 'button',
                onClick: async () => {
                  setOpen(false)
                  try {
                    const svg = await rest('/badge-wall.svg')
                    const text = typeof svg === 'string' ? svg : JSON.stringify(svg)
                    downloadText('hermes-achievements-wall.svg', text)
                    haptic('tap')
                  } catch (e) {
                    host.notify({ kind: 'error', message: `Badge wall export failed: ${e?.message ?? e}` })
                  }
                },
                className: itemClass,
                children: 'Badge wall SVG'
              })
            ]
          })
        : null
    ]
  })
}

// ── Share card ─────────────────────────────────────────────────────────────

function themeVars(el) {
  const cs = getComputedStyle(el)
  const get = v => cs.getPropertyValue(v).trim() || null
  return {
    bg: get('--ui-bg-primary') || '#161616',
    surface: get('--ui-bg-tertiary') || '#232323',
    accent: get('--ui-accent') || '#7B2D8E',
    text: get('--ui-text-primary') || '#f2f2f2',
    secondary: get('--ui-text-secondary') || '#b0b0b0'
  }
}

function wrapText(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/)
  const lines = []
  let line = ''
  for (const w of words) {
    const test = line ? line + ' ' + w : w
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line)
      line = w
    } else {
      line = test
    }
  }
  if (line) lines.push(line)
  return lines
}

function drawShareCard(canvas, item) {
  const W = 1200
  const H = 630
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  const t = themeVars(canvas)

  const grad = ctx.createLinearGradient(0, 0, W, H)
  grad.addColorStop(0, t.bg)
  grad.addColorStop(1, t.surface)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, W, H)

  ctx.globalAlpha = 0.09
  ctx.fillStyle = t.accent
  ctx.beginPath()
  ctx.arc(200, 150, 280, 0, Math.PI * 2)
  ctx.fill()
  ctx.globalAlpha = 1

  ctx.fillStyle = t.secondary
  ctx.font = '600 26px -apple-system, system-ui, sans-serif'
  ctx.fillText('HERMES ACHIEVEMENT', 64, 78)

  ctx.fillStyle = t.accent
  ctx.beginPath()
  ctx.moveTo(64, 148)
  ctx.lineTo(96, 112)
  ctx.lineTo(128, 148)
  ctx.lineTo(96, 184)
  ctx.closePath()
  ctx.fill()

  ctx.fillStyle = t.text
  ctx.font = '700 72px -apple-system, system-ui, sans-serif'
  ctx.fillText(String(item.name || 'Achievement').slice(0, 28), 64, 268)

  const tierLabel = String(item.tier || 'EARNED').toUpperCase()
  ctx.font = '700 22px -apple-system, system-ui, sans-serif'
  const tw = ctx.measureText(tierLabel).width
  ctx.fillStyle = t.accent
  ctx.beginPath()
  if (ctx.roundRect) {
    ctx.roundRect(64, 300, tw + 36, 46, 23)
  } else {
    ctx.rect(64, 300, tw + 36, 46)
  }
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.fillText(tierLabel, 64 + 18, 300 + 31)

  ctx.fillStyle = t.secondary
  ctx.font = '400 30px -apple-system, system-ui, sans-serif'
  const lines = wrapText(ctx, item.description || '', 1060).slice(0, 4)
  lines.forEach((l, i) => ctx.fillText(l, 64, 410 + i * 42))

  ctx.fillStyle = t.secondary
  ctx.font = '400 20px -apple-system, system-ui, sans-serif'
  ctx.fillText('Hermes · achievements · collected from real session history', 64, H - 48)
}

function ShareCardOverlay({ item, onClose }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    if (canvasRef.current) drawShareCard(canvasRef.current, item)
  }, [item])

  useEffect(() => {
    const h = e => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const download = () => {
    const c = canvasRef.current
    if (!c) return
    const url = c.toDataURL('image/png')
    const a = document.createElement('a')
    a.href = url
    a.download = `hermes-achievement-${item.id}.png`
    a.click()
  }

  return jsxs('div', {
    className: 'fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 p-6',
    onClick: onClose,
    children: [
      jsxs('div', {
        className: 'flex flex-col gap-4 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) p-5 shadow-2xl',
        onClick: e => e.stopPropagation(),
        children: [
          jsx('canvas', {
            ref: canvasRef,
            className: 'w-[560px] max-w-full rounded-lg border border-(--ui-stroke-secondary)',
            style: { aspectRatio: '1200 / 630' }
          }),
          jsxs('div', {
            className: 'flex items-center justify-between gap-2',
            children: [
              jsx('span', {
                className: 'text-xs text-(--ui-text-tertiary)',
                children: `${item.name} · 1200×630 share card`
              }),
              jsxs('div', {
                className: 'flex items-center gap-2',
                children: [
                  jsx(Button, { variant: 'secondary', size: 'sm', onClick: onClose, children: 'Close' }),
                  jsx(Button, { variant: 'primary', size: 'sm', onClick: download, children: 'Download PNG' })
                ]
              })
            ]
          })
        ]
      })
    ]
  })
}

// ── Mini stats ─────────────────────────────────────────────────────────────

function MiniStats({ data }) {
  const items = data.achievements || []
  const unlocked = items.filter(a => a.unlocked)
  const byTier = {}
  for (const a of unlocked) {
    if (a.tier) byTier[a.tier] = (byTier[a.tier] || 0) + 1
  }
  const dayCount = {}
  for (const a of unlocked) {
    if (!a.unlocked_at) continue
    const d = new Date(a.unlocked_at * 1000).toLocaleDateString('en-US', { weekday: 'long' })
    dayCount[d] = (dayCount[d] || 0) + 1
  }
  const busiest = Object.entries(dayCount).sort((a, b) => b[1] - a[1])[0]
  const tiers = TIER_ORDER.filter(t => byTier[t])

  if (tiers.length === 0 && !busiest) return null

  return jsxs('div', {
    className: 'px-6 pb-2',
    children: [
      jsxs('div', {
        className: 'flex flex-wrap items-center gap-1.5 rounded-xl border border-(--ui-stroke-secondary) px-3 py-2',
        style: { backgroundColor: 'var(--ui-bg-chrome)' },
        children: [
          jsx('span', {
            className: 'text-[0.6875rem] font-medium',
            style: { color: 'var(--ui-text-secondary)' },
            children: 'Tiers'
          }),
          ...tiers.map(t => {
            const c = tierColor(t)
            return jsxs('span', {
              key: t,
              className: 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.6875rem] tabular-nums',
              style: {
                backgroundColor: c ? `color-mix(in srgb, ${c} 12%, transparent)` : 'var(--ui-bg-quaternary)',
                color: c || 'var(--ui-text-secondary)'
              },
              children: [jsx('span', { className: 'font-semibold', children: String(byTier[t]) }), jsx('span', { children: t })]
            })
          }),
          busiest
            ? jsxs('span', {
                className: 'ml-auto text-[0.6875rem]',
                style: { color: 'var(--ui-text-secondary)' },
                children: [
                  jsx('span', { className: 'mr-1', children: 'Busiest day' }),
                  jsx('span', { className: 'font-medium', children: busiest[0] })
                ]
              })
            : null
        ]
      })
    ]
  })
}

// ── Activity heatmap (GitHub-style contribution graph) ────────────────────

function ActivityHeatmap({ activity }) {
  if (!activity || activity.length === 0) return null

  // Show the last 6 months (182 days) — a 12-month window at ~5% activity
  // reads as a sea of empty cells, and 52 thin bars hide the spikes.
  const windowed = activity.slice(-182)

  // Roll days into weekly bars (Monday-start). Sparse data reads far better
  // as a compact bar strip than as a 365-cell grid that is 95% empty.
  const weeks = [] // { weekStart, label, sessions, tools, days }
  let current = null
  for (const d of windowed) {
    const dt = new Date(d.date + 'T00:00:00')
    const dow = (dt.getDay() + 6) % 7 // Mon=0
    if (!current || dow === 0) {
      current = { weekStart: d.date, sessions: 0, tools: 0, days: 0 }
      weeks.push(current)
    }
    current.sessions += d.sessions || 0
    current.tools += d.tools || 0
    if (d.sessions > 0) current.days += 1
  }
  const maxTools = Math.max(1, ...weeks.map(w => w.tools))

  // Month labels: mark the first week whose month differs from the previous.
  const monthMarks = []
  {
    let last = null
    for (const w of weeks) {
      const m = new Date(w.weekStart + 'T00:00:00').toLocaleDateString('en-US', { month: 'short' })
      if (m !== last) {
        monthMarks.push({ m, weekStart: w.weekStart })
        last = m
      }
    }
  }

  const totalDays = windowed.filter(d => d.sessions > 0).length
  const totalTools = windowed.reduce((n, d) => n + (d.tools || 0), 0)

  // Bar height: 4px minimum for any activity, scaled up to 44px.
  const barHeight = w => (w.tools > 0 ? Math.max(4, Math.round((w.tools / maxTools) * 44)) : 2)

  return jsxs('div', {
    className: 'px-6 pb-3',
    children: [
      jsxs('div', {
        className: 'relative',
        children: [
          jsxs('div', {
            className: 'flex items-end gap-[2px]',
            children: weeks.map((w, wi) =>
              jsx('div', {
                key: wi,
                className: cn(
                  'min-w-[3px] flex-1 rounded-sm',
                  w.tools > 0 ? 'bg-(--ui-accent)' : 'bg-(--ui-bg-quaternary)'
                ),
                style: { height: barHeight(w) }
              })
            )
          }),
          jsxs('div', {
            className: 'mt-1 flex gap-[2px] text-[0.5625rem] text-(--ui-text-quaternary)',
            children: weeks.map((w, wi) => {
              const mark = monthMarks.find(m => m.weekStart === w.weekStart)
              return jsx('div', {
                key: wi,
                className: 'min-w-[3px] flex-1 whitespace-nowrap overflow-hidden',
                children: mark ? mark.m : ''
              })
            })
          })
        ]
      })
    ]
  })
}

// ── Rewards strip (unlockable theme rewards) ──────────────────────────────

function RewardsStrip({ rewards }) {
  const [installing, setInstalling] = useState(null)
  const [installed, setInstalled] = useState({})
  const [ref, cols] = useCardCols()

  if (!rewards || rewards.length === 0) return null

  const install = async (reward) => {
    setInstalling(reward.id)
    try {
      const res = await rest(`/rewards/${encodeURIComponent(reward.id)}/install`, { method: 'POST' })
      if (res && res.ok) {
        setInstalled(prev => ({ ...prev, [reward.id]: true }))
        haptic('tap')
        host.notify({ kind: 'success', message: `Theme installed: ${reward.theme}. Find it in Appearance.` })
      } else {
        host.notify({ kind: 'error', message: `Reward install failed: ${res?.error || 'unknown error'}` })
      }
    } catch (e) {
      host.notify({ kind: 'error', message: `Reward install failed: ${e?.message ?? e}` })
    } finally {
      setInstalling(null)
    }
  }

  const rewardIcon = id => ({
    theme_diamond: '💎',
    theme_streak30: '🔥',
    theme_olympian: '🏆',
    theme_sets: '🏅'
  }[id] || '🎁')

  return jsxs('div', {
    ref,
    className: 'px-6 pb-2.5',
    children: [
      jsx('div', {
        className: 'flex flex-wrap gap-2',
        style: { display: 'flex', flexWrap: 'wrap' },
        children: rewards.map(r => {
          const isInstalled = !!installed[r.id]
          const icon = rewardIcon(r.id)
          return jsxs('div', {
            key: r.id,
            className: cn(
              'flex flex-col rounded-lg border p-2 transition-colors',
              r.unlocked
                ? 'border-(--ui-accent)/40 bg-(--ui-bg-secondary)'
                : 'border-(--ui-stroke-secondary) bg-(--ui-bg-tertiary)'
            ),
            // Inline width (cols per row at 8px gap) — purge-proof, same
            // density as the achievement grid below.
            style: { width: cardWidth(cols) },
            children: [
              jsxs('div', {
                className: 'flex items-center justify-between gap-1',
                children: [
                  jsxs('div', {
                    className: 'flex min-w-0 items-center gap-1',
                    children: [
                      jsx('span', { className: 'shrink-0 text-[0.75rem] leading-none', children: icon }),
                      jsx('span', { className: 'truncate text-[0.8125rem] font-medium leading-tight', children: r.name })
                    ]
                  }),
                  r.unlocked
                    ? jsx('span', { className: 'shrink-0 text-[0.5625rem] text-(--ui-accent)', children: 'Open' })
                    : jsx('span', { className: 'shrink-0 text-[0.5625rem] text-(--ui-text-quaternary)', children: 'Locked' })
                ]
              }),
              jsx(Tip, {
                label: r.description,
                children: jsx('span', {
                  className: 'mt-1 block truncate text-[0.625rem] leading-tight',
                  style: { color: 'var(--ui-text-secondary)' },
                  children: r.description
                })
              }),
              jsxs('div', {
                className: 'mt-1.5 flex items-center justify-between gap-2',
                children: [
                  jsx('span', {
                    className: 'truncate text-[0.625rem] tabular-nums text-(--ui-text-quaternary)',
                    children: r.progress || 'not started'
                  }),
                  r.id === 'theme_streak30' && !r.unlocked
                    ? (() => {
                        // Countdown from the CURRENT streak (ticks daily while
                        // you keep using Hermes), not the all-time max (which
                        // only moves when you set a new record).
                        const m = /current streak: (\d+)/.exec(r.progress || '')
                        const cur = m ? parseInt(m[1], 10) : 0
                        const left = Math.max(0, 30 - cur)
                        return jsx('span', {
                          className: 'shrink-0 text-[0.625rem] font-medium text-(--ui-accent)',
                          children: left === 0 ? '🔥 today?' : `🔥 ${left}d to go`
                        })
                      })()
                    : null,
                  r.unlocked
                    ? jsx('button', {
                        className: cn(
                          'shrink-0 rounded border px-1 py-0.5 text-[0.5625rem] font-medium transition-colors',
                          isInstalled
                            ? 'border-(--ui-stroke-secondary) text-(--ui-text-quaternary)'
                            : 'border-(--ui-accent) text-(--ui-accent) hover:bg-(--ui-accent)/10'
                        ),
                        type: 'button',
                        disabled: isInstalled || installing === r.id,
                        onClick: () => install(r),
                        children: isInstalled ? 'Installed' : installing === r.id ? '…' : 'Install'
                      })
                    : null
                ]
              })
            ]
          })
        })
      })
    ]
  })
}

// ── Header / score strip ────────────────────────────────────────────────────

function ScoreHeader({ data, onRescan, rescinding, onOpenSettings }) {
  const { unlocked_count, discovered_count, total_count } = data
  const pct = total_count ? Math.round((unlocked_count / total_count) * 100) : 0
  const level = data.level || {}
  const xpPct = level.xp_for_next ? Math.round((level.xp_in_level / level.xp_for_next) * 100) : 0
  const items = data.achievements || []
  const now = Date.now() / 1000
  const week = 7 * 24 * 3600
  const thisWeek = items.filter(a => a.unlocked && a.unlocked_at && now - a.unlocked_at < week).length
  const streak = (data.streak && data.streak.current_streak_days) || 0

  return jsxs('div', {
    className: 'px-6 pb-2 pt-4',
    children: [
      jsxs('div', {
        className: 'flex w-full items-center gap-4 rounded-xl border border-(--ui-stroke-secondary) px-4 py-3',
        style: { maxWidth: 840, backgroundColor: 'var(--ui-bg-chrome)' },
        children: [
          // Level medallion: fixed-size circle (inline sizing so Tailwind
          // purge can't strip it), solid accent gradient, white level number.
          jsxs('div', {
            className: 'flex shrink-0 flex-col items-center justify-center',
            style: {
              width: 56,
              height: 56,
              borderRadius: '50%',
              background: 'linear-gradient(135deg, var(--ui-accent) 0%, color-mix(in srgb, var(--ui-accent) 65%, white) 100%)'
            },
            children: [
              jsx('span', {
                className: 'text-[0.5625rem] font-semibold uppercase leading-none tracking-wide',
                style: { color: 'rgba(255,255,255,0.85)' },
                children: 'Lv'
              }),
              jsx('span', {
                className: 'mt-0.5 text-lg font-bold leading-none tabular-nums',
                style: { color: '#ffffff' },
                children: String(level.level ?? unlocked_count)
              })
            ]
          }),
          // Center block: level name, XP bar, meta line.
          jsxs('div', {
            className: 'min-w-0 flex-1',
            children: [
              jsxs('div', {
                className: 'flex items-baseline justify-between gap-2',
                children: [
                  jsxs('div', {
                    className: 'flex min-w-0 items-baseline gap-2',
                    children: [
                      jsx('span', { className: 'truncate text-sm font-semibold', children: level.name || 'Achievements' }),
                      jsx('span', {
                        className: 'shrink-0 text-[0.6875rem] tabular-nums',
                        style: { color: 'var(--ui-text-secondary)' },
                        children: `${unlocked_count}/${total_count} unlocked · ${pct}%`
                      })
                    ]
                  }),
                  level.xp_for_next
                    ? jsx('span', {
                        className: 'shrink-0 text-[0.6875rem] tabular-nums',
                        style: { color: 'var(--ui-text-secondary)' },
                        children: `${level.xp_in_level}/${level.xp_for_next} XP · next: ${level.next_name}`
                      })
                    : null
                ]
              }),
              jsxs('div', {
                className: 'mt-2 h-2 w-full overflow-hidden rounded-full',
                style: { backgroundColor: 'color-mix(in srgb, var(--ui-text-tertiary) 22%, transparent)' },
                children: [
                  jsx('div', {
                    className: 'h-full rounded-full transition-all',
                    style: {
                      width: `${Math.min(100, xpPct || pct)}%`,
                      background: 'linear-gradient(90deg, var(--ui-accent), color-mix(in srgb, var(--ui-accent) 60%, white))'
                    }
                  })
                ]
              }),
              jsxs('div', {
                className: 'mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.6875rem]',
                style: { color: 'var(--ui-text-secondary)' },
                children: [
                  jsx('span', { children: `${thisWeek} unlocked this week` }),
                  jsx('span', { children: `${discovered_count} discovered` }),
                  streak >= 2 ? jsx('span', { children: `🔥 ${streak}-day streak` }) : null,
                  data.generated_at
                    ? jsx('span', { children: `scanned ${relativeTime(data.generated_at * 1000)}` })
                    : null,
                  data.is_stale ? jsx(Badge, { variant: 'warn', children: 'stale' }) : null
                ]
              })
            ]
          }),
          // Actions: settings + rescan always visible.
          jsxs('div', {
            className: 'flex shrink-0 items-center gap-1.5',
            children: [
              jsx('button', {
                type: 'button',
                onClick: onOpenSettings,
                className:
                  'inline-flex h-7 items-center gap-1 rounded-md border border-(--ui-stroke-secondary) px-2 transition-colors hover:border-(--ui-stroke-strong)',
                style: { color: 'var(--ui-text-secondary)' },
                children: jsx(Codicon, { name: 'settings', size: '0.8rem' })
              }),
              jsx(Button, {
                variant: 'secondary',
                size: 'sm',
                disabled: rescinding,
                onClick: onRescan,
                children: rescinding ? 'Scanning…' : 'Rescan'
              }),
              jsx(ExportMenu, { data })
            ]
          })
        ]
      })
    ]
  })
}

// ── Next up strip ───────────────────────────────────────────────────────────

function NextUpStrip({ items, onHover, onLeave }) {
  const [ref, cols] = useCardCols()
  if (!items || items.length === 0) return null

  return jsxs('div', {
    ref,
    className: 'border-b border-(--ui-stroke-secondary) px-6 py-2.5',
    children: [
      jsx('div', {
        className: 'mb-1.5 text-[0.6875rem] font-medium uppercase tracking-wide',
        style: { color: 'var(--ui-text-secondary)' },
        children: 'Next up'
      }),
      jsxs('div', {
        className: 'flex flex-wrap gap-2',
        style: { display: 'flex', flexWrap: 'wrap' },
        children: items.map(a =>
          jsx('div', {
            key: a.id,
            className: 'relative',
            onMouseEnter: () => onHover && onHover(a),
            onMouseLeave: () => onLeave && onLeave(),
            onFocus: () => onHover && onHover(a),
            onBlur: () => onLeave && onLeave(),
            // Inline width (cols per row at 8px gap) — purge-proof, same
            // density as the achievement grid. Same card component as the
            // grid and Recent row so all sections match in height/density.
            style: { width: cardWidth(cols) },
            children: jsx(AchievementCard, { item: a, showPin: false })
          })
        )
      })
    ]
  })
}

// ── Session context ─────────────────────────────────────────────────────────

// The gateway's `session.active_list` RPC returns live sessions with BOTH
// identities: `id` (runtime session id, what host.state.activeSessionId
// exposes) and `session_key` (stored session id, e.g. 20260807_170436_b7b698).
// The achievements backend keys per-session badges by the STORED id, so the
// runtime id must be translated before querying — otherwise the lookup misses
// and "This session" always renders empty. See AGENTS.md on identity: live
// streaming keys off the runtime identity; durable navigation off the stored.
async function resolveStoredSessionId(runtimeId) {
  if (!runtimeId) return null
  try {
    const res = await host.request('session.active_list', {})
    const sessions = (res && res.sessions) || []
    const match = sessions.find(s => s.id === runtimeId)
    if (match && match.session_key) return match.session_key
  } catch (e) {
    // Gateway unavailable or method missing — fall through to the raw id.
  }
  return runtimeId
}

function SessionBadges() {
  const sessionId = useValue(host.state.activeSessionId)
  const [storedId, setStoredId] = useState(undefined)
  const resolving = storedId === undefined

  useEffect(() => {
    let cancelled = false
    setStoredId(undefined)
    if (!sessionId) {
      setStoredId(null)
      return
    }
    resolveStoredSessionId(sessionId).then(resolved => {
      if (!cancelled) setStoredId(resolved || sessionId)
    })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  const effectiveId = storedId || sessionId
  const { data, isLoading } = useQuery({
    queryKey: ['hermes-achievements', 'session', effectiveId ?? 'none'],
    queryFn: () =>
      effectiveId
        ? rest('/sessions/' + encodeURIComponent(effectiveId) + '/badges', { timeoutMs: 8000 })
        : Promise.resolve({ badges: [] }),
    enabled: !!effectiveId && !resolving,
    refetchInterval: 60_000,
    staleTime: 30_000
  })

  if (!sessionId) return null

  const badges = data?.badges || []
  const accent = FILTER_TAB_META.badges.color

  return jsxs('div', {
    className: 'px-6 pb-2',
    children: [
      jsxs('div', {
        className: 'rounded-xl border border-(--ui-stroke-secondary) px-4 py-3',
        style: { maxWidth: 840, backgroundColor: 'var(--ui-bg-chrome)' },
        children: [
          jsxs('div', {
            className: 'flex items-center justify-between gap-2',
            children: [
              jsxs('div', {
                className: 'flex min-w-0 items-center gap-2',
                children: [
                  // Section color bar + icon + uppercase label, the app's
                  // Section language but carrying the Badges tab accent and
                  // larger weight so the header doesn't get lost.
                  jsx('span', {
                    style: { background: accent, opacity: 0.85 },
                    className: 'h-4 w-1 shrink-0 rounded-full'
                  }),
                  jsx(Codicon, { name: 'zap', size: '0.95rem', style: { color: accent } }),
                  jsx('span', {
                    className: 'text-xs font-semibold uppercase tracking-wide',
                    style: { color: accent },
                    children: 'This session'
                  })
                ]
              }),
              badges.length > 0
                ? jsx('span', {
                    className: 'shrink-0 rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold tabular-nums',
                    style: {
                      color: accent,
                      backgroundColor: `color-mix(in srgb, ${accent} 12%, transparent)`
                    },
                    children: `${badges.length} badge${badges.length === 1 ? '' : 's'}`
                  })
                : null
            ]
          }),
          badges.length > 0
            ? jsx('div', {
                className: 'mt-3 grid gap-2',
                // Deterministic responsive grid: ~3 cards across at the
                // card's 840px cap (each ≈260px). Not useCardCols: that
                // hook only observes a ref that exists on FIRST render, and
                // this grid mounts after the query resolves, so it locked
                // onto window.innerWidth (6 columns on wide monitors) and
                // every name truncated. auto-fill keeps full names visible,
                // collapsing gracefully on narrower windows.
                style: {
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))',
                  gap: 8
                },
                children: badges.map(b => {
                  // Mini achievement card: same identity language as the grid
                  // (3px category left accent, soft tinted fill, colored
                  // milestone icon) with a proper icon tile and a tier chip
                  // colored by the TIER hue. Names wrap up to 2 lines instead
                  // of truncating so the haul stays readable.
                  const cat = b.category || ''
                  const tierHex = tierColor(b.tier)
                  return jsxs('div', {
                    key: b.id,
                    className: 'flex items-center gap-2.5 rounded-lg border border-(--ui-stroke-secondary) px-3 py-2.5',
                    style: {
                      borderLeft: `3px solid ${categoryColor(cat)}`,
                      backgroundColor: categoryBg(cat)
                    },
                    children: [
                      jsx('div', {
                        className: 'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                        style: {
                          backgroundColor: `color-mix(in srgb, ${categoryColor(cat)} 18%, transparent)`,
                          color: categoryIcon(cat)
                        },
                        children: jsx(Codicon, { name: 'milestone', size: '1rem' })
                      }),
                      jsxs('div', {
                        className: 'min-w-0 flex-1',
                        children: [
                          jsx('span', {
                            className: 'line-clamp-2 text-[0.8125rem] font-semibold leading-snug',
                            children: b.name
                          }),
                          jsxs('div', {
                            className: 'mt-1 flex items-center gap-1',
                            children: [
                              tierHex
                                ? jsx('span', {
                                    style: { backgroundColor: tierHex },
                                    className: 'h-1.5 w-1.5 shrink-0 rounded-full'
                                  })
                                : null,
                              jsx('span', {
                                className: 'truncate text-[0.6875rem] font-medium',
                                style: { color: tierTextColor(b.tier) },
                                children: b.tier || 'Earned'
                              })
                            ]
                          })
                        ]
                      })
                    ]
                  })
                })
              })
            : jsx('span', {
                className: 'mt-2.5 block text-xs leading-snug',
                style: { color: 'var(--ui-text-secondary)' },
                children: isLoading || resolving
                  ? 'Checking this session…'
                  : 'No badges this session yet. Keep working and check back, or browse what is closest below.'
              })
        ]
      })
    ]
  })
}

// ── Achievement card ────────────────────────────────────────────────────────

function AchievementCard({ item, onCatClick, pinned, onTogglePin, showPin = true }) {
  const [open, setOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const isSecret = item.state === 'secret'
  const pct = item.progress_pct ?? 0
  const isNew =
    item.unlocked &&
    item.unlocked_at &&
    Date.now() / 1000 - item.unlocked_at < 48 * 3600

  return jsxs('div', {
    className: cn(
      'group relative flex flex-col rounded-lg border p-2.5',
      item.unlocked
        ? 'border-(--ui-stroke-strong)'
        : 'border-(--ui-stroke-secondary)',
      pinned && 'ring-1 ring-(--ui-accent)/40',
      isSecret && 'opacity-70'
    ),
    // Category identity: 3px left accent + soft tinted fill. Unlocked cards
    // keep their tint but the border goes strong so state stays readable.
    style: {
      borderLeft: `3px solid ${categoryColor(item.category)}`,
      backgroundColor: categoryBg(item.category)
    },
    children: [
      showPin
        ? jsx('button', {
            type: 'button',
            onClick: e => {
              e.stopPropagation()
              onTogglePin && onTogglePin(item.id)
            },
            className: cn(
              'absolute right-1.5 top-1 z-10 rounded p-0.5 text-[0.625rem] transition-colors',
              pinned ? 'text-(--ui-accent)' : 'text-(--ui-text-secondary) hover:text-(--ui-text-primary)'
            ),
            children: pinned ? '📌' : '📌'
          })
        : null,
      jsxs('div', {
        className: 'flex items-start justify-between gap-1.5',
        children: [
          jsxs('div', {
            className: 'flex min-w-0 items-center gap-1.5',
            children: [
              jsx(Codicon, {
                name: 'milestone',
                size: '0.85rem',
                style: { color: categoryIcon(item.category) },
                className: cn('shrink-0', item.unlocked && 'opacity-90')
              }),
              jsx('span', {
                className: 'truncate text-[0.8125rem] font-medium',
                children: isSecret ? '???' : item.name
              })
            ]
          }),
          jsxs('div', {
            className: 'flex shrink-0 items-center gap-1',
            children: [
              isNew
                ? jsx(Badge, {
                    variant: 'outline',
                    className: 'shrink-0 text-[0.625rem] text-(--ui-accent)',
                    children: 'NEW'
                  })
                : null,
              item.tier
                ? jsx(Badge, {
                    variant: 'outline',
                    className: cn('shrink-0 text-[0.625rem]', tierBadgeClass(item.tier)),
                    children: item.tier
                  })
                : item.unlocked
                  ? jsx(Badge, {
                      variant: 'outline',
                      className: 'shrink-0 text-[0.625rem] text-(--ui-accent)',
                      children: 'Earned'
                    })
                  : null,
              item.unlocked && !isSecret
                ? jsxs('div', {
                    className: 'flex shrink-0 items-center gap-1',
                    children: [
                      jsx('button', {
                        type: 'button',
                        onClick: () => celebrate({ name: item.name, tier: item.tier }, {}),
                        className:
                          'inline-flex items-center gap-0.5 rounded-md border border-(--ui-stroke-secondary) px-1 py-0.5 text-[0.625rem] transition-colors hover:text-(--ui-text-primary)',
                        style: { color: 'var(--ui-text-secondary)' },
                        children: jsxs('span', {
                          className: 'inline-flex items-center gap-0.5',
                          children: [jsx(Codicon, { name: 'play', size: '0.625rem' }), 'Replay']
                        })
                      }),
                      jsx('button', {
                        type: 'button',
                        onClick: () => setShareOpen(true),
                        className:
                          'inline-flex items-center gap-0.5 rounded-md border border-(--ui-stroke-secondary) px-1 py-0.5 text-[0.625rem] transition-colors hover:text-(--ui-text-primary)',
                        style: { color: 'var(--ui-text-secondary)' },
                        children: jsxs('span', {
                          className: 'inline-flex items-center gap-0.5',
                          children: [jsx(Codicon, { name: 'share', size: '0.625rem' }), 'Share']
                        })
                      })
                    ]
                  })
                : null
            ]
          })
        ]
      }),
      jsx('p', {
        className: 'mt-1.5 line-clamp-2 text-xs leading-snug',
        style: { color: 'var(--ui-text-secondary)' },
        children: isSecret ? 'Secret achievement, hidden until the first matching signal appears.' : item.description
      }),
      jsx('button', {
        type: 'button',
        onClick: e => {
          e.stopPropagation()
          onCatClick && onCatClick(item.category)
        },
        className:
          'mt-1 inline-block self-start text-[0.625rem] font-medium uppercase tracking-wide transition-opacity hover:opacity-70',
        style: { color: categoryColor(item.category) },
        children: item.category
      }),
      jsxs('div', {
        className: 'mt-1.5',
        children: [
          jsxs('div', {
            className: 'flex items-center justify-between text-[0.625rem]',
            style: { color: 'var(--ui-text-secondary)' },
            children: [
              jsx('span', {
                className: 'truncate',
                children: item.unlocked ? (item.next_tier ? `next: ${item.next_tier} · ${item.next_threshold}` : 'max tier') : (item.next_tier ? `next: ${item.next_tier} · ${item.next_threshold}` : '')
              }),
              jsx('span', { className: 'shrink-0 tabular-nums', children: isSecret ? '' : `${pct}%` })
            ]
          }),
          jsxs('div', {
            className: 'mt-1 h-1 w-full overflow-hidden rounded-full bg-(--ui-bg-quaternary)',
            children: [
              jsx('div', {
                className: 'h-full rounded-full',
                style: {
                  ...tierProgressStyle(item.state, item.unlocked ? item.tier : item.next_tier),
                  width: `${isSecret ? 0 : Math.min(100, pct)}%`
                }
              })
            ]
          })
        ]
      }),
      item.criteria
        ? jsxs('div', {
            className: 'mt-1.5',
            children: [
              jsx('button', {
                className:
                  'text-[0.625rem] underline decoration-dotted underline-offset-2 hover:text-(--ui-text-primary)',
                style: { color: 'var(--ui-text-secondary)' },
                type: 'button',
                onClick: () => setOpen(o => !o),
                children: open ? 'Hide what counts' : 'What counts?'
              }),
              open
                ? jsx('p', {
                    className: 'mt-1 text-[0.625rem] leading-snug',
                    style: { color: 'var(--ui-text-secondary)' },
                    children: item.criteria
                  })
                : null
            ]
          })
        : null,
      item.evidence && item.evidence.title
        ? jsx('p', {
            className: 'mt-1 truncate text-[0.625rem]',
            style: { color: 'var(--ui-text-secondary)' },
            children: 'evidence: ' + item.evidence.title
          })
        : null,
      shareOpen
        ? jsx(ShareCardOverlay, { item, onClose: () => setShareOpen(false) })
        : null
    ]
  })
}

// ── Achievement preview panel ───────────────────────────────────────────────
// Docked to the right edge (mirrors the theme pack's PreviewPanel) so hover
// details never cover the grid. Fixed position escapes the scroll container.

function AchievementPreviewPanel({ card }) {
  if (!card) return null
  const item = card
  const isSecret = item.state === 'secret'
  const pct = item.progress_pct ?? 0

  return jsxs('div', {
    className: 'pointer-events-none fixed z-30 w-72 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) p-3 shadow-2xl',
    // Inline right/top: the app's Tailwind build strips right-6/top-24 (only
    // core files feed the purge), so utility classes for these land nowhere.
    style: { right: 24, top: 96, borderLeft: `3px solid ${categoryColor(item.category)}` },
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between gap-2',
        children: [
          jsx('span', {
            className: 'truncate text-[0.8125rem] font-semibold',
            style: { color: categoryColor(item.category) },
            children: isSecret ? '???' : item.name
          }),
          jsx('span', {
            className: 'shrink-0 text-[0.5625rem] font-medium uppercase tracking-wide text-(--ui-text-quaternary)',
            children: item.category
          })
        ]
      }),
      jsx('p', {
        className: 'mt-1.5 text-[0.6875rem] leading-relaxed text-(--ui-text-secondary)',
        children: isSecret
          ? 'Secret achievement — hidden until the first matching signal appears.'
          : item.description
      }),
      item.criteria
        ? jsxs('div', {
            className: 'mt-2 rounded-md bg-(--ui-bg-tertiary) px-2 py-1.5',
            children: [
              jsx('span', {
                className: 'text-[0.5625rem] font-medium uppercase tracking-wide text-(--ui-text-quaternary)',
                children: 'What counts'
              }),
              jsx('p', {
                className: 'mt-0.5 text-[0.625rem] leading-relaxed text-(--ui-text-tertiary)',
                children: item.criteria
              })
            ]
          })
        : null,
      jsxs('div', {
        className: 'mt-2 flex items-center justify-between gap-2 text-[0.625rem] text-(--ui-text-tertiary)',
        children: [
          jsx('span', {
            children: item.unlocked
              ? (item.tier ? `unlocked · ${item.tier}` : 'unlocked')
              : (item.next_tier ? `next: ${item.next_tier} · ${item.next_threshold}` : '')
          }),
          jsxs('span', {
            className: 'flex shrink-0 items-center gap-2 tabular-nums',
            children: [
              item.eta_days ? jsx('span', { className: 'text-(--ui-text-quaternary)', children: `~${item.eta_days}d` }) : null,
              isSecret ? null : jsx('span', { children: `${pct}%` })
            ]
          })
        ]
      }),
      item.next_threshold
        ? jsxs('div', {
            className: 'mt-1.5 h-1 w-full overflow-hidden rounded-full bg-(--ui-bg-quaternary)',
            children: [
              jsx('div', {
                className: 'h-full rounded-full',
                style: {
                  ...tierProgressStyle(item.state, item.unlocked ? item.tier : item.next_tier),
                  width: `${isSecret ? 0 : Math.min(100, pct)}%`
                }
              })
            ]
          })
        : null
    ]
  })
}

// ── Personal records strip ──────────────────────────────────────────────────

function RecordsStrip({ records }) {
  const [ref, cols] = useCardCols()
  if (!records) return null
  const items = [
    records.best_day ? { label: 'Best day', value: `${records.best_day.tool_calls.toLocaleString()} calls`, sub: records.best_day.date } : null,
    records.busiest_day ? { label: 'Busiest day', value: `${records.busiest_day.sessions} sessions`, sub: records.busiest_day.date } : null,
    records.biggest_session ? { label: 'Biggest session', value: records.biggest_session.title, sub: `${records.biggest_session.tool_calls} calls` } : null,
    records.longest_session ? { label: 'Longest session', value: records.longest_session.title, sub: `${records.longest_session.messages} msgs` } : null
  ].filter(Boolean)
  if (items.length === 0) return null

  return jsxs('div', {
    ref,
    className: 'px-6 pb-2.5',
    children: [
      jsxs('div', {
        className: 'flex flex-wrap gap-2',
        style: { display: 'flex', flexWrap: 'wrap' },
        children: items.map(it =>
          jsxs('div', {
            className: 'flex flex-col rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) p-2',
            style: { width: cardWidth(Math.min(cols, 4), 6) },
            children: [
              jsx('span', { className: 'text-[0.5625rem] font-medium uppercase tracking-wide text-(--ui-text-quaternary)', children: it.label }),
              jsx('span', { className: 'mt-0.5 truncate text-[0.75rem] font-medium leading-tight', children: it.value }),
              jsx('span', { className: 'truncate text-[0.5625rem] text-(--ui-text-quaternary)', children: it.sub })
            ]
          })
        )
      })
    ]
  })
}

// ── Collapsible section wrapper ─────────────────────────────────────────────
// Every strip on the page can collapse to a header row, with the state
// persisted per section id so the user's layout survives reloads.

const SECTION_DEFAULTS = {}

function Section({ id, title, extra, children, defaultOpen = true, color }) {
  const [open, setOpen] = useState(SECTION_DEFAULTS[id] !== undefined ? SECTION_DEFAULTS[id] : defaultOpen)

  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        const stored = (await storageRef.get('sectionState')) || {}
        if (mounted && stored[id] !== undefined) setOpen(!!stored[id])
      } catch (e) {
        /* ignore */
      }
    })()
    return () => { mounted = false }
  }, [id])

  const toggle = () => {
    const next = !open
    setOpen(next)
    SECTION_DEFAULTS[id] = next
    try {
      storageRef.get('sectionState').then(stored => {
        const base = stored || {}
        base[id] = next
        storageRef.set('sectionState', base)
      })
    } catch (e) {
      /* ignore */
    }
  }

  return jsxs('div', {
    className: 'border-b border-(--ui-stroke-secondary)',
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between gap-2 px-6 pb-1 pt-2.5',
        children: [
          jsx('button', {
            type: 'button',
            onClick: toggle,
            className:
              'group flex items-center gap-1.5 text-left text-[0.6875rem] font-medium uppercase tracking-wide text-(--ui-text-tertiary) transition-colors hover:text-(--ui-text-primary)',
            children: [
              color
                ? jsx('span', {
                    style: { background: color, opacity: 0.85 },
                    className: 'h-3 w-1 shrink-0 rounded-full'
                  })
                : null,
              jsx(Codicon, {
                name: open ? 'chevron-down' : 'chevron-right',
                size: '0.7rem',
                className: 'shrink-0 transition-transform'
              }),
              color
                ? jsx('span', { style: { color }, children: title })
                : jsx('span', { children: title })
            ]
          }),
          extra
            ? jsx('span', { className: 'text-xs', style: { color: 'var(--ui-text-secondary)' }, children: extra })
            : null
        ]
      }),
      open ? jsx('div', { children }) : null
    ]
  })
}

// ── Page ────────────────────────────────────────────────────────────────────

// Category completion chips (click to filter the grid).
function CategoryChips({ categories, active, onSelect }) {
  if (!categories || categories.length === 0) return null
  return jsxs('div', {
    className: 'flex flex-wrap gap-1.5 px-6 pb-2',
    children: categories.map(c => {
      const isActive = active === c.category
      const pct = c.total ? Math.round((c.unlocked / c.total) * 100) : 0
      const tint = categoryColor(c.category)
      return jsx('button', {
        key: c.category,
        type: 'button',
        onClick: () => onSelect(isActive ? null : c.category),
        className: cn(
          'flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors',
          isActive
            ? 'border-(--ui-accent)'
            : 'border-(--ui-stroke-secondary) hover:border-(--ui-stroke-strong)'
        ),
        style: {
          borderLeft: `3px solid ${isActive ? 'var(--ui-accent)' : tint}`,
          backgroundColor: isActive
            ? 'color-mix(in srgb, var(--ui-accent) 8%, transparent)'
            : `color-mix(in srgb, ${tint} 7%, transparent)`
        },
        children: [
          jsx('span', { className: 'h-2.5 w-2.5 shrink-0 rounded-full', style: { backgroundColor: tint } }),
          jsxs('span', {
            className: 'min-w-0 flex-1',
            children: [
              jsx('span', { className: 'block truncate text-xs font-medium', children: c.category }),
              jsxs('span', {
                className: 'block text-[0.625rem] tabular-nums',
                style: { color: 'var(--ui-text-secondary)' },
                children: [`${c.unlocked}/${c.total} unlocked`]
              })
            ]
          }),
          jsx('span', {
            className: 'shrink-0 text-[0.625rem] font-semibold tabular-nums',
            style: { color: tint },
            children: `${pct}%`
          })
        ]
      })
    })
  })
}

// Monthly + weekly challenge strips.
function ChallengesStrip({ challenges, weekly }) {
  const [ref, cols] = useCardCols()
  if ((!challenges || challenges.length === 0) && (!weekly || weekly.length === 0)) return null
  const renderRow = (title, list) =>
    jsxs('div', {
      className: 'mb-2 last:mb-0',
      children: [
        jsx('div', {
          className: 'mb-1.5 text-[0.6875rem] font-medium uppercase tracking-wide text-(--ui-text-tertiary)',
          children: title
        }),
        jsxs('div', {
          className: 'flex flex-wrap gap-2',
          style: { display: 'flex', flexWrap: 'wrap' },
          children: list.map(c =>
            jsxs('div', {
              key: c.id,
              className: cn(
                'flex flex-col rounded-lg border p-2',
                c.done
                  ? 'border-(--ui-ok)/50 bg-(--ui-ok)/10'
                  : 'border-(--ui-stroke-secondary) bg-(--ui-bg-secondary)'
              ),
              style: { width: cardWidth(Math.min(cols, 5)) },
              children: [
                jsxs('div', {
                  className: 'flex items-center justify-between gap-1',
                  children: [
                    jsx('span', { className: 'truncate text-[0.75rem] font-medium leading-tight', children: c.name }),
                    c.done
                      ? jsx('span', { className: 'shrink-0 text-[0.5625rem] font-medium text-(--ui-ok)', children: 'Done' })
                      : jsx('span', {
                          className: 'shrink-0 text-[0.5625rem] tabular-nums text-(--ui-text-quaternary)',
                          children: `${c.value}/${c.target}`
                        })
                  ]
                }),
                jsxs('div', {
                  className: 'mt-1.5 h-1 w-full overflow-hidden rounded-full bg-(--ui-bg-quaternary)',
                  children: [
                    jsx('div', {
                      className: cn('h-full rounded-full', c.done ? 'bg-(--ui-ok)' : 'bg-(--ui-accent)'),
                      style: { width: `${Math.min(100, c.pct || 0)}%` }
                    })
                  ]
                })
              ]
            })
          )
        })
      ]
    })

  return jsxs('div', {
    ref,
    className: 'px-6 pb-2.5',
    children: [
      challenges && challenges.length > 0 ? renderRow('This month', challenges) : null,
      weekly && weekly.length > 0 ? renderRow('This week', weekly) : null
    ]
  })
}

// ── Quests tab (all available quests + completion history) ─────────────────

function QuestsTab({ data }) {
  const quests = data?.quests || []
  const recent = data?.recently_completed_quests || []
  const [ref, cols] = useCardCols()

  if (quests.length === 0) {
    return jsx(EmptyState, {
      title: 'No quests available',
      description: 'Quests appear here once defined.'
    })
  }

  return jsx('div', {
    ref,
    className: 'flex-1 overflow-y-auto p-6',
    children: [
      recent.length > 0
        ? jsxs('div', {
            className: 'mb-5',
            children: [
              jsx('div', {
                className: 'mb-2 text-[0.6875rem] font-medium uppercase tracking-wide text-(--ui-text-tertiary)',
                children: 'Recently completed'
              }),
              jsx('ol', {
                className: 'relative space-y-3 border-l border-(--ui-stroke-secondary) pl-5',
                children: recent.map(q =>
                  jsxs('li', {
                    key: q.id,
                    className: 'relative',
                    children: [
                      jsx('span', {
                        style: { left: -26 },
                        className:
                          'absolute top-1 h-2.5 w-2.5 rounded-full bg-(--ui-ok) ring-4 ring-(--ui-bg-primary)'
                      }),
                      jsxs('div', {
                        className: 'flex items-center justify-between gap-2',
                        children: [
                          jsx('span', { className: 'text-sm font-medium', children: q.name }),
                          jsx('span', {
                            className: 'shrink-0 text-[0.6875rem] text-(--ui-text-quaternary)',
                            children: `${new Date((q.completed_at || 0) * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · +${q.xp} XP`
                          })
                        ]
                      }),
                      jsx('div', { className: 'mt-0.5 text-xs text-(--ui-text-tertiary)', children: q.description })
                    ]
                  })
                )
              })
            ]
          })
        : null,
      jsx('div', {
        className: 'mb-2 text-[0.6875rem] font-medium uppercase tracking-wide text-(--ui-text-tertiary)',
        children: `All quests (${quests.length})`
      }),
      jsxs('div', {
        className: 'flex flex-wrap gap-2',
        style: { display: 'flex', flexWrap: 'wrap' },
        children: quests.map(q =>
          jsxs('div', {
            key: q.id,
            className: cn(
              'flex flex-col rounded-lg border p-3',
              q.done
                ? 'border-(--ui-ok)/50 bg-(--ui-ok)/10'
                : 'border-(--ui-stroke-secondary) bg-(--ui-bg-secondary)'
            ),
            style: { width: cardWidth(Math.min(cols, 5)) },
            children: [
              jsxs('div', {
                className: 'flex items-center justify-between gap-1',
                children: [
                  jsx('span', { className: 'truncate text-[0.8125rem] font-medium leading-tight', children: q.name }),
                  jsx('span', {
                    className: cn(
                      'shrink-0 text-[0.625rem] font-medium',
                      q.done ? 'text-(--ui-ok)' : 'text-(--ui-text-quaternary)'
                    ),
                    children: q.done ? '✓ Done' : `+${q.xp} XP`
                  })
                ]
              }),
              jsx('div', { className: 'mt-1 text-xs leading-snug text-(--ui-text-tertiary)', children: q.description }),
              q.done && q.completed_at
                ? jsx('div', {
                    className: 'mt-2 text-[0.6875rem] text-(--ui-text-quaternary)',
                    children: `Completed ${new Date(q.completed_at * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                  })
                : null
            ]
          })
        )
      })
    ]
  })
}

function CustomGoalsSection({ data }) {
  const [name, setName] = useState('')
  const [metric, setMetric] = useState('session_count')
  const [target, setTarget] = useState('')
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState(null)
  const [ref, cols] = useCardCols()

  const goals = data.custom_goals || []
  const options = data.custom_metric_options || {}

  const create = async () => {
    const t = parseInt(target, 10)
    if (!name.trim() || !t || t <= 0) {
      host.notify({ kind: 'error', message: 'Give the goal a name and a positive target.' })
      return
    }
    setSaving(true)
    try {
      const res = await rest('/custom-goals', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), metric, target: t }),
        headers: { 'Content-Type': 'application/json' }
      })
      if (res && res.ok) {
        setName('')
        setTarget('')
        haptic('tap')
        await queryClient.invalidateQueries({ queryKey: ['hermes-achievements'] })
      } else {
        host.notify({ kind: 'error', message: `Create failed: ${res?.error || 'unknown'}` })
      }
    } catch (e) {
      host.notify({ kind: 'error', message: `Create failed: ${e?.message ?? e}` })
    } finally {
      setSaving(false)
    }
  }

  const remove = async id => {
    setRemoving(id)
    try {
      await rest(`/custom-goals/${encodeURIComponent(id)}`, { method: 'DELETE' })
      await queryClient.invalidateQueries({ queryKey: ['hermes-achievements'] })
    } catch (e) {
      host.notify({ kind: 'error', message: `Delete failed: ${e?.message ?? e}` })
    } finally {
      setRemoving(null)
    }
  }

  return jsxs('div', {
    ref,
    className: 'px-6 pb-2.5',
    children: [
      jsxs('div', {
        className: 'mb-2 flex flex-wrap items-center gap-1.5',
        children: [
          jsx('input', {
            className:
              'w-40 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) px-2 py-1 text-xs outline-none focus:border-(--ui-accent)',
            placeholder: 'Goal name…',
            value: name,
            onChange: e => setName(e.target.value)
          }),
          jsx('select', {
            className:
              'rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) px-2 py-1 text-xs outline-none focus:border-(--ui-accent)',
            value: metric,
            onChange: e => setMetric(e.target.value),
            children: Object.entries(options).map(([k, label]) =>
              jsx('option', { key: k, value: k, children: label })
            )
          }),
          jsx('input', {
            className:
              'w-20 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) px-2 py-1 text-xs tabular-nums outline-none focus:border-(--ui-accent)',
            placeholder: 'Target',
            type: 'number',
            min: 1,
            value: target,
            onChange: e => setTarget(e.target.value)
          }),
          jsx(Button, {
            variant: 'secondary',
            size: 'sm',
            disabled: saving,
            onClick: create,
            children: saving ? 'Adding…' : 'Add goal'
          })
        ]
      }),
      goals.length === 0
        ? jsx('p', {
            className: 'text-[0.6875rem] text-(--ui-text-quaternary)',
            children: 'No custom goals yet — set one above and watch it fill.'
          })
        : jsxs('div', {
            className: 'flex flex-wrap gap-2',
            style: { display: 'flex', flexWrap: 'wrap' },
            children: goals.map(g =>
              jsxs('div', {
                key: g.id,
                className: cn(
                  'flex flex-col rounded-lg border p-2',
                  g.done ? 'border-(--ui-ok)/50 bg-(--ui-ok)/10' : 'border-(--ui-stroke-secondary) bg-(--ui-bg-secondary)'
                ),
                style: { width: cardWidth(Math.min(cols, 5)) },
                children: [
                  jsxs('div', {
                    className: 'flex items-center justify-between gap-1',
                    children: [
                      jsx('span', { className: 'truncate text-[0.75rem] font-medium leading-tight', children: g.name }),
                      jsxs('div', {
                        className: 'flex shrink-0 items-center gap-1',
                        children: [
                          jsx('span', {
                            className: 'text-[0.5625rem] tabular-nums text-(--ui-text-quaternary)',
                            children: `${g.value}/${g.target}`
                          }),
                          jsx('button', {
                            type: 'button',
                            onClick: () => remove(g.id),
                            disabled: removing === g.id,
                            className:
                              'rounded border border-(--ui-stroke-secondary) px-1 text-[0.5625rem] transition-colors',
                            style: { color: 'var(--ui-text-secondary)' },
                            children: '✕'
                          })
                        ]
                      })
                    ]
                  }),
                  jsx('span', {
                    className: 'mt-0.5 truncate text-[0.5625rem] text-(--ui-text-quaternary)',
                    children: g.metric_label
                  }),
                  jsxs('div', {
                    className: 'mt-1 h-1 w-full overflow-hidden rounded-full bg-(--ui-bg-quaternary)',
                    children: [
                      jsx('div', {
                        className: cn('h-full rounded-full', g.done ? 'bg-(--ui-ok)' : 'bg-(--ui-accent)'),
                        style: { width: `${Math.min(100, g.pct || 0)}%` }
                      })
                    ]
                  })
                ]
              })
            )
          })
    ]
  })
}

function AchievementsPage() {
  const [filter, setFilter] = useState('badges')
  const [stateFilter, setStateFilter] = useState('all')
  const [q, setQ] = useState('')
  const [sort, setSort] = useState('progress')
  const [catFilter, setCatFilter] = useState(null)
  const [hoverItem, setHoverItem] = useState(null)
  const [pinned, setPinned] = useState([])
  const [rescinding, setRescinding] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const searchRef = useRef(null)
  const [gridRef, cols] = useCardCols()

  // Palette "Find a badge" focuses the search input on arrival.
  useEffect(() => {
    if (_pendingFind) {
      _pendingFind = false
      const t = setTimeout(() => {
        if (searchRef.current) searchRef.current.focus()
      }, 100)
      return () => clearTimeout(t)
    }
  }, [])

  // Persisted category filter (survives reloads).
  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        const stored = (await storageRef.get('catFilter')) || null
        if (mounted && stored) setCatFilter(stored)
        const pinnedStored = (await storageRef.get('pinned')) || []
        if (mounted && Array.isArray(pinnedStored)) setPinned(pinnedStored)
      } catch (e) {
        /* ignore */
      }
    })()
    return () => { mounted = false }
  }, [])

  const selectCat = cat => {
    const next = catFilter === cat ? null : cat
    setCatFilter(next)
    try {
      storageRef.set('catFilter', next)
    } catch (e) {
      /* ignore */
    }
  }

  const togglePin = id => {
    setPinned(prev => {
      const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
      try {
        storageRef.set('pinned', next)
      } catch (e) {
        /* ignore */
      }
      return next
    })
  }

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['hermes-achievements', 'all'],
    queryFn: () => rest('/achievements'),
    refetchInterval: 120_000
  })

  const rescan = async () => {
    setRescinding(true)
    try {
      await rest('/rescan', { method: 'POST' })
      await queryClient.invalidateQueries({ queryKey: ['hermes-achievements'] })
    } catch (e) {
      host.notify({ kind: 'error', message: `Achievements rescan failed: ${e?.message ?? e}` })
    } finally {
      setRescinding(false)
    }
  }

  if (isLoading) {
    return jsx('div', {
      className: 'grid h-full grid-cols-1 gap-4 overflow-y-auto p-6 sm:grid-cols-2 lg:grid-cols-3',
      children: Array.from({ length: 9 }, () =>
        jsx(Skeleton, { className: 'h-40 w-full rounded-lg' })
      )
    })
  }

  if (isError || !data) {
    return jsx(ErrorState, {
      title: 'Could not load achievements',
      description: `${error?.message ?? 'Unknown error'} — is the achievements plugin enabled?`,
      children: jsx(Button, { variant: 'secondary', onClick: () => refetch(), children: 'Retry' })
    })
  }

  const items = data.achievements || []
  // The Badges tab filters the grid by badge state (all/unlocked/discovered/secret).
  const shown = items.filter(a => stateFilter === 'all' || a.state === stateFilter)
  const query = q.trim().toLowerCase()
  const filtered = query
    ? shown.filter(a => `${a.name} ${a.description || ''}`.toLowerCase().includes(query))
    : shown
  const catFiltered = catFilter ? filtered.filter(a => (a.category || 'Other') === catFilter) : filtered
  const sorted = [...catFiltered].sort((a, b) => {
    const ap = pinned.includes(a.id) ? 0 : 1
    const bp = pinned.includes(b.id) ? 0 : 1
    if (ap !== bp) return ap - bp
    if (sort === 'name') return (a.name || '').localeCompare(b.name || '')
    if (sort === 'tier') return tierIndex(b.tier) - tierIndex(a.tier) || (b.progress_pct || 0) - (a.progress_pct || 0)
    if (a.unlocked !== b.unlocked) return a.unlocked ? 1 : -1
    return (b.progress_pct || 0) - (a.progress_pct || 0)
  })
  const nextUp = items
    .filter(a => !a.unlocked && a.state !== 'secret' && (a.progress_pct ?? 0) > 0)
    .sort((x, y) => (y.progress_pct ?? 0) - (x.progress_pct ?? 0))
    .slice(0, 3)

  // View logic: the filter tabs are the primary navigation by CONTENT TYPE.
  // - 'badges' = the achievement grid (state sub-filter + search + sort inside)
  // - 'goals' = monthly/weekly challenges + custom metric goals
  // - 'records' = personal bests + the activity heatmap
  // - 'rewards' = unlockable theme cards
  // - 'quests' / 'history' = dedicated views
  const isBadges = filter === 'badges'
  const isGoals = filter === 'goals'
  const isRecords = filter === 'records'
  const isRewards = filter === 'rewards'
  const isMain = isBadges

  return jsxs('div', {
    className: 'flex h-full flex-col overflow-y-auto',
    // Reserve a right gutter (320px ≈ w-72 panel + right-6 + gap) so the
    // fixed preview panel always floats over empty space, never over the
    // header/chips/grid content. Same docked-preview idea as the theme pack.
    style: { paddingRight: 320 },
    children: [
      jsx(ScoreHeader, { data, onRescan: rescan, rescinding, onOpenSettings: () => setSettingsOpen(true) }),
      // Primary navigation — pinned to the top of the scroll area so tabs
      // stay reachable while browsing badges, goals, records, or rewards.
      // Opaque chrome bg covers content scrolling underneath.
      jsxs('div', {
        className:
          'sticky top-0 z-20 flex flex-wrap items-center gap-2 border-b border-(--ui-stroke-secondary) bg-(--ui-bg-chrome) px-6 py-2',
        children: [
          jsxs('div', {
            className: 'flex items-center gap-1',
            children: FILTERS.map(f => {
              const meta = FILTER_TAB_META[f] || {}
              const active = filter === f
              return jsxs('button', {
                key: f,
                className: cn(
                  'flex items-center gap-1 rounded-md px-2.5 py-1 text-xs capitalize transition-all',
                  active
                    ? 'font-medium text-white shadow-md'
                    : 'text-(--ui-text-secondary) hover:bg-(--ui-bg-quaternary) hover:text-(--ui-text-primary)'
                ),
                style: active && meta.color
                  ? {
                      background: `linear-gradient(135deg, ${meta.color} 0%, ${meta.color}cc 100%)`,
                      boxShadow: `0 4px 14px ${meta.color}44`
                    }
                  : undefined,
                type: 'button',
                onClick: () => {
                  setHoverItem(null)
                  setFilter(f)
                },
                children: [
                  meta.icon ? jsx(Codicon, { name: meta.icon, size: '0.75rem' }) : null,
                  f
                ]
              })
            })
          }),
          isBadges
            ? jsxs('div', {
                className: 'flex items-center gap-1 border-l border-(--ui-stroke-secondary) pl-2',
                children: STATE_FILTERS.map(f => {
                  const count =
                    f === 'all'
                      ? data.total_count
                      : f === 'unlocked'
                        ? data.unlocked_count
                        : f === 'discovered'
                          ? data.discovered_count
                          : f === 'secret'
                            ? data.secret_count
                            : null
                  return jsx('button', {
                    key: f,
                    className: cn(
                      'rounded-md px-2 py-1 text-xs capitalize transition-colors',
                      stateFilter === f ? 'font-medium text-(--ui-accent)' : 'text-(--ui-text-secondary) hover:text-(--ui-text-primary)'
                    ),
                    style: stateFilter === f ? { backgroundColor: 'color-mix(in srgb, var(--ui-accent) 12%, transparent)' } : undefined,
                    type: 'button',
                    onClick: () => {
                      setHoverItem(null)
                      setStateFilter(f)
                    },
                    children: `${f} (${count})`
                  })
                })
              })
            : null,
          isBadges
            ? jsxs('div', {
                className: 'ml-auto flex items-center gap-2',
                children: [
                  jsx('input', {
                    ref: searchRef,
                    className:
                      'w-44 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) px-2 py-1 text-xs outline-none focus:border-(--ui-accent)',
                    placeholder: 'Search…',
                    value: q,
                    onChange: e => setQ(e.target.value)
                  }),
                  jsxs('div', {
                    className: 'flex items-center gap-1',
                    children: [
                      ['progress', 'Closest'],
                      ['tier', 'Tier'],
                      ['name', 'Name']
                    ].map(([k, label]) =>
                      jsx('button', {
                        key: k,
                        className: cn(
                          'rounded-md px-2 py-1 text-xs transition-colors',
                          sort === k ? 'font-medium text-(--ui-accent)' : 'text-(--ui-text-secondary) hover:text-(--ui-text-primary)'
                        ),
                        style: sort === k ? { backgroundColor: 'color-mix(in srgb, var(--ui-accent) 12%, transparent)' } : undefined,
                        type: 'button',
                        onClick: () => setSort(k),
                        children: label
                      })
                    )
                  })
                ]
              })
            : null
        ]
      }),
      isMain
        ? jsx(CategoryChips, { categories: data.categories, active: catFilter, onSelect: selectCat })
        : null,
      isMain ? jsx(MiniStats, { data }) : null,
      isBadges ? jsx(SessionBadges, {}) : null,
      isBadges ? jsx(NextUpStrip, { items: nextUp, onHover: setHoverItem, onLeave: () => setHoverItem(null) }) : null,
      isBadges ? jsx(RecentAchievements, {}) : null,
      isRecords
        ? jsx(Section, {
            id: 'records',
            title: 'Records',
            color: 'hsl(190 70% 48%)',
            children: jsx(RecordsStrip, { records: data.records })
          })
        : null,
      isRecords
        ? jsx(Section, {
            id: 'activity',
            title: 'Activity',
            color: 'hsl(205 85% 55%)',
            extra: `${(data.activity || []).filter(d => d.sessions > 0).length} active days · last 6 months`,
            children: jsx(ActivityHeatmap, { activity: data.activity })
          })
        : null,
      isRewards
        ? jsx(Section, {
            id: 'rewards',
            title: 'Rewards',
            color: 'hsl(45 90% 50%)',
            children: jsx(RewardsStrip, { rewards: data.rewards })
          })
        : null,
      isGoals
        ? jsx(Section, {
            id: 'goals',
            title: 'Goals',
            color: 'hsl(150 55% 45%)',
            children: jsx(ChallengesStrip, { challenges: data.challenges, weekly: data.weekly })
          })
        : null,
      isGoals
        ? jsx(Section, {
            id: 'custom-goals',
            title: 'Custom goals',
            color: 'hsl(0 70% 60%)',
            children: jsx(CustomGoalsSection, { data })
          })
        : null,
      filter === 'history'
        ? jsx(HistoryTab, {})
        : filter === 'custom'
          ? jsx(CustomTab, {})
          : filter === 'quests'
            ? jsx(QuestsTab, { data })
          : isBadges
            ? sorted.length === 0
              ? jsx(EmptyState, {
                  title: 'No achievements here',
                  description: query
                    ? `Nothing matches "${q}". Try a different search.`
                    : 'Nothing in this state yet — keep using Hermes.'
                })
              : jsx(Section, {
                  id: 'all-achievements',
                  title: 'All achievements',
                  color: 'hsl(220 60% 55%)',
                  extra: `${sorted.length} shown`,
                  children: jsx('div', {
                    ref: gridRef,
                    className: 'flex flex-wrap content-start gap-2 px-6 py-4',
                    style: { display: 'flex', flexWrap: 'wrap' },
                    children: sorted.map(a =>
                      jsx('div', {
                        key: a.id,
                        className: 'relative',
                        onMouseEnter: () => setHoverItem(a),
                        onMouseLeave: () => setHoverItem(null),
                        onFocus: () => setHoverItem(a),
                        onBlur: () => setHoverItem(null),
                        // Inline width (cols per row at 8px gap) because the
                        // app's Tailwind build only ships grid-cols-1/2/4/6 —
                        // plugin grid classes get purged. Same trick as the
                        // theme pack. Responsive via useCardCols.
                        style: { width: cardWidth(cols) },
                        children: jsx(AchievementCard, {
                          item: a,
                          pinned: pinned.includes(a.id),
                          onTogglePin: togglePin,
                          onCatClick: cat => {
                            setFilter('badges')
                            setStateFilter('all')
                            selectCat(cat)
                          }
                        })
                      })
                    )
                  })
                })
            : null,
      jsx(SettingsPanel, { open: settingsOpen, onClose: () => setSettingsOpen(false) }),
      jsx(AchievementPreviewPanel, { card: hoverItem })
    ]
  })
}

// ── Statusbar score chip ────────────────────────────────────────────────────

function ScoreChip() {
  const { data } = useQuery({
    queryKey: ['hermes-achievements', 'chip'],
    queryFn: () => rest('/achievements'),
    refetchInterval: 120_000
  })

  if (!data || !data.unlocked_count) return null

  const next = (data.achievements || [])
    .filter(a => !a.unlocked && a.state !== 'secret' && (a.progress_pct ?? 0) > 0)
    .sort((x, y) => (y.progress_pct ?? 0) - (x.progress_pct ?? 0))[0]

  const streak = (data.streak && data.streak.current_streak_days) || 0
  const streakLabel = streak >= 2 ? ` · 🔥 ${streak}-day streak` : ''

  const label = next
    ? `Achievements: ${data.unlocked_count}/${data.total_count} · Next: ${next.name} ${next.progress_pct}%${streakLabel}`
    : `Achievements: ${data.unlocked_count}/${data.total_count} — all unlocked!${streakLabel}`

  return jsx(Tip, {
    label,
    children: jsx('button', {
      className: cn(
        'inline-flex h-full items-center gap-1 rounded-none px-1.5 text-[0.6875rem] tabular-nums transition-colors',
        'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
      ),
      type: 'button',
      onClick: () => {
        haptic('tap')
        host.navigate('/achievements')
      },
      children: jsxs('span', {
        className: 'inline-flex items-center gap-1',
        children: [
          jsx(Codicon, { name: 'milestone', size: '0.7rem' }),
          jsx('span', { children: `${data.unlocked_count}/${data.total_count}` }),
          streak >= 2
            ? jsx('span', {
                className: 'inline-flex items-center gap-0.5',
                children: [
                  jsx('span', { children: '🔥' }),
                  jsx('span', { children: String(streak) })
                ]
              })
            : null
        ]
      })
    })
  })
}

// ── Plugin export ───────────────────────────────────────────────────────────

// Set by the palette "Find" command; AchievementsPage focuses its search
// input when it mounts with this flag.
let _pendingFind = false

export default {
  id: ID,
  name: 'Achievements',
  description:
    'Hermes achievement badges — collectible tiers from real session history. Read-only dashboard backed by the hermes-achievements plugin API, with unlock notifications, confetti celebrations, unlock history, custom achievements, and share cards.',
  defaultEnabled: true,
  register(ctx) {
    rest = ctx.rest
    storageRef = ctx.storage
    try {
      ctx.storage.get('settings').then(s => {
        if (s) _settings = { ...DEFAULT_SETTINGS, ...s }
      })
    } catch (e) {
      /* ignore */
    }
    startUnlockWatcher(ctx)

    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: '/achievements' },
        title: 'Achievements',
        render: () => jsx(AchievementsPage, {})
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        order: 55,
        data: { path: '/achievements', label: 'Achievements', codicon: 'milestone' }
      },
      {
        id: 'score',
        area: STATUSBAR_AREAS.right,
        order: 90,
        render: () => jsx(ScoreChip, {})
      },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'hermes-achievements.open',
          label: 'Achievements: Open',
          keywords: ['achievements', 'badges', 'tiers', 'trophy'],
          run: () => {
            haptic('tap')
            host.navigate('/achievements')
          }
        }
      },
      {
        id: 'find',
        area: PALETTE_AREA,
        data: {
          id: 'hermes-achievements.find',
          label: 'Achievements: Find a badge',
          keywords: ['achievements', 'search', 'find', 'badge', 'filter'],
          run: () => {
            haptic('tap')
            _pendingFind = true
            host.navigate('/achievements')
          }
        }
      }
    ])
  }
}
