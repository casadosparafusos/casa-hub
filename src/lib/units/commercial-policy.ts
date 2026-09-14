// CommercialPolicy -- separada da normalizacao por UNIT (ver §8). Uma UNIT
// nao implica uma politica automaticamente; a selecao fica centralizada em
// compute.ts.

import { moneyRound, safeFloor } from './decimal'
import { DEFAULT_COMMERCIAL_POLICY_CONFIG, type CommercialPolicyConfig } from './types'

export interface FixadorCentoResult {
  retailUnitPrice: number
  wholesaleUnitPrice: number
  wholesaleMinQty: number
  wakeStock: number
}

/**
 * FIXADOR_CENTO -- unica politica comercial hoje aplicada a produtos
 * HUNDRED (fixadores vendidos por cento). markup sobre o varejo, desconto
 * de atacado sobre o varejo, exposicao de estoque fisico -- todos vindos de
 * `config` (settings de producao), nunca hardcoded. Default =
 * DEFAULT_COMMERCIAL_POLICY_CONFIG quando o chamador nao informa (ex.:
 * testes do modulo puro isolado).
 */
export function applyFixadorCentoPolicy(
  baseUnitPrice: number,
  physicalUnits: number,
  config: CommercialPolicyConfig = DEFAULT_COMMERCIAL_POLICY_CONFIG,
): FixadorCentoResult {
  const retailUnitPrice = moneyRound(baseUnitPrice * (1 + config.markupPercent / 100))
  const wholesaleUnitPrice = moneyRound(retailUnitPrice * (1 - config.wholesaleDiscountPercent / 100))
  const wakeStock = safeFloor(Math.max(physicalUnits, 0) * (config.stockExposurePercent / 100))

  return { retailUnitPrice, wholesaleUnitPrice, wholesaleMinQty: config.wholesaleMinQty, wakeStock }
}

export interface NoPolicyResult {
  salePrice: number
  saleStock: number
}

/** NoCommercialPolicy -- identidade. Default para DIRECT e PACKAGE_MEASURED. */
export function applyNoCommercialPolicy(salePrice: number, saleStock: number): NoPolicyResult {
  return { salePrice, saleStock }
}
