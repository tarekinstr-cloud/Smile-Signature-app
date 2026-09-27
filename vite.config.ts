import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// `--mode preview-artifact` builds a plain bundle (no service worker) for a single-file hosted preview.
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    mode !== 'preview-artifact' && VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Smile Signature',
        short_name: 'Smile',
        description: 'Gestion du restaurant Smile Signature',
        lang: 'fr',
        dir: 'ltr',
        theme_color: '#1f2937',
        background_color: '#f5f5f4',
        display: 'standalone',
        orientation: 'any',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
    }),
  ],
}))
