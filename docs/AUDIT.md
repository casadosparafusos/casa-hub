# AUDIT — principais achados do baseline

## P0

### Provider mock
O provider de preço cai em `mock` por default/env e o core não possui guard explícito impedindo sync real com mock.

### Reconciliação
O worker chama o mesmo `runSync()`; o diff normal compara cálculo contra `lastApplied*`. Isso não detecta necessariamente alteração manual feita diretamente na Wake.

### Estoque Wake
O ACK por variante é bom para confirmação de PUT, mas ainda falta leitura real de estoque por SKU/CD para reconciliação.

### Tabela de preço
O código marca a operação da tabela como aplicada sem readback equivalente.

### UNIT
O CISS devolve `unit`, porém a camada atual descarta isso.
Os motores de preço/estoque assumem CENTO para todos.

### Preço CENTO
O código atual e textos históricos precisam ser alinhados com a regra canônica:
CISS/100 → varejo +20% → >=100 desconto 20% sobre varejo.

## P1

### Histórico
Todo no-change vira linha e toda checagem vira run.

### Scheduler
Usa `sync_runs` como relógio; antes de remover no-op histórico deve existir `sync_status`.

### Concorrência
`setInterval` pode iniciar tick enquanto o anterior ainda trabalha; locks evitam write duplicado do mesmo recurso, mas geram tentativas inúteis.

### Lock release
Release deveria ser condicional ao owner/token que adquiriu.

### Precisão monetária
JS number + SQLite REAL não é o melhor desenho para dinheiro.

### Estoque raw
Pode haver valores fracionários; raw ERP não deveria ser integer.

### UI
Limites fixos de 200/300/500, sem paginação/pesquisa completa.

### Single SKU
Não existe.

### Whitelist
Sem toggle UI.

### Realtime
Só atualiza após resposta e `router.refresh()`.

### Contadores
Preço-base e tabela podem contar operações separadas como “produtos”.

### Settings GET
Deve exigir autenticação.

### Auth
Sem rate limit e todos usuários ativos possuem acesso total.

### HTTP
Produção interna atual opera sem TLS.

### Deploy docs
Há documentação histórica contraditória sobre nginx/porta direta.

### Testes
Cobertura concentrada nos motores CENTO puros; falta integração.
