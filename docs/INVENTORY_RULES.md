# INVENTORY_RULES — Regras canônicas de estoque

## CENTO — fixadores

CISS:
`UNIT=CENTO`

Conversão:
`physical_units = max(estoque_ciss, 0) * 100`

Exposição atual:
`wake_stock = floor(physical_units * 0.10)`

O 10% é regra específica dos fixadores atuais.

## PC / UN

`wake_stock = floor(max(estoque_ciss, 0))`

1 PC = 1 PC.

Não usar ×100.
Não usar 10%.

## KG vendido em caixa

Cadastro:
`kg_por_caixa > 0`

CISS:
estoque bruto em kg.

Wake:
`wake_stock = floor(max(estoque_ciss_kg, 0) / kg_por_caixa)`

Exemplo:
`340kg / 18kg = 18 caixas`, sobra 16 kg.

A sobra deve ser exibida para auditoria, mas não vira caixa vendável.

## Fail closed

Se:
- UNIT desconhecida;
- `kg_por_caixa` ausente;
- número inválido;
- resposta CISS inválida;

então:
- não escrever Wake;
- registrar motivo;
- não inventar zero;
- não usar fórmula CENTO como fallback.

## Tipo de dado

O estoque raw do ERP pode ser fracionário.

Não persistir `erp_stock` como integer se o CISS puder devolver fração.

O estoque final enviado à Wake deve ser inteiro.
