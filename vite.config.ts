import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { plantUmlPlugin } from './plantumlPlugin'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), plantUmlPlugin()],
})
