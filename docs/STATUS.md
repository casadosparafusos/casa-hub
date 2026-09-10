# STATUS — Casa HUB

**Atualizado:** 10/09/2026, ~17:30 (-03), fim da FASE 0
**Baseline auditado:** `053434ce0209c406add5020fe1c2d259d138e165`
**Branch de produção:** `main` (não alterada)
**Branch desta rodada:** `audit/fase-0-runtime-readonly`
**Estado:** `PARTIAL — PRODUÇÃO OPERACIONAL, RUNTIME CERTIFICADO, WAKE NÃO RECONCILIADA`

## Runtime certificado (FASE 0, read-only)

Detalhe e evidências em `AUDIT_RUNTIME_REPORT.md` e `docs/PRODUCTION_RECONCILIATION.md`.

- **Host:** `10.0.247.6` (Einstein), `/opt/erp-wake`, porta 8083.
- **Código:** os 71 arquivos implantados são idênticos ao `main` `053434c`, e as units systemd são idênticas às do repositório.
- **systemd:**
  - `erp-wake-web` e `erp-wake-worker` estão enabled e active;
  - `Restart=always`, `RestartSec=5`, NRestarts 0.
- **Worker:** uma instância lógica.
- **`CISS_PRICE_PROVIDER=live`**: o gate de mock passou.
- **Tokens:** CISS e Wake configurados; `SETTINGS_SECRET_KEY` configurado.
- **Configuração:**
  - CD 25, tabela 74, promoção 10365;
  - enterprise 2, location 2;
  - markup 20%, `STOCK_PERCENT` 10.
- **Whitelist:** 2318 produtos, todos ativos.
- **Coerência local:** estado calculado = regra CENTO = `last_applied` em 100% (preço e estoque). **Isso não é Wake.**
- **Falhas "reconferência não confirmou":** todas anteriores a 10/09 12:46Z; nenhuma depois da correção e da migração.
- **Preço vigente:** base = P/100×1,20 e promoção de −20% a partir de 100 un = 0,96×base. **Bate com o PRICE_RULES.**

## Confirmado no repositório

- Web e worker usam o mesmo motor `runSync()`.
- Wake é escrito em lotes de até 50.
- Há lock entre sincronizações.
- Há recuperação de runs órfãs no boot do worker.
- Units systemd de web e worker contêm `Restart=always` e `RestartSec=5`.
- Tokens CISS e Wake são separados.
- Segredos podem ser criptografados.
- `.env`, bancos e logs ficam fora do Git.
- Motor atual de preço é CENTO-only: divide sempre por 100.
- Motor atual de estoque é CENTO-only: multiplica sempre por 100.
- Endpoint CISS de estoque recebe `unit`, mas a camada de domínio atual descarta o campo.
- Não existe single-SKU.
- Não existe toggle de whitelist pela UI.
- Não existe realtime profissional.
- Runs automáticos e itens `no_change` são persistidos: 138.902 linhas `no_change` em ~1,5 h de produção.
- A "reconciliação" reaproveita o mesmo `runSync()` e **nunca rodou** (0 runs `reconciliation`). Motivo: disparo só em `HH:00`, e o `LockUnavailableError` é engolido sem nova tentativa no dia.
- A tabela de preço não tem readback depois da escrita, e o contador conta duas vezes.
- `GET /api/settings` responde 200 sem sessão (sem segredo; só valores não secretos e booleanos).
- `CSV_IDENTIFIER_TYPE`, `WAKE_PROMOTION_ID`, `WAKE_STOCK_CONTROL_MODE` e `WHOLESALE_MIN_QTY` não governam o motor.

## P0

- ~~Confirmar `.env` real e `CISS_PRICE_PROVIDER`~~: **feito**, está `live`.
- Bloquear `mock → write Wake` (o default do código continua `mock`).
- Implementar a reconciliação CISS → esperado → Wake ao vivo. **Bloqueada** até autorização (ver "Próxima ação").
- Implementar a leitura real de estoque Wake por SKU/CD (`GET /produtos?centrosDistribuicao=25`, com cursor).
- Verificar a Tabela de Preço após a escrita.
- Consolidar e testar a regra 1/99/100/101.
- UnitStrategy para CENTO, PC/UN e KG. A distribuição real de UNIT ainda é **desconhecida**.
- Persistir `UNIT`.
- Configuração `kg_por_caixa`.
- Validação semântica de settings.
- **Novo:** a Wake deprecia `pagina` em 21/09/2026. Confirmado para `GET /produtos`; **não confirmado** para `/tabelaPrecos/{id}/produtos` e `/promocoes`, que o código usa.
- **Novo:** o teste prático de restart (kill e reboot) não foi feito e depende de janela.

## P1

- Histórico sem no-change massivo.
- `sync_status` / heartbeat (pré-requisito para cortar o no-op, porque o scheduler usa `sync_runs` como relógio).
- Tick serial no worker (hoje cerca de 3 "lock em uso" por ciclo).
- `GET /api/settings` autenticado.
- `erp_stock` com tipo correto (hoje é `integer` com valor fracionário).
- Textos da UI: `/precos` (≥100) e `/configuracoes` (`CSV_IDENTIFIER_TYPE`).
- Busca e paginação.
- Single-SKU.
- Ativar/inativar produto.
- SSE/realtime.
- Reorganização de Configurações.
- health/ready.
- Roles e rate-limit de login.
- CI.
- 3 produtos sem leitura CISS: 1273, 28875 e 28899.

## Bloqueios

- **Reconciliação ao vivo, distribuição de UNIT:** exigem executar leitura com os tokens no servidor. A execução de script remoto está bloqueada e aguarda autorização explícita.
- **Checkout 1/99/100/101 e restart:** exigem janela.

## Próxima ação

Autorização do usuário para uma destas opções:

**(a)** Branch `audit/reconciliacao-readonly` com o script de reconciliação **só GET**.
- Wake: `/produtos` com CD 25 e cursor, `/tabelaPrecos/74/produtos` e `/promocoes/10365`.
- CISS: preço e estoque com `unit`.
- Garantias: ≤30 req/min, aborta no primeiro 429, saída CSV/JSON, testado com mocks.
- Depois, **uma** execução no servidor.

**(b)** Janela para o teste de kill/restart do worker e do web.
