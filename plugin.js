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

const DEFAULT_SETTINGS = { confetti: true, sound: true, haptic: true, discordWebhook: '' }
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

function notifyUnlock(a) {
  celebrate(a)
  const tier = a.tier ? ` [${a.tier}]` : ''
  host.notify({ kind: 'success', message: `Achievement unlocked: ${a.name}${tier}` })
  postToWebhook(`🏆 Achievement unlocked: ${a.name}${tier}`)
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

// ── Header / score strip ────────────────────────────────────────────────────

function ScoreHeader({ data, onRescan, rescinding, onOpenSettings }) {
  const { unlocked_count, discovered_count, secret_count, total_count } = data
  const pct = total_count ? Math.round((unlocked_count / total_count) * 100) : 0

  return jsxs('div', {
    className: 'border-b border-(--ui-stroke-secondary) px-6 py-5',
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
        className: 'mt-4 h-1.5 w-full overflow-hidden rounded-full bg-(--ui-bg-quaternary)',
        children: [
          jsx('div', {
            className: cn('h-full rounded-full transition-all', 'bg-(--ui-accent)'),
            style: { width: `${Math.min(100, pct)}%` }
          })
        ]
      })
    ]
  })
}

// ── Next up strip ───────────────────────────────────────────────────────────

function NextUpStrip({ items }) {
  if (!items || items.length === 0) return null

  return jsxs('div', {
    className: 'border-b border-(--ui-stroke-secondary) px-6 py-4',
    children: [
      jsx('div', {
        className: 'mb-2 text-[0.6875rem] font-medium uppercase tracking-wide text-(--ui-text-tertiary)',
        children: 'Next up'
      }),
      jsxs('div', {
        className: 'grid grid-cols-1 gap-2 sm:grid-cols-3',
        children: items.map(a =>
          jsxs('div', {
            key: a.id,
            className: 'rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) p-3',
            children: [
              jsxs('div', {
                className: 'flex items-center justify-between gap-2',
                children: [
                  jsx('span', { className: 'truncate text-xs font-medium', children: a.name }),
                  jsx('span', {
                    className: 'shrink-0 text-[0.6875rem] tabular-nums text-(--ui-text-tertiary)',
                    children: `${a.progress_pct ?? 0}%`
                  })
                ]
              }),
              jsxs('div', {
                className: 'mt-2 h-1 w-full overflow-hidden rounded-full bg-(--ui-bg-quaternary)',
                children: [
                  jsx('div', {
                    className: 'h-full rounded-full bg-(--ui-accent)',
                    style: { width: `${Math.min(100, a.progress_pct ?? 0)}%` }
                  })
                ]
              }),
              a.next_tier
                ? jsx('div', {
                    className: 'mt-1.5 text-[0.6875rem] text-(--ui-text-quaternary)',
                    children: `next: ${a.next_tier} · ${a.next_threshold}`
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

function AchievementCard({ item }) {
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
      'flex flex-col rounded-lg border p-4',
      item.unlocked
        ? 'border-(--ui-stroke-strong) bg-(--ui-bg-tertiary)'
        : 'border-(--ui-stroke-secondary) bg-(--ui-bg-secondary)',
      isSecret && 'opacity-70'
    ),
    children: [
      jsxs('div', {
        className: 'flex items-start justify-between gap-2',
        children: [
          jsxs('div', {
            className: 'flex min-w-0 items-center gap-2',
            children: [
              jsx(Codicon, {
                name: 'milestone',
                className: cn('shrink-0', item.unlocked ? 'text-(--ui-accent)' : 'text-(--ui-text-tertiary)')
              }),
              jsx('span', {
                className: 'truncate text-sm font-medium',
                children: isSecret ? '???' : item.name
              })
            ]
          }),
          jsxs('div', {
            className: 'flex shrink-0 items-center gap-1.5',
            children: [
              isNew
                ? jsx(Badge, {
                    variant: 'outline',
                    className: 'shrink-0 text-[0.6875rem] text-(--ui-accent)',
                    children: 'NEW'
                  })
                : null,
              item.tier
                ? jsx(Badge, {
                    variant: 'outline',
                    className: cn('shrink-0 text-[0.6875rem]', tierBadgeClass(item.tier)),
                    children: item.tier
                  })
                : item.unlocked
                  ? jsx(Badge, {
                      variant: 'outline',
                      className: 'shrink-0 text-[0.6875rem] text-(--ui-accent)',
                      children: 'Earned'
                    })
                  : null,
              item.unlocked && !isSecret
                ? jsxs('div', {
                    className: 'flex shrink-0 items-center gap-1.5',
                    children: [
                      jsx('button', {
                        type: 'button',
                        onClick: () => celebrate({ name: item.name, tier: item.tier }, {}),
                        className:
                          'inline-flex items-center gap-1 rounded-md border border-(--ui-stroke-secondary) px-1.5 py-0.5 text-[0.6875rem] text-(--ui-text-tertiary) transition-colors hover:text-(--ui-text-primary)',
                        children: jsxs('span', {
                          className: 'inline-flex items-center gap-1',
                          children: [jsx(Codicon, { name: 'play', size: '0.75rem' }), 'Replay']
                        })
                      }),
                      jsx('button', {
                        type: 'button',
                        onClick: () => setShareOpen(true),
                        className:
                          'inline-flex items-center gap-1 rounded-md border border-(--ui-stroke-secondary) px-1.5 py-0.5 text-[0.6875rem] text-(--ui-text-tertiary) transition-colors hover:text-(--ui-text-primary)',
                        children: jsxs('span', {
                          className: 'inline-flex items-center gap-1',
                          children: [jsx(Codicon, { name: 'share', size: '0.75rem' }), 'Share']
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
        className: 'mt-2 line-clamp-2 text-xs leading-relaxed text-(--ui-text-tertiary)',
        children: isSecret ? 'Secret achievement — hidden until the first matching signal appears.' : item.description
      }),
      jsxs('div', {
        className: 'mt-3',
        children: [
          jsxs('div', {
            className: 'flex items-center justify-between text-[0.6875rem] text-(--ui-text-tertiary)',
            children: [
              jsx('span', {
                children: item.unlocked ? (item.next_tier ? `next: ${item.next_tier} · ${item.next_threshold}` : 'max tier') : (item.next_tier ? `next: ${item.next_tier} · ${item.next_threshold}` : '')
              }),
              jsx('span', { className: 'tabular-nums', children: isSecret ? '' : `${pct}%` })
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
            className: 'mt-3',
            children: [
              jsx('button', {
                className: 'text-[0.6875rem] text-(--ui-text-tertiary) underline decoration-dotted underline-offset-2 hover:text-(--ui-text-primary)',
                type: 'button',
                onClick: () => setOpen(o => !o),
                children: open ? 'Hide what counts' : 'What counts?'
              }),
              open
                ? jsx('p', {
                    className: 'mt-1.5 text-[0.6875rem] leading-relaxed text-(--ui-text-tertiary)',
                    children: item.criteria
                  })
                : null
            ]
          })
        : null,
      item.evidence && item.evidence.title
        ? jsx('p', {
            className: 'mt-2 truncate text-[0.6875rem] text-(--ui-text-quaternary)',
            children: 'evidence: ' + item.evidence.title
          })
        : null,
      shareOpen
        ? jsx(ShareCardOverlay, { item, onClose: () => setShareOpen(false) })
        : null
    ]
  })
}

// ── Page ────────────────────────────────────────────────────────────────────

function AchievementsPage() {
  const [filter, setFilter] = useState('all')
  const [q, setQ] = useState('')
  const [sort, setSort] = useState('progress')
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
  const sorted = [...filtered].sort((a, b) => {
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
    children: [
      jsx(ScoreHeader, { data, onRescan: rescan, rescinding, onOpenSettings: () => setSettingsOpen(true) }),
      filter !== 'history' && filter !== 'custom' ? jsx(MiniStats, { data }) : null,
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
                onClick: () => setFilter(f),
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
                className: 'grid flex-1 auto-rows-min grid-cols-1 gap-4 overflow-y-auto p-6 sm:grid-cols-2 lg:grid-cols-3',
                children: sorted.map(a => jsx(AchievementCard, { key: a.id, item: a }))
              }),
      jsx(SettingsPanel, { open: settingsOpen, onClose: () => setSettingsOpen(false) })
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

  const label = next
    ? `Achievements: ${data.unlocked_count}/${data.total_count} · Next: ${next.name} ${next.progress_pct}%`
    : `Achievements: ${data.unlocked_count}/${data.total_count} — all unlocked!`

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
          jsx('span', { children: `${data.unlocked_count}/${data.total_count}` })
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
