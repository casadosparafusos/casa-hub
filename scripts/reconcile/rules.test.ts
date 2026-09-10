import { describe, expect, it } from 'vitest'
import { classifyUnit, computeExpected, pricesMatch, safeFloor } from './rules'

describe('classifyUnit', () => {
  it('normaliza caixa e espacos', () => {
    expect(classifyUnit(' cento ')).toEqual({ kind: 'ok', unit: 'CENTO' })
    expect(classifyUnit('PC')).toEqual({ kind: 'ok', unit: 'PC' })
    expect(classifyUnit('un')).toEqual({ kind: 'ok', unit: 'UN' })
    expect(classifyUnit('Kg')).toEqual({ kind: 'ok', unit: 'KG' })
  })
  it('ausente ou vazio = missing', () => {
    expect(classifyUnit(null)).toEqual({ kind: 'missing' })
    expect(classifyUnit(undefined)).toEqual({ kind: 'missing' })
    expect(classifyUnit('   ')).toEqual({ kind: 'missing' })
  })
  it('desconhecida = unsupported (fail closed, nunca assume CENTO)', () => {
    expect(classifyUnit('MILHEIRO')).toEqual({ kind: 'unsupported', raw: 'MILHEIRO' })
    expect(classifyUnit('CX')).toEqual({ kind: 'unsupported', raw: 'CX' })
  })
})

describe('computeExpected', () => {
  it('CENTO: preco/100 * 1.20, atacado = varejo * 0.80, estoque = floor(s*100*0.10)', () => {
    const r = computeExpected({ unit: 'CENTO', cissPrice: 25, cissStock: 36.69 })
    expect(r).toMatchObject({
      kind: 'ok',
      expectedRetailPrice: 0.3,
      expectedWholesalePrice: 0.24,
      expectedStock: 366,
      priceTableExpected: 0.3,
    })
  })

  it('CENTO: estoque negativo vira 0', () => {
    const r = computeExpected({ unit: 'CENTO', cissPrice: 10, cissStock: -5 })
    expect(r).toMatchObject({ kind: 'ok', expectedStock: 0 })
  })

  it('CENTO: estoque igual a formula literal de producao para todo valor com 3 casas ate 1000', () => {
    for (let i = 0; i <= 1_000_000; i++) {
      const s = i / 1000
      const r = computeExpected({ unit: 'CENTO', cissPrice: 10, cissStock: s })
      if (r.kind !== 'ok') throw new Error('esperado ok')
      const prod = Math.floor(Math.max(s, 0) * 100 * (10 / 100))
      if (r.expectedStock !== prod || r.floatEdgeNote) throw new Error(`divergencia em ${s}: ${r.expectedStock} vs ${prod}`)
    }
  })

  it('PC: preco = preco CISS, sem x100, sem /100, sem markup; estoque = floor(s)', () => {
    const r = computeExpected({ unit: 'PC', cissPrice: 12.5, cissStock: 7.9 })
    expect(r).toEqual({ kind: 'ok', expectedRetailPrice: 12.5, expectedWholesalePrice: null, expectedStock: 7, priceTableExpected: 12.5 })
  })

  it('UN: mesma regra de PC', () => {
    const r = computeExpected({ unit: 'UN', cissPrice: 3.99, cissStock: 40 })
    expect(r).toEqual({ kind: 'ok', expectedRetailPrice: 3.99, expectedWholesalePrice: null, expectedStock: 40, priceTableExpected: 3.99 })
  })

  it('KG com embalagem: preco = preco_kg * kg_por_caixa; estoque = floor(kg / kg_por_caixa)', () => {
    const r = computeExpected({ unit: 'KG', cissPrice: 30, cissStock: 12.5, packageWeightKg: 5 })
    expect(r).toMatchObject({ kind: 'ok', expectedRetailPrice: 150, expectedStock: 2, expectedWholesalePrice: null })
  })

  it('KG sem embalagem: CONFIGURATION_REQUIRED, nao inventa valor', () => {
    const r = computeExpected({ unit: 'KG', cissPrice: 30, cissStock: 12.5 })
    expect(r.kind).toBe('configuration_required')
    expect(computeExpected({ unit: 'KG', cissPrice: 30, cissStock: 12.5, packageWeightKg: null }).kind).toBe('configuration_required')
  })

  it('KG com embalagem invalida: CONFIGURATION_REQUIRED', () => {
    expect(computeExpected({ unit: 'KG', cissPrice: 30, cissStock: 1, packageWeightKg: 0 }).kind).toBe('configuration_required')
    expect(computeExpected({ unit: 'KG', cissPrice: 30, cissStock: 1, packageWeightKg: -2 }).kind).toBe('configuration_required')
  })

  it('preco invalido = invalid_input', () => {
    expect(computeExpected({ unit: 'PC', cissPrice: Number.NaN, cissStock: 1 }).kind).toBe('invalid_input')
    expect(computeExpected({ unit: 'PC', cissPrice: -1, cissStock: 1 }).kind).toBe('invalid_input')
  })
})

describe('safeFloor / pricesMatch', () => {
  it('safeFloor corrige ruido de float', () => {
    expect(safeFloor(22.999999999999996)).toBe(23)
    expect(safeFloor(22.9)).toBe(22)
  })
  it('pricesMatch com tolerancia de meio centavo', () => {
    expect(pricesMatch(0.3, 0.3)).toBe(true)
    expect(pricesMatch(0.3, 0.304)).toBe(true)
    expect(pricesMatch(0.3, 0.31)).toBe(false)
    expect(pricesMatch(null, 0.3)).toBeNull()
  })
})
