// Motor de preco -- puro, sem I/O, testavel isoladamente. Delega TODO o
// calculo pro motor de UNIT compartilhado (src/lib/units, single-sourced em
// scripts/reconcile/units) -- ver docs/CASA_HUB_FASE_B_UNIT_STRATEGIES.md
// §13 ("UMA fonte pura de calculo", nao duplicar a regra aqui).
//
// SUBSTITUI a versao anterior (calculatePricing), que assumia TODO produto
// como CENTO (preco bruto do CISS / 100 * markup). Essa suposicao foi
// removida por definicao da FASE B: a UNIT real vem do campo `unit` do CISS
// (unitRaw), nunca inferida.
//
// wholesalePrice/wholesaleMinQty (preenchidos so pra HUNDRED, politica
// FIXADOR_CENTO) sao campos de AUDITORIA nesta fase -- a Tabela de Preco no
// Wake continua sendo alimentada pelo `retailPrice` (mesmo que o
// reconciliador READ-ONLY ja faz: ver scripts/reconcile/rules.ts,
// priceTableExpected = result.salePrice, NUNCA wholesalePrice). Nenhum
// caminho de escrita real (src/lib/sync/engine.ts) consome wholesalePrice
// hoje.
import { computeUnit, type CommercialPolicyConfig, type CommercialPolicyKind, type PackageSaleUnitConfig, type UnitClass, type UnitResolutionFailure } from '@/lib/units'

export interface UnitPriceInput {
  /** Campo `unit` cru do CISS -- nunca inferir por nome/descricao/SKU. */
  unitRaw: string | null | undefined
  /** Preco bruto retornado pelo CISS pra este produto (na UNIT de origem, ex: preco do cento pra CT). */
  cissPrice: number
  /** Obrigatorio para PACKAGE_MEASURED (KG/MT); ignorado nas outras classes. */
  packageConfig?: PackageSaleUnitConfig | null
  /** Parametros de FIXADOR_CENTO vindos de settings (src/lib/settings.ts#getCommercialPolicyConfig); default = DEFAULT_COMMERCIAL_POLICY_CONFIG quando ausente (ver src/lib/units/types.ts). */
  commercialPolicyConfig?: CommercialPolicyConfig
  /** Forca a policy independente da UnitClass -- ver FASE B.1 PROBLEMA 2 (CT + NoCommercialPolicy). */
  commercialPolicyOverride?: CommercialPolicyKind
}

export type UnitPriceResult =
  | {
      ok: true
      unitRaw: string
      unitNormalized: string
      unitClass: UnitClass
      /** Preco final de varejo no Wake -- unico valor usado nos caminhos de escrita (endpoint base e Tabela de Preco). */
      retailPrice: number
      /** So auditoria nesta fase -- ver comentario acima. null quando a UNIT/politica nao define atacado. */
      wholesalePrice: number | null
      wholesaleMinQty: number | null
    }
  | {
      ok: false
      unitRaw: string | null
      unitNormalized: string | null
      reason: UnitResolutionFailure
      detail?: string
    }

export function calculateUnitPrice(input: UnitPriceInput): UnitPriceResult {
  const result = computeUnit({
    unitRaw: input.unitRaw,
    cissPrice: input.cissPrice,
    cissStock: 0, // preco e estoque sao matematicamente independentes no motor de UNIT -- placeholder inofensivo.
    packageConfig: input.packageConfig ?? null,
    commercialPolicyConfig: input.commercialPolicyConfig,
    commercialPolicyOverride: input.commercialPolicyOverride,
  })

  if (!result.ok) {
    return { ok: false, unitRaw: result.unitRaw, unitNormalized: result.unitNormalized, reason: result.reason, detail: result.detail }
  }

  return {
    ok: true,
    unitRaw: result.unitRaw,
    unitNormalized: result.unitNormalized,
    unitClass: result.unitClass,
    retailPrice: result.salePrice,
    wholesalePrice: result.wholesalePrice ?? null,
    wholesaleMinQty: result.wholesaleMinQty ?? null,
  }
}
