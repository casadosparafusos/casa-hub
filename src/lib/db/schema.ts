import { sqliteTable, text, integer, real, index, uniqueIndex, check } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

// ---------------------------------------------------------------------------
// Banco proprio da integracao ERP (CISS/PODER) -> Wake Commerce.
// Independente do banco da Reposicao -- nao compartilha arquivo/tabelas.
// Ver docs/README.md e a especificacao original (secoes 40-47) pro desenho
// dessas 8 tabelas.
// ---------------------------------------------------------------------------

/**
 * Whitelist de produtos administrados por esta integracao -- importada via
 * CSV (ciss_product_id, wake_product_variant_id, wake_sku, active). Nenhum
 * produto fora desta tabela (ou com active=0) pode ser alterado no Wake.
 */
export const managedProducts = sqliteTable(
  'managed_products',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    cissProductId: text('ciss_product_id').notNull(),
    wakeProductVariantId: text('wake_product_variant_id').notNull(),
    wakeSku: text('wake_sku').notNull(),
    // nome do produto no Wake -- vem de graca no GET /produtos/{sku} que o
    // importer ja chama pra resolver o wakeProductVariantId (getWakeProductBySku,
    // campo `nome`); so pra exibicao na tela /produtos, nunca usado em logica
    // de sync. Nullable porque linhas importadas antes desta coluna existir
    // ficam sem valor ate rodar o backfill (scripts/backfill-wake-product-name.ts).
    wakeProductName: text('wake_product_name'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    // preenchido/atualizado pelo importer -- util pra auditoria de origem
    importId: integer('import_id').references(() => imports.id),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text('updated_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => ({
    cissProductIdIdx: uniqueIndex('managed_products_ciss_product_id_idx').on(t.cissProductId),
    wakeVariantIdIdx: uniqueIndex('managed_products_wake_variant_id_idx').on(t.wakeProductVariantId),
    activeIdx: index('managed_products_active_idx').on(t.active),
  }),
)

/**
 * Estado conhecido mais recente de cada produto administrado -- usado pro
 * diff (o que mudou desde a ultima sincronizacao) e pra nao reenviar o que
 * ja esta correto no Wake. Uma linha 1:1 com managed_products.
 */
export const syncProductState = sqliteTable(
  'sync_product_state',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    managedProductId: integer('managed_product_id')
      .notNull()
      .references(() => managedProducts.id),

    // ultimo valor lido no ERP
    erpPrice: real('erp_price'), // preco de varejo bruto do CISS (fonte da regra de markup e do preco/cento)
    // `real`, NAO `integer` -- o CISS retorna estoque fracionario de verdade
    // (KG, MT, e ate CT com sobra, ex: 2.3 cento). O truncamento pro Wake
    // (floor) acontece so no limite da strategy/policy (ver src/lib/units),
    // nunca na persistencia do valor cru lido do ERP. Ver §11 do FASE B.
    erpStock: real('erp_stock'),
    erpReadAt: text('erp_read_at'),

    // UNIT observada na ultima leitura do CISS (ver §14 do FASE B). `unitRaw`
    // preserva o valor exatamente como veio (ex: " ct "); `unitNormalized` e
    // trim+uppercase (ex: "CT") -- nunca sobrescrever um com o outro, ambos
    // devem permanecer distinguiveis. `unitClass`/`unitResolutionStatus`
    // espelham o resultado do UnitResolver (src/lib/units) so pra evitar
    // reprocessar a classificacao em toda leitura de tela/relatorio.
    unitRaw: text('unit_raw'),
    unitNormalized: text('unit_normalized'),
    unitClass: text('unit_class', { enum: ['HUNDRED', 'DIRECT', 'PACKAGE_MEASURED'] }),
    unitResolutionStatus: text('unit_resolution_status', { enum: ['OK', 'UNSUPPORTED_UNIT', 'CONFIGURATION_REQUIRED', 'NO_STOCK_RECORD'] }),

    // ultimo valor calculado pelos motores (preco/estoque de destino)
    calculatedWakeUnitPrice: real('calculated_wake_unit_price'),
    calculatedWakeSpecialPrice: real('calculated_wake_special_price'), // preco/cento (>= WHOLESALE_MIN_QTY)
    calculatedWakeStock: integer('calculated_wake_stock'),

    // ultimo valor confirmado como aplicado no Wake (pos-escrita, idealmente
    // reverificado via leitura -- nunca soh assumido a partir do payload enviado)
    lastAppliedWakeUnitPrice: real('last_applied_wake_unit_price'),
    lastAppliedWakeSpecialPrice: real('last_applied_wake_special_price'),
    lastAppliedWakeStock: integer('last_applied_wake_stock'),
    lastAppliedAt: text('last_applied_at'),
    lastSyncRunId: integer('last_sync_run_id').references(() => syncRuns.id),

    updatedAt: text('updated_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => ({
    managedProductIdIdx: uniqueIndex('sync_product_state_managed_product_id_idx').on(t.managedProductId),
  }),
)

/**
 * Configuracao de conversao pra produtos PACKAGE_MEASURED (KG/MT) -- ver §9 e
 * §10 do FASE B. Generica (uma tabela so, nao uma por UNIT): `sourceUnit`
 * diz qual UNIT do CISS essa config atende, `quantityPerSaleUnit` e quantos
 * kg/m formam 1 unidade vendavel no Wake. Sem uma linha ativa aqui pro
 * produto, o motor (src/lib/units) retorna CONFIGURATION_REQUIRED e nao
 * escreve nada -- nunca assume "1 KG" ou "1 MT" por padrao.
 *
 * BLOQUEIO B (FASE B.2, 16/09/2026): `wake_sku` foi removida desta tabela.
 * Era denormalizada de managed_products.wake_sku, podia divergir, e uma
 * varredura completa do repositorio confirmou que NENHUM consumidor le
 * `productSaleUnitConfig.wakeSku` -- toda a engine de sync/reconciliacao usa
 * exclusivamente `managedProducts.wakeSku` (join por `managed_product_id`,
 * que ja e a identidade canonica desta tabela). Uma camada de importacao
 * futura (FASE 7) resolve SKU -> managed_product_id antes de gravar aqui,
 * nunca precisando desnormalizar de volta.
 */
export const productSaleUnitConfig = sqliteTable(
  'product_sale_unit_config',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    managedProductId: integer('managed_product_id')
      .notNull()
      .references(() => managedProducts.id),
    sourceUnit: text('source_unit', { enum: ['KG', 'MT'] }).notNull(),
    quantityPerSaleUnit: real('quantity_per_sale_unit').notNull(),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text('updated_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedBy: text('updated_by'), // usuario do Portal (X-Auth-User)
  },
  (t) => ({
    managedProductIdIdx: index('product_sale_unit_config_managed_product_id_idx').on(t.managedProductId),
    // No maximo 1 config ATIVA por produto -- evita duas configs conflitantes
    // pro mesmo managed_product_id (ver §10). Desativar a antiga antes de
    // ativar uma nova, nunca duas ativas ao mesmo tempo.
    oneActivePerProductIdx: uniqueIndex('product_sale_unit_config_one_active_idx')
      .on(t.managedProductId)
      .where(sql`${t.active} = 1`),
    quantityPositiveCheck: check('product_sale_unit_config_quantity_positive', sql`${t.quantityPerSaleUnit} > 0`),
    // BLOQUEIO A (FASE B.2): antes so o enum TypeScript acima restringia
    // source_unit a KG/MT -- sem CHECK no SQL, uma insercao direta (fora do
    // Drizzle, ex: script solto/import futuro) podia gravar qualquer texto.
    sourceUnitCheck: check('product_sale_unit_config_source_unit_check', sql`${t.sourceUnit} IN ('KG', 'MT')`),
  }),
)

/**
 * Uma linha por execucao do motor de sincronizacao -- manual (web) ou
 * agendada (worker), incluindo a reconciliacao diaria. dry_run=1 nunca
 * escreve no Wake, soh calcula e registra o que faria.
 */
export const syncRuns = sqliteTable(
  'sync_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind', { enum: ['price', 'stock', 'both', 'reconciliation'] }).notNull(),
    trigger: text('trigger', { enum: ['manual', 'scheduled', 'reconciliation'] }).notNull(),
    triggeredBy: text('triggered_by'), // usuario do Portal (X-Auth-User) quando trigger=manual
    dryRun: integer('dry_run', { mode: 'boolean' }).notNull().default(false),
    status: text('status', { enum: ['running', 'success', 'partial', 'failed'] }).notNull().default('running'),

    totalProducts: integer('total_products').notNull().default(0),
    changedProducts: integer('changed_products').notNull().default(0),
    appliedProducts: integer('applied_products').notNull().default(0),
    skippedProducts: integer('skipped_products').notNull().default(0),
    failedProducts: integer('failed_products').notNull().default(0),

    errorSummary: text('error_summary'),
    startedAt: text('started_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    finishedAt: text('finished_at'),
  },
  (t) => ({
    startedAtIdx: index('sync_runs_started_at_idx').on(t.startedAt),
    statusIdx: index('sync_runs_status_idx').on(t.status),
  }),
)

/**
 * Detalhe por produto dentro de uma execucao -- e a trilha de auditoria
 * exigida pela especificacao (secao 62): valor antigo/novo de origem,
 * valor antigo/novo de destino, estado do Wake antes/depois, status/erro.
 * Nunca grava token nenhum aqui.
 */
export const syncRunItems = sqliteTable(
  'sync_run_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    syncRunId: integer('sync_run_id')
      .notNull()
      .references(() => syncRuns.id),
    managedProductId: integer('managed_product_id')
      .notNull()
      .references(() => managedProducts.id),

    field: text('field', { enum: ['unit_price', 'special_price', 'stock'] }).notNull(),

    sourceOldValue: real('source_old_value'),
    sourceNewValue: real('source_new_value'),
    targetOldValue: real('target_old_value'),
    targetNewValue: real('target_new_value'),

    wakeBeforeRaw: text('wake_before_raw'), // JSON snapshot da leitura de verificacao (sem token)
    wakeAfterRaw: text('wake_after_raw'),

    // 'mismatch' (FASE C §6): distinto de 'failed' -- o Wake aceitou a
    // chamada de escrita sem erro, mas a reconferencia (leitura/ACK) achou
    // um valor diferente do enviado. 'failed' continua reservado pra falha
    // da propria chamada (erro HTTP/timeout) ou reconferencia que nao
    // encontrou o item de jeito nenhum. Sem CHECK no SQL (so tipo em TS,
    // igual todo o resto deste enum) -- adicionar este valor nao exige
    // migration.
    status: text('status', { enum: ['no_change', 'planned', 'applied', 'failed', 'mismatch', 'skipped'] }).notNull(),
    errorMessage: text('error_message'),

    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => ({
    syncRunIdIdx: index('sync_run_items_sync_run_id_idx').on(t.syncRunId),
    managedProductIdIdx: index('sync_run_items_managed_product_id_idx').on(t.managedProductId),
    statusIdx: index('sync_run_items_status_idx').on(t.status),
  }),
)

/**
 * Historico de importacoes do CSV de whitelist. Cada import cria/atualiza
 * linhas em managed_products; nunca remove produtos automaticamente (spec
 * exige revisao explicita pra desativar, nao delecao silenciosa).
 */
export const imports = sqliteTable('imports', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  filename: text('filename').notNull(),
  importedBy: text('imported_by'), // usuario do Portal
  totalRows: integer('total_rows').notNull().default(0),
  createdRows: integer('created_rows').notNull().default(0),
  updatedRows: integer('updated_rows').notNull().default(0),
  errorRows: integer('error_rows').notNull().default(0),
  errorDetail: text('error_detail'), // JSON com linhas invalidas, se houver
  status: text('status', { enum: ['success', 'partial', 'failed'] }).notNull(),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
})

/**
 * Configuracao chave/valor -- inclui os valores que a especificacao exige
 * descobrir (nunca inventar) antes de ligar a sincronizacao real:
 * WAKE_CD_ID, WAKE_STOCK_CONTROL_MODE ('fstore'|'erp', validado por
 * SETTING_ENUM_RANGES), WAKE_PRICE_TABLE_ID, WAKE_PROMOTION_ID,
 * CISS_STOCK_ENTERPRISE, CISS_STOCK_LOCATION, UNIT_PRICE_MARKUP_PERCENT,
 * WHOLESALE_MIN_QTY, STOCK_PERCENT. Ver src/lib/settings.ts pro contrato de
 * leitura/default.
 */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value'),
  updatedAt: text('updated_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  updatedBy: text('updated_by'),
})

/**
 * Lock transacional -- garante que o worker agendado e um disparo manual
 * nunca rodem o motor de sincronizacao ao mesmo tempo. Uma linha fixa por
 * "recurso" (ex: 'sync-price', 'sync-stock'); adquirida via INSERT/UPDATE
 * condicional (ver src/lib/sync/engine.ts).
 */
export const jobLocks = sqliteTable('job_locks', {
  resource: text('resource').primaryKey(),
  lockedAt: text('locked_at'),
  lockedBy: text('locked_by'), // ex: "worker:pid1234" ou "web:usuario"
  expiresAt: text('expires_at'),
})

/**
 * Placeholder desabilitado pra feature de "Caixas" (preco por cento) --
 * NAO USAR ate as regras de negocio serem confirmadas pelo usuario (spec
 * pede explicitamente DISABLED nesta primeira etapa). Estrutura minima
 * pra nao bloquear migracoes futuras.
 */
export const boxes = sqliteTable('boxes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  managedProductId: integer('managed_product_id').references(() => managedProducts.id),
  unitsPerBox: integer('units_per_box'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
})

// ---------------------------------------------------------------------------
// Autenticacao propria do Casa Hub (03/09/2026) -- o app deixou de fazer
// parte do ecossistema do Portal Interno (que so roda em horario comercial,
// no servidor atual) e passou a ter login/cadastro proprios, porque vai
// operar 24/7 num servidor separado no futuro. Acesso e GERAL: qualquer
// usuario cadastrado e ativo tem acesso completo, sem tabela de permissao
// por app/feature (ao contrario do user_applications do Portal) -- pedido
// explicito do usuario ("acesso geral, nao precisa filtrar permissoes").
//
// Mesmo padrao de seguranca de sessao do Portal (Portal/app/db.py): `id` da
// sessao guarda o SHA-256 do token, nunca o token em si -- um vazamento do
// arquivo do banco nao permite montar um cookie valido. Hash de senha via
// scrypt do modulo nativo `crypto` do Node (sem dependencia nova, ver
// src/lib/password.ts) -- este projeto ja tem better-sqlite3 como unica
// dependencia nativa e nao ha motivo pra adicionar outra (ex: bcrypt).
// ---------------------------------------------------------------------------

export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    username: text('username').notNull(),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    lastLoginAt: text('last_login_at'),
  },
  (t) => ({
    usernameIdx: uniqueIndex('users_username_idx').on(t.username),
  }),
)

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(), // SHA-256 hex do token -- nunca o token em si
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    expiresAt: text('expires_at').notNull(),
  },
  (t) => ({
    userIdIdx: index('sessions_user_id_idx').on(t.userId),
    expiresAtIdx: index('sessions_expires_at_idx').on(t.expiresAt),
  }),
)
