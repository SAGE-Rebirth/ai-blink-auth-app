import axios from 'axios';

const API_URL = 'http://localhost:8000';

const api = axios.create({
  baseURL: API_URL,
  headers: { 'Content-Type': 'application/json' },
});

// ─── Token Storage Helpers ────────────────────────────────────────────────────
export const storeTokens = ({ access_token, refresh_token }) => {
  if (access_token) localStorage.setItem('token', access_token);
  if (refresh_token) localStorage.setItem('refresh_token', refresh_token);
};

export const clearTokens = () => {
  localStorage.removeItem('token');
  localStorage.removeItem('refresh_token');
};

// ─── Request Interceptor ─────────────────────────────────────────────────────
// Attach JWT access token to every outgoing request
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// ─── Response Interceptor ────────────────────────────────────────────────────
// On 401: attempt a silent refresh using the refresh token.
// If refresh fails (expired), clear all tokens and fire auth:logout event.
let _isRefreshing = false;
let _failedQueue = [];

const _processQueue = (error, token = null) => {
  _failedQueue.forEach((p) => (error ? p.reject(error) : p.resolve(token)));
  _failedQueue = [];
};

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    if (error.response?.status === 401 && !originalRequest._retry) {
      const refreshToken = localStorage.getItem('refresh_token');

      if (!refreshToken) {
        clearTokens();
        window.dispatchEvent(new CustomEvent('auth:logout'));
        return Promise.reject(error);
      }

      if (_isRefreshing) {
        // Queue during ongoing refresh
        return new Promise((resolve, reject) => {
          _failedQueue.push({
            resolve: (token) => { originalRequest.headers.Authorization = `Bearer ${token}`; resolve(api(originalRequest)); },
            reject,
          });
        });
      }

      originalRequest._retry = true;
      _isRefreshing = true;

      try {
        const { data } = await axios.post(`${API_URL}/auth/refresh`, {
          refresh_token: refreshToken,
        });
        const newAccessToken = data.access_token;
        localStorage.setItem('token', newAccessToken);
        api.defaults.headers.common.Authorization = `Bearer ${newAccessToken}`;
        _processQueue(null, newAccessToken);
        originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;
        return api(originalRequest);
      } catch (refreshError) {
        _processQueue(refreshError);
        clearTokens();
        window.dispatchEvent(new CustomEvent('auth:logout'));
        return Promise.reject(refreshError);
      } finally {
        _isRefreshing = false;
      }
    }
    return Promise.reject(error);
  }
);

// ─── Helper ──────────────────────────────────────────────────────────────────
// Unwraps the API error into a readable string
export const getErrorMessage = (error) => {
  if (error?.response?.data?.detail) return error.response.data.detail;
  if (error?.message) return error.message;
  return 'An unexpected error occurred.';
};

// ─── API Functions ───────────────────────────────────────────────────────────
export const registerUser = async (userData) => {
  const response = await api.post('/auth/register', userData);
  return response.data;
};

export const checkUser = async (phone) => {
  const response = await api.post('/auth/check-user', { phone });
  return response.data;
};

export const verifyUser = async (payload) => {
  const response = await api.post('/auth/verify-face', payload);
  return response.data;
};

export const getProfile = async () => {
  const response = await api.get('/auth/profile');
  return response.data;
};

export const updateProfile = async (data) => {
  const response = await api.put('/auth/profile', data);
  return response.data;
};

export const updateFace = async (images) => {
  const response = await api.put('/auth/profile/face', { images });
  return response.data;
};

export const deleteAccount = async () => {
  const response = await api.delete('/auth/profile');
  return response.data;
};

export const getAllUsers = async (adminSecret) => {
  const response = await api.get('/auth/admin/users', {
    headers: { 'X-Admin-Secret': adminSecret },
  });
  return response.data;
};

export const adminUpdateUser = async (phone, data, adminSecret) => {
  const response = await api.put(`/auth/admin/users/${phone}`, data, {
    headers: { 'X-Admin-Secret': adminSecret },
  });
  return response.data;
};

export const adminDeleteUser = async (phone, adminSecret) => {
  const response = await api.delete(`/auth/admin/users/${phone}`, {
    headers: { 'X-Admin-Secret': adminSecret },
  });
  return response.data;
};

export default api;
