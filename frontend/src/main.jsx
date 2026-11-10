import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import { preloadRoute } from './routes.js'

const mount = () =>
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StrictMode>,
  )

// The route chunk is already downloading — the preload tags in index.html start
// it in parallel with React — so awaiting it here costs no extra round trip and
// means the first paint is the actual screen. Rendering immediately would paint
// the Suspense spinner first and then shift the layout when the real content
// replaced it. preloadRoute never rejects, so a failed chunk still mounts and is
// handled by the Suspense boundary on retry.
preloadRoute(window.location.pathname).then(mount)
