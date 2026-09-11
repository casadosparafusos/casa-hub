import { createDecipheriv, createHash } from 'node:crypto'

// Decifra segredos gravados pela tela de Configuracoes -- mesmo formato de
// src/lib/crypto/secret-box.ts ("v1:<iv-b64>:<authTag-b64>:<ct-b64>",
// AES-256-GCM, chave = sha256(SETTINGS_SECRET_KEY)). Copia local de proposito:
// o modulo original importa 'server-only' e nao roda fora do Next. Aqui so
// existe DECIFRAR -- o reconciliador nunca grava segredo.

export function decryptSecretV1(stored: string, masterKey: string): string {
  const [prefix, ivB64, authTagB64, ciphertextB64] = stored.split(':')
  if (prefix !== 'v1' || !ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error('Valor criptografado em formato inesperado')
  }
  if (!masterKey || masterKey.trim() === '') {
    throw new Error('SETTINGS_SECRET_KEY nao configurada -- necessaria para ler segredos do banco')
  }
  const key = createHash('sha256').update(masterKey).digest()
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(ciphertextB64, 'base64')), decipher.final()]).toString('utf8')
}

/**
 * Mesma precedencia de getSecret() em producao: valor do banco (cifrado)
 * primeiro, env como fallback. Devolve tambem a ORIGEM (nunca o valor) para
 * registro no relatorio.
 */
export function resolveSecret(
  dbValue: string | null,
  envValue: string | undefined,
  masterKey: string | undefined,
): { value: string | null; source: 'db' | 'env' | 'none' } {
  if (dbValue) return { value: decryptSecretV1(dbValue, masterKey ?? ''), source: 'db' }
  const env = envValue?.trim()
  if (env) return { value: env, source: 'env' }
  return { value: null, source: 'none' }
}
