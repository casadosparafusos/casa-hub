# PRODUCTION_RECONCILIATION — preencher no servidor

**Modo inicial:** READ-ONLY
**Rodada:** FASE 0, 10/09/2026 (~16:50–17:30 -03). O detalhe está em `AUDIT_RUNTIME_REPORT.md`.

## Git/runtime

- data: 10/09/2026
- branch: `audit/fase-0-runtime-readonly` (produção roda o `main`)
- SHA: `053434ce0209c406add5020fe1c2d259d138e165`; os 71 arquivos implantados são idênticos ao `main`
- host: `10.0.247.6` (Einstein), `/opt/erp-wake`, usuário `erpwake`, porta 8083
- web active: active (running), MainPID 465676, NRestarts 0
- web enabled: enabled
- worker active: active (running), NRestarts 0
- worker enabled: enabled
- worker PID: 465677 (tsx) → 465701 (node, owner do lock) → 465715 (esbuild); uma instância lógica
- provider preço: **`live`** (via `.env`)
- interval preço: 24 h (`PRICE_SYNC_INTERVAL_HOURS=24`)
- interval estoque: 1 min configurado (`STOCK_SYNC_INTERVAL_MINUTES=1`); na prática, run de ~2,4 min a cada ~4 min, e os ticks intermediários são pulados por lock
- reconciliação: `RECONCILIATION_HOUR_LOCAL` = default 3; **0 runs `reconciliation` na história**

## CISS

- token configurado: sim (criptografado no banco, com prioridade; também no `.env`)
- price endpoint: `POST {CISS_BASE_URL}/products/prices/search` (lotes de 150)
- stock endpoint: `GET {CISS_BASE_URL}/products/stock?product_id=...`
- enterprise: 2 (default do código; a chave não está no banco)
- location: 2

## Wake

- token configurado: sim (`.env`)
- CD: 25
- price table: 74
- promotion: 10365, "PREÇO CENTO - FIXADORES". Validada em 04/09 (qtd 100, −20%); **não relida nesta rodada**
- stock control mode: `fstore` (valor informativo; o motor não lê)

## Whitelist

- total: 2318
- ativos: 2318
- inativos: 0

## UNIT

**NÃO EXECUTADO: bloqueado.** A distribuição exige leitura ao vivo do CISS (`/products/stock` → `unit`), que só é possível no servidor, com o token. O banco local não guarda UNIT.

- CENTO: —
- PC/UN: —
- KG: —
- unsupported: —
- sem UNIT: —

## Reconciliation

**NÃO EXECUTADO: bloqueado** (mesmo motivo). Os números abaixo são apenas de **coerência local** (CISS gravado → calculado → `last_applied`). **Não são Wake.**

- CISS price found: 2317 (estado local)
- CISS price missing: 1 (ciss 28875)
- Wake price found: — (não lido)
- Wake price missing: — (não lido)
- price matches: — (local: calculado = `last_applied` em 2317/2317)
- price mismatches: — (local: 0; as 7 aparentes são empate de arredondamento do SQLite, não do motor)
- stock matches: — (local: calculado = regra CENTO = `last_applied` em 2318/2318)
- stock mismatches: — (local: 0)
- table matches: — (não lido)
- table mismatches: — (não lido)
- errors: CISS sem leitura de estoque para 1273, 28875 e 28899; sem preço para 28875

## Checkout 1/99/100/101

**NÃO EXECUTADO**: é teste de carrinho na loja real e exige janela e autorização.

- SKU: —
- CISS CENTO: —
- qty1: —
- qty99: —
- qty100: —
- qty101: —

## Divergências

Nenhum CSV/JSON gerado: sem leitura da Wake, não há divergência Wake a reportar.
Não corrigir automaticamente na primeira rodada.

## Status

`PARTIAL`. O runtime foi certificado (provider `live`, systemd OK, código = `main`). A Wake não foi validada por leitura.
