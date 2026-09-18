import { listConfigs, listPendingProducts } from '@/lib/measured-packages/service'
import { EmbalagensClient } from '@/components/embalagens/embalagens-client'

export const dynamic = 'force-dynamic'

export default async function EmbalagensPage() {
  const [configs, pending] = await Promise.all([listConfigs(), listPendingProducts()])

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-[var(--texto)]">Embalagens KG/MT</h1>
        <p className="text-sm text-[var(--texto-suave)]">
          Cadastre a quantidade por unidade vendável dos produtos medidos por KG ou MT. O motor de cálculo já existe
          -- esta tela só alimenta a configuração que ele usa. A UNIT (KG/MT) é sempre lida do CISS, nunca digitada
          aqui.
        </p>
      </div>

      <EmbalagensClient initialConfigs={configs} initialPending={pending} />
    </div>
  )
}
