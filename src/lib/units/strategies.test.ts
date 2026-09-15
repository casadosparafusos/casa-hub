import { describe, expect, it } from 'vitest'
import { computeDirect, computeHundred, computeMeasuredPackage } from './strategies'

describe('DirectUnitStrategy', () => {
  it.each(['PC', 'UN', 'JG', 'PR', 'CJ', 'RL', 'KT', 'CX', 'LT', 'PL'])(
    '%s: 1:1, sem /100, x100, exposicao ou markup de fixador',
    () => {
      const r = computeDirect(2.07, 1894)
      expect(r).toEqual({ salePrice: 2.07, saleStock: 1894 })
    },
  )

  it('nao aplica +20%/-20% nem qualquer fator de atacado', () => {
    const r = computeDirect(100, 50)
    expect(r.salePrice).toBe(100)
    expect(r.saleStock).toBe(50)
  })

  it('estoque negativo -> 0 (nunca negativo)', () => {
    const r = computeDirect(10, -5)
    expect(r.saleStock).toBe(0)
  })

  it('estoque fracionario -> floor', () => {
    const r = computeDirect(10, 5.9)
    expect(r.saleStock).toBe(5)
  })
})

describe('HundredUnitStrategy (normalizacao pura, sem politica comercial)', () => {
  it('price=300, stock=2.3 -> base_unit_price=3.00, physical_units=230 (nao 3.60 nem estoque 23)', () => {
    const r = computeHundred(300, 2.3)
    expect(r.baseUnitPrice).toBe(3)
    expect(r.physicalUnits).toBe(230)
  })

  it('nao aplica markup nem exposicao de estoque dentro da strategy', () => {
    const r = computeHundred(300, 2.3)
    expect(r.baseUnitPrice).not.toBe(3.6)
    expect(r.physicalUnits).not.toBe(23)
  })

  it('estoque negativo -> 0 unidades fisicas', () => {
    const r = computeHundred(300, -1)
    expect(r.physicalUnits).toBe(0)
  })
})

describe('MeasuredPackageUnitStrategy (KG/MT)', () => {
  it('340kg / 18kg -> 18 unidades de venda, sobra 16kg', () => {
    const outcome = computeMeasuredPackage(10, 340, 18)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.result.saleStock).toBe(18)
    expect(outcome.result.remainder).toBe(16)
    expect(outcome.result.salePrice).toBe(180)
  })

  it('sem quantity_per_sale_unit -> falha (CONFIGURATION_REQUIRED no compute.ts)', () => {
    expect(computeMeasuredPackage(10, 340, null).ok).toBe(false)
    expect(computeMeasuredPackage(10, 340, undefined).ok).toBe(false)
  })

  it('quantity_per_sale_unit <= 0 -> falha', () => {
    expect(computeMeasuredPackage(10, 340, 0).ok).toBe(false)
    expect(computeMeasuredPackage(10, 340, -1).ok).toBe(false)
  })

  it('estoque negativo -> 0, sem sobra negativa', () => {
    const outcome = computeMeasuredPackage(10, -5, 18)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.result.saleStock).toBe(0)
    expect(outcome.result.remainder).toBe(0)
  })

  it('fronteira de precisao (FASE B.1, PROBLEMA 6): KG com quantity_per_sale_unit=2.5 nao sofre ruido de float no preco nem no floor do estoque', () => {
    // preco/kg=4.20 x 2.5kg/venda = 10.5 cru -- sem cleanNumber no preco
    // (moneyRound ja limpa via Number.EPSILON), mas o ponto sensivel aqui e
    // o floor: 12.5kg / 2.5 = 5 EXATO em decimal, porem 12.5/2.5 em IEEE-754
    // pode carregar ruido dependendo da ordem das operacoes -- safeFloor
    // garante que isso nunca vira 4 por baixo.
    const outcome = computeMeasuredPackage(4.2, 12.5, 2.5)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.result.saleStock).toBe(5)
    expect(outcome.result.salePrice).toBe(10.5)
    expect(outcome.result.remainder).toBe(0)
  })

  it('fronteira de precisao (FASE B.1, PROBLEMA 6): MT com quantity_per_sale_unit=0.3 nao sofre ruido de float (0.3*3=0.8999999999999999 em JS cru)', () => {
    expect(0.3 * 3).not.toBe(0.9)
    // 0.9m de estoque / 0.3m por venda deveria dar exatamente 3 unidades
    // vendaveis, sem sobra -- se o ruido de 0.3*3 vazasse pro calculo, o
    // floor poderia cair pra 2 por engano.
    const outcome = computeMeasuredPackage(15, 0.9, 0.3)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.result.saleStock).toBe(3)
    expect(outcome.result.remainder).toBe(0)
    expect(outcome.result.salePrice).toBe(4.5)
  })
})
