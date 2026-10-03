import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Keep in sync with routeLoaders in src/routes.js.
const ROUTE_ENTRIES = {
  '/': 'src/components/Login.jsx',
  '/register': 'src/components/RegistrationForm.jsx',
  '/profile': 'src/components/Profile.jsx',
  '/admin': 'src/components/AdminDashboard.jsx',
}

/**
 * Vite injects <link rel="modulepreload"> for the entry chunk's static imports,
 * but a route chunk reached through import() is invisible to the parser — the
 * browser only learns about it once the entry has downloaded and run, which put
 * a second round trip on the critical path and cost more than code-splitting
 * saved (measured: LCP 1.97s -> 2.57s on a cold /admin).
 *
 * This resolves each route to its chunk (plus that chunk's transitive static
 * imports) at build time and emits a tiny inline script that adds the preload
 * tags for the requested path while the HTML is still parsing. The route chunk
 * then downloads alongside React rather than after it, and only the chunk that
 * route actually needs is fetched.
 */
function routeChunkPreload() {
  let base = '/'
  return {
    name: 'route-chunk-preload',
    apply: 'build',
    configResolved(config) {
      base = config.base || '/'
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const bundle = ctx.bundle
        if (!bundle) return html

        const chunks = Object.values(bundle).filter((c) => c.type === 'chunk')
        const byFile = new Map(chunks.map((c) => [c.fileName, c]))
        const findByModule = (suffix) =>
          chunks.find((c) => c.facadeModuleId?.replace(/\\/g, '/').endsWith(suffix))

        // Anything the entry pulls in statically already has a preload tag from
        // Vite; listing it again would just duplicate the request.
        const entry = chunks.find((c) => c.isEntry)
        const alreadyPreloaded = new Set()
        const walk = (file, seen) => {
          if (!file || seen.has(file)) return
          seen.add(file)
          for (const dep of byFile.get(file)?.imports ?? []) walk(dep, seen)
        }
        walk(entry?.fileName, alreadyPreloaded)

        const map = {}
        for (const [route, moduleSuffix] of Object.entries(ROUTE_ENTRIES)) {
          const chunk = findByModule(moduleSuffix)
          if (!chunk) {
            this.warn(`route-chunk-preload: no chunk found for ${moduleSuffix}`)
            continue
          }
          const deps = new Set()
          walk(chunk.fileName, deps)
          const files = [...deps].filter((f) => !alreadyPreloaded.has(f))
          if (files.length) map[route] = files.map((f) => base + f)
        }
        if (!Object.keys(map).length) return html

        return {
          html,
          tags: [{
            tag: 'script',
            // A classic script prepended to <head>, deliberately: a module
            // script is deferred and runs in document order *after* the entry,
            // by which point the entry has already started the import() itself
            // and the hints are worthless. This runs while the HTML is still
            // parsing, so the route chunk is in flight before React is fetched.
            children:
              `var m=${JSON.stringify(map)}[location.pathname];` +
              `if(m)for(var i=0;i<m.length;i++){var l=document.createElement('link');` +
              `l.rel='modulepreload';l.crossOrigin='';l.href=m[i];document.head.appendChild(l)}`,
            injectTo: 'head-prepend',
          }],
        }
      },
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), routeChunkPreload()],
  build: {
    // Every browser that can run getUserMedia + WebAssembly (which this app
    // requires anyway) supports ES2020, so shipping legacy transpilation and
    // polyfills to them is pure weight.
    target: 'es2020',
    rollupOptions: {
      output: {
        // React and the router change only when a dependency is upgraded, while
        // the app code changes every deploy. Keeping them in their own chunk
        // means a release invalidates the app chunk alone and returning users
        // re-download tens of kilobytes instead of the whole entry.
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-dom/client', 'react-router-dom'],
        },
      },
    },
  },
})
