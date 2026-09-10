# Pedido ao SIGAS -- campo/endpoint de preço de varejo no CISS/PODER

> **RESOLVIDO em 03/09/2026.** O SIGAS gerou 3 endpoints dedicados ao Casa
> Hub -- `GET /products/prices/{product_id}`, `GET /products/prices/search`
> e `GET /products/prices` -- mais um token dedicado (não o token genérico
> de outros apps). Implementado em `src/lib/ciss/prices.ts`, ligado ao
> motor de preço via `livePriceProvider` (`src/lib/ciss/price-provider.ts`).
> `CISS_PRICE_PROVIDER=live` já é o padrão a partir desta data. O restante
> deste documento é o pedido original, mantido como histórico.

Segue o mesmo formato do pedido já existente da Reposição
(`/opt/reposicao/docs/ciss-required-endpoints.md`), aplicado ao gap
específico desta integração.

## O que falta

Um endpoint (ou campo dentro de um endpoint já existente) que devolva o
**preço de varejo atual (de tabela/lista)** de um produto no CISS/PODER,
por `codigoProduto`.

## O que já foi sondado (sem sucesso)

Nenhum dos endpoints abaixo, já em uso por outros apps desta empresa,
expõe preço de varejo atual:

- `GET /products/stock-sales` -- só estoque e vendas, sem preço.
- `GET /sales-management/by-product` -- métricas de venda por produto
  (usado pela Reposição, concilia com o fechamento do ERP), sem preço de
  tabela.
- `GET /sales-management/by-seller` -- idem, por vendedor.
- `GET /sales-invoices/search` -- devolve `amount` só no nível da nota
  fiscal inteira, não por linha de produto.
- `GET /customers/{id}` -- dados de cliente, sem relação com preço de
  produto.

Além disso, 14 variações de nome de endpoint plausíveis (`/products/prices`,
`/products/price-table`, `/pricing/*`, etc.) foram testadas e todas
devolveram `404` -- não `400` (que é a resposta padrão do CISS quando a
rota existe mas falta um filtro obrigatório, conforme já documentado em
`docs/ciss-required-endpoints.md` da Reposição). Isso indica ausência real
da rota, não um erro de uso.

## O que é usado hoje como preço, em outros apps

O RD Gerencial popula `unit_price` a partir dos dados de **pedido**
vindos do Wake/Mercado Livre -- ou seja, é o preço de VENDA já praticado
num canal, não o preço de TABELA do ERP. Não serve como substituto: esta
integração precisa do preço de tabela do CISS pra aplicar o markup por
cima dele (regra: `wakeUnitPrice = precoErp * (1 + 20%)`), e usar um preço
que já inclui a margem de outro canal duplicaria/distorceria essa conta.

## O que estamos pedindo ao SIGAS

Um dos dois:

1. Um novo endpoint dedicado (ex: `GET /products/prices` ou
   `GET /products/{id}/price`) que devolva o preço de tabela atual por
   produto; ou
2. Confirmação de que o campo já existe em algum endpoint não documentado
   ou não testado ainda, com o nome exato do campo e o endpoint que o
   contém.

## Enquanto isso

O motor de preço (`src/lib/pricing/engine.ts`) está pronto e testável,
alimentado por um provider mock (`src/lib/ciss/price-provider.ts`,
`CISS_PRICE_PROVIDER=mock`) que gera preços fake determinísticos só pra
exercitar o cálculo e o fluxo de sincronização (inclusive dry-run) de
ponta a ponta. **Nunca deve rodar em produção fora de dry-run** enquanto
`CISS_PRICE_PROVIDER` continuar em `mock` -- o motor de estoque, que não
depende deste campo, pode seguir em produção normalmente assim que as
demais configurações forem confirmadas.
