#!/usr/bin/env node
/** Reproducible selector equivalence and microbenchmark; synthetic in-memory fixture only. */
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'

const LIMIT = 3
const SEED = 0x51a7
let state = SEED
const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x100000000)
const rank = (shot) => shot.kind === 'card' ? 1 : 0
const compare = (a, b) => rank(a) - rank(b)
  || String(a.captured_at || '').localeCompare(String(b.captured_at || ''))
  || Number(a.id) - Number(b.id)

function oldSelect(shots, groups, limit = LIMIT) {
  const byHit = new Map(), byPoint = new Map()
  for (const shot of shots) {
    if (shot.hit_id !== null) (byHit.get(shot.hit_id) || (byHit.set(shot.hit_id, []), byHit.get(shot.hit_id))).push(shot)
    if (shot.point_id !== null) (byPoint.get(shot.point_id) || (byPoint.set(shot.point_id, []), byPoint.get(shot.point_id))).push(shot)
  }
  const out = new Map()
  for (const group of groups) {
    const pool = []
    for (const hitId of group.hit_ids || []) pool.push(...(byHit.get(Number(hitId)) || []))
    const pointShots = byPoint.get(Number(group.point_id)) || []
    for (const shot of pointShots) {
      if (group.target && shot.target && String(shot.target) === String(group.target)) pool.push(shot)
      else if (group.asset_id !== null && group.asset_id !== undefined && shot.asset_id === group.asset_id) pool.push(shot)
    }
    for (const shot of pointShots) pool.push(shot)
    const seen = new Set()
    const picked = pool.sort(compare).filter((shot) => !seen.has(shot.id) && seen.add(shot.id)).slice(0, limit)
    out.set(Number(group.point_id), picked.map((shot) => shot.id))
  }
  return out
}

function newSelect(shots, groups, limit = LIMIT) {
  const byHit = new Map(), byPoint = new Map()
  for (const shot of shots) {
    if (shot.hit_id !== null) (byHit.get(shot.hit_id) || (byHit.set(shot.hit_id, []), byHit.get(shot.hit_id))).push(shot)
    if (shot.point_id !== null) (byPoint.get(shot.point_id) || (byPoint.set(shot.point_id, []), byPoint.get(shot.point_id))).push(shot)
  }
  const out = new Map()
  for (const group of groups) {
    const seen = new Set(), picked = []
    const consider = (shot) => {
      if (shot === undefined || shot === null || seen.has(shot.id)) return
      seen.add(shot.id)
      let lo = 0, hi = picked.length
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (compare(picked[mid], shot) <= 0) lo = mid + 1
        else hi = mid
      }
      if (lo < limit) {
        picked.splice(lo, 0, shot)
        if (picked.length > limit) picked.pop()
      }
    }
    for (const hitId of group.hit_ids || []) for (const shot of byHit.get(Number(hitId)) || []) consider(shot)
    for (const shot of byPoint.get(Number(group.point_id)) || []) consider(shot)
    out.set(Number(group.point_id), picked.map((shot) => shot.id))
  }
  return out
}

function fixture({ shotCount, pointCount, hitCount, hitsPerGroup, duplicates = 0 }) {
  const shots = Array.from({ length: shotCount }, (_, id) => {
    const point = Math.floor(random() * pointCount)
    return {
      id, point_id: random() < 0.03 ? null : point,
      hit_id: random() < 0.2 ? Math.floor(random() * hitCount) : null,
      kind: random() < 0.2 ? 'card' : 'screenshot',
      captured_at: random() < 0.04 ? null : (random() < 0.04 ? '' : `2026-01-${String(1 + Math.floor(random() * 28)).padStart(2, '0')}T00:00:${String(Math.floor(random() * 60)).padStart(2, '0')}Z`),
      target: random() < 0.5 ? `host-${Math.floor(random() * 20)}` : null,
      asset_id: random() < 0.5 ? Math.floor(random() * 50) : null,
    }
  })
  const groups = Array.from({ length: pointCount }, (_, point_id) => {
    const hit_ids = Array.from({ length: hitsPerGroup }, () => Math.floor(random() * hitCount))
    for (let i = 0; i < duplicates; i++) hit_ids.push(hit_ids[i % Math.max(1, hit_ids.length)] ?? 0)
    return { point_id, hit_ids, target: `host-${point_id % 20}`, asset_id: point_id % 50 }
  })
  return { shots, groups }
}

function measure(fn, shots, groups, rounds = 25) {
  for (let i = 0; i < 5; i++) fn(shots, groups)
  const times = []
  for (let i = 0; i < rounds; i++) {
    const start = performance.now()
    fn(shots, groups)
    times.push(performance.now() - start)
  }
  times.sort((a, b) => a - b)
  return { medianMs: +times[Math.floor(times.length / 2)].toFixed(2), p95Ms: +times[Math.ceil(times.length * 0.95) - 1].toFixed(2), rounds }
}

const propertyFixture = fixture({ shotCount: 4000, pointCount: 16, hitCount: 900, hitsPerGroup: 90, duplicates: 20 })
assert.deepEqual([...newSelect([], [])], [...oldSelect([], [])], 'empty set')
assert.deepEqual([...newSelect(propertyFixture.shots, propertyFixture.groups)], [...oldSelect(propertyFixture.shots, propertyFixture.groups)], 'fixed-seed full ordered ids')

const workloads = [
  { name: 'typical', shotCount: 3000, pointCount: 40, hitCount: 500, hitsPerGroup: 10, duplicates: 2 },
  { name: 'tail', shotCount: 30000, pointCount: 20, hitCount: 2000, hitsPerGroup: 100, duplicates: 20 },
]
const results = workloads.map((workload) => {
  const { name, ...shape } = workload
  const { shots, groups } = fixture(shape)
  assert.deepEqual([...newSelect(shots, groups)], [...oldSelect(shots, groups)], `${name} ordered ids`)
  return { name, shots: shots.length, groups: groups.length, hits: shape.hitCount, hitsPerGroup: shape.hitsPerGroup,
    candidateUpperBound: groups.reduce((sum, group) => sum + group.hit_ids.length, 0) + shots.length,
    old: measure(oldSelect, shots, groups), optimized: measure(newSelect, shots, groups) }
})
console.log(JSON.stringify({ seed: `0x${SEED.toString(16)}`, node: process.version, property: 'pass', results }, null, 2))
