# ROADMAP — Casa HUB

## FASE 0 — Runtime audit READ-ONLY — P0 — PARTIAL

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

Status: provider live e systemd confirmados (`audit/fase-0-runtime-readonly`, `464c429`/`8448372`). O restante (reconciliação Wake ao vivo) foi coberto pelas fases seguintes.

## FASE 1 — Guards de produção — P0

- impedir mock → Wake;
- settings com Zod por chave;
- GET settings autenticado;
- lock owner-aware;
- tick serial;
- health/ready.

## FASE 2 — Wake readback + reconciliação — P0 — Executado READ-ONLY 1× em produção (11/09/2026, `c7616d7`)

- leitura preço Wake;
- leitura estoque Wake por SKU/CD;
- tabela de preço readback;
- reconciliação full;
- VERIFIED/MISMATCH;
- CSV/JSON de divergências.

Resultado em `PRODUCTION_RECONCILIATION.md` / `RECONCILIATION_READONLY.md`. Sem escrita na Wake; nada foi corrigido.

## FASE 3 — Unit engine — P0 — mapa OWNER_CONFIRMED em 11/09/2026, implementação PENDENTE (`feat/unit-strategies`)

Censo READ-ONLY completo (22323 produtos, 13 siglas) em `CISS_UNIT_MAP.md`. Mapa canônico confirmado pelo proprietário:

- preservar UNIT CISS (nunca inferir por nome);
- `CT` → `HundredUnitStrategy`;
- `PC UN JG PR CJ RL KT CX LT PL` → `DirectUnitStrategy`;
- `KG`, `MT` → `MeasuredPackageUnitStrategy` (`CONFIGURATION_REQUIRED` sem `quantity_per_sale_unit`);
- qualquer UNIT futura fora do mapa → `UnsupportedUnitStrategy` (fail closed);
- schema/migrations para `product_sale_unit_config` (ver FASE 7);
- Decimal para dinheiro.

Nada disso foi implementado ainda — motor de produção continua tratando `CT`/PC/KG com a fórmula antiga. Implementação fica para `feat/unit-strategies`, a criar a partir de `origin/main` só após aprovação desta base documental.

## FASE 4 — Política comercial — P0

- separar normalização de política (arquitetura já descrita em `ARCHITECTURE_TARGET.md`);
- `FIXADOR_CENTO` (só produtos `CT`, nunca acoplada por padrão a UNIT futura):
  - +20% varejo;
  - >=100: -20% sobre varejo;
  - 10% de exposição de estoque;
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

## FASE 7 — Embalagens KG/MT — P1

- Caixas → Embalagens (`KG` e `MT`, não só KG);
- tabela genérica `product_sale_unit_config` (campos: `managed_product_id, wake_sku, source_unit, quantity_per_sale_unit, active, created_at, updated_at, updated_by`) — **não** criar tabela por UNIT (`kg_por_caixa`/`metros_por_rolo` separadas);
- UI: rótulo `QT KG` ou `QT MT` conforme `source_unit`;
- preview;
- status configuração (`CONFIGURATION_REQUIRED` quando ausente/inválido);
- preço da unidade de venda;
- estoque da unidade de venda.

### Importação por planilha (roadmap, não implementar antes desta fase)

- KG: `SKU | NOME | QT KG`; MT: `SKU | NOME | QT MT`;
- validar contra a UNIT real do CISS (rejeitar SKU com UNIT incompatível, SKU ausente, quantidade <= 0; reportar duplicados);
- fluxo: upload → preview → validação → válidos/inválidos → confirmação → import → relatório → audit log;
- a modelagem de `product_sale_unit_config` criada nesta fase não pode bloquear esta importação futura.

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
