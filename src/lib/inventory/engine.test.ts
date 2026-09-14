import { describe, expect, it } from 'vitest'
import { calculateUnitStock } from './engine'

describe('calculateUnitStock', () => {
  // CT (HUNDRED) -- CISS devolve estoque em CENTO (100 unidades), nao em
  // unidades fisicas -- caso real relatado pelo usuario em 08/09/2026:
  // produto 1563, CISS devolve "2" (= 2 cento = 200 parafusos fisicos).
  // Converte pra unidades ANTES de expor 10% (STOCK_PERCENT, proposital --
  // ver [[casa-hub-stock-percent-10-proposital]]).
  it('CT: converte cento pra unidades antes de expor 10% (caso real: produto 1563)', () => {
    const result = calculateUnitStock({ unitRaw: 'CT', cissStock: 2 }) // 2 cento = 200 parafusos
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.unitClass).toBe('HUNDRED')
    expect(result.targetWakeStock).toBe(20) // 200 * 10%, NUNCA 0 (2 * 10% floor)
  })

  it('CT: nunca devolve estoque negativo mesmo com entrada negativa', () => {
    const result = calculateUnitStock({ unitRaw: 'CT', cissStock: -50 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.targetWakeStock).toBe(0)
  })

  // PC/UN/etc (DIRECT) -- estoque fisico real, 1:1, SEM aplicar
  // STOCK_PERCENT (diferente de CT: nao ha "colchao" de exposicao parcial
  // pra unidade ja vendida individualmente).
  it('PC: estoque fisico 1:1, sem multiplicar por 100 nem aplicar STOCK_PERCENT', () => {
    const result = calculateUnitStock({ unitRaw: 'PC', cissStock: 7 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.unitClass).toBe('DIRECT')
    expect(result.targetWakeStock).toBe(7)
  })

  // KG/MT (PACKAGE_MEASURED) -- estoque na unidade de origem / quantidade
  // configurada por produto (product_sale_unit_config), floor, sobra so pra
  // auditoria.
  it('KG: com config cadastrada, divide estoque em kg pela quantidade por unidade de venda', () => {
    const result = calculateUnitStock({ unitRaw: 'KG', cissStock: 17, packageConfig: { quantityPerSaleUnit: 5 } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.unitClass).toBe('PACKAGE_MEASURED')
    expect(result.targetWakeStock).toBe(3) // floor(17 / 5)
  })

  it('KG: sem config cadastrada, falha fail-closed com CONFIGURATION_REQUIRED', () => {
    const result = calculateUnitStock({ unitRaw: 'KG', cissStock: 10 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('CONFIGURATION_REQUIRED')
  })

  it('UNIT desconhecida: falha fail-closed com UNSUPPORTED_UNIT, nunca assume DIRECT', () => {
    const result = calculateUnitStock({ unitRaw: 'XYZ', cissStock: 10 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('UNSUPPORTED_UNIT')
  })
})
