import React, { useState, useEffect, createContext, useContext, useCallback } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import RegistrationForm from './components/RegistrationForm';
import Login from './components/Login';
import Profile from './components/Profile';
import AdminDashboard from './components/AdminDashboard';
import { clearTokens, getRole } from './services/api';
import './App.css';

// ─── Auth Context ──────────────────────────────────────────────────────────────
export const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

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
                <NavBtn active={isActive('/')} onClick={() => navigate('/')}>Login</NavBtn>
                <NavBtn active={isActive('/register')} onClick={() => navigate('/register')}>Register</NavBtn>
              </>
            ) : (
              <>
                <NavBtn active={isActive('/profile')} onClick={() => navigate('/profile')}>My Profile</NavBtn>
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
      <main className="pt-14 min-h-screen flex items-center justify-center p-4">
        <div className={`w-full animate-fade-in ${location.pathname === '/admin' ? 'max-w-6xl' : 'max-w-md'}`}>
          <Routes>
            <Route path="/" element={<Login />} />
            <Route path="/register" element={<RegistrationForm />} />
            <Route path="/profile" element={<ProtectedRoute><Profile /></ProtectedRoute>} />
            <Route path="/admin" element={<AdminRoute><AdminDashboard /></AdminRoute>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </main>
    </AuthContext.Provider>
  );
}

const NavBtn = ({ children, active, onClick }) => (
  <button
    onClick={onClick}
    className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-200 ${active
      ? 'bg-primary-500/20 text-primary-300 border border-primary-500/30'
      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/50'
      }`}
  >
    {children}
  </button>
);

export default App;
