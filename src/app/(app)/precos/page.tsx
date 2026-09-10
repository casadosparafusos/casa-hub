import { db, schema } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { RULE_DEFAULTS } from '@/lib/settings'

export const dynamic = 'force-dynamic'

export default async function PrecosPage() {
  const rows = await db
    .select({
      cissProductId: schema.managedProducts.cissProductId,
      wakeSku: schema.managedProducts.wakeSku,
      active: schema.managedProducts.active,
      erpPrice: schema.syncProductState.erpPrice,
      calculatedWakeUnitPrice: schema.syncProductState.calculatedWakeUnitPrice,
      calculatedWakeSpecialPrice: schema.syncProductState.calculatedWakeSpecialPrice,
      lastAppliedWakeUnitPrice: schema.syncProductState.lastAppliedWakeUnitPrice,
      lastAppliedAt: schema.syncProductState.lastAppliedAt,
    })
    .from(schema.managedProducts)
    .leftJoin(schema.syncProductState, eq(schema.syncProductState.managedProductId, schema.managedProducts.id))
    .where(eq(schema.managedProducts.active, true))
    .limit(200)

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-[var(--texto)]">Sincronização de Preços</h1>
        <p className="text-sm text-[var(--texto-suave)]">
          Regra: markup de {RULE_DEFAULTS.UNIT_PRICE_MARKUP_PERCENT}% sobre o preço bruto do ERP; preço/cento a partir
          de {RULE_DEFAULTS.WHOLESALE_MIN_QTY} unidades, igual ao preço bruto do ERP (sem markup), via Tabela de
          Preço + Promoção no Wake -- ver{' '}
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
              <th className="px-3 py-2 text-right">Preço ERP (bruto)</th>
              <th className="px-3 py-2 text-right">Calculado (unitário)</th>
              <th className="px-3 py-2 text-right">Calculado (cento)</th>
              <th className="px-3 py-2 text-right">Último aplicado no Wake</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-center text-[var(--texto-suave)]">
                  Nenhum produto sincronizado ainda -- importe a whitelist em Produtos e rode uma sincronização.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.wakeSku} className="border-b border-[var(--borda)]">
                <td className="px-3 py-2 font-mono text-xs">{r.wakeSku}</td>
                <td className="px-3 py-2 font-mono text-xs text-[var(--texto-suave)]">{r.cissProductId}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(r.erpPrice)}</td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums">{fmtMoney(r.calculatedWakeUnitPrice)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(r.calculatedWakeSpecialPrice)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-[var(--texto-suave)]">{fmtMoney(r.lastAppliedWakeUnitPrice)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function fmtMoney(v: number | null) {
  if (v === null || v === undefined) return '—'
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}
