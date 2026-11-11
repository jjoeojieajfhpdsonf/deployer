import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from 'sonner'
import { App } from './App.js'
import { ErrorBoundary } from './components/ErrorBoundary.js'

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
import { watchConnection } from './lib/connection.js'
import { mutationCacheWithToasts } from './lib/feedback.js'

// index.html hat das Theme schon gesetzt; hier kommt der Wechsel mit dem Gerät dazu («Wie das Gerät»)
applyTheme(readLocalTheme())

const queryClient = new QueryClient({
  // Fehler jeder Aktion ohne eigene Anzeige → Fehler-Toast mit Grund und «Erneut versuchen»
  mutationCache: mutationCacheWithToasts(),
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 2_000 },
  },
})
// Zustand «Veraltet»: Server antwortet nicht → letzte Daten bleiben, Leiste in der Shell
watchConnection(queryClient)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        {/* Letzte Linie: statt schwarzem Bild eine Fehlerseite mit «Neu laden» */}
        <ErrorBoundary scope="app">
          <App />
        </ErrorBoundary>
      </BrowserRouter>
      {/* Einmal, an der Wurzel. Farben aus den eigenen Tokens (styles.css), daher hell und dunkel ohne theme-Prop. */}
      <Toaster position="bottom-right" duration={10_000} gap={8} containerAriaLabel="Meldungen" />
    </QueryClientProvider>
  </StrictMode>,
)
