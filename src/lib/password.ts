import 'server-only'

// Guard de runtime do Next (so pode ser importado a partir de Server
// Component/route handler) em cima da implementacao real, que mora em
// password-core.ts sem esse guard -- scripts standalone (scripts/seed-admin.ts)
// importam direto de la, ja que 'server-only' lanca erro incondicional fora
// da resolucao especial do bundler do Next.
export { hashPassword, verifyPassword } from './password-core'
