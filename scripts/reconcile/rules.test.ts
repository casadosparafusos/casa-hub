import { describe, expect, it } from 'vitest'
import { classifyUnit, computeExpected, moneyRound, pricesMatch, safeFloor } from './rules'

describe('classifyUnit (adapter sobre ./units)', () => {
  it('CT -> ok HUNDRED', () => {
    expect(classifyUnit('CT')).toEqual({ kind: 'ok', unit: 'HUNDRED' })
  })

  it('" ct " -> ok HUNDRED (trim + uppercase)', () => {
    expect(classifyUnit(' ct ')).toEqual({ kind: 'ok', unit: 'HUNDRED' })
  })

  it.each(['PC', 'UN', 'JG', 'PR', 'CJ', 'RL', 'KT', 'CX', 'LT', 'PL'])('%s -> ok DIRECT', (raw) => {
    expect(classifyUnit(raw)).toEqual({ kind: 'ok', unit: 'DIRECT' })
  })

  it.each(['KG', 'MT'])('%s -> ok PACKAGE_MEASURED', (raw) => {
    expect(classifyUnit(raw)).toEqual({ kind: 'ok', unit: 'PACKAGE_MEASURED' })
  })

  it('unidade desconhecida -> unsupported (fail closed, nunca DIRECT por padrao)', () => {
    expect(classifyUnit('XYZ')).toEqual({ kind: 'unsupported', raw: 'XYZ' })
    expect(classifyUnit('CENTO')).toEqual({ kind: 'unsupported', raw: 'CENTO' })
    expect(classifyUnit('MILHEIRO')).toEqual({ kind: 'unsupported', raw: 'MILHEIRO' })
  })

  it('ausente/vazio -> missing', () => {
    expect(classifyUnit(null)).toEqual({ kind: 'missing' })
    expect(classifyUnit(undefined)).toEqual({ kind: 'missing' })
    expect(classifyUnit('')).toEqual({ kind: 'missing' })
    expect(classifyUnit('   ')).toEqual({ kind: 'missing' })
  })
})

describe('computeExpected -- DIRECT (PC/UN/...)', () => {
  it('1:1, sem markup, sem atacado', () => {
    const r = computeExpected({ unitRaw: 'PC', cissPrice: 2.07, cissStock: 1894 })
    expect(r).toMatchObject({ kind: 'ok', expectedRetailPrice: 2.07, expectedWholesalePrice: null, expectedStock: 1894, priceTableExpected: 2.07 })
  })

  it('UN: mesma regra de PC', () => {
    const r = computeExpected({ unitRaw: 'UN', cissPrice: 3.99, cissStock: 40 })
    expect(r).toMatchObject({ kind: 'ok', expectedRetailPrice: 3.99, expectedWholesalePrice: null, expectedStock: 40, priceTableExpected: 3.99 })
  })

  it('estoque fracionario -> floor', () => {
    const r = computeExpected({ unitRaw: 'PC', cissPrice: 10, cissStock: 5.9 })
    expect(r).toMatchObject({ kind: 'ok', expectedStock: 5 })
  })

  it('estoque negativo -> 0', () => {
    const r = computeExpected({ unitRaw: 'PC', cissPrice: 10, cissStock: -5 })
    expect(r).toMatchObject({ kind: 'ok', expectedStock: 0 })
  })
})

describe('computeExpected -- HUNDRED (CT + FIXADOR_CENTO)', () => {
  it('CISS P100=300, estoque=2.3 -> retail=3.60, wholesale=2.88, stock=23', () => {
    const r = computeExpected({ unitRaw: 'CT', cissPrice: 300, cissStock: 2.3 })
    expect(r).toMatchObject({ kind: 'ok', expectedRetailPrice: 3.6, expectedWholesalePrice: 2.88, expectedStock: 23, priceTableExpected: 3.6 })
  })

  it('estoque negativo vira 0 unidades fisicas -> 0 vendavel', () => {
    const r = computeExpected({ unitRaw: 'CT', cissPrice: 10, cissStock: -5 })
    expect(r).toMatchObject({ kind: 'ok', expectedStock: 0 })
  })
})

describe('computeExpected -- PACKAGE_MEASURED (KG/MT)', () => {
  it('KG sem kg_por_caixa -> configuration_required, nao inventa valor', () => {
    const r = computeExpected({ unitRaw: 'KG', cissPrice: 10, cissStock: 340 })
    expect(r.kind).toBe('configuration_required')
    expect(computeExpected({ unitRaw: 'KG', cissPrice: 10, cissStock: 340, packageWeightKg: null }).kind).toBe('configuration_required')
  })

  it('MT sem configuracao -> configuration_required', () => {
    const r = computeExpected({ unitRaw: 'MT', cissPrice: 10, cissStock: 50 })
    expect(r.kind).toBe('configuration_required')
  })

  it('KG com embalagem invalida -> configuration_required', () => {
    expect(computeExpected({ unitRaw: 'KG', cissPrice: 30, cissStock: 1, packageWeightKg: 0 }).kind).toBe('configuration_required')
    expect(computeExpected({ unitRaw: 'KG', cissPrice: 30, cissStock: 1, packageWeightKg: -2 }).kind).toBe('configuration_required')
  })

  it('KG com 18kg/caixa -> 340/18 = 18 caixas, preco=180', () => {
    const r = computeExpected({ unitRaw: 'KG', cissPrice: 10, cissStock: 340, packageWeightKg: 18 })
    expect(r).toMatchObject({ kind: 'ok', expectedRetailPrice: 180, expectedStock: 18, expectedWholesalePrice: null })
  })
})

describe('computeExpected -- entrada invalida', () => {
  it('preco negativo/NaN -> invalid_input, nunca lanca', () => {
    expect(computeExpected({ unitRaw: 'PC', cissPrice: Number.NaN, cissStock: 1 }).kind).toBe('invalid_input')
    expect(computeExpected({ unitRaw: 'PC', cissPrice: -1, cissStock: 1 }).kind).toBe('invalid_input')
  })
})

describe('safeFloor / moneyRound (re-exportados de ./units)', () => {
  it('safeFloor corrige ruido de float', () => {
    expect(safeFloor(22.999999999999996)).toBe(23)
    expect(safeFloor(22.9)).toBe(22)
  })

  it('moneyRound arredonda meio-para-cima em 2 casas', () => {
    expect(moneyRound(3.005)).toBe(3.01)
  })
})

describe('pricesMatch', () => {
  it('dentro da tolerancia (meio centavo) -> true', () => {
    expect(pricesMatch(0.3, 0.3)).toBe(true)
    expect(pricesMatch(0.3, 0.304)).toBe(true)
  })

  it('fora da tolerancia -> false', () => {
    expect(pricesMatch(0.3, 0.31)).toBe(false)
  })

  it('null em qualquer lado -> null (nao comparavel)', () => {
    expect(pricesMatch(null, 0.3)).toBeNull()
    expect(pricesMatch(0.3, null)).toBeNull()
  })
})
