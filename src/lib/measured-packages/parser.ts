import 'server-only'
import ExcelJS from 'exceljs'
import type { PackageSourceUnit, RawImportRow } from './types'
import { MeasuredPackageError } from './types'

const MAX_FILE_BYTES = 5 * 1024 * 1024
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

function detectUnitColumn(headers: string[]): { unit: PackageSourceUnit; index: number } | null {
  const kgIdx = headers.indexOf('QT KG')
  if (kgIdx >= 0) return { unit: 'KG', index: kgIdx }
  const mtIdx = headers.indexOf('QT MT')
  if (mtIdx >= 0) return { unit: 'MT', index: mtIdx }
  return null
}

function splitDelimitedLine(line: string, delimiter: string): string[] {
  return line.split(delimiter).map((c) => c.trim())
}

function parseDelimitedTable(text: string): string[][] {
  const clean = text.replace(/^﻿/, '')
  const lines = clean.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length === 0) return []
  const headerLine = lines[0]!
  const semicolons = (headerLine.match(/;/g) ?? []).length
  const commas = (headerLine.match(/,/g) ?? []).length
  const delimiter = semicolons > commas ? ';' : ','
  return lines.map((line) => splitDelimitedLine(line, delimiter))
}

export function parseCsv(content: string): RawImportRow[] {
  const table = parseDelimitedTable(content)
  if (table.length === 0) throw new MeasuredPackageError('Arquivo vazio.')

  const headers = table[0]!.map(normalizeHeader)
  const skuIdx = headers.indexOf('SKU')
  const nomeIdx = headers.indexOf('NOME')
  const unitCol = detectUnitColumn(headers)
  if (skuIdx < 0 || !unitCol) {
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
    // Aba sem o cabecalho esperado e ignorada (pode ser aba auxiliar/instrucoes) --
    // nunca usa o NOME da aba pra decidir UNIT (§8).
    if (skuIdx < 0 || !unitCol) continue

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
