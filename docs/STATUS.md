# STATUS — Casa HUB

**Atualizado:** 10/09/2026  
**Baseline auditado:** `053434ce0209c406add5020fe1c2d259d138e165`  
**Branch de produção:** `main`  
**Estado:** `PARTIAL — PRODUÇÃO OPERACIONAL, NÃO CERTIFICADA`

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
- Runs automáticos e itens `no_change` são persistidos.
- A “reconciliação” atual reaproveita o mesmo `runSync()` e não garante detecção de drift direto na Wake.
- `main` continua no baseline `053434ce0209c406add5020fe1c2d259d138e165`.

## P0

- Confirmar `.env` real e `CISS_PRICE_PROVIDER`.
- Bloquear `mock → write Wake`.
- Implementar reconciliação CISS → esperado → Wake ao vivo.
- Implementar leitura real de estoque Wake por SKU/CD.
- Verificar Tabela de Preço após escrita.
- Consolidar e testar regra 1/99/100/101.
- UnitStrategy para CENTO, PC/UN e KG.
- Persistir `UNIT`.
- Configuração `kg_por_caixa`.
- Validação semântica de settings.

## P1

- Histórico sem no-change massivo.
- `sync_status` / heartbeat.
- busca e paginação;
- single-SKU;
- ativar/inativar produto;
- SSE/realtime;
- reorganização Configurações;
- health/ready;
- roles e rate-limit de login;
- CI.

## Runtime ainda não certificado pelo GitHub

GitHub não prova:
- `.env` do servidor;
- SQLite real;
- `systemctl is-enabled/is-active`;
- logs atuais;
- CISS ao vivo;
- Wake ao vivo;
- conteúdo efetivo da Tabela/Promoção;
- próxima rodada real.

A próxima ação deve ser auditoria runtime READ-ONLY.
