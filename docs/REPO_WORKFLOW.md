# REPO_WORKFLOW — Git e continuidade

Repo:
`git@github.com:casadosparafusos/casa-hub.git`

Diretório local:
`D:\E-commerce\RD_Workspace\Apps Personalizados\Casa dos Parafusos APP's\Casa HUB`

## Início de rodada

1. entrar no diretório;
2. `git status`;
3. confirmar remote;
4. `git fetch --all --prune`;
5. comparar HEAD com `origin/main`;
6. garantir working tree conhecido;
7. criar branch secundária a partir da `main`.

## Nomeação

- `audit/...`
- `fix/...`
- `feat/...`
- `docs/...`

## Fim de rodada

- testes;
- build;
- atualizar STATUS;
- commits atômicos;
- push da branch;
- abrir PR;
- entregar SHA + PR + relatório.

## Merge

Somente após aprovação explícita.

Após merge:
- atualizar local `main` por fast-forward;
- não rebasear histórico de produção;
- não force-push.
