// Constantes compartilhadas entre o form client-side (settings-form.tsx) e a
// leitura server-side (src/lib/settings.ts) -- sem 'server-only' de proposito,
// pra poder ser importado por um Client Component.

/** Sinaliza pro form que um campo secreto ja tem valor gravado -- NUNCA e o valor real. */
export const SECRET_CONFIGURED_SENTINEL = '__secret_configured__'

export const SECRET_KEYS = ['WAKE_ADMIN_API_TOKEN', 'CISS_API_TOKEN'] as const
export type SecretKey = (typeof SECRET_KEYS)[number]
