# CISS UNIT MAP — mapa canônico das unidades de medida

- Censo READ-ONLY em 11/09/2026, na branch `audit/ciss-unit-census`.
- Decisões de negócio **confirmadas pelo proprietário em 11/09/2026**.

Este documento traz só agregados: sem preço, sem estoque, sem segredos. O relatório completo por produto fica **fora do Git** (ver "Relatórios privados").

> **Estado do código:** o mapa abaixo é a regra de negócio vigente, mas **ainda não está implementado**.
> - O motor de produção (`main` 053434c) ignora `unit` e aplica a fórmula de CENTO a tudo.
> - Por isso os 16 PC e o KG 12852 da whitelist estão errados na Wake.
> - A implementação fica para a branch `feat/unit-strategies`, depois da aprovação (ver "Próxima fase").
> - O dicionário dentro de `scripts/reconcile/unit-census.ts` guarda os status **da época do censo** (CT candidato, demais UNSUPPORTED) e não foi alterado. Ele é registro histórico do censo, não a regra.

## Mapa canônico — OWNER_CONFIRMED

| UNIT CISS | Significado | Classe | Estratégia | Status |
|---|---|---|---|---|
| `CT` | cento (100 unidades) | HUNDRED | HundredUnitStrategy | **OWNER_CONFIRMED** |
| `PC` | peça | DIRECT | DirectUnitStrategy | **OWNER_CONFIRMED** |
| `UN` | unidade | DIRECT | DirectUnitStrategy | **OWNER_CONFIRMED** |
| `JG` | jogo | DIRECT | DirectUnitStrategy | **OWNER_CONFIRMED** |
| `PR` | par | DIRECT | DirectUnitStrategy | **OWNER_CONFIRMED** |
| `CJ` | conjunto | DIRECT | DirectUnitStrategy | **OWNER_CONFIRMED** |
| `RL` | rolo | DIRECT | DirectUnitStrategy | **OWNER_CONFIRMED** |
| `KT` | kit | DIRECT | DirectUnitStrategy | **OWNER_CONFIRMED** |
| `CX` | caixa | DIRECT | DirectUnitStrategy | **OWNER_CONFIRMED** |
| `LT` | (1:1) | DIRECT | DirectUnitStrategy | **OWNER_CONFIRMED** |
| `PL` | (1:1) | DIRECT | DirectUnitStrategy | **OWNER_CONFIRMED** |
| `KG` | quilograma | PACKAGE_MEASURED(KG) | MeasuredPackageUnitStrategy | **OWNER_CONFIRMED** |
| `MT` | metro | PACKAGE_MEASURED(MT) | MeasuredPackageUnitStrategy | **OWNER_CONFIRMED** |
| qualquer UNIT **fora desta tabela** | — | UNSUPPORTED | — | `UNSUPPORTED_UNIT`: fail closed, zero write, até revisão |

- A correspondência é **exata**, sobre a UNIT normalizada (trim + uppercase).
- "As demais são 1:1" vale **só** para as 10 siglas DIRECT listadas, identificadas neste censo.
- Uma sigla nova **nunca** vira DIRECT, HUNDRED nem PC automaticamente.
- Uma UNIT ausente ou vazia também é `UNSUPPORTED_UNIT`.
- A UNIT do CISS prevalece sobre a descrição. **Nunca** se deduz unidade ou embalagem pelo nome do produto.

## Regras por classe

### HUNDRED — `CT`

É a normalização matemática da UNIT; não inclui política comercial.

```text
base_unit_price = ciss_price / 100      # o preço CISS vale 100 unidades
physical_units  = ciss_stock * 100      # o estoque CISS está em centos
```

### Política comercial FIXADOR_CENTO (separada da normalização)

Vale para os fixadores CT administrados hoje pelo Casa Hub. **Não** faz parte do significado de CT e **não** pode ser codificada no adapter do CISS.

```text
retail_unit_price    = base_unit_price * 1.20
wholesale_unit_price = retail_unit_price * 0.80        # a partir de 100 unidades
wake_stock           = floor(max(ciss_stock, 0) * 100 * 0.10)
```

Arquitetura alvo: `CT normalization != FIXADOR_CENTO commercial policy`. O fator de 10% e o markup de +20% / −20% pertencem à política, que é configurável e separada.

### DIRECT — `PC UN JG PR CJ RL KT CX LT PL`

```text
wake_price = ciss_price
wake_stock = floor(max(ciss_stock, 0))
```

- Não se aplica ÷100 nem ×100.
- Não se aplicam os 10% dos fixadores, o markup de +20% nem o atacado ≥ 100 dos fixadores.
- Não se deduz nada pelo nome. Exemplo: os SKUs 5418, 5419 e 5420 são `PC`, mas a descrição diz "50 peças"; mesmo assim o valor do ERP é tratado 1:1.
- O nome da estratégia é `DirectUnitStrategy`, e não `PieceStrategy`, porque JG, PR, CJ, RL, CX etc. não são "peça".

### PACKAGE_MEASURED — `KG` e `MT`

No CISS, o preço é de **1 kg** ou **1 metro**, e o estoque é o total em kg ou em metros. Na Wake, o produto é vendido numa unidade de venda (caixa, pacote, rolo) com uma quantidade definida da unidade de origem.

```text
wake_price = ciss_price_per_source_unit * quantity_per_sale_unit
wake_stock = floor(max(ciss_stock_in_source_unit, 0) / quantity_per_sale_unit)
```

- Exemplo KG: caixa de 18 kg com 340 kg em estoque dá `340 / 18` = 18 caixas. A sobra de 16 kg não forma unidade vendável.
- Produto vendido por exatamente 1 metro: `QT MT = 1`.
- Sem configuração válida (ausente, inativa ou ≤ 0): `CONFIGURATION_REQUIRED`, com **zero write de preço e zero write de estoque**.

## Modelagem recomendada para KG e MT (ainda não criada)

Uma estrutura genérica, **não** duas tabelas (`kg_por_caixa` + `metros_por_rolo`):

```text
product_sale_unit_config
  managed_product_id
  wake_sku
  source_unit              KG | MT
  quantity_per_sale_unit   decimal > 0
  active
  created_at
  updated_at
  updated_by
```

- **Semântica:** quantidade da unidade CISS necessária para formar 1 unidade vendável na Wake.
- **UI:** o rótulo muda com a UNIT: `KG → QT KG`, `MT → QT MT`.
- **Esta rodada:** nenhuma migration criada.

## Importação por planilha (roadmap; não implementar agora)

Além do cadastro manual, a configuração de KG e MT deve poder vir de planilha:

```text
KG:  SKU | NOME | QT KG
MT:  SKU | NOME | QT MT
```

Validação contra a UNIT real do CISS:

| Caso | Resultado |
|---|---|
| `QT KG` + produto CISS `KG` | válido |
| `QT MT` + produto CISS `MT` | válido |
| `QT KG` + produto CISS `PC` (ou qualquer UNIT ≠ KG) | rejeitar |
| SKU inexistente | rejeitar |
| quantidade ≤ 0 | rejeitar |
| SKU duplicado | reportar |

O fluxo terá sete etapas: preview → validação → contagem de válidos e inválidos → confirmação → aplicação → relatório → audit log.

A modelagem de `product_sale_unit_config` precisa suportar esse fluxo; por isso `source_unit`, `updated_by` e timestamps ficam nela.

## Censo — como foi lido

| Item | Valor |
|---|---|
| Endpoint | `GET /products/stock?page=N&per_page=500`, sem `product_id` (modo listagem) |
| Probe | 1 GET na página 1 às 14:55:46Z → **200**, `LISTING_SUPPORTED` |
| Resposta | `data` + `pagination` `{page, per_page, total: 22323, total_pages: 45}` |
| Campos por item | `product_id`, `description`, `unit`, `reference`, `companies` |
| Leitura | 45 páginas, sequencial, pausa de 1 s |
| Produtos lidos | **22323**, igual ao `total` reportado; 0 repetidos; 0 avisos |
| Duração | probe 1,35 s; censo 69,4 s (14:55:57Z → 14:57:06Z) |
| Requests | CISS: 46 (1 probe + 45). **Wake: 0** |
| Escritas | **0**: Wake, CISS e SQLite (este aberto `readonly` + `query_only`); sem sync |
| Onde | `/tmp/ciss-unit-census-20260911/` no servidor, como `erpwake`; `/opt/erp-wake` não foi tocado |

O saldo (`companies`) foi descartado na leitura. Por produto ficaram só `product_id`, `reference`, `description` e `unit_raw`.

## Censo — distribuição

São **13** UNITs distintas. Nenhuma tem variação de caixa ou espaço, nenhuma vem vazia ou ausente; raw = normalizada.

| UNIT | Catálogo | Whitelist atual | Exemplos de `product_id` | Exemplos de `reference` | Classe |
|---|---:|---:|---|---|---|
| `PC` | 13504 | 16 | 1, 2, 3, 4, 5 | 0563382, 563425, 5634855, 566515, 566545 | DIRECT |
| `CT` | 6808 | 2298 | 41, 79, 80, 81, 82 | IO1419275, 81010100, 81015100, 81020100, 81025100 | HUNDRED |
| `JG` | 741 | 0 | 5494, 8253, 8254, 8255, 8258 | 1, TB14895, TB14894, TB14898, TB14891 | DIRECT |
| `PR` | 516 | 0 | 12788, 12810, 12966, 12967, 12968 | 22, 33, 59, 5052, 5053 | DIRECT |
| `KG` | 408 | 1 | 915, 5091, 5092, 5093, 5094 | G07, 3471701, S1010, S1212, 3497701 | PACKAGE_MEASURED(KG) |
| `CJ` | 152 | 0 | 29683, 29705, 29857, 29859, 29861 | 40.018.31, 40.508.08, 40.102.01, 40.102.80, 40.022.21 | DIRECT |
| `RL` | 78 | 0 | 13207, 13208, 13363, 13364, 13365 | NETTEN, TAPUME-REDE, PA00293, PA00318, PA00467 | DIRECT |
| `MT` | 76 | 0 | 8905, 8974, 8992, 10199, 10539 | 5600209/PT, 41039659, 41039704, 41039709, 41039702 | PACKAGE_MEASURED(MT) |
| `UN` | 28 | 0 | 9867, 17433, 17437, 17439, 17441 | 1618596177, A042-F, 78072724012, FAL3M, R010279 | DIRECT |
| `KT` | 5 | 0 | 13050, 33734, 33736, 33738, 33740 | GB35 (demais sem `reference`) | DIRECT |
| `CX` | 5 | 0 | 34672, 34673, 34674, 34676, 34677 | DA90600 P PT, DA90600 M PT, DA90600 G PT, DA301CA M IN, DA301CA G IN | DIRECT |
| `LT` | 1 | 0 | 16824 | (sem `reference`) | DIRECT |
| `PL` | 1 | 0 | 31075 | 4045BELF4600EL | DIRECT |
| **Total** | **22323** | **2315** | | | |

Na whitelist atual (2318 ativos), a classificação fica assim:

| Classe | Produtos |
|---|---:|
| HUNDRED (CT) | 2298 |
| DIRECT (PC) | 16 |
| DIRECT (outras) | 0 |
| PACKAGE_MEASURED(KG) | 1 (12852), hoje sem `QT KG` → `CONFIGURATION_REQUIRED` |
| PACKAGE_MEASURED(MT) | 0 |
| Sem registro no CISS | 3 (`1273`, `28875`, `28899`) |

## Evidências (histórico)

Antes da confirmação do proprietário, o CT estava como `CANDIDATE / OWNER_CONFIRMATION_REQUIRED`:

- Não há documentação oficial: `openapi`/`docs` do SIGAS devolvem 404, e a API não expõe o cadastro de unidades.
- Evidência indireta:
  - produto de controle 1563 (CT): o dono confirmou "2 no ERP = 200 peças";
  - simulação da reconciliação: 2297 de 2298 CT bateram com a fórmula CENTO;
  - nenhuma descrição do catálogo contém "CENTO" ou "C/100".

Em **11/09/2026** o proprietário confirmou `CT = CENTO` e os demais significados; todos os status passaram a `OWNER_CONFIRMED`.

## Limitações

- A listagem de `/products/stock` só cobre produtos com linha de saldo no CISS. Por isso os 3 SKUs sem registro não aparecem.
- Os relatórios por SKU da reconciliação saíram da árvore em `a5de5e2`, mas **continuam no histórico** (`95204fd`, `d92f059`). Removê-los exige force-push, que não é permitido. A mitigação é o repositório privado.

## Relatórios privados (fora do Git)

Ficam na estação, em `Casa HUB/artifacts-private/` (que está no `.gitignore`):

| Arquivo | SHA-256 |
|---|---|
| `ciss-unit-census-20260911.json` (4.164.105 B) | `dd0e806687337a22e1fc4adb7ab048df74f2532af5dba9d33edfc399c5f0dd17` |
| `ciss-unit-census-20260911.csv` (1.246.361 B) | `c0932f4883b1fed7c4edf8d9669268934f34f8ff62486f0a0978e1d1057c4db2` |
| `ciss-unit-census-20260911.probe.log` | `faaa4d4544694f6fd047ddfa312020bae02ee6a40675c15ac982106c9f735a45` |
| `ciss-unit-census-20260911.run.log` | `c0db945201954739b82fc19ef077fba7c7a98eaed6138f622a5b263462e752be` |

Os originais continuam no servidor em `/tmp/ciss-unit-census-20260911/out/`, com os mesmos hashes.

## Próxima fase (só depois de aprovação e integração na `main`)

A branch `feat/unit-strategies`, criada a partir da nova `origin/main`, vai implementar:

- `UnitResolver`;
- `DirectUnitStrategy`;
- `HundredUnitStrategy`;
- `MeasuredPackageUnitStrategy` (KG/MT);
- `CommercialPolicy` separada (FIXADOR_CENTO);
- persistência da UNIT;
- `CONFIGURATION_REQUIRED`;
- UNIT desconhecida → fail closed.

Só depois disso vem a correção dos produtos reais: os 16 PC e o KG 12852.

## Como reproduzir o censo

```bash
tsx scripts/ciss-unit-census.ts --root <app> --env-file <.env> --out <dir> --probe
tsx scripts/ciss-unit-census.ts --root <app> --env-file <.env> --out <dir>
```

- Códigos de saída: 0 = ok; 3 = listagem não suportada; 1 = falha.
- Testes: `scripts/reconcile/unit-census.test.ts` e `no-write-path.test.ts`.
