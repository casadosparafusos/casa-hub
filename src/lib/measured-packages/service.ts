import 'server-only'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '@/lib/db'
import { fetchStockForProducts } from '@/lib/ciss/stock'
import { stockSource } from '@/lib/settings'
import { MeasuredPackageError, MeasuredPackageInfraError, type ConfigWithProduct, type PendingProduct, type PackageSourceUnit } from './types'

/**
 * Resolve o UNIT real de um produto no CISS (fonte de verdade -- nunca
 * inferido por nome/categoria, ver FASE E §4). Lanca MeasuredPackageInfraError
 * se a chamada ao CISS falhar (rede/5xx/token) -- essa falha NUNCA vira
 * "UNIT invalido", precisa abortar a operacao inteira.
 */
async function resolveCissUnit(cissProductId: string): Promise<string | null> {
  const enterprise = await stockSource.enterprise()
  const location = await stockSource.location()
  let rows: Awaited<ReturnType<typeof fetchStockForProducts>>
  try {
    rows = await fetchStockForProducts([cissProductId], { enterprise, location })
  } catch (err) {
    throw new MeasuredPackageInfraError(`Falha ao consultar UNIT no CISS: ${err instanceof Error ? err.message : String(err)}`)
  }
  const row = rows[0]
  if (!row || row.noRecord || !row.unitRaw) return null
  return row.unitRaw.trim().toUpperCase()
}

function toConfigWithProduct(
  config: typeof schema.productSaleUnitConfig.$inferSelect,
  product: typeof schema.managedProducts.$inferSelect,
): ConfigWithProduct {
  return {
    id: config.id,
    managedProductId: config.managedProductId,
    wakeSku: product.wakeSku,
    wakeProductName: product.wakeProductName,
    cissProductId: product.cissProductId,
    sourceUnit: config.sourceUnit as PackageSourceUnit,
    quantityPerSaleUnit: config.quantityPerSaleUnit,
    active: config.active,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
    updatedBy: config.updatedBy,
  }
}

export async function listConfigs(): Promise<ConfigWithProduct[]> {
  const rows = await db
    .select({ config: schema.productSaleUnitConfig, product: schema.managedProducts })
    .from(schema.productSaleUnitConfig)
    .innerJoin(schema.managedProducts, eq(schema.managedProducts.id, schema.productSaleUnitConfig.managedProductId))
    .orderBy(desc(schema.productSaleUnitConfig.updatedAt))
  return rows.map((r) => toConfigWithProduct(r.config, r.product))
}

export async function listPendingProducts(): Promise<PendingProduct[]> {
  const rows = await db
    .select({
      managedProductId: schema.managedProducts.id,
      wakeSku: schema.managedProducts.wakeSku,
      wakeProductName: schema.managedProducts.wakeProductName,
      cissProductId: schema.managedProducts.cissProductId,
      unitNormalized: schema.syncProductState.unitNormalized,
    })
    .from(schema.managedProducts)
    .innerJoin(schema.syncProductState, eq(schema.syncProductState.managedProductId, schema.managedProducts.id))
    .leftJoin(
      schema.productSaleUnitConfig,
      and(eq(schema.productSaleUnitConfig.managedProductId, schema.managedProducts.id), eq(schema.productSaleUnitConfig.active, true)),
    )
    .where(
      and(
        eq(schema.managedProducts.active, true),
        inArray(schema.syncProductState.unitNormalized, ['KG', 'MT']),
        isNull(schema.productSaleUnitConfig.id),
      ),
    )
  return rows.map((r) => ({
    managedProductId: r.managedProductId,
    wakeSku: r.wakeSku,
    wakeProductName: r.wakeProductName,
    cissProductId: r.cissProductId,
    unitNormalized: r.unitNormalized as PackageSourceUnit,
  }))
}

// better-sqlite3 e sincrono por baixo dos panos -- drizzle so suporta
// callback SINCRONO em db.transaction() para este driver (await dentro do
// callback faz o commit nativo disparar antes do corpo terminar, perdendo
// atomicidade). Por isso os helpers de escrita abaixo usam .run()/.get()
// direto, nunca await, e sao chamados de dentro de callbacks sincronos.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

function recordEvent(
  tx: Tx,
  input: {
    managedProductId: number
    action: 'CREATE' | 'UPDATE' | 'DEACTIVATE' | 'REACTIVATE'
    sourceUnit: PackageSourceUnit
    oldQuantityPerSaleUnit: number | null
    newQuantityPerSaleUnit: number | null
    actor: string
    origin: 'MANUAL' | 'IMPORT'
    filename?: string | null
  },
) {
  tx.insert(schema.productSaleUnitConfigEvents)
    .values({
      managedProductId: input.managedProductId,
      action: input.action,
      sourceUnit: input.sourceUnit,
      oldQuantityPerSaleUnit: input.oldQuantityPerSaleUnit,
      newQuantityPerSaleUnit: input.newQuantityPerSaleUnit,
      actor: input.actor,
      origin: input.origin,
      filename: input.filename ?? null,
    })
    .run()
}

/**
 * Cadastro/edicao manual por SKU (FASE E §4). O usuario informa so SKU +
 * quantidade -- o UNIT NUNCA vem do formulario, e sempre resolvido ao vivo
 * no CISS. Cria uma config nova ou atualiza a ativa existente in place.
 */
export async function upsertBySku(input: { sku: string; quantity: number; actor: string }): Promise<ConfigWithProduct> {
  const sku = input.sku.trim()
  if (!sku) throw new MeasuredPackageError('Informe o SKU do produto.')
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
    throw new MeasuredPackageError('Quantidade por unidade vendável precisa ser um número maior que zero.')
  }

  const [product] = await db.select().from(schema.managedProducts).where(eq(schema.managedProducts.wakeSku, sku)).limit(1)
  if (!product) throw new MeasuredPackageError(`SKU "${sku}" não encontrado na whitelist de produtos administrados.`)
  if (!product.active) throw new MeasuredPackageError(`SKU "${sku}" está inativo na whitelist -- ative o produto antes de configurar embalagem.`)

  const unitNormalized = await resolveCissUnit(product.cissProductId)
  if (!unitNormalized) throw new MeasuredPackageError(`CISS não retornou UNIT para o SKU "${sku}". Nenhuma configuração foi gravada.`)
  if (unitNormalized !== 'KG' && unitNormalized !== 'MT') {
    throw new MeasuredPackageError(
      `O SKU "${sku}" está cadastrado como ${unitNormalized} no CISS. Esta funcionalidade aceita somente produtos com UNIT KG ou MT. Nenhuma configuração foi gravada.`,
    )
  }

  const [existing] = await db
    .select()
    .from(schema.productSaleUnitConfig)
    .where(and(eq(schema.productSaleUnitConfig.managedProductId, product.id), eq(schema.productSaleUnitConfig.active, true)))
    .limit(1)

  if (existing && existing.sourceUnit === unitNormalized && existing.quantityPerSaleUnit === input.quantity) {
    return toConfigWithProduct(existing, product)
  }

  return db.transaction((tx) => {
    if (existing) {
      const updated = tx
        .update(schema.productSaleUnitConfig)
        .set({
          sourceUnit: unitNormalized,
          quantityPerSaleUnit: input.quantity,
          updatedBy: input.actor,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.productSaleUnitConfig.id, existing.id))
        .returning()
        .get()
      recordEvent(tx, {
        managedProductId: product.id,
        action: 'UPDATE',
        sourceUnit: unitNormalized,
        oldQuantityPerSaleUnit: existing.quantityPerSaleUnit,
        newQuantityPerSaleUnit: input.quantity,
        actor: input.actor,
        origin: 'MANUAL',
      })
      return toConfigWithProduct(updated, product)
    }

    const created = tx
      .insert(schema.productSaleUnitConfig)
      .values({
        managedProductId: product.id,
        sourceUnit: unitNormalized,
        quantityPerSaleUnit: input.quantity,
        active: true,
        updatedBy: input.actor,
      })
      .returning()
      .get()
    recordEvent(tx, {
      managedProductId: product.id,
      action: 'CREATE',
      sourceUnit: unitNormalized,
      oldQuantityPerSaleUnit: null,
      newQuantityPerSaleUnit: input.quantity,
      actor: input.actor,
      origin: 'MANUAL',
    })
    return toConfigWithProduct(created, product)
  })
}

export async function deactivateConfig(configId: number, actor: string): Promise<void> {
  const [existing] = await db.select().from(schema.productSaleUnitConfig).where(eq(schema.productSaleUnitConfig.id, configId)).limit(1)
  if (!existing) throw new MeasuredPackageError('Configuração não encontrada.')
  if (!existing.active) throw new MeasuredPackageError('Esta configuração já está inativa.')

  db.transaction((tx) => {
    tx.update(schema.productSaleUnitConfig)
      .set({ active: false, updatedBy: actor, updatedAt: new Date().toISOString() })
      .where(eq(schema.productSaleUnitConfig.id, configId))
      .run()
    recordEvent(tx, {
      managedProductId: existing.managedProductId,
      action: 'DEACTIVATE',
      sourceUnit: existing.sourceUnit as PackageSourceUnit,
      oldQuantityPerSaleUnit: existing.quantityPerSaleUnit,
      newQuantityPerSaleUnit: null,
      actor,
      origin: 'MANUAL',
    })
  })
}

export async function reactivateConfig(configId: number, actor: string): Promise<ConfigWithProduct> {
  const [existing] = await db.select().from(schema.productSaleUnitConfig).where(eq(schema.productSaleUnitConfig.id, configId)).limit(1)
  if (!existing) throw new MeasuredPackageError('Configuração não encontrada.')
  if (existing.active) throw new MeasuredPackageError('Esta configuração já está ativa.')

  const [product] = await db.select().from(schema.managedProducts).where(eq(schema.managedProducts.id, existing.managedProductId)).limit(1)
  if (!product) throw new MeasuredPackageError('Produto administrado não encontrado.')

  const [otherActive] = await db
    .select()
    .from(schema.productSaleUnitConfig)
    .where(and(eq(schema.productSaleUnitConfig.managedProductId, existing.managedProductId), eq(schema.productSaleUnitConfig.active, true)))
    .limit(1)
  if (otherActive) throw new MeasuredPackageError('Já existe uma configuração ativa para este produto -- desative-a antes de reativar esta.')

  return db.transaction((tx) => {
    const reactivated = tx
      .update(schema.productSaleUnitConfig)
      .set({ active: true, updatedBy: actor, updatedAt: new Date().toISOString() })
      .where(eq(schema.productSaleUnitConfig.id, configId))
      .returning()
      .get()
    recordEvent(tx, {
      managedProductId: existing.managedProductId,
      action: 'REACTIVATE',
      sourceUnit: existing.sourceUnit as PackageSourceUnit,
      oldQuantityPerSaleUnit: null,
      newQuantityPerSaleUnit: existing.quantityPerSaleUnit,
      actor,
      origin: 'MANUAL',
    })
    return toConfigWithProduct(reactivated, product)
  })
}
