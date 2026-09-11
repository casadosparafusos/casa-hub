# BUSINESS_RULES — Fonte canônica

## 1. Escopo e whitelist

Somente produtos ativos na whitelist podem ser escritos na Wake.

Desativar produto no Casa HUB:
`managed_products.active = false`

Isso NÃO desativa o produto dentro da Wake.

## 2. Fonte de UNIT

Fonte de verdade:
campo `unit` devolvido pelo CISS/POWER no endpoint de estoque.

Mapeamento inicial:

- `CENTO` → fixadores;
- `PC` e `UN` → produtos normais;
- `KG` → produto controlado em kg e vendido em embalagem configurada.

Qualquer outra UNIT:
`UNSUPPORTED_UNIT`

Comportamento:
- não calcular;
- não escrever;
- registrar pendência;
- nunca assumir PC.

## 3. Separação obrigatória

A arquitetura deve separar:

1. normalização pela UNIT;
2. política comercial;
3. comparação com Wake;
4. escrita;
5. verificação.

Não misturar isso em um único `if` gigante.

## 4. Fixadores CENTO

Estoque CISS em CENTO:
`unidades_fisicas = estoque_ciss * 100`

Somente fixadores expõem 10%:
`estoque_wake = floor(unidades_fisicas * 0.10)`

Preço CISS em CENTO:
`preco_base_unitario = preco_ciss_cento / 100`

Política comercial atual:
- varejo: +20%;
- a partir de 100 unidades: desconto de 20% sobre o varejo.

Detalhes em `PRICE_RULES.md`.

## 5. PC / UN

Estoque:
`estoque_wake = floor(estoque_ciss)`

Preço:
`preco_base = preco_ciss`

Não aplicar:
- ×100;
- ÷100;
- 10% de estoque;
- markup dos fixadores;
- promoção de fixadores.

Qualquer margem futura de PC/UN deve ser política configurável própria.

## 6. KG

CISS:
- estoque em kg;
- preço de 1 kg.

Cadastro obrigatório no Casa HUB:
`kg_por_caixa`

Estoque:
`caixas_wake = floor(estoque_ciss_kg / kg_por_caixa)`

Preço:
`preco_caixa = preco_ciss_por_kg * kg_por_caixa`

Exemplo:
- estoque CISS = 340 kg
- caixa = 18 kg
- Wake = `floor(340/18) = 18 caixas`

Sem `kg_por_caixa`:
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
