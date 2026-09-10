# UI_UX_REQUIREMENTS — Casa HUB

## Visão Geral

Trocar:
`Modo: Pronto pra produção`

por:
- `Ambiente: Produção`
- `Status: Operacional | Degradado | Indisponível`

Cards recomendados:
- Produtos monitorados;
- Última verificação;
- Última atualização real;
- Status do sistema.

### Realtime

A UI não deve depender de F5.

Abordagem principal:
SSE.

Eventos:
- `run_started`
- `run_progress`
- `product_updated`
- `run_failed`
- `run_finished`
- `health_changed`

Fallback aceitável:
polling incremental de 2–3 segundos.

## Últimas execuções

Não listar runs automáticos em que:
- atualizados = 0;
- falhas = 0.

Ainda assim o scheduler deve continuar checando o CISS.

Mostrar, na UI principal:
- `Atualizados`
- `Falhas`

Manter internamente:
- detected;
- sent;
- verified;
- failed.

## Produtos

Adicionar:
- busca por SKU Wake;
- busca por ID CISS;
- busca por nome;
- filtros Ativos/Inativos/Pendentes;
- botão Desativar;
- botão Reativar;
- confirmação;
- audit log.

Desativar só a whitelist do Casa HUB.

## Sincronização de Preços

Adicionar search e paginação.

Por SKU:
- Simular;
- Sincronizar preço agora;
- visualizar CISS;
- visualizar cálculo;
- visualizar Wake real;
- resultado VERIFIED/MISMATCH.

## Sincronização de Estoque

Adicionar search e paginação.

Por SKU:
- Simular;
- Sincronizar estoque agora;
- CISS raw;
- UNIT;
- conversão;
- Wake atual;
- resultado.

## Histórico

Persistir:
- mudança;
- falha;
- divergência;
- execução manual relevante.

Não persistir milhares de `Sem mudança`.

Enquanto legado existir, ordenar:
1. falhas;
2. alterados/aplicados;
3. planejados;
4. sem mudança.

## Configurações

Organizar em cards/seções:

### Wake Commerce
- Token Wake;
- Centro de Distribuição;
- Tabela de Preço;
- Promoção;
- Testar conexão.

### ERP CISS / POWER
- Base URL;
- Token ERP;
- Empresa;
- Local;
- Testar conexão.

### Fixadores — CENTO
- markup varejo;
- quantidade atacado;
- desconto atacado;
- percentual estoque.

### Produtos PC / UN
- política de preço;
- política de estoque.

### Produtos KG
- comportamento;
- link para Embalagens.

### Sincronização
- intervalo preço;
- intervalo estoque;
- reconciliação.

### Sistema
- versão/commit;
- ambiente;
- saúde;
- worker heartbeat.

Não exibir nomes de env em inglês como UX principal; podem aparecer em detalhe técnico.

## Caixas → Embalagens

Reaproveitar a área para cadastrar produtos KG.

Campos:
- ID CISS;
- SKU Wake;
- produto;
- UNIT CISS;
- kg por caixa;
- preço/kg;
- preço calculado por caixa;
- estoque kg;
- caixas calculadas;
- sobra kg;
- status da configuração.
