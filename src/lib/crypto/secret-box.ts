import 'server-only'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

// Criptografia simetrica (AES-256-GCM) pros valores sensiveis gravados na
// tabela `settings` (tokens de API Wake/CISS). Sem biblioteca nova -- so
// `node:crypto`, mesma filosofia de src/lib/password-core.ts.
//
// A chave mestra vem de SETTINGS_SECRET_KEY (env, systemd EnvironmentFile em
// producao). Qualquer string funciona como entrada -- e reduzida a 32 bytes
// via SHA-256 antes de virar chave AES-256. Trocar essa env var invalida
// todos os segredos ja gravados (ficam ilegiveis) -- nao rotacionar sem
// replanejar os valores.

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const FORMAT_PREFIX = 'v1'

function getKey(): Buffer {
  const secret = process.env.SETTINGS_SECRET_KEY
  if (!secret || secret.trim() === '') {
    throw new Error('SETTINGS_SECRET_KEY nao configurada (.env) -- necessaria para gravar/ler segredos criptografados')
  }
  return createHash('sha256').update(secret).digest()
}

/** Formato armazenado: "v1:<iv-base64>:<authTag-base64>:<ciphertext-base64>". */
export function encryptSecret(plaintext: string): string {
  const key = getKey()
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return [FORMAT_PREFIX, iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':')
}

export function decryptSecret(stored: string): string {
  const [prefix, ivB64, authTagB64, ciphertextB64] = stored.split(':')
  if (prefix !== FORMAT_PREFIX || !ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error('Valor criptografado em formato inesperado')
  }
  const key = getKey()
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'))
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, 'base64')), decipher.final()])
  return plaintext.toString('utf8')
}
