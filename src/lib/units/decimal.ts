// Helpers de arredondamento centralizados -- fonte unica para toda a
// engine de UNIT (app + reconciliador). Ver docs/CASA_HUB_FASE_B_UNIT_STRATEGIES.md §12.

/**
 * Arredondamento monetario -- 2 casas decimais, meio-para-cima.
 *
 * BLOQUEIO D (FASE B.2, 16/09/2026): a abordagem anterior (`Number.EPSILON`
 * antes do `* 100`) falha em casos comercialmente relevantes -- por
 * exemplo `10.075` vira `10.07` em vez de `10.08`, porque o proprio
 * `10.075 * 100` ja arredonda pra `1007.4999...` em ponto flutuante antes
 * do EPSILON conseguir compensar. A troca de representacao decimal pra
 * string via `Number(valor + 'e2')`/`Number(resultado + 'e-2')` desloca a
 * casa decimal ANTES do `Math.round`, evitando o erro de precisao binaria
 * na multiplicacao por 100 -- e' o padrao "exponential notation rounding",
 * determinístico e testado nos 7 casos de fronteira do BLOQUEIO D (ver
 * decimal.test.ts). Sinal tratado separadamente porque `Math.round` em
 * JS arredonda `-0.5` pra `-0` (ties-to-positive-infinity), nao
 * meio-para-cima em magnitude -- aplicar o arredondamento sobre o valor
 * absoluto e reaplicar o sinal depois mantem "meio-para-cima" simetrico
 * pros dois lados.
 */
export function moneyRound(value: number): number {
  const sign = value < 0 ? -1 : 1
  const abs = Math.abs(value)
  return sign * Number(`${Math.round(Number(`${abs}e2`))}e-2`)
}

/**
 * Remove ruido de ponto flutuante (arredonda a 9 casas) SEM truncar.
 * Necessario porque `2.3 * 100` em JS da 229.99999999999997, nao 230 --
 * se essa etapa intermediaria fosse floored direto (sem essa limpeza),
 * o resultado sairia 229 em vez de 230 (ver teste HundredUnitStrategy).
 */
export function cleanNumber(value: number): number {
  return Math.round(value * 1e9) / 1e9
}

/** floor tolerante a ruido de ponto flutuante (limpa antes de floorar). */
export function safeFloor(value: number): number {
  return Math.floor(cleanNumber(value))
}
