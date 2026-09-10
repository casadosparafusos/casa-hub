# ERP → Wake Hub

Integração interna Casa dos Parafusos: sincroniza **preço** e **estoque**
do ERP (CISS/PODER) para o Wake Commerce, escopo restrito a
fixadores/parafusos administrados por uma whitelist. App independente da
Reposição de Estoque -- próprio banco, próprio serviço, mesmo padrão de
infra (Portal/nginx/systemd).

## Por que este app existe separado da Reposição

A especificação original (seção "PRIMEIRO PASSO DO CLAUDE") pediu
explicitamente uma aplicação nova, não um módulo da Reposição -- mesmo
compartilhando servidor, padrão de auth e visual. Motivos práticos:
escopo de dados completamente diferente (preço/estoque pro Wake, não
gestão de lotes/transferência), e nenhuma dependência funcional real
entre as duas.

## Arquitetura em uma página

- **Auth**: zero código próprio. O Portal Interno (`127.0.0.1:8020`) faz
  todo o trabalho via `auth_request` no nginx -- ver
  `deploy/nginx-erp-wake.conf`. Este app só lê os headers
  `X-Auth-User`/`X-Auth-Display`/`X-Auth-Master` (`src/lib/auth.ts`),
  nunca decide sozinho quem pode entrar.
- **Dois processos**: web (Next.js, dashboard + disparo manual) e worker
  (`worker/index.ts`, processo Node standalone, roda como systemd
  independente, sync horária + reconciliação diária às 03:00). Ambos
  chamam o mesmo `runSync()` em `src/lib/sync/engine.ts` -- não há
  lógica de sincronização duplicada entre o caminho manual e o
  agendado.
- **Lock**: `job_locks` (SQLite) impede que o worker e um disparo manual
  rodem o mesmo tipo de sync ao mesmo tempo (`src/lib/sync/lock.ts`).
- **Banco**: SQLite próprio via Drizzle (`src/lib/db/schema.ts`), nunca
  compartilhado com o `app.db` da Reposição.
- **Motores puros**: `src/lib/pricing/engine.ts` e
  `src/lib/inventory/engine.ts` não fazem I/O -- só recebem número, devolvem
  número, fáceis de testar (`npm test`).
- **Fonte de preço do ERP**: atrás de um provider trocável
  (`src/lib/ciss/price-provider.ts`) porque o campo real ainda não existe
  no CISS -- ver `docs/PEDIDO-CISS-PRECO.md`. Estoque não tem esse
  problema e já lê dado real (`src/lib/ciss/stock.ts`).

## O que ainda falta antes de qualquer sync real contra produção

Ver `src/lib/settings.ts` (`REQUIRED_UNCONFIRMED_KEYS`) e a tela
Configurações -- nenhum desses é inventado, todos ficam bloqueando
sincronização real (não dry-run) até serem preenchidos:

- `WAKE_CD_ID`, `WAKE_STOCK_CONTROL_MODE`, `WAKE_PRICE_TABLE_ID`,
  `WAKE_PROMOTION_ID` -- precisam do admin do Wake.
- `CSV_IDENTIFIER_TYPE` -- decisão de qual identificador (SKU ou ID
  interno) usar nas chamadas de escrita do Wake.

`CISS_STOCK_ENTERPRISE`/`CISS_STOCK_LOCATION` NÃO estão mais nessa lista:
já têm default real (empresa=2, local=5 = "ESTOQUE CD"), confirmado por
sondagem direta da API CISS e validado em produção pelo sync da Reposição
(mesmo CD que abastece o e-commerce) -- não é valor inventado. Continuam
editáveis em Configurações caso o SIGAS confirme outro local no futuro. Ver
`src/lib/settings.ts` (`STOCK_SOURCE_DEFAULTS`).
- Campo de preço de varejo no CISS -- pedido formal em
  `docs/PEDIDO-CISS-PRECO.md`, ainda sem resposta do SIGAS.
- Mecanismo real de preço-por-produto numa Tabela de Preço do Wake, e
  criação da Promoção -- ver `docs/WAKE-API-CONTRATOS.md`, seção "NÃO
  CONFIRMADO".
- Os 3 cenários de preflight (99 vs 100un, combo misto, whitelisted +
  não-whitelisted) -- ainda não executados.
- CSV real da whitelist -- usuário ainda não tem, importar quando
  disponível via tela Produtos.

## Deploy (resumo -- seguir o padrão já usado nos outros apps)

1. `scp` do projeto pra `/tmp` no servidor, depois mover pra
   `/opt/erp-wake` com `sudo cp` + `chown erpwake:erpwake` (criar o
   usuário de serviço `erpwake` se ainda não existir).
2. **Build no servidor**, nunca copiar `.next`/`node_modules` da estação
   (mesma regra da Reposição/RD Gerencial -- ver memória
   `deploy-dist-rd-gerencial-no-servidor`).
3. `npm run db:generate` + `npm run db:migrate` pra criar o schema.
4. Copiar `.env.example` pra `.env`, preencher, `chmod 600`.
5. Copiar as 2 units (`deploy/erp-wake-web.service`,
   `deploy/erp-wake-worker.service`) pra `/etc/systemd/system/`,
   `systemctl daemon-reload`, `enable --now` os dois.
6. Copiar `deploy/nginx-erp-wake.conf` pra
   `/etc/nginx/sites-available/erp-wake`, symlink em `sites-enabled`,
   `nginx -t`, `systemctl reload nginx`.
7. Rodar `deploy/portal-registration.sql` contra o SQLite do Portal (com
   backup antes), ajustando `<ID_DO_USUARIO>`.
8. Testar os três casos: sem sessão → redireciona pro Portal; sessão sem
   permissão `erp_wake` → 403/redireciona; sessão com permissão → carrega
   com o menu de conta compartilhado.
9. Só depois disso, primeira sincronização em **dry-run**, revisar
   `/historico`, e então liberar sync real seguindo o rollout faseado
   (5% → 50% → 100% da whitelist, via `active` em `managed_products`).
