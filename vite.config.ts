import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Smile Signature',
        short_name: 'Smile',
        description: 'تسيير مطعم Smile Signature',
        lang: 'ar',
        dir: 'rtl',
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
})
