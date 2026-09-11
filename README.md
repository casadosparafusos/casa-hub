# Casa HUB — Engineering README

Casa HUB é a aplicação interna da Casa dos Parafusos responsável por sincronizar preços e estoques do ERP CISS/POWER para o e-commerce Wake Commerce.

## Baseline canônico da auditoria

- Repositório: `casadosparafusos/casa-hub`
- Branch de produção observada: `main`
- Baseline: `053434ce0209c406add5020fe1c2d259d138e165`
- Data da auditoria: 10/09/2026
- Stack observada: Next.js 15 + React 19 + worker Node/tsx + SQLite/Drizzle
- Escopo de produção atual: fixadores em `UNIT=CENTO`
- Estado: produção operacional, ainda não certificada por reconciliação completa CISS → Wake real.

## Ordem obrigatória de leitura para qualquer agente

1. `README.md`
2. `DOCS/STATUS.md`
3. `DOCS/BUSINESS_RULES.md`
4. `DOCS/PRICE_RULES.md`
5. `DOCS/INVENTORY_RULES.md`
6. `DOCS/UI_UX_REQUIREMENTS.md`
7. `DOCS/ARCHITECTURE_TARGET.md`
8. `DOCS/ROADMAP.md`
9. `DOCS/REPO_WORKFLOW.md`
10. `DOCS/VALIDATION_PROTOCOL.md`
11. `DOCS/PRODUCTION_RECONCILIATION.md`
12. Git real: branch, HEAD, `origin/main`, diff e PR atual.

Conversas antigas e comentários históricos nunca prevalecem sobre Git + documentos canônicos acima.

## Diretório local oficial

`D:\E-commerce\RD_Workspace\Apps Personalizados\Casa dos Parafusos APP's\Casa HUB`

## Regras Git

- `main` contém apenas código aprovado.
- Nunca desenvolver direto em `main`.
- Toda mudança futura ocorre em branch secundária.
- PR obrigatória.
- Merge somente após aprovação explícita do usuário.
- Nunca force-push.
- Nunca `reset --hard` como forma de sincronização.
- Sempre atualizar `DOCS/STATUS.md` antes do fim da rodada.

## Regra de segurança operacional

Nunca considerar “enviado” como “aplicado”.

Fluxo conceitual:

`DETECTED → SENT → VERIFIED`

ou

`DETECTED → SENT → MISMATCH / FAILED`

Preço deve possuir read-after-write.
Estoque deve ser reconciliável contra o estoque real do CD na Wake.

## UNIT é fonte de verdade

A unidade de medida do CISS deve governar a regra:

- `CENTO` → fixadores;
- `PC` / `UN` → peça;
- `KG` → produto vendido em caixa/pacote configurado;
- qualquer outra unidade → fail closed até configuração explícita.

Nunca inferir unidade pelo nome do produto.
