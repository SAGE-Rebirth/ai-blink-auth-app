import axios from 'axios';

const API_URL = 'http://localhost:8000';

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Add a request interceptor to include the token
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

export const registerUser = async (userData) => {
  try {
    const response = await api.post('/auth/register', userData);
    return response.data;
  } catch (error) {
    throw error.response ? error.response.data : error;
  }
};

export const verifyUser = async (payload) => {
  try {
    const response = await api.post('/auth/verify-face', payload);
    return response.data;
  } catch (error) {
    throw error.response ? error.response.data : error;
  }
};

export const getProfile = async () => {
  try {
    const response = await api.get('/auth/profile');
    return response.data;
  } catch (error) {
    throw error.response ? error.response.data : error;
  }
};

export const updateProfile = async (data) => {
  try {
    const response = await api.put('/auth/profile', data);
    return response.data;
  } catch (error) {
    throw error.response ? error.response.data : error;
  }
};

export const deleteAccount = async () => {
  try {
    const response = await api.delete('/auth/profile');
    return response.data;
  } catch (error) {
    throw error.response ? error.response.data : error;
  }
};

export const checkUser = async (phone) => {
  try {
    const response = await api.post('/auth/check-user', { phone, image: "" });
    return response.data;
  } catch (error) {
    throw error.response ? error.response.data : error;
  }
};

export const getAllUsers = async () => {
  try {
    const response = await api.get('/auth/admin/users');
    return response.data;
  } catch (error) {
    throw error.response ? error.response.data : error;
  }
};

export const updateFace = async (images) => {
  try {
    const response = await api.put('/auth/profile/face', { images: images });
    return response.data;
  } catch (error) {
    throw error.response ? error.response.data : error;
  }
};

export const adminDeleteUser = async (phone) => {
  try {
    const response = await api.delete(`/auth/admin/users/${phone}`);
    return response.data;
  } catch (error) {
    throw error.response ? error.response.data : error;
  }
};

export const adminUpdateUser = async (phone, data) => {
  try {
    const response = await api.put(`/auth/admin/users/${phone}`, data);
    return response.data;
  } catch (error) {
    throw error.response ? error.response.data : error;
  }
};

export default api;
