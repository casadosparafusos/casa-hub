// Tipos do motor puro de UNIT. Zero imports de Wake client, CISS client, DB,
// settings, sync, filesystem ou env -- ver docs/CASA_HUB_FASE_B_UNIT_STRATEGIES.md §4.

export type UnitClass = 'HUNDRED' | 'DIRECT' | 'PACKAGE_MEASURED'

export type PackageSourceUnit = 'KG' | 'MT'

export type CommercialPolicyKind = 'NONE' | 'FIXADOR_CENTO'

export type UnitResolutionFailure = 'UNSUPPORTED_UNIT' | 'CONFIGURATION_REQUIRED'

export interface PackageSaleUnitConfig {
  quantityPerSaleUnit: number
}

export interface ComputeUnitInput {
  /** Campo `unit` cru do CISS -- nunca inferir por nome/descricao/categoria/SKU. */
  unitRaw: string | null | undefined
  cissPrice: number
  cissStock: number
  /** Obrigatorio para PACKAGE_MEASURED (KG/MT); ignorado nas outras classes. */
  packageConfig?: PackageSaleUnitConfig | null
}

export type UnitComputationResult =
  | {
      ok: true
      unitRaw: string
      unitNormalized: string
      unitClass: UnitClass
      policy: CommercialPolicyKind
      /** Preco final de venda no Wake (varejo, ja com a politica comercial aplicada). */
      salePrice: number
      /** Estoque final no Wake (inteiro, floor). */
      saleStock: number
      /** Preenchido so quando a politica comercial define atacado (FIXADOR_CENTO). */
      wholesalePrice?: number
      wholesaleMinQty?: number
      /** Preenchido so para HUNDRED: unidades fisicas antes da exposicao de estoque. */
      physicalUnits?: number
      /** Preenchido so para PACKAGE_MEASURED: sobra na unidade de origem (kg/m), so para auditoria. */
      remainder?: number
    }
  | {
      ok: false
      unitRaw: string | null
      unitNormalized: string | null
      reason: UnitResolutionFailure
      detail?: string
    }
