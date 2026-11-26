// @vitest-environment node
// The README is a hub that links into docs/*.md, and the docs link to each other.
// Every relative link must point at a file that exists, and every #anchor at a
// heading that exists (GitHub's slug rules), so a renamed section can't silently
// break the map.
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'

const files = ['README.md', ...readdirSync('docs').filter((f) => f.endsWith('.md')).map((f) => join('docs', f))]

function slug(h: string): string {
  return h.replace(/`/g, '').trim().toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}_\- ]/gu, '').replace(/ /g, '-')
}

/** Lines outside fenced code blocks. */
function prose(text: string): { line: string; n: number }[] {
  let fence = false
  const out: { line: string; n: number }[] = []
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.trimStart().startsWith('```')) { fence = !fence; return }
    if (!fence) out.push({ line, n: i + 1 })
  })
  return out
}

const anchorCache = new Map<string, Set<string>>()
function anchors(path: string): Set<string> {
  let set = anchorCache.get(path)
  if (set) return set
  set = new Set()
  const seen = new Map<string, number>()
  for (const { line } of prose(readFileSync(path, 'utf8'))) {
    const m = /^#{1,6} (.*)$/.exec(line)
    if (!m) continue
    const s = slug(m[1])
    const k = seen.get(s) ?? 0
    set.add(k === 0 ? s : `${s}-${k}`)
    seen.set(s, k + 1)
  }
  anchorCache.set(path, set)
  return set
}

describe('documentation links', () => {
  it('every relative link and anchor in README.md and docs/*.md resolves', () => {
    const broken: string[] = []
    for (const file of files) {
      for (const { line, n } of prose(readFileSync(file, 'utf8'))) {
        for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) {
          const target = m[1]
          if (/^(https?:|mailto:)/.test(target)) continue
          const [path, frag] = target.split('#')
          const resolved = path ? normalize(join(dirname(file), path)) : file
          if (path && !existsSync(resolved)) { broken.push(`${file}:${n} → ${target} (no such file)`); continue }
          if (frag && resolved.endsWith('.md') && !anchors(resolved).has(frag)) broken.push(`${file}:${n} → ${target} (no such heading)`)
        }
      }
    }
    expect(broken).toEqual([])
  })
})
