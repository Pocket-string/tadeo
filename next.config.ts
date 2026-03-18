import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  experimental: {
    optimizePackageImports: [
      '@supabase/supabase-js',
      '@supabase/ssr',
      'ai',
      '@ai-sdk/openai',
      '@ai-sdk/google',
      'zod',
    ],
  },
}

export default nextConfig
