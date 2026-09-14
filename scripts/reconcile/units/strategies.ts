// Strategies por UNIT -- normalizacao pura, sem politica comercial.
// Ver docs/CASA_HUB_FASE_B_UNIT_STRATEGIES.md §6, §7, §9 e docs/INVENTORY_RULES.md.
//
// PROIBIDO: nenhuma strategy aplica markup/desconto/exposicao de estoque.
// Isso e responsabilidade exclusiva de commercial-policy.ts.

import { cleanNumber, moneyRound, safeFloor } from './decimal'

export interface DirectStrategyResult {
  salePrice: number
  saleStock: number
}

/** DIRECT -- PC, UN, JG, PR, CJ, RL, KT, CX, LT, PL. 1:1, sem /100, x100 ou markup. */
export function computeDirect(cissPrice: number, cissStock: number): DirectStrategyResult {
  return {
    salePrice: moneyRound(cissPrice),
    saleStock: safeFloor(Math.max(cissStock, 0)),
  }
}

export interface HundredStrategyResult {
  baseUnitPrice: number
  physicalUnits: number
}

/**
 * HUNDRED -- normalizacao CT. Preco do "cento" -> preco unitario;
 * estoque cru -> unidades fisicas. NAO aplica markup nem exposicao de
 * estoque (isso e FixadorCentoCommercialPolicy, separada).
 */
export function computeHundred(cissPrice: number, cissStock: number): HundredStrategyResult {
  return {
    baseUnitPrice: moneyRound(cissPrice / 100),
    physicalUnits: cleanNumber(Math.max(cissStock, 0) * 100),
  }
}

export interface PackageStrategyResult {
  salePrice: number
  saleStock: number
  /** Sobra na unidade de origem (kg/m) -- so para auditoria, nunca vendavel. */
  remainder: number
}

export type PackageStrategyOutcome = { ok: true; result: PackageStrategyResult } | { ok: false }

/**
 * PACKAGE_MEASURED -- generica para KG e MT. Sem `quantityPerSaleUnit`
 * valido (> 0), falha fail-closed (o chamador mapeia para CONFIGURATION_REQUIRED).
 */
export function computeMeasuredPackage(
  cissPricePerSourceUnit: number,
  cissStock: number,
  quantityPerSaleUnit: number | null | undefined,
): PackageStrategyOutcome {
  if (quantityPerSaleUnit == null || !Number.isFinite(quantityPerSaleUnit) || quantityPerSaleUnit <= 0) {
    return { ok: false }
  }

  const stock = Math.max(cissStock, 0)
  const saleStock = safeFloor(stock / quantityPerSaleUnit)
  const remainder = cleanNumber(stock - saleStock * quantityPerSaleUnit)

  return {
    ok: true,
    result: {
      salePrice: moneyRound(cissPricePerSourceUnit * quantityPerSaleUnit),
      saleStock,
      remainder,
    },
  }
}
