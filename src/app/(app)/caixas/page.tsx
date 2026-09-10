// Feature DESABILITADA -- ver schema.boxes e a especificacao original:
// "Caixas" (preco/estoque por cento fechado) so entra em operacao depois
// que as regras de negocio forem confirmadas com o usuario. Esta pagina
// existe so pra manter a sub-navegacao completa conforme pedido, mas nao
// oferece nenhuma acao.

export default function CaixasPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-[var(--texto)]">Caixas</h1>
        <p className="text-sm text-[var(--texto-suave)]">Preço e estoque por caixa/cento fechado.</p>
      </div>

      <div className="rounded-lg border border-dashed border-[var(--borda)] bg-[var(--superficie)] p-8 text-center">
        <p className="text-sm font-medium text-[var(--texto)]">Em breve</p>
        <p className="mt-1 text-sm text-[var(--texto-suave)]">
          Esta funcionalidade está desabilitada até as regras de negócio (unidades por caixa, arredondamento,
          interação com o preço/cento já existente) serem confirmadas.
        </p>
      </div>
    </div>
  )
}
