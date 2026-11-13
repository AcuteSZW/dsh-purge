import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RedteamStore } from '../lib/redteam/store-core.js'

const root = mkdtempSync(join(tmpdir(), 'poc-cleanup-race-'))
const rootStore = new RedteamStore(root)
const writerStore = new RedteamStore(root)
let writerDb
try {
  const original = rootStore.savePoc({ code: 'cleanup-race', title: 'cleanup race', content: 'ORIGINAL' })
  const oldPath = original.path
  const db = rootStore.kb()
  writerDb = writerStore.kb()
  writerDb.exec('PRAGMA busy_timeout = 0')

  let lockAttempted = false
  const cleanupStore = new RedteamStore(root, { onPocTransactionPhase(name, details) {
    if (name !== 'transaction-begin' || details.op !== 'write' || lockAttempted) return
    lockAttempted = true
    assert.ok(existsSync(oldPath), 'obsolete POC file exists while save transaction owns the SQLite write lock')
    assert.throws(() => writerDb.exec('BEGIN IMMEDIATE'), { code: 'ERR_SQLITE_ERROR' },
      'a competing SQLite writer cannot enter while cleanup owns BEGIN IMMEDIATE')
    assert.equal(writerDb.prepare('SELECT code FROM poc WHERE path = ? LIMIT 1').get(oldPath)?.code, 'cleanup-race',
      'the old reference remains visible to other connections until the cleanup transaction commits')
  } })
  try {
    const replacement = cleanupStore.savePoc({ code: 'cleanup-race', title: 'cleanup race', filename: 'replacement.txt', content: 'REPLACEMENT' })
    assert.equal(replacement.path, join(cleanupStore.pocsDirOf(), 'cleanup-race', 'replacement.txt'))
  } finally {
    cleanupStore.close()
  }

  assert.equal(lockAttempted, true, 'test exercised a competing writer during the cleanup transaction')
  assert.equal(db.prepare('SELECT 1 FROM poc WHERE path = ? LIMIT 1').get(oldPath), undefined,
    'no reference was committed while obsolete-path cleanup held the SQLite write lock')
  assert.equal(existsSync(oldPath), false, 'unreferenced obsolete POC file is cleaned after commit')

  const shared = rootStore.savePoc({ code: 'shared-owner', title: 'shared owner', content: 'SHARED' })
  const sharedPath = shared.path
  db.prepare('UPDATE poc SET path = ? WHERE code = ?').run(sharedPath, 'cleanup-race')

  const sharedReplacement = rootStore.savePoc({ code: 'shared-owner', title: 'shared owner', filename: 'new.txt', content: 'NEW-SHARED' })
  assert.notEqual(sharedReplacement.path, sharedPath)
  assert.equal(db.prepare('SELECT code FROM poc WHERE path = ?').get(sharedPath)?.code, 'cleanup-race',
    'path remains referenced by the other POC row')
  assert.equal(readFileSync(sharedPath, 'utf8'), 'SHARED', 'shared referenced file is preserved')

  if (process.platform === 'win32') {
    const aliasOwner = rootStore.savePoc({ code: 'case-owner', title: 'case owner', content: 'CASE-SHARED' })
    const aliasReference = rootStore.savePoc({ code: 'case-reference', title: 'case reference' })
    const caseAlias = aliasOwner.path.replace('case-owner', 'CASE-OWNER')
    assert.notEqual(caseAlias, aliasOwner.path)
    assert.equal(existsSync(caseAlias), true, 'Windows resolves the case-variant path to the same file')
    db.prepare('UPDATE poc SET path = ? WHERE code = ?').run(caseAlias, 'case-reference')

    rootStore.savePoc({ code: 'case-owner', title: 'case owner', filename: 'replacement.txt', content: 'CASE-REPLACEMENT' })
    assert.equal(db.prepare('SELECT code FROM poc WHERE code = ?').get('case-reference')?.code, 'case-reference')
    assert.equal(existsSync(caseAlias), true,
      'cleanup must preserve a file referenced through a Windows case alias')
    assert.equal(readFileSync(caseAlias, 'utf8'), 'CASE-SHARED')
  }

  console.log(`PASS poc-cleanup-race: RedteamStore cleanup serializes competing writer, preserves shared references${process.platform === 'win32' ? ', and checks Windows case aliases' : ''}`)
} finally {
  try { writerStore.close() } finally {
    try { rootStore.close() } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
}
