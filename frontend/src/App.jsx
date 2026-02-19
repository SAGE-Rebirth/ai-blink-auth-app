import React, { useState, useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import RegistrationForm from './components/RegistrationForm';
import Login from './components/Login';
import Profile from './components/Profile';
import AdminDashboard from './components/AdminDashboard';
import './App.css';

// Protected Route Wrapper
const ProtectedRoute = ({ children }) => {
  const token = localStorage.getItem('token');
  if (!token) {
    return <Navigate to="/" replace />;
  }
  return children;
};

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const token = localStorage.getItem('token');
    // Only auto-authenticate if we are on the profile page
    // This allows the landing page (/) to always show the Login form first
    if (token && location.pathname === '/profile') {
      setIsAuthenticated(true);
    }
  }, [location.pathname]);

  const handleLoginSuccess = () => {
    setIsAuthenticated(true);
    navigate('/profile');
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    setIsAuthenticated(false);
    navigate('/');
  };

  return (
    <>
      <div className="auth-nav">
        {!isAuthenticated && location.pathname !== '/admin' && (
          <>
            <button
              className={`nav-btn ${location.pathname === '/' ? 'active' : ''}`}
              onClick={() => navigate('/')}
            >
              Login
            </button>
            <button
              className={`nav-btn ${location.pathname === '/register' ? 'active' : ''}`}
              onClick={() => navigate('/register')}
            >
              Register
            </button>
            <button
              className={`nav-btn ${location.pathname === '/admin' ? 'active' : ''}`}
              onClick={() => navigate('/admin')}
            >
              Admin
            </button>
          </>
        )}
        {isAuthenticated && (
          <button
            className={`nav-btn ${location.pathname === '/profile' ? 'active' : ''}`}
            onClick={() => navigate('/profile')}
          >
            My Profile
          </button>
        )}
        {location.pathname === '/admin' && (
          <div className="nav-title">Admin Console</div>
        )}
      </div>

      <Routes>
        <Route path="/" element={<Login onLoginSuccess={handleLoginSuccess} onAdminClick={() => navigate('/admin')} />} />
        <Route path="/register" element={<RegistrationForm onRegisterSuccess={() => navigate('/')} />} />
        <Route
          path="/profile"
          element={
            <ProtectedRoute>
              <Profile onLogout={handleLogout} />
            </ProtectedRoute>
          }
        />
        <Route path="/admin" element={<AdminDashboard onBack={() => navigate('/')} />} />
      </Routes>
    </>
  );
}

export default App;
