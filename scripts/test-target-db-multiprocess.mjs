import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const tempParent = fileURLToPath(new URL('../.tmp-tests/', import.meta.url))
mkdirSync(tempParent, { recursive: true })
const root = mkdtempSync(join(tempParent, 'target-db-multiprocess-'))
const moduleUrl = new URL('../lib/redteam/store-core.js', import.meta.url).href
let sharedPointId
const worker = String.raw`
  import { RedteamStore } from ${JSON.stringify(moduleUrl)}
  const [root, index, pointId] = process.argv.slice(1)
  const store = new RedteamStore(root)
  try {
    const engagement = store.openEngagement('shared-target', [])
    const id = engagement.id
    for (let n = 0; n < 40; n++) {
      store.addScoreHit(id, { point_id: Number(pointId), evidence: 'parallel write ' + index + '/' + n, target: 'fixture-' + index + '-' + n })
      store.importBundle(id, { assets: [{ ip: '10.' + index + '.0.' + (n + 1), state: 'up', provenance: 'active' }] })
    }
    process.stdout.write('DONE')
  } finally { store.close() }
`
const children = []
try {
  const base = new (await import('../lib/redteam/store-core.js')).RedteamStore(root)
  try {
  const engagement = base.openEngagement('shared-target', [])
  const id = engagement.id
  const point = base.listScorePoints(id).items[0]
  assert.ok(point, 'score points must seed during initialization')
  sharedPointId = point.id

  const targetRoot = base.dirOf(id)
  const sourcePath = join(targetRoot, 'source.txt')
  const outsidePath = join(root, 'outside.txt')
  writeFileSync(sourcePath, 'fixture-source')
  writeFileSync(outsidePath, 'outside-source')
  const pathShot = base.addShot(id, { path: sourcePath, file: 'path-import.txt' })
  const base64Shot = base.addShot(id, { data_base64: Buffer.from('base64-fixture').toString('base64'), file: 'base64-import.txt' })
  assert.equal(readFileSync(join(base.shotsDirOf(id), pathShot.file), 'utf8'), 'fixture-source')
  assert.equal(readFileSync(join(base.shotsDirOf(id), base64Shot.file), 'utf8'), 'base64-fixture')
  assert.throws(() => base.addShot(id, { path: outsidePath, file: 'outside-import.txt' }), /path outside allowed roots/i)

  const attack = base.addAttackFile(id, { target: 'fixture-target', name: 'source.txt', evidence: 'fixture', path: sourcePath })
  assert.equal(readFileSync(attack.path, 'utf8'), 'fixture-source')
  assert.throws(() => base.addAttackFile(id, { target: 'fixture-target', name: 'outside.txt', evidence: 'fixture', path: outsidePath }), /path outside allowed roots/i)

  const pocsDir = base.pocsDirOf()
  mkdirSync(pocsDir, { recursive: true })
  const pocSource = join(pocsDir, 'source.txt')
  writeFileSync(pocSource, 'poc-source')
  const importedPoc = base.savePoc({ code: 'path-import', title: 'path import', path: pocSource })
  assert.equal(base.getPoc(importedPoc.poc.code).content, 'poc-source')
  assert.throws(() => base.savePoc({ code: 'outside-import', title: 'outside import', path: outsidePath }), /path outside allowed roots/i)
  } finally { base.close() }
  for (let i = 0; i < 6; i++) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', worker, root, String(i), String(sharedPointId)], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    children.push(new Promise((resolve, reject) => {
      let stdout = '', stderr = ''
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
      child.once('error', reject)
      child.once('close', (code) => {
        try {
          assert.equal(code, 0, `worker exit=${code}; stdout=${stdout}; stderr=${stderr}`)
          assert.equal(stdout, 'DONE')
          assert.doesNotMatch(stderr, /SQLITE_BUSY|database is locked/i)
          resolve()
        } catch (error) { reject(error) }
      })
    }))
  }
  await Promise.all(children)
  const { RedteamStore } = await import('../lib/redteam/store-core.js')
  const check = new RedteamStore(root)
  try {
    const id = check.openEngagement('shared-target', []).id
    assert.equal(check.db(id).prepare('SELECT COUNT(*) AS n FROM score_hit').get().n, 240)
    assert.equal(check.db(id).prepare('SELECT COUNT(*) AS n FROM asset').get().n, 240)
    const checkpoint = check.db(id).prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    assert.equal(checkpoint.busy, 0, 'all concurrent writers/readers must be closed before cleanup')
  } finally { check.close() }
  console.log('PASS target-db-multiprocess: 6 workers × 40 concurrent hits and assets')
} finally {
  const cleanup = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import { rmSync } from 'node:fs'; rmSync(process.argv[1], { recursive: true, force: true })",
    root], { encoding: 'utf8', timeout: 15000, windowsHide: true })
  if (cleanup.error || cleanup.status !== 0) {
    console.error(`cleanup child failed: status=${cleanup.status}; ${cleanup.stderr || cleanup.error?.message || ''}`)
    process.exitCode = 1
  }
}
