# CISS UNIT MAP — censo global das unidades de medida

Censo feito em 11/09/2026 na branch `audit/ciss-unit-census`. **Só leitura.**

Este documento traz apenas agregados. Não tem preço, estoque nem segredos. O relatório completo, por produto, fica **fora do Git** (ver "Relatórios privados" no fim).

> Esta rodada **não corrige nada**. O motor de produção continua ignorando `unit`: os 16 produtos PC e o produto KG da whitelist seguem passando pela fórmula CENTO. A correção depende de aprovação.

## Como foi lido

| Item | Valor |
|---|---|
| Endpoint | `GET /products/stock?page=N&per_page=500`, sem `product_id` (modo listagem) |
| Probe | 1 GET na página 1 às 14:55:46Z → **200**, `LISTING_SUPPORTED` |
| Resposta | chaves `data` e `pagination` `{page, per_page, total: 22323, total_pages: 45}` |
| Campos por item | `product_id`, `description`, `unit`, `reference`, `companies`; os 500 itens da página 1 tinham `unit` |
| Leitura | 45 páginas, sequencial, pausa de 1 s entre páginas |
| Produtos lidos | **22323**, igual ao `total` reportado; 0 repetidos; 0 avisos |
| Duração | probe 1,35 s; censo 69,4 s (14:55:57Z → 14:57:06Z) |
| Requests | CISS: 46 (1 probe + 45 páginas). **Wake: 0** |
| Escritas | **0**: nada na Wake, no CISS nem no SQLite (aberto `readonly` + `query_only`); sem sync |
| Onde rodou | `/tmp/ciss-unit-census-20260911/` no servidor, como `erpwake`; `/opt/erp-wake` não foi tocado |

O campo `companies`, que traz o saldo, foi descartado na leitura. De cada produto ficaram só `product_id`, `reference`, `description` e `unit_raw`.

## UNITs encontradas

São **13** valores distintos de `unit`. Nenhum tem espaço extra, minúscula, valor vazio ou ausente. Por isso cada valor normalizado (trim + uppercase) corresponde a um único valor raw.

| UNIT | Catálogo | Whitelist atual | Exemplos de `product_id` | Exemplos de `reference` | Canônica | Estratégia | Status |
|---|---:|---:|---|---|---|---|---|
| `PC` | 13504 | 16 | 1, 2, 3, 4, 5 | 0563382, 563425, 5634855, 566515, 566545 | PIECE | PieceStrategy | OWNER_PROPOSED |
| `CT` | 6808 | 2298 | 41, 79, 80, 81, 82 | IO1419275, 81010100, 81015100, 81020100, 81025100 | CENTO | HundredStrategy | **CANDIDATE / OWNER_CONFIRMATION_REQUIRED** |
| `JG` | 741 | 0 | 5494, 8253, 8254, 8255, 8258 | 1, TB14895, TB14894, TB14898, TB14891 | UNSUPPORTED | FUTURE_RULE | UNSUPPORTED / FUTURE_RULE |
| `PR` | 516 | 0 | 12788, 12810, 12966, 12967, 12968 | 22, 33, 59, 5052, 5053 | UNSUPPORTED | FUTURE_RULE | UNSUPPORTED / FUTURE_RULE |
| `KG` | 408 | 1 | 915, 5091, 5092, 5093, 5094 | G07, 3471701, S1010, S1212, 3497701 | KG_PACKAGE | KgPackageStrategy | OWNER_PROPOSED |
| `CJ` | 152 | 0 | 29683, 29705, 29857, 29859, 29861 | 40.018.31, 40.508.08, 40.102.01, 40.102.80, 40.022.21 | UNSUPPORTED | FUTURE_RULE | UNSUPPORTED / FUTURE_RULE |
| `RL` | 78 | 0 | 13207, 13208, 13363, 13364, 13365 | NETTEN, TAPUME-REDE, PA00293, PA00318, PA00467 | UNSUPPORTED | FUTURE_RULE | UNSUPPORTED / FUTURE_RULE |
| `MT` | 76 | 0 | 8905, 8974, 8992, 10199, 10539 | 5600209/PT, 41039659, 41039704, 41039709, 41039702 | UNSUPPORTED | FUTURE_RULE | UNSUPPORTED / FUTURE_RULE |
| `UN` | 28 | 0 | 9867, 17433, 17437, 17439, 17441 | 1618596177, A042-F, 78072724012, FAL3M, R010279 | PIECE | PieceStrategy | OWNER_PROPOSED |
| `KT` | 5 | 0 | 13050, 33734, 33736, 33738, 33740 | GB35 (os demais sem `reference`) | UNSUPPORTED | FUTURE_RULE | UNSUPPORTED / FUTURE_RULE |
| `CX` | 5 | 0 | 34672, 34673, 34674, 34676, 34677 | DA90600 P PT, DA90600 M PT, DA90600 G PT, DA301CA M IN, DA301CA G IN | UNSUPPORTED | FUTURE_RULE | UNSUPPORTED / FUTURE_RULE |
| `LT` | 1 | 0 | 16824 | (sem `reference`) | UNSUPPORTED | FUTURE_RULE | UNSUPPORTED / FUTURE_RULE |
| `PL` | 1 | 0 | 31075 | 4045BELF4600EL | UNSUPPORTED | FUTURE_RULE | UNSUPPORTED / FUTURE_RULE |
| **Total** | **22323** | **2315** | | | | | |

A coluna "Whitelist atual" soma 2315 porque 3 produtos da whitelist não aparecem na listagem (ver abaixo).

## Distribuição na whitelist (2318 produtos ativos)

| Categoria | Produtos |
|---|---:|
| CT | 2298 |
| PC | 16 |
| UN | 0 |
| KG | 1 |
| Outras UNITs | 0 |
| Sem registro na listagem | 3 (`1273`, `28875`, `28899`) |

Confere com a reconciliação de 11/09 (CT 2298 / PC 16 / KG 1 / CISS_MISSING 3).

## Significado de cada código — evidências

Não há documentação oficial disponível. `openapi.json`, `swagger` e `docs` do SIGAS devolvem 404 (testado em rodadas anteriores). O endpoint também não traz descrição da unidade, só a sigla. Nenhum endpoint novo foi testado nesta rodada.

Hierarquia pedida: doc oficial → cadastro oficial → código/endpoint documentado → produtos de controle.

| Nível | Resultado |
|---|---|
| Documentação oficial | **Não existe / não localizada.** |
| Cadastro oficial de unidades | **Não exposto pela API em uso.** Precisa ser pedido ao SIGAS ou consultado na tela de cadastro do CISS/POWER. |
| Código / endpoint documentado | Só código interno do Casa Hub: comentários "preço do cento" em `pricing/engine.ts`, `UNITS_PER_CENTO` em `inventory/engine.ts` e o rótulo "PREÇO CENTO ERP" nas configurações. É evidência de como o Casa Hub **interpreta** o dado. Não diz o que o ERP **define**. |
| Produtos de controle | SKU **1563** tem `unit = CT` e está na whitelist. O dono confirmou em 08/09 que "2" no ERP = 2 centos = 200 peças. Na simulação da reconciliação (não oficial), a fórmula CENTO bateu em preço, tabela e estoque para 2297 das 2298 linhas CT publicadas. |

**Conclusão sobre CT:** é consistente com CENTO, mas **sem confirmação oficial**. Continua `CT → CENTO = CANDIDATE / OWNER_CONFIRMATION_REQUIRED`.

Outros pontos sobre CT:

- Nenhuma descrição do catálogo, em nenhuma UNIT, contém "CENTO", "C/100", "CX100" ou "100 UN/PC" (0 ocorrências).
- A sigla "CT" é ambígua fora deste contexto; em outros ERPs pode significar cartela, por exemplo.

As demais siglas só têm como indício as descrições dos próprios produtos, o que **não é definição**. Por isso todas ficam sem regra:

| UNIT | Leitura provável (só indício) | Base do indício |
|---|---|---|
| PC | peça | ferramentas e itens avulsos |
| UN | unidade | brocas, porcas avulsas |
| KG | quilo | eletrodos, arames, grampos a granel |
| JG | jogo | "jogo de chaves…" |
| PR | par | botinas e botas |
| CJ | conjunto | quase só "parafuso de roda" |
| RL | rolo | fitas, cordas, telas, arame farpado |
| MT | metro | cabo de aço, mangueira |
| KT | kit | jogos de brocas/chaves |
| CX | caixa | luvas |
| LT | litro ou lata (indefinido) | 1 produto, óleo |
| PL | indefinido | 1 produto, botina |

Observação: os SKUs 5418, 5419 e 5420 da whitelist são `PC`, mas a descrição indica embalagem com 50 peças. Isso reforça que **não se deve inferir a UNIT pelo nome** e que PC não é garantia de "1 peça por item publicado". O caso vai para a regra PIECE quando for aprovada.

## Dicionário canônico recomendado

| UNIT raw | Canônica | Estratégia | Status | Pré-requisito para ativar |
|---|---|---|---|---|
| `CT` | CENTO | HundredStrategy | CANDIDATE / OWNER_CONFIRMATION_REQUIRED | confirmação do dono (ou do SIGAS) de que CT = cento |
| `PC` | PIECE | PieceStrategy | OWNER_PROPOSED | aprovar a fórmula PIECE (preço e estoque sem ÷100/×100) |
| `UN` | PIECE | PieceStrategy | OWNER_PROPOSED | idem PC; hoje 0 na whitelist |
| `KG` | KG_PACKAGE | KgPackageStrategy | OWNER_PROPOSED | `kg_por_caixa` por SKU (não existe; sem migration ainda) |
| qualquer outra | UNSUPPORTED | FUTURE_RULE | UNSUPPORTED / FUTURE_RULE | regra específica aprovada |

Regras do dicionário, implementadas em `scripts/reconcile/unit-census.ts`:

- a correspondência é **exata** sobre a UNIT normalizada;
- UNIT desconhecida vai **sempre** para UNSUPPORTED, **nunca** para PC nem para CENTO;
- nada é inferido a partir de `description`.

## Unidades sem regra

`JG` (741), `PR` (516), `CJ` (152), `RL` (78), `MT` (76), `KT` (5), `CX` (5), `LT` (1), `PL` (1): **1575 produtos** no catálogo, **0** na whitelist atual. Se algum deles entrar na whitelist sem regra aprovada, deve cair em UNSUPPORTED e não ser publicado.

## Limitações

- A listagem de `/products/stock` cobre só produtos com linha de saldo no CISS. Os 3 SKUs da whitelist sem registro (1273, 28875, 28899) não aparecem, e produtos do cadastro sem saldo também ficam de fora. O total de 22323 é "catálogo com saldo", não o cadastro inteiro.
- Não há descrição oficial de nenhuma sigla. Todo significado acima é candidato.
- Os relatórios por SKU da reconciliação de 11/09 foram removidos da árvore em `a5de5e2`, mas **continuam no histórico** do Git (`95204fd`, `d92f059`). Tirá-los de lá exigiria reescrever o histórico com force-push, que não é permitido. A mitigação é o repositório ficar privado.

## Relatórios privados (fora do Git)

Na estação, em `Casa HUB/artifacts-private/` (a pasta está no `.gitignore`):

| Arquivo | SHA-256 |
|---|---|
| `ciss-unit-census-20260911.json` (4.164.105 B) | `dd0e806687337a22e1fc4adb7ab048df74f2532af5dba9d33edfc399c5f0dd17` |
| `ciss-unit-census-20260911.csv` (1.246.361 B) | `c0932f4883b1fed7c4edf8d9669268934f34f8ff62486f0a0978e1d1057c4db2` |
| `ciss-unit-census-20260911.probe.log` | `faaa4d4544694f6fd047ddfa312020bae02ee6a40675c15ac982106c9f735a45` |
| `ciss-unit-census-20260911.run.log` | `c0db945201954739b82fc19ef077fba7c7a98eaed6138f622a5b263462e752be` |

Os originais continuam no servidor em `/tmp/ciss-unit-census-20260911/out/`, com os mesmos hashes.

## Como reproduzir

```bash
tsx scripts/ciss-unit-census.ts --root <app> --env-file <.env> --out <dir> --probe
tsx scripts/ciss-unit-census.ts --root <app> --env-file <.env> --out <dir>
```

- Códigos de saída: 0 = ok; 3 = listagem não suportada (o censo não roda); 1 = falha.
- Testes: `scripts/reconcile/unit-census.test.ts`.
- Garantia de "sem write path": `scripts/reconcile/no-write-path.test.ts`, que também cobre o CLI do censo.
