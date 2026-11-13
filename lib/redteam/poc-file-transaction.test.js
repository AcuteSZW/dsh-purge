import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { RedteamStore } from './store-core.js'
import { removeUnreferencedPocFile, stagePocFile, withPocFileTransaction } from './poc-file-transaction.js'
const root = mkdtempSync(join(tmpdir(), 'poc-file-transaction-'))
function tryFileSymlink(target, linkPath) {
  try { symlinkSync(target, linkPath, 'file'); return true } catch (error) {
    if (['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) return false
    throw error
  }
}
const crashHelper = String.raw`
  import { RedteamStore } from ${JSON.stringify(new URL('./store-core.js', import.meta.url).href)}
  const [root, op, phase] = process.argv.slice(1)
  const store = new RedteamStore(root, { onPocTransactionPhase(name) {
    if (name === phase) process.exit(86)
  } })
  if (op === 'create') store.savePoc({ code: 'crash-create', title: 'crash create', content: 'NEW' })
  else if (op === 'overwrite') store.updatePoc('crash-overwrite', { content: 'NEW' })
  else if (op === 'delete') store.deletePoc('crash-delete')
  store.close()
`
function crashAt(storeRoot, operation, phase) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', crashHelper, storeRoot, operation, phase], {
    encoding: 'utf8', timeout: 15000,
  })
  assert.equal(result.status, 86, `child should crash at ${operation}/${phase}: ${result.stderr}`)
}
function recoverAndCheck(storeRoot, check) {
  const recovered = new RedteamStore(storeRoot)
  try {
    assert.deepEqual(recovered.recoverPocFiles(), { rolledBack: 0, finalized: 0 })
    check(recovered)
    assert.deepEqual(recovered.recoverPocFiles(), { rolledBack: 0, finalized: 0 })
    check(recovered)
  } finally { recovered.close() }
}
const db = new DatabaseSync(join(root, 'test.db'))
try {
  const pocs = join(root, 'pocs')
  const file = join(pocs, 'shared', 'poc.txt')
  mkdirSync(join(pocs, 'shared'), { recursive: true })
  writeFileSync(file, 'ORIGINAL')
  db.exec(`CREATE TABLE poc(id INTEGER PRIMARY KEY, path TEXT, content TEXT);
    CREATE VIRTUAL TABLE poc_fts USING fts5(poc_id UNINDEXED, content);
    INSERT INTO poc VALUES(1, '${file.replaceAll("'", "''")}', 'ORIGINAL');
    INSERT INTO poc_fts VALUES('1', 'ORIGINAL');`)

  const staged = stagePocFile(file, 'REPLACEMENT')
  assert.throws(() => withPocFileTransaction(db, staged, () => {
    db.prepare('UPDATE poc SET content = ? WHERE id = 1').run('REPLACEMENT')
    db.prepare('DELETE FROM poc_fts WHERE poc_id = ?').run('1')
    throw new Error('FTS failpoint')
  }), /FTS failpoint/)
  assert.equal(db.prepare('SELECT content FROM poc WHERE id = 1').get().content, 'ORIGINAL')
  assert.equal(db.prepare('SELECT content FROM poc_fts WHERE poc_id = ?').get('1').content, 'ORIGINAL')
  assert.equal(readFileSync(file, 'utf8'), 'ORIGINAL')
  assert.deepEqual(readdirSync(join(pocs, 'shared')).sort(), ['poc.txt'])

  const committed = stagePocFile(file, 'COMMITTED')
  withPocFileTransaction(db, committed, () => {
    db.prepare('UPDATE poc SET content = ? WHERE id = 1').run('COMMITTED')
    db.prepare('DELETE FROM poc_fts WHERE poc_id = ?').run('1')
    db.prepare('INSERT INTO poc_fts VALUES(?, ?)').run('1', 'COMMITTED')
  })
  assert.equal(db.prepare('SELECT content FROM poc WHERE id = 1').get().content, 'COMMITTED')
  assert.equal(db.prepare('SELECT content FROM poc_fts WHERE poc_id = ?').get('1').content, 'COMMITTED')
  assert.equal(readFileSync(file, 'utf8'), 'COMMITTED')

  const sharedDir = join(pocs, 'shared')
  const outside = join(root, 'user-owned.txt')
  writeFileSync(outside, 'keep')
  assert.deepEqual(removeUnreferencedPocFile(pocs, outside, () => false), {
    removed: false, reason: 'outside-managed-root',
  })
  assert.equal(readFileSync(outside, 'utf8'), 'keep')
  const outsideDir = join(root, 'outside-dir')
  mkdirSync(outsideDir)
  const outsideKeep = join(outsideDir, 'keep.txt')
  writeFileSync(outsideKeep, 'external keep')
  symlinkSync(outsideDir, join(pocs, 'redirect'), 'junction')
  assert.deepEqual(removeUnreferencedPocFile(pocs, join(pocs, 'redirect', 'keep.txt'), () => false), {
    removed: false, reason: 'outside-managed-root',
  })
  assert.equal(readFileSync(outsideKeep, 'utf8'), 'external keep')
  const rootLink = join(root, 'pocs-link')
  symlinkSync(outsideDir, rootLink, 'junction')
  assert.deepEqual(removeUnreferencedPocFile(rootLink, join(rootLink, 'keep.txt'), () => false), {
    removed: false, reason: 'outside-managed-root',
  })
  assert.equal(readFileSync(outsideKeep, 'utf8'), 'external keep')
  assert.deepEqual(removeUnreferencedPocFile(pocs, file, () => true), {
    removed: false, reason: 'referenced',
  })
  assert.equal(readFileSync(file, 'utf8'), 'COMMITTED')
  assert.deepEqual(removeUnreferencedPocFile(pocs, file, () => false), {
    removed: true, removedEmptyDirectory: true,
  })
  assert.throws(() => readdirSync(sharedDir), { code: 'ENOENT' })

  const recoveryRoot = join(root, 'recovery')
  const seed = new RedteamStore(recoveryRoot)
  const original = seed.savePoc({ code: 'crash-overwrite', title: 'crash overwrite', content: 'ORIGINAL' })
  seed.savePoc({ code: 'crash-delete', title: 'crash delete', content: 'DELETE-ME' })
  const originalPath = original.path
  seed.close()

  for (const [operation, phase] of [
    ['create', 'after-stage'],
    ['overwrite', 'after-stage'],
    ['create', 'commit-pending'],
    ['overwrite', 'commit-pending'],
    ['create', 'after-commit'],
    ['overwrite', 'after-commit'],
    ['delete', 'after-tombstone-commit'],
  ]) {
    crashAt(recoveryRoot, operation, phase)
    recoverAndCheck(recoveryRoot, (recovered) => {
      if (phase === 'after-stage' || phase === 'commit-pending') {
        if (operation === 'create') assert.equal(recovered.getPoc('crash-create'), undefined)
        else assert.equal(recovered.getPoc('crash-overwrite').content, 'ORIGINAL')
        assert.equal(readFileSync(originalPath, 'utf8'), 'ORIGINAL')
        const stageDir = operation === 'create' ? join(recovered.pocsDirOf(), 'crash-create') : dirname(originalPath)
        const stageFiles = readdirSync(stageDir).filter((name) => name.endsWith('.tmp') || name.endsWith('.bak'))
        if (phase === 'after-stage') assert.ok(stageFiles.length > 0, 'unjournaled stage orphan is observable and intentionally retained')
        return
      }
      if (operation === 'create') {
        assert.equal(recovered.getPoc('crash-create').content, 'NEW')
        assert.equal(readFileSync(recovered.getPoc('crash-create').path, 'utf8'), 'NEW')
      } else if (operation === 'overwrite') {
        assert.equal(recovered.getPoc('crash-overwrite').content, 'NEW')
        assert.equal(readFileSync(originalPath, 'utf8'), 'NEW')
      } else {
        assert.equal(recovered.getPoc('crash-delete'), undefined)
        assert.throws(() => readFileSync(join(recovered.pocsDirOf(), 'crash-delete', 'poc.txt')), { code: 'ENOENT' })
      }
    })
  }

  const symlinkRoot = join(root, 'symlink-finalize')
  const symlinkSeed = new RedteamStore(symlinkRoot)
  const symlinkPoc = symlinkSeed.savePoc({ code: 'symlink-final', title: 'symlink final', content: 'DATABASE-CONTENT' })
  const symlinkPath = symlinkPoc.path
  symlinkSeed.close()
  const symlinkSentinel = join(root, 'symlink-sentinel.txt')
  writeFileSync(symlinkSentinel, 'KEEP-SENTINEL')
  unlinkSync(symlinkPath)
  if (tryFileSymlink(symlinkSentinel, symlinkPath)) {
    const symlinkDb = new DatabaseSync(join(symlinkRoot, 'knowledge.db'))
    try {
      symlinkDb.prepare(`INSERT INTO __poc_file_journal
        (id, op, final_path, had_original, content, state)
        VALUES(?, 'write', ?, 0, ?, 'committed')`).run('leaf-symlink', symlinkPath, 'DATABASE-CONTENT')
    } finally { symlinkDb.close() }
    const symlinkRecovery = new RedteamStore(symlinkRoot)
    try {
      assert.throws(() => symlinkRecovery.kb(), /symlink|symbolic/i,
        'recovery must reject a symlink at the journal final leaf')
      assert.equal(readFileSync(symlinkSentinel, 'utf8'), 'KEEP-SENTINEL',
        'recovery must leave an outside symlink target unchanged')
    } finally { symlinkRecovery.close() }
  } else {
    console.log('SKIP poc-file-transaction: file symlink privilege unavailable')
  }
  const raceRoot = join(root, 'save-mark-race')
  let markAfterStaging = false
  const raceSeed = new RedteamStore(raceRoot, { onPocTransactionPhase(name, details) {
    if (markAfterStaging && name === 'after-stage' && details.op === 'write') {
      markAfterStaging = false
      raceSeed.markPocUsed('save-mark-race', '2026-11-13T00:00:00.000Z')
    }
  } })
  try {
    const raceInitial = raceSeed.savePoc({ code: 'save-mark-race', title: 'save mark race', content: 'OLD' })
    markAfterStaging = true
    raceSeed.savePoc({ code: 'save-mark-race', title: 'save mark race', content: 'UPDATED' })
    const racedRow = raceSeed.getPoc(raceInitial.poc.id)
    assert.equal(markAfterStaging, false, 'after-stage phase hook ran the concurrent-use mutation')
    assert.equal(racedRow.hit_count, 1, 'savePoc must preserve the usage count updated after staging')
    assert.equal(racedRow.used_on, '2026-11-13T00:00:00.000Z', 'savePoc must preserve the usage timestamp updated after staging')
  } finally { raceSeed.close() }

  const finalizeRoot = join(root, 'finalize-failure')
  const finalizeSeed = new RedteamStore(finalizeRoot)
  const finalizeOriginal = finalizeSeed.savePoc({ code: 'finalize-case', title: 'finalize case', content: 'OLD' })
  finalizeSeed.close()
  const finalizeStore = new RedteamStore(finalizeRoot, { onPocTransactionPhase(name) {
    if (name === 'after-commit') throw new Error('finalize failpoint')
  } })
  let finalizeError
  try {
    finalizeStore.updatePoc('finalize-case', { content: 'NEW' })
  } catch (error) { finalizeError = error } finally { finalizeStore.close() }
  assert.equal(finalizeError?.code, 'POC_FILE_FINALIZE_FAILED')
  assert.equal(finalizeError?.committed, true)
  assert.ok(finalizeError?.journalId)
  const finalizeDb = new DatabaseSync(join(finalizeRoot, 'knowledge.db'))
  try { assert.ok(finalizeDb.prepare('SELECT 1 FROM __poc_file_journal WHERE id = ?').get(finalizeError.journalId)) }
  finally { finalizeDb.close() }
  recoverAndCheck(finalizeRoot, (recovered) => {
    assert.equal(recovered.getPoc('finalize-case').content, 'NEW')
    assert.equal(readFileSync(finalizeOriginal.path, 'utf8'), 'NEW')
  })

  const poisonedRoot = join(root, 'poisoned-journal')
  const poisonSeed = new RedteamStore(poisonedRoot)
  poisonSeed.kb()
  poisonSeed.close()
  const outsideJournalTarget = join(root, 'journal-outside.txt')
  writeFileSync(outsideJournalTarget, 'KEEP-OUTSIDE')
  const poisonedDb = new DatabaseSync(join(poisonedRoot, 'knowledge.db'))
  try {
    poisonedDb.prepare(`INSERT INTO __poc_file_journal
      (id, op, final_path, temp_path, backup_path, had_original, content, state)
      VALUES(?, 'delete', ?, NULL, NULL, 0, NULL, 'committed')`).run('outside-final', outsideJournalTarget)
  } finally { poisonedDb.close() }
  const poisonedStore = new RedteamStore(poisonedRoot)
  try {
    assert.throws(() => poisonedStore.kb(), /journal path outside managed root/)
    assert.throws(() => poisonedStore.kb(), /journal path outside managed root/)
    assert.equal(readFileSync(outsideJournalTarget, 'utf8'), 'KEEP-OUTSIDE')
    const cleanPoisonDb = new DatabaseSync(join(poisonedRoot, 'knowledge.db'))
    try { cleanPoisonDb.prepare('DELETE FROM __poc_file_journal WHERE id = ?').run('outside-final') }
    finally { cleanPoisonDb.close() }
    assert.ok(poisonedStore.kb(), 'failed recovery must not cache the database handle')
  } finally { poisonedStore.close() }

  const poisonedTempRoot = join(root, 'poisoned-temp-journal')
  const tempSeed = new RedteamStore(poisonedTempRoot)
  tempSeed.kb()
  tempSeed.close()
  const tempFinal = join(tempSeed.pocsDirOf(), 'inside', 'file.txt')
  mkdirSync(dirname(tempFinal), { recursive: true })
  const outsideTemp = join(root, 'journal-outside.tmp')
  writeFileSync(outsideTemp, 'KEEP-TEMP')
  const tempJournalDb = new DatabaseSync(join(poisonedTempRoot, 'knowledge.db'))
  try {
    tempJournalDb.prepare(`INSERT INTO __poc_file_journal
      (id, op, final_path, temp_path, backup_path, had_original, content, state)
      VALUES(?, 'delete', ?, ?, NULL, 0, NULL, 'committed')`).run('outside-temp', tempFinal, outsideTemp)
  } finally { tempJournalDb.close() }
  const tempRecovery = new RedteamStore(poisonedTempRoot)
  try {
    assert.throws(() => tempRecovery.recoverPocFiles(), /journal staging path outside managed root/)
    assert.equal(readFileSync(outsideTemp, 'utf8'), 'KEEP-TEMP')
  } finally { tempRecovery.close() }

  const noFileRoot = join(root, 'no-file-poc')
  const noFileStore = new RedteamStore(noFileRoot)
  try {
    const noFilePoc = noFileStore.savePoc({ code: 'no-file-poc', title: 'no file content' })
    assert.equal(noFilePoc.poc.path, null)
    assert.equal(noFileStore.deletePoc(noFilePoc.poc.id).ok, true)
    assert.equal(noFileStore.kb().prepare('SELECT COUNT(*) AS n FROM __poc_file_journal').get().n, 0)
  } finally { noFileStore.close() }

  const storeRoot = join(root, 'store')
  const store = new RedteamStore(storeRoot)
  try {
    const saved = store.savePoc({ code: 'api-save-fail', title: 'API save fail', content: 'ORIGINAL' })
    const storeDb = store.kb()
    const savePath = saved.path
    storeDb.exec("CREATE TRIGGER fail_poc_insert BEFORE INSERT ON poc WHEN NEW.code = 'api-save-orphan' BEGIN SELECT RAISE(ABORT, 'save failpoint'); END")
    assert.throws(() => store.savePoc({ code: 'api-save-orphan', title: 'save orphan', content: 'REPLACEMENT' }), /save failpoint/)
    assert.equal(store.getPoc('api-save-orphan'), undefined)
    assert.equal(readdirSync(join(store.pocsDirOf(), 'api-save-orphan')).length, 0)
    storeDb.exec('DROP TRIGGER fail_poc_insert')

    storeDb.exec("CREATE TRIGGER fail_poc_overwrite BEFORE UPDATE ON poc WHEN NEW.code = 'api-save-fail' BEGIN SELECT RAISE(ABORT, 'overwrite failpoint'); END")
    assert.throws(() => store.savePoc({ code: 'api-save-fail', title: 'overwrite fail', content: 'REPLACEMENT' }), /overwrite failpoint/)
    assert.equal(store.getPoc('api-save-fail').content, 'ORIGINAL')
    assert.equal(readFileSync(savePath, 'utf8'), 'ORIGINAL')
    assert.deepEqual(readdirSync(dirname(savePath)).sort(), [basename(savePath)])
    storeDb.exec('DROP TRIGGER fail_poc_overwrite')

    storeDb.exec(`CREATE TABLE poc_tx_parent(id INTEGER PRIMARY KEY);
      CREATE TABLE poc_tx_child(parent_id INTEGER REFERENCES poc_tx_parent(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER fail_poc_commit AFTER UPDATE ON poc WHEN NEW.id = ${saved.poc.id}
      BEGIN INSERT INTO poc_tx_child(parent_id) VALUES(987654321); END;`)
    assert.throws(() => store.updatePoc(saved.poc.id, { content: 'COMMIT-FAIL' }), /FOREIGN KEY constraint failed/)
    assert.equal(store.getPoc(saved.poc.id).content, 'ORIGINAL')
    assert.equal(readFileSync(savePath, 'utf8'), 'ORIGINAL')
    assert.deepEqual(readdirSync(dirname(savePath)).sort(), [basename(savePath)])
    storeDb.exec('DROP TRIGGER fail_poc_commit')

    storeDb.exec(`CREATE TRIGGER fail_poc_update BEFORE UPDATE ON poc WHEN NEW.id = ${saved.poc.id}
      BEGIN SELECT RAISE(ABORT, 'update failpoint'); END`)
    assert.throws(() => store.updatePoc(saved.poc.id, { content: 'UPDATE-FAIL' }), /update failpoint/)
    assert.equal(store.getPoc(saved.poc.id).content, 'ORIGINAL')
    assert.equal(readFileSync(savePath, 'utf8'), 'ORIGINAL')
    assert.deepEqual(readdirSync(dirname(savePath)).sort(), [basename(savePath)])
    storeDb.exec('DROP TRIGGER fail_poc_update')

    const sharedPath = join(store.pocsDirOf(), 'api-shared', 'shared.txt')
    mkdirSync(dirname(sharedPath), { recursive: true })
    writeFileSync(sharedPath, 'SHARED')
    const sharedA = store.savePoc({ code: 'api-shared-a', title: 'shared A', content: 'SHARED', filename: 'shared.txt' })
    const sharedB = store.savePoc({ code: 'api-shared-b', title: 'shared B', content: 'SHARED', filename: 'shared.txt' })
    storeDb.prepare('UPDATE poc SET path = ? WHERE code = ?').run(sharedPath, 'api-shared-a')
    storeDb.prepare('UPDATE poc SET path = ? WHERE code = ?').run(sharedPath, 'api-shared-b')
    const beforeDelete = store.getPoc('api-save-fail')
    storeDb.exec(`CREATE TRIGGER fail_poc_delete BEFORE DELETE ON poc WHEN OLD.id = ${saved.poc.id}
      BEGIN SELECT RAISE(ABORT, 'delete failpoint'); END`)
    assert.throws(() => store.deletePoc(saved.poc.id), /delete failpoint/)
    assert.equal(store.getPoc(saved.poc.id).content, beforeDelete.content)
    assert.equal(storeDb.prepare('SELECT content FROM poc_fts WHERE poc_id = ?').get(String(saved.poc.id)).content, 'ORIGINAL')
    assert.equal(readFileSync(savePath, 'utf8'), 'ORIGINAL')
    storeDb.exec('DROP TRIGGER fail_poc_delete')

    const originalPrepare = storeDb.prepare.bind(storeDb)
    storeDb.prepare = (sql) => {
      if (sql === 'DELETE FROM poc_fts WHERE poc_id = ?') throw new Error('FTS failpoint')
      return originalPrepare(sql)
    }
    assert.throws(() => store.deletePoc(saved.poc.id), /FTS failpoint/)
    assert.equal(store.getPoc(saved.poc.id).content, beforeDelete.content)
    assert.equal(storeDb.prepare('SELECT content FROM poc_fts WHERE poc_id = ?').get(String(saved.poc.id)).content, 'ORIGINAL')
    assert.equal(readFileSync(savePath, 'utf8'), 'ORIGINAL')
    storeDb.prepare = originalPrepare
    const updatedShared = store.updatePoc('api-shared-a', { content: 'SHARED-UPDATED' })
    assert.notEqual(updatedShared.path, sharedPath, 'updating a shared path must detach the updated owner')
    assert.equal(readFileSync(updatedShared.path, 'utf8'), 'SHARED-UPDATED')
    assert.equal(storeDb.prepare('SELECT content FROM poc WHERE code = ?').get('api-shared-a').content, 'SHARED-UPDATED')
    assert.equal(readFileSync(sharedPath, 'utf8'), 'SHARED', 'other owner keeps original bytes')
    assert.equal(store.getPoc('api-shared-b').content, 'SHARED')
    const deleted = store.deletePoc('api-shared-a')
    assert.equal(deleted.removed_files, 1, 'detached owner may remove only its new path')
    assert.equal(readFileSync(sharedPath, 'utf8'), 'SHARED')
    assert.equal(store.deletePoc('api-shared-b').removed_files, 1)
    const fallback = store.savePoc({ code: 'fallback-content', title: 'fallback content', content: 'FILE-CONTENT' })
    storeDb.prepare('UPDATE poc SET content = ? WHERE id = ?').run('', fallback.poc.id)
    const fallbackUpdated = store.updatePoc(fallback.poc.id, { content: 'UPDATED-FILE-CONTENT' })
    assert.equal(fallbackUpdated.content, 'UPDATED-FILE-CONTENT')
    assert.equal(readFileSync(fallbackUpdated.path, 'utf8'), 'UPDATED-FILE-CONTENT')
    const twoRowsPath = join(store.pocsDirOf(), 'same-path', 'shared.txt')
    mkdirSync(dirname(twoRowsPath), { recursive: true })
    writeFileSync(twoRowsPath, 'TWO-ROWS')
    store.savePoc({ code: 'two-row-first', title: 'first shared', content: 'TWO-ROWS' })
    store.savePoc({ code: 'two-row-second', title: 'second shared', content: 'TWO-ROWS' })
    storeDb.prepare('UPDATE poc SET path = ? WHERE code IN (?, ?)').run(twoRowsPath, 'two-row-first', 'two-row-second')
    assert.equal(store.deletePoc('two-row-first').removed_files, 0)
    assert.equal(readFileSync(twoRowsPath, 'utf8'), 'TWO-ROWS')
    assert.equal(store.deletePoc('two-row-second').removed_files, 1)
    assert.throws(() => readFileSync(twoRowsPath), { code: 'ENOENT' })
    assert.equal(store.getPoc('api-save-fail').content, 'ORIGINAL')
    void sharedA
    void sharedB
  } finally {
    store.close()
  }
  console.log('PASS poc-file-transaction')
} finally {
  db.close()
  for (const link of [join(root, 'pocs', 'redirect'), join(root, 'pocs-link')]) {
    try { unlinkSync(link) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const cleanup = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import { rmSync } from 'node:fs'; rmSync(process.argv[1], { recursive: true, force: true })",
    root], { encoding: 'utf8', timeout: 15000, windowsHide: true })
  if (cleanup.error || cleanup.status !== 0) {
    console.error(`cleanup child failed: status=${cleanup.status}; ${cleanup.stderr || cleanup.error?.message || ''}`)
    process.exitCode = 1
  }
}
