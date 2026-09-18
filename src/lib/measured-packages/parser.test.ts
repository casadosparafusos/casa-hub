import { describe, expect, it, vi } from 'vitest'
import ExcelJS from 'exceljs'
import { parseCsv, parseImportFile, parseXlsx } from './parser'
import { MeasuredPackageError } from './types'

// server-only recusa import fora de condicao react-server (mesmo motivo do
// mock em src/lib/sync/engine.test.ts) -- vitest nao roda com essa condicao.
vi.mock('server-only', () => ({}))

describe('parseCsv -- FASE E §6/§8', () => {
  it('aceita cabecalho SKU + QT KG, separador virgula', () => {
    const rows = parseCsv('SKU,NOME,QT KG\nABC-1,Produto A,18')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sku: 'ABC-1', nameFromFile: 'Produto A', sourceUnit: 'KG', quantity: 18, parseError: null })
  })

  it('aceita cabecalho SKU + QT MT, separador ponto e virgula (mais ; que , no header)', () => {
    const csv = 'SKU;NOME;QT MT\nXYZ-1;Produto X;10'
    const rows = parseCsv(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sku: 'XYZ-1', sourceUnit: 'MT', quantity: 10 })
  })

  it('decimal com virgula (separador ; ) e convertido pra numero (12,5 -> 12.5)', () => {
    const rows = parseCsv('SKU;NOME;QT KG\nABC-1;Produto A;12,5')
    expect(rows[0]?.quantity).toBe(12.5)
    expect(rows[0]?.parseError).toBeNull()
  })

  // Tech Lead review PR #5, achado #3: parser real de CSV (RFC4180) --
  // campo entre aspas protege virgula/quebra interna do delimitador.
  it('campo entre aspas com virgula dentro (nome) nao quebra a coluna', () => {
    const rows = parseCsv('SKU,NOME,QT KG\nABC-1,"Silva, Produto A",18')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sku: 'ABC-1', nameFromFile: 'Silva, Produto A', sourceUnit: 'KG', quantity: 18, parseError: null })
  })

  it('decimal com virgula entre aspas (separador , ) e convertido pra numero, nao quebra a coluna', () => {
    const rows = parseCsv('SKU,NOME,QT KG\nABC-1,Produto A,"12,5"')
    expect(rows[0]?.quantity).toBe(12.5)
    expect(rows[0]?.parseError).toBeNull()
  })

  it('aspas escapadas ("") dentro de campo entre aspas viram uma aspas literal', () => {
    const rows = parseCsv('SKU,NOME,QT KG\nABC-1,"Produto ""Especial""",18')
    expect(rows[0]?.nameFromFile).toBe('Produto "Especial"')
  })

  it('separador ; com decimal em virgula em varias linhas', () => {
    const rows = parseCsv('SKU;NOME;QT MT\nXYZ-1;Produto X;10,5\nXYZ-2;Produto Y;3,25')
    expect(rows[0]?.quantity).toBe(10.5)
    expect(rows[1]?.quantity).toBe(3.25)
  })

  it('remove BOM UTF-8 do inicio do arquivo', () => {
    const bom = '﻿SKU,NOME,QT KG\nABC-1,Produto A,18'
    const rows = parseCsv(bom)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.sku).toBe('ABC-1')
  })

  it('SKU vazio vira erro de linha, nao aborta o arquivo', () => {
    const rows = parseCsv('SKU,NOME,QT KG\n,Produto A,18')
    expect(rows[0]?.parseError).toBe('SKU vazio.')
  })

  it('quantidade invalida vira erro de linha', () => {
    const rows = parseCsv('SKU,NOME,QT KG\nABC-1,Produto A,abc')
    expect(rows[0]?.parseError).toMatch(/Quantidade inválida/)
  })

  it('cabecalho sem SKU ou sem QT KG/QT MT -- lanca erro, nunca infere pelo nome da aba/arquivo', () => {
    expect(() => parseCsv('CODIGO,NOME,QUANTIDADE\nABC-1,Produto A,18')).toThrow(MeasuredPackageError)
  })

  // Tech Lead review PR #5, achado #4: cabecalho com as DUAS colunas QT
  // KG/QT MT ao mesmo tempo e ambiguo -- fail-closed, nunca escolhe uma.
  it('cabecalho com QT KG e QT MT ao mesmo tempo -- lanca erro de ambiguidade, nunca escolhe uma', () => {
    expect(() => parseCsv('SKU,NOME,QT KG,QT MT\nABC-1,Produto A,18,5')).toThrow(/ambíguo/)
  })

  it('arquivo vazio -- lanca erro', () => {
    expect(() => parseCsv('')).toThrow(MeasuredPackageError)
  })

  it('acima do limite de 5000 linhas -- lanca erro', () => {
    const header = 'SKU,NOME,QT KG\n'
    const body = Array.from({ length: 5001 }, (_, i) => `SKU-${i},Produto,1`).join('\n')
    expect(() => parseCsv(header + body)).toThrow(/limite de 5000 linhas/)
  })

  it('SKU preservado como texto -- nao coage pra numero mesmo se parecer numerico', () => {
    const rows = parseCsv('SKU,NOME,QT KG\n000123,Produto A,18')
    expect(rows[0]?.sku).toBe('000123')
  })
})

describe('parseXlsx -- FASE E §6/§8', () => {
  async function buildWorkbookBuffer(build: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
    const wb = new ExcelJS.Workbook()
    build(wb)
    const arrayBuffer = await wb.xlsx.writeBuffer()
    return Buffer.from(arrayBuffer)
  }

  it('le aba KG com cabecalho SKU/NOME/QT KG', async () => {
    const buffer = await buildWorkbookBuffer((wb) => {
      const sheet = wb.addWorksheet('KG')
      sheet.addRow(['SKU', 'NOME', 'QT KG'])
      sheet.addRow(['ABC-1', 'Produto A', 18])
    })
    const rows = await parseXlsx(buffer)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sku: 'ABC-1', sourceUnit: 'KG', quantity: 18, parseError: null })
  })

  it('nunca usa o nome da aba pra decidir UNIT -- aba chamada "MT" mas com cabecalho QT KG e lida como KG', async () => {
    const buffer = await buildWorkbookBuffer((wb) => {
      const sheet = wb.addWorksheet('MT')
      sheet.addRow(['SKU', 'NOME', 'QT KG'])
      sheet.addRow(['ABC-1', 'Produto A', 18])
    })
    const rows = await parseXlsx(buffer)
    expect(rows[0]?.sourceUnit).toBe('KG')
  })

  it('ignora aba sem cabecalho reconhecido (aba auxiliar/instrucoes)', async () => {
    const buffer = await buildWorkbookBuffer((wb) => {
      const aux = wb.addWorksheet('Instrucoes')
      aux.addRow(['Leia isto antes de preencher'])
      const kg = wb.addWorksheet('KG')
      kg.addRow(['SKU', 'NOME', 'QT KG'])
      kg.addRow(['ABC-1', 'Produto A', 18])
    })
    const rows = await parseXlsx(buffer)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.sheet).toBe('KG')
  })

  it('celula com formula na coluna SKU ou quantidade vira erro de linha, nunca e executada', async () => {
    const buffer = await buildWorkbookBuffer((wb) => {
      const sheet = wb.addWorksheet('KG')
      sheet.addRow(['SKU', 'NOME', 'QT KG'])
      const row = sheet.addRow(['ABC-1', 'Produto A', 18])
      row.getCell(3).value = { formula: 'SUM(1,2)', result: 18 }
    })
    const rows = await parseXlsx(buffer)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.parseError).toMatch(/fórmula/)
    expect(rows[0]?.quantity).toBeNull()
  })

  it('linha totalmente em branco e ignorada', async () => {
    const buffer = await buildWorkbookBuffer((wb) => {
      const sheet = wb.addWorksheet('KG')
      sheet.addRow(['SKU', 'NOME', 'QT KG'])
      sheet.addRow(['ABC-1', 'Produto A', 18])
      sheet.addRow([])
      sheet.addRow(['ABC-2', 'Produto B', 10])
    })
    const rows = await parseXlsx(buffer)
    expect(rows).toHaveLength(2)
  })

  it('nenhuma aba com cabecalho reconhecido -- lanca erro', async () => {
    const buffer = await buildWorkbookBuffer((wb) => {
      const sheet = wb.addWorksheet('Aba1')
      sheet.addRow(['CODIGO', 'DESCRICAO'])
    })
    await expect(parseXlsx(buffer)).rejects.toThrow(MeasuredPackageError)
  })

  // Tech Lead review PR #5, achado #4: mesma regra fail-closed de ambiguidade
  // vale pra aba XLSX (nao so CSV).
  it('aba com SKU + QT KG e QT MT ao mesmo tempo -- lanca erro de ambiguidade, nunca escolhe uma', async () => {
    const buffer = await buildWorkbookBuffer((wb) => {
      const sheet = wb.addWorksheet('Ambiguo')
      sheet.addRow(['SKU', 'NOME', 'QT KG', 'QT MT'])
      sheet.addRow(['ABC-1', 'Produto A', 18, 5])
    })
    await expect(parseXlsx(buffer)).rejects.toThrow(/ambíguo/)
  })
})

describe('parseImportFile -- despacho por extensao e limites (FASE E §6/§8)', () => {
  it('extensao nao suportada -- lanca erro', async () => {
    await expect(parseImportFile(Buffer.from('SKU,QT KG\nA,1'), 'planilha.txt')).rejects.toThrow(/não suportado/)
  })

  it('arquivo vazio -- lanca erro', async () => {
    await expect(parseImportFile(Buffer.alloc(0), 'planilha.csv')).rejects.toThrow(/vazio/)
  })

  it('acima de 5MB -- lanca erro', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 'a')
    await expect(parseImportFile(big, 'planilha.csv')).rejects.toThrow(/5MB/)
  })

  it('.csv despacha pro parser de CSV', async () => {
    const rows = await parseImportFile(Buffer.from('SKU,NOME,QT KG\nABC-1,Produto A,18', 'utf-8'), 'planilha.csv')
    expect(rows[0]?.sheet).toBe('CSV')
  })
})
