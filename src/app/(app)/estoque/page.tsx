import { db, schema } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { RULE_DEFAULTS } from '@/lib/settings'

export const dynamic = 'force-dynamic'

export default async function EstoquePage() {
  const rows = await db
    .select({
      cissProductId: schema.managedProducts.cissProductId,
      wakeSku: schema.managedProducts.wakeSku,
      erpStock: schema.syncProductState.erpStock,
      calculatedWakeStock: schema.syncProductState.calculatedWakeStock,
      lastAppliedWakeStock: schema.syncProductState.lastAppliedWakeStock,
      lastAppliedAt: schema.syncProductState.lastAppliedAt,
    })
    .from(schema.managedProducts)
    .leftJoin(schema.syncProductState, eq(schema.syncProductState.managedProductId, schema.managedProducts.id))
    .where(eq(schema.managedProducts.active, true))
    .limit(200)

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-[var(--texto)]">Sincronização de Estoque</h1>
        <p className="text-sm text-[var(--texto-suave)]">
          Regra: {RULE_DEFAULTS.STOCK_PERCENT}% do estoque real do ERP (empresa/local "ESTOQUE CD", já com default
          confirmado), arredondado sempre pra baixo (floor). Depende de WAKE_CD_ID confirmado em{' '}
          <a href="/configuracoes" className="underline">
            Configurações
          </a>
          .
        </p>
      </div>

      <div className="section overflow-x-auto">
        <table className="data-table w-full text-sm">
          <thead>
            <tr>
              <th className="px-3 py-2 text-left">SKU Wake</th>
              <th className="px-3 py-2 text-left">ID CISS</th>
              <th className="px-3 py-2 text-right">Estoque ERP</th>
              <th className="px-3 py-2 text-right">Calculado (Wake)</th>
              <th className="px-3 py-2 text-right">Último aplicado no Wake</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-center text-[var(--texto-suave)]">
                  Nenhum produto sincronizado ainda -- importe a whitelist em Produtos e rode uma sincronização.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.wakeSku} className="border-b border-[var(--borda)]">
                <td className="px-3 py-2 font-mono text-xs">{r.wakeSku}</td>
                <td className="px-3 py-2 font-mono text-xs text-[var(--texto-suave)]">{r.cissProductId}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.erpStock ?? '—'}</td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums">{r.calculatedWakeStock ?? '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums text-[var(--texto-suave)]">{r.lastAppliedWakeStock ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
