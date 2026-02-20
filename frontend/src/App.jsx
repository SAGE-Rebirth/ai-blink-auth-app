import React, { useState, useEffect, createContext, useContext, useCallback } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import RegistrationForm from './components/RegistrationForm';
import Login from './components/Login';
import Profile from './components/Profile';
import AdminDashboard from './components/AdminDashboard';
import { clearTokens } from './services/api';
import './App.css';

// ─── Auth Context ─────────────────────────────────────────────────────────────
// Provides isAuthenticated state and login/logout handlers globally
export const AuthContext = createContext(null);

export const useAuth = () => useContext(AuthContext);

const ProtectedRoute = ({ children }) => {
  const token = localStorage.getItem('token');
  return token ? children : <Navigate to="/" replace />;
};

// ─── App ──────────────────────────────────────────────────────────────────────
function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(!!localStorage.getItem('token'));
  const navigate = useNavigate();
  const location = useLocation();

  const handleLoginSuccess = useCallback(() => {
    setIsAuthenticated(true);
    navigate('/profile');
  }, [navigate]);

  const handleLogout = useCallback(() => {
    clearTokens();
    setIsAuthenticated(false);
    navigate('/');
  }, [navigate]);

  // Listen for the auth:logout event dispatched by the 401 response interceptor
  useEffect(() => {
    const onForcedLogout = () => handleLogout();
    window.addEventListener('auth:logout', onForcedLogout);
    return () => window.removeEventListener('auth:logout', onForcedLogout);
  }, [handleLogout]);

  return (
    <AuthContext.Provider value={{ isAuthenticated, handleLoginSuccess, handleLogout }}>
      {/* Navigation Bar */}
      <nav className="app-nav">
        <div className="app-nav__logo">
          <span className="app-nav__logo-icon">👁</span>
          <span>BlinkAuth</span>
        </div>
        <div className="app-nav__links">
          {!isAuthenticated ? (
            <>
              <button
                className={`nav-btn ${location.pathname === '/' ? 'nav-btn--active' : ''}`}
                onClick={() => navigate('/')}
              >
                Login
              </button>
              <button
                className={`nav-btn ${location.pathname === '/register' ? 'nav-btn--active' : ''}`}
                onClick={() => navigate('/register')}
              >
                Register
              </button>
              <button
                className={`nav-btn ${location.pathname === '/admin' ? 'nav-btn--active' : ''}`}
                onClick={() => navigate('/admin')}
              >
                Admin
              </button>
            </>
          ) : (
            <>
              <button
                className={`nav-btn ${location.pathname === '/profile' ? 'nav-btn--active' : ''}`}
                onClick={() => navigate('/profile')}
              >
                My Profile
              </button>
              <button className="nav-btn nav-btn--logout" onClick={handleLogout}>
                Logout
              </button>
            </>
          )}
        </div>
      </nav>

      {/* Page Content */}
      <main className="app-main">
        <Routes>
          <Route path="/" element={<Login />} />
          <Route path="/register" element={<RegistrationForm />} />
          <Route
            path="/profile"
            element={
              <ProtectedRoute>
                <Profile />
              </ProtectedRoute>
            }
          />
          <Route path="/admin" element={<AdminDashboard />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </AuthContext.Provider>
  );
}

export default App;
