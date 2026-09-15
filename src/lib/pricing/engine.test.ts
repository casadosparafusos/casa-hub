import { describe, expect, it } from 'vitest'
import { calculateUnitPrice } from './engine'

describe('calculateUnitPrice', () => {
  // CT (HUNDRED) -- preco bruto do CISS e o preco DO CENTO (100 unidades),
  // nao o preco unitario -- confirmado pelo usuario em 08/09/2026 com um
  // caso real (BELENUS 1563: preco de cento no CISS 290.83 -> preco
  // unitario ja com markup no site R$3,49). Politica FIXADOR_CENTO: /100,
  // +20% varejo, -20% sobre o varejo pro atacado (auditoria, nao escrito).
  it('CT: divide por 100 (preco de cento -> unitario) e aplica markup de 20%', () => {
    const result = calculateUnitPrice({ unitRaw: 'CT', cissPrice: 300 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.unitClass).toBe('HUNDRED')
    expect(result.retailPrice).toBe(3.6) // (300 / 100) * 1.2
    expect(result.wholesalePrice).toBe(2.88) // 3.6 * 0.8 -- auditoria, nao escrito no Wake
    expect(result.wholesaleMinQty).toBe(100)
  })

  // PC/UN/etc (DIRECT) -- 1:1, sem divisao por 100 nem markup.
  it('PC: preco 1:1, sem markup nem divisao por cento', () => {
    const result = calculateUnitPrice({ unitRaw: 'PC', cissPrice: 12.5 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.unitClass).toBe('DIRECT')
    expect(result.retailPrice).toBe(12.5)
    expect(result.wholesalePrice).toBeNull()
  })

  // KG/MT (PACKAGE_MEASURED) -- preco por unidade de origem * quantidade
  // configurada por produto (product_sale_unit_config).
  it('KG: com config cadastrada, multiplica preco por kg pela quantidade por unidade de venda', () => {
    const result = calculateUnitPrice({ unitRaw: 'KG', cissPrice: 10, packageConfig: { quantityPerSaleUnit: 5 } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.unitClass).toBe('PACKAGE_MEASURED')
    expect(result.retailPrice).toBe(50) // 10/kg * 5kg
    expect(result.wholesalePrice).toBeNull()
  })

  it('KG: sem config cadastrada, falha fail-closed com CONFIGURATION_REQUIRED', () => {
    const result = calculateUnitPrice({ unitRaw: 'KG', cissPrice: 10 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('CONFIGURATION_REQUIRED')
  })

  it('UNIT desconhecida: falha fail-closed com UNSUPPORTED_UNIT, nunca assume DIRECT', () => {
    const result = calculateUnitPrice({ unitRaw: 'XYZ', cissPrice: 10 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('UNSUPPORTED_UNIT')
  })

  it('UNIT ausente: falha fail-closed com UNSUPPORTED_UNIT', () => {
    const result = calculateUnitPrice({ unitRaw: null, cissPrice: 10 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('UNSUPPORTED_UNIT')
  })

  it('rejeita preco negativo (corrupcao numerica genuina, nao fluxo de negocio)', () => {
    expect(() => calculateUnitPrice({ unitRaw: 'PC', cissPrice: -1 })).toThrow()
  })

  it('rejeita preco nao finito', () => {
    expect(() => calculateUnitPrice({ unitRaw: 'PC', cissPrice: Number.NaN })).toThrow()
  })

  // FASE B.1 (PROBLEMA 1): prova que commercialPolicyConfig (settings via
  // src/lib/settings.ts#getCommercialPolicyConfig, injetado por
  // src/lib/sync/engine.ts) realmente afeta o resultado -- nao fica so
  // aceito na assinatura e ignorado no calculo.
  it('CT: markup de settings (30%) muda o retailPrice em vez do default (20%)', () => {
    const withDefault = calculateUnitPrice({ unitRaw: 'CT', cissPrice: 300 })
    const withCustomMarkup = calculateUnitPrice({
      unitRaw: 'CT',
      cissPrice: 300,
      commercialPolicyConfig: { markupPercent: 30, wholesaleDiscountPercent: 20, stockExposurePercent: 10, wholesaleMinQty: 100 },
    })
    expect(withDefault.ok).toBe(true)
    expect(withCustomMarkup.ok).toBe(true)
    if (!withDefault.ok || !withCustomMarkup.ok) return
    expect(withDefault.retailPrice).toBe(3.6) // (300/100) * 1.2
    expect(withCustomMarkup.retailPrice).toBe(3.9) // (300/100) * 1.3
    expect(withCustomMarkup.retailPrice).not.toBe(withDefault.retailPrice)
  })

  it('CT: desconto de atacado de settings (30%) muda o wholesalePrice em vez do default (20%)', () => {
    const withCustomDiscount = calculateUnitPrice({
      unitRaw: 'CT',
      cissPrice: 300,
      commercialPolicyConfig: { markupPercent: 20, wholesaleDiscountPercent: 30, stockExposurePercent: 10, wholesaleMinQty: 100 },
    })
    expect(withCustomDiscount.ok).toBe(true)
    if (!withCustomDiscount.ok) return
    expect(withCustomDiscount.retailPrice).toBe(3.6) // markup inalterado
    expect(withCustomDiscount.wholesalePrice).toBe(2.52) // 3.6 * 0.7, nao 3.6 * 0.8
  })

  it('DIRECT: commercialPolicyConfig customizado nao afeta preco (politica so se aplica a HUNDRED)', () => {
    const result = calculateUnitPrice({
      unitRaw: 'PC',
      cissPrice: 12.5,
      commercialPolicyConfig: { markupPercent: 99, wholesaleDiscountPercent: 99, stockExposurePercent: 99, wholesaleMinQty: 1 },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.retailPrice).toBe(12.5)
    expect(result.wholesalePrice).toBeNull()
  })
})
