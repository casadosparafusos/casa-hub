# AUDIT_RUNTIME_REPORT — FASE 0 (READ-ONLY)

**Data:** 10/09/2026, ~16:50–17:30 (-03)
**Branch:** `audit/fase-0-runtime-readonly`
**SHA inicial (baseline = `main` = `origin/main`):** `053434ce0209c406add5020fe1c2d259d138e165`
**Host:** `10.0.247.6` (hostname `Einstein`, servidor de produção do SIGAS), app em `/opt/erp-wake`, usuário `erpwake`
**Modo:** somente leitura. Nenhuma escrita na Wake, no CISS, no SQLite ou no systemd. Nenhum segredo impresso.

## STATUS: `PARTIAL`

O runtime foi certificado: provider `live`, systemd e código implantado igual ao `main`.
A reconciliação ao vivo contra a Wake **não foi executada**. Pela regra do protocolo ("nunca declarar PASS se a Wake não tiver sido validada por leitura"), o status não pode ser PASS.

---

## 1. Como a auditoria foi feita

- Leitura via SSH (`suporte@10.0.247.6`), usando apenas:
  - `systemctl show` / `is-enabled` / `is-active`, `journalctl`, `ss`, `ps`;
  - `sha256sum`, `find`;
  - `sqlite3 -readonly` com `file:...?mode=ro`;
  - `curl` sem sessão na porta 8083.
- Do `.env` foram lidos **só os nomes das chaves** e os valores não secretos (`DATABASE_PATH`, `CISS_BASE_URL`, `CISS_PRICE_PROVIDER`). Os tokens e o `SETTINGS_SECRET_KEY` foram checados apenas como SET ou UNSET.
- **Não foi executado nenhum script da aplicação no servidor.** A execução de script remoto foi bloqueada pela política desta sessão e respeita a regra "não mexer na versão funcional".
- Os tokens Wake/CISS existem só no servidor e não foram extraídos. Por isso não houve chamada à Wake nem ao CISS.

## 2. Git

| Item | Valor |
|---|---|
| remote | `https://github.com/casadosparafusos/casa-hub.git` (o SSH `git@github.com:` não autentica nesta estação; o push sai por HTTPS) |
| `main` local | `053434c` |
| `origin/main` | `053434c` |
| working tree antes | limpo, exceto os docs canônicos não rastreados (commitados em `62e54e7`) |
| `main` alterado? | **não** |

## 3. Código implantado × repositório

- **71 arquivos** idênticos ao `main` `053434c` (sha256 comparado arquivo a arquivo): `src/`, `worker/`, `drizzle/`, `scripts/`, `package.json`, `package-lock.json` e `next.config.mjs`.
- As units instaladas em `/etc/systemd/system/erp-wake-{web,worker}.service` são idênticas a `deploy/*.service` do repositório.
- **Sobras no servidor, inofensivas e não usadas:**
  - `/opt/erp-wake/deploy/*`: cópia antiga de 03/09;
  - `scripts/whitelist-fixadores-inactive.csv`: extra, fora do Git;
  - um arquivo vazio literalmente chamado `*.db` em `/opt/erp-wake`.

## 4. systemd

| | web | worker |
|---|---|---|
| unit | `erp-wake-web.service` | `erp-wake-worker.service` |
| enabled | enabled | enabled |
| active | active (running) | active (running) |
| Restart | `always`, `RestartUSec=5s` | `always`, `RestartUSec=5s` |
| NRestarts | 0 | 0 |
| início | 10/09 13:02:09 | 10/09 13:02:09 |
| MainPID | 465676 (`next-server v15.5.25`) | 465677 (cli tsx) → 465701 (node loader) → 465715 (esbuild) |
| porta | 8083 (next-server) | — |

- **Worker em uma única instância lógica.** A árvore pai/filho é o padrão do `tsx`, não uma duplicata. O lock `sync-stock` estava com o owner `pid465701`, o mesmo processo.
- O journal não registra restart, stop nem crash desde a instalação, e o web não teve warning em 24 h.
- **NÃO testados:** restart após `kill`, catch-up após reboot e SIGTERM no meio de uma run. Esses testes alteram produção num servidor que também é do ERP e precisam de janela aprovada (ver §10).

## 5. Configuração efetiva

### `.env` (só nomes e valores não secretos)

| Chave | Valor |
|---|---|
| `DATABASE_PATH` | `/opt/erp-wake/data/app.db` |
| `CISS_BASE_URL` | `http://sigas.casadosparafusos.com:5099/api/ciss` |
| **`CISS_PRICE_PROVIDER`** | **`live`** |
| `CISS_API_TOKEN` | SET |
| `WAKE_ADMIN_API_TOKEN` | SET |
| `SETTINGS_SECRET_KEY` | SET |

**Resultado do gate de mock:** o provider é `live`, então **não há P0/FAIL de mock em produção hoje**. O risco estrutural continua existindo: o default do código é `mock` (`src/lib/ciss/price-provider.ts:62`) e não há guard. Ver P0-1.

### Settings no SQLite

| Chave | Valor | Observação |
|---|---|---|
| `CISS_API_TOKEN` | SET (criptografado) | tem prioridade sobre o `.env` |
| `WAKE_ADMIN_API_TOKEN` | — | vem do `.env` |
| `CISS_STOCK_ENTERPRISE` | (ausente) → default 2 | |
| `CISS_STOCK_LOCATION` | 2 | |
| `WAKE_CD_ID` | 25 | |
| `WAKE_PRICE_TABLE_ID` | 74 | |
| `WAKE_PROMOTION_ID` | 10365 | **não é lido pelo motor** |
| `WAKE_STOCK_CONTROL_MODE` | fstore | **não é lido pelo motor** |
| `CSV_IDENTIFIER_TYPE` | sku | **não é lido pelo motor** (`tipoIdentificador: 'Sku'` fixo no código) |
| `UNIT_PRICE_MARKUP_PERCENT` | 20 | |
| `WHOLESALE_MIN_QTY` | 100 | **não governa nada**; a regra ≥100 vive na promoção 10365 da Wake |
| `STOCK_PERCENT` | 10 | proposital |
| `PRICE_SYNC_INTERVAL_HOURS` | 24 | |
| `STOCK_SYNC_INTERVAL_MINUTES` | 1 | |
| `RECONCILIATION_HOUR_LOCAL` | (ausente) → default 3 | |

### Endpoints e alvos

- **CISS preço:** `POST /products/prices/search`, em lotes de 150.
- **CISS estoque:** `GET /products/stock?product_id=...`, enterprise 2 e location 2.
- **Wake:**
  - CD 25, tabela de preço 74, promoção 10365 ("PREÇO CENTO - FIXADORES");
  - a promoção foi validada ao vivo em 04/09 (quantidade 100, −20%) e **não foi revalidada hoje**.

## 6. Banco (SQLite, só leitura)

### Whitelist

2318 produtos: 2318 ativos, 0 inativos.

### Estado local (`sync_product_state`)

- **Estoque:**
  - `calculated_wake_stock` bate com a regra CENTO recomputada, `floor(max(erp,0)×100×0,10)`, em **2318/2318**;
  - `last_applied = calculated` em 2318/2318;
  - ERP negativo em 44 produtos, zero em 35.
- **Preço:**
  - 2317 com preço, 1 sem (ciss 28875);
  - `last_applied = calculated` em 2317/2317;
  - 7 aparentes divergências de "calculado × regra" são **artefato do `round()` do SQLite** em empates de meio centavo (0,225 → 0,23 no JS com `EPSILON`; o SQLite dá 0,22). O motor está correto.
- **Unidades:** `erp_stock` é declarado `integer`, mas **2221/2318 estão gravados como REAL** (fracionário, CENTO). O valor está correto, o tipo declarado não.
- **Importante:** `last_applied` **não é a Wake**. Esta seção prova só a coerência interna, não o estado da loja.

### Runs

| kind | trigger | runs |
|---|---|---|
| both | manual | 26 |
| both | scheduled | 25 |
| price | manual | 12 |
| price | scheduled | 2 |
| stock | scheduled | 271 |
| **qualquer** | **reconciliation** | **0 (nunca rodou)** |

- **Estoque:**
  - cada run leva ~2,3–2,5 min e começa a cada ~4 min;
  - cerca de 3 ticks por ciclo terminam em "pulado (lock em uso)";
  - desde a migração (16:01Z), 59 runs de estoque: 23 no-op e 0 com falha de run.
- **Itens desde a migração:** 138.902 `no_change`, 211 `applied`, 2 `skipped`. Mais de 99,8% do volume de histórico é no-op.
- **Total histórico:** 380.908 linhas em `sync_run_items`.
- **Falhas em 24 h:**
  - 4083 "Wake aceitou... reconferência não confirmou", entre 09/09 13:19Z e **10/09 12:46Z**. Todas são **anteriores** à correção do ACK de estoque e à migração; **nenhuma desde então**.
  - 41 por produto de "Sem leitura de estoque CISS" para os produtos 1273, 28875 e 28899 (o CISS não devolve leitura).
  - 3 de "Sem preço de origem" para o 28875.
- **Auth:** 1 usuário ativo, 17 sessões válidas.

## 7. HTTP (sem sessão)

| rota | status |
|---|---|
| `GET /api/settings` | **200** (deveria ser 401) |
| `GET /login` | 200 |
| `GET /healthz`, `/readyz` | 404 (não existem) |

- O `GET /api/settings` sem cookie devolve **os valores não secretos** (CD, tabela, promoção, regras) e **booleanos** para os segredos.
- **Nenhum token vaza.** Mesmo assim, expõe configuração sem autenticação (`src/app/api/settings/route.ts:27`).

## 8. Achados validados (com evidência)

| # | Achado | Evidência | Status |
|---|---|---|---|
| A1 | Motor de preço é CENTO-only: sempre divide por 100 | `src/lib/pricing/engine.ts:59` | CONFIRMADO |
| A2 | Motor de estoque é CENTO-only: sempre multiplica por 100 | `src/lib/inventory/engine.ts` e o teste `engine.test.ts:19` | CONFIRMADO |
| A3 | `unit` do CISS é descartado; não há coluna de UNIT | `src/lib/db/schema.ts` | CONFIRMADO |
| A4 | Provider cai em `mock` por default, sem guard para write | `src/lib/ciss/price-provider.ts:62` | CONFIRMADO no código; produção está `live` |
| A5 | Diff de preço compara com `lastApplied*`, não com a Wake: não detecta drift manual na Wake | `src/lib/sync/engine.ts:276` | CONFIRMADO |
| A6 | Reconciliação reusa `runSync('both')` e o mesmo diff (A5); não é uma reconciliação | `worker/index.ts:91-95`, `engine.ts:89` | CONFIRMADO |
| A7 | Reconciliação nunca rodou: 0 runs `reconciliation` na história inteira (ver o texto abaixo da tabela) | `worker/index.ts:37,68,92-95` e a tabela `sync_runs` | CONFIRMADO |
| A8 | Tabela de preço: POST/PUT sem readback depois da escrita; `changed++` e `applied++` contam o mesmo produto de novo | `engine.ts:444-445` | CONFIRMADO |
| A9 | Tabela 74 usa `precoDe = precoPor × 1,30` (desconto "fake" de 30%) | `engine.ts:227,326` | CONFIRMADO (decisão de negócio a validar) |
| A10 | Estoque: o ACK do PUT não substitui a leitura do CD; falta ler o estoque real por SKU/CD | `GET /produtos/{sku}` devolve `estoque[]` vazio; `GET /produtos?centrosDistribuicao=25` devolve estoque por CD | CONFIRMADO (doc Wake) |
| A11 | No-change persistido em massa (138.902 linhas em ~1,5 h) | `engine.ts:280,513` e a contagem em §6 | CONFIRMADO |
| A12 | O scheduler usa `sync_runs` como relógio; não dá para cortar o histórico no-op sem `sync_status` | `worker/index.ts:44,80,86` | CONFIRMADO |
| A13 | `setInterval` sem serializar os ticks gera ~3 "lock em uso" por ciclo | `worker/index.ts:114` e o journal | CONFIRMADO |
| A14 | SIGTERM faz `process.exit(0)` sem esperar a run; a run órfã é recuperada no boot | `worker/index.ts:128` | CONFIRMADO (restart não testado) |
| A15 | `GET /api/settings` sem autenticação | `route.ts:27` e o probe HTTP 200 | CONFIRMADO |
| A16 | `CSV_IDENTIFIER_TYPE`, `WAKE_PROMOTION_ID` e `WAKE_STOCK_CONTROL_MODE` são só informativos; a UI afirma que o primeiro governa o `tipoIdentificador` | `configuracoes/page.tsx:13`, `settings.ts:25-28` | CONFIRMADO |
| A17 | `WHOLESALE_MIN_QTY` não governa nada; a regra ≥100 está na promoção 10365 | `pricing/engine.ts` só repassa o valor | CONFIRMADO |
| A18 | Texto da UI em `/precos` diz que "≥100 = preço bruto do ERP (sem markup)", o que contradiz o PRICE_RULES (0,96 × base) | `precos/page.tsx:30` | CONFIRMADO (só texto; o comportamento real está certo, ver abaixo) |
| A19 | `erp_stock` é `integer` no schema, mas o valor é fracionário | §6 | CONFIRMADO |
| A20 | `wakeSpecialPrice` (= P) é calculado e guardado, mas nunca é escrito na Wake | `engine.ts` (`syncPrices`) | CONFIRMADO (código morto enganoso) |
| A21 | Histórico da UI: 50 runs e 500 itens fixos, sem priorizar falhas | `historico/page.tsx` | CONFIRMADO |
| A22 | Sem single-SKU, sem toggle da whitelist, sem SSE | UI e rotas | CONFIRMADO |

**Sobre A7, por que a reconciliação nunca rodou:**
- ela só dispara no tick exato de `HH:00`;
- se o lock `sync-stock` estiver em uso, o `LockUnavailableError` é engolido e a data já foi marcada em memória, então não há nova tentativa no mesmo dia;
- o estoque segura o lock cerca de 60% do tempo;
- neste host, o worker ainda não passou por nenhum 03:00.

### Política de preço vigente em produção (validação da regra)

Para fixador CENTO com P = preço CISS por cento:
- **base/varejo na Wake** = `moneyRound(P/100 × 1,20)`;
- **promoção 10365**: quantidade ≥ 100 → −20% sobre o varejo → **0,96 × P/100**.

**Isso BATE com `docs/PRICE_RULES.md`.** Não é bug. Estão errados apenas o texto da UI (A18) e o comentário/campo `wakeSpecialPrice` (A20).

**Ressalva:** a promoção 10365 não foi relida hoje. Ela entra na reconciliação ao vivo.

### Risco de paginação Wake (21/09/2026)

- A depreciação de `pagina` está **confirmada só para `GET /produtos`**, que o código hoje não usa.
- O código usa `pagina` em três rotas:
  - `GET /tabelaPrecos/{id}/produtos?pagina`: **usada em toda run de preço**;
  - `GET /promocoes?pagina`;
  - `GET /produtos/alteracoes?pagina`: sem chamador.
- Se a depreciação se estender a essas rotas, o sync de preço quebra a partir de 21/09. **Precisa de confirmação com a Wake antes de 21/09.**

## 9. Riscos P0

1. **P0-1 — Guard de provider.**
   - Hoje está `live`, mas um `.env` sem a chave cai em `mock`, e o mock escreve na Wake.
   - Guard: bloquear o write se `provider !== 'live'`.
2. **P0-2 — Não existe reconciliação real (A5–A7).**
   - O estado da Wake nunca foi comparado ao vivo com CISS → esperado.
   - Drift manual na Wake (preço, estoque ou tabela) passa despercebido indefinidamente.
3. **P0-3 — Tabela de preço sem readback (A8).**
4. **P0-4 — UNIT.**
   - Qualquer produto não-CENTO na whitelist hoje recebe preço ÷100 e estoque ×100.
   - A distribuição real de UNIT dos 2318 é **desconhecida**, porque depende de leitura CISS no servidor.
5. **P0-5 — Paginação `pagina` em `/tabelaPrecos` e `/promocoes`** antes de 21/09 (não confirmado).
6. **P0-6 — Restart e reboot não comprovados na prática.** A configuração está correta, mas o teste de kill/reboot não foi feito.

**P1 relevantes:**
- `GET /api/settings` sem auth;
- histórico no-op massivo (A11/A12);
- ticks não serializados (A13);
- `erp_stock` com tipo errado;
- textos de UI e settings sem efeito;
- 3 produtos sem leitura CISS (1273, 28875, 28899).

## 10. O que NÃO foi executado, e por quê

| Item | Motivo | O que desbloqueia |
|---|---|---|
| Reconciliação ao vivo (CISS → UNIT → esperado → Wake) | Exige tokens, que só existem no servidor, e execução de script lá, bloqueada | O usuário autorizar um script **só leitura** (GET only, ≤30 req/min, para no primeiro 429, saída CSV/JSON) no servidor, ou fornecer um caminho seguro para os tokens chegarem ao ambiente de auditoria sem serem impressos |
| Distribuição de UNIT (CENTO/PC/UN/KG/sem UNIT) | Mesma razão: exige leitura CISS de `/products/stock` | Mesmo script |
| Checkout 1/99/100/101 | É teste de carrinho na loja real, fora do escopo read-only | Janela e autorização |
| Restart após kill e catch-up após reboot | Altera produção no servidor do ERP | Janela aprovada |

**Cuidado com o token Wake:** ele é compartilhado com o worker de produção. Uma leitura em massa precisa respeitar o limite de 120 req/min e o risco de bloqueio do token por 1 h depois de 5 respostas 429. Por isso o teto proposto é ≤30 req/min.

## 11. Próxima ação exata

Aprovar, **em chat**, uma destas opções:

**(a)** Uma branch `audit/reconciliacao-readonly` com o script `scripts/reconcile-readonly.ts`.
- **Wake:** `GET /produtos?centrosDistribuicao=25&quantidadeRegistros=50&produtoVarianteIdDe=<cursor>`, `GET /tabelaPrecos/74/produtos` e `GET /promocoes/10365`.
- **CISS:** preço e `/products/stock` com `unit`.
- **Garantias:**
  - zero write;
  - teto de 30 req/min;
  - aborta no primeiro 429;
  - saída em `reconciliation-<data>.json` e `.csv`;
  - testado localmente com mocks.
- Depois disso, a sua autorização para rodá-lo **uma vez** no servidor como `erpwake`.

**(b)** Uma janela para o teste de restart: `systemctl kill -s KILL erp-wake-worker`, confirmar o retorno em ≤5 s com instância única e sem duplicar a run, e depois o mesmo com o web.
