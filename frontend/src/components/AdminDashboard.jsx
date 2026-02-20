import React, { useEffect, useState, useCallback } from 'react';
import { getAllUsers, adminDeleteUser, adminUpdateUser, getErrorMessage } from '../services/api';
import ConfirmDialog from './ConfirmDialog';

const AdminDashboard = () => {
    const [adminSecret, setAdminSecret] = useState('');
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [secretInput, setSecretInput] = useState('');
    const [secretError, setSecretError] = useState('');

    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(false);
    const [alert, setAlert] = useState(null); // { type, text }
    const [editMode, setEditMode] = useState(null); // phone of user being edited
    const [editForm, setEditForm] = useState({ name: '', masked_id: '' });
    const [confirm, setConfirm] = useState(null);

    const setError = (text) => setAlert({ type: 'error', text });
    const setSuccess = (text) => setAlert({ type: 'success', text });

    // ── Authenticate with admin secret ────────────────────────────
    const handleAdminLogin = async (e) => {
        e.preventDefault();
        setSecretError('');
        if (!secretInput.trim()) { setSecretError('Admin secret is required.'); return; }
        // Try fetching users to validate the secret
        setLoading(true);
        try {
            const data = await getAllUsers(secretInput.trim());
            setAdminSecret(secretInput.trim());
            setUsers(data);
            setIsAuthenticated(true);
        } catch (err) {
            setSecretError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    // ── Fetch Users ───────────────────────────────────────────────
    const fetchUsers = useCallback(async () => {
        setLoading(true);
        try {
            const data = await getAllUsers(adminSecret);
            setUsers(data);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, [adminSecret]);

    useEffect(() => {
        if (isAuthenticated) fetchUsers();
    }, [isAuthenticated, fetchUsers]);

    // ── Delete ────────────────────────────────────────────────────
    const requestDelete = (phone) => {
        setConfirm({
            title: 'Delete User',
            message: `Delete the account for ${phone}? This cannot be undone.`,
            danger: true,
            confirmLabel: 'Delete',
            onConfirm: async () => {
                setConfirm(null);
                try {
                    await adminDeleteUser(phone, adminSecret);
                    setUsers((prev) => prev.filter((u) => u.phone !== phone));
                    setSuccess(`User ${phone} deleted successfully.`);
                } catch (err) {
                    setError(getErrorMessage(err));
                }
            },
        });
    };

    // ── Edit ──────────────────────────────────────────────────────
    const startEdit = (user) => {
        setEditMode(user.phone);
        setEditForm({ name: user.name, masked_id: user.masked_id });
    };

    const cancelEdit = () => { setEditMode(null); };

    const saveEdit = async (phone) => {
        try {
            await adminUpdateUser(phone, editForm, adminSecret);
            setUsers((prev) => prev.map((u) => u.phone === phone ? { ...u, ...editForm } : u));
            setEditMode(null);
            setSuccess('User updated successfully.');
        } catch (err) {
            setError(getErrorMessage(err));
        }
    };

    const formattedDate = (d) => d ? new Date(d).toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' }) : 'N/A';

    // ── Admin Auth Gate ───────────────────────────────────────────
    if (!isAuthenticated) {
        return (
            <div className="card" style={{ maxWidth: 400 }}>
                <div className="card-header">
                    <div className="card-icon">🛡</div>
                    <h1 className="card-title">Admin Access</h1>
                    <p className="card-subtitle">Enter the admin secret to continue</p>
                </div>
                <form onSubmit={handleAdminLogin}>
                    <div className="form-group">
                        <label className="form-label" htmlFor="admin-secret">Admin Secret</label>
                        <input
                            id="admin-secret"
                            className="form-input"
                            type="password"
                            value={secretInput}
                            onChange={(e) => setSecretInput(e.target.value)}
                            placeholder="Enter admin secret"
                            autoFocus
                        />
                    </div>
                    {secretError && <div className="alert alert-error"><span>✕</span><span>{secretError}</span></div>}
                    <button type="submit" className="btn btn-primary" disabled={loading}>
                        {loading ? 'Verifying…' : 'Access Dashboard'}
                    </button>
                </form>
            </div>
        );
    }

    // ── Admin Dashboard ───────────────────────────────────────────
    return (
        <div className="card card--wide">
            {confirm && (
                <ConfirmDialog
                    title={confirm.title}
                    message={confirm.message}
                    danger={confirm.danger}
                    confirmLabel={confirm.confirmLabel}
                    onConfirm={confirm.onConfirm}
                    onCancel={() => setConfirm(null)}
                />
            )}

            <div className="card-header">
                <div className="card-icon">🛡</div>
                <h1 className="card-title">Admin Dashboard</h1>
                <p className="card-subtitle">{users.length} registered user{users.length !== 1 ? 's' : ''}</p>
            </div>

            {alert && (
                <div className={`alert alert-${alert.type}`}>
                    <span>{alert.type === 'success' ? '✓' : '✕'}</span>
                    <span>{alert.text}</span>
                </div>
            )}

            {loading ? (
                <div className="spinner-overlay"><div className="spinner" /><span>Loading users…</span></div>
            ) : users.length === 0 ? (
                <p style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '2rem 0' }}>No registered users found.</p>
            ) : (
                <div className="admin-table-wrapper">
                    <table className="admin-table">
                        <thead>
                            <tr>
                                <th>Name</th>
                                <th>Phone</th>
                                <th>Masked ID</th>
                                <th>Registered</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {users.map((user) => (
                                <tr key={user.phone}>
                                    <td>
                                        {editMode === user.phone
                                            ? <input className="table-input" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
                                            : user.name}
                                    </td>
                                    <td>{user.phone}</td>
                                    <td>
                                        {editMode === user.phone
                                            ? <input className="table-input" value={editForm.masked_id} onChange={(e) => setEditForm({ ...editForm, masked_id: e.target.value })} />
                                            : <span style={{ fontFamily: 'monospace' }}>{user.masked_id}</span>}
                                    </td>
                                    <td>{formattedDate(user.created_at)}</td>
                                    <td>
                                        <div className="admin-actions">
                                            {editMode === user.phone ? (
                                                <>
                                                    <button className="btn btn-success btn-sm" onClick={() => saveEdit(user.phone)}>Save</button>
                                                    <button className="btn btn-secondary btn-sm" onClick={cancelEdit}>Cancel</button>
                                                </>
                                            ) : (
                                                <>
                                                    <button className="btn btn-secondary btn-sm" onClick={() => startEdit(user)}>Edit</button>
                                                    <button className="btn btn-danger btn-sm" onClick={() => requestDelete(user.phone)}>Delete</button>
                                                </>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            <hr className="divider" />
            <div className="btn-group">
                <button className="btn btn-secondary" onClick={fetchUsers} disabled={loading}>Refresh</button>
                <button className="btn btn-secondary" onClick={() => { setIsAuthenticated(false); setUsers([]); setAdminSecret(''); setSecretInput(''); }}>
                    Logout Admin
                </button>
            </div>
        </div>
    );
};

export default AdminDashboard;
