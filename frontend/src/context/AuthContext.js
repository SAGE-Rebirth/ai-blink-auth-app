import { createContext, useContext } from 'react';

/**
 * Auth context, kept in its own module.
 *
 * It used to live in App.jsx alongside the App component. Vite's fast refresh
 * only works when a module exports components *or* values, not both, so every
 * edit to App.jsx forced a full page reload — which in this app means the
 * camera restarts and any in-progress capture is lost.
 */
export const AuthContext = createContext(null);

export const useAuth = () => {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used inside <AuthContext.Provider>');
    return ctx;
};
