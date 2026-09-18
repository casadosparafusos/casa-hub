import 'server-only'
import { and, eq, inArray } from 'drizzle-orm'
import { db, schema } from '@/lib/db'
import { fetchStockForProducts, type CissStockRow } from '@/lib/ciss/stock'
import { stockSource } from '@/lib/settings'
import { MeasuredPackageInfraError } from './types'
import type { ImportApplyResult, ImportValidationResult, PackageSourceUnit, RawImportRow, ValidatedImportRow } from './types'

function summarize(rows: ValidatedImportRow[]): ImportValidationResult {
  return {
    rows,
    totalRows: rows.length,
    createCount: rows.filter((r) => r.action === 'CREATE').length,
    updateCount: rows.filter((r) => r.action === 'UPDATE').length,
    noopCount: rows.filter((r) => r.action === 'NOOP').length,
    errorCount: rows.filter((r) => r.action === 'ERROR').length,
  }
}

/**
 * Valida as linhas ja parseadas do arquivo contra a whitelist + CISS ao
 * vivo (FASE E §10). Usada tanto no preview (mode=preview, zero write)
 * quanto reexecutada por completo no apply (nunca confia no JSON do
 * preview, ver §11). Se a consulta ao CISS falhar (rede/5xx/token), aborta
 * com MeasuredPackageInfraError -- nunca vira erro de linha nem assume UNIT.
 */
export async function validateImportRows(rows: RawImportRow[]): Promise<ImportValidationResult> {
  const skuCounts = new Map<string, number>()
  for (const r of rows) {
    if (r.sku) skuCounts.set(r.sku, (skuCounts.get(r.sku) ?? 0) + 1)
  }

  const candidateSkus = [...new Set(rows.filter((r) => !r.parseError && r.sku && (skuCounts.get(r.sku) ?? 0) === 1).map((r) => r.sku))]

  const managedRows = candidateSkus.length
    ? await db.select().from(schema.managedProducts).where(inArray(schema.managedProducts.wakeSku, candidateSkus))
    : []
  const managedBySku = new Map(managedRows.map((m) => [m.wakeSku, m]))

  const cissIdsToQuery = [...new Set(managedRows.filter((m) => m.active).map((m) => m.cissProductId))]
  const enterprise = await stockSource.enterprise()
  const location = await stockSource.location()

  let stockRows: CissStockRow[]
  try {
    stockRows = cissIdsToQuery.length ? await fetchStockForProducts(cissIdsToQuery, { enterprise, location }) : []
  } catch (err) {
    throw new MeasuredPackageInfraError(`Falha ao consultar estoque/UNIT no CISS: ${err instanceof Error ? err.message : String(err)}`)
  }
  const stockByCissId = new Map(stockRows.map((s) => [s.productId, s]))

  const managedIds = managedRows.map((m) => m.id)
  const existingConfigs = managedIds.length
    ? await db
        .select()
        .from(schema.productSaleUnitConfig)
        .where(and(inArray(schema.productSaleUnitConfig.managedProductId, managedIds), eq(schema.productSaleUnitConfig.active, true)))
    : []
  const existingByManagedId = new Map(existingConfigs.map((c) => [c.managedProductId, c]))

  const validated: ValidatedImportRow[] = rows.map((r) => {
    const base = { line: r.line, sku: r.sku, nameFromFile: r.nameFromFile, sourceUnit: r.sourceUnit }
    const errorRow = (message: string, extra: Partial<ValidatedImportRow> = {}): ValidatedImportRow => ({
      ...base,
      managedProductId: null,
      managedProductName: null,
      cissProductId: null,
      detectedUnit: null,
      quantityPerSaleUnit: null,
      action: 'ERROR',
      status: 'error',
      message,
      ...extra,
    })

    if (r.parseError) return errorRow(r.parseError)
    if ((skuCounts.get(r.sku) ?? 0) > 1) return errorRow(`SKU duplicado no arquivo (aparece ${skuCounts.get(r.sku)}x).`)

    const managed = managedBySku.get(r.sku)
    if (!managed) return errorRow(`SKU "${r.sku}" não encontrado na whitelist de produtos administrados.`)
    if (!managed.active) {
      return errorRow(`SKU "${r.sku}" está inativo na whitelist.`, {
        managedProductId: managed.id,
        managedProductName: managed.wakeProductName,
        cissProductId: managed.cissProductId,
      })
    }

    const stock = stockByCissId.get(managed.cissProductId)
    const unitNormalized = stock?.unitRaw ? stock.unitRaw.trim().toUpperCase() : null

    if (!unitNormalized) {
      return errorRow(`CISS não retornou UNIT para o SKU "${r.sku}". Nenhuma configuração foi gravada para esta linha.`, {
        managedProductId: managed.id,
        managedProductName: managed.wakeProductName,
        cissProductId: managed.cissProductId,
      })
    }
    if (unitNormalized !== r.sourceUnit) {
      return errorRow(
        `O SKU "${r.sku}" está cadastrado como ${unitNormalized} no CISS. Esta planilha aceita somente produtos com UNIT ${r.sourceUnit}. Nenhuma configuração foi gravada para esta linha.`,
        { managedProductId: managed.id, managedProductName: managed.wakeProductName, cissProductId: managed.cissProductId, detectedUnit: unitNormalized },
      )
    }
    if (r.quantity === null || r.quantity <= 0) {
      return errorRow('Quantidade inválida -- precisa ser um número maior que zero.', {
        managedProductId: managed.id,
        managedProductName: managed.wakeProductName,
        cissProductId: managed.cissProductId,
        detectedUnit: unitNormalized,
      })
    }

    const existing = existingByManagedId.get(managed.id)
    const commonValid = {
      ...base,
      managedProductId: managed.id,
      managedProductName: managed.wakeProductName,
      cissProductId: managed.cissProductId,
      detectedUnit: unitNormalized,
      quantityPerSaleUnit: r.quantity,
    }

    if (existing && existing.sourceUnit === r.sourceUnit && existing.quantityPerSaleUnit === r.quantity) {
      return { ...commonValid, action: 'NOOP', status: 'warning', message: 'Sem mudança -- configuração já está com este valor.' }
    }
    const action = existing ? 'UPDATE' : 'CREATE'
    return { ...commonValid, action, status: 'valid', message: null }
  })

  return summarize(validated)
}

/**
 * Reexecuta a validacao completa (nunca confia no preview enviado pelo
 * cliente, §11) e grava apenas as linhas CREATE/UPDATE, dentro de uma
 * transacao. NOOP nao escreve nada; ERROR e pulada. Grava um evento de
 * auditoria por linha aplicada (origin=IMPORT).
 */
export async function applyImport(rows: RawImportRow[], opts: { actor: string; filename: string }): Promise<ImportApplyResult> {
  const validation = await validateImportRows(rows)
  const writable = validation.rows.filter((r) => (r.action === 'CREATE' || r.action === 'UPDATE') && r.managedProductId && r.quantityPerSaleUnit)

  if (writable.length === 0) {
    const status = validation.errorCount > 0 ? 'failed' : 'success'
    return { ...validation, status, appliedCount: 0 }
  }

  const managedIds = writable.map((r) => r.managedProductId as number)
  const existingConfigs = await db
    .select()
    .from(schema.productSaleUnitConfig)
    .where(and(inArray(schema.productSaleUnitConfig.managedProductId, managedIds), eq(schema.productSaleUnitConfig.active, true)))
  const existingByManagedId = new Map(existingConfigs.map((c) => [c.managedProductId, c]))

  let appliedCount = 0
  db.transaction((tx) => {
    for (const row of writable) {
      const managedProductId = row.managedProductId as number
      const quantity = row.quantityPerSaleUnit as number
      const sourceUnit = row.sourceUnit as PackageSourceUnit
      const existing = existingByManagedId.get(managedProductId)

      if (existing) {
        tx.update(schema.productSaleUnitConfig)
          .set({ sourceUnit, quantityPerSaleUnit: quantity, updatedBy: opts.actor, updatedAt: new Date().toISOString() })
          .where(eq(schema.productSaleUnitConfig.id, existing.id))
          .run()
        tx.insert(schema.productSaleUnitConfigEvents)
          .values({
            managedProductId,
            action: 'UPDATE',
            sourceUnit,
            oldQuantityPerSaleUnit: existing.quantityPerSaleUnit,
            newQuantityPerSaleUnit: quantity,
            actor: opts.actor,
            origin: 'IMPORT',
            filename: opts.filename,
          })
          .run()
      } else {
        tx.insert(schema.productSaleUnitConfig)
          .values({ managedProductId, sourceUnit, quantityPerSaleUnit: quantity, active: true, updatedBy: opts.actor })
          .run()
        tx.insert(schema.productSaleUnitConfigEvents)
          .values({
            managedProductId,
            action: 'CREATE',
            sourceUnit,
            oldQuantityPerSaleUnit: null,
            newQuantityPerSaleUnit: quantity,
            actor: opts.actor,
            origin: 'IMPORT',
            filename: opts.filename,
          })
          .run()
      }
      appliedCount += 1
    }
  })

  const status: ImportApplyResult['status'] = validation.errorCount === 0 ? 'success' : appliedCount > 0 ? 'partial' : 'failed'
  return { ...validation, status, appliedCount }
}
