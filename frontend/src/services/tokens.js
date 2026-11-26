// Token/role storage, split out from api.js on purpose.
//
// These three helpers touch nothing but localStorage, yet App.jsx needs them on
// the very first render (to decide the initial route and nav state). While they
// lived in api.js, importing them dragged axios into the entry chunk and onto
// the critical path of every page — Lighthouse showed it as
// main.jsx → App.jsx → api.js → axios before anything could paint. Keeping them
// axios-free lets the shell render while the HTTP layer loads with its route.
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
