# Reconciliador READ-ONLY (CISS → UNIT → regra → Wake)

Branch: `audit/reconciliacao-readonly` (base `main` 053434c). **Não mergear sem aprovação.**

Compara, produto a produto da whitelist (`managed_products` ativos), o **CISS real** → **UNIT** (campo `unit` do CISS, fonte de verdade) → **regra de negócio esperada** → **Wake real**. Não corrige nada: só classifica e grava um relatório local.

## Garantias de somente-leitura

| Sistema | O que faz | Como é garantido |
|---|---|---|
| Wake | só `GET` | `scripts/reconcile/http.ts` é o único ponto de rede; o método é fixo em `'GET'` e o tipo `FetchLike` só aceita `'GET'` |
| CISS | só `GET` | mesmo ponto único de rede |
| SQLite | só `SELECT` | `readonly: true` + `fileMustExist: true` + `PRAGMA query_only = ON`; não importa `src/lib/db` (que abre em leitura-escrita e seta WAL) |
| Settings | só leitura | lê a tabela `settings` com SELECT; segredos só são **decifrados** em memória |
| Sync/worker/systemd | nada | não importa `src/lib/sync`, `src/lib/wake/client`, `src/lib/settings` |
| Disco | 2 arquivos | só `artifacts/reconciliation-YYYYMMDD-HHMM.{json,csv}`, com flag `wx` (nunca sobrescreve) |

`scripts/reconcile/no-write-path.test.ts` verifica tudo isso estaticamente (verbos de escrita, `method`, `fetch` fora do `http.ts`, imports da aplicação, SQL de escrita, escrita em disco fora do `output.ts`).

## Regras por UNIT

| UNIT | Estoque esperado | Varejo esperado | Atacado (≥100) |
|---|---|---|---|
| CENTO | `floor(max(s,0) × 100 × 0,10)` | `round2(preço/100 × 1,20)` | `round2(varejo × 0,80)` |
| PC / UN | `floor(max(s,0))` | `round2(preço)` (sem ×100, ÷100 ou markup) | — |
| KG | `floor(kg / kg_por_caixa)` | `round2(preço_kg × kg_por_caixa)` | — |
| KG sem `kg_por_caixa` | — | — | `CONFIGURATION_REQUIRED` (não inventa valor; nenhuma migration criada) |
| ausente/desconhecida | — | — | `UNSUPPORTED_UNIT` (fail closed) |

Na Wake: `precoPor` do produto e `precoPor` da tabela 74 comparados com o varejo esperado (tolerância de R$ 0,005). O `precoDe` é registrado sem julgamento. O atacado é conferido na **promoção** (condição 22 = quantidade 100, ação 20%), lida da Wake — nunca do `lastApplied` local.

## Status por linha

A precedência vai de cima para baixo:

1. `ERROR`: leitura CISS falhou, ou a leitura Wake foi abortada/incompleta.
2. `CISS_MISSING`: `/products/stock` com `data:[]` ou produto sem `retail_price`.
3. `UNSUPPORTED_UNIT`: unit ausente ou fora de CENTO/PC/UN/KG.
4. `CONFIGURATION_REQUIRED`: KG sem `kg_por_caixa`.
5. `WAKE_MISSING`: SKU ausente em `GET /produtos` (só quando a varredura terminou sem abortar).
6. `MATCH` / `PRICE_MISMATCH` / `STOCK_MISMATCH` / `PRICE_AND_STOCK_MISMATCH`.

## Endpoints (todos GET)

Wake (`https://api.fbits.net`, header `Authorization: BASIC <token>`):
- `GET /produtos?centrosDistribuicao=25&quantidadeRegistros=50&produtoVarianteIdDe=<cursor>`: cursor exclusivo, começa em `min(variantId da whitelist) − 1` e para ao passar do `max`. **Não usa `pagina`.**
- `GET /tabelaPrecos/74/produtos?pagina=N&quantidadeRegistros=50`: este endpoint só aceita `pagina`.
- `GET /promocoes/10365`

CISS (`CISS_BASE_URL`, header `Authorization: Bearer <token>`):
- `GET /products/prices/search?product_ids=<até 150>&page=N&per_page=500`: mesma fonte live de produção.
- `GET /products/stock?product_id=<id>`: preserva `product_id`, `unit`, `quantity`, empresa e local (`CISS_STOCK_ENTERPRISE`/`CISS_STOCK_LOCATION`; em produção, local 2).

## Rate limit e abortos

- Wake: serializada, 1 request a cada 2 s (≤ 30 req/min). O token é compartilhado com o worker (120 req/min; 5×429 bloqueiam por 1 h).
  - **Qualquer 429 aborta na hora, sem retry.**
  - 401/403 abortam.
  - 5xx/rede: 1 retry após 5 s.
  - `x-rate-limit-remaining < 15` gera uma pausa de 60 s.
- Com a Wake abortada, o CISS continua sendo lido (a distribuição de UNIT continua útil) e os artefatos são gravados com `meta.aborted = true` (exit code 2).
- CISS: concorrência 3, 2 tentativas; 401/403 derrubam a leitura inteira.

## Estimativa (2318 produtos)

- **Wake:**
  - `/produtos`: `ceil(variantes existentes no intervalo / 50)` páginas. Melhor caso ~47 (intervalo denso); pior caso = catálogo inteiro / 50 (~400 páginas para ~20 mil variantes). `--plan` mostra o limite superior exato.
  - Tabela 74: ~47 páginas.
  - Promoção: 1.
  - **Total: ~95 a ~450 requests, ou seja, ~3 a ~15 min a 30 req/min.**
- **CISS:** 16 requests de preço + 2318 de estoque (concorrência 3), ~5 a 15 min.
- **Total estimado: ~8 a 30 min.**

## Uso

```bash
# plano, sem rede
tsx scripts/reconcile-readonly.ts --root /opt/erp-wake --env-file /opt/erp-wake/.env --plan
# execução
tsx scripts/reconcile-readonly.ts --root /opt/erp-wake --env-file /opt/erp-wake/.env --out /tmp/reconcile/out
```

Flags:
- `--db <path>`: o default é `$DATABASE_PATH` ou `<root>/data/app.db`.
- `--full-scan`: obrigatório se algum `wake_product_variant_id` não for numérico.

Exit codes:
- `0`: ok;
- `2`: concluído com leitura abortada;
- `1`: falha antes de gravar.

O log vai para o stderr: só path, status e contagens. Os tokens aparecem apenas pela **origem** (`db`/`env`/`none`), nunca pelo valor. Antes de gravar, o JSON e o CSV são varridos contra os segredos em memória; se algum aparecer, nada é gravado.

## Saída

`reconciliation-YYYYMMDD-HHMM.json` contém:
- `meta`: modo, duração, abortos, número de requests, config, regras, avisos e settings observados vs. regra canônica;
- `aggregates`;
- `promotion_check`;
- `wake_scan`;
- `rows`.

O `.csv` traz as colunas da spec mais `unit_raw`, `ciss_enterprise`, `ciss_location`, `wake_variant_id_actual`, `wake_preco_de` e `price_table_preco_de_actual`.
