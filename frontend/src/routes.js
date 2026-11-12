import { lazy } from 'react';

/**
 * Route code-splitting, in one place so the build and the runtime agree.
 *
 * Each screen is its own chunk, so opening /admin no longer downloads Login,
 * RegistrationForm and Profile as well. Splitting naively made a cold visit
 * slower, though, and two pieces fix that:
 *
 *  - the browser only discovers an import() after the entry chunk has executed,
 *    which put a second round trip on the critical path. The
 *    `route-chunk-preload` plugin in vite.config.js turns the map below into
 *    <link rel="modulepreload"> tags for the requested path, so the route chunk
 *    downloads in parallel with React instead of after it.
 *  - a Suspense fallback that paints and is then replaced costs a layout shift,
 *    because <main> centres its child and re-centres it when the real screen
 *    (taller than the spinner) arrives. RouteView renders the module directly
 *    once it is in hand, so on a preloaded route no fallback is painted at all.
 *
 * Keys are matched against location.pathname exactly; keep them in sync with the
 * <Route path> values in App.jsx and with ROUTE_ENTRIES in vite.config.js.
 */
export const routeLoaders = {
  '/': () => import('./components/Login'),
  '/register': () => import('./components/RegistrationForm'),
  '/profile': () => import('./components/Profile'),
  '/admin': () => import('./components/AdminDashboard'),
};

const lazyComponents = {
  '/': lazy(routeLoaders['/']),
  '/register': lazy(routeLoaders['/register']),
  '/profile': lazy(routeLoaders['/profile']),
  '/admin': lazy(routeLoaders['/admin']),
};

/** Route path -> module default, for chunks that have finished loading. */
const loaded = new Map();

/**
 * Warm a route's chunk. Dynamic imports are module-cached, so calling this more
 * than once is free. Never rejects: a prefetch that loses the network must not
 * surface an error — the real navigation will retry and report it properly.
 */
export const preloadRoute = (pathname) => {
  const load = routeLoaders[pathname];
  if (!load) return Promise.resolve();
  return load().then(
    (module) => { loaded.set(pathname, module.default); },
    () => { },
  );
};

/**
 * The component to render for `path`: the already-loaded module when the chunk
 * is in hand (no Suspense round trip), otherwise the lazy wrapper.
 *
 * Callers must resolve this once per mount, not on every render — the two
 * results are different component identities, so switching between them at the
 * same position would make React remount the screen and discard its state.
 */
export const resolveRouteComponent = (path) =>
  loaded.get(path) ?? lazyComponents[path];
