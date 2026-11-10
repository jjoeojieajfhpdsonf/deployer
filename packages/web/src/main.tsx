import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App.js'

// Lokal gebündelt über @fontsource, nicht von Google Fonts: im LAN soll der
// Aufruf der Oberfläche nichts von aussen nachladen.
// Cal Sans (OFL) für Titel und Kennzahlen, Inter für Text, Geist Mono für
// Logs, Hashes und Code.
import '@fontsource/cal-sans/400.css'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/geist-mono/400.css'
import '@fontsource/geist-mono/500.css'

import './styles.css'
import { applyTheme, readLocalTheme } from './lib/theme.js'

// index.html hat das Theme schon gesetzt; hier kommt der Wechsel mit dem Gerät dazu («Wie das Gerät»)
applyTheme(readLocalTheme())

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 2_000 },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
