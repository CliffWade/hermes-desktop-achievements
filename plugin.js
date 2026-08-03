/**
 * Hermes Achievements — desktop plugin.
 *
 * Full achievements page + sidebar nav + statusbar score chip, backed by the
 * existing hermes-achievements dashboard plugin API (mounted at
 * /api/plugins/hermes-achievements/ — same plugin id in ~/.hermes/plugins/).
 * Read-only UI + rescan trigger. Plain ESM loaded uncompiled: UI is jsx()
 * calls, NOT JSX syntax; only @hermes/plugin-sdk, react, react/jsx-runtime
 * resolve.
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
  useQuery
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useState } from 'react'

const ID = 'hermes-achievements'

// Assigned in register(ctx) — components can't see ctx directly.
let rest

const TIER_ORDER = ['Copper', 'Silver', 'Gold', 'Diamond', 'Olympian']
const FILTERS = ['all', 'unlocked', 'discovered', 'secret']

function tierIndex(tier) {
  return tier ? TIER_ORDER.indexOf(tier) : -1
}

function tierBadgeClass(tier) {
  // Tier is conveyed by label + a subtle theme-safe accent, never hardcoded
  // colors. Higher tiers get a stronger visual weight via opacity/emphasis.
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

// ── Header / score strip ────────────────────────────────────────────────────

function ScoreHeader({ data, onRescan, rescinding }) {
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
          jsx(Button, {
            variant: 'secondary',
            size: 'sm',
            disabled: rescinding,
            onClick: onRescan,
            children: rescinding ? 'Scanning…' : 'Rescan'
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

// ── Achievement card ────────────────────────────────────────────────────────

function AchievementCard({ item }) {
  const [open, setOpen] = useState(false)
  const isSecret = item.state === 'secret'
  const pct = item.progress_pct ?? 0

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
              : null
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
        : null
    ]
  })
}

// ── Page ────────────────────────────────────────────────────────────────────

function AchievementsPage() {
  const [filter, setFilter] = useState('all')
  const [rescinding, setRescinding] = useState(false)

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

  return jsxs('div', {
    className: 'flex h-full min-h-0 flex-col',
    children: [
      jsx(ScoreHeader, { data, onRescan: rescan, rescinding }),
      jsxs('div', {
        className: 'flex items-center gap-1 border-b border-(--ui-stroke-secondary) px-6 py-2',
        children: FILTERS.map(f => {
          const count =
            f === 'all'
              ? data.total_count
              : f === 'unlocked'
                ? data.unlocked_count
                : f === 'discovered'
                  ? data.discovered_count
                  : data.secret_count
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
            children: `${f} (${count})`
          })
        })
      }),
      shown.length === 0
        ? jsx(EmptyState, {
            title: 'No achievements here',
            description: 'Nothing in this state yet — keep using Hermes.'
          })
        : jsx('div', {
            className: 'grid flex-1 auto-rows-min grid-cols-1 gap-4 overflow-y-auto p-6 sm:grid-cols-2 lg:grid-cols-3',
            children: shown.map(a => jsx(AchievementCard, { key: a.id, item: a }))
          })
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

  return jsx(Tip, {
    label: `Achievements: ${data.unlocked_count}/${data.total_count} unlocked`,
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
  description: 'Hermes achievement badges — collectible tiers from real session history. Read-only dashboard backed by the hermes-achievements plugin API.',
  defaultEnabled: true,
  register(ctx) {
    rest = ctx.rest

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
