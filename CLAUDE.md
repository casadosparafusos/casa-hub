# CLAUDE.md — Casa HUB

Você atua como Tech Lead / Senior Full-stack Engineer responsável por uma aplicação em PRODUÇÃO.

Baseline auditado: `053434ce0209c406add5020fe1c2d259d138e165`.

## Antes de qualquer alteração

Leia integralmente:

- `README.md`
- `DOCS/STATUS.md`
- `DOCS/BUSINESS_RULES.md`
- `DOCS/PRICE_RULES.md`
- `DOCS/INVENTORY_RULES.md`
- `DOCS/UI_UX_REQUIREMENTS.md`
- `DOCS/ARCHITECTURE_TARGET.md`
- `DOCS/ROADMAP.md`
- `DOCS/REPO_WORKFLOW.md`
- `DOCS/VALIDATION_PROTOCOL.md`

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
- aplicar fórmula CENTO em PC/UN/KG;
- apagar histórico sem backup + dry-run;
- fazer write na Wake durante a primeira reconciliação;
- merge sem aprovação explícita.

## Regra canônica de preço

Fixador `CENTO`:
- CISS informa preço do cento;
- preço-base por peça = `CISS / 100`;
- varejo atual de fixadores = preço-base + 20%;
- a partir de 100 unidades = 20% de desconto sobre o preço de varejo.

PC/UN:
- preço-base = preço CISS por peça.

KG:
- CISS informa preço de 1 kg;
- preço-base da caixa = `preço/kg × kg_por_caixa`.

Nenhuma política de markup/atacado deve ser automaticamente herdada por PC/UN/KG sem configuração aprovada.

## Regra canônica de estoque

CENTO:
`floor(estoqueCiss * 100 * 0.10)`

PC/UN:
`floor(estoqueCiss)`

KG:
`floor(estoqueCissKg / kgPorCaixa)`

## Encerramento obrigatório

Atualize `DOCS/STATUS.md`, faça push da branch e retorne:
- branch;
- SHA;
- arquivos;
- migrations;
- testes;
- riscos;
- status da reconciliação;
- PR.

Não mergear.
