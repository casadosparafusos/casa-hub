import { describe, expect, it } from 'vitest'
import { resolveUnit } from './resolver'

describe('resolveUnit', () => {
  it('CT -> HUNDRED', () => {
    const r = resolveUnit('CT')
    expect(r).toEqual({ ok: true, unitRaw: 'CT', unitNormalized: 'CT', unitClass: 'HUNDRED' })
  })

  it('" ct " -> HUNDRED, normaliza para CT (trim + uppercase)', () => {
    const r = resolveUnit(' ct ')
    expect(r).toEqual({ ok: true, unitRaw: ' ct ', unitNormalized: 'CT', unitClass: 'HUNDRED' })
  })

  it.each(['PC', 'UN', 'JG', 'PR', 'CJ', 'RL', 'KT', 'CX', 'LT', 'PL'])('%s -> DIRECT', (unit) => {
    const r = resolveUnit(unit)
    expect(r).toEqual({ ok: true, unitRaw: unit, unitNormalized: unit, unitClass: 'DIRECT' })
  })

  it('KG -> PACKAGE_MEASURED(KG)', () => {
    const r = resolveUnit('KG')
    expect(r).toEqual({ ok: true, unitRaw: 'KG', unitNormalized: 'KG', unitClass: 'PACKAGE_MEASURED', sourceUnit: 'KG' })
  })

  it('MT -> PACKAGE_MEASURED(MT)', () => {
    const r = resolveUnit('MT')
    expect(r).toEqual({ ok: true, unitRaw: 'MT', unitNormalized: 'MT', unitClass: 'PACKAGE_MEASURED', sourceUnit: 'MT' })
  })

  it('ZZ (unidade desconhecida) -> falha, fail closed', () => {
    const r = resolveUnit('ZZ')
    expect(r).toEqual({ ok: false, unitRaw: 'ZZ', unitNormalized: 'ZZ' })
  })

  it('"" -> falha', () => {
    const r = resolveUnit('')
    expect(r.ok).toBe(false)
  })

  it('null -> falha', () => {
    const r = resolveUnit(null)
    expect(r).toEqual({ ok: false, unitRaw: null, unitNormalized: null })
  })

  it('undefined -> falha', () => {
    const r = resolveUnit(undefined)
    expect(r).toEqual({ ok: false, unitRaw: null, unitNormalized: null })
  })

  it('nunca cai em DIRECT por padrao para UNIT nova/desconhecida', () => {
    for (const raw of ['XY', 'FOO', 'BAR123', 'CENTO']) {
      const r = resolveUnit(raw)
      expect(r.ok).toBe(false)
    }
  })
})
