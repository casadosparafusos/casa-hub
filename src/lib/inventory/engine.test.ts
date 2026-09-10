import { describe, expect, it } from 'vitest'
import { calculateInventory } from './engine'

describe('calculateInventory', () => {
  const rules = { stockPercent: 10 }

  // O CISS devolve estoque em CENTO (100 unidades), nao em unidades fisicas
  // -- caso real relatado pelo usuario em 08/09/2026: produto 1563, CISS
  // devolve "2" (= 2 cento = 200 parafusos fisicos). Converte pra unidades
  // ANTES de aplicar o STOCK_PERCENT, senao sai 100x menor que o correto.
  it('converte cento pra unidades antes de aplicar o percentual (caso real: produto 1563)', () => {
    const result = calculateInventory(2, rules) // 2 cento = 200 parafusos
    expect(result.sourceErpStockUnits).toBe(200)
    expect(result.targetWakeStock).toBe(20) // 200 * 10%, NUNCA 0 (2 * 10% floor)
  })

  it('aplica o percentual sobre as unidades convertidas e arredonda pra baixo (floor)', () => {
    expect(calculateInventory(99, rules).targetWakeStock).toBe(990) // 99 cento = 9900un * 10%
    expect(calculateInventory(1, rules).targetWakeStock).toBe(10) // 1 cento = 100un * 10%
  })

  it('nunca devolve estoque negativo mesmo com entrada negativa', () => {
    expect(calculateInventory(-50, rules).targetWakeStock).toBe(0)
  })

  it('rejeita percentual nao finito', () => {
    expect(() => calculateInventory(100, { stockPercent: Number.NaN })).toThrow()
  })
})
