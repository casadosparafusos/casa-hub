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
- `product_sale_unit_config` (genérica para KG e MT — não uma tabela por UNIT — campos: `managed_product_id, source_unit, quantity_per_sale_unit, active, created_at, updated_at, updated_by`; SKU nunca denormalizado aqui — resolvível só via JOIN com `managed_products`. **Criada em `feat/unit-strategies` (migration `0003_unit_strategies_schema.sql`), reformulada na FASE B.2 (migration `0004_public_betty_brant.sql`: remove `wake_sku`, adiciona CHECK de `source_unit`), não aplicada em produção**). Integridade provada contra banco real: FK, índice único parcial (`active=1`) e CHECK `quantity_per_sale_unit > 0` (FASE B.1) e CHECK `source_unit IN ('KG','MT')` (FASE B.2) funcionam no nível do banco, não só no tipo TypeScript;
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

## Roteamento comercial — Tabela de Preço 74 vs atacarejo nativo Wake (FASE B.4, 16/09/2026)

Três mecanismos comerciais distintos, nunca confundir:

```text
1. preço base/varejo do produto        -- endpoint padrão de preço da Wake
2. Tabela de Preço 74                  -- mecanismo próprio deste app (precoDe fictício)
3. atacarejo/promoção por quantidade   -- mecanismo nativo da Wake (listaAtacado / promoção 10365)
```

**Gate da Tabela 74** (`src/lib/sync/engine.ts`, `syncPrices()`, linha ~409): os writers `addWakePriceTableProducts`/`updateWakePriceTableProducts` só são chamados quando `priceResult.policy === 'FIXADOR_CENTO'` — nunca apenas porque `WAKE_PRICE_TABLE_ID` está configurado, e nunca apenas porque `unitClass === 'HUNDRED'` (um `CT` pode navegar como `policy: 'NONE'` via `commercialPolicyOverride`, ver `resolveCommercialPolicy` em `src/lib/units/policy-resolver.ts`). `policy` é a única fonte de verdade — `UnitPriceResult.policy` (`src/lib/pricing/engine.ts`), originada em `computeUnit()`.

Rotas por UNIT (escopo atual):

```text
CT + FIXADOR_CENTO      -> participa da Tabela 74
DIRECT                  -> NÃO participa
PACKAGE_MEASURED (KG)   -> NÃO participa
PACKAGE_MEASURED (MT)   -> NÃO participa
CT + NoCommercialPolicy -> NÃO participa
```

O `precoDe` da Tabela 74 é **fictício** (`retailPrice * 1.30`, constante `TABLE_FAKE_DISCOUNT_PERCENT` em `sync/engine.ts`) e fica isolado a esse mecanismo — nunca entra no payload base enviado a `updateWakePrices`.

**Semântica de `expectedWholesalePrice`** (`UnitPriceResult.expectedWholesalePrice`, `src/lib/pricing/engine.ts`, renomeado de `wholesalePrice` na FASE B.4): valor de atacado **esperado/calculado pelo domínio** para produtos `FIXADOR_CENTO`, usado hoje só para auditoria/comparação futura — **nenhum caminho de escrita real (`sync/engine.ts`) o publica na Wake nesta fase**. Colunas legadas no banco (`calculatedWakeSpecialPrice`, `lastAppliedWakeSpecialPrice`) mantêm o nome antigo de propósito (renomear exigiria migration sem ganho imediato nesta rodada) — tratá-las como legado, não como fonte de verdade do domínio.

O comportamento real de atacarejo (>=100 unidades) hoje depende inteiramente do que já está configurado na Wake nativamente (promoção 10365 e/ou `listaAtacado`) — **não** do `expectedWholesalePrice` calculado aqui. Isso será validado READ-ONLY na FASE C, nunca escrito nesta fase.

**Mecanismos nativos Wake — referência arquitetural (sem writes)**:
- endpoint de preço base (`updateWakePrices`): preço/estoque padrão por SKU;
- Tabela de Preço (`getWakePriceTableProducts`/`add`/`updateWakePriceTableProducts`, ID 74 neste ambiente): mecanismo específico deste app, usa `precoDe`/`precoPor`, gatilhado só por `policy === 'FIXADOR_CENTO'`;
- `listaAtacado` no produto Wake (`precoPor` + `quantidade`) e consulta específica de atacarejo por produto — mecanismo nativo de tier de quantidade, **não escrito por este app**;
- Storefront `prices.wholesalePrices` — exposição pro cliente final do atacarejo nativo, **não escrito por este app**;
- promoção 10365 (`WAKE_PROMOTION_ID`): hoje só usada como settings/gate de UI, **nunca referenciada em write real**; semântica completa (condição 4, ação 2, escopo) ainda `UNVERIFIED` (ver `RECONCILIATION_READONLY.md`) — não alterada nesta fase.

### Pendência explícita FASE C (READ-ONLY, antes de qualquer remediation/write)

```text
- ler promoção 10365 (condição/ativo/vigência/percentual/escopo);
- ler atacarejo real (listaAtacado) dos SKUs de controle;
- comparar Storefront prices.wholesalePrices/tier quando aplicável;
- validar checkout 1/99/100/101 em janela aprovada;
- só então decidir remediation/write, com aprovação explícita separada.
```

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
