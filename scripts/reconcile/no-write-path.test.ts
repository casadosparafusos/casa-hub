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

  // Excecao unica e estreita: o motor puro de UNIT mora em src/lib/units
  // (PROBLEMA 4/FASE B.1 -- ver docs/ARCHITECTURE_TARGET.md). E o UNICO path
  // de src/ que o reconciliador pode importar, e so o modulo puro em si
  // (sem subpaths de outras pastas de src/). Guardado por seu proprio
  // describe block abaixo, que prova que ele mesmo nao importa write/infra.
  const PURE_UNITS_DOMAIN_IMPORT = /^(\.\.\/)+src\/lib\/units(\/.*)?$/

  it.each(sources)('$file: nao importa modulos da aplicacao (wake client, db, settings, sync)', ({ text }) => {
    const specifiers = [...text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*|req\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '')
    for (const s of specifiers) {
      expect(s.startsWith('node:') || s.startsWith('./') || s === 'better-sqlite3' || PURE_UNITS_DOMAIN_IMPORT.test(s)).toBe(true)
    }
    const forbidden = specifiers.filter((s) => !PURE_UNITS_DOMAIN_IMPORT.test(s))
    expect(forbidden.some((s) => /(^@\/|src\/|wake\/client|db\/index|settings|sync)/.test(s))).toBe(false)
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

// PROBLEMA 4 (FASE B.1): o motor puro de UNIT foi movido de
// scripts/reconcile/units/ para src/lib/units/ (domínio real de producao,
// consumido tanto pelo app -- sync/pricing/inventory engines -- quanto pelo
// reconciliador read-only). Guard dedicado: prova que esse modulo compartilhado
// continua livre de DB, Wake writer, sync engine, settings/env, CISS HTTP e
// filesystem, exatamente como o reconciliador exigia de si mesmo acima.
const UNITS_DIR = path.join(DIR, '..', '..', 'src', 'lib', 'units')
const unitsSources = fs
  .readdirSync(UNITS_DIR)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => path.join(UNITS_DIR, f))
  .map((file) => ({ file: path.relative(path.join(DIR, '..', '..'), file).replace(/\\/g, '/'), text: fs.readFileSync(file, 'utf8') }))

describe('src/lib/units (motor puro compartilhado) sem write/infra path', () => {
  it('encontrou os fontes esperados', () => {
    const names = unitsSources.map((s) => s.file)
    for (const f of ['src/lib/units/types.ts', 'src/lib/units/resolver.ts', 'src/lib/units/strategies.ts', 'src/lib/units/commercial-policy.ts', 'src/lib/units/policy-resolver.ts', 'src/lib/units/compute.ts', 'src/lib/units/decimal.ts', 'src/lib/units/index.ts']) {
      expect(names).toContain(f)
    }
  })

  it.each(unitsSources)('$file: so importa node:, arquivos irmaos (./) ou tipos internos', ({ text }) => {
    const specifiers = [...text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '')
    for (const s of specifiers) {
      expect(s.startsWith('node:') || s.startsWith('./')).toBe(true)
    }
  })

  it.each(unitsSources)('$file: nenhum verbo HTTP de escrita nem fetch', ({ text }) => {
    expect(text).not.toMatch(/['"`](PUT|POST|PATCH|DELETE)['"`]/i)
    expect(text).not.toMatch(/\bfetch\s*\(/)
    expect(text).not.toMatch(/\bfetchImpl\s*\(/)
  })

  it.each(unitsSources)('$file: nenhum SQL nem acesso a DB', ({ text }) => {
    expect(text).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|REPLACE\s+INTO|DROP\s+TABLE|ALTER\s+TABLE|CREATE\s+TABLE|SELECT\s+.+\s+FROM)\b/i)
    expect(text).not.toMatch(/\bbetter-sqlite3\b/)
    expect(text).not.toMatch(/\.prepare\s*\(/)
  })

  it.each(unitsSources)('$file: nenhuma leitura de settings/env', ({ text }) => {
    expect(text).not.toMatch(/\bprocess\.env\b/)
    expect(text).not.toMatch(/\bgetSetting\s*\(/)
  })

  it.each(unitsSources)('$file: nenhuma escrita em disco', ({ text }) => {
    expect(text).not.toMatch(/\b(writeFileSync|appendFileSync|createWriteStream|writeFile|unlinkSync|rmSync|renameSync|mkdirSync|readFileSync|readdirSync)\b/)
  })
})
