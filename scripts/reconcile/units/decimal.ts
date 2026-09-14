// Helpers de arredondamento centralizados -- fonte unica para toda a
// engine de UNIT (app + reconciliador). Ver docs/CASA_HUB_FASE_B_UNIT_STRATEGIES.md §12.

/** Arredondamento monetario -- 2 casas decimais, meio-para-cima. */
export function moneyRound(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
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
