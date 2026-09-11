# PRICE_RULES — Regras canônicas de preço

**Fonte de verdade para qualquer implementação futura.**

## Princípio

Primeiro normalizar o preço conforme `UNIT`.
Depois aplicar a política comercial do grupo de produto.

Pipeline:

`CISS raw price`
→ `UNIT normalization`
→ `base price`
→ `commercial policy`
→ `expected Wake`
→ `write`
→ `readback`
→ `VERIFIED / MISMATCH`

---

## 1. Fixadores — UNIT=CENTO

No CISS/POWER, o preço informado é o preço de 100 peças.

Se:

`P100 = preço bruto CISS do CENTO`

então:

`Pbase_unit = P100 / 100`

### Varejo atual

A política atual dos fixadores aplica markup de 20%:

`Pvarejo_unit = Pbase_unit * 1.20`

### Atacado a partir de 100 unidades

A regra declarada pelo negócio é literalmente:

**a partir de 100 unidades, aplicar 20% de desconto sobre o preço de varejo dos fixadores.**

Portanto:

`Patacado_unit = Pvarejo_unit * 0.80`

e:

`Patacado_100 = Patacado_unit * 100`

### Consequência matemática importante

`Pbase * 1.20 * 0.80 = Pbase * 0.96`

Ou seja: adicionar 20% e depois descontar 20% NÃO retorna ao preço-base; resulta em 96% do base.

Nenhum agente pode “corrigir” isso silenciosamente.

Se no futuro o negócio decidir que 100 unidades devem totalizar exatamente o preço bruto do CENTO do CISS, isso será uma mudança explícita de política.

### Exemplo

CISS:
`P100 = R$ 300,00`

Base:
`R$ 3,00/un`

Varejo:
`3,00 × 1,20 = R$ 3,60/un`

Atacado >=100:
`3,60 × 0,80 = R$ 2,88/un`

100 unidades:
`R$ 288,00`

Este exemplo existe para tornar a regra inequívoca.

### Gate obrigatório Wake

Validar checkout com um SKU real:
- quantidade 1;
- 99;
- 100;
- 101.

Registrar preço unitário e total efetivamente cobrados.

---

## 2. PC / UN

O preço do CISS já representa uma peça.

`Pbase = Pciss`

Não dividir por 100.

O markup atual de 20% foi definido para fixadores; não aplicar automaticamente em PC/UN.

Se o negócio quiser margem futura:
criar `CommercialPolicy` própria e configurável.

---

## 3. KG vendido em caixa

O preço CISS representa 1 kg.

Cadastro:
`kg_por_caixa`

Preço-base da caixa:

`Pcaixa = Pciss_kg * kg_por_caixa`

Exemplo:
- CISS = R$ 24,50/kg
- caixa = 18 kg
- preço-base caixa = R$ 441,00

Não aplicar automaticamente o markup/atacado de fixadores.

---

## 4. Arredondamento e precisão

Dinheiro não deve depender apenas de `number`/float.

Preferir:
- Decimal exato; ou
- centavos inteiros.

Definir explicitamente:
- ponto do arredondamento;
- casas decimais;
- comparação com Wake;
- tolerância, se houver.

Evitar arredondamentos intermediários desnecessários.

---

## 5. Tabela de preço e promoção Wake

A implementação atual usa preço-base Wake + Tabela de Preço + Promoção.

Antes de redesenhar:
- ler configuração real;
- validar condição de quantidade;
- validar ação de desconto;
- validar interação com PIX, cupom e outras promoções.

`WHOLESALE_MIN_QTY` local não pode fingir governar uma promoção Wake se a condição real estiver configurada separadamente no admin/API.
