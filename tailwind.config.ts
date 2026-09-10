import type { Config } from 'tailwindcss'

// Paleta oficial Casa dos Parafusos -- copiada 1:1 do tailwind.config.ts da
// Reposicao de Estoque (mesma referencia visual dos 4 apps do ecossistema:
// Portal, RD Gerencial, Reposicao, Auditoria). Nao diverge daqui sem
// atualizar os outros -- ver comentario original em globals.css deles.
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        slate: { 50: '#f7f7f6', 100: '#eeeeed', 200: '#dddddb', 400: '#9c9c96', 600: '#6d6d68', 700: '#595955', 900: '#3a3a36' },
        red: { 50: '#fef5f4', 200: '#fbd4d1', 400: '#f1766e', 600: '#d61f14', 700: '#b11911', 800: '#92150e', 900: '#73110b' },
        amber: { 50: '#fbf7e5', 200: '#eedd96', 700: '#6a5911', 900: '#43390b' },
        emerald: { 50: '#eefae5', 200: '#b6ec93', 600: '#3e7b16', 700: '#336512', 800: '#29520f', 900: '#20400b' },
        sky: { 50: '#ebf9fe', 200: '#afe5fb', 800: '#054f6b', 900: '#043e54' },
        orange: { 50: '#fdf5f0', 200: '#f7d6c2', 800: '#763810' },
      },
      fontFamily: {
        sans: ['var(--fonte-marca)', 'ui-sans-serif', 'system-ui', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
    },
  },
  plugins: [],
}

export default config
