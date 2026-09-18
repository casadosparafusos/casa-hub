import 'server-only'
import { eq } from 'drizzle-orm'
import { db, schema } from './db'
import { decryptSecret, encryptSecret } from './crypto/secret-box'
import { SECRET_KEYS, type SecretKey } from './settings-shared'
import type { CommercialPolicyConfig } from './units'

export { SECRET_KEYS }
export type { SecretKey }

// -----------------------------------------------------------------------
// Configuracao da integracao ERP -> Wake. Duas camadas:
//   1) valores fixos de regra de negocio, ja definidos pela especificacao
//      (podem ser sobrescritos por env var, mas tem default do proprio
//      spec);
//   2) valores especificos de conta Wake/CISS que a especificacao PROIBE
//      inventar -- ficam null ate serem descobertos e gravados na tabela
//      `settings` (via tela de Configuracoes) ou setados por env var no
//      systemd. O motor de sync deve recusar rodar contra o Wake real
//      (fora de dry-run) enquanto qualquer um destes REQUIRED_UNCONFIRMED
//      estiver ausente.
// -----------------------------------------------------------------------

export const REQUIRED_UNCONFIRMED_KEYS = [
  'WAKE_CD_ID',
  'WAKE_STOCK_CONTROL_MODE', // 'fstore' | 'erp' -- ver docs/WAKE-API-CONTRATOS.md
  'WAKE_PRICE_TABLE_ID',
  'WAKE_PROMOTION_ID',
  'CSV_IDENTIFIER_TYPE', // 'sku' | 'id interno' -- tipoIdentificador da API Wake
] as const

export type RequiredUnconfirmedKey = (typeof REQUIRED_UNCONFIRMED_KEYS)[number]

export const RULE_DEFAULTS = {
  UNIT_PRICE_MARKUP_PERCENT: 20,
  // Adicionado na FASE B.1 (PROBLEMA 1): faltava o 4o parametro da
  // FIXADOR_CENTO (desconto do atacado sobre o varejo) como setting -- os
  // outros 3 (markup/estoque/qty minima) ja existiam, esse ficava hardcoded
  // em CommercialPolicyConfig. Default 20 preserva o comportamento atual.
  WHOLESALE_DISCOUNT_PERCENT: 20,
  WHOLESALE_MIN_QTY: 100,
  STOCK_PERCENT: 10,
  RECONCILIATION_HOUR_LOCAL: 3, // 03:00, ver worker/index.ts
  // Intervalos do sync agendado (worker/index.ts) -- independentes: estoque
  // muda o dia todo (giro de venda), preco e mais estavel (custo do ERP).
  // Pedido explicito do usuario em 08/09/2026: estoque de 1 em 1 minuto,
  // preco de 24 em 24h.
  STOCK_SYNC_INTERVAL_MINUTES: 1,
  PRICE_SYNC_INTERVAL_HOURS: 24,
} as const

// CISS_STOCK_ENTERPRISE/CISS_STOCK_LOCATION NAO estao em REQUIRED_UNCONFIRMED
// porque ja temos valor real, confirmado por sondagem direta da API CISS em
// 25/08/2026 e validado em producao pelo sync da Reposicao (empresa=2,
// local=5 = "ESTOQUE CD", o mesmo CD que abastece o e-commerce) -- nao e
// valor inventado, ver docs/ciss-required-endpoints.md e memoria
// reposicao-sync-real-ativado-server-30. Continuam sobrescritiveis (env var
// ou tela de Configuracoes) caso o SIGAS confirme outro local no futuro.
export const STOCK_SOURCE_DEFAULTS = {
  CISS_STOCK_ENTERPRISE: 2,
  CISS_STOCK_LOCATION: 5,
} as const

// FASE D-PRE §4 (achado independente do Tech Lead): PUT /api/settings so
// validava chave-conhecida + string nao-vazia, e getNumberRule()/
// getStockSourceValue() abaixo tratavam QUALQUER valor persistido invalido
// (NaN, negativo, fora de faixa) exatamente igual a um valor AUSENTE --
// caindo no default e deixando a sync real rodar com uma configuracao que
// ninguem confirmou de verdade (ex: STOCK_PERCENT="abc" virava 10% default
// em silencio). Esse validador fica no meio do caminho: AUSENTE ainda cai
// no default (comportamento antigo, preservado), mas PRESENTE-E-INVALIDO
// agora e um erro explicito, nunca mais um fallback silencioso. Reusado por
// PUT /api/settings (route.ts), pelos getters abaixo e pelos 3
// REQUIRED_UNCONFIRMED_KEYS numericos (WAKE_CD_ID/WAKE_PRICE_TABLE_ID/
// WAKE_PROMOTION_ID, ver checkRequiredUnconfirmed logo abaixo e
// src/lib/sync/engine.ts).
export class SettingValidationError extends Error {
  constructor(
    public readonly key: string,
    message: string,
  ) {
    super(message)
    this.name = 'SettingValidationError'
  }
}

type SettingSpec = { kind: 'number' | 'integer'; min?: number; max?: number; exclusiveMin?: number }

export const SETTING_RANGES: Record<string, SettingSpec> = {
  UNIT_PRICE_MARKUP_PERCENT: { kind: 'number', min: 0 },
  WHOLESALE_DISCOUNT_PERCENT: { kind: 'number', min: 0, max: 100 },
  STOCK_PERCENT: { kind: 'number', min: 0, max: 100 },
  WHOLESALE_MIN_QTY: { kind: 'integer', exclusiveMin: 0 },
  RECONCILIATION_HOUR_LOCAL: { kind: 'integer', min: 0, max: 23 },
  STOCK_SYNC_INTERVAL_MINUTES: { kind: 'number', exclusiveMin: 0 },
  PRICE_SYNC_INTERVAL_HOURS: { kind: 'number', exclusiveMin: 0 },
  CISS_STOCK_ENTERPRISE: { kind: 'integer', exclusiveMin: 0 },
  CISS_STOCK_LOCATION: { kind: 'integer', exclusiveMin: 0 },
  WAKE_CD_ID: { kind: 'integer', exclusiveMin: 0 },
  WAKE_PRICE_TABLE_ID: { kind: 'integer', exclusiveMin: 0 },
  WAKE_PROMOTION_ID: { kind: 'integer', exclusiveMin: 0 },
}

/** Lanca SettingValidationError se `raw` (valor JA CONFIRMADO presente) nao respeitar a faixa de `key`. */
export function validateSettingValue(key: string, raw: string): number {
  const spec = SETTING_RANGES[key]
  if (!spec) throw new SettingValidationError(key, `Chave '${key}' nao tem faixa de validação definida`)
  const n = Number(raw)
  if (!Number.isFinite(n)) throw new SettingValidationError(key, `'${key}' precisa ser um número válido, recebido: ${JSON.stringify(raw)}`)
  if (spec.kind === 'integer' && !Number.isInteger(n)) {
    throw new SettingValidationError(key, `'${key}' precisa ser um número inteiro, recebido: ${raw}`)
  }
  if (spec.min !== undefined && n < spec.min) throw new SettingValidationError(key, `'${key}' precisa ser >= ${spec.min}, recebido: ${n}`)
  if (spec.max !== undefined && n > spec.max) throw new SettingValidationError(key, `'${key}' precisa ser <= ${spec.max}, recebido: ${n}`)
  if (spec.exclusiveMin !== undefined && n <= spec.exclusiveMin) {
    throw new SettingValidationError(key, `'${key}' precisa ser > ${spec.exclusiveMin}, recebido: ${n}`)
  }
  return n
}

export function isValidSettingValue(key: string, raw: string): boolean {
  try {
    validateSettingValue(key, raw)
    return true
  } catch {
    return false
  }
}

function envOverride(key: string): string | undefined {
  const v = process.env[key]
  return v && v.trim() !== '' ? v.trim() : undefined
}

export async function getSetting(key: string): Promise<string | null> {
  const envValue = envOverride(key)
  if (envValue !== undefined) return envValue
  const row = await db.select().from(schema.settings).where(eq(schema.settings.key, key)).get()
  return row?.value ?? null
}

export async function setSetting(key: string, value: string, updatedBy?: string): Promise<void> {
  await db
    .insert(schema.settings)
    .values({ key, value, updatedBy, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value, updatedBy, updatedAt: new Date().toISOString() },
    })
}

// -----------------------------------------------------------------------
// Segredos (tokens de API Wake/CISS) -- gravados criptografados
// (AES-256-GCM, ver src/lib/crypto/secret-box.ts) na mesma tabela
// `settings`, nunca em texto plano no banco nem devolvidos ao cliente (a
// rota /api/settings so expoe um booleano "configurado"). Diferente de
// getSetting/setSetting: aqui o valor gravado no banco tem PRIORIDADE sobre
// a env var (o objetivo desta tela e permitir rotacionar o token sem SSH),
// mas a env var continua funcionando como fallback caso nada tenha sido
// salvo ainda pela UI -- zero downtime na migracao.
// -----------------------------------------------------------------------

async function getSecretRow(key: SecretKey): Promise<string | null> {
  const row = await db.select().from(schema.settings).where(eq(schema.settings.key, key)).get()
  return row?.value ?? null
}

export async function setSecret(key: SecretKey, value: string, updatedBy?: string): Promise<void> {
  const encrypted = encryptSecret(value)
  await db
    .insert(schema.settings)
    .values({ key, value: encrypted, updatedBy, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value: encrypted, updatedBy, updatedAt: new Date().toISOString() },
    })
}

export async function getSecret(key: SecretKey): Promise<string | null> {
  const stored = await getSecretRow(key)
  if (stored) return decryptSecret(stored)
  return envOverride(key) ?? null
}

/** Pra UI: diz se o segredo esta configurado, sem nunca devolver o valor. */
export async function isSecretConfigured(key: SecretKey): Promise<boolean> {
  const stored = await getSecretRow(key)
  if (stored) return true
  return envOverride(key) !== undefined
}

/** Le todos os valores obrigatorios-nao-confirmados e diz quais faltam (ou estao presentes mas invalidos). */
export async function checkRequiredUnconfirmed(): Promise<{
  values: Record<RequiredUnconfirmedKey, string | null>
  missing: RequiredUnconfirmedKey[]
}> {
  const values = {} as Record<RequiredUnconfirmedKey, string | null>
  const missing: RequiredUnconfirmedKey[] = []
  for (const key of REQUIRED_UNCONFIRMED_KEYS) {
    const v = await getSetting(key)
    values[key] = v
    if (v === null) {
      missing.push(key)
    } else if (key in SETTING_RANGES && !isValidSettingValue(key, v)) {
      // FASE D-PRE §4: presente-mas-invalido (WAKE_CD_ID/WAKE_PRICE_TABLE_ID/
      // WAKE_PROMOTION_ID sao os 3 numericos desta lista) bloqueia a sync
      // real do mesmo jeito que ausente -- reaproveita `missing`, ja usado
      // pelo gate em src/lib/sync/engine.ts (runSyncLocked), em vez de criar
      // um segundo gate paralelo que alguem podia esquecer de checar.
      missing.push(key)
    }
  }
  return { values, missing }
}

async function getNumberRule(key: keyof typeof RULE_DEFAULTS): Promise<number> {
  const raw = await getSetting(key)
  if (raw === null) return RULE_DEFAULTS[key]
  return validateSettingValue(key, raw)
}

async function getStockSourceValue(key: keyof typeof STOCK_SOURCE_DEFAULTS): Promise<number> {
  const raw = await getSetting(key)
  if (raw === null) return STOCK_SOURCE_DEFAULTS[key]
  return validateSettingValue(key, raw)
}

export const rules = {
  unitPriceMarkupPercent: () => getNumberRule('UNIT_PRICE_MARKUP_PERCENT'),
  wholesaleDiscountPercent: () => getNumberRule('WHOLESALE_DISCOUNT_PERCENT'),
  wholesaleMinQty: () => getNumberRule('WHOLESALE_MIN_QTY'),
  stockPercent: () => getNumberRule('STOCK_PERCENT'),
  reconciliationHourLocal: () => getNumberRule('RECONCILIATION_HOUR_LOCAL'),
  stockSyncIntervalMinutes: () => getNumberRule('STOCK_SYNC_INTERVAL_MINUTES'),
  priceSyncIntervalHours: () => getNumberRule('PRICE_SYNC_INTERVAL_HOURS'),
}

export const stockSource = {
  enterprise: () => getStockSourceValue('CISS_STOCK_ENTERPRISE'),
  location: () => getStockSourceValue('CISS_STOCK_LOCATION'),
}

/**
 * Ponte camada-de-aplicacao -> modulo puro (FASE B.1, PROBLEMA 1): le os 4
 * settings de regra comercial (markup/desconto atacado/exposicao de
 * estoque/qty minima -- os mesmos 4 campos de CommercialPolicyConfig, ver
 * src/lib/units/types.ts) e monta o config que sync/engine.ts injeta em
 * calculateUnitPrice()/calculateUnitStock(). O modulo puro continua sem
 * saber que settings existem -- so recebe o objeto ja resolvido. Se nenhum
 * setting foi configurado ainda, cada getNumberRule() cai no RULE_DEFAULTS
 * correspondente, que e byte-a-byte igual a DEFAULT_COMMERCIAL_POLICY_CONFIG
 * -- zero mudanca de comportamento pra quem nunca abriu a tela de
 * Configuracoes.
 */
export async function getCommercialPolicyConfig(): Promise<CommercialPolicyConfig> {
  const [markupPercent, wholesaleDiscountPercent, stockExposurePercent, wholesaleMinQty] = await Promise.all([
    rules.unitPriceMarkupPercent(),
    rules.wholesaleDiscountPercent(),
    rules.stockPercent(),
    rules.wholesaleMinQty(),
  ])
  return { markupPercent, wholesaleDiscountPercent, stockExposurePercent, wholesaleMinQty }
}
