#!/usr/bin/env node
/** Reproducible end-to-end scoreReport benchmark using a temporary SQLite fixture. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { deflateSync, inflateSync } from 'node:zlib'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { RedteamStore } from '../lib/redteam/store-core.js'

const WORKLOADS = [
  { name: 'smoke', hits: 100 },
  { name: '1k', hits: 1000 },
  { name: '2k', hits: 2000 },
]
const WARMUPS = 1
const ROUNDS = 5
const MAX_HITS = process.env.SCORE_REPORT_BENCH_MAX_HITS
  ? Number.parseInt(process.env.SCORE_REPORT_BENCH_MAX_HITS, 10)
  : Infinity
assert(Number.isFinite(MAX_HITS) || MAX_HITS === Infinity, 'SCORE_REPORT_BENCH_MAX_HITS must be an integer')
assert(MAX_HITS > 0, 'SCORE_REPORT_BENCH_MAX_HITS must be positive')
const FIXTURE_SEED = 'score-report-bench-v1'
const FIXTURE_CIDR = '198.18.0.0/16'
const FIXTURE_AT = '2026-01-01T00:00:00.000Z'
function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii')
  const chunk = Buffer.concat([name, data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(chunk))
  return Buffer.concat([length, chunk, crc])
}

const PNG_1X1 = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])),
  pngChunk('IDAT', deflateSync(Buffer.from([0, 32, 64, 80, 255]))),
  pngChunk('IEND', Buffer.alloc(0)),
])

function verifyFixturePng(buf) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  assert.ok(buf.subarray(0, 8).equals(sig), 'fixture should have a PNG signature')
  let offset = 8
  let idat = Buffer.alloc(0)
  let sawIend = false
  while (offset + 12 <= buf.length) {
    const size = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const end = offset + 12 + size
    assert.ok(end <= buf.length, `PNG ${type} chunk should be complete`)
    const chunk = buf.subarray(offset + 4, offset + 8 + size)
    assert.equal(buf.readUInt32BE(offset + 8 + size), crc32(chunk), `PNG ${type} CRC`)
    if (type === 'IHDR') assert.deepEqual([buf.readUInt32BE(offset + 8), buf.readUInt32BE(offset + 12)], [1, 1])
    if (type === 'IDAT') idat = Buffer.concat([idat, buf.subarray(offset + 8, offset + 8 + size)])
    if (type === 'IEND') { sawIend = true; break }
    offset = end
  }
  assert.ok(sawIend, 'PNG should contain IEND')
  assert.equal(inflateSync(idat).length, 5, '1x1 PNG scanline should decode')
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

function crc32(buf) {
  let crc = 0xffffffff
  for (const byte of buf) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    medianMs: +sorted[Math.floor(sorted.length / 2)].toFixed(2),
    maxMs: +sorted[sorted.length - 1].toFixed(2),
    rounds: sorted.length,
  }
}

function stableReport(report) {
  return {
    target: report.target,
    summary: report.summary,
    itemCount: report.items.length,
    markdownBytes: Buffer.byteLength(report.markdown),
    markdownSha256: createHash('sha256').update(report.markdown).digest('hex'),
  }
}

function buildFixture(store, engagementId, count) {
  const db = store.db(engagementId)
  const point = db.prepare(`INSERT INTO score_point
    (code,name,category,points,max_hits,description,enabled,sort_order,created_at,updated_at,src,rule,tier,cap,dedup_scope,legacy,builtin)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'bench-report-point', 'Benchmark fixture point', 'OTHER', 10, 0,
    'Synthetic scoreReport benchmark fixture', 1, 1, FIXTURE_SEED, FIXTURE_SEED,
    null, null, null, 0, 'none', 0, 0,
  )
  const pointId = Number(point.lastInsertRowid)
  const insertAsset = db.prepare(`INSERT INTO asset
    (segment_cidr,ip,ip_int,state,primary_name,first_seen,last_seen,discovered_at)
    VALUES(?,?,?,?,?,?,?,?)`)
  const insertVuln = db.prepare(`INSERT INTO vuln
    (asset_id,title,severity,status,evidence,target,found_at,gained)
    VALUES(?,?,?,?,?,?,?,?)`)
  const insertStep = db.prepare(`INSERT INTO attack_step
    (seq,stage,stage_code,title,detail,asset_id,vuln_id,point_id,tool,result,recorded_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
  const insertHit = db.prepare(`INSERT INTO score_hit
    (point_id,asset_id,vuln_id,step_id,target,evidence,note,self_created,port,recorded_by,recorded_at,points,multiplier)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  const insertEvidence = db.prepare(`INSERT INTO http_evidence
    (vuln_id,asset_id,label,method,url,status,request,response,note,captured_by,captured_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
  const shotBytes = PNG_1X1
  const pngDimensions = verifyFixturePng(shotBytes)
  assert.deepEqual(pngDimensions, { width: 1, height: 1 })
  const at = FIXTURE_AT
  const targetHost = (i) => `198.18.${Math.floor(i / 254)}.${(i % 254) + 1}`
  const ipInCidr = (host) => {
    const [a, b, c, d] = host.split('.').map(Number)
    assert.equal(a, 198, `${host} must be in ${FIXTURE_CIDR}`)
    assert.equal(b, 18, `${host} must be in ${FIXTURE_CIDR}`)
    assert.ok(c >= 0 && c <= 255 && d >= 1 && d <= 254, `${host} must be in ${FIXTURE_CIDR}`)
    return (((a * 256 + b) * 256 + c) * 256 + d) >>> 0
  }
  db.exec('BEGIN')
  try {
    for (let i = 0; i < count; i++) {
      const host = targetHost(i)
      const ipInt = ipInCidr(host)
      const target = `http://${host}/item/${i}`
      const asset = insertAsset.run(FIXTURE_CIDR, host, ipInt, 'active', `fixture-${i}`, at, at, at)
      const assetId = Number(asset.lastInsertRowid)
      const vuln = insertVuln.run(assetId, `Synthetic finding ${i}`, 'medium', 'confirmed', `fixture evidence ${i}`, target, at, 'test access')
      const vulnId = Number(vuln.lastInsertRowid)
      const step = insertStep.run(i + 1, 'exploit', 'exploit', `Synthetic action ${i}`, `Fixture trace ${i}`,
        assetId, vulnId, pointId, 'fixture-tool --verify', `synthetic-result-${i}`, at)
      const stepId = Number(step.lastInsertRowid)
      const hit = insertHit.run(pointId, assetId, vulnId, stepId, target, `Synthetic verified result ${i}`,
        'deterministic fixture', 0, null, 'benchmark', at, 10, 1)
      const hitId = Number(hit.lastInsertRowid)
      const crlf = String.fromCharCode(13, 10)
      const request = [`GET /item/${i} HTTP/1.1`, `Host: ${host}`, '', ''].join(crlf)
      assert.equal(request.split(crlf)[0], `GET /item/${i} HTTP/1.1`)
      assert.equal(/^Host: ([0-9.]+)$/m.exec(request)?.[1], host, `${count} hits: Host should match target`)
      insertEvidence.run(vulnId, assetId, `Fixture request ${i}`, 'GET', target, 200,
        request, ['HTTP/1.1 200 OK', '', 'fixture'].join(crlf),
        'synthetic benchmark evidence', 'benchmark', at)
      if (i === 0) {
        const shot = store.addShot(engagementId, { hit_id: hitId, asset_id: assetId, vuln_id: vulnId,
          target, label: 'Benchmark fixture shot', note: 'Synthetic valid 1x1 PNG', file: 'bench-evidence.png',
          data_base64: shotBytes.toString('base64'), captured_at: at })
        assert.ok(shot.ok)
        const saved = store.db(engagementId).prepare('SELECT width,height,mime,bytes FROM shot WHERE id = ?').get(shot.id)
        assert.deepEqual([saved.width, saved.height, saved.mime, saved.bytes], [1, 1, 'image/png', shotBytes.length])
      }
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return { hitCount: count, pointId }
}

function buildCoverageFixture(store, engagementId) {
  const db = store.db(engagementId)
  const insertPoint = db.prepare(`INSERT INTO score_point
    (code,name,category,points,max_hits,description,enabled,sort_order,created_at,updated_at,src,rule,tier,cap,dedup_scope,legacy,builtin)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  const insertAsset = db.prepare(`INSERT INTO asset (segment_cidr,ip,ip_int,state,primary_name,first_seen,last_seen,discovered_at)
    VALUES(?,?,?,?,?,?,?,?)`)
  const insertHit = db.prepare(`INSERT INTO score_hit
    (point_id,asset_id,vuln_id,step_id,target,evidence,note,self_created,port,recorded_by,recorded_at,points,multiplier)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  const host = (n) => `198.18.200.${n}`
  const addPoint = (code, enabled = 1, cap = 0, rule = null, dedup = 'none') => Number(insertPoint.run(
    code, code, 'OTHER', 10, 0, 'coverage fixture', enabled, 10, FIXTURE_AT, FIXTURE_AT,
    null, rule, null, cap, dedup, 0, 0,
  ).lastInsertRowid)
  const addAsset = (n) => Number(insertAsset.run(FIXTURE_CIDR, host(n), 0, 'active', `coverage-${n}`,
    FIXTURE_AT, FIXTURE_AT, FIXTURE_AT).lastInsertRowid)
  const addHit = ({ pointId, assetId, target, evidence, selfCreated = 0, stepId = null, vulnId = null }) => Number(insertHit.run(
    pointId, assetId, vulnId, stepId, target, evidence, 'coverage fixture', selfCreated, null,
    'benchmark', FIXTURE_AT, 10, 1,
  ).lastInsertRowid)

  db.exec('BEGIN')
  try {
    // Keep cap behavior isolated from the main workload's ordinary points.
    const disabledPoint = addPoint('coverage-disabled', 0)
    const disabledAsset = addAsset(1)
    addHit({ pointId: disabledPoint, assetId: disabledAsset, target: host(1), evidence: 'disabled hit' })

    const ordinaryPoint = addPoint('coverage-self-created')
    const selfAsset = addAsset(2)
    addHit({ pointId: ordinaryPoint, assetId: selfAsset, target: host(2), evidence: 'self-created hit', selfCreated: 1 })
    addHit({ pointId: ordinaryPoint, assetId: addAsset(3), target: host(3), evidence: 'ordinary hit' })

    const servicePoint = addPoint('coverage-service-dedup', 1, 0, null, 'service')
    const serviceAsset = addAsset(4)
    addHit({ pointId: servicePoint, assetId: serviceAsset, target: `${host(4)}:8080`, evidence: 'service winner' })
    addHit({ pointId: servicePoint, assetId: serviceAsset, target: `${host(4)}:8080`, evidence: 'service duplicate' })

    const groupedPoint = addPoint('coverage-group')
    const groupAsset = addAsset(6)
    const groupStep = Number(db.prepare(`INSERT INTO attack_step
      (seq,stage,stage_code,title,detail,asset_id,point_id,tool,result,recorded_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(5000, 'exploit', 'exploit', 'Grouped action', 'same batch',
      groupAsset, groupedPoint, 'fixture-batch --run', 'completed', FIXTURE_AT).lastInsertRowid)
    for (let i = 0; i < 5; i++) addHit({ pointId: groupedPoint, assetId: groupAsset, target: host(6 + i),
      evidence: `Grouped success ${i}`, stepId: groupStep })

    const tracePoint = addPoint('coverage-traces')
    const traceAsset = addAsset(20)
    const vulnId = Number(db.prepare(`INSERT INTO vuln
      (asset_id,title,severity,status,evidence,target,found_at,gained) VALUES(?,?,?,?,?,?,?,?)`)
      .run(traceAsset, 'Trace finding', 'high', 'confirmed', 'trace fixture', `http://${host(20)}/trace`, FIXTURE_AT, 'access').lastInsertRowid)
    const traceStep = Number(db.prepare(`INSERT INTO attack_step
      (seq,stage,stage_code,title,detail,asset_id,vuln_id,point_id,tool,result,recorded_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(6000, 'exploit', 'exploit', 'Trace command', 'trace fixture',
      traceAsset, vulnId, tracePoint, 'fixture-cli --trace', 'trace-result', FIXTURE_AT).lastInsertRowid)
    const traceHit = addHit({ pointId: tracePoint, assetId: traceAsset, target: `http://${host(20)}/trace`,
      evidence: 'trace fixture account fixture-user-2048 secret pass-phrase-2048', stepId: traceStep })
    db.prepare(`INSERT INTO credential (asset_id,host,username,secret_type,secret_value,privilege,source,tool,found_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(traceAsset, host(20), 'fixture-user-2048', 'password', 'pass-phrase-2048',
      'admin', 'fixture', 'fixture source', FIXTURE_AT)
    db.prepare(`INSERT INTO webshell (asset_id,url,shell_type,pass_key,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)`).run(traceAsset, `http://${host(20)}/shell.php`, 'antsword', 'fixture-key', 'active', FIXTURE_AT, FIXTURE_AT)
    db.prepare(`INSERT INTO tunnel (asset_id,kind,listen,entry,reach,entry_kind,status,command,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(traceAsset, 'socks5', '127.0.0.1:1080', host(20), '10.20.0.0/24',
      'target-outbound', 'active', 'fixture-tunnel --start', FIXTURE_AT, FIXTURE_AT)

    const insertTraceStep = db.prepare(`INSERT INTO attack_step
      (seq,stage,stage_code,title,detail,asset_id,vuln_id,point_id,tool,result,recorded_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    const traceFallbacks = []
    const addTraceCase = ({ name, n, source, stepPoint, withVuln = false, pointStep = false }) => {
      const pointId = addPoint(`coverage-trace-${name}`)
      const assetId = addAsset(n)
      const vulnId = withVuln ? Number(db.prepare(`INSERT INTO vuln
        (asset_id,title,severity,status,evidence,target,found_at,gained) VALUES(?,?,?,?,?,?,?,?)`)
        .run(assetId, `${name} finding`, 'medium', 'confirmed', `${name} evidence`, `http://${host(n)}/finding`,
          FIXTURE_AT, 'fixture').lastInsertRowid) : null
      if (withVuln || stepPoint !== undefined || pointStep) {
        insertTraceStep.run(6100 + n, 'exploit', 'exploit', name, 'trace source fixture', assetId, vulnId,
          stepPoint ?? pointId, 'fixture --trace', 'done', FIXTURE_AT)
      }
      const hitId = addHit({ pointId, assetId, target: `trace-${name}-${n}`, evidence: `${name} trace`, vulnId })
      traceFallbacks.push({ name, hitId, source })
      return { pointId, assetId, hitId }
    }
    const vulnTrace = addTraceCase({ name: 'vuln', n: 40, source: 'vuln', withVuln: true })
    const pointTrace = addTraceCase({ name: 'point', n: 41, source: 'point', pointStep: true })
    const assetTrace = addTraceCase({ name: 'asset', n: 42, source: 'asset', stepPoint: addPoint('coverage-unmatched-point') })
    addTraceCase({ name: 'none', n: 43, source: null })

    const insertHttpEvidence = db.prepare(`INSERT INTO http_evidence
      (asset_id,label,method,url,status,request,response,note,captured_at) VALUES(?,?,?,?,?,?,?,?,?)`)
    const urlCases = []
    const addUrlCase = ({ name, n, targetPath, evidencePath, evidenceHost, global = false }) => {
      const pointId = addPoint(`coverage-url-${name}`)
      const assetId = addAsset(n)
      const targetHost = host(n)
      const target = `http://${targetHost}${targetPath}`
      const hitId = addHit({ pointId, assetId, target, evidence: `${name} URL fallback` })
      const evidenceAsset = global ? addAsset(n + 100) : assetId
      const crlf = String.fromCharCode(13, 10)
      insertHttpEvidence.run(evidenceAsset, `url-${name}`, 'GET', `http://${evidenceHost || targetHost}${evidencePath}`,
        200, [`GET ${evidencePath} HTTP/1.1`, `Host: ${evidenceHost || targetHost}`, '', ''].join(crlf),
        'HTTP/1.1 200 OK', 'URL candidate fixture', FIXTURE_AT)
      urlCases.push({ name, hitId, expectedLabel: `url-${name}` })
    }
    addUrlCase({ name: 'authority-first', n: 50, targetPath: '/api/v1/users/7', evidencePath: '/api/v1/health' })
    addUrlCase({ name: 'authority-second', n: 51, targetPath: '/api/v1/users/7', evidencePath: '/api/health' })
    addUrlCase({ name: 'authority-only', n: 52, targetPath: '/api/v1/users/7', evidencePath: '/' })
    addUrlCase({ name: 'path-only', n: 53, targetPath: '/api/v1/users/7', evidenceHost: '198.18.250.1', evidencePath: '/api/v1/health' })
    addUrlCase({ name: 'global', n: 54, targetPath: '/api/v1/users/7', evidencePath: '/api/v1/health', global: true })
    db.exec('COMMIT')
    const report = store.scoreReport(engagementId, { limit: 2000 })
    const items = report.items
    assert.equal(report.summary.serviceCappedExcluded, 1, 'exactly one same-service duplicate should be excluded')
    assert.equal(report.summary.disabledExcluded, 1, 'exactly one disabled hit should be excluded')
    assert.equal(report.summary.selfCreatedExcluded, 1, 'exactly one self-created hit should be excluded')
    assert.deepEqual(report.summary.serviceCapped.map((x) => x.evidence), ['service duplicate'],
      'the duplicate same-service hit should be the excluded row')
    const capBoard = store.listScorePoints(engagementId)
    assert.equal(capBoard.summary.cappedByDedup, 1, 'one same-service duplicate should be capped by dedup')
    assert.equal(capBoard.summary.cappedByRuleLimit, 0, 'this fixture does not assert rule-limit caps')
    assert.ok(items.some((x) => x.target === host(2)) === false, 'self-created fixture omitted')
    assert.ok(items.some((x) => x.target === host(1)) === false, 'disabled fixture omitted')
    assert.ok(items.some((x) => x.is_group && x.group_size === 5), 'same-step hits grouped')
    const trace = items.find((x) => x.id === traceHit)
    assert.ok(trace, 'trace hit included')
    assert.equal(trace.credentials.length, 1)
    assert.equal(trace.credentials[0].username, 'fixture-user-2048')
    assert.equal(trace.webshells.length, 1)
    assert.equal(trace.webshells[0].url, `http://${host(20)}/shell.php`)
    assert.equal(trace.tunnels.length, 1)
    assert.equal(trace.tunnels[0].listen, '127.0.0.1:1080')
    const traceSourceCases = traceFallbacks.map(({ name, hitId, source }) => {
      const item = items.find((x) => x.id === hitId)
      assert.ok(item, `${name} trace fallback hit included`)
      assert.equal(item.steps.length, source === null ? 0 : 1, `${name} trace source step count`)
      assert.equal(item.trace.step_source, source, `${name} trace source fallback`)
      return { name, source: item.trace.step_source }
    })
    const urlFallbackCases = urlCases.map(({ name, hitId, expectedLabel }) => {
      const item = items.find((x) => x.id === hitId)
      assert.ok(item, `${name} URL fallback hit included`)
      assert.equal(item.requests[0]?.source, 'auto', `${name} URL evidence source`)
      assert.equal(item.requests[0]?.label, expectedLabel, `${name} URL candidate selected`)
      assert.equal(item.requests.length, 1, `${name} URL evidence count`)
      return { name, label: item.requests[0].label }
    })
    const firstFallback = items.find((x) => x.id === urlCases[0].hitId)
    assert.ok(firstFallback.requests[0].request.includes(String.fromCharCode(13, 10)), 'authority-first request contains CRLF')
    assert.equal(firstFallback.replay_source, 'auto')
    assert.equal(firstFallback.repro_kind, 'http', 'authority-first request parser classifies this as HTTP')
    return { excluded: { disabled: report.summary.disabledExcluded, selfCreated: report.summary.selfCreatedExcluded,
      serviceDedup: report.summary.serviceCappedExcluded }, groupedItems: items.filter((x) => x.is_group).length,
      credentialTrace: trace.credentials.length, tunnelTrace: trace.tunnels.length, webshellTrace: trace.webshells.length,
      traceSources: traceSourceCases, urlFallbacks: urlFallbackCases }
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* transaction already committed */ }
    throw error
  }
}

function runWorkload(workload) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-score-report-bench-'))
  const store = new RedteamStore(root)
  try {
    const engagement = store.openEngagement(`score-report-${workload.name}`, [], { bindCurrent: false })
    const fixtureStart = performance.now()
    const fixture = buildFixture(store, engagement.id, workload.hits)
    const fixtureMs = performance.now() - fixtureStart
    const coverageEngagement = store.openEngagement(`score-report-coverage-${workload.name}`, [], { bindCurrent: false })
    const coverageStart = performance.now()
    const coverage = buildCoverageFixture(store, coverageEngagement.id)
    const coverageFixtureMs = performance.now() - coverageStart

    const baselineReport = store.scoreReport(engagement.id, { limit: 2000 })
    assert.equal(baselineReport.items[0]?.repro_kind, 'http', `${workload.name}: captured request should parse as HTTP`)
    const reportRequest = baselineReport.items[0]?.requests?.[0]?.request || ''
    const crlf = String.fromCharCode(13, 10)
    assert.ok(reportRequest.startsWith(`GET /item/0 HTTP/1.1${crlf}Host: 198.18.`),
      `${workload.name}: report should retain parsed request line and Host`)
    const baseline = stableReport(baselineReport)
    assert.equal(baseline.summary.count, workload.hits, `${workload.name}: all main-path fixture hits should be reported`)
    assert.equal(baseline.itemCount, workload.hits, `${workload.name}: one main-path item per hit`)
    assert.ok(baselineReport.items.every((item) => item.recorded_at === FIXTURE_AT), `${workload.name}: stable fixture timestamps`)
    assert.ok(baselineReport.items.some((item) => item.shots.some((shot) => shot.width === 1 && shot.height === 1)),
      `${workload.name}: report should expose decoded PNG dimensions`)
    assert.match(baseline.markdownSha256, /^[a-f0-9]{64}$/)
    for (let i = 0; i < WARMUPS; i++) {
      assert.deepEqual(stableReport(store.scoreReport(engagement.id, { limit: 2000 })), baseline,
        `${workload.name}: warmup output stability`)
    }
    const reportTimes = []
    for (let i = 0; i < ROUNDS; i++) {
      const start = performance.now()
      const report = store.scoreReport(engagement.id, { limit: 2000 })
      reportTimes.push(performance.now() - start)
      assert.deepEqual(stableReport(report), baseline, `${workload.name}: repeated output stability`)
    }
    return {
      name: workload.name,
      fixture: { ...fixture, generationMs: +fixtureMs.toFixed(2), coverageGenerationMs: +coverageFixtureMs.toFixed(2) },
      coverage,
      report: stats(reportTimes),
      output: baseline,
    }
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
}

const selectedWorkloads = WORKLOADS.filter((workload) => workload.hits <= MAX_HITS)
assert(selectedWorkloads.length > 0, 'no workload selected; increase SCORE_REPORT_BENCH_MAX_HITS')
const results = selectedWorkloads.map(runWorkload)
console.log(JSON.stringify({
  benchmark: 'scoreReport conventional synthetic main path (store/SQLite/trace/evidence/Markdown)',
  fixtureSeed: FIXTURE_SEED,
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  warmups: WARMUPS,
  rounds: ROUNDS,
  selectedWorkloads: selectedWorkloads.map(({ name, hits }) => ({ name, hits })),
  maxHits: MAX_HITS,
  limit: 2000,
  outputStability: 'pass',
  results,
  notes: [
    'main and independent coverage fixture generation times are reported separately from scoreReport wall time',
    'coverage fixture asserts disabled and self-created exclusions, same-service dedup exclusion (not rule-limit cap), same-step grouping, credential/tunnel/webshell traces, trace source fallback (vuln/point/asset/none), and URL evidence candidate fallback (authority first/second/authority-only/path-only/global) with CRLF parsing',
    'screenshot fixture is a valid decoded 1x1 RGBA PNG; image rendering is not measured',
    'coverage uses isolated persisted-schema fixtures for each asserted trace and URL fallback branch; global denotes cross-asset evidence lookup after same-asset candidates miss',
    'SQLite and Markdown/report generation are included; KB initialization is not part of scoreReport',
    'no cross-machine latency threshold is implied; maxMs is the largest sample, not a p95 estimate',
  ],
}, null, 2))
