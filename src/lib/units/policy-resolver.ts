// Selecao centralizada de CommercialPolicy por UnitClass -- ver
// docs/CASA_HUB_FASE_B1_HARDENING_UNIT_STRATEGIES.md §3.
//
// Regra canonica: `CT normalization != FIXADOR_CENTO commercial policy`.
// E proibido equivalencia implicita (`if (unit === 'CT') policy = FIXADOR_CENTO`)
// espalhada pelo codigo. Esta funcao e o UNICO lugar que decide a policy;
// compute.ts chama isto em vez de aplicar FIXADOR_CENTO incondicionalmente.
//
// Escopo atual (documentado, nao e regra da UNIT): toda a whitelist HUNDRED
// gerenciada hoje e fixador, entao o default e HUNDRED -> FIXADOR_CENTO e
// qualquer outra classe -> NONE. Nao ha campo de commercial policy por
// managed product no banco ainda -- quando existir, a leitura desse campo
// deve substituir este default (nao apagar a funcao: ela continua sendo o
// unico ponto de decisao). `override` existe hoje para (a) testes provarem
// que CT + NoCommercialPolicy e representavel e (b) ser o ponto de extensao
// futuro para a policy por produto.
import type { CommercialPolicyKind, UnitClass } from './types'

export function resolveCommercialPolicy(unitClass: UnitClass, override?: CommercialPolicyKind): CommercialPolicyKind {
  if (override) return override
  return unitClass === 'HUNDRED' ? 'FIXADOR_CENTO' : 'NONE'
}
