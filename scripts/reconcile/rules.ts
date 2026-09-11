// Regras de negocio esperadas por UNIT -- puras, sem I/O.
//
// Fonte de verdade da unidade = campo `unit` do CISS (GET /products/stock).
// NUNCA inferir unidade pelo nome do produto. Unidade desconhecida = fail
// closed (UNSUPPORTED_UNIT), nunca "assumir CENTO".
//
// Constantes canonicas desta rodada (especificacao do Tech Lead, 10/09/2026).
// Os settings de producao (UNIT_PRICE_MARKUP_PERCENT, STOCK_PERCENT,
// WHOLESALE_MIN_QTY) sao lidos so para registro no meta do relatorio e
// sinalizados se divergirem destas constantes -- nao alteram o calculo.

export const CENTO_UNITS = 100
export const CENTO_STOCK_PERCENT = 10
export const CENTO_RETAIL_MULTIPLIER = 1.2
export const WHOLESALE_MULTIPLIER = 0.8
export const WHOLESALE_MIN_QTY = 100
/** Tolerancia de comparacao de preco (meio centavo). */
export const PRICE_TOLERANCE = 0.005

export type CanonicalUnit = 'CENTO' | 'PC' | 'UN' | 'KG'

export type UnitClassification =
  | { kind: 'ok'; unit: CanonicalUnit }
  | { kind: 'missing' }
  | { kind: 'unsupported'; raw: string }

const UNIT_MAP: Record<string, CanonicalUnit> = {
  CENTO: 'CENTO',
  PC: 'PC',
  UN: 'UN',
  KG: 'KG',
}

/** Mesmo arredondamento de src/lib/pricing/engine.ts (JS + EPSILON, meio-para-cima). */
export function moneyRound(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

/**
 * floor tolerante a ruido de ponto flutuante (arredonda para 9 casas antes do
 * floor). Para estoques com ate 3 casas decimais o resultado e identico a
 * formula literal de producao (verificado em rules.test.ts de 0 a 1000); a
 * protecao existe para valores fora desse padrao, que ganham floatEdgeNote.
 */
export function safeFloor(value: number): number {
  return Math.floor(Math.round(value * 1e9) / 1e9)
}

export function classifyUnit(raw: string | null | undefined): UnitClassification {
  if (raw == null) return { kind: 'missing' }
  const normalized = raw.trim().toUpperCase()
  if (normalized === '') return { kind: 'missing' }
  const unit = UNIT_MAP[normalized]
  if (unit) return { kind: 'ok', unit }
  return { kind: 'unsupported', raw }
}

export interface ExpectedInput {
  unit: CanonicalUnit
  cissPrice: number
  cissStock: number
  /** So para KG. null/undefined = embalagem nao cadastrada. */
  packageWeightKg?: number | null
}

export type ExpectedResult =
  | {
      kind: 'ok'
      expectedRetailPrice: number
      /** null = sem preco de atacado esperado para esta unidade. */
      expectedWholesalePrice: number | null
      expectedStock: number
      /** precoPor esperado na tabela de preco (= varejo esperado). */
      priceTableExpected: number
      /** Preenchido quando a formula literal de producao (sem safeFloor) daria outro estoque. */
      floatEdgeNote?: string
    }
  | { kind: 'configuration_required'; error: string }
  | { kind: 'invalid_input'; error: string }

export function computeExpected(input: ExpectedInput): ExpectedResult {
  const { unit, cissPrice, cissStock } = input
  if (!Number.isFinite(cissPrice) || cissPrice < 0) {
    return { kind: 'invalid_input', error: `preco CISS invalido: ${cissPrice}` }
  }
  if (!Number.isFinite(cissStock)) {
    return { kind: 'invalid_input', error: `estoque CISS invalido: ${cissStock}` }
  }
  const stock = Math.max(cissStock, 0)

  switch (unit) {
    case 'CENTO': {
      const base = cissPrice / CENTO_UNITS
      const retail = moneyRound(base * CENTO_RETAIL_MULTIPLIER)
      const wholesale = moneyRound(retail * WHOLESALE_MULTIPLIER)
      const expectedStock = safeFloor(stock * CENTO_UNITS * (CENTO_STOCK_PERCENT / 100))
      // Formula literal do motor de producao (src/lib/inventory/engine.ts).
      const prodFormula = Math.floor(stock * CENTO_UNITS * (CENTO_STOCK_PERCENT / 100))
      return {
        kind: 'ok',
        expectedRetailPrice: retail,
        expectedWholesalePrice: wholesale,
        expectedStock,
        priceTableExpected: retail,
        ...(prodFormula !== expectedStock
          ? { floatEdgeNote: `borda de ponto flutuante: formula literal de producao daria ${prodFormula}` }
          : {}),
      }
    }
    case 'PC':
    case 'UN': {
      // Sem x100, sem /100, sem markup de fixadores.
      const retail = moneyRound(cissPrice)
      return {
        kind: 'ok',
        expectedRetailPrice: retail,
        expectedWholesalePrice: null,
        expectedStock: safeFloor(stock),
        priceTableExpected: retail,
      }
    }
    case 'KG': {
      const w = input.packageWeightKg
      if (w == null) {
        return { kind: 'configuration_required', error: 'UNIT=KG sem kg_por_caixa cadastrado (nao inventar valor)' }
      }
      if (!Number.isFinite(w) || w <= 0) {
        return { kind: 'configuration_required', error: `UNIT=KG com kg_por_caixa invalido: ${w}` }
      }
      const retail = moneyRound(cissPrice * w)
      return {
        kind: 'ok',
        expectedRetailPrice: retail,
        expectedWholesalePrice: null,
        expectedStock: safeFloor(stock / w),
        priceTableExpected: retail,
      }
    }
  }
}

export function pricesMatch(expected: number | null, actual: number | null): boolean | null {
  if (expected == null || actual == null) return null
  return Math.abs(expected - actual) <= PRICE_TOLERANCE
}
