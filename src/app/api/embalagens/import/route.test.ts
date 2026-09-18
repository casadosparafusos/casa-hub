import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'

vi.mock('server-only', () => ({}))

// Tech Lead review PR #5, achado #7: o limite de 5MB era checado DEPOIS de
// `file.arrayBuffer()` (dentro de parseImportFile), ou seja, um upload
// gigante era inteiro bufferizado na memoria so pra descobrir que excede o
// limite. Este teste prova a ordem: `file.size` e checado ANTES de
// bufferizar, com 413 e sem nunca chamar parseImportFile.

const mockRequireSessionIdentity = vi.fn()
vi.mock('@/lib/auth', () => ({
  requireSessionIdentity: () => mockRequireSessionIdentity(),
}))

const mockParseImportFile = vi.fn()
vi.mock('@/lib/measured-packages/parser', async () => {
  const actual = await vi.importActual<typeof import('@/lib/measured-packages/parser')>('@/lib/measured-packages/parser')
  return { ...actual, parseImportFile: (...args: unknown[]) => mockParseImportFile(...args) }
})

const mockValidateImportRows = vi.fn()
const mockApplyImport = vi.fn()
vi.mock('@/lib/measured-packages/import', () => ({
  validateImportRows: (...args: unknown[]) => mockValidateImportRows(...args),
  applyImport: (...args: unknown[]) => mockApplyImport(...args),
}))

const FAKE_IDENTITY = { userId: 1, username: 'tester', displayName: 'Tester' }

let POST: typeof import('./route').POST
let MAX_FILE_BYTES: number

beforeEach(async () => {
  vi.clearAllMocks()
  mockRequireSessionIdentity.mockResolvedValue(FAKE_IDENTITY)
  ;({ POST } = await import('./route'))
  ;({ MAX_FILE_BYTES } = await import('@/lib/measured-packages/parser'))
})

afterEach(() => {
  vi.resetModules()
})

function fakeFile(size: number): File {
  const file = new File(['x'], 'planilha.csv')
  Object.defineProperty(file, 'size', { value: size })
  Object.defineProperty(file, 'arrayBuffer', { value: vi.fn(async () => new ArrayBuffer(0)) })
  return file
}

function fakeRequest(mode: string, file: unknown): NextRequest {
  return {
    nextUrl: { searchParams: new URLSearchParams({ mode }) },
    formData: async () => {
      const map = new Map<string, unknown>([['file', file]])
      return { get: (k: string) => map.get(k) } as unknown as FormData
    },
  } as unknown as NextRequest
}

describe('POST /api/embalagens/import -- FASE E achado #7 (tamanho checado antes de bufferizar)', () => {
  it('arquivo acima de 5MB -- 413, nunca chama arrayBuffer() nem parseImportFile', async () => {
    const file = fakeFile(MAX_FILE_BYTES + 1)
    const res = await POST(fakeRequest('preview', file))

    expect(res.status).toBe(413)
    const body = await res.json()
    expect(body.error).toMatch(/5MB/)
    expect(file.arrayBuffer).not.toHaveBeenCalled()
    expect(mockParseImportFile).not.toHaveBeenCalled()
  })

  it('arquivo dentro do limite -- segue o fluxo normal (chama arrayBuffer e parseImportFile)', async () => {
    const file = fakeFile(MAX_FILE_BYTES)
    mockParseImportFile.mockResolvedValue([])
    mockValidateImportRows.mockResolvedValue({ rows: [], totalRows: 0, createCount: 0, updateCount: 0, noopCount: 0, errorCount: 0 })

    const res = await POST(fakeRequest('preview', file))

    expect(res.status).toBe(200)
    expect(file.arrayBuffer).toHaveBeenCalledTimes(1)
    expect(mockParseImportFile).toHaveBeenCalledTimes(1)
  })

  it('nao autenticado -- 401 antes de checar tamanho', async () => {
    mockRequireSessionIdentity.mockResolvedValue({ error: true, status: 401 })
    const file = fakeFile(MAX_FILE_BYTES + 1)
    const res = await POST(fakeRequest('preview', file))
    expect(res.status).toBe(401)
    expect(file.arrayBuffer).not.toHaveBeenCalled()
  })
})
