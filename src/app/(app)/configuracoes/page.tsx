import clsx from 'clsx'
import { checkRequiredUnconfirmed, getSetting, isSecretConfigured, RULE_DEFAULTS, SECRET_KEYS, STOCK_SOURCE_DEFAULTS } from '@/lib/settings'
import { SECRET_CONFIGURED_SENTINEL } from '@/lib/settings-shared'
import { SettingsForm } from '@/components/settings-form'

export const dynamic = 'force-dynamic'

const REQUIRED_FIELDS = [
  { key: 'WAKE_CD_ID', label: 'ID do Centro de Distribuição no Wake', help: 'Descobrir no admin do Wake (Configurações > Centros de Distribuição). Nunca inventar.' },
  { key: 'WAKE_STOCK_CONTROL_MODE', label: "'fstore' ou 'erp'", help: '"Controlar estoque pela FStore" ON = fstore (não enviar baixa manual); OFF = erp (enviar baixa explícita). Checar no admin do Wake.' },
  { key: 'WAKE_PRICE_TABLE_ID', label: 'ID da Tabela de Preço "PARAFUSOS - PREÇO CENTO ERP"', help: 'Criar a tabela no admin do Wake primeiro, depois colar o ID aqui.' },
  { key: 'WAKE_PROMOTION_ID', label: 'ID da Promoção "PREÇO CENTO - FIXADORES"', help: 'Não há endpoint confirmado de criação de promoção via API -- criar no admin do Wake.' },
]
// CSV_IDENTIFIER_TYPE removida desta lista (revisao Tech Lead PR #4, fix #3):
// auditoria (grep em src/) confirmou que nenhum consumidor le essa setting --
// o tipoIdentificador enviado ao Wake e sempre um literal hardcoded por
// chamada em src/lib/wake/client.ts. Ver comentario equivalente em
// src/lib/settings.ts (REQUIRED_UNCONFIRMED_KEYS).

const RULE_FIELDS = [
  { key: 'UNIT_PRICE_MARKUP_PERCENT', label: String(RULE_DEFAULTS.UNIT_PRICE_MARKUP_PERCENT), help: 'Markup percentual sobre o preço bruto do ERP para o preço unitário no Wake.' },
  { key: 'WHOLESALE_MIN_QTY', label: String(RULE_DEFAULTS.WHOLESALE_MIN_QTY), help: 'Quantidade mínima (unidades) pra valer o preço/cento.' },
  { key: 'STOCK_PERCENT', label: String(RULE_DEFAULTS.STOCK_PERCENT), help: 'Percentual do estoque real do ERP exposto no Wake (floor).' },
  { key: 'STOCK_SYNC_INTERVAL_MINUTES', label: String(RULE_DEFAULTS.STOCK_SYNC_INTERVAL_MINUTES), help: 'De quantos em quantos minutos o worker agendado sincroniza estoque com o Wake.' },
  { key: 'PRICE_SYNC_INTERVAL_HOURS', label: String(RULE_DEFAULTS.PRICE_SYNC_INTERVAL_HOURS), help: 'De quantas em quantas horas o worker agendado sincroniza preço com o Wake.' },
]

const SECRET_FIELDS = [
  {
    key: 'WAKE_ADMIN_API_TOKEN',
    label: 'Token BASIC da API admin do Wake (Fbits)',
    help: 'Gerado no admin do Wake. Gravado criptografado (AES-256-GCM) -- depois de salvo, não é mais possível visualizar nem copiar o valor, só substituir por um novo.',
    secret: true,
  },
  {
    key: 'CISS_API_TOKEN',
    label: 'Token Bearer da API CISS/SIGAS',
    help: 'Token dedicado gerado pelo SIGAS para o Casa Hub. Gravado criptografado -- mesmo comportamento write-only do token Wake acima.',
    secret: true,
  },
]

const STOCK_SOURCE_FIELDS = [
  { key: 'CISS_STOCK_ENTERPRISE', label: String(STOCK_SOURCE_DEFAULTS.CISS_STOCK_ENTERPRISE), help: 'Empresa (CISS) filtrada em /products/stock-sales. Default = "ESTOQUE CD", confirmado por sondagem direta e já validado em produção pela Reposição -- editar só se o SIGAS indicar outro local.' },
  { key: 'CISS_STOCK_LOCATION', label: String(STOCK_SOURCE_DEFAULTS.CISS_STOCK_LOCATION), help: 'Local/depósito (CISS) filtrado em /products/stock-sales. Default = "ESTOQUE CD" (mesmo CD da Reposição) -- editar só se o SIGAS indicar outro local.' },
]

export default async function ConfiguracoesPage() {
  const { values, missing } = await checkRequiredUnconfirmed()
  const ruleValues: Record<string, string | null> = {}
  for (const f of RULE_FIELDS) ruleValues[f.key] = await getSetting(f.key)
  // Prefill com o default real (nao um placeholder vazio): o valor ja esta
  // em vigor mesmo sem override explicito, ver src/lib/settings.ts.
  const stockSourceValues: Record<string, string | null> = {}
  for (const f of STOCK_SOURCE_FIELDS) {
    stockSourceValues[f.key] = (await getSetting(f.key)) ?? String(STOCK_SOURCE_DEFAULTS[f.key as keyof typeof STOCK_SOURCE_DEFAULTS])
  }

  const secretValues: Record<string, string | null> = {}
  for (const f of SECRET_FIELDS) {
    secretValues[f.key] = (await isSecretConfigured(f.key as (typeof SECRET_KEYS)[number])) ? SECRET_CONFIGURED_SENTINEL : null
  }

  const confirmedCount = REQUIRED_FIELDS.length - missing.length
  const allConfirmed = missing.length === 0
  // Revisao Tech Lead PR #4, final polish (item 1): "todos confirmados" NAO
  // e o mesmo que "estoque real liberado" -- com WAKE_STOCK_CONTROL_MODE=erp
  // o backend bloqueia escrita real de estoque de proposito (guard fail-closed
  // em runSyncLocked(), ver src/lib/sync/engine.ts), mesmo com missing=[].
  // "Pronto para producao" tambem e amplo demais aqui: essa pagina so cobre
  // as 4 settings obrigatorias, nao os outros gates (provider real, readiness,
  // rollout). A barra de progresso continua baseada só na confirmacao das
  // settings, sem novo fluxo de baixa de estoque inventado.
  const stockMode = values.WAKE_STOCK_CONTROL_MODE
  const stockWriteBlocked = allConfirmed && stockMode === 'erp'

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--texto)]">Configurações</h1>
        <p className="text-sm text-[var(--texto-suave)]">
          Valores específicos de conta Wake/CISS nunca são inventados -- ficam pendentes até serem confirmados aqui.
        </p>
      </div>

      <div className="section section--pad">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-[var(--texto)]">
              {allConfirmed ? 'Todos os obrigatórios confirmados' : `${confirmedCount} de ${REQUIRED_FIELDS.length} obrigatórios confirmados`}
            </p>
            <p className="mt-0.5 text-xs text-[var(--texto-suave)]">
              {!allConfirmed
                ? `Enquanto houver pendência, a sincronização real fica bloqueada (dry-run continua liberado). Faltam: ${missing.join(', ')}.`
                : stockWriteBlocked
                  ? 'Preço real pode ser executado, mas estoque real está bloqueado enquanto o modo ERP não tiver fluxo de baixa implementado.'
                  : 'Configuração apta ao sync real; demais gates de produção (provider real, readiness, rollout) continuam independentes.'}
            </p>
          </div>
          <span
            className={clsx(
              'shrink-0 self-start rounded-full px-3 py-1 text-xs font-bold sm:self-auto',
              !allConfirmed ? 'bg-amber-50 text-amber-700' : stockWriteBlocked ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700',
            )}
          >
            {!allConfirmed ? 'Somente dry-run' : stockWriteBlocked ? 'Estoque real bloqueado' : 'Configuração confirmada'}
          </span>
        </div>
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-[var(--superficie-sunken)]">
          <div
            className={clsx('h-full rounded-full transition-all', allConfirmed ? 'bg-emerald-500' : 'bg-amber-400')}
            style={{ width: `${(confirmedCount / REQUIRED_FIELDS.length) * 100}%` }}
          />
        </div>
      </div>

      <section className="section section--pad">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--texto)]">Obrigatórios</h2>
          <span className="text-xs text-[var(--texto-suave)]">bloqueiam sincronização real</span>
        </div>
        <SettingsForm fields={REQUIRED_FIELDS} initialValues={values} />
      </section>

      <section className="section section--pad">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--texto)]">Tokens de API (criptografados)</h2>
          <span className="text-xs text-[var(--texto-suave)]">write-only -- não é possível visualizar depois de salvo</span>
        </div>
        <SettingsForm fields={SECRET_FIELDS} initialValues={secretValues} />
      </section>

      <section className="section section--pad">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--texto)]">Origem do estoque (CISS)</h2>
          <span className="text-xs text-[var(--texto-suave)]">já tem default real, editável</span>
        </div>
        <SettingsForm fields={STOCK_SOURCE_FIELDS} initialValues={stockSourceValues} />
      </section>

      <section className="section section--pad">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--texto)]">Regras de negócio</h2>
          <span className="text-xs text-[var(--texto-suave)]">têm default da especificação</span>
        </div>
        <SettingsForm fields={RULE_FIELDS} initialValues={ruleValues} />
      </section>
    </div>
  )
}
