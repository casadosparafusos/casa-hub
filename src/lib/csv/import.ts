import 'server-only'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db'
import { getWakeProductBySku, WakeClientError } from '../wake/client'

// Importador do CSV de whitelist: ciss_product_id,wake_sku,active. So 2
// colunas de dado + active -- o wake_product_variant_id (exigido pela API
// de estoque do Wake, ver src/lib/sync/engine.ts) e resolvido sozinho aqui,
// por linha, via GET /produtos/{sku}?tipoIdentificador=sku (confirmado ao
// vivo em 08/09/2026 -- ver getWakeProductBySku em src/lib/wake/client.ts).
// Usuario nao precisa mais descobrir/colar o variant_id na mao: so precisa
// saber o SKU (visivel no admin do Wake, dentro da variante do produto) e o
// ID do CISS (idsubproduto).
//
// Regra: nunca desativa/remove produto silenciosamente. Uma linha ausente
// no CSV de uma nova importacao NAO desativa o produto existente -- so
// active=0 explicito na propria linha desativa. Import e sempre
// aditivo/atualizador, nunca substitutivo.

const rowSchema = z.object({
  ciss_product_id: z.string().trim().min(1),
  wake_sku: z.string().trim().min(1),
  active: z
    .string()
    .trim()
    .transform((v) => v.toLowerCase())
    .pipe(z.enum(['1', '0', 'true', 'false', 'sim', 'nao', 'não']))
    .transform((v) => v === '1' || v === 'true' || v === 'sim'),
})

export interface ImportRowError {
  line: number
  raw: string
  error: string
}

export interface ImportResult {
  importId: number
  totalRows: number
  createdRows: number
  updatedRows: number
  errorRows: ImportRowError[]
  status: 'success' | 'partial' | 'failed'
}

function parseCsv(content: string): string[][] {
  // parser simples -- sem aspas/escapes complexos, suficiente pro formato
  // fixo de 3 colunas exigido pela especificacao. Se o CSV real vier de
  // Excel com separador ';' ou aspas, ajustar aqui quando o arquivo real
  // chegar.
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(',').map((cell) => cell.trim()))
}

export async function importWhitelistCsv(content: string, filename: string, importedBy?: string): Promise<ImportResult> {
  const rows = parseCsv(content)
  if (rows.length === 0) {
    throw new Error('CSV vazio')
  }

  const header = rows[0]!.map((h) => h.toLowerCase())
  const expectedHeader = ['ciss_product_id', 'wake_sku', 'active']
  const hasHeader = expectedHeader.every((col) => header.includes(col))
  const dataRows = hasHeader ? rows.slice(1) : rows

  const colIndex = hasHeader
    ? {
        cissProductId: header.indexOf('ciss_product_id'),
        wakeSku: header.indexOf('wake_sku'),
        active: header.indexOf('active'),
      }
    : { cissProductId: 0, wakeSku: 1, active: 2 }

  const errors: ImportRowError[] = []
  let created = 0
  let updated = 0

  const [importRow] = await db
    .insert(schema.imports)
    .values({ filename, importedBy, status: 'partial', totalRows: dataRows.length })
    .returning()
  if (!importRow) throw new Error('Falha ao registrar import')

  for (let i = 0; i < dataRows.length; i++) {
    const line = i + (hasHeader ? 2 : 1)
    const raw = dataRows[i]!
    const parsed = rowSchema.safeParse({
      ciss_product_id: raw[colIndex.cissProductId] ?? '',
      wake_sku: raw[colIndex.wakeSku] ?? '',
      active: raw[colIndex.active] ?? '',
    })

    if (!parsed.success) {
      errors.push({ line, raw: raw.join(','), error: parsed.error.issues.map((iss) => iss.message).join('; ') })
      continue
    }

    const { ciss_product_id, wake_sku, active } = parsed.data

    // Resolve o produtoVarianteId sozinho a partir do SKU -- e a unica
    // informacao do Wake que o usuario nao digita mais. Uma linha cujo SKU
    // nao existe no Wake vira erro dessa linha, sem derrubar o import
    // inteiro (mesma logica de erro-por-linha usada pro resto do arquivo).
    let wakeVariantId: number
    let wakeProductName: string | null = null
    try {
      const product = await getWakeProductBySku(wake_sku)
      if (!product) {
        errors.push({ line, raw: raw.join(','), error: `SKU "${wake_sku}" não encontrado no Wake` })
        continue
      }
      wakeVariantId = product.produtoVarianteId
      wakeProductName = product.nome ?? null
    } catch (err) {
      const msg = err instanceof WakeClientError ? err.message : err instanceof Error ? err.message : String(err)
      errors.push({ line, raw: raw.join(','), error: `Falha ao consultar SKU "${wake_sku}" no Wake: ${msg}` })
      continue
    }

    const existing = await db
      .select()
      .from(schema.managedProducts)
      .where(eq(schema.managedProducts.cissProductId, ciss_product_id))
      .get()

    if (existing) {
      await db
        .update(schema.managedProducts)
        .set({
          wakeProductVariantId: String(wakeVariantId),
          wakeSku: wake_sku,
          wakeProductName,
          active,
          importId: importRow.id,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.managedProducts.id, existing.id))
      updated++
    } else {
      await db
        .insert(schema.managedProducts)
        .values({ cissProductId: ciss_product_id, wakeProductVariantId: String(wakeVariantId), wakeSku: wake_sku, wakeProductName, active, importId: importRow.id })
      created++
    }
  }

  const status: ImportResult['status'] = errors.length === 0 ? 'success' : created + updated > 0 ? 'partial' : 'failed'

  await db
    .update(schema.imports)
    .set({ createdRows: created, updatedRows: updated, errorRows: errors.length, errorDetail: errors.length ? JSON.stringify(errors) : null, status })
    .where(eq(schema.imports.id, importRow.id))

  return { importId: importRow.id, totalRows: dataRows.length, createdRows: created, updatedRows: updated, errorRows: errors, status }
}
