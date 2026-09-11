import { describe, expect, it } from 'vitest'
import { parseArgs } from './cli-args'

describe('parseArgs', () => {
  it('defaults: sem full-scan, sem plan, CISS concorrencia 1', () => {
    expect(parseArgs([])).toMatchObject({ fullScan: false, plan: false, cissConcurrency: 1 })
  })

  it('--ciss-concurrency aceita inteiro de 1 a 4', () => {
    expect(parseArgs(['--ciss-concurrency', '2']).cissConcurrency).toBe(2)
    for (const bad of ['0', '5', 'x', '1.5']) {
      expect(() => parseArgs(['--ciss-concurrency', bad])).toThrow('--ciss-concurrency deve ser inteiro')
    }
    expect(() => parseArgs(['--ciss-concurrency'])).toThrow('faltou valor')
  })

  it('argumento desconhecido falha', () => {
    expect(() => parseArgs(['--write'])).toThrow('argumento desconhecido')
  })
})
