import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'

// The canvas is tldraw (CS-2554). The React Flow canvas it replaced, once at `?canvas=classic`, is
// gone: that address, and a browser that remembered choosing it, get tldraw. The remembered
// choice is cleared, since nothing reads it now.
try {
  localStorage.removeItem('sphere-canvas')
} catch {}

// Loaded on its own, after the page's first script: tldraw is most of the bundle.
const Canvas = lazy(() => import('./tldraw/TldrawApp').then(m => ({ default: m.TldrawApp })))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Canvas />
    </Suspense>
  </StrictMode>,
)
