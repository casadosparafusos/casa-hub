import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import {
  REQUIRED_UNCONFIRMED_KEYS,
  RULE_DEFAULTS,
  SECRET_KEYS,
  STOCK_SOURCE_DEFAULTS,
  checkRequiredUnconfirmed,
  getSetting,
  isSecretConfigured,
  setSecret,
  setSetting,
} from '@/lib/settings'
import { requireSessionIdentity } from '@/lib/auth'

const RULE_KEYS = Object.keys(RULE_DEFAULTS)
// CISS_STOCK_ENTERPRISE/CISS_STOCK_LOCATION ("Origem do estoque" na tela de
// Configuracoes, ver src/app/(app)/configuracoes/page.tsx) ficaram de fora
// dessa whitelist por descuido -- a secao aparecia e lia normal (getSetting
// com fallback pro default), mas salvar sempre batia em "Chave de
// configuracao desconhecida". Achado em 08/09/2026 tentando trocar
// CISS_STOCK_LOCATION de 5 pra 2 (ver [[ciss-stock-500-corrigido-mas-location-nao-bate-2026-09-08]]).
const STOCK_SOURCE_KEYS = Object.keys(STOCK_SOURCE_DEFAULTS)
const ALL_KEYS = [...REQUIRED_UNCONFIRMED_KEYS, ...RULE_KEYS, ...STOCK_SOURCE_KEYS]
const SECRET_KEYS_LIST: readonly string[] = SECRET_KEYS

export async function GET() {
  const { values, missing } = await checkRequiredUnconfirmed()
  const rules: Record<string, string | null> = {}
  for (const key of RULE_KEYS) rules[key] = await getSetting(key)
  // Segredos: so o booleano "configurado" -- o valor real nunca sai do servidor.
  const secrets: Record<string, boolean> = {}
  for (const key of SECRET_KEYS) secrets[key] = await isSecretConfigured(key)
  return NextResponse.json({ required: values, missing, rules, secrets })
}

const bodySchema = z.object({
  key: z.string().refine((k) => ALL_KEYS.includes(k) || SECRET_KEYS_LIST.includes(k), { message: 'Chave de configuração desconhecida' }),
  value: z.string().min(1),
})

export async function PUT(req: NextRequest) {
  const identity = await requireSessionIdentity()
  if ('error' in identity) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 })

  const parsed = bodySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, { status: 400 })
  }
  const { key, value } = parsed.data
  if (SECRET_KEYS_LIST.includes(key)) {
    await setSecret(key as (typeof SECRET_KEYS)[number], value, identity.username)
  } else {
    await setSetting(key, value, identity.username)
  }
  return NextResponse.json({ ok: true })
}
