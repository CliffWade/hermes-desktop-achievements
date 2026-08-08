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
const FILTERS = ['all', 'unlocked', 'discovered', 'secret', 'history', 'custom']
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

function progressBarClass(state) {
  if (state === 'unlocked') return 'bg-(--ui-accent)'
  return 'bg-(--ui-text-tertiary)'
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

// ── History timeline ────────────────────────────────────────────────────────

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
      description: 'Your unlock timeline will appear here.'
    })
  }

  return jsx('div', {
    className: 'flex-1 overflow-y-auto p-6',
    children: jsx('ol', {
      className: 'relative space-y-4 border-l border-(--ui-stroke-secondary) pl-5',
      children: items.map(a =>
        jsxs('li', {
          key: a.id,
          className: 'relative',
          children: [
            jsx('span', {
              className:
                'absolute -left-[26px] top-1 h-2.5 w-2.5 rounded-full bg-(--ui-accent) ring-4 ring-(--ui-bg-primary)'
            }),
            jsxs('div', {
              className: 'flex flex-wrap items-center gap-2',
              children: [
                jsx('span', { className: 'text-sm font-medium', children: a.name }),
                a.tier
                  ? jsx(Badge, {
                      variant: 'outline',
                      className: cn('text-[0.6875rem]', tierBadgeClass(a.tier)),
                      children: a.tier
                    })
                  : null,
                jsx('span', {
                  className: 'text-[0.6875rem] text-(--ui-text-tertiary)',
                  children: a.unlocked_at ? relativeTime(a.unlocked_at * 1000) : ''
                }),
                jsx('button', {
                  type: 'button',
                  onClick: () => celebrate({ name: a.name, tier: a.tier }, {}),
                  className:
                    'text-[0.6875rem] text-(--ui-text-tertiary) underline decoration-dotted underline-offset-2 hover:text-(--ui-text-primary)',
                  children: 'replay'
                })
              ]
            }),
            a.evidence && a.evidence.title
              ? jsx('div', {
                  className: 'mt-0.5 text-[0.6875rem] text-(--ui-text-quaternary)',
                  children: 'evidence: ' + a.evidence.title
                })
              : null
          ]
        })
      )
    })
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
        className: 'w-[420px] max-w-full rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-primary) p-5 shadow-2xl',
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
              'absolute right-0 top-full z-20 mt-1 w-36 overflow-hidden rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-primary) shadow-xl',
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
                children: 'Badge wall'
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
        className: 'flex flex-col gap-4 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-primary) p-5 shadow-2xl',
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
  const now = Date.now() / 1000
  const week = 7 * 24 * 3600
  const unlocked = items.filter(a => a.unlocked)
  const thisWeek = unlocked.filter(a => a.unlocked_at && now - a.unlocked_at < week).length
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
  const tierLine = TIER_ORDER.filter(t => byTier[t])
    .map(t => `${byTier[t]} ${t}`)
    .join(' · ')

  return jsxs('div', {
    className:
      'flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-(--ui-stroke-secondary) px-6 py-2 text-[0.6875rem] text-(--ui-text-tertiary)',
    children: [
      jsx('span', { children: `${thisWeek} unlocked this week` }),
      busiest ? jsx('span', { children: `busiest day: ${busiest[0]}` }) : null,
      tierLine ? jsx('span', { children: tierLine }) : null
    ]
  })
}

// ── Activity heatmap (GitHub-style contribution graph) ────────────────────

function ActivityHeatmap({ activity }) {
  if (!activity || activity.length === 0) return null

  // Find the max tools-per-day for intensity scaling (0 → empty, 4 levels).
  const max = Math.max(1, ...activity.map(d => d.tools || 0))
  const levels = ['bg-(--ui-bg-quaternary)', 'bg-(--ui-accent)/25', 'bg-(--ui-accent)/55', 'bg-(--ui-accent)/80', 'bg-(--ui-accent)']
  const levelFor = d => {
    if (!d.sessions) return 0
    const ratio = (d.tools || 0) / max
    if (ratio <= 0) return 0
    if (ratio < 0.25) return 1
    if (ratio < 0.5) return 2
    if (ratio < 0.75) return 3
    return 4
  }

  const weekdayLabels = ['Mon', 'Wed', 'Fri']
  const monthLabels = []
  {
    let last = null
    for (const d of activity) {
      const dt = new Date(d.date + 'T00:00:00')
      const m = dt.toLocaleDateString('en-US', { month: 'short' })
      if (m !== last) {
        monthLabels.push({ m, date: d.date })
        last = m
      }
    }
  }

  // Group by week (columns). Day-of-week from date; Monday-first.
  const weeks = []
  for (const d of activity) {
    const dt = new Date(d.date + 'T00:00:00')
    const dow = (dt.getDay() + 6) % 7 // Mon=0 ... Sun=6
    let week = weeks[weeks.length - 1]
    if (!week || week.length >= 7) {
      week = []
      weeks.push(week)
    }
    // Pad to the day-of-week so each week column aligns.
    while (week.length < dow) week.push(null)
    week.push(d)
  }
  // Pad the last week to full height.
  const lastWeek = weeks[weeks.length - 1]
  if (lastWeek) while (lastWeek.length < 7) lastWeek.push(null)

  const totalDays = activity.filter(d => d.sessions > 0).length
  const totalTools = activity.reduce((n, d) => n + (d.tools || 0), 0)

  return jsxs('div', {
    className: 'border-b border-(--ui-stroke-secondary) px-6 py-4',
    children: [
      jsxs('div', {
        className: 'mb-2 flex items-baseline justify-between',
        children: [
          jsx('div', {
            className: 'text-[0.6875rem] font-medium uppercase tracking-wide text-(--ui-text-tertiary)',
            children: 'Activity'
          }),
          jsx('span', {
            className: 'text-[0.6875rem] text-(--ui-text-quaternary)',
            children: `${totalDays} active days · ${totalTools.toLocaleString()} tool calls · last 12 months`
          })
        ]
      }),
      jsxs('div', {
        className: 'overflow-x-auto',
        children: [
          jsxs('div', {
            className: 'flex gap-1',
            children: [
              jsxs('div', {
                className: 'flex flex-col justify-between py-0.5 pr-1 text-[0.625rem] text-(--ui-text-quaternary)',
                children: [
                  jsx('span', { children: 'Mon' }),
                  jsx('span', { children: 'Wed' }),
                  jsx('span', { children: 'Fri' })
                ]
              }),
              jsxs('div', {
                className: 'flex gap-[3px]',
                children: weeks.map((week, wi) =>
                  jsx('div', {
                    key: wi,
                    className: 'flex flex-col gap-[3px]',
                    children: week.map((d, di) =>
                      d === null
                        ? jsx('div', { key: di, className: 'h-2.5 w-2.5 rounded-[2px] bg-transparent' })
                        : jsx('div', {
                            key: di,
                            title: `${d.date}: ${d.sessions} session${d.sessions === 1 ? '' : 's'}, ${d.tools} tool calls`,
                            className: cn('h-2.5 w-2.5 rounded-[2px]', levels[levelFor(d)])
                          })
                    )
                  })
                )
              })
            ]
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
    className: 'border-b border-(--ui-stroke-secondary) px-6 py-2.5',
    children: [
      jsx('div', {
        className: 'mb-1.5 text-[0.6875rem] font-medium uppercase tracking-wide text-(--ui-text-tertiary)',
        children: 'Rewards'
      }),
      jsxs('div', {
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
            // Inline width (6 per row at 8px gap) — purge-proof, same
            // density as the achievement grid below.
            style: { width: 'calc((100% - 40px) / 6)' },
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
              jsx('span', {
                className: 'mt-1 truncate text-[0.625rem] leading-tight text-(--ui-text-tertiary)',
                title: r.description,
                children: r.description
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
                        const m = /longest streak: (\d+)/.exec(r.progress || '')
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
  const { unlocked_count, discovered_count, secret_count, total_count } = data
  const pct = total_count ? Math.round((unlocked_count / total_count) * 100) : 0
  const level = data.level || {}
  const xpPct = level.xp_for_next ? Math.round((level.xp_in_level / level.xp_for_next) * 100) : 0

  return jsxs('div', {
    className: 'border-b border-(--ui-stroke-secondary) px-6 py-4',
    children: [
      jsxs('div', {
        className: 'flex items-start justify-between gap-4',
        children: [
          jsxs('div', {
            children: [
              jsxs('div', {
                className: 'flex items-baseline gap-3',
                children: [
                  jsx('span', {
                    className: 'text-3xl font-semibold tabular-nums',
                    children: `${unlocked_count}/${total_count}`
                  }),
                  jsx('span', {
                    className: 'text-sm text-(--ui-text-secondary)',
                    children: `unlocked · ${pct}%`
                  })
                ]
              }),
              jsxs('div', {
                className: 'mt-1 flex items-center gap-3 text-xs text-(--ui-text-tertiary)',
                children: [
                  jsx('span', { children: `${discovered_count} discovered` }),
                  jsx('span', { children: `${secret_count} secret` }),
                  level.level
                    ? jsxs('span', {
                        className: 'inline-flex items-center gap-1 rounded-md border border-(--ui-stroke-secondary) px-1.5 py-0.5 text-[0.6875rem] font-medium text-(--ui-text-primary)',
                        children: [
                          jsx('span', { children: `Lv ${level.level}` }),
                          jsx('span', { className: 'text-(--ui-text-tertiary)', children: level.name })
                        ]
                      })
                    : null,
                  data.generated_at
                    ? jsx('span', {
                        children: `scanned ${relativeTime(data.generated_at * 1000)}`
                      })
                    : null,
                  data.is_stale
                    ? jsx(Badge, { variant: 'warn', children: 'stale' })
                    : null
                ]
              })
            ]
          }),
          jsxs('div', {
            className: 'flex items-center gap-2',
            children: [
              jsx(ExportMenu, { data }),
              jsx('button', {
                type: 'button',
                onClick: onOpenSettings,
                className:
                  'inline-flex h-7 items-center gap-1 rounded-md border border-(--ui-stroke-secondary) px-2 text-xs text-(--ui-text-tertiary) transition-colors hover:text-(--ui-text-primary)',
                children: jsxs('span', {
                  className: 'inline-flex items-center gap-1',
                  children: [jsx(Codicon, { name: 'settings', size: '0.8rem' }), 'Settings']
                })
              }),
              jsx(Button, {
                variant: 'secondary',
                size: 'sm',
                disabled: rescinding,
                onClick: onRescan,
                children: rescinding ? 'Scanning…' : 'Rescan'
              })
            ]
          })
        ]
      }),
      jsxs('div', {
        className: 'mt-4',
        children: [
          level.level
            ? jsxs('div', {
                className: 'flex items-center justify-between text-[0.625rem] text-(--ui-text-tertiary)',
                children: [
                  jsx('span', { children: `Level ${level.level} · ${level.name}` }),
                  jsx('span', {
                    className: 'tabular-nums',
                    children: `${level.xp_in_level}/${level.xp_for_next} XP → ${level.next_name}`
                  })
                ]
              })
            : null,
          jsxs('div', {
            className: 'mt-1 h-1.5 w-full overflow-hidden rounded-full bg-(--ui-bg-quaternary)',
            children: [
              jsx('div', {
                className: cn('h-full rounded-full transition-all', 'bg-(--ui-accent)'),
                style: { width: `${Math.min(100, pct)}%` }
              })
            ]
          }),
          level.level
            ? jsxs('div', {
                className: 'mt-1 h-1 w-full overflow-hidden rounded-full bg-(--ui-bg-quaternary)',
                children: [
                  jsx('div', {
                    className: cn('h-full rounded-full transition-all', 'bg-(--ui-text-tertiary)'),
                    style: { width: `${Math.min(100, xpPct)}%` }
                  })
                ]
              })
            : null
        ]
      })
    ]
  })
}

// ── Next up strip ───────────────────────────────────────────────────────────

function NextUpStrip({ items }) {
  if (!items || items.length === 0) return null

  return jsxs('div', {
    className: 'border-b border-(--ui-stroke-secondary) px-6 py-2.5',
    children: [
      jsx('div', {
        className: 'mb-1.5 text-[0.6875rem] font-medium uppercase tracking-wide text-(--ui-text-tertiary)',
        children: 'Next up'
      }),
      jsxs('div', {
        className: 'flex flex-wrap gap-2',
        style: { display: 'flex', flexWrap: 'wrap' },
        children: items.map(a =>
          jsxs('div', {
            key: a.id,
            className: 'flex flex-col rounded-lg border border-(--ui-stroke-secondary) p-2',
            // Inline width (6 per row at 8px gap) — purge-proof, same
            // density as the achievement grid below. Category identity
            // matches the main cards: left accent + tinted fill.
            style: {
              width: 'calc((100% - 40px) / 6)',
              borderLeft: `3px solid ${categoryColor(a.category)}`,
              backgroundColor: categoryBg(a.category)
            },
            children: [
              jsxs('div', {
                className: 'flex items-center justify-between gap-1',
                children: [
                  jsx('span', { className: 'truncate text-[0.8125rem] font-medium leading-tight', children: a.name }),
                  jsx('span', {
                    className: 'shrink-0 text-[0.625rem] tabular-nums text-(--ui-text-tertiary)',
                    children: `${a.progress_pct ?? 0}%`
                  })
                ]
              }),
              jsxs('div', {
                className: 'mt-1.5 h-1 w-full overflow-hidden rounded-full bg-(--ui-bg-quaternary)',
                children: [
                  jsx('div', {
                    className: 'h-full rounded-full bg-(--ui-accent)',
                    style: { width: `${Math.min(100, a.progress_pct ?? 0)}%` }
                  })
                ]
              }),
              jsx('span', {
                className: 'mt-1 inline-block text-[0.5625rem] font-medium uppercase tracking-wide',
                style: { color: categoryColor(a.category) },
                children: a.category
              }),
              a.next_tier
                ? jsx('div', {
                    className: 'mt-0.5 flex items-center justify-between gap-1 text-[0.5625rem] text-(--ui-text-quaternary)',
                    children: [
                      jsx('span', { className: 'truncate', children: `next: ${a.next_tier} · ${a.next_threshold}` }),
                      a.eta_days
                        ? jsx('span', {
                            className: 'shrink-0 tabular-nums',
                            children: `~${a.eta_days}d`
                          })
                        : null
                    ]
                  })
                : null
            ]
          })
        )
      })
    ]
  })
}

// ── Session context ─────────────────────────────────────────────────────────

function SessionBadges() {
  const sessionId = useValue(host.state.activeSessionId)
  const { data, isLoading } = useQuery({
    queryKey: ['hermes-achievements', 'session', sessionId ?? 'none'],
    queryFn: () =>
      sessionId
        ? rest('/sessions/' + encodeURIComponent(sessionId) + '/badges', { timeoutMs: 8000 })
        : Promise.resolve({ badges: [] }),
    enabled: !!sessionId,
    refetchInterval: 60_000,
    staleTime: 30_000
  })

  if (!sessionId) return null

  const badges = data?.badges || []

  return jsxs('div', {
    className: 'border-b border-(--ui-stroke-secondary) px-6 py-3',
    children: [
      jsxs('div', {
        className: 'flex flex-wrap items-center gap-2 text-xs',
        children: [
          jsx('span', {
            className: 'text-(--ui-text-tertiary)',
            children: isLoading
              ? 'Checking this session…'
              : badges.length
                ? `Earned this session (${badges.length}):`
                : 'No badges this session yet.'
          }),
          ...badges.map(b =>
            jsx(Badge, {
              key: b.id,
              variant: 'outline',
              className: tierBadgeClass(b.tier),
              children: b.tier ? `${b.name} · ${b.tier}` : b.name
            })
          )
        ]
      })
    ]
  })
}

// ── Achievement card ────────────────────────────────────────────────────────

function AchievementCard({ item, onCatClick }) {
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
      'relative flex flex-col rounded-lg border p-2.5',
      item.unlocked
        ? 'border-(--ui-stroke-strong)'
        : 'border-(--ui-stroke-secondary)',
      isSecret && 'opacity-70'
    ),
    // Category identity: 3px left accent + soft tinted fill. Unlocked cards
    // keep their tint but the border goes strong so state stays readable.
    style: {
      borderLeft: `3px solid ${categoryColor(item.category)}`,
      backgroundColor: categoryBg(item.category)
    },
    children: [
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
                          'inline-flex items-center gap-0.5 rounded-md border border-(--ui-stroke-secondary) px-1 py-0.5 text-[0.625rem] text-(--ui-text-tertiary) transition-colors hover:text-(--ui-text-primary)',
                        children: jsxs('span', {
                          className: 'inline-flex items-center gap-0.5',
                          children: [jsx(Codicon, { name: 'play', size: '0.625rem' }), 'Replay']
                        })
                      }),
                      jsx('button', {
                        type: 'button',
                        onClick: () => setShareOpen(true),
                        className:
                          'inline-flex items-center gap-0.5 rounded-md border border-(--ui-stroke-secondary) px-1 py-0.5 text-[0.625rem] text-(--ui-text-tertiary) transition-colors hover:text-(--ui-text-primary)',
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
        className: 'mt-1.5 line-clamp-2 text-[0.6875rem] leading-snug text-(--ui-text-tertiary)',
        children: isSecret ? 'Secret achievement — hidden until the first matching signal appears.' : item.description
      }),
      jsx('button', {
        type: 'button',
        onClick: e => {
          e.stopPropagation()
          onCatClick && onCatClick(item.category)
        },
        title: `Filter: ${item.category}`,
        className:
          'mt-1 inline-block self-start text-[0.5625rem] font-medium uppercase tracking-wide transition-opacity hover:opacity-70',
        style: { color: categoryColor(item.category) },
        children: item.category
      }),
      jsxs('div', {
        className: 'mt-1.5',
        children: [
          jsxs('div', {
            className: 'flex items-center justify-between text-[0.625rem] text-(--ui-text-tertiary)',
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
                className: cn('h-full rounded-full', progressBarClass(item.state)),
                style: { width: `${isSecret ? 0 : Math.min(100, pct)}%` }
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
                className: 'text-[0.625rem] text-(--ui-text-tertiary) underline decoration-dotted underline-offset-2 hover:text-(--ui-text-primary)',
                type: 'button',
                onClick: () => setOpen(o => !o),
                children: open ? 'Hide what counts' : 'What counts?'
              }),
              open
                ? jsx('p', {
                    className: 'mt-1 text-[0.625rem] leading-snug text-(--ui-text-tertiary)',
                    children: item.criteria
                  })
                : null
            ]
          })
        : null,
      item.evidence && item.evidence.title
        ? jsx('p', {
            className: 'mt-1 truncate text-[0.625rem] text-(--ui-text-quaternary)',
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
    className: 'pointer-events-none fixed right-6 top-24 z-30 w-72 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-primary) p-3 shadow-2xl',
    style: { borderLeft: `3px solid ${categoryColor(item.category)}` },
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
                className: cn('h-full rounded-full', progressBarClass(item.state)),
                style: { width: `${isSecret ? 0 : Math.min(100, pct)}%` }
              })
            ]
          })
        : null
    ]
  })
}

// ── Personal records strip ──────────────────────────────────────────────────

function RecordsStrip({ records }) {
  if (!records) return null
  const items = [
    records.best_day ? { label: 'Best day', value: `${records.best_day.tool_calls.toLocaleString()} calls`, sub: records.best_day.date } : null,
    records.busiest_day ? { label: 'Busiest day', value: `${records.busiest_day.sessions} sessions`, sub: records.busiest_day.date } : null,
    records.biggest_session ? { label: 'Biggest session', value: records.biggest_session.title, sub: `${records.biggest_session.tool_calls} calls` } : null,
    records.longest_session ? { label: 'Longest session', value: records.longest_session.title, sub: `${records.longest_session.messages} msgs` } : null
  ].filter(Boolean)
  if (items.length === 0) return null

  return jsxs('div', {
    className: 'border-b border-(--ui-stroke-secondary) px-6 py-2.5',
    children: [
      jsx('div', {
        className: 'mb-1.5 text-[0.6875rem] font-medium uppercase tracking-wide text-(--ui-text-tertiary)',
        children: 'Records'
      }),
      jsxs('div', {
        className: 'flex flex-wrap gap-2',
        style: { display: 'flex', flexWrap: 'wrap' },
        children: items.map(it =>
          jsxs('div', {
            className: 'flex flex-col rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) p-2',
            style: { width: 'calc((100% - 24px) / 4)' },
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

// ── Quests strip (combo requirements with bonus XP) ─────────────────────────

function QuestsStrip({ quests }) {
  if (!quests || quests.length === 0) return null
  return jsxs('div', {
    className: 'border-b border-(--ui-stroke-secondary) px-6 py-2.5',
    children: [
      jsx('div', {
        className: 'mb-1.5 text-[0.6875rem] font-medium uppercase tracking-wide text-(--ui-text-tertiary)',
        children: 'Quests'
      }),
      jsxs('div', {
        className: 'flex flex-wrap gap-2',
        style: { display: 'flex', flexWrap: 'wrap' },
        children: quests.map(q =>
          jsxs('div', {
            key: q.id,
            className: cn(
              'flex flex-col rounded-lg border p-2',
              q.done ? 'border-(--ui-ok)/50 bg-(--ui-ok)/10' : 'border-(--ui-stroke-secondary) bg-(--ui-bg-secondary)'
            ),
            style: { width: 'calc((100% - 32px) / 5)' },
            children: [
              jsxs('div', {
                className: 'flex items-center justify-between gap-1',
                children: [
                  jsx('span', { className: 'truncate text-[0.75rem] font-medium leading-tight', children: q.name }),
                  q.done
                    ? jsx('span', { className: 'shrink-0 text-[0.5625rem] font-medium text-(--ui-ok)', children: `+${q.xp} XP` })
                    : jsx('span', { className: 'shrink-0 text-[0.5625rem] tabular-nums text-(--ui-text-quaternary)', children: `+${q.xp} XP` })
                ]
              }),
              jsx('span', {
                className: 'mt-0.5 line-clamp-2 text-[0.625rem] leading-snug text-(--ui-text-tertiary)',
                children: q.description
              }),
              q.done
                ? jsx('span', { className: 'mt-1 text-[0.5625rem] font-medium text-(--ui-ok)', children: 'Complete' })
                : null
            ]
          })
        )
      })
    ]
  })
}

// ── Page ────────────────────────────────────────────────────────────────────

// Category completion chips (click to filter the grid).
function CategoryChips({ categories, active, onSelect }) {
  if (!categories || categories.length === 0) return null
  return jsxs('div', {
    className: 'flex flex-wrap gap-1.5 border-b border-(--ui-stroke-secondary) px-6 py-2',
    children: categories.map(c => {
      const isActive = active === c.category
      return jsx('button', {
        key: c.category,
        type: 'button',
        onClick: () => onSelect(isActive ? null : c.category),
        title: `${c.category}: ${c.unlocked}/${c.total} unlocked`,
        className: cn(
          'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[0.625rem] transition-colors',
          isActive
            ? 'border-(--ui-accent) bg-(--ui-accent)/10 text-(--ui-text-primary)'
            : 'border-(--ui-stroke-secondary) text-(--ui-text-tertiary) hover:text-(--ui-text-primary)'
        ),
        children: [
          jsx('span', {
            className: 'h-2 w-2 rounded-full',
            style: { backgroundColor: categoryColor(c.category) }
          }),
          jsx('span', { children: c.category }),
          jsx('span', {
            className: 'tabular-nums text-(--ui-text-quaternary)',
            children: `${c.unlocked}/${c.total}`
          })
        ]
      })
    })
  })
}

// Monthly + weekly challenge strips.
function ChallengesStrip({ challenges, weekly }) {
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
              style: { width: 'calc((100% - 32px) / 5)' },
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
    className: 'border-b border-(--ui-stroke-secondary) px-6 py-2.5',
    children: [
      challenges && challenges.length > 0 ? renderRow('This month', challenges) : null,
      weekly && weekly.length > 0 ? renderRow('This week', weekly) : null
    ]
  })
}

// Custom metric goals section (goal-based custom badges).
function CustomGoalsSection({ data }) {
  const [name, setName] = useState('')
  const [metric, setMetric] = useState('session_count')
  const [target, setTarget] = useState('')
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState(null)

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
    className: 'border-b border-(--ui-stroke-secondary) px-6 py-2.5',
    children: [
      jsx('div', {
        className: 'mb-1.5 text-[0.6875rem] font-medium uppercase tracking-wide text-(--ui-text-tertiary)',
        children: 'Custom goals'
      }),
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
                style: { width: 'calc((100% - 32px) / 5)' },
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
                            title: 'Delete goal',
                            className:
                              'rounded border border-(--ui-stroke-secondary) px-1 text-[0.5625rem] text-(--ui-text-tertiary) transition-colors hover:text-(--ui-error)',
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
  const [filter, setFilter] = useState('all')
  const [q, setQ] = useState('')
  const [sort, setSort] = useState('progress')
  const [catFilter, setCatFilter] = useState(null)
  const [hoverItem, setHoverItem] = useState(null)
  const [rescinding, setRescinding] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

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
  const shown = items.filter(a => filter === 'all' || a.state === filter)
  const query = q.trim().toLowerCase()
  const filtered = query
    ? shown.filter(a => `${a.name} ${a.description || ''}`.toLowerCase().includes(query))
    : shown
  const catFiltered = catFilter ? filtered.filter(a => (a.category || 'Other') === catFilter) : filtered
  const sorted = [...catFiltered].sort((a, b) => {
    if (sort === 'name') return (a.name || '').localeCompare(b.name || '')
    if (sort === 'tier') return tierIndex(b.tier) - tierIndex(a.tier) || (b.progress_pct || 0) - (a.progress_pct || 0)
    if (a.unlocked !== b.unlocked) return a.unlocked ? 1 : -1
    return (b.progress_pct || 0) - (a.progress_pct || 0)
  })
  const nextUp = items
    .filter(a => !a.unlocked && a.state !== 'secret' && (a.progress_pct ?? 0) > 0)
    .sort((x, y) => (y.progress_pct ?? 0) - (x.progress_pct ?? 0))
    .slice(0, 3)

  return jsxs('div', {
    className: 'flex h-full min-h-0 flex-col',
    // Reserve a right gutter (320px ≈ w-72 panel + right-6 + gap) so the
    // fixed preview panel always floats over empty space, never over the
    // header/chips/grid content. Same docked-preview idea as the theme pack.
    style: { paddingRight: 320 },
    children: [
      jsx(ScoreHeader, { data, onRescan: rescan, rescinding, onOpenSettings: () => setSettingsOpen(true) }),
      filter !== 'history' && filter !== 'custom'
        ? jsx(CategoryChips, { categories: data.categories, active: catFilter, onSelect: setCatFilter })
        : null,
      filter !== 'history' && filter !== 'custom' ? jsx(MiniStats, { data }) : null,
      filter !== 'history' && filter !== 'custom' ? jsx(ActivityHeatmap, { activity: data.activity }) : null,
      filter !== 'history' && filter !== 'custom' ? jsx(RewardsStrip, { rewards: data.rewards }) : null,
      filter !== 'history' && filter !== 'custom' ? jsx(RecordsStrip, { records: data.records }) : null,
      filter !== 'history' && filter !== 'custom' ? jsx(ChallengesStrip, { challenges: data.challenges, weekly: data.weekly }) : null,
      filter !== 'history' && filter !== 'custom' ? jsx(QuestsStrip, { quests: data.quests }) : null,
      filter !== 'history' && filter !== 'custom' ? jsx(CustomGoalsSection, { data }) : null,
      filter !== 'history' && filter !== 'custom' ? jsx(SessionBadges, {}) : null,
      filter === 'all' ? jsx(NextUpStrip, { items: nextUp }) : null,
      jsxs('div', {
        className: 'flex flex-wrap items-center gap-2 border-b border-(--ui-stroke-secondary) px-6 py-2',
        children: [
          jsxs('div', {
            className: 'flex items-center gap-1',
            children: FILTERS.map(f => {
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
                  'rounded-md px-2.5 py-1 text-xs capitalize transition-colors',
                  filter === f
                    ? 'bg-(--ui-bg-quaternary) text-(--ui-text-primary)'
                    : 'text-(--ui-text-tertiary) hover:text-(--ui-text-primary)'
                ),
                type: 'button',
                onClick: () => {
                  setHoverItem(null)
                  setFilter(f)
                },
                children: count === null ? f : `${f} (${count})`
              })
            })
          }),
          filter !== 'history' && filter !== 'custom'
            ? jsxs('div', {
                className: 'ml-auto flex items-center gap-2',
                children: [
                  jsx('input', {
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
                          sort === k
                            ? 'bg-(--ui-bg-quaternary) text-(--ui-text-primary)'
                            : 'text-(--ui-text-tertiary) hover:text-(--ui-text-primary)'
                        ),
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
      filter === 'history'
        ? jsx(HistoryTab, {})
        : filter === 'custom'
          ? jsx(CustomTab, {})
          : sorted.length === 0
            ? jsx(EmptyState, {
                title: 'No achievements here',
                description: query
                  ? `Nothing matches "${q}". Try a different search.`
                  : 'Nothing in this state yet — keep using Hermes.'
              })
            : jsx('div', {
                className: 'flex flex-wrap content-start gap-2 overflow-y-auto p-4',
                style: { display: 'flex', flexWrap: 'wrap' },
                children: sorted.map(a =>
                  jsx('div', {
                    key: a.id,
                    className: 'relative',
                    onMouseEnter: () => setHoverItem(a),
                    onMouseLeave: () => setHoverItem(null),
                    onFocus: () => setHoverItem(a),
                    onBlur: () => setHoverItem(null),
                    // Inline width (6 per row at 8px gap) because the app's
                    // Tailwind build only ships grid-cols-1/2/4/6 — plugin
                    // grid classes get purged. Same trick as the theme pack.
                    style: { width: 'calc((100% - 40px) / 6)' },
                    children: jsx(AchievementCard, {
                      item: a,
                      onCatClick: cat => {
                        setFilter('all')
                        setCatFilter(catFilter === cat ? null : cat)
                      }
                    })
                  })
                )
              }),
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
      }
    ])
  }
}
