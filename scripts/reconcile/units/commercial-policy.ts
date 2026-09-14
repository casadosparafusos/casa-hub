// CommercialPolicy -- separada da normalizacao por UNIT (ver §8). Uma UNIT
// nao implica uma politica automaticamente; a selecao fica centralizada em
// compute.ts.

import { moneyRound, safeFloor } from './decimal'

export interface FixadorCentoResult {
  retailUnitPrice: number
  wholesaleUnitPrice: number
  wholesaleMinQty: number
  wakeStock: number
}

/**
 * FIXADOR_CENTO -- unica politica comercial hoje aplicada a produtos
 * HUNDRED (fixadores vendidos por cento). +20% varejo, -20% atacado sobre
 * o varejo, exposicao de 10% do estoque fisico.
 */
export function applyFixadorCentoPolicy(baseUnitPrice: number, physicalUnits: number): FixadorCentoResult {
  const retailUnitPrice = moneyRound(baseUnitPrice * 1.2)
  const wholesaleUnitPrice = moneyRound(retailUnitPrice * 0.8)
  const wakeStock = safeFloor(Math.max(physicalUnits, 0) * 0.1)

  return { retailUnitPrice, wholesaleUnitPrice, wholesaleMinQty: 100, wakeStock }
}

export interface NoPolicyResult {
  salePrice: number
  saleStock: number
}

/** NoCommercialPolicy -- identidade. Default para DIRECT e PACKAGE_MEASURED. */
export function applyNoCommercialPolicy(salePrice: number, saleStock: number): NoPolicyResult {
  return { salePrice, saleStock }
}
