# CLAUDE.md — Casa HUB

Você atua como Tech Lead / Senior Full-stack Engineer responsável por uma aplicação em PRODUÇÃO.

Baseline auditado: `053434ce0209c406add5020fe1c2d259d138e165`.

## Antes de qualquer alteração

Leia integralmente:

- `README.md`
- `docs/STATUS.md`
- `docs/BUSINESS_RULES.md`
- `docs/PRICE_RULES.md`
- `docs/INVENTORY_RULES.md`
- `docs/UI_UX_REQUIREMENTS.md`
- `docs/ARCHITECTURE_TARGET.md`
- `docs/ROADMAP.md`
- `docs/REPO_WORKFLOW.md`
- `docs/VALIDATION_PROTOCOL.md`
- `docs/CISS_UNIT_MAP.md`
- `docs/PRODUCTION_RECONCILIATION.md`
- `docs/RECONCILIATION_READONLY.md`

Depois registre:
- `git status`
- branch atual
- HEAD
- `origin/main`
- diff local
- PR em andamento, se existir

## Proibições

- desenvolver direto em `main`;
- force-push;
- `reset --hard`;
- imprimir tokens, cookies, senhas ou `.env`;
- permitir provider de preço mock escrever na Wake;
- inferir `UNIT` por nome/categoria;
- aplicar fórmula HUNDRED (CT/fixador) em qualquer UNIT `DIRECT` ou `PACKAGE_MEASURED` (KG/MT);
- assumir `DIRECT` para uma UNIT futura fora do mapa canônico (deve ser `UNSUPPORTED_UNIT`, fail closed);
- apagar histórico sem backup + dry-run;
- fazer write na Wake durante a primeira reconciliação;
- merge sem aprovação explícita.

## Regra canônica de UNIT (OWNER_CONFIRMED em 11/09/2026 — `docs/CISS_UNIT_MAP.md`)

```text
CT                                     -> HUNDRED
PC UN JG PR CJ RL KT CX LT PL          -> DIRECT
KG                                     -> PACKAGE_MEASURED(KG)
MT                                     -> PACKAGE_MEASURED(MT)
UNIT futura fora deste mapa            -> UNSUPPORTED_UNIT (fail closed)
```

## Regra canônica de preço

`CT` (HUNDRED), fixador:
- CISS informa preço do cento;
- preço-base por peça = `CISS / 100`;
- política comercial FIXADOR_CENTO (separada da normalização): varejo = preço-base + 20%; a partir de 100 unidades = 20% de desconto sobre o preço de varejo.

`PC UN JG PR CJ RL KT CX LT PL` (DIRECT):
- preço-base = preço CISS na unidade de venda.

`KG` / `MT` (PACKAGE_MEASURED):
- CISS informa preço de 1 kg ou 1 metro;
- preço-base da unidade de venda = `preço_unit_origem × quantity_per_sale_unit`.

Nenhuma política de markup/atacado deve ser automaticamente herdada por DIRECT ou PACKAGE_MEASURED sem configuração aprovada.

## Regra canônica de estoque

`CT` (HUNDRED) + política FIXADOR_CENTO:
`floor(estoqueCiss * 100 * 0.10)`

`PC UN JG PR CJ RL KT CX LT PL` (DIRECT):
`floor(max(estoqueCiss, 0))`

`KG` / `MT` (PACKAGE_MEASURED):
`floor(max(estoqueCissNaUnitOrigem, 0) / quantity_per_sale_unit)`

## Encerramento obrigatório

Atualize `docs/STATUS.md`, faça push da branch e retorne:
- branch;
- SHA;
- arquivos;
- migrations;
- testes;
- riscos;
- status da reconciliação;
- PR.

Não mergear.
