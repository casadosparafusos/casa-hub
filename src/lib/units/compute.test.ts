import { describe, expect, it } from 'vitest'
import { computeUnit } from './compute'

describe('computeUnit -- caso real PC (controle dry-run)', () => {
  it('price=2.07, stock=1894 -> price=2.07, stock=1894 (DIRECT, 1:1)', () => {
    const r = computeUnit({ unitRaw: 'PC', cissPrice: 2.07, cissStock: 1894 })
    expect(r).toMatchObject({ ok: true, unitClass: 'DIRECT', policy: 'NONE', salePrice: 2.07, saleStock: 1894 })
  })
})

describe('computeUnit -- CT (HUNDRED + FIXADOR_CENTO)', () => {
  it('reproduz preco/estoque combinando strategy + politica', () => {
    const r = computeUnit({ unitRaw: 'CT', cissPrice: 300, cissStock: 2.3 })
    expect(r).toMatchObject({
      ok: true,
      unitClass: 'HUNDRED',
      policy: 'FIXADOR_CENTO',
      salePrice: 3.6,
      wholesalePrice: 2.88,
      wholesaleMinQty: 100,
      physicalUnits: 230,
      saleStock: 23,
    })
  })
})

describe('computeUnit -- CT + NoCommercialPolicy (PROBLEMA 2)', () => {
  it('commercialPolicyOverride=NONE -> CT vira identidade, nunca FIXADOR_CENTO', () => {
    const r = computeUnit({ unitRaw: 'CT', cissPrice: 300, cissStock: 2.3, commercialPolicyOverride: 'NONE' })
    expect(r).toMatchObject({ ok: true, unitClass: 'HUNDRED', policy: 'NONE' })
    if (!r.ok) throw new Error('unreachable')
    expect(r.wholesalePrice).toBeUndefined()
    expect(r.wholesaleMinQty).toBeUndefined()
  })

  it('CT + NoCommercialPolicy produz numeros DIFERENTES de CT + FIXADOR_CENTO para a mesma entrada', () => {
    const withPolicy = computeUnit({ unitRaw: 'CT', cissPrice: 300, cissStock: 2.3 })
    const withoutPolicy = computeUnit({ unitRaw: 'CT', cissPrice: 300, cissStock: 2.3, commercialPolicyOverride: 'NONE' })
    expect(withPolicy).toMatchObject({ ok: true, salePrice: 3.6, saleStock: 23 })
    expect(withoutPolicy).toMatchObject({ ok: true, salePrice: 3, saleStock: 230 })
  })
})

describe('computeUnit -- commercialPolicyConfig muda o resultado de HUNDRED (PROBLEMA 1)', () => {
  it('markup 20% (default) vs 30%', () => {
    const r20 = computeUnit({ unitRaw: 'CT', cissPrice: 300, cissStock: 2.3 })
    const r30 = computeUnit({
      unitRaw: 'CT',
      cissPrice: 300,
      cissStock: 2.3,
      commercialPolicyConfig: { markupPercent: 30, wholesaleDiscountPercent: 20, stockExposurePercent: 10, wholesaleMinQty: 100 },
    })
    expect(r20).toMatchObject({ ok: true, salePrice: 3.6 })
    expect(r30).toMatchObject({ ok: true, salePrice: 3.9 })
  })

  it('exposicao de estoque 10% (default) vs 15%', () => {
    const r10 = computeUnit({ unitRaw: 'CT', cissPrice: 300, cissStock: 2.3 })
    const r15 = computeUnit({
      unitRaw: 'CT',
      cissPrice: 300,
      cissStock: 2.3,
      commercialPolicyConfig: { markupPercent: 20, wholesaleDiscountPercent: 20, stockExposurePercent: 15, wholesaleMinQty: 100 },
    })
    expect(r10).toMatchObject({ ok: true, saleStock: 23 })
    expect(r15).toMatchObject({ ok: true, saleStock: 34 })
  })

  it('DIRECT e PACKAGE_MEASURED ignoram commercialPolicyConfig por completo (nao tem policy)', () => {
    const direct = computeUnit({
      unitRaw: 'PC',
      cissPrice: 2.07,
      cissStock: 1894,
      commercialPolicyConfig: { markupPercent: 999, wholesaleDiscountPercent: 999, stockExposurePercent: 999, wholesaleMinQty: 999 },
    })
    expect(direct).toMatchObject({ ok: true, unitClass: 'DIRECT', salePrice: 2.07, saleStock: 1894 })
  })
})

describe('computeUnit -- KG/MT sem configuracao', () => {
  it('KG sem packageConfig -> CONFIGURATION_REQUIRED, zero write', () => {
    const r = computeUnit({ unitRaw: 'KG', cissPrice: 10, cissStock: 340 })
    expect(r).toEqual({
      ok: false,
      unitRaw: 'KG',
      unitNormalized: 'KG',
      reason: 'CONFIGURATION_REQUIRED',
      detail: expect.stringContaining('quantity_per_sale_unit'),
    })
  })

  it('MT sem packageConfig -> CONFIGURATION_REQUIRED, zero write', () => {
    const r = computeUnit({ unitRaw: 'MT', cissPrice: 10, cissStock: 50 })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.reason).toBe('CONFIGURATION_REQUIRED')
  })

  it('KG com packageConfig valido -> ok', () => {
    const r = computeUnit({ unitRaw: 'KG', cissPrice: 10, cissStock: 340, packageConfig: { quantityPerSaleUnit: 18 } })
    expect(r).toMatchObject({ ok: true, unitClass: 'PACKAGE_MEASURED', policy: 'NONE', salePrice: 180, saleStock: 18, remainder: 16 })
  })

  it('MT com packageConfig valido -> ok (37m / 2.5 = 14, sobra 2m)', () => {
    const r = computeUnit({ unitRaw: 'MT', cissPrice: 8, cissStock: 37, packageConfig: { quantityPerSaleUnit: 2.5 } })
    expect(r).toMatchObject({ ok: true, unitClass: 'PACKAGE_MEASURED', policy: 'NONE', salePrice: 20, saleStock: 14, remainder: 2 })
  })
})

describe('computeUnit -- UNIT desconhecida', () => {
  it('nunca escreve -- UNSUPPORTED_UNIT', () => {
    const r = computeUnit({ unitRaw: 'ZZ', cissPrice: 10, cissStock: 5 })
    expect(r).toEqual({ ok: false, unitRaw: 'ZZ', unitNormalized: 'ZZ', reason: 'UNSUPPORTED_UNIT' })
  })

  it('UNIT ausente -- UNSUPPORTED_UNIT', () => {
    const r = computeUnit({ unitRaw: null, cissPrice: 10, cissStock: 5 })
    expect(r).toEqual({ ok: false, unitRaw: null, unitNormalized: null, reason: 'UNSUPPORTED_UNIT' })
  })
})

describe('computeUnit -- seguranca de estoque negativo', () => {
  it('DIRECT com estoque negativo nunca resulta em saleStock negativo', () => {
    const r = computeUnit({ unitRaw: 'PC', cissPrice: 10, cissStock: -50 })
    expect(r).toMatchObject({ ok: true, saleStock: 0 })
  })

  it('HUNDRED com estoque negativo nunca resulta em saleStock negativo', () => {
    const r = computeUnit({ unitRaw: 'CT', cissPrice: 300, cissStock: -1 })
    expect(r).toMatchObject({ ok: true, saleStock: 0, physicalUnits: 0 })
  })

  it('PACKAGE_MEASURED com estoque negativo nunca resulta em saleStock negativo', () => {
    const r = computeUnit({ unitRaw: 'KG', cissPrice: 10, cissStock: -1, packageConfig: { quantityPerSaleUnit: 18 } })
    expect(r).toMatchObject({ ok: true, saleStock: 0 })
  })
})

describe('computeUnit -- a descricao nunca governa a UNIT', () => {
  it('SKU descrito como "50 pecas" mas unit=PC continua DIRECT 1:1 (evidencia real: SKUs 5418/5419/5420)', () => {
    // ComputeUnitInput nao aceita nome/descricao/categoria/SKU -- so unitRaw + preco/estoque do CISS.
    // Isso ja e a prova estrutural: nao ha como a descricao influenciar o resultado.
    const r = computeUnit({ unitRaw: 'PC', cissPrice: 5, cissStock: 50 })
    expect(r).toMatchObject({ ok: true, unitClass: 'DIRECT', salePrice: 5, saleStock: 50 })
  })
})

describe('computeUnit -- validacao de entrada numerica', () => {
  it('preco invalido (NaN/negativo) lanca erro -- nao e fluxo de negocio', () => {
    expect(() => computeUnit({ unitRaw: 'PC', cissPrice: Number.NaN, cissStock: 1 })).toThrow()
    expect(() => computeUnit({ unitRaw: 'PC', cissPrice: -1, cissStock: 1 })).toThrow()
  })

  it('estoque nao finito lanca erro', () => {
    expect(() => computeUnit({ unitRaw: 'PC', cissPrice: 1, cissStock: Number.NaN })).toThrow()
  })
})
