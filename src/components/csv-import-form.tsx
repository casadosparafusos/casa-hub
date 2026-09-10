'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// Exemplo real (confirmado ao vivo em 08/09/2026 via GET /produtos/1563
// ?tipoIdentificador=sku): "Parafuso Sextavado Rosca Parcial NC 3/4 x 2.1/4
// Enegrecido Grau 5 -- BELENUS-SXRP3/4X2-1/488". wake_sku "1563" é o campo
// SKU de verdade (visível no admin do Wake, dentro da variante do produto
// -- não confundir com o nome exibido no site). O ciss_product_id fica como
// placeholder porque a leitura de preço/produto no CISS ainda não está
// liberada nesta integração (token sem escopo `product_prices`, ver
// docs/WAKE-API-CONTRATOS.md) pra confirmar o idsubproduto real deste item
// -- trocar pelo id de verdade antes de importar.
const TEMPLATE_CSV = 'ciss_product_id,wake_sku,active\n<PREENCHER_ID_CISS_idsubproduto>,1563,1\n'

function downloadTemplate() {
  const blob = new Blob([TEMPLATE_CSV], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'modelo-whitelist.csv'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function CsvImportForm() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const fileInput = form.elements.namedItem('file') as HTMLInputElement
    const file = fileInput.files?.[0]
    if (!file) return

    setBusy(true)
    setMessage(null)
    try {
      const body = new FormData()
      body.set('file', file)
      const res = await fetch('/api/import', { method: 'POST', body })
      const data = await res.json()
      if (!res.ok) {
        setMessage(`Erro: ${data.error ?? res.statusText}`)
      } else {
        setMessage(
          `Import #${data.importId}: ${data.createdRows} criados, ${data.updatedRows} atualizados, ${data.errorRows.length} com erro (de ${data.totalRows} linhas).`,
        )
        router.refresh()
      }
    } catch (err) {
      setMessage(`Erro: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
      form.reset()
    }
  }

  return (
    <form onSubmit={onSubmit} className="section section--pad">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="mb-1 text-sm font-bold text-[var(--texto)]">Importar whitelist (CSV)</h2>
          <p className="text-xs text-[var(--texto-suave)]">
            Colunas: ciss_product_id, wake_sku, active. O ID da variante no Wake é descoberto sozinho a partir do SKU
            -- não precisa preencher. Import é aditivo/atualizador -- nunca desativa produtos silenciosamente.
          </p>
        </div>
        <button
          type="button"
          onClick={downloadTemplate}
          className="shrink-0 rounded-full border border-[var(--borda)] px-3 py-1.5 text-xs font-semibold text-[var(--texto)] transition-colors hover:bg-[var(--fundo-suave)]"
        >
          Baixar modelo (CSV)
        </button>
      </div>
      <div className="flex items-center gap-3">
        <input type="file" name="file" accept=".csv,text/csv" required className="text-sm text-[var(--texto)]" />
        <button
          type="submit"
          disabled={busy}
          className="rounded-full bg-[var(--marca)] px-4 py-1.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-[var(--marca-escura)] disabled:opacity-50"
        >
          {busy ? 'Importando…' : 'Importar'}
        </button>
      </div>
      {message && <p className="mt-3 border-t border-[var(--borda)] pt-3 text-sm text-[var(--texto)]">{message}</p>}
    </form>
  )
}
