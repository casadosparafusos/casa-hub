// Reexport fino do motor puro de UNIT (resolver/strategies/commercial-policy/
// compute), single-sourced em scripts/reconcile/units -- mesmo modulo usado
// pelo reconciliador READ-ONLY (ver scripts/reconcile/rules.ts, §15 do FASE B).
//
// NAO duplicar logica aqui. NAO mover o modulo pra ca: o reconciliador
// importa via ./units (relativo), exigido pelo guard de
// scripts/reconcile/no-write-path.test.ts (specifiers precisam comecar com
// 'node:', './' ou ser exatamente 'better-sqlite3'). Um import '../../src/lib/units'
// quebraria esse guard. Este arquivo existe so pra dar ao app um caminho de
// import ergonomico sem violar isso -- ver §13 do FASE B ("UMA fonte pura de
// calculo").
export * from '../../../scripts/reconcile/units'
