// Orquestrador puro: CISS raw -> UnitResolver -> Strategy -> CommercialPolicy
// -> UnitComputationResult. Unica funcao publica que app e reconciliador
// devem chamar -- ver §13 (uma so fonte de calculo, sem duplicar).

import { applyFixadorCentoPolicy, applyNoCommercialPolicy } from './commercial-policy'
import { resolveUnit } from './resolver'
import { computeDirect, computeHundred, computeMeasuredPackage } from './strategies'
import type { ComputeUnitInput, UnitComputationResult } from './types'

function assertFinite(value: number, label: string, allowNegative: boolean): void {
  if (!Number.isFinite(value) || (!allowNegative && value < 0)) {
    throw new Error(`${label} invalido: ${value}`)
  }
}

export function computeUnit(input: ComputeUnitInput): UnitComputationResult {
  assertFinite(input.cissPrice, 'preco CISS', false)
  assertFinite(input.cissStock, 'estoque CISS', true)

  const resolution = resolveUnit(input.unitRaw)

  if (!resolution.ok) {
    return {
      ok: false,
      unitRaw: resolution.unitRaw,
      unitNormalized: resolution.unitNormalized,
      reason: 'UNSUPPORTED_UNIT',
    }
  }

  switch (resolution.unitClass) {
    case 'DIRECT': {
      const { salePrice, saleStock } = computeDirect(input.cissPrice, input.cissStock)
      const policy = applyNoCommercialPolicy(salePrice, saleStock)
      return {
        ok: true,
        unitRaw: resolution.unitRaw,
        unitNormalized: resolution.unitNormalized,
        unitClass: 'DIRECT',
        policy: 'NONE',
        salePrice: policy.salePrice,
        saleStock: policy.saleStock,
      }
    }

    case 'HUNDRED': {
      const { baseUnitPrice, physicalUnits } = computeHundred(input.cissPrice, input.cissStock)
      // FIXADOR_CENTO e a unica politica comercial usada hoje para HUNDRED
      // (todo o catalogo CT gerenciado). Nao existe campo de politica por
      // produto no banco ainda -- selecao centralizada aqui, de proposito,
      // ate existir modelagem por produto (debt documentado em
      // docs/ARCHITECTURE_TARGET.md). HUNDRED != FIXADOR_CENTO por definicao;
      // isto e so a escolha default desta fase, nao uma regra da UNIT.
      const policy = applyFixadorCentoPolicy(baseUnitPrice, physicalUnits)
      return {
        ok: true,
        unitRaw: resolution.unitRaw,
        unitNormalized: resolution.unitNormalized,
        unitClass: 'HUNDRED',
        policy: 'FIXADOR_CENTO',
        salePrice: policy.retailUnitPrice,
        saleStock: policy.wakeStock,
        wholesalePrice: policy.wholesaleUnitPrice,
        wholesaleMinQty: policy.wholesaleMinQty,
        physicalUnits,
      }
    }

    case 'PACKAGE_MEASURED': {
      const outcome = computeMeasuredPackage(input.cissPrice, input.cissStock, input.packageConfig?.quantityPerSaleUnit)
      if (!outcome.ok) {
        return {
          ok: false,
          unitRaw: resolution.unitRaw,
          unitNormalized: resolution.unitNormalized,
          reason: 'CONFIGURATION_REQUIRED',
          detail: `UNIT=${resolution.unitNormalized} sem quantity_per_sale_unit valido cadastrado`,
        }
      }
      const policy = applyNoCommercialPolicy(outcome.result.salePrice, outcome.result.saleStock)
      return {
        ok: true,
        unitRaw: resolution.unitRaw,
        unitNormalized: resolution.unitNormalized,
        unitClass: 'PACKAGE_MEASURED',
        policy: 'NONE',
        salePrice: policy.salePrice,
        saleStock: policy.saleStock,
        remainder: outcome.result.remainder,
      }
    }
  }
}
