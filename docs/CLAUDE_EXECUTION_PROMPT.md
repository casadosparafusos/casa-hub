# Prompt canônico — próxima execução Claude Opus 5 Médio

Você atuará como Tech Lead / Senior Backend + Full-stack Engineer responsável pelo **Casa HUB da Casa dos Parafusos**, aplicação JÁ EM PRODUÇÃO que sincroniza preço e estoque do ERP **CISS/POWER** para a **Wake Commerce**.

Não reescreva a aplicação e não faça uma mega-refatoração.

Repo:
`git@github.com:casadosparafusos/casa-hub.git`

Diretório local oficial:
`D:\E-commerce\RD_Workspace\Apps Personalizados\Casa dos Parafusos APP's\Casa HUB`

Baseline Git auditado pelo ChatGPT:
`053434ce0209c406add5020fe1c2d259d138e165`

## REGRA 0 — LEIA ANTES DE AGIR

Leia integralmente:
1. `README.md`
2. `CLAUDE.md`
3. `docs/STATUS.md`
4. `docs/BUSINESS_RULES.md`
5. `docs/PRICE_RULES.md`
6. `docs/INVENTORY_RULES.md`
7. `docs/UI_UX_REQUIREMENTS.md`
8. `docs/ARCHITECTURE_TARGET.md`
9. `docs/AUDIT.md`
10. `docs/ROADMAP.md`
11. `docs/REPO_WORKFLOW.md`
12. `docs/VALIDATION_PROTOCOL.md`

Depois registre:
- `git status`
- branch atual
- HEAD
- `origin/main`
- remote
- diff local

Faça `git fetch --all --prune`.

NÃO altere `main`.
Crie branch secundária.

## MISSÃO DESTA RODADA

Execute primeiro a **FASE 0 — auditoria de runtime READ-ONLY**.

Não escreva preço nem estoque na Wake nesta primeira etapa.

No servidor de produção:
- confirmar systemd web;
- confirmar systemd worker;
- confirmar se estão enabled + active;
- confirmar PID único;
- confirmar comportamento de restart;
- confirmar `.env` sem imprimir segredo;
- confirmar `CISS_PRICE_PROVIDER`;
- confirmar settings efetivos;
- confirmar intervalos reais;
- confirmar CISS price endpoint;
- confirmar CISS stock endpoint;
- confirmar Wake token configurado;
- confirmar CD;
- confirmar tabela de preço;
- confirmar promoção;
- confirmar modo de controle de estoque.

Se `CISS_PRICE_PROVIDER=mock` e houver qualquer caminho capaz de executar preço real:
**STATUS P0/FAIL e bloqueie preço real.**

## RECONCILIAÇÃO

A primeira reconciliação é READ-ONLY.

Não use `sync_product_state.lastApplied*` como representação da Wake.

Para cada produto ativo:
`CISS → UNIT → cálculo esperado → Wake AO VIVO`

Comparar:
- preço base Wake;
- estoque Wake do CD;
- tabela de preço;
- configuração da promoção quando aplicável.

Gerar relatório agregado e arquivo CSV/JSON de divergências.

## REGRAS DE UNIT — NÃO NEGOCIÁVEL

A fonte da unidade é `unit` do endpoint CISS de estoque.

Nunca detectar por nome/categoria.

### CENTO — fixadores

Preço:
- CISS informa preço de 100;
- base unitária = `CISS / 100`;
- varejo atual dos fixadores = base +20%;
- a partir de 100 unidades = 20% de desconto sobre o varejo.

Formalmente:
`base = P100/100`
`retail = base*1.20`
`wholesale = retail*0.80`

Não “corrija” essa matemática para voltar ao base.

Estoque:
`wake = floor(ciss_stock * 100 * 0.10)`

### PC / UN

Preço:
`wake_base = ciss_price`

Estoque:
`wake_stock = floor(ciss_stock)`

Não usar 100.
Não aplicar política de fixadores automaticamente.

### KG

CISS informa:
- estoque em kg;
- preço por 1 kg.

Produto precisa de:
`kg_por_caixa`

Preço:
`preco_caixa = preco_kg * kg_por_caixa`

Estoque:
`caixas = floor(estoque_kg / kg_por_caixa)`

Sem kg_por_caixa:
`CONFIGURATION_REQUIRED`, zero write.

## ACHADOS QUE VOCÊ DEVE VALIDAR

- motor atual de preço divide tudo por 100;
- motor atual de estoque multiplica tudo por 100;
- `unit` chega do CISS mas é descartada;
- reconciliação atual reaproveita runSync e pode não detectar drift Wake;
- ACK de estoque não substitui reconciliação por leitura;
- tabela de preço não tem readback equivalente;
- no-change é persistido em massa;
- dashboard depende de refresh;
- não há single-SKU;
- não há toggle de whitelist na UI;
- GET settings deve exigir sessão;
- configuração `CSV_IDENTIFIER_TYPE` parece não governar os writes atuais;
- `WHOLESALE_MIN_QTY` local pode divergir da condição real da promoção Wake.

## NÃO IMPLEMENTE TUDO NESTA PRIMEIRA RODADA

Primeiro:
1. audite;
2. preencha `docs/PRODUCTION_RECONCILIATION.md`;
3. atualize `docs/STATUS.md`;
4. gere `AUDIT_RUNTIME_REPORT.md`;
5. pare e reporte.

Não faça merge.

## DEPOIS DA APROVAÇÃO

Seguir o ROADMAP em branches separadas, nesta ordem:

P0:
- production guards;
- Wake readback/reconciliation;
- UnitStrategy;
- política comercial e teste 1/99/100/101.

P1:
- histórico sustentável;
- single-SKU/search/toggle;
- Embalagens KG;
- realtime SSE;
- Configurações;
- hardening.

## REQUISITOS DE UI JÁ APROVADOS

Visão Geral:
- trocar “Pronto pra produção” por `Ambiente: Produção`;
- health separado;
- realtime sem F5;
- ocultar runs automáticos no-op;
- UI principal usar `Atualizados` + `Falhas`.

Produtos:
- ativar/inativar whitelist;
- busca.

Preços/Estoque:
- busca;
- paginação;
- operação single-SKU rápida.

Histórico:
- não persistir `Sem mudança` em massa;
- enquanto legado existir, alterações/falhas primeiro.

Configurações:
- português;
- organizar Wake separado de ERP;
- regras CENTO / PC / KG separadas;
- descrições claras;
- tokens write-only;
- Testar conexão.

Caixas:
- evoluir para `Embalagens`, para produtos KG.

## RESTART

O repositório possui systemd com `Restart=always` e `RestartSec=5` para web e worker.
Isso é apenas configuração versionada.

Você deve provar no host:
- unit instalada;
- enabled;
- active;
- restart após kill;
- reboot/catch-up em janela segura;
- sem worker duplicado.

## SEGURANÇA

Nunca imprimir:
- token Wake;
- token CISS;
- SETTINGS_SECRET_KEY;
- cookies;
- hash de senha;
- conteúdo do `.env`.

Não apagar DB.
Antes de migration destrutiva: backup + dry-run + relatório.

## ENTREGA FINAL DESTA RODADA

Retorne:
- `STATUS = PASS | PARTIAL | FAIL`;
- branch;
- SHA inicial;
- SHA final;
- runtime audit;
- provider real;
- systemd status;
- reconciliation totals;
- divergências;
- riscos P0;
- arquivos gerados/alterados;
- testes executados;
- próxima ação exata.

Faça push da branch para:
`git@github.com:casadosparafusos/casa-hub.git`

Não merge.
