# INVENTORY_RULES — Regras canônicas de estoque

Mapa canônico OWNER_CONFIRMED em 11/09/2026 — ver `CISS_UNIT_MAP.md` e `BUSINESS_RULES.md §2`.

## CT / HUNDRED — fixadores

CISS:
`UNIT=CT`

Normalização:
`physical_units = max(estoque_ciss, 0) * 100`

Exposição (política comercial FIXADOR_CENTO, separada da normalização):
`wake_stock = floor(physical_units * 0.10)`

O 10% é regra específica da política comercial de fixadores, não da UNIT `CT` em si.

## DIRECT — PC, UN, JG, PR, CJ, RL, KT, CX, LT, PL

`wake_stock = floor(max(estoque_ciss, 0))`

1 unidade CISS = 1 unidade Wake.

Não usar ×100.
Não usar 10%.
Não usar nenhum fator de fixador.

## KG e MT — PACKAGE_MEASURED

Cadastro por SKU (`product_sale_unit_config`):
`quantity_per_sale_unit > 0` (UI: `QT KG` ou `QT MT`)

CISS:
estoque bruto na unidade de origem (kg ou metros).

Wake:
`wake_stock = floor(max(estoque_ciss_na_unit_origem, 0) / quantity_per_sale_unit)`

Exemplo (KG):
`340kg / 18kg = 18 unidades de venda`, sobra 16 kg.

A sobra deve ser exibida para auditoria, mas não vira unidade vendável.

## Fail closed

Se:
- UNIT desconhecida (fora do mapa canônico → `UNSUPPORTED_UNIT`);
- `quantity_per_sale_unit` ausente ou inválido (KG/MT) → `CONFIGURATION_REQUIRED`;
- número inválido;
- resposta CISS inválida;

então:
- não escrever Wake;
- registrar motivo;
- não inventar zero;
- não usar fórmula HUNDRED nem DIRECT como fallback.

## Tipo de dado

O estoque raw do ERP pode ser fracionário.

Não persistir `erp_stock` como integer se o CISS puder devolver fração.

O estoque final enviado à Wake deve ser inteiro.
