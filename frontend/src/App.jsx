import React, { Suspense, useState, useEffect, useCallback } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
// Route components and their loaders live in ./routes so the build plugin and
// the runtime share one definition of which chunk each path needs.
import { preloadRoute } from './routes';
import RouteView from './components/RouteView';

// Token helpers come from ./services/tokens rather than ./services/api: they are
// plain localStorage reads, and importing them from api.js would put axios on
// the shell's critical path for every route.
import { clearTokens, getRole } from './services/tokens';
import { AuthContext } from './context/AuthContext';
import './App.css';

/**
 * Warm the chunks the current user can reach from the nav, once the browser is
 * idle. Dynamic imports are module-cached, so calling a loader a second time is
 * free and a later click resolves without a network hop.
 */
const prefetchRoutes = (isAuthenticated, role) => {
  const paths = isAuthenticated
    ? ['/profile', ...(role === 'admin' ? ['/admin'] : [])]
    : ['/', '/register'];
  paths.forEach(preloadRoute);
};

const scheduleIdle = (fn) =>
  typeof window.requestIdleCallback === 'function'
    ? window.requestIdleCallback(fn, { timeout: 2000 })
    : window.setTimeout(fn, 1200);

const cancelIdle = (handle) =>
  typeof window.cancelIdleCallback === 'function'
    ? window.cancelIdleCallback(handle)
    : window.clearTimeout(handle);

/** Placeholder while a route chunk downloads. Holds height so nothing shifts. */
const RouteLoading = () => (
  <div
    className="min-h-[60vh] flex flex-col items-center justify-center gap-3 text-slate-400"
    role="status"
    aria-live="polite"
  >
    <span className="spinner" />
    <span className="text-sm">Loading…</span>
  </div>
);

const ProtectedRoute = ({ children }) => {
  const token = localStorage.getItem('token');
  return token ? children : <Navigate to="/" replace />;
};

const AdminRoute = ({ children }) => {
  const token = localStorage.getItem('token');
  const role = getRole();
  if (!token) return <Navigate to="/" replace />;
  if (role !== 'admin') return <Navigate to="/profile" replace />;
  return children;
};

// ─── App ───────────────────────────────────────────────────────────────────────
function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(!!localStorage.getItem('token'));
  const [role, setRole] = useState(getRole());
  const navigate = useNavigate();
  const location = useLocation();

  const handleLoginSuccess = useCallback((userRole) => {
    setIsAuthenticated(true);
    setRole(userRole || 'user');
    navigate(userRole === 'admin' ? '/admin' : '/profile');
  }, [navigate]);

  const handleLogout = useCallback(() => {
    clearTokens();
    setIsAuthenticated(false);
    setRole('user');
    navigate('/');
  }, [navigate]);

  useEffect(() => {
    const onForcedLogout = () => handleLogout();
    window.addEventListener('auth:logout', onForcedLogout);
    return () => window.removeEventListener('auth:logout', onForcedLogout);
  }, [handleLogout]);

  useEffect(() => {
    const handle = scheduleIdle(() => prefetchRoutes(isAuthenticated, role));
    return () => cancelIdle(handle);
  }, [isAuthenticated, role]);

  const isActive = (path) => location.pathname === path;

  return (
    <AuthContext.Provider value={{ isAuthenticated, role, handleLoginSuccess, handleLogout }}>
      {/* ── Navigation ── */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-slate-900/80 backdrop-blur-md border-b border-slate-700/50">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2 font-bold text-lg">
            <span className="text-2xl">👁</span>
            <span className="bg-gradient-to-r from-primary-400 to-purple-400 bg-clip-text text-transparent">
              BlinkAuth
            </span>
          </div>
          <div className="flex items-center gap-1">
            {!isAuthenticated ? (
              <>
                {/* onMouseEnter starts the chunk on intent, so the click itself
                    usually has nothing left to wait for. */}
                <NavBtn active={isActive('/')} onClick={() => navigate('/')} prefetch="/">Login</NavBtn>
                <NavBtn active={isActive('/register')} onClick={() => navigate('/register')} prefetch="/register">Register</NavBtn>
              </>
            ) : (
              <>
                {/* The admin dashboard had no way in from the nav — an admin
                    who navigated away had to retype the URL. */}
                {role === 'admin' && (
                  <NavBtn active={isActive('/admin')} onClick={() => navigate('/admin')} prefetch="/admin">Admin</NavBtn>
                )}
                <NavBtn active={isActive('/profile')} onClick={() => navigate('/profile')} prefetch="/profile">My Profile</NavBtn>
                <button
                  onClick={handleLogout}
                  className="ml-2 px-3 py-1.5 rounded-lg text-sm font-medium bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 transition-all duration-200"
                >
                  Logout
                </button>
              </>
            )}
          </div>
        </div>
      </nav>

      {/* ── Page Content ── */}
      {/* The page gives the full width and each screen decides how much of it
          to use (see AuthLayout). Previously every route was pinned to
          max-w-md, which made the desktop site a phone-width column. */}
      <main className="pt-14 min-h-screen flex items-start sm:items-center justify-center px-4 py-6 sm:py-8">
        <div className="w-full max-w-6xl animate-fade-in">
          <Suspense fallback={<RouteLoading />}>
            <Routes>
              <Route path="/" element={<RouteView path="/" />} />
              <Route path="/register" element={<RouteView path="/register" />} />
              <Route path="/profile" element={<ProtectedRoute><RouteView path="/profile" /></ProtectedRoute>} />
              <Route path="/admin" element={<AdminRoute><RouteView path="/admin" /></AdminRoute>} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </div>
      </main>
    </AuthContext.Provider>
  );
}

const NavBtn = ({ children, active, onClick, prefetch }) => (
  <button
    onClick={onClick}
    onMouseEnter={prefetch ? () => preloadRoute(prefetch) : undefined}
    onFocus={prefetch ? () => preloadRoute(prefetch) : undefined}
    className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-200 ${active
      ? 'bg-primary-500/20 text-primary-300 border border-primary-500/30'
      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/50'
      }`}
  >
    {children}
  </button>
);

export default App;
