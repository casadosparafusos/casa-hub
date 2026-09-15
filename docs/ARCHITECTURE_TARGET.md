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

Mapa canônico OWNER_CONFIRMED em 11/09/2026 (`CISS_UNIT_MAP.md`):

```text
CT                                     -> HundredUnitStrategy
PC UN JG PR CJ RL KT CX LT PL          -> DirectUnitStrategy
KG                                     -> MeasuredPackageUnitStrategy(KG)
MT                                     -> MeasuredPackageUnitStrategy(MT)
qualquer UNIT futura fora do mapa      -> UnsupportedUnitStrategy (fail closed)
```

Nomeação deliberada: **não** existe `PieceStrategy` — o grupo `DIRECT` inclui JG/PR/CJ/RL/CX, que não são semanticamente "peça"; por isso `DirectUnitStrategy`. Uma UNIT nova e desconhecida nunca vira `DirectUnitStrategy` por padrão — cai em `UnsupportedUnitStrategy`.

## Separação de preço

`UnitNormalizer` (normalização matemática, por UNIT):
- `CT` (HUNDRED): `ciss_price / 100`
- `PC UN JG PR CJ RL KT CX LT PL` (DIRECT): `ciss_price`
- `KG` / `MT` (PACKAGE_MEASURED): `ciss_price_por_unidade_origem * quantity_per_sale_unit`

`CommercialPolicy` (separada da normalização — nunca no adapter CISS):
- `FIXADOR_CENTO` (só para produtos `CT`): varejo +20%; >=100 unidades: desconto 20% sobre varejo; exposição de estoque 10%.
- `DIRECT`: sem regra extra por padrão.
- `PACKAGE_MEASURED`: sem regra extra por padrão.

## Estoque

`CT` (HUNDRED), normalização + política FIXADOR_CENTO:
`floor(raw*100*0.10)`

`PC UN JG PR CJ RL KT CX LT PL` (DIRECT):
`floor(max(raw,0))`

`KG` / `MT` (PACKAGE_MEASURED):
`floor(max(raw,0)/quantity_per_sale_unit)`

## Reconciliation

A reconciliação nunca usa `lastApplied*` como substituto da Wake.

`ExpectedWakeState` deve ser comparado com `WakeLiveState`.

## Persistência

Separar:
- `managed_products`;
- estado atual por produto;
- UNIT observada;
- `product_sale_unit_config` (genérica para KG e MT — não uma tabela por UNIT — campos: `managed_product_id, wake_sku, source_unit, quantity_per_sale_unit, active, created_at, updated_at, updated_by`; **criada em `feat/unit-strategies` (migration `0003_unit_strategies_schema.sql`), não aplicada em produção**). Integridade provada contra banco real na FASE B.1 (hardening): FK, índice único parcial (`active=1`) e CHECK `quantity_per_sale_unit > 0` funcionam no nível do banco. **Gap conhecido, não corrigido**: `source_unit` só é restrito a KG/MT pelo tipo TypeScript — não há CHECK/enum no SQL; sem impacto funcional hoje porque o motor (`UnitResolver`) falha closed antes de qualquer escrita para uma UNIT fora do mapa;
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
