import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

// Implementacao pura (sem 'server-only') pra poder ser importada tanto pelo
// app (via src/lib/password.ts, que adiciona o guard) quanto por scripts
// standalone fora do Next (ex: scripts/seed-admin.ts) -- 'server-only' lanca
// erro incondicional fora da resolucao especial do bundler do Next, entao
// nao pode aparecer na cadeia de imports de um script rodado com tsx puro.
//
// Hash de senha via scrypt do modulo nativo `crypto` do Node -- sem
// dependencia nova (nem bcrypt, nem argon2). Formato armazenado:
// "<salt-hex>:<hash-hex>", scryptSync com N=16384 (default), keylen 64.

const KEY_LENGTH = 64

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, KEY_LENGTH).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hashHex] = stored.split(':')
  if (!salt || !hashHex) return false
  const hash = scryptSync(password, salt, KEY_LENGTH)
  const storedHash = Buffer.from(hashHex, 'hex')
  if (hash.length !== storedHash.length) return false
  return timingSafeEqual(hash, storedHash)
}
