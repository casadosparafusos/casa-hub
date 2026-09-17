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
// expectedWholesalePrice/wholesaleMinQty (preenchidos so pra HUNDRED,
// politica FIXADOR_CENTO) sao campos de AUDITORIA nesta fase -- valor
// ESPERADO/calculado pelo dominio, nunca efetivamente publicado em nenhum
// endpoint da Wake (nem preco base, nem Tabela de Preco -- FASE B.4 §5). A
// Wake possui mecanismos proprios de atacarejo/wholesale (listaAtacado,
// Storefront prices.wholesalePrices) que permanecem fora deste write path;
// ver docs/ARCHITECTURE_TARGET.md. Nenhum caminho de escrita real
// (src/lib/sync/engine.ts) consome expectedWholesalePrice hoje -- so grava
// em sync_product_state pra auditoria/comparacao futura (FASE C, READ-ONLY).
//
// `policy` (FASE B.4 §3) e a UNICA fonte de verdade pra decidir se um
// produto pode participar de mecanismos comerciais de fixador (ex: Tabela de
// Preco 74) -- nunca inferir isso de unitClass === 'HUNDRED' sozinho, pois
// HUNDRED sem override de commercialPolicyOverride tambem pode navegar como
// 'NONE' (ver resolveCommercialPolicy em src/lib/units/policy-resolver.ts).
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
      /** Decisao comercial centralizada (resolveCommercialPolicy) -- gate oficial para mecanismos de fixador (ex: Tabela de Preco 74). Nunca usar unitClass === 'HUNDRED' como proxy disso. */
      policy: CommercialPolicyKind
      /** Preco final de varejo no Wake -- unico valor usado nos caminhos de escrita (endpoint base e Tabela de Preco). */
      retailPrice: number
      /** Valor de atacado ESPERADO/auditavel nesta fase -- ver comentario acima. NUNCA enviado a Wake na FASE B. null quando a UNIT/politica nao define atacado. */
      expectedWholesalePrice: number | null
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
    policy: result.policy,
    retailPrice: result.salePrice,
    expectedWholesalePrice: result.wholesalePrice ?? null,
    wholesaleMinQty: result.wholesaleMinQty ?? null,
  }
}
