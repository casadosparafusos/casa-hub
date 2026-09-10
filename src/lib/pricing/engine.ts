// Motor de preco -- puro, sem I/O, testavel isoladamente. Recebe o preco
// bruto que o CISS/PODER devolve (P) e devolve os dois valores que a
// integracao escreve no Wake:
//   - unitPrice: preco por UNIDADE, com markup
//   - specialPrice: preco "de cento" (>= WHOLESALE_MIN_QTY unidades) --
//     entregue via Tabela de Preco + Promocao no Wake (ver
//     docs/WAKE-API-CONTRATOS.md), nao via este motor diretamente.
//
// IMPORTANTE (corrigido 08/09/2026, ver [[correcao-preco-unitario-divisao-cento]]):
// o preco bruto que o CISS/PODER expoe hoje E O PRECO DO CENTO, nao o preco
// unitario. Por isso:
//   - wakeSpecialPrice = P direto (ja e o preco de cento, sem markup).
//   - wakeUnitPrice = (P / 100) * (1 + markup%) -- tem que dividir por 100
//     ANTES de aplicar o markup, senao o unitario sai 100x maior que devia.
//
// P (preco bruto do CISS) ainda nao esta disponivel via API em producao --
// ver src/lib/ciss/price-provider.ts pro provider mock que alimenta este
// motor ate o escopo `product_prices` ser liberado pelo SIGAS (401 hoje,
// ver docs/WAKE-API-CONTRATOS.md).

export interface PricingRules {
  /** ex: 20 significa +20% sobre o preco bruto do ERP */
  unitPriceMarkupPercent: number
  /** quantidade minima (em unidades) pra valer o preco "de cento" */
  wholesaleMinQty: number
}

export interface PricingResult {
  /** preco de varejo bruto do ERP, sem nenhum ajuste -- so pra auditoria/diff */
  sourceRetailPrice: number
  /** preco unitario final no Wake, com markup aplicado e arredondado */
  wakeUnitPrice: number
  /** preco/cento final no Wake (igual ao preco bruto do ERP) */
  wakeSpecialPrice: number
  wholesaleMinQty: number
}

/**
 * Arredondamento monetario -- 2 casas decimais, meio-para-cima. Isolado
 * numa funcao propria porque arredondamento de dinheiro e um dos pontos
 * classicos de divergencia de centavos entre sistemas (ver
 * [[fonte-unica-receita-erp-fix-auditoria]] no RD Gerencial pra um caso
 * real desse tipo de discrepancia).
 */
export function moneyRound(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

export function calculatePricing(retailPriceFromErp: number, rules: PricingRules): PricingResult {
  if (!Number.isFinite(retailPriceFromErp) || retailPriceFromErp < 0) {
    throw new Error(`Preco de origem invalido (ERP): ${retailPriceFromErp}`)
  }
  if (!Number.isFinite(rules.unitPriceMarkupPercent)) {
    throw new Error(`UNIT_PRICE_MARKUP_PERCENT invalido: ${rules.unitPriceMarkupPercent}`)
  }

  // O preco bruto do CISS/PODER e o preco DO CENTO -- divide por 100 antes
  // de aplicar o markup pra chegar no preco por unidade.
  const wakeUnitPrice = moneyRound((retailPriceFromErp / 100) * (1 + rules.unitPriceMarkupPercent / 100))
  // Preco "de cento": preco bruto do ERP, sem markup, conforme especificacao.
  const wakeSpecialPrice = moneyRound(retailPriceFromErp)

  return {
    sourceRetailPrice: retailPriceFromErp,
    wakeUnitPrice,
    wakeSpecialPrice,
    wholesaleMinQty: rules.wholesaleMinQty,
  }
}
