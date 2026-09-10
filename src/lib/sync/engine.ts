import 'server-only'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db'
import { withLocks, LockUnavailableError } from './lock'
import { checkRequiredUnconfirmed, rules as ruleSettings, stockSource } from '../settings'
import { calculatePricing, moneyRound } from '../pricing/engine'
import { calculateInventory } from '../inventory/engine'
import { getActivePriceProvider } from '../ciss/price-provider'
import { fetchStockForProducts } from '../ciss/stock'
import {
  updateWakePrices,
  updateWakeStock,
  getWakePriceTableProducts,
  addWakePriceTableProducts,
  updateWakePriceTableProducts,
  getWakeProductBySku,
  WakeClientError,
  type WakePriceUpdateItem,
  type WakeStockUpdateItem,
  type WakeStockUpdateResponse,
  type WakeStockUpdateResultEntry,
  type WakePriceTableProductItem,
} from '../wake/client'

// -----------------------------------------------------------------------
// Motor de sincronizacao -- o "core" unico usado tanto pelo disparo manual
// (web, src/app/api/sync/route.ts) quanto pelo worker agendado
// (worker/index.ts). Nao ha logica de negocio duplicada entre os dois
// caminhos: ambos chamam runSync() abaixo.
//
// Contrato:
//  - dryRun=true NUNCA escreve no Wake -- so calcula e grava o "plano" em
//    sync_run_items (status='planned').
//  - fora de dry-run, se algum REQUIRED_UNCONFIRMED_KEYS estiver faltando,
//    a execucao e recusada (nunca preenche com valor inventado).
//  - protegido por lock (job_locks) contra execucao concorrente do mesmo
//    kind.
//  - todo item processado gera uma linha em sync_run_items, mesmo quando
//    nao houve mudanca (status='no_change') -- trilha de auditoria
//    completa exigida pela especificacao (secao 62).
// -----------------------------------------------------------------------

export type SyncKind = 'price' | 'stock' | 'both'
export type SyncTrigger = 'manual' | 'scheduled' | 'reconciliation'

export interface RunSyncOptions {
  kind: SyncKind
  trigger: SyncTrigger
  triggeredBy?: string
  dryRun: boolean
}

export interface RunSyncResult {
  syncRunId: number
  status: 'success' | 'partial' | 'failed'
  totalProducts: number
  changedProducts: number
  appliedProducts: number
  skippedProducts: number
  failedProducts: number
}

const WAKE_BATCH_SIZE = 50

// Achado em 08-09/09/2026: PUT /produtos/precos e /produtos/estoques nao
// estourar erro NAO prova que o Wake aplicou cada item do lote -- o formato
// do corpo de resposta desses dois endpoints nao e documentado
// publicamente (ver docs/WAKE-API-CONTRATOS.md), e um caso real (SKU 7648,
// syncRunId=172) foi marcado 'applied' sem o Wake ter mudado nada
// (confirmado por GET /produtos/{sku} horas depois: precoPor e
// dataAtualizacao intocados). Por isso toda escrita agora e reconferida por
// leitura (GET /produtos/{sku}, ja confirmado ao vivo) antes de marcar
// 'applied' -- so entao o estado local (sync_product_state) e avancado, pra
// nao travar o produto num "ja aplicado" falso que nunca mais seria
// reenviado. Isso adiciona 1 chamada Wake por produto alterado; o delay
// abaixo mantem a taxa combinada (lote + reconferencia) bem abaixo do
// limite de 120 req/min documentado.
const WAKE_VERIFY_DELAY_MS = 650

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function runSync(options: RunSyncOptions): Promise<RunSyncResult> {
  // 'both' precisa travar os DOIS recursos reais (10/09/2026). Antes pegava
  // so 'sync-both', e um "Preco + Estoque" manual podia rodar em paralelo
  // com o estoque agendado -- escrita duplicada no Wake e o dobro de pressao
  // no limite de 120 req/min (5 throttles seguidos = token bloqueado 1h).
  const lockResources = options.kind === 'both' ? ['sync-price', 'sync-stock'] : [`sync-${options.kind}`]
  try {
    return await withLocks(lockResources, `${options.trigger}:${options.triggeredBy ?? 'system'}`, () =>
      runSyncLocked(options),
    )
  } catch (err) {
    if (err instanceof LockUnavailableError) {
      throw err // deixa o chamador decidir como comunicar (ex: 409 na API)
    }
    throw err
  }
}

async function runSyncLocked(options: RunSyncOptions): Promise<RunSyncResult> {
  const { kind, trigger, triggeredBy, dryRun } = options

  if (!dryRun) {
    const { missing } = await checkRequiredUnconfirmed()
    if (missing.length > 0) {
      throw new Error(
        `Sincronizacao real recusada -- configuracoes obrigatorias ainda nao confirmadas: ${missing.join(', ')}. ` +
          `Preencha em Configuracoes ou rode em modo dry-run.`,
      )
    }
  }

  const [run] = await db
    .insert(schema.syncRuns)
    .values({ kind, trigger, triggeredBy, dryRun, status: 'running' })
    .returning()
  if (!run) throw new Error('Falha ao criar sync_run')

  try {
    const products = await db
      .select()
      .from(schema.managedProducts)
      .where(eq(schema.managedProducts.active, true))

    let changed = 0
    let applied = 0
    let skipped = 0
    let failed = 0

    if (kind === 'price' || kind === 'both') {
      const priceResult = await syncPrices(run.id, products, dryRun)
      changed += priceResult.changed
      applied += priceResult.applied
      skipped += priceResult.skipped
      failed += priceResult.failed
    }

    if (kind === 'stock' || kind === 'both') {
      const stockResult = await syncStock(run.id, products, dryRun)
      changed += stockResult.changed
      applied += stockResult.applied
      skipped += stockResult.skipped
      failed += stockResult.failed
    }

    const status: RunSyncResult['status'] = failed === 0 ? 'success' : applied > 0 ? 'partial' : 'failed'

    await db
      .update(schema.syncRuns)
      .set({
        status,
        totalProducts: products.length,
        changedProducts: changed,
        appliedProducts: applied,
        skippedProducts: skipped,
        failedProducts: failed,
        finishedAt: new Date().toISOString(),
      })
      .where(eq(schema.syncRuns.id, run.id))

    return { syncRunId: run.id, status, totalProducts: products.length, changedProducts: changed, appliedProducts: applied, skippedProducts: skipped, failedProducts: failed }
  } catch (err) {
    await db
      .update(schema.syncRuns)
      .set({ status: 'failed', errorSummary: String(err instanceof Error ? err.message : err), finishedAt: new Date().toISOString() })
      .where(eq(schema.syncRuns.id, run.id))
    throw err
  }
}

type ManagedProduct = typeof schema.managedProducts.$inferSelect

async function getState(managedProductId: number) {
  return db.select().from(schema.syncProductState).where(eq(schema.syncProductState.managedProductId, managedProductId)).get()
}

async function upsertState(managedProductId: number, fields: Partial<typeof schema.syncProductState.$inferInsert>) {
  const existing = await getState(managedProductId)
  if (existing) {
    await db
      .update(schema.syncProductState)
      .set({ ...fields, updatedAt: new Date().toISOString() })
      .where(eq(schema.syncProductState.managedProductId, managedProductId))
  } else {
    await db.insert(schema.syncProductState).values({ managedProductId, ...fields })
  }
}

async function logItem(item: typeof schema.syncRunItems.$inferInsert) {
  await db.insert(schema.syncRunItems).values(item)
}

/**
 * Le todas as paginas de uma tabela de preco Wake e devolve um mapa
 * sku -> {precoDe, precoPor} com o que ja esta gravado la. Usado em
 * syncPrices() tanto pra decidir POST (adicionar) vs PUT (atualizar) por
 * produto quanto pra saber se o valor ja bate (evita PUT redundante).
 * Paginado a 50/pagina (limite da API, ver docs/WAKE-API-CONTRATOS.md).
 * MAX_PAGES e so um teto de seguranca contra loop infinito (ex: API
 * devolvendo sempre pagina cheia por bug) -- nao uma expectativa de
 * tamanho de catalogo. Achado em 08/09/2026 ao expandir a whitelist de
 * fixadores pra 2319 produtos: o teto antigo (20 paginas = 1000 produtos)
 * cortava a leitura no meio do catalogo, fazendo produtos alem do corte
 * nunca serem detectados como "ja corretos" e ficarem sujeitos a reenvio
 * redundante toda run. 200 paginas = 10000 produtos da bastante folga.
 */
async function fetchPriceTableEntries(tabelaPrecoId: number): Promise<Map<string, { precoDe: number; precoPor: number }>> {
  const entries = new Map<string, { precoDe: number; precoPor: number }>()
  const PAGE_SIZE = 50
  const MAX_PAGES = 200
  for (let pagina = 1; pagina <= MAX_PAGES; pagina++) {
    const page = await getWakePriceTableProducts(tabelaPrecoId, { pagina, quantidadeRegistros: PAGE_SIZE })
    for (const p of page) entries.set(p.sku, { precoDe: p.precoDe, precoPor: p.precoPor })
    if (page.length < PAGE_SIZE) break
  }
  return entries
}

// --- Preco ------------------------------------------------------------

// Preco "De" da Tabela de Preco e ficticio (nao vem do ERP) -- pedido
// explicito do usuario em 08/09/2026: so pra mostrar desconto na vitrine,
// sempre 30% acima do Preco Por (que agora e o mesmo preco unitario
// aplicado no endpoint base).
const TABLE_FAKE_DISCOUNT_PERCENT = 30

async function syncPrices(syncRunId: number, products: ManagedProduct[], dryRun: boolean) {
  let changed = 0, applied = 0, skipped = 0, failed = 0

  const provider = getActivePriceProvider()
  const retailPrices = await provider.getRetailPrices(products.map((p) => p.cissProductId))
  const markupPercent = await ruleSettings.unitPriceMarkupPercent()
  const wholesaleMinQty = await ruleSettings.wholesaleMinQty()

  // Tabela de Preco dedicada (WAKE_PRICE_TABLE_ID, ver
  // src/lib/pricing/engine.ts) -- preco "de cento" so chega no Wake por
  // ela, nunca pelo endpoint base (updateWakePrices/precoPor). Buscada uma
  // vez aqui (nao dentro do loop) pra decidir POST vs PUT por produto e pra
  // detectar quando o valor gravado la ja bate com o alvo, INDEPENDENTE de
  // o preco unitario ter mudado ou nao -- achado em 08/09/2026 (Execucao
  // #111): mudar so a formula do preco de/por, sem o preco unitario mudar,
  // nao disparava reenvio nenhum porque esse passo vivia dentro do mesmo
  // "se o preco unitario mudou" do endpoint base.
  const { values } = await checkRequiredUnconfirmed()
  const priceTableIdRaw = values.WAKE_PRICE_TABLE_ID
  const priceTableId = priceTableIdRaw && Number.isFinite(Number(priceTableIdRaw)) ? Number(priceTableIdRaw) : null
  const tableEntries = !dryRun && priceTableId !== null ? await fetchPriceTableEntries(priceTableId) : null

  const toApplyUnitPrice: Array<{
    product: ManagedProduct
    unitPrice: number
    specialPrice: number
    sourceOldValue: number | null
    sourceNewValue: number
    targetOldValue: number | null
  }> = []
  const toApplyTablePrice: Array<{ product: ManagedProduct; precoDe: number; precoPor: number; existsInTable: boolean }> = []

  for (const product of products) {
    const retailPrice = retailPrices.get(product.cissProductId)
    if (retailPrice === undefined) {
      // MUDANCA (10/09/2026, pedido do usuario): produto sem preco cadastrado
      // no ERP nao e erro da integracao -- nao ha preco pra enviar, entao o
      // item e IGNORADO (status 'skipped') e o preco atual do Wake fica como
      // esta. Erro de verdade (CISS fora/401/timeout) lanca dentro do
      // provider e derruba a run, nao cai aqui.
      skipped++
      await logItem({ syncRunId, managedProductId: product.id, field: 'unit_price', status: 'skipped', errorMessage: 'Sem preço cadastrado no ERP -- preço do Wake mantido' })
      continue
    }

    const pricing = calculatePricing(retailPrice, { unitPriceMarkupPercent: markupPercent, wholesaleMinQty })
    const state = await getState(product.id)
    const priceUnchanged = state?.lastAppliedWakeUnitPrice === pricing.wakeUnitPrice && state?.lastAppliedWakeSpecialPrice === pricing.wakeSpecialPrice

    if (priceUnchanged) {
      skipped++
      await logItem({ syncRunId, managedProductId: product.id, field: 'unit_price', sourceOldValue: state?.erpPrice ?? null, sourceNewValue: retailPrice, targetOldValue: state?.lastAppliedWakeUnitPrice ?? null, targetNewValue: pricing.wakeUnitPrice, status: 'no_change' })
    } else {
      changed++
      const sourceOldValue = state?.erpPrice ?? null
      const targetOldValue = state?.lastAppliedWakeUnitPrice ?? null

      if (dryRun) {
        await logItem({
          syncRunId,
          managedProductId: product.id,
          field: 'unit_price',
          sourceOldValue,
          sourceNewValue: retailPrice,
          targetOldValue,
          targetNewValue: pricing.wakeUnitPrice,
          status: 'planned',
        })
      }
      // fora de dry-run o log so acontece depois da reconferencia, la
      // embaixo -- ver comentario de WAKE_VERIFY_DELAY_MS.

      await upsertState(product.id, {
        erpPrice: retailPrice,
        erpReadAt: new Date().toISOString(),
        calculatedWakeUnitPrice: pricing.wakeUnitPrice,
        calculatedWakeSpecialPrice: pricing.wakeSpecialPrice,
      })

      if (!dryRun) {
        toApplyUnitPrice.push({
          product,
          unitPrice: pricing.wakeUnitPrice,
          specialPrice: pricing.wakeSpecialPrice,
          sourceOldValue,
          sourceNewValue: retailPrice,
          targetOldValue,
        })
      }
    }

    // Preco Por = preco unitario (igual ao que vai no endpoint base); Preco
    // De = Preco Por + 30% (ficticio, so pra exibir desconto). Compara
    // contra o que JA ESTA no Wake (tableEntries), nao contra nosso estado
    // local -- por isso roda mesmo quando priceUnchanged acima.
    if (tableEntries) {
      const targetPrecoPor = pricing.wakeUnitPrice
      const targetPrecoDe = moneyRound(targetPrecoPor * (1 + TABLE_FAKE_DISCOUNT_PERCENT / 100))
      const current = tableEntries.get(product.wakeSku)
      const tableUnchanged = current !== undefined && current.precoPor === targetPrecoPor && current.precoDe === targetPrecoDe
      if (!tableUnchanged) {
        toApplyTablePrice.push({ product, precoDe: targetPrecoDe, precoPor: targetPrecoPor, existsInTable: current !== undefined })
      }
    }
  }

  if (!dryRun && toApplyUnitPrice.length > 0) {
    // tipoIdentificador vai como query param dentro de updateWakePrices()
    // (ver comentario la -- NAO e campo do corpo, bug de raiz corrigido em
    // 09/09/2026).
    for (let i = 0; i < toApplyUnitPrice.length; i += WAKE_BATCH_SIZE) {
      const batch = toApplyUnitPrice.slice(i, i + WAKE_BATCH_SIZE)
      const payload: WakePriceUpdateItem[] = batch.map((b) => ({
        identificador: b.product.wakeSku,
        precoPor: b.unitPrice,
      }))

      let putResponse: unknown = null
      let putError: string | null = null
      try {
        putResponse = await updateWakePrices(payload)
      } catch (err) {
        putError = err instanceof WakeClientError ? err.message : String(err)
      }
      const putResponseRaw = putError === null ? JSON.stringify(putResponse ?? null).slice(0, 4000) : null

      if (putError !== null) {
        for (const b of batch) {
          failed++
          await logItem({
            syncRunId,
            managedProductId: b.product.id,
            field: 'unit_price',
            sourceOldValue: b.sourceOldValue,
            sourceNewValue: b.sourceNewValue,
            targetOldValue: b.targetOldValue,
            targetNewValue: b.unitPrice,
            status: 'failed',
            errorMessage: putError,
          })
        }
        continue
      }

      // Lote aceito sem erro -- reconfere item a item por leitura antes de
      // marcar 'applied' (ver comentario de WAKE_VERIFY_DELAY_MS acima).
      for (const b of batch) {
        let verified = false
        let verifyDetail = ''
        try {
          const live = await getWakeProductBySku(b.product.wakeSku)
          if (live && live.precoPor === b.unitPrice) {
            verified = true
          } else if (live) {
            verifyDetail = `Wake ainda mostra precoPor=${live.precoPor} (esperado ${b.unitPrice})`
          } else {
            verifyDetail = 'produto nao encontrado no Wake na reconferencia'
          }
        } catch (err) {
          verifyDetail = `falha ao reconferir: ${err instanceof WakeClientError ? err.message : String(err)}`
        }

        if (verified) {
          applied++
          await upsertState(b.product.id, { lastAppliedWakeUnitPrice: b.unitPrice, lastAppliedWakeSpecialPrice: b.specialPrice, lastAppliedAt: new Date().toISOString(), lastSyncRunId: syncRunId })
          await logItem({
            syncRunId,
            managedProductId: b.product.id,
            field: 'unit_price',
            sourceOldValue: b.sourceOldValue,
            sourceNewValue: b.sourceNewValue,
            targetOldValue: b.targetOldValue,
            targetNewValue: b.unitPrice,
            status: 'applied',
            wakeAfterRaw: putResponseRaw,
          })
        } else {
          failed++
          // NAO atualiza lastApplied* -- sync_product_state continua
          // divergente do calculado, entao a proxima run detecta como
          // "mudou" de novo e tenta reenviar, em vez de travar num falso
          // "ja aplicado" que nunca mais seria reconferido.
          await logItem({
            syncRunId,
            managedProductId: b.product.id,
            field: 'unit_price',
            sourceOldValue: b.sourceOldValue,
            sourceNewValue: b.sourceNewValue,
            targetOldValue: b.targetOldValue,
            targetNewValue: b.unitPrice,
            status: 'failed',
            errorMessage: `Wake aceitou a chamada sem erro, mas a reconferencia nao confirmou -- ${verifyDetail}`,
            wakeAfterRaw: putResponseRaw,
          })
        }
        await sleep(WAKE_VERIFY_DELAY_MS)
      }
    }
  } else if (dryRun) {
    applied = 0 // dry-run nunca conta como aplicado
  }

  // Envio pra Tabela de Preco -- best-effort e desacoplado do lote de preco
  // unitario acima (endpoints diferentes do Wake; um falhar nao desfaz o
  // outro). So roda fora de dry-run e com WAKE_PRICE_TABLE_ID configurado.
  if (!dryRun && priceTableId !== null && toApplyTablePrice.length > 0) {
    for (let i = 0; i < toApplyTablePrice.length; i += WAKE_BATCH_SIZE) {
      const batch = toApplyTablePrice.slice(i, i + WAKE_BATCH_SIZE)
      const toUpdate: WakePriceTableProductItem[] = batch.filter((b) => b.existsInTable).map((b) => ({ sku: b.product.wakeSku, precoDe: b.precoDe, precoPor: b.precoPor }))
      const toAdd: WakePriceTableProductItem[] = batch.filter((b) => !b.existsInTable).map((b) => ({ sku: b.product.wakeSku, precoDe: b.precoDe, precoPor: b.precoPor }))

      try {
        if (toUpdate.length > 0) await updateWakePriceTableProducts(priceTableId, toUpdate)
        if (toAdd.length > 0) await addWakePriceTableProducts(priceTableId, toAdd)
        for (const b of batch) {
          changed++
          applied++
          await logItem({ syncRunId, managedProductId: b.product.id, field: 'special_price', targetOldValue: null, targetNewValue: b.precoPor, status: 'applied' })
        }
      } catch (err) {
        for (const b of batch) {
          failed++
          await logItem({ syncRunId, managedProductId: b.product.id, field: 'special_price', status: 'failed', errorMessage: err instanceof WakeClientError ? err.message : String(err) })
        }
      }
    }
  }

  return { changed, applied, skipped, failed }
}

// --- Estoque ----------------------------------------------------------

async function syncStock(syncRunId: number, products: ManagedProduct[], dryRun: boolean) {
  let changed = 0, applied = 0, skipped = 0, failed = 0

  const { values } = await checkRequiredUnconfirmed()
  const wakeCdId = values.WAKE_CD_ID

  if (!wakeCdId) {
    // dry-run pode chegar aqui sem esse valor -- registra e sai, sem quebrar a run inteira.
    // CISS_STOCK_ENTERPRISE/CISS_STOCK_LOCATION nao bloqueiam mais: ja tem
    // default real confirmado (ver src/lib/settings.ts, STOCK_SOURCE_DEFAULTS).
    for (const product of products) {
      failed++
      await logItem({ syncRunId, managedProductId: product.id, field: 'stock', status: 'failed', errorMessage: 'WAKE_CD_ID ainda nao configurado' })
    }
    return { changed, applied, skipped, failed }
  }

  const stockPercent = await ruleSettings.stockPercent()
  const enterprise = await stockSource.enterprise()
  const location = await stockSource.location()
  const stockRows = await fetchStockForProducts(products.map((p) => p.cissProductId), { enterprise, location })
  const stockByProduct = new Map(stockRows.map((r) => [r.productId, r.stock]))
  const noRecordIds = new Set(stockRows.filter((r) => r.noRecord).map((r) => r.productId))
  // Aviso informativo (NAO e erro) gravado no item -- usa a coluna
  // error_message, que a tela so pinta de vermelho quando status='failed'.
  const NO_RECORD_NOTE = 'Sem registro de estoque no ERP -- tratado como 0'

  const toApply: Array<{
    product: ManagedProduct
    targetStock: number
    sourceOldValue: number | null
    sourceNewValue: number
    targetOldValue: number | null
    note: string | null
  }> = []

  for (const product of products) {
    const erpStock = stockByProduct.get(product.cissProductId)
    const note = noRecordIds.has(product.cissProductId) ? NO_RECORD_NOTE : null
    if (erpStock === undefined) {
      failed++
      await logItem({ syncRunId, managedProductId: product.id, field: 'stock', status: 'failed', errorMessage: `Sem leitura de estoque CISS para ciss_product_id=${product.cissProductId}` })
      continue
    }

    const inventory = calculateInventory(erpStock, { stockPercent })
    const state = await getState(product.id)
    const stockUnchanged = state?.lastAppliedWakeStock === inventory.targetWakeStock

    if (stockUnchanged) {
      skipped++
      await logItem({ syncRunId, managedProductId: product.id, field: 'stock', sourceOldValue: state?.erpStock ?? null, sourceNewValue: erpStock, targetOldValue: state?.lastAppliedWakeStock ?? null, targetNewValue: inventory.targetWakeStock, status: 'no_change', errorMessage: note })
      continue
    }

    changed++
    const sourceOldValue = state?.erpStock ?? null
    const targetOldValue = state?.lastAppliedWakeStock ?? null

    if (dryRun) {
      await logItem({ syncRunId, managedProductId: product.id, field: 'stock', sourceOldValue, sourceNewValue: erpStock, targetOldValue, targetNewValue: inventory.targetWakeStock, status: 'planned', errorMessage: note })
    }
    // fora de dry-run o log so acontece depois da reconferencia, la embaixo.

    await upsertState(product.id, { erpStock, erpReadAt: new Date().toISOString(), calculatedWakeStock: inventory.targetWakeStock })

    if (!dryRun) toApply.push({ product, targetStock: inventory.targetWakeStock, sourceOldValue, sourceNewValue: erpStock, targetOldValue, note })
  }

  if (!dryRun && toApply.length > 0) {
    // tipoIdentificador vai como query param dentro de updateWakeStock()
    // (ver comentario la -- NAO e campo do corpo, bug de raiz corrigido em
    // 09/09/2026: era esse o motivo do Wake rejeitar 100% dos itens com
    // "Produto \"0\" nao encontrado", mesmo com produtoVarianteId correto).
    for (let i = 0; i < toApply.length; i += WAKE_BATCH_SIZE) {
      const batch = toApply.slice(i, i + WAKE_BATCH_SIZE)
      const payload: WakeStockUpdateItem[] = batch.map((b) => ({
        identificador: b.product.wakeSku,
        listaEstoque: [{ produtoVarianteId: Number(b.product.wakeProductVariantId), centroDistribuicaoId: Number(wakeCdId), estoqueFisico: b.targetStock }],
      }))

      let putResponse: WakeStockUpdateResponse | null = null
      let putError: string | null = null
      try {
        putResponse = await updateWakeStock(payload)
      } catch (err) {
        putError = err instanceof WakeClientError ? err.message : String(err)
      }
      const putResponseRaw = putError === null ? JSON.stringify(putResponse ?? null).slice(0, 4000) : null

      if (putError !== null) {
        for (const b of batch) {
          failed++
          await logItem({
            syncRunId,
            managedProductId: b.product.id,
            field: 'stock',
            sourceOldValue: b.sourceOldValue,
            sourceNewValue: b.sourceNewValue,
            targetOldValue: b.targetOldValue,
            targetNewValue: b.targetStock,
            status: 'failed',
            errorMessage: putError,
          })
        }
        continue
      }

      // Lote aceito sem erro -- confere item a item pelo ACK POR VARIANTE que
      // o proprio PUT /produtos/estoques devolve (produtosAtualizados /
      // produtosNaoAtualizados, cada entrada com produtoVarianteId, sku,
      // `resultado` e `detalhes`). Ver WakeStockUpdateResponse em
      // src/lib/wake/client.ts.
      //
      // BUG CORRIGIDO (10/09/2026): antes daqui saia uma reconferencia por
      // RELEITURA (GET /produtos/{sku}) checando se `dataAtualizacao` tinha
      // avancado pra depois do inicio da sync. Isso era um falso negativo
      // permanente, porque:
      //   1. GET /produtos/{sku} nunca devolve `estoque` preenchido (sempre
      //      `[]`), entao nao dava pra comparar o valor direto como no preco;
      //   2. `dataAtualizacao` e timestamp de CATALOGO/PRECO -- escrita de
      //      estoque (que vive no subsistema de centro de distribuicao) NAO
      //      encosta nele. Provado em producao: os 102 itens que falhavam
      //      todo ciclo reportavam todos `dataAtualizacao=2026-09-09T17:52:46`
      //      (horario local), que e exatamente quando a sync de PRECO da run
      //      207 rodou -- nenhuma das dezenas de escritas de estoque
      //      posteriores mexeu naquele campo, mesmo o Wake respondendo
      //      "atualizado com sucesso" pra todas elas.
      // Efeito do bug: o item nunca era marcado 'applied', logo
      // last_applied_wake_stock nunca era gravado, logo a run seguinte
      // tratava o mesmo produto como "mudou" e reenviava -- laco infinito de
      // ~105 falhas fantasma por execucao (runs 209..227), enquanto o estoque
      // no Wake ja estava certo o tempo todo.
      //
      // O ack do lote e sinal DIRETO e por item, vindo do proprio Wake -- e
      // estritamente melhor que qualquer releitura heuristica, e de brinde
      // elimina 1 GET por produto alterado (a sync de estoque cheia caiu de
      // ~35min pra poucos minutos).
      const ackByVariant = new Map<number, WakeStockUpdateResultEntry>()
      const ackBySku = new Map<string, WakeStockUpdateResultEntry>()
      const rejectedByVariant = new Map<number, WakeStockUpdateResultEntry>()
      const rejectedBySku = new Map<string, WakeStockUpdateResultEntry>()
      for (const entry of putResponse?.produtosAtualizados ?? []) {
        if (typeof entry.produtoVarianteId === 'number') ackByVariant.set(entry.produtoVarianteId, entry)
        if (entry.sku) ackBySku.set(String(entry.sku), entry)
      }
      for (const entry of putResponse?.produtosNaoAtualizados ?? []) {
        if (typeof entry.produtoVarianteId === 'number') rejectedByVariant.set(entry.produtoVarianteId, entry)
        if (entry.sku) rejectedBySku.set(String(entry.sku), entry)
      }

      for (const b of batch) {
        const variantId = Number(b.product.wakeProductVariantId)
        const sku = String(b.product.wakeSku)
        const ok = (Number.isFinite(variantId) ? ackByVariant.get(variantId) : undefined) ?? ackBySku.get(sku)
        const rejected = (Number.isFinite(variantId) ? rejectedByVariant.get(variantId) : undefined) ?? rejectedBySku.get(sku)

        let verified = false
        let verifyDetail = ''
        if (ok && ok.resultado !== false) {
          verified = true
        } else if (rejected) {
          verifyDetail = rejected.detalhes
            ? `Wake recusou o item: ${rejected.detalhes}`
            : 'Wake listou o item em produtosNaoAtualizados (sem detalhe)'
        } else if (ok) {
          // esta em produtosAtualizados mas com resultado=false -- contraditorio,
          // trata como recusa e mantem o produto na fila da proxima run.
          verifyDetail = ok.detalhes ? `Wake retornou resultado=false: ${ok.detalhes}` : 'Wake retornou resultado=false para o item'
        } else {
          verifyDetail = `Wake nao mencionou o item (sku=${sku}, produtoVarianteId=${variantId}) em nenhuma das listas da resposta do lote`
        }

        if (verified) {
          applied++
          await upsertState(b.product.id, { lastAppliedWakeStock: b.targetStock, lastAppliedAt: new Date().toISOString(), lastSyncRunId: syncRunId })
          await logItem({
            syncRunId,
            managedProductId: b.product.id,
            field: 'stock',
            sourceOldValue: b.sourceOldValue,
            sourceNewValue: b.sourceNewValue,
            targetOldValue: b.targetOldValue,
            targetNewValue: b.targetStock,
            status: 'applied',
            errorMessage: b.note,
            wakeAfterRaw: putResponseRaw,
          })
        } else {
          failed++
          // NAO atualiza lastAppliedWakeStock -- mesma logica do preco:
          // sem isso, a proxima run trataria esse produto como "ja
          // aplicado" e nunca mais tentaria reenviar.
          await logItem({
            syncRunId,
            managedProductId: b.product.id,
            field: 'stock',
            sourceOldValue: b.sourceOldValue,
            sourceNewValue: b.sourceNewValue,
            targetOldValue: b.targetOldValue,
            targetNewValue: b.targetStock,
            status: 'failed',
            errorMessage: `Wake aceitou a chamada, mas nao confirmou este item -- ${verifyDetail}`,
            wakeAfterRaw: putResponseRaw,
          })
        }
      }

      // Pausa ENTRE LOTES (nao mais por item -- nao ha releitura por item
      // desde o fix de 10/09/2026). Mantem a taxa bem abaixo dos 120 req/min
      // do Wake mesmo com o catalogo inteiro: ~47 lotes de 50 = ~30s de pausa
      // somada, em vez dos ~25min que as reconferencias por item custavam.
      await sleep(WAKE_VERIFY_DELAY_MS)
    }
  }

  return { changed, applied, skipped, failed }
}
