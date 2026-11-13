import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep, win32 } from 'node:path'

function inside(root, target) {
  const rel = relative(resolve(root), resolve(target))
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function hasSymlinkAncestor(root, target) {
  const managedRoot = resolve(root)
  let current = dirname(resolve(target))
  while (inside(managedRoot, current)) {
    try {
      if (lstatSync(current).isSymbolicLink()) return true
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return false
}

function canonicallyInside(root, target) {
  const managedRoot = resolve(root)
  try {
    if (lstatSync(managedRoot).isSymbolicLink()) return false
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
  if (!inside(managedRoot, target) || hasSymlinkAncestor(managedRoot, target)) return false
  let canonicalRoot
  let canonicalParent
  try {
    canonicalRoot = realpathSync(managedRoot)
    canonicalParent = realpathSync(dirname(resolve(target)))
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
  const rel = relative(canonicalRoot, canonicalParent)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * Stage beside the destination; promote happens before SQLite COMMIT, and rollback
 * restores the prior file if the transaction fails. This is compensating behavior,
 * not cross-resource atomicity: process crashes/TOCTOU and directory fsync durability
 * are not covered by this Node API implementation.
 */
export class PocFileFinalizeError extends Error {
  constructor(cause, journalId) {
    super(`POC database commit succeeded but file finalize failed: ${cause.message}`, { cause })
    this.name = 'PocFileFinalizeError'
    this.code = 'POC_FILE_FINALIZE_FAILED'
    this.committed = true
    this.journalId = journalId
  }
}

function ensureJournal(db) {
  const schemaReady = () => {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__poc_file_journal'").get()
    if (!table) return false
    return db.prepare('PRAGMA table_info(__poc_file_journal)').all()
      .some((column) => column.name === 'cleanup_paths')
  }
  if (schemaReady()) return
  const ownsTransaction = !db.isTransaction
  if (ownsTransaction) db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS __poc_file_journal (
      id TEXT PRIMARY KEY, op TEXT NOT NULL, final_path TEXT NOT NULL, temp_path TEXT,
      backup_path TEXT, had_original INTEGER NOT NULL DEFAULT 0, content TEXT, state TEXT NOT NULL,
      cleanup_paths TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`)
    let columns = db.prepare('PRAGMA table_info(__poc_file_journal)').all()
    if (!columns.some((column) => column.name === 'cleanup_paths')) {
      try {
        db.exec("ALTER TABLE __poc_file_journal ADD COLUMN cleanup_paths TEXT NOT NULL DEFAULT '[]'")
      } catch (error) {
        columns = db.prepare('PRAGMA table_info(__poc_file_journal)').all()
        if (!columns.some((column) => column.name === 'cleanup_paths')) throw error
      }
    }
    if (ownsTransaction) db.exec('COMMIT')
  } catch (error) {
    if (ownsTransaction) { try { db.exec('ROLLBACK') } catch {} }
    throw error
  }
}

function referencePath(path) {
  if (!path) return ''
  if (process.platform !== 'win32') return resolve(path)
  return win32.resolve(path).replace(/\\/g, '/').toLowerCase()
}

function referencedPoc(db, filePath) {
  const expected = referencePath(filePath)
  return db.prepare('SELECT path, content FROM poc WHERE path IS NOT NULL').all()
    .find((row) => referencePath(row.path) === expected)
}

function isPathReferenced(db, filePath) {
  return referencedPoc(db, filePath) !== undefined
}

function rejectSymlinkLeaf(filePath) {
  try {
    if (lstatSync(filePath).isSymbolicLink()) throw new Error(`POC recovery target is a symlink: ${filePath}`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

function writeRecoveredFile(filePath, content, managedRoot) {
  rejectSymlinkLeaf(filePath)
  const tempPath = resolve(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.recover.tmp`)
  try {
    writeFileSync(tempPath, content, { encoding: 'utf8', flag: 'wx' })
    if (managedRoot && !canonicallyInside(managedRoot, filePath)) {
      throw new Error(`POC journal path outside managed root: ${filePath}`)
    }
    rejectSymlinkLeaf(filePath)
    renameSync(tempPath, filePath)
  } catch (error) {
    rmSync(tempPath, { force: true })
    throw error
  }
}

function removeIfUnreferenced(db, filePath, managedRoot) {
  if (!filePath) return
  if (!managedRoot || !canonicallyInside(managedRoot, filePath)) {
    throw new Error(`POC journal cleanup path outside managed root: ${filePath}`)
  }
  if (!isPathReferenced(db, filePath)) rmSync(filePath, { force: true })
}

function phase(options, name, details = {}) { options?.onPhase?.(name, details) }

function applyJournalRow(db, row, managedRoot) {
  if (row.state === 'committed') {
    if (row.op === 'delete') {
      removeIfUnreferenced(db, row.final_path, managedRoot)
    } else if (row.op !== 'cleanup') {
      const owner = referencedPoc(db, row.final_path)
      if (!owner || owner.content !== row.content) {
        throw new Error(`POC journal does not match committed row: ${row.final_path}`)
      }
      mkdirSync(dirname(row.final_path), { recursive: true })
      writeRecoveredFile(row.final_path, row.content, managedRoot)
    }
    for (const cleanupPath of JSON.parse(row.cleanup_paths || '[]')) removeIfUnreferenced(db, cleanupPath, managedRoot)
    if (row.temp_path) rmSync(row.temp_path, { force: true })
    if (row.backup_path) rmSync(row.backup_path, { force: true })
  } else if (row.had_original) {
    try { renameSync(row.backup_path, row.final_path) } catch (error) { if (error?.code !== 'ENOENT') throw error }
    rmSync(row.temp_path, { force: true })
  } else {
    rmSync(row.temp_path, { force: true })
    if (row.op !== 'delete') rmSync(row.final_path, { force: true })
  }
  db.prepare('DELETE FROM __poc_file_journal WHERE id = ?').run(row.id)
}

export function recoverPocFileTransactions(db, managedRoot) {
  ensureJournal(db)
  const ownsTransaction = !db.isTransaction
  if (ownsTransaction) db.exec('BEGIN IMMEDIATE')
  try {
    const rows = db.prepare('SELECT * FROM __poc_file_journal ORDER BY created_at, id').all()
    let rolledBack = 0, finalized = 0
    for (const row of rows) {
      if (managedRoot && row.final_path && !canonicallyInside(managedRoot, row.final_path)) {
        throw new Error(`POC journal path outside managed root: ${row.final_path}`)
      }
      for (const candidate of [row.temp_path, row.backup_path, ...JSON.parse(row.cleanup_paths || '[]')]) {
        if (candidate && managedRoot && !canonicallyInside(managedRoot, candidate)) {
          throw new Error(`POC journal staging path outside managed root: ${candidate}`)
        }
      }
      applyJournalRow(db, row, managedRoot)
      if (row.state === 'committed') finalized++
      else rolledBack++
    }
    if (ownsTransaction) db.exec('COMMIT')
    return { rolledBack, finalized }
  } catch (error) {
    if (ownsTransaction) { try { db.exec('ROLLBACK') } catch {} }
    throw error
  }
}

export function withPocFileTransaction(db, staged, work, options = {}) {
  ensureJournal(db)
  recoverPocFileTransactions(db, options.managedRoot)
  const journalId = randomUUID()
  const op = options.op === 'delete' ? 'delete' : (staged ? 'write' : (options.getCleanupPaths ? 'cleanup' : 'db'))
  db.exec('BEGIN IMMEDIATE')
  let result
  let deletePath = null
  try {
    phase(options, 'transaction-begin', { journalId, op })
    result = work()
    const cleanupPaths = options.getCleanupPaths ? options.getCleanupPaths(result).filter(Boolean) : []
    deletePath = options.getDeletePath ? options.getDeletePath(result) : options.deletePath
    const shouldJournal = op === 'delete' ? Boolean(deletePath) : (op !== 'db' || cleanupPaths.length > 0)
    if (shouldJournal) {
      db.prepare(`INSERT INTO __poc_file_journal(id, op, final_path, temp_path, backup_path, had_original, content, state, cleanup_paths)
        VALUES(?,?,?,?,?,?,?,'committed',?)`).run(journalId, op, deletePath || staged?.path || '', staged?.tempPath || null,
        staged?.backupPath || null, staged?.hadOriginal ? 1 : 0, staged?.content ?? null, JSON.stringify(cleanupPaths))
    }
    phase(options, op === 'delete' ? 'tombstone-pending' : 'commit-pending', { journalId, op })
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    try { staged?.cleanup() } catch (cleanupError) { error.cleanupError = cleanupError }
    throw error
  }
  try {
    phase(options, op === 'delete' ? 'after-tombstone-commit' : 'after-commit', { journalId, op })
    if ((op === 'db' && !options.getCleanupPaths) || (op === 'delete' && !deletePath)) return result
    db.exec('BEGIN IMMEDIATE')
    const row = db.prepare('SELECT * FROM __poc_file_journal WHERE id = ?').get(journalId)
    if (row) applyJournalRow(db, row, options.managedRoot)
    db.exec('COMMIT')
    staged?.markSettled?.()
    return result
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    if (error instanceof PocFileFinalizeError) throw error
    throw new PocFileFinalizeError(error, journalId)
  }
}

export function stagePocFile(destination, content) {
  const finalPath = resolve(destination)
  const dir = dirname(finalPath)
  mkdirSync(dir, { recursive: true })
  const token = randomUUID()
  const tempPath = resolve(dir, `.${basename(finalPath)}.${token}.tmp`)
  const backupPath = resolve(dir, `.${basename(finalPath)}.${token}.bak`)
  let hadOriginal = false
  let promoted = false
  let settled = false

  try {
    try {
      const info = lstatSync(finalPath)
      if (!info.isFile()) throw new Error(`poc target is not a regular file: ${finalPath}`)
      copyFileSync(finalPath, backupPath)
      hadOriginal = true
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    writeFileSync(tempPath, String(content), { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    rmSync(tempPath, { force: true })
    rmSync(backupPath, { force: true })
    throw error
  }

  return {
    path: finalPath,
    tempPath,
    backupPath,
    hadOriginal,
    content: String(content),
    markSettled() { settled = true },
    promote() {
      if (settled) throw new Error('staged poc file already settled')
      renameSync(tempPath, finalPath)
      promoted = true
      return finalPath
    },
    finalize() {
      if (!promoted || settled) throw new Error('staged poc file is not promoted')
      rmSync(backupPath, { force: true })
      settled = true
    },
    rollback() {
      if (settled) return
      if (promoted) {
        if (hadOriginal) renameSync(backupPath, finalPath)
        else rmSync(finalPath, { force: true })
      } else {
        rmSync(tempPath, { force: true })
        rmSync(backupPath, { force: true })
      }
      settled = true
    },
    cleanup() {
      if (settled) return
      rmSync(tempPath, { force: true })
      rmSync(backupPath, { force: true })
      settled = true
    },
  }
}

/**
 * Remove only an unreferenced regular file strictly below the managed root.
 * Empty its immediate parent only; never recursively removes a directory.
 */
export function removeUnreferencedPocFile(root, filePath, isReferenced) {
  const managedRoot = resolve(root)
  const target = resolve(filePath)
  if (!canonicallyInside(managedRoot, target)) return { removed: false, reason: 'outside-managed-root' }
  if (typeof isReferenced !== 'function' || isReferenced(target)) {
    return { removed: false, reason: 'referenced' }
  }

  let info
  try { info = lstatSync(target) } catch (error) {
    if (error?.code === 'ENOENT') return { removed: false, reason: 'missing' }
    throw error
  }
  if (!info.isFile()) return { removed: false, reason: 'not-regular-file' }

  rmSync(target)
  let removedEmptyDirectory = false
  const parent = dirname(target)
  if (inside(managedRoot, parent)) {
    try {
      rmdirSync(parent)
      removedEmptyDirectory = true
    } catch (error) {
      if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error?.code)) throw error
    }
  }
  return { removed: true, removedEmptyDirectory }
}
