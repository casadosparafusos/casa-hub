import { describe, expect, it } from 'vitest'
import { applyFixadorCentoPolicy, applyNoCommercialPolicy } from './commercial-policy'
import { computeHundred } from './strategies'

describe('FixadorCentoCommercialPolicy', () => {
  it('CISS P100=300 -> base=3.00, retail=3.60, wholesale=2.88', () => {
    const { baseUnitPrice, physicalUnits } = computeHundred(300, 2.3)
    const policy = applyFixadorCentoPolicy(baseUnitPrice, physicalUnits)
    expect(policy.retailUnitPrice).toBe(3.6)
    expect(policy.wholesaleUnitPrice).toBe(2.88)
    expect(policy.wholesaleMinQty).toBe(100)
  })

  it.each([
    { physicalUnits: 1, expected: 0 },
    { physicalUnits: 99, expected: 9 },
    { physicalUnits: 100, expected: 10 },
    { physicalUnits: 101, expected: 10 },
  ])('fronteira de exposicao de estoque: physical_units=$physicalUnits -> wake_stock=$expected', ({ physicalUnits, expected }) => {
    const policy = applyFixadorCentoPolicy(3, physicalUnits)
    expect(policy.wakeStock).toBe(expected)
  })

  it('estoque fisico negativo -> 0 (nunca vende o que nao existe)', () => {
    const policy = applyFixadorCentoPolicy(3, -10)
    expect(policy.wakeStock).toBe(0)
  })
})

describe('NoCommercialPolicy', () => {
  it('e identidade -- DIRECT e PACKAGE_MEASURED nao sofrem ajuste', () => {
    const r = applyNoCommercialPolicy(2.07, 1894)
    expect(r).toEqual({ salePrice: 2.07, saleStock: 1894 })
  })
})

describe('FixadorCentoCommercialPolicy -- config parametrizavel (PROBLEMA 1)', () => {
  it('markup 20% (default) vs 30% muda o preco de varejo', () => {
    const p20 = applyFixadorCentoPolicy(3, 230, { markupPercent: 20, wholesaleDiscountPercent: 20, stockExposurePercent: 10, wholesaleMinQty: 100 })
    const p30 = applyFixadorCentoPolicy(3, 230, { markupPercent: 30, wholesaleDiscountPercent: 20, stockExposurePercent: 10, wholesaleMinQty: 100 })
    expect(p20.retailUnitPrice).toBe(3.6)
    expect(p30.retailUnitPrice).toBe(3.9)
    expect(p20.retailUnitPrice).not.toBe(p30.retailUnitPrice)
  })

  it('exposicao de estoque 10% (default) vs 15% muda o estoque publicado', () => {
    const e10 = applyFixadorCentoPolicy(3, 230, { markupPercent: 20, wholesaleDiscountPercent: 20, stockExposurePercent: 10, wholesaleMinQty: 100 })
    const e15 = applyFixadorCentoPolicy(3, 230, { markupPercent: 20, wholesaleDiscountPercent: 20, stockExposurePercent: 15, wholesaleMinQty: 100 })
    expect(e10.wakeStock).toBe(23)
    expect(e15.wakeStock).toBe(34)
    expect(e10.wakeStock).not.toBe(e15.wakeStock)
  })

  it('desconto de atacado 20% (default) vs 30% muda o preco de atacado', () => {
    const d20 = applyFixadorCentoPolicy(3, 230, { markupPercent: 20, wholesaleDiscountPercent: 20, stockExposurePercent: 10, wholesaleMinQty: 100 })
    const d30 = applyFixadorCentoPolicy(3, 230, { markupPercent: 20, wholesaleDiscountPercent: 30, stockExposurePercent: 10, wholesaleMinQty: 100 })
    expect(d20.wholesaleUnitPrice).toBe(2.88)
    expect(d30.wholesaleUnitPrice).toBe(2.52)
  })

  it('wholesaleMinQty configurado e repassado sem alteracao', () => {
    const p = applyFixadorCentoPolicy(3, 230, { markupPercent: 20, wholesaleDiscountPercent: 20, stockExposurePercent: 10, wholesaleMinQty: 50 })
    expect(p.wholesaleMinQty).toBe(50)
  })

  it('sem config explicito -- usa DEFAULT_COMMERCIAL_POLICY_CONFIG (20/20/10/100, compatibilidade com FASE B)', () => {
    const r = applyFixadorCentoPolicy(3, 230)
    expect(r).toEqual({ retailUnitPrice: 3.6, wholesaleUnitPrice: 2.88, wholesaleMinQty: 100, wakeStock: 23 })
  })
})
