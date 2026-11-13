import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RedteamStore } from '../lib/redteam/store-core.js'
import { stagePocFile } from '../lib/redteam/poc-file-transaction.js'

// Run from the repository root: node scripts/test-poc-file-multiprocess.mjs
const WORKERS = 6
const TIMEOUT_MS = 30_000
const root = mkdtempSync(join(tmpdir(), 'poc-multiprocess-'))
const schemaRoot = join(root, 'schema-race')
const gateDir = join(root, 'gates')
mkdirSync(gateDir, { recursive: true })
const storeModule = new URL('../lib/redteam/store-core.js', import.meta.url).href
const workerSource = String.raw`
  import { RedteamStore } from ${JSON.stringify(storeModule)}
  import { existsSync } from 'node:fs'
  import { join } from 'node:path'
  const [root, role, gateDir] = process.argv.slice(1)
  const waitGate = (name) => new Promise((resolve) => {
    const path = join(gateDir, 'gate-' + name)
    const poll = () => existsSync(path) ? resolve() : setTimeout(poll, 5)
    poll()
  })
  const store = new RedteamStore(root)
  try {
    if (role.startsWith('schema')) {
      process.stdout.write('READY' + String.fromCharCode(10))
      await waitGate(role)
      const db = store.kb()
      const columns = db.prepare('PRAGMA table_info(__poc_file_journal)').all()
      process.stdout.write('SCHEMA_COLUMNS:' + columns.filter((column) => column.name === 'cleanup_paths').length + String.fromCharCode(10))
      process.stdout.write('DONE' + String.fromCharCode(10))
    } else {
      store.kb()
      process.stdout.write('READY' + String.fromCharCode(10))
      await waitGate('start')
      let outcome = 'ok'
      try {
        if (role === 'recover') store.recoverPocFiles()
        else {
          await waitGate(role)
          if (role === 'shared-delete' || role.startsWith('same-delete-') || role === 'race-delete') {
            const code = role === 'shared-delete' ? 'shared-victim' : role.startsWith('same-delete-') ? 'same-delete' : 'solo-race'
            const deletion = store.deletePoc(code)
            outcome = deletion.ok && deletion.removed_files ? 'deleted' : 'not-found'
          } else if (role === 'shared-update') {
            store.updatePoc('shared-keeper', { content: 'KEEPER-UPDATED' })
          } else if (role === 'race-update') {
            store.updatePoc('solo-race', { content: 'SOLO-UPDATED' })
          } else throw new Error('unknown worker role: ' + role)
        }
      } catch (error) {
        if ((role === 'race-update' || role.startsWith('same-delete-') || role === 'race-delete') &&
            /poc changed concurrently|poc not found/.test(error.message)) outcome = 'conflict'
        else throw error
      }
      process.stdout.write('OUTCOME:' + outcome + String.fromCharCode(10))
    }
    process.stdout.write('DONE' + String.fromCharCode(10))
  } finally { store.close() }
`

const children = new Set()
function spawnWorker(role, workerRoot = root) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', workerSource, workerRoot, role, gateDir], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  children.add(child)
  let stdout = '', stderr = '', settled = false
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
  const exit = new Promise((resolve, reject) => {
    child.once('error', (error) => { settled = true; reject(error) })
    child.once('close', (code, signal) => { settled = true; children.delete(child); resolve({ code, signal, stdout, stderr }) })
  })
  const ready = new Promise((resolve, reject) => {
    const deadline = Date.now() + TIMEOUT_MS
    const poll = () => {
      if (stdout.includes('READY' + String.fromCharCode(10))) return resolve()
      if (settled) return reject(new Error(`worker ${role} exited before READY: ${stderr || stdout}`))
      if (Date.now() >= deadline) return reject(new Error(`worker ${role} READY timeout; stdout=${stdout}; stderr=${stderr}`))
      setTimeout(poll, 10)
    }
    poll()
  })
  return { child, exit, ready, role }
}
function signal(name) {
  try { writeFileSync(join(gateDir, 'gate-' + name), 'go', { flag: 'wx' }) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
}
function assertWorkerSuccess(worker, result) {
  assert.equal(result.signal, null, `${worker.role}: unexpected signal; ${result.stderr}`)
  assert.equal(result.code, 0, `${worker.role}: exit=${result.code}; stdout=${result.stdout}; stderr=${result.stderr}`)
  assert.ok(result.stdout.endsWith('DONE' + String.fromCharCode(10)), `${worker.role}: DONE marker missing; stdout=${result.stdout}`)
  assert.doesNotMatch(result.stderr, /database is locked|SQLITE_BUSY/i, `${worker.role}: busy timeout failure: ${result.stderr}`)
  return result.stdout.match(/OUTCOME:([a-z-]+)/)?.[1] ?? 'ok'
}
async function waitAllReady(workers) {
  let timer
  try {
    await Promise.race([
      Promise.all(workers.map((worker) => worker.ready)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`workers did not become READY within ${TIMEOUT_MS}ms`)), TIMEOUT_MS) }),
    ])
  } finally { clearTimeout(timer) }
}
async function runPhase(workers, gates = []) {
  await waitAllReady(workers)
  signal('start')
  for (const gate of gates) signal(gate)
  let timer
  try {
    const results = await Promise.race([
      Promise.all(workers.map((worker) => worker.exit)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`workers did not exit within ${TIMEOUT_MS}ms`)), TIMEOUT_MS) }),
    ])
    return results.map((result, index) => assertWorkerSuccess(workers[index], result))
  } finally { clearTimeout(timer) }
}
function assertDbAndFiles(check, expectedRows) {
  const db = check.kb()
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM __poc_file_journal').get().n, 0, 'recovery left journal rows behind')
  for (const [code, content, path] of expectedRows) {
    const row = check.getPoc(code)
    assert.ok(row, `expected referenced row ${code}`)
    assert.equal(row.content, content, `${code} SQLite content mismatch`)
    assert.equal(row.path, path, `${code} path changed unexpectedly`)
    assert.equal(readFileSync(path, 'utf8'), content, `${code} SQLite/disk content mismatch`)
  }
  for (const ref of db.prepare('SELECT DISTINCT path FROM poc WHERE path IS NOT NULL').all()) {
    assert.ok(existsSync(ref.path), `referenced file missing: ${ref.path}`)
  }
}
function seedSharedFile(store, first, second, content) {
  const a = store.savePoc({ code: first, title: first, content, filename: 'shared.txt' })
  store.savePoc({ code: second, title: second, content, filename: 'shared.txt' })
  store.kb().prepare('UPDATE poc SET path = ? WHERE code = ?').run(a.path, second)
  return a.path
}

let activeCheck
try {
  // Concurrently initialize a blank database.
  const emptyRoot = join(root, 'schema-empty')
  mkdirSync(emptyRoot, { recursive: true })
  const emptyWorkers = [spawnWorker('schema-empty', emptyRoot), spawnWorker('schema-empty', emptyRoot)]
  await waitAllReady(emptyWorkers)
  signal('schema-empty')
  let emptyTimer
  const emptyResults = await Promise.race([
    Promise.all(emptyWorkers.map((worker) => worker.exit)),
    new Promise((_, reject) => { emptyTimer = setTimeout(() => reject(new Error(`empty-schema timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS) }),
  ]).finally(() => clearTimeout(emptyTimer))
  for (const result of emptyResults) {
    assert.equal(result.signal, null, `empty-schema worker signal: ${result.stderr}`)
    assert.equal(result.code, 0, `empty-schema worker exit=${result.code}; stdout=${result.stdout}; stderr=${result.stderr}`)
    assert.ok(result.stdout.includes('SCHEMA_COLUMNS:1'))
    assert.doesNotMatch(result.stderr, /database is locked|SQLITE_BUSY/i)
  }
  const emptyCheck = new RedteamStore(emptyRoot)
  assert.equal(emptyCheck.kb().prepare('PRAGMA table_info(__poc_file_journal)').all().filter((column) => column.name === 'cleanup_paths').length, 1)
  emptyCheck.close()

  // Concurrently migrate an old journal schema.
  mkdirSync(schemaRoot, { recursive: true })
  const legacyDb = new DatabaseSync(join(schemaRoot, 'knowledge.db'))
  legacyDb.exec(`CREATE TABLE __poc_file_journal (
    id TEXT PRIMARY KEY, op TEXT NOT NULL, final_path TEXT NOT NULL, temp_path TEXT,
    backup_path TEXT, had_original INTEGER NOT NULL DEFAULT 0, content TEXT, state TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`)
  legacyDb.close()
  const schemaWorkers = [spawnWorker('schema', schemaRoot), spawnWorker('schema', schemaRoot)]
  signal('schema')
  let schemaTimer
  const schemaResults = await Promise.race([
    Promise.all(schemaWorkers.map((worker) => worker.exit)),
    new Promise((_, reject) => { schemaTimer = setTimeout(() => reject(new Error(`schema workers timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS) }),
  ]).finally(() => clearTimeout(schemaTimer))
  for (let i = 0; i < schemaWorkers.length; i++) {
    const result = schemaResults[i]
    assert.equal(result.signal, null, `schema worker signal: ${result.stderr}`)
    assert.equal(result.code, 0, `schema worker exit=${result.code}; stdout=${result.stdout}; stderr=${result.stderr}`)
    assert.ok(result.stdout.includes('SCHEMA_COLUMNS:1'), `cleanup_paths missing: ${result.stdout}`)
    assert.doesNotMatch(result.stderr, /database is locked|SQLITE_BUSY/i)
  }
  const schemaCheck = new RedteamStore(schemaRoot)
  const cleanupColumns = schemaCheck.kb().prepare('PRAGMA table_info(__poc_file_journal)').all().filter((column) => column.name === 'cleanup_paths')
  assert.equal(cleanupColumns.length, 1, 'cleanup_paths must be migrated exactly once')
  schemaCheck.close()

  // Six simultaneous recoveries plus exactly one victim delete and one keeper update.
  const seed = new RedteamStore(root)
  const sharedPath = seedSharedFile(seed, 'shared-victim', 'shared-keeper', 'SHARED-CONTENT')
  seed.close()
  const setup = new RedteamStore(root)
  const setupDb = setup.kb()
  assert.equal(setupDb.prepare('SELECT COUNT(*) AS n FROM poc WHERE path = ?').get(sharedPath).n, 2)
  const staged = stagePocFile(sharedPath, 'SHARED-CONTENT')
  setupDb.prepare(`INSERT INTO __poc_file_journal
    (id, op, final_path, temp_path, backup_path, had_original, content, state)
    VALUES('seed-crash', 'write', ?, ?, ?, 1, ?, 'committed')`)
    .run(sharedPath, staged.tempPath, staged.backupPath, 'SHARED-CONTENT')
  setup.close()
  const sharedWorkers = [
    ...Array.from({ length: WORKERS }, () => spawnWorker('recover')),
    spawnWorker('shared-delete'),
    spawnWorker('shared-update'),
  ]
  await runPhase(sharedWorkers, ['shared-delete', 'shared-update'])
  activeCheck = new RedteamStore(root)
  assert.equal(activeCheck.getPoc('shared-victim'), undefined)
  const keeper = activeCheck.getPoc('shared-keeper')
  assert.ok(keeper)
  assert.equal(keeper.content, 'KEEPER-UPDATED')
  assertDbAndFiles(activeCheck, [['shared-keeper', 'KEEPER-UPDATED', keeper.path]])
  activeCheck.close(); activeCheck = null

  // Two processes delete the same sole-owner record: successful removal + not-found/conflict.
  const sameSeed = new RedteamStore(root)
  const same = sameSeed.savePoc({ code: 'same-delete', title: 'same delete', content: 'DELETE-ME' })
  sameSeed.close()
  const sameOutcomes = await runPhase([spawnWorker('same-delete-a'), spawnWorker('same-delete-b')], ['same-delete-a', 'same-delete-b'])
  assert.ok(sameOutcomes.every((outcome) => outcome === 'deleted' || outcome === 'not-found' || outcome === 'conflict'))
  assert.ok(sameOutcomes.every((outcome) => outcome === 'deleted' || outcome === 'no-op' || outcome === 'not-found' || outcome === 'conflict'))
  activeCheck = new RedteamStore(root)
  assert.equal(activeCheck.getPoc('same-delete'), undefined)
  assert.equal(existsSync(same.path), false, 'deleted record file must be removed')
  assertDbAndFiles(activeCheck, [])
  activeCheck.close(); activeCheck = null

  // One sole-owner delete races one content update on the same record. Either
  // serialized winner is valid, but SQLite and its file must describe that winner.
  const raceSeed = new RedteamStore(root)
  const race = raceSeed.savePoc({ code: 'solo-race', title: 'solo race', content: 'ORIGINAL' })
  raceSeed.close()
  const raceOutcomes = await runPhase([spawnWorker('race-delete'), spawnWorker('race-update')], ['race-delete', 'race-update'])
  assert.ok(raceOutcomes[0] === 'deleted' || raceOutcomes[0] === 'not-found')
  assert.ok(raceOutcomes[1] === 'ok' || raceOutcomes[1] === 'conflict')
  activeCheck = new RedteamStore(root)
  const finalRace = activeCheck.getPoc('solo-race')
  if (!finalRace) {
    assert.equal(existsSync(race.path), false, 'delete-wins state must have no file')
    assertDbAndFiles(activeCheck, [])
  } else {
    assert.equal(finalRace.content, 'SOLO-UPDATED', 'update-wins state must contain updated content')
    assertDbAndFiles(activeCheck, [['solo-race', 'SOLO-UPDATED', finalRace.path]])
  }
  console.log(`PASS test-poc-file-multiprocess schema-race=2 recovery=${WORKERS} shared-delete/update=1/1 same-record-delete=2 solo-delete/update=1/1 outcomes=${raceOutcomes.join('/')},${sameOutcomes.join('/')} platform=${process.platform}`)
} catch (error) {
  console.error(error.stack || error)
  process.exitCode = 1
} finally {
  try { activeCheck?.close() } catch {}
  for (const child of children) { try { child.kill() } catch {} }
  const deadline = Date.now() + 5_000
  while (children.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
  try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
  catch (error) { console.error(`cleanup failed: ${error.message}`); process.exitCode = 1 }
}
