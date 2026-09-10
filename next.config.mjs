/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ['better-sqlite3'],
  eslint: { dirs: ['src', 'worker'] },
}

export default nextConfig
