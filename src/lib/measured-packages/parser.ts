import 'server-only'
import { parse } from 'csv-parse/sync'
import ExcelJS from 'exceljs'
import type { PackageSourceUnit, RawImportRow } from './types'
import { MeasuredPackageError } from './types'

export const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_ROWS = 5000

function normalizeHeader(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toUpperCase()
}

function parseQuantity(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const normalized = trimmed.includes(',') && !trimmed.includes('.') ? trimmed.replace(',', '.') : trimmed
  if (!/^-?\d+([.,]\d+)?$/.test(trimmed) && !/^-?\d+(\.\d+)?$/.test(normalized)) return null
  const n = Number(normalized)
  if (!Number.isFinite(n)) return null
  return n
}

// Tech Lead review PR #5, achado #4: cabecalho com AMBAS as colunas "QT KG"
// e "QT MT" e ambiguo (arquivo bagunçado/gerado errado) -- fail-closed,
// nunca escolhe uma das duas silenciosamente.
type UnitColumnResult = { kind: 'ok'; unit: PackageSourceUnit; index: number } | { kind: 'ambiguous' } | { kind: 'missing' }

function detectUnitColumn(headers: string[]): UnitColumnResult {
  const kgIdx = headers.indexOf('QT KG')
  const mtIdx = headers.indexOf('QT MT')
  if (kgIdx >= 0 && mtIdx >= 0) return { kind: 'ambiguous' }
  if (kgIdx >= 0) return { kind: 'ok', unit: 'KG', index: kgIdx }
  if (mtIdx >= 0) return { kind: 'ok', unit: 'MT', index: mtIdx }
  return { kind: 'missing' }
}

// Tech Lead review PR #5, achado #3: `line.split(delimiter)` nao e CSV real
// -- quebra em qualquer campo entre aspas (nome com virgula, quantidade com
// virgula decimal). csv-parse/sync implementa RFC4180 (aspas, aspas
// escapadas "", multi-linha dentro de campo). O delimitador ainda e
// detectado pela primeira linha (falta de sniffing melhor no csv-parse
// para , vs ;), igual antes.
function parseDelimitedTable(text: string): string[][] {
  const clean = text.replace(/^﻿/, '')
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? ''
  const semicolons = (firstLine.match(/;/g) ?? []).length
  const commas = (firstLine.match(/,/g) ?? []).length
  const delimiter = semicolons > commas ? ';' : ','

  const records = parse(clean, {
    bom: true,
    delimiter,
    trim: true,
    skip_empty_lines: true,
    relax_column_count: true,
  }) as string[][]
  return records
}

export function parseCsv(content: string): RawImportRow[] {
  const table = parseDelimitedTable(content)
  if (table.length === 0) throw new MeasuredPackageError('Arquivo vazio.')

  const headers = table[0]!.map(normalizeHeader)
  const skuIdx = headers.indexOf('SKU')
  const nomeIdx = headers.indexOf('NOME')
  const unitCol = detectUnitColumn(headers)
  if (unitCol.kind === 'ambiguous') {
    throw new MeasuredPackageError('Cabeçalho ambíguo -- a planilha tem as colunas "QT KG" e "QT MT" ao mesmo tempo. Envie apenas uma delas por arquivo.')
  }
  if (skuIdx < 0 || unitCol.kind === 'missing') {
    throw new MeasuredPackageError('Cabeçalho inválido -- esperado ao menos as colunas "SKU" e "QT KG" ou "QT MT".')
  }

  const dataRows = table.slice(1)
  if (dataRows.length > MAX_ROWS) throw new MeasuredPackageError(`Arquivo excede o limite de ${MAX_ROWS} linhas.`)

  return dataRows.map((cells, i) => {
    const sku = (cells[skuIdx] ?? '').trim()
    const nameFromFile = nomeIdx >= 0 ? (cells[nomeIdx] ?? '').trim() || null : null
    const quantityRaw = (cells[unitCol.index] ?? '').trim()
    const quantity = parseQuantity(quantityRaw)
    return {
      line: i + 2,
      sheet: 'CSV',
      sku,
      nameFromFile,
      sourceUnit: unitCol.unit,
      quantity,
      parseError: sku === '' ? 'SKU vazio.' : quantity === null ? `Quantidade inválida: "${quantityRaw}".` : null,
    }
  })
}

function isFormulaCell(cell: ExcelJS.Cell): boolean {
  return cell.type === ExcelJS.ValueType.Formula
}

export async function parseXlsx(buffer: Buffer): Promise<RawImportRow[]> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer)

  const rows: RawImportRow[] = []

  for (const worksheet of workbook.worksheets) {
    const headerRow = worksheet.getRow(1)
    const headers: string[] = []
    headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      headers[colNumber - 1] = normalizeHeader(String(cell.text ?? cell.value ?? ''))
    })
    const skuIdx = headers.indexOf('SKU')
    const nomeIdx = headers.indexOf('NOME')
    const unitCol = detectUnitColumn(headers)
    // Tech Lead review PR #5, achado #4: aba com coluna SKU + as DUAS
    // colunas QT KG/QT MT e ambigua -- bloqueio explicito, nunca escolhe
    // uma silenciosamente. Aba sem SKU (aux/instrucoes) continua ignorada
    // mesmo se por acaso tiver ambas as colunas de quantidade.
    if (skuIdx >= 0 && unitCol.kind === 'ambiguous') {
      throw new MeasuredPackageError(
        `Aba "${worksheet.name}": cabeçalho ambíguo -- tem as colunas "QT KG" e "QT MT" ao mesmo tempo. Envie apenas uma delas por aba.`,
      )
    }
    // Aba sem o cabecalho esperado e ignorada (pode ser aba auxiliar/instrucoes) --
    // nunca usa o NOME da aba pra decidir UNIT (§8).
    if (skuIdx < 0 || unitCol.kind !== 'ok') continue

    const lastRow = worksheet.rowCount
    for (let r = 2; r <= lastRow; r++) {
      const row = worksheet.getRow(r)
      if (row.cellCount === 0) continue

      const skuCell = row.getCell(skuIdx + 1)
      const qtyCell = row.getCell(unitCol.index + 1)
      const nomeCell = nomeIdx >= 0 ? row.getCell(nomeIdx + 1) : null
      const nameFromFile = nomeCell ? String(nomeCell.text ?? '').trim() || null : null

      if (isFormulaCell(skuCell) || isFormulaCell(qtyCell)) {
        rows.push({
          line: r,
          sheet: worksheet.name,
          sku: String(skuCell.text ?? '').trim(),
          nameFromFile,
          sourceUnit: unitCol.unit,
          quantity: null,
          parseError: 'Célula com fórmula não é aceita -- use valor literal.',
        })
        continue
      }

      const sku = String(skuCell.text ?? skuCell.value ?? '').trim()
      const quantityRaw = String(qtyCell.text ?? qtyCell.value ?? '').trim()
      if (sku === '' && quantityRaw === '') continue // linha em branco, ignorada

      const quantity = parseQuantity(quantityRaw)
      rows.push({
        line: r,
        sheet: worksheet.name,
        sku,
        nameFromFile,
        sourceUnit: unitCol.unit,
        quantity,
        parseError: sku === '' ? 'SKU vazio.' : quantity === null ? `Quantidade inválida: "${quantityRaw}".` : null,
      })
    }
  }

  if (rows.length === 0) {
    throw new MeasuredPackageError('Nenhuma aba com cabeçalho "SKU" + "QT KG"/"QT MT" foi encontrada no arquivo.')
  }
  if (rows.length > MAX_ROWS) throw new MeasuredPackageError(`Arquivo excede o limite de ${MAX_ROWS} linhas.`)
  return rows
}

export async function parseImportFile(buffer: Buffer, filename: string): Promise<RawImportRow[]> {
  if (buffer.length === 0) throw new MeasuredPackageError('Arquivo vazio.')
  if (buffer.length > MAX_FILE_BYTES) throw new MeasuredPackageError('Arquivo excede o limite de 5MB.')

  const lower = filename.toLowerCase()
  if (lower.endsWith('.csv')) return parseCsv(buffer.toString('utf-8'))
  if (lower.endsWith('.xlsx')) return parseXlsx(buffer)
  throw new MeasuredPackageError('Formato não suportado -- envie um arquivo .xlsx ou .csv.')
}
