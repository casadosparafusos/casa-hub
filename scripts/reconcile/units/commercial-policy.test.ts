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
