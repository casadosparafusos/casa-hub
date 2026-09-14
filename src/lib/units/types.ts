// Tipos do motor puro de UNIT. Zero imports de Wake client, CISS client, DB,
// settings, sync, filesystem ou env -- ver docs/CASA_HUB_FASE_B_UNIT_STRATEGIES.md §4.

export type UnitClass = 'HUNDRED' | 'DIRECT' | 'PACKAGE_MEASURED'

export type PackageSourceUnit = 'KG' | 'MT'

export type CommercialPolicyKind = 'NONE' | 'FIXADOR_CENTO'

export type UnitResolutionFailure = 'UNSUPPORTED_UNIT' | 'CONFIGURATION_REQUIRED'

export interface PackageSaleUnitConfig {
  quantityPerSaleUnit: number
}

/**
 * Parametros configuraveis da FIXADOR_CENTO policy. O modulo puro NAO le
 * settings (ver docs/CASA_HUB_FASE_B_UNIT_STRATEGIES.md §4) -- este tipo
 * existe para a camada de aplicacao (src/lib/settings.ts) e o reconciliador
 * (leitura read-only da tabela settings) injetarem o MESMO config aqui,
 * em vez de cada um reimplementar a conta com literais proprios.
 */
export interface CommercialPolicyConfig {
  /** % de markup sobre o preco base para chegar no varejo (producao: 20). */
  markupPercent: number
  /** % de desconto do atacado sobre o varejo (producao: 20). */
  wholesaleDiscountPercent: number
  /** % do estoque fisico exposto como estoque de venda (producao: 10). */
  stockExposurePercent: number
  /** Quantidade minima de compra para valer o preco de atacado (producao: 100). */
  wholesaleMinQty: number
}

/** Defaults de producao -- usados quando o chamador nao informa commercialPolicyConfig (ex.: testes do modulo puro isolado). */
export const DEFAULT_COMMERCIAL_POLICY_CONFIG: CommercialPolicyConfig = {
  markupPercent: 20,
  wholesaleDiscountPercent: 20,
  stockExposurePercent: 10,
  wholesaleMinQty: 100,
}

export interface ComputeUnitInput {
  /** Campo `unit` cru do CISS -- nunca inferir por nome/descricao/categoria/SKU. */
  unitRaw: string | null | undefined
  cissPrice: number
  cissStock: number
  /** Obrigatorio para PACKAGE_MEASURED (KG/MT); ignorado nas outras classes. */
  packageConfig?: PackageSaleUnitConfig | null
  /** Parametros da FIXADOR_CENTO policy; default = DEFAULT_COMMERCIAL_POLICY_CONFIG quando ausente. */
  commercialPolicyConfig?: CommercialPolicyConfig
  /**
   * Forca a CommercialPolicy independente da UnitClass resolvida. Existe para
   * tornar CT + NoCommercialPolicy representavel (hoje nao ha campo de policy
   * por managed product no banco -- ver resolveCommercialPolicy em ./policy-resolver).
   */
  commercialPolicyOverride?: CommercialPolicyKind
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
