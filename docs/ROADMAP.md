# ROADMAP — Casa HUB

## FASE 0 — Runtime audit READ-ONLY — P0

Objetivo:
certificar o que está realmente rodando.

- provider preço;
- systemd;
- settings;
- DB;
- CISS;
- Wake;
- promoção;
- tabela;
- intervalos;
- logs;
- uma instância do worker.

Sem writes.

## FASE 1 — Guards de produção — P0

- impedir mock → Wake;
- settings com Zod por chave;
- GET settings autenticado;
- lock owner-aware;
- tick serial;
- health/ready.

## FASE 2 — Wake readback + reconciliação — P0

- leitura preço Wake;
- leitura estoque Wake por SKU/CD;
- tabela de preço readback;
- reconciliação full;
- VERIFIED/MISMATCH;
- CSV/JSON de divergências.

## FASE 3 — Unit engine — P0

- preservar UNIT CISS;
- CENTO;
- PC/UN;
- KG;
- unsupported;
- schema/migrations;
- Decimal.

## FASE 4 — Política comercial — P0

- separar normalização de política;
- fixador CENTO:
  - +20% varejo;
  - >=100: -20% sobre varejo;
- validação 1/99/100/101;
- validar promoção/tabela Wake.

## FASE 5 — Histórico sustentável — P1

- `sync_status`;
- heartbeat;
- scheduler não depende de no-op history;
- no-change sem item;
- no-op automático sem lote histórico;
- cleanup legado com backup + dry-run.

## FASE 6 — Operação por SKU — P1

- search;
- paginação;
- single-SKU price/stock/both;
- simulação;
- toggle whitelist.

## FASE 7 — Embalagens KG — P1

- Caixas → Embalagens;
- kg por caixa;
- preview;
- status configuração;
- preço caixa;
- estoque caixa.

## FASE 8 — Dashboard realtime — P1

- SSE;
- progresso;
- Última verificação;
- Última atualização;
- Ambiente Produção;
- saúde;
- tabela só de runs relevantes.

## FASE 9 — Configurações/segurança — P1/P2

- cards por sistema/regra;
- tokens separados;
- roles;
- login rate limit;
- HTTPS.

## FASE 10 — CI/release — P0

- typecheck;
- unit;
- integration;
- build;
- GitHub Actions;
- backup;
- deploy;
- smoke;
- reconciliation;
- rollback.

## Regra

Uma fase lógica por branch/PR.
Não criar mega-branch.
