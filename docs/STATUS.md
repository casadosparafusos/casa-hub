# STATUS — Casa Hub

Atualizado em 10/09/2026.

## Produção

- `main` = `053434c` = o que roda em `10.0.247.6:/opt/erp-wake` (porta 8083, usuário `erpwake`). **Intocado.**
- Todo desenvolvimento acontece local e em branches; nada é deployado sem pedido explícito.

## Branches abertas (sem merge)

| Branch | Base | Estado |
|---|---|---|
| `audit/fase-0-runtime-readonly` | main | FASE 0: auditoria de runtime. **PARTIAL**: provider live e systemd ok; reconciliação ao vivo pendente (ver abaixo). |
| `audit/reconciliacao-readonly` | main 053434c | Reconciliador READ-ONLY implementado e testado com mocks. **Nunca executado no servidor.** Aguarda aprovação para UMA execução. |

## Reconciliador READ-ONLY — `audit/reconciliacao-readonly`

Detalhes em [RECONCILIATION_READONLY.md](RECONCILIATION_READONLY.md).

- Script: `scripts/reconcile-readonly.ts`; módulos em `scripts/reconcile/`.
- Compara CISS real → UNIT (campo `unit` do CISS) → regra esperada → Wake real, e grava `artifacts/reconciliation-YYYYMMDD-HHMM.{json,csv}`.
- **Sem write path:**
  - Wake/CISS só GET;
  - SQLite `readonly` + `query_only`;
  - nenhum import de sync, cliente Wake, settings ou db da aplicação;
  - provado por `no-write-path.test.ts`.
- Rate limit Wake: ≤ 30 req/min, cursor de 50 em `/produtos`, aborta no primeiro 429.
- Testes: `scripts/reconcile/*.test.ts`. Cobrem:
  - CENTO, PC, UN, KG com e sem embalagem, unsupported;
  - ausência no CISS e ausência na Wake;
  - mismatch de preço e de estoque;
  - cursor com mais de 50 itens;
  - 429 abortando com segurança;
  - ausência de segredos no relatório.

### Correção registrada (borda de ponto flutuante)

A FASE 0 afirmou que a fórmula de estoque de produção (`Math.floor(s*100*0.10)`) poderia perder 1 unidade por ruído de float (ex.: 2,3 → 22). **A afirmação estava errada.** Em JS, `2.3*100*0.1 === 23`, e uma busca exaustiva em todos os valores com até 3 casas decimais entre 0 e 1000 não encontrou nenhuma divergência. O reconciliador ainda usa um `safeFloor` defensivo e marca `floatEdgeNote` se algum valor real divergir, mas isso não é um bug conhecido de produção.

### Execução proposta (aguardando aprovação — UMA vez)

1. Copiar o conteúdo da branch para um diretório temporário no servidor (não tocar em `/opt/erp-wake`).
2. Como `erpwake`: `tsx <tmp>/scripts/reconcile-readonly.ts --root /opt/erp-wake --env-file /opt/erp-wake/.env --plan` (sem rede; confirma a whitelist, o intervalo e a estimativa).
3. Se o plano estiver ok: a mesma linha sem `--plan` e com `--out <tmp>/out`.
4. Trazer só os artefatos (sem segredo; varridos antes de gravar) e analisar. **Não corrigir divergências** nesta fase.

Estimativa: Wake ~95 a ~450 GETs (~3 a 15 min a 30 req/min); CISS ~2.334 GETs (~5 a 15 min).

## Pendências conhecidas

- KG sem `kg_por_caixa` → `CONFIGURATION_REQUIRED`. O cadastro de embalagem ainda não existe (nenhuma migration criada, de propósito).
- Correções de UNIT no motor de produção (hoje trata tudo como CENTO) só depois da reconciliação real e de aprovação.
