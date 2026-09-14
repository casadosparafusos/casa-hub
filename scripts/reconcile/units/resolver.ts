// UnitResolver -- mapeamento puro do UNIT cru do CISS para a classe
// canonica. Mapa OWNER_CONFIRMED 11/09/2026, ver docs/CISS_UNIT_MAP.md.
//
// Fail closed: qualquer UNIT fora do mapa (ou ausente/vazio) NUNCA vira
// DIRECT por padrao -- vira falha UNSUPPORTED_UNIT.

import type { PackageSourceUnit } from './types'

export type UnitResolution =
  | { ok: true; unitRaw: string; unitNormalized: string; unitClass: 'HUNDRED' }
  | { ok: true; unitRaw: string; unitNormalized: string; unitClass: 'DIRECT' }
  | {
      ok: true
      unitRaw: string
      unitNormalized: string
      unitClass: 'PACKAGE_MEASURED'
      sourceUnit: PackageSourceUnit
    }
  | { ok: false; unitRaw: string | null; unitNormalized: string | null }

const HUNDRED_UNITS: ReadonlySet<string> = new Set(['CT'])

const DIRECT_UNITS: ReadonlySet<string> = new Set(['PC', 'UN', 'JG', 'PR', 'CJ', 'RL', 'KT', 'CX', 'LT', 'PL'])

const PACKAGE_UNITS: Readonly<Record<string, PackageSourceUnit>> = { KG: 'KG', MT: 'MT' }

export function resolveUnit(unitRaw: string | null | undefined): UnitResolution {
  const hasRaw = typeof unitRaw === 'string'
  const unitNormalized = hasRaw ? unitRaw.trim().toUpperCase() : null

  if (!unitNormalized) {
    return { ok: false, unitRaw: hasRaw ? unitRaw : null, unitNormalized: null }
  }

  const raw = unitRaw as string

  if (HUNDRED_UNITS.has(unitNormalized)) {
    return { ok: true, unitRaw: raw, unitNormalized, unitClass: 'HUNDRED' }
  }
  if (DIRECT_UNITS.has(unitNormalized)) {
    return { ok: true, unitRaw: raw, unitNormalized, unitClass: 'DIRECT' }
  }
  const sourceUnit = PACKAGE_UNITS[unitNormalized]
  if (sourceUnit) {
    return { ok: true, unitRaw: raw, unitNormalized, unitClass: 'PACKAGE_MEASURED', sourceUnit }
  }

  return { ok: false, unitRaw: raw, unitNormalized }
}
