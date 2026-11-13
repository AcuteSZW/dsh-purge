#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { RedteamStore } from '../lib/redteam/store-core.js'

const root = mkdtempSync(join(tmpdir(), 'dsh-purge-attack-file-'))
let store
try {
  store = new RedteamStore(root)
  const engagement = store.openEngagement('attack-file-path-collision', [], { bindCurrent: false })
  const id = engagement.id
  const common = { name: 'run.sh', kind: 'script', evidence: '回归测试验证有效' }

  // This is the regression: the old slug-only layout mapped both targets to attack-files/host/run.sh.
  const first = store.addAttackFile(id, { ...common, target: 'http://host:80', content: 'url-target' })
  const second = store.addAttackFile(id, { ...common, target: 'host', content: 'host-target' })
  assert.notEqual(first.path, second.path, 'different raw targets must use isolated paths')
  assert.equal(store.readAttackFile(id, store.listAttackFiles(id, { target: first.target })[0].id).content, 'url-target')
  assert.equal(store.readAttackFile(id, store.listAttackFiles(id, { target: second.target })[0].id).content, 'host-target')
  assert.notEqual(readFileSync(first.path, 'utf8'), readFileSync(second.path, 'utf8'))

  const db = store.db(id)
  const attackRoot = store.attackFilesDirOf(id)
  const makePath = (target, name) => join(attackRoot, `${target}-${createHash('sha1').update(target, 'utf8').digest('hex').slice(0, 12)}`, name)

  // A stale database without an owner row still must not clobber an existing filesystem object.
  const collisionTarget = 'disk-collision'
  const collisionPath = makePath(collisionTarget, common.name)
  mkdirSync(dirname(collisionPath), { recursive: true })
  writeFileSync(collisionPath, 'disk-owner', 'utf8')
  assert.throws(() => store.addAttackFile(id, { ...common, target: collisionTarget, content: 'must-not-overwrite' }), /path conflict|EEXIST/)
  assert.equal(readFileSync(collisionPath, 'utf8'), 'disk-owner')

  // Windows path identity ignores case and separators; filesystem case sensitivity can
  // vary by volume on POSIX (notably macOS), so probe the fixture directory itself.
  const aliasTarget = 'alias-attacker'
  const aliasPath = makePath(aliasTarget, 'ALIAS-OWNER.SH')
  mkdirSync(dirname(aliasPath), { recursive: true })
  writeFileSync(aliasPath, 'alias-owner', 'utf8')
  const caseInsensitiveFs = existsSync(aliasPath.replace('ALIAS-OWNER.SH', 'alias-owner.sh'))
  const aliasOwnerPath = process.platform === 'win32'
    ? aliasPath.split(sep).join(sep === String.fromCharCode(92) ? '/' : String.fromCharCode(92)).replace('ALIAS-OWNER.SH', 'alias-owner.sh')
    : caseInsensitiveFs ? aliasPath.replace('ALIAS-OWNER.SH', 'alias-owner.sh') : aliasPath
  db.prepare(`INSERT INTO attack_file(target, target_kind, name, kind, path, evidence, created_at)
    VALUES(?,?,?,?,?,?,?)`).run('alias-owner', null, 'alias-owner.sh', 'script', aliasOwnerPath, 'alias fixture', new Date().toISOString())
  if (process.platform === 'win32' || caseInsensitiveFs) {
    assert.throws(() => store.addAttackFile(id, { ...common, name: 'ALIAS-OWNER.SH', target: aliasTarget, content: 'must-not-overwrite' }), /path conflict/)
    assert.equal(readFileSync(aliasPath, 'utf8'), 'alias-owner')
    db.prepare(`INSERT INTO attack_file(target, target_kind, name, kind, path, evidence, created_at)
      VALUES(?,?,?,?,?,?,?)`).run(aliasTarget, null, 'ALIAS-OWNER.SH', 'script', aliasPath, 'existing alias fixture', new Date().toISOString())
    assert.throws(() => store.addAttackFile(id, { ...common, name: 'ALIAS-OWNER.SH', target: aliasTarget, content: 'must-not-overwrite-existing-alias' }), /path conflict/)
    assert.equal(readFileSync(aliasPath, 'utf8'), 'alias-owner', 'updating an alias-owned path must preserve the other target file')
  } else {
    const caseDistinct = store.addAttackFile(id, { ...common, name: 'alias-owner.sh', target: aliasTarget, content: 'posix-distinct' })
    assert.equal(caseDistinct.path, aliasPath.replace('ALIAS-OWNER.SH', 'alias-owner.sh'))
  }

  // Existing rows from the slug-only layout remain readable; an update must not overwrite a sibling target.
  const legacyDir = join(attackRoot, 'legacy-host')
  const legacyPath = join(legacyDir, 'legacy.sh')
  mkdirSync(legacyDir, { recursive: true })
  writeFileSync(legacyPath, 'legacy-b-content', 'utf8')
  db.prepare(`INSERT INTO attack_file(target, target_kind, name, kind, path, evidence, created_at)
    VALUES(?,?,?,?,?,?,?)`).run('legacy-b', null, 'legacy.sh', 'script', legacyPath, 'legacy fixture', new Date().toISOString())
  db.prepare(`INSERT INTO attack_file(target, target_kind, name, kind, path, evidence, created_at)
    VALUES(?,?,?,?,?,?,?)`).run('legacy-a', null, 'legacy.sh', 'script', legacyPath, 'legacy fixture', new Date().toISOString())
  const legacyA = store.addAttackFile(id, { target: 'legacy-a', name: 'legacy.sh', content: 'legacy-a-new', evidence: '更新验证有效' })
  assert.notEqual(legacyA.path, legacyPath, 'conflicting legacy path must be isolated before update')
  assert.equal(readFileSync(legacyPath, 'utf8'), 'legacy-b-content', 'conflicting legacy row must not be overwritten')
  assert.equal(store.readAttackFile(id, db.prepare('SELECT id FROM attack_file WHERE target = ? AND name = ?').get('legacy-a', 'legacy.sh').id).content, 'legacy-a-new')

  // Invalid device names/dot components/trailing dots are rejected; trim safely sanitizes trailing spaces.
  for (const name of ['.', '..', 'CON', 'nul.txt', 'LPT1.log', 'trailing.']) {
    assert.throws(() => store.addAttackFile(id, { ...common, name, target: `invalid-${name}`, content: 'x' }), /invalid attack file name/)
  }
  const trimmed = store.addAttackFile(id, { ...common, name: 'trailing ', target: 'trimmed-name', content: 'trimmed' })
  assert.equal(trimmed.name, 'trailing')

  // Input validation remains active.
  assert.throws(() => store.addAttackFile(id, { ...common, target: '', content: 'x' }), /target required/)
  assert.throws(() => store.addAttackFile(id, { ...common, target: 'host', content: '' }), /content or path required/)

  console.log(JSON.stringify({ ok: true, isolated: [first.path, second.path], legacyRehomed: legacyA.path, platform: process.platform }, null, 2))
} finally {
  store?.close()
  rmSync(root, { recursive: true, force: true })
}
