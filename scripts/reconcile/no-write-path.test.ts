import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Teste ESTATICO: prova que o reconciliador nao tem caminho de escrita.
// Varre o codigo-fonte (nao-teste) de scripts/reconcile/ + o CLI.

const DIR = __dirname
const CLI = path.join(DIR, '..', 'reconcile-readonly.ts')
const CENSUS_CLI = path.join(DIR, '..', 'ciss-unit-census.ts')
const sources = [
  ...fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => path.join(DIR, f)),
  CLI,
  CENSUS_CLI,
].map((file) => ({ file: path.relative(path.join(DIR, '..'), file).replace(/\\/g, '/'), text: fs.readFileSync(file, 'utf8') }))

describe('reconciliador sem write path', () => {
  it('encontrou os fontes esperados', () => {
    const names = sources.map((s) => s.file)
    for (const f of ['reconcile/http.ts', 'reconcile/wake-reader.ts', 'reconcile/ciss-reader.ts', 'reconcile/db-readonly.ts', 'reconcile-readonly.ts', 'reconcile/unit-census.ts', 'ciss-unit-census.ts']) {
      expect(names).toContain(f)
    }
  })

  it.each(sources)('$file: nenhum verbo HTTP de escrita', ({ text }) => {
    expect(text).not.toMatch(/['"`](PUT|POST|PATCH|DELETE)['"`]/i)
  })

  it.each(sources)('$file: todo `method` e GET', ({ text }) => {
    for (const m of text.matchAll(/\bmethod\s*:\s*([^,;}\n]+)/g)) {
      expect((m[1] ?? '').trim()).toBe("'GET'")
    }
  })

  it.each(sources)('$file: fetch so e chamado dentro de http.ts', ({ file, text }) => {
    if (file === 'reconcile/http.ts') return
    expect(text).not.toMatch(/\bfetch\s*\(/)
    expect(text).not.toMatch(/\bfetchImpl\s*\(/)
  })

  it.each(sources)('$file: nao importa modulos da aplicacao (wake client, db, settings, sync)', ({ text }) => {
    const specifiers = [...text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*|req\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '')
    for (const s of specifiers) {
      expect(s.startsWith('node:') || s.startsWith('./') || s === 'better-sqlite3').toBe(true)
    }
    expect(specifiers.some((s) => /(^@\/|src\/|wake\/client|db\/index|settings|sync)/.test(s))).toBe(false)
  })

  it.each(sources)('$file: nenhum SQL de escrita', ({ text }) => {
    expect(text).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|REPLACE\s+INTO|DROP\s+TABLE|ALTER\s+TABLE|CREATE\s+TABLE)\b/i)
    expect(text).not.toMatch(/\.run\s*\(/)
    expect(text).not.toMatch(/\bdb\.exec\s*\(/)
  })

  it('SQLite aberto em readonly + query_only', () => {
    const db = sources.find((s) => s.file === 'reconcile/db-readonly.ts')?.text ?? ''
    expect(db).toMatch(/readonly:\s*true/)
    expect(db).toMatch(/fileMustExist:\s*true/)
    expect(db).toMatch(/query_only\s*=\s*ON/)
    for (const m of db.matchAll(/prepare\(\s*[`'"]\s*(\w+)/g)) expect((m[1] ?? '').toUpperCase()).toBe('SELECT')
  })

  it.each(sources)('$file: escrita em disco so no output.ts (artefatos)', ({ file, text }) => {
    if (file === 'reconcile/output.ts') return
    expect(text).not.toMatch(/\b(writeFileSync|appendFileSync|createWriteStream|writeFile|unlinkSync|rmSync|renameSync|mkdirSync)\b/)
  })
})
