import axios from 'axios';

const API_URL = 'http://localhost:8000';

const api = axios.create({
  baseURL: API_URL,
  headers: { 'Content-Type': 'application/json' },
});

// ─── Token / Role Storage ─────────────────────────────────────────────────────
export const storeTokens = ({ access_token, refresh_token, role }) => {
  if (access_token) localStorage.setItem('token', access_token);
  if (refresh_token) localStorage.setItem('refresh_token', refresh_token);
  if (role) localStorage.setItem('role', role);
};

export const clearTokens = () => {
  localStorage.removeItem('token');
  localStorage.removeItem('refresh_token');
  localStorage.removeItem('role');
};

export const getRole = () => localStorage.getItem('role') || 'user';

// ─── Request Interceptor ─────────────────────────────────────────────────────
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token');
    if (token) config.headers.Authorization = `Bearer ${token}`;
    return config;
  },
  (error) => Promise.reject(error)
);

// ─── Response Interceptor ────────────────────────────────────────────────────
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
        const { data } = await axios.post(`${API_URL}/auth/refresh`, { refresh_token: refreshToken });
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
export const getErrorMessage = (error) => {
  if (error?.response?.data?.detail) return error.response.data.detail;
  if (error?.message) return error.message;
  return 'An unexpected error occurred.';
};

// ─── Auth API ────────────────────────────────────────────────────────────────
export const registerUser = async (userData) => (await api.post('/auth/register', userData)).data;
export const checkUser = async (phone) => (await api.post('/auth/check-user', { phone })).data;
export const verifyUser = async (payload) => (await api.post('/auth/verify-face', payload)).data;
export const refreshTokens = async (rt) => (await api.post('/auth/refresh', { refresh_token: rt })).data;
export const getProfile = async () => (await api.get('/auth/profile')).data;
export const updateProfile = async (data) => (await api.put('/auth/profile', data)).data;
export const updateFace = async (images) => (await api.put('/auth/profile/face', { images })).data;
export const deleteAccount = async () => (await api.delete('/auth/profile')).data;

// ─── Admin API (JWT-authenticated, role=admin required) ───────────────────────
export const getAllUsers = async () => (await api.get('/auth/admin/users')).data;
export const adminUpdateUser = async (phone, data) => (await api.put(`/auth/admin/users/${phone}`, data)).data;
export const adminDeleteUser = async (phone) => (await api.delete(`/auth/admin/users/${phone}`)).data;
export const promoteToAdmin = async (phone) => (await api.put(`/auth/admin/promote/${phone}`)).data;
export const demoteToUser = async (phone) => (await api.put(`/auth/admin/demote/${phone}`)).data;

export default api;
