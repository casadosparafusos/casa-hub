// Orquestrador puro: CISS raw -> UnitResolver -> Strategy -> CommercialPolicy
// -> UnitComputationResult. Unica funcao publica que app e reconciliador
// devem chamar -- ver §13 (uma so fonte de calculo, sem duplicar).

import { applyFixadorCentoPolicy, applyNoCommercialPolicy } from './commercial-policy'
import { resolveCommercialPolicy } from './policy-resolver'
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
      // Selecao de policy centralizada em resolveCommercialPolicy (§3): HUNDRED
      // normalization != FIXADOR_CENTO policy por definicao. O default abaixo
      // (HUNDRED -> FIXADOR_CENTO) e so a escolha desta fase -- documentado em
      // docs/ARCHITECTURE_TARGET.md -- porque nao existe campo de policy por
      // managed product no banco ainda. commercialPolicyOverride torna
      // CT + NoCommercialPolicy representavel hoje (teste e futuro uso real).
      const policy = resolveCommercialPolicy('HUNDRED', input.commercialPolicyOverride)
      if (policy === 'NONE') {
        const noPolicy = applyNoCommercialPolicy(baseUnitPrice, physicalUnits)
        return {
          ok: true,
          unitRaw: resolution.unitRaw,
          unitNormalized: resolution.unitNormalized,
          unitClass: 'HUNDRED',
          policy: 'NONE',
          salePrice: noPolicy.salePrice,
          saleStock: noPolicy.saleStock,
          physicalUnits,
        }
      }
      const fixador = applyFixadorCentoPolicy(baseUnitPrice, physicalUnits, input.commercialPolicyConfig)
      return {
        ok: true,
        unitRaw: resolution.unitRaw,
        unitNormalized: resolution.unitNormalized,
        unitClass: 'HUNDRED',
        policy: 'FIXADOR_CENTO',
        salePrice: fixador.retailUnitPrice,
        saleStock: fixador.wakeStock,
        wholesalePrice: fixador.wholesaleUnitPrice,
        wholesaleMinQty: fixador.wholesaleMinQty,
        physicalUnits,
      }
    }

    case 'PACKAGE_MEASURED': {
      if (input.packageConfig && input.packageConfig.sourceUnit !== resolution.sourceUnit) {
        return {
          ok: false,
          unitRaw: resolution.unitRaw,
          unitNormalized: resolution.unitNormalized,
          reason: 'CONFIGURATION_REQUIRED',
          detail: `Configuracao cadastrada para UNIT ${input.packageConfig.sourceUnit} incompativel com UNIT atual do CISS ${resolution.sourceUnit}`,
        }
      }
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
