import 'server-only'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db'
import { withLocks, LockUnavailableError } from './lock'
import { checkRequiredUnconfirmed, getCommercialPolicyConfig, stockSource } from '../settings'
import { calculateUnitPrice } from '../pricing/engine'
import { calculateUnitStock } from '../inventory/engine'
import { moneyRound, type CommercialPolicyConfig } from '../units'
import { getActivePriceProvider } from '../ciss/price-provider'
import { fetchStockForProducts, type CissStockRow } from '../ciss/stock'
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
    // FASE C §3: motor nunca pode escrever no Wake com o provider de preco
    // em modo mock -- sinal de ambiente nao pronto pra producao (ver
    // src/lib/ciss/price-provider.ts, unico switch mock/live do codebase).
    // Vale pro run inteiro (price/stock/both), nao so pra 'price': um
    // ambiente com preco mockado nao e um ambiente onde faz sentido confiar
    // em nenhuma escrita real. Recusa ANTES de criar a sync_run, igual o
    // check de REQUIRED_UNCONFIRMED_KEYS abaixo.
    const activeProvider = getActivePriceProvider()
    if (activeProvider.name === 'mock') {
      throw new Error(
        'MOCK_PROVIDER_WRITE_BLOCKED: CISS_PRICE_PROVIDER=mock nao pode gravar no Wake fora de dry-run. ' +
          'Configure CISS_PRICE_PROVIDER=live ou rode com dryRun=true.',
      )
    }

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

    // Busca UNICA de estoque+unit no CISS, compartilhada entre syncPrices()
    // e syncStock() -- ver docs/CASA_HUB_FASE_B_UNIT_STRATEGIES.md §13. O
    // preco no CISS nao expoe `unit` (ver ciss/price-provider.ts), so
    // /products/stock expoe -- por isso precisa uma sync de preco tambem
    // consultar esse endpoint agora, mesmo em kind='price'. Endpoint com
    // historico de timeout intermitente (ver memoria
    // ciss-stock-sales-timeout-intermitente-2026-09.md): buscar 1x aqui em
    // vez de 1x por funcao evita dobrar essa exposicao numa run kind='both'.
    const enterprise = await stockSource.enterprise()
    const location = await stockSource.location()
    const stockRows = await fetchStockForProducts(products.map((p) => p.cissProductId), { enterprise, location })
    const stockByProduct = new Map(stockRows.map((r) => [r.productId, r]))

    const packageConfigRows = await db
      .select()
      .from(schema.productSaleUnitConfig)
      .where(eq(schema.productSaleUnitConfig.active, true))
    const packageConfigs = new Map(packageConfigRows.map((r) => [r.managedProductId, { quantityPerSaleUnit: r.quantityPerSaleUnit }]))

    // FASE B.1 (PROBLEMA 1) -- ponte settings -> CommercialPolicyConfig,
    // lida UMA vez por run e injetada em syncPrices()/syncStock() (que por
    // sua vez passam pra calculateUnitPrice()/calculateUnitStock()). O
    // modulo puro (src/lib/units) nunca le settings/env diretamente -- ver
    // src/lib/settings.ts#getCommercialPolicyConfig e no-write-path.test.ts.
    const commercialPolicyConfig = await getCommercialPolicyConfig()

    let changed = 0
    let applied = 0
    let skipped = 0
    let failed = 0

    if (kind === 'price' || kind === 'both') {
      const priceResult = await syncPrices(run.id, products, dryRun, stockByProduct, packageConfigs, commercialPolicyConfig)
      changed += priceResult.changed
      applied += priceResult.applied
      skipped += priceResult.skipped
      failed += priceResult.failed
    }

    if (kind === 'stock' || kind === 'both') {
      const stockResult = await syncStock(run.id, products, dryRun, stockByProduct, packageConfigs, commercialPolicyConfig)
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

async function syncPrices(
  syncRunId: number,
  products: ManagedProduct[],
  dryRun: boolean,
  stockByProduct: Map<string, CissStockRow>,
  packageConfigs: Map<number, { quantityPerSaleUnit: number }>,
  commercialPolicyConfig: CommercialPolicyConfig,
) {
  let changed = 0, applied = 0, skipped = 0, failed = 0

  const provider = getActivePriceProvider()
  const retailPrices = await provider.getRetailPrices(products.map((p) => p.cissProductId))

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
    expectedWholesalePrice: number | null
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

    // unitRaw so vem do endpoint de estoque (ver comentario em
    // runSyncLocked()) -- por isso essa leitura, mesmo numa sync de preco.
    const stockRow = stockByProduct.get(product.cissProductId)
    const unitRaw = stockRow?.unitRaw ?? null
    const packageConfig = packageConfigs.get(product.id) ?? null
    const priceResult = calculateUnitPrice({ unitRaw, cissPrice: retailPrice, packageConfig, commercialPolicyConfig })

    if (!priceResult.ok) {
      // §1/§5: UNIT nao suportada ou config de PACKAGE_MEASURED faltando sao
      // exatamente os problemas que essa fase existe pra expor -- por isso
      // 'failed' (pinta vermelho na UI), nunca 'skipped', e zero escrita no
      // Wake pra esse produto.
      failed++
      await upsertState(product.id, {
        erpPrice: retailPrice,
        erpReadAt: new Date().toISOString(),
        unitRaw: priceResult.unitRaw,
        unitNormalized: priceResult.unitNormalized,
        unitClass: null,
        unitResolutionStatus: priceResult.reason,
      })
      await logItem({
        syncRunId,
        managedProductId: product.id,
        field: 'unit_price',
        sourceOldValue: null,
        sourceNewValue: retailPrice,
        status: 'failed',
        errorMessage: `UNIT nao processavel (${priceResult.reason}${priceResult.detail ? `: ${priceResult.detail}` : ''}) -- unit_raw=${priceResult.unitRaw ?? 'null'}`,
      })
      continue
    }

    const unitFields = {
      unitRaw: priceResult.unitRaw,
      unitNormalized: priceResult.unitNormalized,
      unitClass: priceResult.unitClass,
      unitResolutionStatus: 'OK' as const,
    }

    const state = await getState(product.id)
    // lastAppliedWakeSpecialPrice e coluna legada (nunca renomeada -- FASE
    // B.4 §5, evitar migration sem ganho imediato) que guarda
    // expectedWholesalePrice pra fins de comparacao/auditoria; nunca reflete
    // um valor de fato enviado a Wake.
    const priceUnchanged = state?.lastAppliedWakeUnitPrice === priceResult.retailPrice && state?.lastAppliedWakeSpecialPrice === priceResult.expectedWholesalePrice

    if (priceUnchanged) {
      skipped++
      await logItem({ syncRunId, managedProductId: product.id, field: 'unit_price', sourceOldValue: state?.erpPrice ?? null, sourceNewValue: retailPrice, targetOldValue: state?.lastAppliedWakeUnitPrice ?? null, targetNewValue: priceResult.retailPrice, status: 'no_change' })
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
          targetNewValue: priceResult.retailPrice,
          status: 'planned',
        })
      }
      // fora de dry-run o log so acontece depois da reconferencia, la
      // embaixo -- ver comentario de WAKE_VERIFY_DELAY_MS.

      await upsertState(product.id, {
        erpPrice: retailPrice,
        erpReadAt: new Date().toISOString(),
        calculatedWakeUnitPrice: priceResult.retailPrice,
        calculatedWakeSpecialPrice: priceResult.expectedWholesalePrice,
        ...unitFields,
      })

      if (!dryRun) {
        toApplyUnitPrice.push({
          product,
          unitPrice: priceResult.retailPrice,
          expectedWholesalePrice: priceResult.expectedWholesalePrice,
          sourceOldValue,
          sourceNewValue: retailPrice,
          targetOldValue,
        })
      }
    }

    // Preco Por = preco de varejo (igual ao que vai no endpoint base); Preco
    // De = Preco Por + 30% (ficticio, so pra exibir desconto). Compara
    // contra o que JA ESTA no Wake (tableEntries), nao contra nosso estado
    // local -- por isso roda mesmo quando priceUnchanged acima.
    //
    // FASE B.4 §3 (BLOQUEIO PRINCIPAL): o gate NAO pode ser so "existe
    // WAKE_PRICE_TABLE_ID configurado" (tableEntries !== null) -- isso
    // aplicava a Tabela 74 a QUALQUER produto/UNIT, vazando o mecanismo de
    // FIXADOR_CENTO (CT >= 100) pra DIRECT/KG/MT por acidente. O gate real e
    // a decisao comercial centralizada (`priceResult.policy`, vinda de
    // resolveCommercialPolicy() via computeUnit() -- ver
    // src/lib/units/policy-resolver.ts), nunca `unitClass === 'HUNDRED'`
    // isolado: CT com commercialPolicyOverride='NONE' tambem fica de fora.
    if (tableEntries && priceResult.policy === 'FIXADOR_CENTO') {
      const targetPrecoPor = priceResult.retailPrice
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
        // FASE C §5/§6: 'mismatch' = Wake respondeu e o valor la e outro
        // (escrita foi aceita, mas divergiu) -- distinto de 'failed', que
        // fica reservado pra erro de fato (produto sumiu na reconferencia
        // ou a propria leitura falhou). Ver mesmo criterio no bloco da
        // Tabela 74 mais abaixo.
        let mismatch = false
        let verifyDetail = ''
        try {
          const live = await getWakeProductBySku(b.product.wakeSku)
          if (live && live.precoPor === b.unitPrice) {
            verified = true
          } else if (live) {
            mismatch = true
            verifyDetail = `Wake ainda mostra precoPor=${live.precoPor} (esperado ${b.unitPrice})`
          } else {
            verifyDetail = 'produto nao encontrado no Wake na reconferencia'
          }
        } catch (err) {
          verifyDetail = `falha ao reconferir: ${err instanceof WakeClientError ? err.message : String(err)}`
        }

        if (verified) {
          applied++
          await upsertState(b.product.id, { lastAppliedWakeUnitPrice: b.unitPrice, lastAppliedWakeSpecialPrice: b.expectedWholesalePrice, lastAppliedAt: new Date().toISOString(), lastSyncRunId: syncRunId })
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
            status: mismatch ? 'mismatch' : 'failed',
            errorMessage: `Wake aceitou a chamada sem erro, mas a reconferencia ${mismatch ? 'encontrou valor diferente' : 'nao confirmou'} -- ${verifyDetail}`,
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

        // FASE C §9: updateWakePriceTableProducts/addWakePriceTableProducts
        // nao devolvem ACK por item (void, ver src/lib/wake/client.ts) --
        // diferente do preco unitario (GET /produtos/{sku}) e do estoque
        // (ACK do proprio PUT), o unico jeito de confirmar aqui e reler a
        // Tabela de Preco inteira, igual fetchPriceTableEntries() ja faz no
        // topo desta funcao pra montar o diff. Sem isto o bug historico do
        // SKU 7648 (escrita aceita sem erro, valor no Wake nunca mudou)
        // ficava sem protecao nenhuma neste caminho.
        const verifyEntries = await fetchPriceTableEntries(priceTableId)
        for (const b of batch) {
          changed++
          const entry = verifyEntries.get(b.product.wakeSku)
          const verified = entry !== undefined && entry.precoPor === b.precoPor && entry.precoDe === b.precoDe
          if (verified) {
            applied++
            await logItem({ syncRunId, managedProductId: b.product.id, field: 'special_price', targetOldValue: null, targetNewValue: b.precoPor, status: 'applied' })
          } else {
            failed++
            const detail =
              entry === undefined
                ? 'SKU nao encontrado na Tabela de Preco apos a escrita'
                : `Tabela de Preco mostra precoPor=${entry.precoPor}/precoDe=${entry.precoDe} (esperado precoPor=${b.precoPor}/precoDe=${b.precoDe})`
            await logItem({
              syncRunId,
              managedProductId: b.product.id,
              field: 'special_price',
              targetOldValue: null,
              targetNewValue: b.precoPor,
              status: entry === undefined ? 'failed' : 'mismatch',
              errorMessage: `Wake aceitou a chamada sem erro, mas a reconferencia da Tabela de Preco nao confirmou -- ${detail}`,
            })
          }
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

async function syncStock(
  syncRunId: number,
  products: ManagedProduct[],
  dryRun: boolean,
  stockByProduct: Map<string, CissStockRow>,
  packageConfigs: Map<number, { quantityPerSaleUnit: number }>,
  commercialPolicyConfig: CommercialPolicyConfig,
) {
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

  // BLOQUEIO E (FASE B.2): status explicito e fail-closed pra "CISS
  // respondeu OK mas nunca teve linha de estoque pra este produto" --
  // distinto de UNSUPPORTED_UNIT/CONFIGURATION_REQUIRED (que sao problema de
  // UNIT, nao de ausencia de registro) e nunca tratado como estoque zero
  // silencioso. Antes desta correcao, `noRecord` so alimentava um aviso
  // (`note`) num ramo que exige stockResult.ok=true -- mas noRecord=true
  // sempre forca unitRaw=null (ver ciss/stock.ts), que o UnitResolver
  // sempre resolve como falha, entao esse ramo nunca era alcancado: o aviso
  // ficava morto e o operador so via "UNIT nao processavel (UNSUPPORTED_UNIT)
  // -- unit_raw=null", indistinguivel de uma UNIT desconhecida de verdade.
  const NO_RECORD_NOTE = 'Sem registro de estoque no ERP (CISS OK, nenhuma linha em ESTOQUE_SALDO_ATUAL para este produto) -- fail-closed, nada escrito no Wake'

  const toApply: Array<{
    product: ManagedProduct
    targetStock: number
    sourceOldValue: number | null
    sourceNewValue: number
    targetOldValue: number | null
  }> = []

  for (const product of products) {
    const row = stockByProduct.get(product.cissProductId)
    const erpStock = row?.stock
    if (erpStock === undefined) {
      failed++
      await logItem({ syncRunId, managedProductId: product.id, field: 'stock', status: 'failed', errorMessage: `Sem leitura de estoque CISS para ciss_product_id=${product.cissProductId}` })
      continue
    }

    if (row?.noRecord) {
      failed++
      await upsertState(product.id, {
        erpStock,
        erpReadAt: new Date().toISOString(),
        unitRaw: null,
        unitNormalized: null,
        unitClass: null,
        unitResolutionStatus: 'NO_STOCK_RECORD',
      })
      await logItem({
        syncRunId,
        managedProductId: product.id,
        field: 'stock',
        sourceOldValue: null,
        sourceNewValue: erpStock,
        status: 'failed',
        errorMessage: NO_RECORD_NOTE,
      })
      continue
    }

    const unitRaw = row?.unitRaw ?? null
    const packageConfig = packageConfigs.get(product.id) ?? null
    const stockResult = calculateUnitStock({ unitRaw, cissStock: erpStock, packageConfig, commercialPolicyConfig })

    if (!stockResult.ok) {
      // Mesma logica de syncPrices(): UNIT nao suportada/config faltando ->
      // 'failed' visivel, zero escrita no Wake (ver §1/§5).
      failed++
      await upsertState(product.id, {
        erpStock,
        erpReadAt: new Date().toISOString(),
        unitRaw: stockResult.unitRaw,
        unitNormalized: stockResult.unitNormalized,
        unitClass: null,
        unitResolutionStatus: stockResult.reason,
      })
      await logItem({
        syncRunId,
        managedProductId: product.id,
        field: 'stock',
        sourceOldValue: null,
        sourceNewValue: erpStock,
        status: 'failed',
        errorMessage: `UNIT nao processavel (${stockResult.reason}${stockResult.detail ? `: ${stockResult.detail}` : ''}) -- unit_raw=${stockResult.unitRaw ?? 'null'}`,
      })
      continue
    }

    const unitFields = {
      unitRaw: stockResult.unitRaw,
      unitNormalized: stockResult.unitNormalized,
      unitClass: stockResult.unitClass,
      unitResolutionStatus: 'OK' as const,
    }

    const state = await getState(product.id)
    const stockUnchanged = state?.lastAppliedWakeStock === stockResult.targetWakeStock

    if (stockUnchanged) {
      skipped++
      await logItem({ syncRunId, managedProductId: product.id, field: 'stock', sourceOldValue: state?.erpStock ?? null, sourceNewValue: erpStock, targetOldValue: state?.lastAppliedWakeStock ?? null, targetNewValue: stockResult.targetWakeStock, status: 'no_change' })
      continue
    }

    changed++
    const sourceOldValue = state?.erpStock ?? null
    const targetOldValue = state?.lastAppliedWakeStock ?? null

    if (dryRun) {
      await logItem({ syncRunId, managedProductId: product.id, field: 'stock', sourceOldValue, sourceNewValue: erpStock, targetOldValue, targetNewValue: stockResult.targetWakeStock, status: 'planned' })
    }
    // fora de dry-run o log so acontece depois da reconferencia, la embaixo.

    await upsertState(product.id, { erpStock, erpReadAt: new Date().toISOString(), calculatedWakeStock: stockResult.targetWakeStock, ...unitFields })

    if (!dryRun) toApply.push({ product, targetStock: stockResult.targetWakeStock, sourceOldValue, sourceNewValue: erpStock, targetOldValue })
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
