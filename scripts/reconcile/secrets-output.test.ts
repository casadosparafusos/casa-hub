import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertNoSecrets, csvCell, toCsv, writeArtifacts } from './output'
import type { ReconciliationRow } from './reconcile'
import { decryptSecretV1, resolveSecret } from './secrets'

// Mesmo formato de src/lib/crypto/secret-box.ts, montado aqui so para o teste.
function encryptV1(plain: string, masterKey: string): string {
  const key = createHash('sha256').update(masterKey).digest()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ct.toString('base64')}`
}

describe('secrets', () => {
  it('decifra o formato v1 da tela de Configuracoes', () => {
    expect(decryptSecretV1(encryptV1('abc-123', 'master'), 'master')).toBe('abc-123')
  })
  it('chave errada falha (nao devolve lixo)', () => {
    expect(() => decryptSecretV1(encryptV1('abc-123', 'master'), 'outra')).toThrow()
  })
  it('precedencia: banco > env > nenhum, devolvendo so a origem para o log', () => {
    expect(resolveSecret(encryptV1('db-val', 'k'), 'env-val', 'k')).toEqual({ value: 'db-val', source: 'db' })
    expect(resolveSecret(null, ' env-val ', 'k')).toEqual({ value: 'env-val', source: 'env' })
    expect(resolveSecret(null, undefined, 'k')).toEqual({ value: null, source: 'none' })
  })
})

function row(partial: Partial<ReconciliationRow>): ReconciliationRow {
  return {
    ciss_product_id: '1',
    wake_sku: 'A',
    wake_variant_id: '10',
    unit: 'CENTO',
    unit_raw: 'CENTO',
    ciss_price: 25,
    ciss_stock: 1,
    ciss_enterprise: 2,
    ciss_location: 2,
    package_weight_kg: null,
    expected_retail_price: 0.3,
    expected_wholesale_price: 0.24,
    wake_current_price: 0.3,
    price_match: true,
    expected_stock: 10,
    wake_current_stock: 10,
    stock_match: true,
    price_table_expected: 0.3,
    price_table_actual: 0.3,
    price_table_match: true,
    wake_variant_id_actual: 10,
    wake_preco_de: 0.39,
    price_table_preco_de_actual: 0.39,
    status: 'MATCH',
    error: null,
    ...partial,
  }
}

describe('output', () => {
  it('csvCell escapa aspas, virgula, ponto-e-virgula e quebra de linha', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('x "y"')).toBe('"x ""y"""')
    expect(csvCell('x; "y"')).toBe('"x; ""y"""')
    expect(csvCell(null)).toBe('')
    expect(csvCell(false)).toBe('false')
  })

  it('CSV tem os campos obrigatorios no cabecalho', () => {
    const header = toCsv([row({})]).split('\n')[0] ?? ''
    for (const col of [
      'ciss_product_id', 'wake_sku', 'wake_variant_id', 'unit', 'ciss_price', 'ciss_stock', 'package_weight_kg',
      'expected_retail_price', 'expected_wholesale_price', 'wake_current_price', 'price_match', 'expected_stock',
      'wake_current_stock', 'stock_match', 'price_table_expected', 'price_table_actual', 'price_table_match', 'status', 'error',
    ]) {
      expect(header.split(',')).toContain(col)
    }
  })

  it('assertNoSecrets bloqueia gravacao se um segredo aparecer', () => {
    expect(() => assertNoSecrets('ok', ['segredo-longo'])).not.toThrow()
    expect(() => assertNoSecrets('x segredo-longo y', ['segredo-longo'])).toThrow(/segredo/)
    expect(() => assertNoSecrets('curto', [null, undefined, 'curto'])).not.toThrow() // < 8 chars ignorado
  })

  it('writeArtifacts grava JSON+CSV e nao sobrescreve arquivo existente', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-test-'))
    try {
      const report = { meta: {}, rows: [row({})] }
      const out = writeArtifacts(dir, '20260910-1200', report, ['nao-aparece-no-report'])
      expect(path.basename(out.jsonPath)).toBe('reconciliation-20260910-1200.json')
      expect(fs.readFileSync(out.csvPath, 'utf8')).toContain('MATCH')
      expect(() => writeArtifacts(dir, '20260910-1200', report, [])).toThrow()
      const leaking = { meta: { oops: 'token-vazado-123' }, rows: [] }
      expect(() => writeArtifacts(dir, '20260910-1300', leaking, ['token-vazado-123'])).toThrow()
      expect(fs.existsSync(path.join(dir, 'reconciliation-20260910-1300.json'))).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
