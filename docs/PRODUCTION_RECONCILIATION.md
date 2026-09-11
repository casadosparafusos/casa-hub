# Reconciliação READ-ONLY em produção — 11/09/2026

Execução única, aprovada, do reconciliador READ-ONLY ([RECONCILIATION_READONLY.md](RECONCILIATION_READONLY.md)) contra CISS e Wake reais. **Nada foi corrigido.** Este documento só registra o que foi lido.

## Identificação

| Item | Valor |
|---|---|
| Branch | `audit/reconciliacao-readonly` |
| SHA executado | `c7616d7` (reconcile: estoque Wake explícito, CISS concorrência 1, promoção estrita) |
| Servidor | `10.0.247.6`, usuário `erpwake` |
| Diretório de execução | `/tmp/reconcile-20260911-1021` (cópia do commit `c7616d7`; `/opt/erp-wake` **não** foi alterado) |
| Comando | `tsx <tmp>/scripts/reconcile-readonly.ts --root /opt/erp-wake --env-file /opt/erp-wake/.env --out <tmp>/out` |
| Início / fim (UTC) | 2026-09-11 13:22:29 → 13:37:42 |
| Duração real | **15 min 13 s** (`duration_ms` = 912.839) |
| Exit code | 0 |

Verificações locais antes do envio (no SHA `c7616d7`):

- `npm test`: 10 arquivos, **164/164** passaram;
- `npm run typecheck`: exit 0;
- `npm run build`: ok.

O que **não** foi feito:

- nenhuma alteração em `/opt/erp-wake`, no SQLite ou no systemd; `erp-wake-web` e `erp-wake-worker` ficaram ativos o tempo todo, sem restart;
- nenhum `runSync`;
- nenhum PUT, POST, PATCH ou DELETE;
- sem `--full-scan`;
- nenhuma divergência corrigida.

## Saída do `--plan` (completa, sem segredos)

```
[env] 6 variaveis carregadas de .env (valores nao exibidos)
[db] lendo em modo somente-leitura: /opt/erp-wake/data/app.db
[db] 2318 produtos ativos; CD=25 tabela=74 promocao=10365 CISS empresa=2 local=2
[db] intervalo produtoVarianteId da whitelist: 278078..283202
[plan] Wake GET /produtos: <= 103 (limite superior pelo intervalo; real = variantes existentes no intervalo / 50) paginas; GET /tabelaPrecos/74/produtos: ~48 paginas (se a tabela tiver so a whitelist); GET /promocoes/10365: 1
[plan] Wake: 1 request a cada 2s (30 req/min) -- tempo ~ total de requests / 30 minutos
[plan] CISS: 16 requests de preco + 2318 de estoque (concorrencia 1, sequencial)
[plan] ---- confirmacao ----
[plan] produtos ativos (whitelist)  = 2318
[plan] Wake CD                      = 25
[plan] Wake tabela de preco         = 74
[plan] Wake promocao                = 10365
[plan] CISS empresa                 = 2 (default)
[plan] CISS local                   = 2 (settings/env)
[plan] full-scan                    = false
[plan] GET /produtos camposAdicionais = Estoque
[plan] CISS stock concurrency       = 1
[plan] Wake teto                    = 30 req/min; aborta no 1o 429/401/403
[plan] saida                        = /tmp/reconcile-20260911-1021/out
[plan] nenhuma chamada de rede feita (--plan)
```

Os 8 itens de confirmação bateram com o esperado:

- 2318 ativos;
- CD 25;
- tabela 74;
- promoção 10365;
- CISS empresa 2 e local 2;
- sem full-scan;
- nenhum segredo na saída.

A empresa 2 vem do default do script, que é o mesmo default de produção (`src/lib/settings.ts`, `CISS_STOCK_ENTERPRISE: 2`).

## Requests

| Fonte | Requests | Detalhe |
|---|---|---|
| Wake | **144** | 96 páginas de `GET /produtos` (cursor `produtoVarianteIdDe`, sem `pagina`, `camposAdicionais=Estoque` em todas) + 47 páginas de `GET /tabelaPrecos/74/produtos` + 1 `GET /promocoes/10365` |
| CISS | **2334** | 16 de preço (`/products/prices/search`, lotes de 150) + 2318 de estoque (`/products/stock`), sequenciais |

Comportamento observado:

- Wake:
  - 1 request a cada ~2 s;
  - menor `rate-limit restante` observado: 89 de 120;
  - **nenhuma** resposta diferente de 2xx (nenhum 429, 401, 403 ou 5xx).
- CISS:
  - nenhum erro, nenhum retry;
  - preços em ~13 s; estoque em ~10 min 14 s.

Linha do tempo (UTC):

| Etapa | Período |
|---|---|
| Wake `/produtos` | 13:22:30 → 13:25:39 |
| Wake tabela de preço | 13:25:41 → 13:27:13 |
| Wake promoção | 13:27:15 |
| CISS preços | 13:27:15 → 13:27:28 |
| CISS estoque | 13:27:28 → 13:37:42 |

Wake e CISS rodaram em sequência (primeiro a Wake, depois o CISS).

## Resultado

### Leitura

| Métrica | Valor |
|---|---|
| whitelist_total | 2318 |
| wake_found / wake_missing | 2318 / **0** |
| ciss_found / ciss_missing | 2315 / **3** |
| Estoque Wake verificável | **sim**: `estoque[]` presente em 4800/4800 produtos varridos, 0 ausentes; `stock_unverifiable` = 0 |
| errors | **0** |
| warnings | nenhum |
| settings_divergences | nenhuma (UNIT_PRICE_MARKUP_PERCENT 20, STOCK_PERCENT 10, WHOLESALE_MIN_QTY 100, CISS_PRICE_PROVIDER live) |

### Distribuição de UNIT (campo `unit` do CISS)

| UNIT | Qtde |
|---|---|
| CENTO | **0** |
| PC | 16 |
| UN | 0 |
| KG | 1 |
| unsupported | **2298** (todos com `unit` = `"CT"`) |
| missing | 0 (os 3 CISS_MISSING não têm registro de estoque, logo não têm `unit`) |

`unit_raw_distribution` = `{"CT": 2298, "PC": 16, "KG": 1}`.

### Comparações

| Métrica | Match | Mismatch |
|---|---|---|
| Preço (varejo, `precoPor`) | 0 | 16 |
| Estoque (CD 25) | 3 | 13 |
| Tabela de preço 74 (`precoPor`) | 0 | 16 |

Só as 16 linhas PC foram comparadas. As 2298 CT ficaram fora por fail closed, e o KG ficou em configuração pendente.

### Status por linha

| Status | Qtde |
|---|---|
| MATCH | 0 |
| PRICE_MISMATCH | 3 |
| STOCK_MISMATCH | 0 |
| PRICE_AND_STOCK_MISMATCH | 13 |
| CISS_MISSING | 3 |
| WAKE_MISSING | 0 |
| UNSUPPORTED_UNIT | 2298 |
| CONFIGURATION_REQUIRED | 1 |
| ERROR | 0 |

### Promoção 10365 — `UNVERIFIED`

| Check | Resultado |
|---|---|
| ativo | ✅ true |
| vigente | ✅ true (2026-09-03 → 2094-01-01) |
| quantidade = 100 | ❓ não determinável |
| ação = desconto percentual de 20 | ❓ não determinável |
| escopo cobre a whitelist | ❓ não determinável |

Nome: `[20%[ a partir de 100 fixadores`. Estrutura real devolvida pela Wake (`raw`, preservado no JSON):

```json
"condicoes": [{"promocaoCondicaoId": 4, "promocaoLogicaId": 3, "argumentos": [{"nrOrdem": 1, "valor": "23085"}, {"nrOrdem": 2, "valor": "100"}]}],
"acoes":     [{"promocaoAcaoId": 2, "argumentos": [{"nrOrdem": 1, "valor": "20.00"}]}]
```

O analisador procurava a condição 22 e ela não existe. Existe a **condição 4** (lógica 3), com argumentos `23085` e `100`. A ação 2 tem argumento `20.00`, mas nenhum descritor textual; e não há lista explícita de produtos/SKUs.

**Hipótese não verificada:** a condição 4 seria "quantidade ≥ 100 de itens do grupo/hotsite 23085", e a ação 2 seria "desconto percentual". A semântica dos IDs 4, 3 e 2 e o que é `23085` precisam ser confirmados no painel ou na documentação da Wake antes de qualquer PASS. Pela regra estrita, o resultado correto é `UNVERIFIED`. A promoção não bloqueou a reconciliação de preço e estoque.

## Achados (nenhum corrigido)

### 1. `unit` do CISS é `"CT"`, não `"CENTO"` — 2298 produtos (DECISÃO PENDENTE)

O CISS devolve `unit = "CT"` para 2298 dos 2318 fixadores. Como a regra aprovada só reconhece `CENTO`, `PC`, `UN` e `KG`, o reconciliador fez fail closed e marcou `UNSUPPORTED_UNIT`, sem comparar preço nem estoque dessas linhas.

Mapear `CT → CENTO` é uma **mudança funcional na regra** e **não foi feita**. Precisa de aprovação.

**Simulação informativa**, que não faz parte do relatório oficial: aplicando em memória a regra CENTO às 2298 linhas CT, com as mesmas funções puras do reconciliador (`computeExpected`, `pricesMatch`) sobre o JSON gerado:

| | Match | Mismatch |
|---|---|---|
| Preço varejo | 2298 | 0 |
| Tabela 74 | 2298 | 0 |
| Estoque | 2297 | 1 |

A única divergência de estoque é o SKU `6837`: CISS 1,48 CT → esperado 14; Wake 17. É compatível com movimentação de estoque entre o último sync do worker e a leitura, mas não foi investigada.

Ou seja: se CT for aprovado como sinônimo de CENTO, produção está coerente em 2297 de 2298 produtos.

### 2. Os 16 produtos PC estão publicados na Wake com a regra de CENTO

Nos 16 casos, os números da Wake são exatamente o resultado da fórmula CENTO aplicada a um item que o CISS diz ser PC. Exemplo, SKU 270:

- CISS: R$ 2,07, estoque 1894;
- Wake: R$ 0,02 (= 2,07 ÷ 100 × 1,2), estoque 18.940 (= 1894 × 100 × 10%);
- esperado para PC: R$ 2,07 e estoque 1894.

Isso confirma, com dados reais, o que já se sabia do código: o motor de produção aplica CENTO a tudo, sem consultar `unit`.

- 3 são só PRICE_MISMATCH, porque o estoque é 0 nos dois lados: SKUs 355, 15123 e 16527.
- 13 são PRICE_AND_STOCK_MISMATCH: 270, 503, 17894, 12983, 24339, 13064, 359, 13093, 494, 26022, 5418, 5419 e 5420.

Nenhum desses produtos foi corrigido.

### 3. KG — 1 produto em CONFIGURATION_REQUIRED

SKU `12852`: CISS R$ 28,33/KG, estoque 2008,038 KG. A Wake publica R$ 0,34 e estoque 20.080, ou seja, também com a fórmula CENTO. Não existe `kg_por_caixa` cadastrado, e o valor não foi inventado. Nenhuma migration foi criada.

### 4. CISS_MISSING — 3 produtos

`GET /products/stock` responde `data: []` (sem linha de saldo) para os 3. Produção trata esse caso como estoque 0, e a Wake está com estoque 0 nos três.

| SKU | Preço CISS | Wake precoPor |
|---|---|---|
| 1273 | 5776,02 | 69,31 |
| 28875 | null (sem `retail_price` no CISS) | 3,40 |
| 28899 | 369,52 | 4,43 |

São os mesmos 3 já conhecidos como "CISS sem leitura". Sem `unit`, não há regra aplicável.

### 5. Tabela de preço 74

`precoPor` da tabela é igual ao `precoPor` do produto nas 16 linhas comparadas, e as duas coisas divergem do esperado para PC pelo mesmo motivo do achado 2. O `precoDe` da tabela fica em ~1,3× o `precoPor` (ex.: 0,02 → 0,03). Isso foi registrado sem julgamento, conforme a regra.

## Arquivos para auditoria

| Arquivo | Tamanho | SHA-256 |
|---|---|---|
| [reconciliation-20260911-1037.json](reconciliation/reconciliation-20260911-1037.json) | 1.885.489 B | `0e0f9875e9cd859721abf9920cf516382109ac2e9e77bff24badc24c6e12816a` |
| [reconciliation-20260911-1037.csv](reconciliation/reconciliation-20260911-1037.csv) | 274.665 B | `9d9cbf5506544efa50aa4c430abf50af606d3ae62af4d58e2e2f3ac899d7a930` |
| [reconciliation-20260911-1037.plan.txt](reconciliation/reconciliation-20260911-1037.plan.txt) | 1.787 B | `a0018853713ed2d5e47f85b204207bc21e9a1abb4b1e08be86305fddec96b676` |
| [reconciliation-20260911-1037.run.log](reconciliation/reconciliation-20260911-1037.run.log) | 26.037 B | `27f81516dcb977cbc526721be8aa2eb078437bc8f2827a11f545702366c3129c` |

- Cópias locais em `docs/reconciliation/`, pasta versionada porque `artifacts/` está no `.gitignore`.
- Os originais continuam no servidor em `/tmp/reconcile-20260911-1021/` (`out/`, `plan.txt`, `run.log`); nada foi apagado.
- Os arquivos foram varridos contra segredos antes de gravar (no próprio script) e de novo após a cópia (grep por `authorization`, `bearer`, `basic`, `SETTINGS_SECRET`, `password`, `senha`, `cookie`): 0 ocorrências.
- O JSON tem o `raw` completo da promoção.

## Decisões pendentes (aguardando aprovação)

1. **CT = CENTO?** Aprovar ou rejeitar o mapeamento `CT → CENTO` na regra do reconciliador, depois reexecutar para ter o resultado oficial das 2298 linhas.
2. **PC na Wake.** Os 16 produtos PC estão com preço e estoque ÷100/×100. A correção do motor de produção (unidade condicional ao `unit`) segue fora de escopo até aprovação.
3. **KG.** Definir de onde vem o `kg_por_caixa` do SKU 12852; a migration continua bloqueada.
4. **Promoção 10365.** Confirmar a semântica da condição 4 / lógica 3 / argumento `23085` e da ação 2 para decidir se a promoção prova "≥ 100 → −20% em toda a whitelist".
5. **3 CISS_MISSING.** Pedir ao SIGAS o registro de saldo dos SKUs 1273, 28875 e 28899, e o `retail_price` do 28875.
