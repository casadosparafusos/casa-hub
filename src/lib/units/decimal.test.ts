import { describe, expect, it } from 'vitest'
import { cleanNumber, moneyRound, safeFloor } from './decimal'

// Testes de precisao monetaria (FASE B.1, PROBLEMA 6/§7) -- fronteiras
// conhecidas de erro de ponto flutuante em JS, com o valor exato que o
// binario IEEE-754 devolveria SEM a limpeza destes helpers, pra provar que
// moneyRound/cleanNumber/safeFloor realmente neutralizam o ruido nos pontos
// onde a engine de UNIT os usa (strategies.ts, commercial-policy.ts).

describe('moneyRound -- 2 casas decimais, meio-para-cima, resistente a ruido de float', () => {
  it('0.1 + 0.2 -> 0.3 (classico erro de ponto flutuante, 0.1+0.2 cru = 0.30000000000000004)', () => {
    expect(moneyRound(0.1 + 0.2)).toBe(0.3)
  })

  it('1.005 -> 1.01 (1.005 cru em IEEE-754 e 1.00499999999999989..., +Number.EPSILON antes do round corrige pra cima)', () => {
    expect(moneyRound(1.005)).toBe(1.01)
  })

  it('2.675 -> 2.68 (mesma classe de erro que 1.005 -- +Number.EPSILON tambem corrige aqui)', () => {
    expect(moneyRound(2.675)).toBe(2.68)
  })

  it('2.005 -> 2.01 (soma real de preco x qty que bate no mesmo padrao de ruido, mas do lado que arredonda certo)', () => {
    expect(moneyRound(2.005)).toBe(2.01)
  })

  it('meio-para-cima em valores sem ruido de binario: 2.5 centavos -> cima', () => {
    expect(moneyRound(10.125)).toBe(10.13)
    expect(moneyRound(10.135)).toBe(10.14)
  })

  it('preserva valores ja exatos em 2 casas', () => {
    expect(moneyRound(19.9)).toBe(19.9)
    expect(moneyRound(0)).toBe(0)
  })

  it('negativo: arredonda mantendo o sinal (nao usado hoje pela engine, mas a funcao e generica)', () => {
    expect(moneyRound(-1.005)).toBe(-1)
  })
})

describe('cleanNumber -- remove ruido binario sem truncar valor real', () => {
  it('2.3 * 100 cru da 229.99999999999997 em JS -- cleanNumber devolve 230 exato', () => {
    expect(2.3 * 100).not.toBe(230)
    expect(cleanNumber(2.3 * 100)).toBe(230)
  })

  it('kg fracionario x2.5: 0.1 * 2.5 (ruido tipico de PACKAGE_MEASURED) limpa certo', () => {
    expect(cleanNumber(0.1 * 2.5)).toBe(0.25)
  })

  it('m fracionario x0.3: 1 * 0.3 -- cleanNumber nao introduz ruido novo em valor ja exato', () => {
    expect(cleanNumber(1 * 0.3)).toBe(0.3)
  })

  it('nao arredonda pra menos casas do que 9 -- diferenca real de centavos sobrevive', () => {
    expect(cleanNumber(1.23456789)).toBe(1.23456789)
  })
})

describe('safeFloor -- floor tolerante a ruido (limpa antes de florar)', () => {
  it('estoque fisico de HUNDRED: 2.3 cento * 100 nunca vira 229 por ruido de float', () => {
    // Reproduz exatamente o caminho de computeHundred() -- Math.max(2.3,0)*100
    // sem limpeza daria 229.99999999999997, e Math.floor cru erraria pra 229.
    expect(safeFloor(Math.max(2.3, 0) * 100)).toBe(230)
  })

  it('valor ja inteiro exato permanece igual', () => {
    expect(safeFloor(5)).toBe(5)
  })

  it('quantidade fracionaria legitima ainda floora pra baixo (nao e so anti-ruido, continua sendo floor)', () => {
    expect(safeFloor(5.9)).toBe(5)
    expect(safeFloor(5.0000001)).toBe(5)
  })
})
