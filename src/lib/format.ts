// Formatacao e rotulos de exibicao -- fonte unica pra toda a UI.
//
// NAO pode ter 'server-only': e importado tanto por Server Components
// (Visao Geral, Historico, Produtos) quanto por Client Components
// (users-manager, sync-trigger-panel).
//
// Motivo de existir (10/09/2026): a Visao Geral e o Historico mostravam o
// timestamp CRU do banco ("2026-09-10T12:39:43.734Z"), que e UTC. O usuario
// em Sao Paulo lia "12:39" quando eram 09:39 na parede -- 3h de diferenca.
// A pagina de Produtos ja convertia certo, com uma copia local desta funcao;
// agora todas usam esta. Junto vieram os rotulos: o banco guarda os valores
// tecnicos em ingles ('stock', 'scheduled', 'partial', 'no_change'...) e a
// UI mostrava esses valores direto na tela. O banco continua em ingles (nao
// mexer -- e contrato interno e ja tem historico gravado); a traducao e so
// na borda de exibicao.

const TIMEZONE = 'America/Sao_Paulo'

/** "10/09/2026 09:39" -- data e hora no fuso de Sao Paulo, sem segundos. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: TIMEZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d)
}

/** "09:39:12" -- so o horario, com segundos, no fuso de Sao Paulo. */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(d)
}

// --- Rotulos --------------------------------------------------------------

/** sync_runs.kind */
const KIND_LABELS: Record<string, string> = {
  price: 'Preço',
  stock: 'Estoque',
  both: 'Preço + Estoque',
}

/** sync_runs.trigger */
const TRIGGER_LABELS: Record<string, string> = {
  manual: 'Manual',
  scheduled: 'Agendada',
  reconciliation: 'Reconciliação',
}

/** sync_runs.status (execucao inteira) */
const RUN_STATUS_LABELS: Record<string, string> = {
  running: 'Em andamento',
  success: 'Concluída',
  partial: 'Parcial',
  failed: 'Falhou',
}

/** sync_run_items.status (item individual) */
const ITEM_STATUS_LABELS: Record<string, string> = {
  applied: 'Aplicado',
  planned: 'Planejado',
  no_change: 'Sem mudança',
  failed: 'Falhou',
  skipped: 'Ignorado',
}

/** sync_run_items.field */
const FIELD_LABELS: Record<string, string> = {
  unit_price: 'Preço unitário',
  special_price: 'Preço promocional',
  stock: 'Estoque',
}

/** Traduz, mas nunca engole um valor novo: se nao conhecer, devolve o cru. */
function translate(map: Record<string, string>, value: string | null | undefined): string {
  if (!value) return '—'
  return map[value] ?? value
}

export const syncKindLabel = (v: string | null | undefined) => translate(KIND_LABELS, v)
export const syncTriggerLabel = (v: string | null | undefined) => translate(TRIGGER_LABELS, v)
export const syncRunStatusLabel = (v: string | null | undefined) => translate(RUN_STATUS_LABELS, v)
export const syncItemStatusLabel = (v: string | null | undefined) => translate(ITEM_STATUS_LABELS, v)
export const syncFieldLabel = (v: string | null | undefined) => translate(FIELD_LABELS, v)
