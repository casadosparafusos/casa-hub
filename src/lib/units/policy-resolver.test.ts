import { describe, expect, it } from 'vitest'
import { resolveCommercialPolicy } from './policy-resolver'

describe('resolveCommercialPolicy (PROBLEMA 2 -- selecao centralizada)', () => {
  it('HUNDRED sem override -> FIXADOR_CENTO (default desta fase, documentado)', () => {
    expect(resolveCommercialPolicy('HUNDRED')).toBe('FIXADOR_CENTO')
  })

  it('DIRECT sem override -> NONE', () => {
    expect(resolveCommercialPolicy('DIRECT')).toBe('NONE')
  })

  it('PACKAGE_MEASURED sem override -> NONE', () => {
    expect(resolveCommercialPolicy('PACKAGE_MEASURED')).toBe('NONE')
  })

  it('HUNDRED com override NONE -> NONE (CT + NoCommercialPolicy e representavel)', () => {
    expect(resolveCommercialPolicy('HUNDRED', 'NONE')).toBe('NONE')
  })

  it('DIRECT com override FIXADOR_CENTO -> FIXADOR_CENTO (override sempre vence, ponto de extensao futuro)', () => {
    expect(resolveCommercialPolicy('DIRECT', 'FIXADOR_CENTO')).toBe('FIXADOR_CENTO')
  })
})
