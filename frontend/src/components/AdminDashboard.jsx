import React, { useEffect, useState, useCallback } from 'react';
import {
    getAllUsers, adminDeleteUser, adminUpdateUser,
    promoteToAdmin, demoteToUser, getErrorMessage
} from '../services/api';
import ConfirmDialog from './ConfirmDialog';

const RoleBadge = ({ role }) => (
    role === 'admin'
        ? <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-purple-500/20 text-purple-300 border border-purple-500/30">🛡 Admin</span>
        : <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-500/20 text-slate-400 border border-slate-500/30">👤 User</span>
);

const StatCard = ({ icon, label, value, color }) => (
    <div className={`bg-slate-800/60 border rounded-xl p-4 flex items-center gap-3 ${color}`}>
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center text-xl bg-slate-700/50`}>{icon}</div>
        <div>
            <p className="text-2xl font-bold text-white">{value}</p>
            <p className="text-xs text-slate-400">{label}</p>
        </div>
    </div>
);

const AdminDashboard = () => {
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [alert, setAlert] = useState(null);
    const [editMode, setEditMode] = useState(null);
    const [editForm, setEditForm] = useState({ name: '', masked_id: '' });
    const [confirm, setConfirm] = useState(null);
    const [search, setSearch] = useState('');

    const setError = (t) => setAlert({ type: 'error', text: t });
    const setSuccess = (t) => setAlert({ type: 'success', text: t });

    const fetchUsers = useCallback(async () => {
        setLoading(true);
        try {
            const data = await getAllUsers();
            setUsers(data);
        } catch (err) {
            setError(getErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchUsers(); }, [fetchUsers]);

    // ── Delete ─────────────────────────────────────────────────────────
    const requestDelete = (user) => {
        setConfirm({
            title: 'Delete User',
            message: `Delete account for ${user.name} (${user.phone})? This cannot be undone.`,
            danger: true,
            confirmLabel: 'Delete',
            onConfirm: async () => {
                setConfirm(null);
                try {
                    await adminDeleteUser(user.phone);
                    setUsers((prev) => prev.filter((u) => u.phone !== user.phone));
                    setSuccess(`${user.name} deleted.`);
                } catch (err) { setError(getErrorMessage(err)); }
            },
        });
    };

    // ── Edit ───────────────────────────────────────────────────────────
    const startEdit = (user) => { setEditMode(user.phone); setEditForm({ name: user.name, masked_id: user.masked_id }); };
    const cancelEdit = () => setEditMode(null);
    const saveEdit = async (phone) => {
        try {
            await adminUpdateUser(phone, editForm);
            setUsers((prev) => prev.map((u) => u.phone === phone ? { ...u, ...editForm } : u));
            setEditMode(null);
            setSuccess('User updated.');
        } catch (err) { setError(getErrorMessage(err)); }
    };

    // ── Promote / Demote ───────────────────────────────────────────────
    const handleToggleRole = (user) => {
        const isPromoting = user.role !== 'admin';
        setConfirm({
            title: isPromoting ? 'Promote to Admin' : 'Demote to User',
            message: isPromoting
                ? `Grant admin access to ${user.name}? They will have full admin privileges.`
                : `Remove admin access from ${user.name}?`,
            danger: !isPromoting,
            confirmLabel: isPromoting ? 'Promote' : 'Demote',
            onConfirm: async () => {
                setConfirm(null);
                try {
                    if (isPromoting) {
                        await promoteToAdmin(user.phone);
                        setUsers((prev) => prev.map((u) => u.phone === user.phone ? { ...u, role: 'admin' } : u));
                        setSuccess(`${user.name} is now an admin.`);
                    } else {
                        await demoteToUser(user.phone);
                        setUsers((prev) => prev.map((u) => u.phone === user.phone ? { ...u, role: 'user' } : u));
                        setSuccess(`${user.name} is now a user.`);
                    }
                } catch (err) { setError(getErrorMessage(err)); }
            },
        });
    };

    const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' }) : 'N/A';

    const filtered = users.filter((u) =>
        u.name.toLowerCase().includes(search.toLowerCase()) ||
        u.phone.includes(search)
    );

    const adminCount = users.filter(u => u.role === 'admin').length;
    const userCount = users.length - adminCount;

    return (
        <div className="w-full max-w-5xl mx-auto px-2 animate-slide-up">
            {confirm && <ConfirmDialog {...confirm} onCancel={() => setConfirm(null)} />}

            {/* Header */}
            <div className="mb-6">
                <div className="flex items-center gap-3 mb-1">
                    <div className="w-10 h-10 bg-purple-500/20 rounded-xl flex items-center justify-center text-xl border border-purple-500/30">🛡</div>
                    <div>
                        <h1 className="text-2xl font-bold text-white">Admin Dashboard</h1>
                        <p className="text-slate-400 text-sm">Manage users, roles, and accounts</p>
                    </div>
                </div>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-3 mb-5">
                <StatCard icon="👥" label="Total Users" value={users.length} color="border-slate-700/50" />
                <StatCard icon="🛡" label="Admins" value={adminCount} color="border-purple-500/20" />
                <StatCard icon="👤" label="Regular Users" value={userCount} color="border-blue-500/20" />
            </div>

            {/* Alert */}
            {alert && (
                <div className={`flex items-center gap-2 rounded-xl px-4 py-3 mb-4 text-sm font-medium ${alert.type === 'success' ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300' : 'bg-red-500/10 border border-red-500/30 text-red-300'
                    }`}>
                    <span>{alert.type === 'success' ? '✓' : '✕'}</span>
                    <span>{alert.text}</span>
                    <button onClick={() => setAlert(null)} className="ml-auto text-current opacity-60 hover:opacity-100">✕</button>
                </div>
            )}

            {/* Search + Refresh */}
            <div className="flex gap-3 mb-4">
                <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search by name or phone…"
                    className="flex-1 bg-slate-800/60 border border-slate-700/50 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-500/50 transition-all"
                />
                <button
                    onClick={fetchUsers}
                    disabled={loading}
                    className="px-4 py-2.5 rounded-xl border border-slate-700/50 bg-slate-800/60 text-slate-300 hover:bg-slate-700/60 text-sm font-medium transition-all disabled:opacity-50"
                >
                    {loading ? '↻' : '↻ Refresh'}
                </button>
            </div>

            {/* Table */}
            <div className="bg-slate-800/60 border border-slate-700/50 rounded-2xl overflow-hidden">
                {loading ? (
                    <div className="flex flex-col items-center gap-3 py-16">
                        <div className="spinner" style={{ width: 36, height: 36, borderWidth: 3 }} />
                        <span className="text-slate-400 text-sm">Loading users…</span>
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="text-center py-16 text-slate-500">
                        {search ? '🔍 No users match your search.' : '👥 No registered users found.'}
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-slate-700/50 bg-slate-900/40">
                                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">User</th>
                                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">Phone</th>
                                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider hidden md:table-cell">Masked ID</th>
                                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">Role</th>
                                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider hidden lg:table-cell">Joined</th>
                                    <th className="text-right px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-700/30">
                                {filtered.map((user) => (
                                    <tr key={user.phone} className="hover:bg-slate-700/20 transition-colors group">
                                        <td className="px-4 py-3">
                                            {editMode === user.phone ? (
                                                <input
                                                    value={editForm.name}
                                                    onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                                                    className="bg-slate-700 border border-slate-600 rounded-lg px-2 py-1 text-white text-sm w-full focus:outline-none focus:ring-1 focus:ring-primary-500"
                                                />
                                            ) : (
                                                <div className="flex items-center gap-2">
                                                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary-500 to-purple-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                                                        {user.name.charAt(0).toUpperCase()}
                                                    </div>
                                                    <span className="font-medium text-white">{user.name}</span>
                                                </div>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 text-slate-300 font-mono text-xs">{user.phone}</td>
                                        <td className="px-4 py-3 hidden md:table-cell">
                                            {editMode === user.phone ? (
                                                <input
                                                    value={editForm.masked_id}
                                                    onChange={(e) => setEditForm({ ...editForm, masked_id: e.target.value })}
                                                    className="bg-slate-700 border border-slate-600 rounded-lg px-2 py-1 text-white text-sm w-full focus:outline-none focus:ring-1 focus:ring-primary-500"
                                                />
                                            ) : (
                                                <span className="text-slate-400 font-mono text-xs">{user.masked_id}</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3"><RoleBadge role={user.role} /></td>
                                        <td className="px-4 py-3 text-slate-500 text-xs hidden lg:table-cell">{fmtDate(user.created_at)}</td>
                                        <td className="px-4 py-3">
                                            <div className="flex items-center justify-end gap-1.5">
                                                {editMode === user.phone ? (
                                                    <>
                                                        <button onClick={() => saveEdit(user.phone)} className="px-2.5 py-1 rounded-lg bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-xs hover:bg-emerald-500/30 transition-all">Save</button>
                                                        <button onClick={cancelEdit} className="px-2.5 py-1 rounded-lg bg-slate-700/50 text-slate-400 border border-slate-600/50 text-xs hover:bg-slate-700 transition-all">Cancel</button>
                                                    </>
                                                ) : (
                                                    <>
                                                        <button onClick={() => startEdit(user)} className="px-2.5 py-1 rounded-lg bg-blue-500/10 text-blue-400 border border-blue-500/20 text-xs hover:bg-blue-500/20 transition-all opacity-0 group-hover:opacity-100">Edit</button>
                                                        <button
                                                            onClick={() => handleToggleRole(user)}
                                                            className={`px-2.5 py-1 rounded-lg text-xs border transition-all ${user.role === 'admin'
                                                                    ? 'bg-orange-500/10 text-orange-400 border-orange-500/20 hover:bg-orange-500/20'
                                                                    : 'bg-purple-500/10 text-purple-400 border-purple-500/20 hover:bg-purple-500/20'
                                                                }`}
                                                        >
                                                            {user.role === 'admin' ? 'Demote' : 'Promote'}
                                                        </button>
                                                        <button onClick={() => requestDelete(user)} className="px-2.5 py-1 rounded-lg bg-red-500/10 text-red-400 border border-red-500/20 text-xs hover:bg-red-500/20 transition-all">Delete</button>
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
            </div>

            <p className="text-center text-xs text-slate-600 mt-3">
                Showing {filtered.length} of {users.length} users
            </p>
        </div>
    );
};

export default AdminDashboard;
