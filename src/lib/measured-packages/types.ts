// Tipos compartilhados da area "Embalagens KG/MT" (FASE E). O motor
// matematico (src/lib/units) e a tabela product_sale_unit_config ja
// existem -- este modulo so cobre CRUD manual + import por planilha em
// cima deles, nunca duplica a formula.

export type PackageSourceUnit = 'KG' | 'MT'

export type ConfigAction = 'CREATE' | 'UPDATE' | 'DEACTIVATE' | 'REACTIVATE'

export type ConfigOrigin = 'MANUAL' | 'IMPORT'

export interface ConfigWithProduct {
  id: number
  managedProductId: number
  wakeSku: string
  wakeProductName: string | null
  cissProductId: string
  sourceUnit: PackageSourceUnit
  quantityPerSaleUnit: number
  active: boolean
  createdAt: string
  updatedAt: string
  updatedBy: string | null
}

export interface PendingProduct {
  managedProductId: number
  wakeSku: string
  wakeProductName: string | null
  cissProductId: string
  unitNormalized: PackageSourceUnit
}

export class MeasuredPackageError extends Error {}

/** Falha de infraestrutura (CISS fora do ar/timeout/token) -- nunca deve virar erro de linha. */
export class MeasuredPackageInfraError extends Error {}

export type ImportRowAction = 'CREATE' | 'UPDATE' | 'NOOP' | 'ERROR'

export interface RawImportRow {
  line: number
  sheet: string
  sku: string
  nameFromFile: string | null
  sourceUnit: PackageSourceUnit
  quantity: number | null
  parseError: string | null
}

export interface ValidatedImportRow {
  line: number
  sheet: string
  sku: string
  nameFromFile: string | null
  managedProductId: number | null
  managedProductName: string | null
  cissProductId: string | null
  detectedUnit: string | null
  sourceUnit: PackageSourceUnit
  quantityPerSaleUnit: number | null
  action: ImportRowAction
  status: 'valid' | 'warning' | 'error'
  message: string | null
}

export interface ImportValidationResult {
  rows: ValidatedImportRow[]
  totalRows: number
  createCount: number
  updateCount: number
  noopCount: number
  errorCount: number
}

export interface ImportApplyResult extends ImportValidationResult {
  status: 'success' | 'partial' | 'failed'
  appliedCount: number
}
