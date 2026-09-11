# VALIDATION_PROTOCOL

## Antes de escrever produção

- branch correta;
- SHA registrado;
- backup DB;
- provider real confirmado;
- token/config válidos;
- nenhum segredo em output;
- CISS saudável;
- Wake saudável.

## Fixador CENTO

SKU controlado:
- 1;
- 99;
- 100;
- 101.

Registrar:
- preço CISS CENTO;
- base unit;
- varejo;
- desconto;
- preço efetivo Wake;
- total de carrinho.

## PC/UN

Provar:
- preço 1:1 CISS;
- estoque 1:1;
- nenhum fator 100;
- nenhuma política de fixador aplicada por acidente.

## KG

Provar:
- preço/kg × kgCaixa;
- floor(kg/kgCaixa);
- sobra;
- bloqueio sem kgCaixa;
- zero divisão por valor inválido.

## Reconciliação

Primeira execução é READ-ONLY.

Por SKU:
- CISS encontrado;
- UNIT;
- preço CISS;
- esperado;
- Wake real;
- estoque CISS;
- esperado;
- Wake real no CD;
- tabela;
- promoção;
- status.

## Restart

No host:
- `systemctl is-enabled`;
- `systemctl is-active`;
- teste de restart controlado;
- confirmação de retorno;
- confirmação de uma única instância;
- heartbeat.

## Histórico

Run automático no-op:
- 0 itens;
- 0 novo lote histórico relevante;
- `last_check_at` atualizado.

## Segurança

- settings sem login → 401;
- token nunca volta ao browser;
- roles funcionam;
- rate limit;
- sem segredo no log.
