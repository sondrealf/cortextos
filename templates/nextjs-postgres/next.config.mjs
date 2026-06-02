/** @type {import('next').NextConfig} */
const nextConfig = {
  // App connects to a self-hosted Postgres at runtime; keep pages dynamic.
  serverExternalPackages: ["pg", "bcryptjs"],
};
export default nextConfig;
