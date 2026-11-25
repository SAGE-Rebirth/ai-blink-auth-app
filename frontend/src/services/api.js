import axios from 'axios';
import { clearTokens } from './tokens';

// Configurable so a deployed build does not have to point at localhost.
// Set VITE_API_URL in .env / .env.production to override.
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

const api = axios.create({
  baseURL: API_URL,
  headers: { 'Content-Type': 'application/json' },
});

// ─── Token / Role Storage ─────────────────────────────────────────────────────
// Defined in ./tokens so the app shell can read them without pulling in axios;
// re-exported here so `from '../services/api'` keeps working everywhere.
export { storeTokens, clearTokens, getRole } from './tokens';

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
  const detail = error?.response?.data?.detail;
  // FastAPI returns validation errors as a list of {loc, msg, type}.
  if (Array.isArray(detail)) {
    return detail.map((d) => d.msg || String(d)).join(' ');
  }
  if (typeof detail === 'string') return detail;
  if (error?.code === 'ERR_NETWORK') {
    return 'Cannot reach the server. Check that the backend is running.';
  }
  if (error?.response?.status === 429) {
    return 'Too many attempts. Please wait a moment and try again.';
  }
  if (error?.message) return error.message;
  return 'An unexpected error occurred.';
};

/** True when the failure was the liveness check rather than identity. */
export const isLivenessFailure = (error) =>
  error?.response?.headers?.['x-liveness-failed'] === '1';

// ─── Auth API ────────────────────────────────────────────────────────────────
export const registerUser = async (userData) => (await api.post('/auth/register', userData)).data;
export const checkUser = async (phone) => (await api.post('/auth/check-user', { phone })).data;

/**
 * Fetch a single-use liveness challenge. Must be called immediately before
 * capturing, since it expires in seconds and is consumed on first use.
 */
export const getChallenge = async (phone) => (await api.post('/auth/challenge', { phone })).data;

/**
 * Verify a captured blink bundle.
 * `frames` is [{ phase, t_ms, image, ear }] covering open_before / closed / open_after.
 */
export const verifyUser = async ({ phone, challenge_id, frames }) =>
  (await api.post('/auth/verify-face', { phone, challenge_id, frames })).data;
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
export const adminUnlockUser = async (phone) => (await api.put(`/auth/admin/unlock/${phone}`)).data;

export default api;
