import type { Config } from 'drizzle-kit'

// Banco proprio da integracao ERP -> Wake, independente do banco da
// Reposicao (ver docs/README.md). Caminho default pode ser sobrescrito
// por DATABASE_PATH em producao (systemd EnvironmentFile).
export default {
  schema: './src/lib/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DATABASE_PATH ?? './data/app.db',
  },
} satisfies Config
