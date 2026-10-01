// Line-level edits to a TOML file that leave everything else (comments, order, formatting)
// untouched. Only what Pittacus Relay needs: root keys and whole tables, no full parser.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { PRIVATE_FILE_MODE, restrictToOwner } from '../security'

interface Entry {
  /** Dotted key, normalised ("a.b"). */
  key: string
  /** Table the entry belongs to; null for the root. */
  table: string | null
  start: number
  /** Last line of the value (inclusive), for arrays and strings spanning lines. */
  end: number
}

interface Header {
  name: string
  line: number
}

export class TomlDoc {
  private lines: string[]
  private readonly eol: string

  constructor(text: string) {
    this.eol = text.includes('\r\n') ? '\r\n' : '\n'
    const body = text.replace(/^﻿/, '')
    this.lines = body ? body.split(/\r?\n/) : []
    if (this.lines.at(-1) === '') this.lines.pop()
  }

  toString(): string {
    return this.lines.length ? this.lines.join(this.eol) + this.eol : ''
  }

  /** Raw text of a root key's assignment, or null when absent. */
  rootRaw(key: string): string | null {
    const e = this.scan().entries.find((x) => x.table === null && x.key === key)
    return e ? this.lines.slice(e.start, e.end + 1).join('\n') : null
  }

  /** The value of a root key or a key in `table`, when it is a plain one-line string. */
  stringValue(key: string, table: string | null = null): string | undefined {
    const e = this.scan().entries.find((x) => x.table === table && x.key === key)
    if (!e || e.start !== e.end) return undefined
    const line = this.lines[e.start]
    const value = line.slice(line.length - line.trimStart().length + keyEnd(line.trim()) + 1).trim()
    const m = /^"((?:[^"\\]|\\.)*)"|^'([^']*)'/.exec(value)
    if (!m) return undefined
    if (m[2] !== undefined) return m[2]
    try {
      return JSON.parse(`"${m[1]}"`)
    } catch {
      return undefined
    }
  }

  /** Sets a root key to raw TOML text ("key = value"), replacing any existing assignment. */
  setRootRaw(key: string, raw: string): void {
    const { entries, headers } = this.scan()
    const existing = entries.find((x) => x.table === null && x.key === key)
    const newLines = raw.split(/\r?\n/)
    if (existing) {
      this.lines.splice(existing.start, existing.end - existing.start + 1, ...newLines)
      return
    }
    const rootEntries = entries.filter((x) => x.table === null)
    if (rootEntries.length) {
      this.lines.splice(rootEntries.at(-1)!.end + 1, 0, ...newLines)
    } else {
      // Before the first table, keeping the root keys out of it.
      const at = headers[0]?.line ?? this.lines.length
      this.lines.splice(at, 0, ...newLines, ...(at < this.lines.length ? [''] : []))
    }
  }

  removeRoot(key: string): void {
    const e = this.scan().entries.find((x) => x.table === null && x.key === key)
    if (e) this.lines.splice(e.start, e.end - e.start + 1)
  }

  /** Raw text of `[name]` and its sub-tables, or null when absent. */
  tableRaw(name: string): string | null {
    const ranges = this.tableRanges(name)
    if (!ranges.length) return null
    return ranges.map(([a, b]) => this.lines.slice(a, b).join('\n')).join('\n')
  }

  removeTable(name: string): void {
    for (const [a, b] of this.tableRanges(name).reverse()) this.lines.splice(a, b - a)
    while (this.lines.length && this.lines.at(-1)!.trim() === '') this.lines.pop()
  }

  /** Appends raw table text at the end of the file. */
  appendTable(raw: string): void {
    while (this.lines.length && this.lines.at(-1)!.trim() === '') this.lines.pop()
    if (this.lines.length) this.lines.push('')
    this.lines.push(...raw.replace(/\s+$/, '').split(/\r?\n/))
  }

  /** True when `name` is also defined some other way (dotted keys or an inline table). */
  definedOutsideTable(name: string): boolean {
    const { entries } = this.scan()
    return entries.some((e) => {
      const full = e.table ? `${e.table}.${e.key}` : e.key
      return !this.inTable(e, name) && (full === name || full.startsWith(`${name}.`))
    })
  }

  private inTable(e: Entry, name: string): boolean {
    return e.table === name || !!e.table?.startsWith(`${name}.`)
  }

  /** [start, endExclusive) line ranges covering `[name]` and `[name.*]`. */
  private tableRanges(name: string): [number, number][] {
    const { headers } = this.scan()
    const ranges: [number, number][] = []
    headers.forEach((h, i) => {
      if (h.name !== name && !h.name.startsWith(`${name}.`)) return
      let end = headers[i + 1]?.line ?? this.lines.length
      // Leave the blank lines and comments that lead into the next table with it.
      while (end > h.line + 1 && /^\s*(#.*)?$/.test(this.lines[end - 1])) end--
      ranges.push([h.line, end])
    })
    return ranges
  }

  private scan(): { entries: Entry[]; headers: Header[] } {
    const entries: Entry[] = []
    const headers: Header[] = []
    let table: string | null = null
    for (let i = 0; i < this.lines.length; i++) {
      const trimmed = this.lines[i].trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      if (trimmed.startsWith('[')) {
        const m = /^\[\[?\s*(.+?)\s*\]\]?\s*(#.*)?$/.exec(trimmed)
        table = m ? normalizeKey(m[1]) : trimmed
        headers.push({ name: table, line: i })
        continue
      }
      const eq = keyEnd(trimmed)
      if (eq < 0) continue
      const key = normalizeKey(trimmed.slice(0, eq))
      const indent = this.lines[i].length - this.lines[i].trimStart().length
      const end = valueEnd(this.lines, i, indent + eq + 1)
      entries.push({ key, table, start: i, end })
      i = end
    }
    return { entries, headers }
  }
}

/** Index of the "=" ending a key, skipping quoted key parts. */
function keyEnd(line: string): number {
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === '=') return i
  }
  return -1
}

function normalizeKey(raw: string): string {
  const parts: string[] = []
  let current = ''
  let quote = ''
  for (const c of raw) {
    if (quote) {
      if (c === quote) quote = ''
      else current += c
    } else if (c === '"' || c === "'") quote = c
    else if (c === '.') {
      parts.push(current.trim())
      current = ''
    } else current += c
  }
  parts.push(current.trim())
  return parts.join('.')
}

/** Last line of a value starting at `col` of line `start`: follows open brackets and multi-line strings. */
function valueEnd(lines: string[], start: number, col: number): number {
  let depth = 0
  let multi = ''
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]
    let j = i === start ? col : 0
    while (j < line.length) {
      if (multi) {
        if (multi === '"""' && line[j] === '\\') {
          j += 2
          continue
        }
        if (line.startsWith(multi, j)) {
          j += 3
          multi = ''
        } else j++
        continue
      }
      const c = line[j]
      if (c === '#') break
      if (line.startsWith('"""', j) || line.startsWith("'''", j)) {
        multi = line.slice(j, j + 3)
        j += 3
      } else if (c === '"' || c === "'") {
        j++
        while (j < line.length && line[j] !== c) j += c === '"' && line[j] === '\\' ? 2 : 1
        j++
      } else {
        if (c === '[' || c === '{') depth++
        else if (c === ']' || c === '}') depth--
        j++
      }
    }
    if (!multi && depth <= 0) return i
  }
  return lines.length - 1
}

/** A TOML basic string; JSON's escapes are all valid TOML escapes. */
export function tomlString(value: string): string {
  return JSON.stringify(value)
}

export function readToml(file: string): TomlDoc | null {
  if (!existsSync(file)) return null
  return new TomlDoc(readFileSync(file, 'utf8'))
}

/** Writes atomically and owner-only, like writeJsonObject: the file holds the local key. */
export function writeToml(file: string, doc: TomlDoc): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.pittacus-tmp`
  writeFileSync(tmp, doc.toString(), { encoding: 'utf8', mode: PRIVATE_FILE_MODE })
  restrictToOwner(tmp)
  renameSync(tmp, file)
}
