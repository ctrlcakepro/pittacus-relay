import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { PRIVATE_FILE_MODE, restrictToOwner } from '../security'

export type Json = Record<string, any>

/** Returns null when the file does not exist; throws when it is not a JSON object. */
export function readJsonObject(file: string): Json | null {
  if (!existsSync(file)) return null
  const text = readFileSync(file, 'utf8').replace(/^﻿/, '')
  if (!text.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${file} is not plain JSON (comments or syntax errors?). Pittacus Relay will not overwrite it.`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} does not contain a JSON object.`)
  }
  return parsed as Json
}

/** Writes atomically and owner-only: these files hold Pittacus Relay's local key or the user's original keys. */
export function writeJsonObject(file: string, value: Json): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.pittacus-tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: PRIVATE_FILE_MODE })
  // writeFileSync's mode only applies on creation; a tmp left by a crash keeps its old mode.
  restrictToOwner(tmp)
  renameSync(tmp, file)
}

export function removeFile(file: string): void {
  rmSync(file, { force: true })
}
