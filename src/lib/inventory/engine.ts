// Motor de estoque -- puro, sem I/O. Converte o estoque real do ERP (numa
// combinacao configuravel de empresa/local do CISS) no estoque que vai pro
// Wake, aplicando o percentual de exposicao (STOCK_PERCENT) com FLOOR
// (nunca arredonda pra cima -- evita vender o que nao existe).
//
// IMPORTANTE (achado 08/09/2026, mesma familia do bug ja corrigido do lado
// do preco -- ver [[correcao-preco-unitario-divisao-cento]] e
// src/lib/pricing/engine.ts): a quantidade de estoque que o CISS devolve pra
// este catalogo (fixadores/parafusos) e EM CENTO (pacotes de 100 unidades),
// nao em unidades fisicas. Exemplo real relatado pelo usuario: CISS devolve
// "2" pro produto 1563, que significa 2 CENTO = 200 parafusos fisicos, nao 2
// parafusos. Por isso multiplica por UNITS_PER_CENTO ANTES de aplicar o
// STOCK_PERCENT -- se aplicasse o percentual direto no valor cru do CISS, o
// estoque exposto no Wake sairia 100x menor que o real (ex: 2 cento * 10% =
// 0 unidades expostas, quando o correto e 200 * 10% = 20).

/** CISS registra estoque deste catalogo em pacotes de cento (100 unidades). */
const UNITS_PER_CENTO = 100

export interface InventoryRules {
  /** ex: 10 significa expor 10% do estoque real do ERP no Wake */
  stockPercent: number
}

export interface InventoryResult {
  /** valor cru como veio do CISS, em CENTO -- so pra auditoria/diff */
  sourceErpStock: number
  /** sourceErpStock convertido pra unidades fisicas (sourceErpStock * 100) */
  sourceErpStockUnits: number
  targetWakeStock: number
  stockPercent: number
}

export function calculateInventory(erpStock: number, rules: InventoryRules): InventoryResult {
  if (!Number.isFinite(erpStock)) {
    throw new Error(`Estoque de origem invalido (ERP): ${erpStock}`)
  }
  if (!Number.isFinite(rules.stockPercent)) {
    throw new Error(`STOCK_PERCENT invalido: ${rules.stockPercent}`)
  }

  const erpStockUnits = Math.max(erpStock, 0) * UNITS_PER_CENTO
  const targetWakeStock = Math.floor(erpStockUnits * (rules.stockPercent / 100))

  return {
    sourceErpStock: erpStock,
    sourceErpStockUnits: erpStockUnits,
    targetWakeStock,
    stockPercent: rules.stockPercent,
  }
}
