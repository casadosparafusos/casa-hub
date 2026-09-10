import { describe, expect, it } from 'vitest'
import { calculatePricing, moneyRound } from './engine'

describe('moneyRound', () => {
  it('arredonda pra 2 casas decimais', () => {
    expect(moneyRound(10.005)).toBe(10.01) // meio-para-cima, evita erro de ponto flutuante
    expect(moneyRound(9.999)).toBe(10)
    expect(moneyRound(5)).toBe(5)
  })
})

describe('calculatePricing', () => {
  const rules = { unitPriceMarkupPercent: 20, wholesaleMinQty: 100 }

  // O preco bruto do CISS/PODER e o preco DO CENTO (100 unidades), nao o
  // preco unitario -- confirmado pelo usuario em 08/09/2026 com um caso real
  // (BELENUS 1563: preco de cento no CISS 290.83 -> preco unitario ja com
  // markup no site R$3,49). Por isso o motor divide por 100 antes do markup.
  it('divide por 100 (preco de cento -> unitario) e aplica markup de 20%', () => {
    const result = calculatePricing(300, rules)
    expect(result.wakeUnitPrice).toBe(3.6) // (300 / 100) * 1.2
  })

  it('preco de cento e igual ao preco bruto do ERP, sem markup', () => {
    const result = calculatePricing(300, rules)
    expect(result.wakeSpecialPrice).toBe(300)
  })

  it('preserva o preco de origem sem alteracao, pra auditoria', () => {
    const result = calculatePricing(7.5, rules)
    expect(result.sourceRetailPrice).toBe(7.5)
  })

  it('rejeita preco negativo', () => {
    expect(() => calculatePricing(-1, rules)).toThrow()
  })

  it('rejeita preco nao finito', () => {
    expect(() => calculatePricing(Number.NaN, rules)).toThrow()
  })
})
