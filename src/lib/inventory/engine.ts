// Motor de estoque -- puro, sem I/O, testavel isoladamente. Delega TODO o
// calculo pro motor de UNIT compartilhado (src/lib/units, single-sourced em
// scripts/reconcile/units) -- ver docs/CASA_HUB_FASE_B_UNIT_STRATEGIES.md
// §13 ("UMA fonte pura de calculo", nao duplicar a regra aqui).
//
// SUBSTITUI a versao anterior (calculateInventory), que multiplicava TODO
// estoque por UNITS_PER_CENTO (100) incondicionalmente, assumindo CENTO pra
// qualquer produto. Essa suposicao foi removida por definicao da FASE B: a
// UNIT real vem do campo `unit` do CISS (unitRaw), nunca inferida -- PC/UN/
// etc (DIRECT) NAO passam pela multiplicacao por 100.
import { computeUnit, type PackageSaleUnitConfig, type UnitClass, type UnitResolutionFailure } from '@/lib/units'

export interface UnitStockInput {
  /** Campo `unit` cru do CISS -- nunca inferir por nome/descricao/SKU. */
  unitRaw: string | null | undefined
  /** Estoque bruto retornado pelo CISS pra este produto (na UNIT de origem, ex: cento pra CT). */
  cissStock: number
  /** Obrigatorio para PACKAGE_MEASURED (KG/MT); ignorado nas outras classes. */
  packageConfig?: PackageSaleUnitConfig | null
}

export type UnitStockResult =
  | {
      ok: true
      unitRaw: string
      unitNormalized: string
      unitClass: UnitClass
      /** Estoque final no Wake (inteiro, floor). */
      targetWakeStock: number
    }
  | {
      ok: false
      unitRaw: string | null
      unitNormalized: string | null
      reason: UnitResolutionFailure
      detail?: string
    }

export function calculateUnitStock(input: UnitStockInput): UnitStockResult {
  const result = computeUnit({
    unitRaw: input.unitRaw,
    cissPrice: 0, // preco e estoque sao matematicamente independentes no motor de UNIT -- placeholder inofensivo.
    cissStock: input.cissStock,
    packageConfig: input.packageConfig ?? null,
  })

  if (!result.ok) {
    return { ok: false, unitRaw: result.unitRaw, unitNormalized: result.unitNormalized, reason: result.reason, detail: result.detail }
  }

  return {
    ok: true,
    unitRaw: result.unitRaw,
    unitNormalized: result.unitNormalized,
    unitClass: result.unitClass,
    targetWakeStock: result.saleStock,
  }
}
