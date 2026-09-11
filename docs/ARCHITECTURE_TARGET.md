# ARCHITECTURE_TARGET — Casa HUB v2

## Fluxo

CISS Adapter
→ Whitelist
→ UnitResolver
→ UnitNormalizer
→ CommercialPolicy
→ ExpectedWakeState
→ DiffEngine
→ WakeWriter
→ WakeReadback
→ Verification
→ Persistence
→ UI/SSE

## UnitResolver

Fonte única:
`CISS stock.unit`

Estratégias:
- `HundredStrategy`
- `PieceStrategy`
- `KgPackageStrategy`
- `UnsupportedStrategy`

## Separação de preço

`UnitNormalizer`:
- CENTO: CISS/100
- PC/UN: CISS
- KG: CISS/kg × kgPorCaixa

`CommercialPolicy`:
- FIXADOR_CENTO:
  - varejo +20%;
  - >=100 desconto 20% sobre varejo.
- PC/UN: inicialmente sem regra extra.
- KG: inicialmente sem regra extra.

## Estoque

CENTO:
`floor(raw*100*0.10)`

PC:
`floor(raw)`

KG:
`floor(raw/kgPorCaixa)`

## Reconciliation

A reconciliação nunca usa `lastApplied*` como substituto da Wake.

`ExpectedWakeState` deve ser comparado com `WakeLiveState`.

## Persistência

Separar:
- `managed_products`;
- estado atual por produto;
- UNIT observada;
- packaging KG;
- scheduler/heartbeat;
- runs relevantes;
- itens alterados/falhos/divergentes;
- audit log.

## Single-SKU

O mesmo core deve aceitar:
- lista inteira;
- conjunto de IDs;
- 1 managed product.

Não duplicar regra em uma rota especial.

## Realtime

POST manual:
- cria/agenda run;
- retorna runId;
- trabalho continua;
- UI acompanha por SSE.

## Health

- `/healthz`: processo vivo;
- `/readyz`: DB/worker/config básica pronta;
- health operacional detalhado autenticado.
