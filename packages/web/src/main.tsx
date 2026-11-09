import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App.js'

// Lokal gebündelt über @fontsource, nicht von Google Fonts: im LAN soll der
// Aufruf der Oberfläche nichts von aussen nachladen.
import '@fontsource/geist/400.css'
import '@fontsource/geist/500.css'
import '@fontsource/geist/600.css'
import '@fontsource/geist/700.css'
import '@fontsource/geist-mono/400.css'
import '@fontsource/geist-mono/500.css'

import './styles.css'
import { PROTO_BASE, isPrototype } from './prototype/flag.js'

// Prototyp «cal» (Branch design/cal-prototype): dieselbe App unter /prototype,
// eigenes Stylesheet und eigene Schriften nur dort. Das Midnight-Design bleibt
// unter allen anderen Pfaden unverändert.
const proto = isPrototype()

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 2_000 },
  },
})

const render = () =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter basename={proto ? PROTO_BASE : undefined}>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  )

// Erst Stylesheet und Schriften des Prototyps, dann rendern (kein Aufblitzen im alten Look)
if (proto) void import('./prototype/setup.js').then(render)
else render()
