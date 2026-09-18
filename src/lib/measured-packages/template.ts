import 'server-only'
import ExcelJS from 'exceljs'

/**
 * Gera o modelo XLSX de importacao (FASE E §7) -- duas abas (KG/MT), coluna
 * SKU formatada como texto, e SOMENTE uma linha de exemplo ficticia (nunca
 * SKU comercial real, repositorio casa-hub e publico).
 */
export async function generateTemplate(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()

  const buildSheet = (name: string, unitHeader: 'QT KG' | 'QT MT', exampleQty: number) => {
    const sheet = workbook.addWorksheet(name)
    sheet.columns = [
      { header: 'SKU', key: 'sku', width: 18 },
      { header: 'NOME', key: 'nome', width: 32 },
      { header: unitHeader, key: 'qtd', width: 14 },
    ]
    sheet.getColumn('sku').numFmt = '@'
    sheet.addRow({ sku: 'EXEMPLO-001', nome: 'Produto de exemplo (substitua pelos seus dados)', qtd: exampleQty })
  }

  buildSheet('KG', 'QT KG', 18)
  buildSheet('MT', 'QT MT', 10)

  const arrayBuffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(arrayBuffer)
}
