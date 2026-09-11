# BUSINESS_RULES — Fonte canônica

## 1. Escopo e whitelist

Somente produtos ativos na whitelist podem ser escritos na Wake.

Desativar produto no Casa HUB:
`managed_products.active = false`

Isso NÃO desativa o produto dentro da Wake.

## 2. Fonte de UNIT

Fonte de verdade:
campo `unit` devolvido pelo CISS/POWER no endpoint de estoque.

**Mapa canônico, OWNER_CONFIRMED em 11/09/2026** (censo global de 22323 produtos, 13 siglas reais; detalhes e evidências em [CISS_UNIT_MAP.md](CISS_UNIT_MAP.md)):

```text
CT                                          -> HUNDRED
PC, UN, JG, PR, CJ, RL, KT, CX, LT, PL      -> DIRECT
KG                                          -> PACKAGE_MEASURED(KG)
MT                                          -> PACKAGE_MEASURED(MT)
qualquer UNIT futura fora deste mapa        -> UNSUPPORTED_UNIT
```

`CT` é a sigla real gravada pelo CISS; "CENTO" é só o apelido usado internamente para a estratégia `HUNDRED`. Nunca inferir esse mapeamento por nome/descrição do produto — só o campo `unit`.

Comportamento para `UNSUPPORTED_UNIT`:
- não calcular;
- não escrever;
- registrar pendência;
- nunca assumir DIRECT nem HUNDRED por padrão (fail closed).

## 3. Separação obrigatória

A arquitetura deve separar:

1. normalização pela UNIT;
2. política comercial;
3. comparação com Wake;
4. escrita;
5. verificação.

Não misturar isso em um único `if` gigante.

## 4. CT / HUNDRED (fixadores)

Normalização (UNIT `CT`, OWNER_CONFIRMED):

`physical_units = estoque_ciss * 100`
`preco_base_unitario = preco_ciss_cento / 100`

Política comercial **FIXADOR_CENTO** é separada da normalização acima — não entra no adapter CISS, fica em `CommercialPolicy`:
- exposição de estoque: `estoque_wake = floor(physical_units * 0.10)`;
- varejo: `preco_varejo = preco_base_unitario * 1.20`;
- a partir de 100 unidades: `preco_atacado = preco_varejo * 0.80`.

Detalhes em `PRICE_RULES.md`.

## 5. DIRECT — PC, UN, JG, PR, CJ, RL, KT, CX, LT, PL

Estoque:
`estoque_wake = floor(max(estoque_ciss, 0))`

Preço:
`preco_base = preco_ciss`

Não aplicar:
- ×100;
- ÷100;
- 10% de estoque;
- markup dos fixadores;
- promoção de fixadores;
- limiar de atacado >=100.

A UNIT do CISS sempre prevalece sobre a descrição do produto — mesmo um texto como "50 peças" não muda a regra de uma UNIT `DIRECT`.

Qualquer margem futura de um destes grupos deve ser política configurável própria, nunca herdada automaticamente do fixador.

## 6. KG e MT — PACKAGE_MEASURED

CISS:
- `KG`: estoque em kg, preço de 1 kg;
- `MT`: estoque em metros, preço de 1 metro.

Cadastro obrigatório por SKU (tabela `product_sale_unit_config`, ver `ARCHITECTURE_TARGET.md`):
`quantity_per_sale_unit` (rótulo de UI `QT KG` ou `QT MT`, conforme a UNIT).

Estoque:
`unidades_venda_wake = floor(max(estoque_ciss_na_unit_de_origem, 0) / quantity_per_sale_unit)`

Preço:
`preco_unidade_venda = preco_ciss_por_unidade_de_origem * quantity_per_sale_unit`

Exemplo (KG):
- estoque CISS = 340 kg
- `QT KG` = 18
- Wake = `floor(340/18) = 18 unidades de venda`, sobra 16 kg (exibida, não vendável)

Sem `quantity_per_sale_unit` configurado e válido (`> 0`):
`CONFIGURATION_REQUIRED`

Não escrever preço nem estoque.

## 7. Erros de origem

Timeout, 5xx, formato inválido ou resposta incompleta do CISS nunca podem virar estoque zero.

Somente uma resposta cujo contrato confirme semanticamente “sem registro = zero” pode gerar zero.

## 8. Certificação

Estado local não é fonte da verdade da Wake.

Resultado certificado:
`expected == WakeLive`

Para preço, read-after-write.
Para estoque, ACK é útil, mas reconciliação precisa de leitura real do CD.
