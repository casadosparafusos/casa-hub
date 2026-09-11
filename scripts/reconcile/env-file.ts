import fs from 'node:fs'

// Mesmo parser de scripts/reconcile-readonly.ts (la ele e exportado, mas
// importar aquele arquivo executaria o main() do reconciliador).

/** Parser minimo de .env (KEY=VALUE, aspas opcionais). Nao sobrescreve o env existente. */
export function loadEnvFile(file: string, env: NodeJS.ProcessEnv): number {
  let loaded = 0
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
    if (!m || !m[1]) continue
    let value = (m[2] ?? '').trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (env[m[1]] === undefined) {
      env[m[1]] = value
      loaded++
    }
  }
  return loaded
}
