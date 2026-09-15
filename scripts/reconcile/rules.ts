// Regras de negocio esperadas por UNIT -- adapta a interface historica do
// reconciliador (classifyUnit/computeExpected) ao motor puro compartilhado
// em ./units (mesmo motor usado pelo app, ver §15 do FASE B). Nao duplica
// mais mapa de UNIT nem formula de calculo -- so traduz o resultado do
// motor pro formato que reconcile.ts/run.ts ja esperam.
//
// Fonte de verdade da unidade = campo `unit` do CISS. NUNCA inferir por
// nome. Unidade desconhecida = fail closed, nunca "assume" DIRECT/CENTO.

import { computeUnit, resolveUnit, type CommercialPolicyConfig, type UnitClass, type UnitComputationResult } from '../../src/lib/units'

export { moneyRound, safeFloor } from '../../src/lib/units'

// Espelham src/lib/units/commercial-policy.ts (FIXADOR_CENTO) e
// strategies.ts (HUNDRED) -- so para exibicao no meta do relatorio
// (ver run.ts), nunca usadas no calculo (isso vem de ../../src/lib/units).
export const CENTO_UNITS = 100
export const CENTO_STOCK_PERCENT = 10
export const CENTO_RETAIL_MULTIPLIER = 1.2
export const WHOLESALE_MULTIPLIER = 0.8
export const WHOLESALE_MIN_QTY = 100
/** Tolerancia de comparacao de preco (meio centavo). */
export const PRICE_TOLERANCE = 0.005

export type CanonicalUnit = UnitClass

export type UnitClassification = { kind: 'ok'; unit: CanonicalUnit } | { kind: 'missing' } | { kind: 'unsupported'; raw: string }

export function classifyUnit(raw: string | null | undefined): UnitClassification {
  const r = resolveUnit(raw)
  if (!r.ok) {
    if (r.unitNormalized == null) return { kind: 'missing' }
    return { kind: 'unsupported', raw: r.unitRaw ?? '' }
  }
  return { kind: 'ok', unit: r.unitClass }
}

export interface ExpectedInput {
  unitRaw: string | null | undefined
  cissPrice: number
  cissStock: number
  /** So para PACKAGE_MEASURED (KG/MT). null/undefined = embalagem nao cadastrada. */
  packageWeightKg?: number | null
  /** Ponte read-only (FASE B.1, PROBLEMA 1): settings observados via db-readonly.ts, montados em reconcile-readonly.ts. Ausente = motor puro cai no DEFAULT_COMMERCIAL_POLICY_CONFIG (ver src/lib/units/types.ts). */
  commercialPolicyConfig?: CommercialPolicyConfig
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
      /** Preenchido quando a formula literal de producao (sem safeFloor) daria outro estoque -- so HUNDRED. */
      floatEdgeNote?: string
    }
  | { kind: 'configuration_required'; error: string }
  | { kind: 'invalid_input'; error: string }

export function computeExpected(input: ExpectedInput): ExpectedResult {
  let result: UnitComputationResult
  try {
    result = computeUnit({
      unitRaw: input.unitRaw,
      cissPrice: input.cissPrice,
      cissStock: input.cissStock,
      packageConfig: input.packageWeightKg != null ? { quantityPerSaleUnit: input.packageWeightKg } : null,
      commercialPolicyConfig: input.commercialPolicyConfig,
    })
  } catch (err) {
    // computeUnit lanca so pra corrupcao numerica genuina (NaN/preco negativo) --
    // nao e fluxo de negocio, mas reconcile.ts nunca pode deixar isso derrubar a
    // linha inteira: vira ERROR (ver reconcile.ts).
    return { kind: 'invalid_input', error: err instanceof Error ? err.message : String(err) }
  }

  if (!result.ok) {
    if (result.reason === 'CONFIGURATION_REQUIRED') {
      return { kind: 'configuration_required', error: result.detail ?? 'configuracao obrigatoria ausente' }
    }
    // UNSUPPORTED_UNIT: reconcile.ts ja filtra via classifyUnit antes de chamar
    // computeExpected, entao isso e defensivo (nunca deve ser alcancado na pratica).
    return { kind: 'invalid_input', error: `UNIT nao suportada: ${result.unitNormalized ?? 'ausente'}` }
  }

  // Diagnostico auditavel: compara contra a formula literal de producao do
  // motor antigo (src/lib/inventory/engine.ts, ainda nao substituido -- §13).
  // So se aplica a HUNDRED, unica classe onde a producao fazia essa conta.
  let floatEdgeNote: string | undefined
  if (result.unitClass === 'HUNDRED') {
    const stock = Math.max(input.cissStock, 0)
    const prodFormula = Math.floor(stock * CENTO_UNITS * (CENTO_STOCK_PERCENT / 100))
    if (prodFormula !== result.saleStock) {
      floatEdgeNote = `borda de ponto flutuante: formula literal de producao daria ${prodFormula}`
    }
  }

  return {
    kind: 'ok',
    expectedRetailPrice: result.salePrice,
    expectedWholesalePrice: result.wholesalePrice ?? null,
    expectedStock: result.saleStock,
    priceTableExpected: result.salePrice,
    ...(floatEdgeNote ? { floatEdgeNote } : {}),
  }
}

export function pricesMatch(expected: number | null, actual: number | null): boolean | null {
  if (expected == null || actual == null) return null
  return Math.abs(expected - actual) <= PRICE_TOLERANCE
}
