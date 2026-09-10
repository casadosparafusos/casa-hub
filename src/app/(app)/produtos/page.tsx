import { db, schema } from '@/lib/db'
import { desc } from 'drizzle-orm'
import { CsvImportForm } from '@/components/csv-import-form'
import { formatDateTime } from '@/lib/format'

export const dynamic = 'force-dynamic'

export default async function ProdutosPage() {
  const products = await db.select().from(schema.managedProducts).orderBy(desc(schema.managedProducts.updatedAt)).limit(300)

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-[var(--texto)]">Produtos (whitelist)</h1>
        <p className="text-sm text-[var(--texto-suave)]">
          Só produtos aqui podem ser alterados no Wake por esta integração. Nenhum produto fora desta lista é tocado.
        </p>
      </div>

      <CsvImportForm />

      <div className="section overflow-x-auto">
        <table className="data-table w-full text-sm">
          <thead>
            <tr>
              <th className="px-3 py-2 text-left">ID CISS</th>
              <th className="px-3 py-2 text-left">ID Wake</th>
              <th className="px-3 py-2 text-left">Nome do produto</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-left">Atualizado em</th>
            </tr>
          </thead>
          <tbody>
            {products.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-center text-[var(--texto-suave)]">
                  Nenhum produto importado ainda.
                </td>
              </tr>
            )}
            {products.map((p) => (
              <tr key={p.id} className="border-b border-[var(--borda)]">
                <td className="px-3 py-2 font-mono text-xs text-[var(--texto-suave)]">{p.cissProductId}</td>
                <td className="px-3 py-2 font-mono text-xs text-[var(--texto-suave)]">{p.wakeProductVariantId}</td>
                <td className="px-3 py-2">{p.wakeProductName ?? <span className="text-[var(--texto-suave)]">—</span>}</td>
                <td className="px-3 py-2">
                  <span
                    className={
                      p.active
                        ? 'rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700'
                        : 'rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600'
                    }
                  >
                    {p.active ? 'ativo' : 'inativo'}
                  </span>
                </td>
                <td className="px-3 py-2 text-[var(--texto-suave)]">{formatDateTime(p.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
