import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './', // Crucial for Electron to find assets
  build: {
    outDir: '../SalTwitchApp/wwwroot', // Sends build directly to .NET
    emptyOutDir: true // Cleans the folder before building
  }
})