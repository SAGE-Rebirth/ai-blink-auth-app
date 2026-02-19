import React, { useEffect, useState } from 'react';
import { getAllUsers, adminDeleteUser, adminUpdateUser } from '../services/api';

const AdminDashboard = ({ onBack }) => {
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [editMode, setEditMode] = useState(null); // phone number of user being edited
    const [editForm, setEditForm] = useState({ name: '', masked_id: '' });

    useEffect(() => {
        fetchUsers();
    }, []);

    const fetchUsers = async () => {
        try {
            const data = await getAllUsers();
            setUsers(data);
        } catch (err) {
            setError('Failed to fetch users');
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    const handleDelete = async (phone) => {
        if (window.confirm(`Are you sure you want to delete user with phone ${phone}?`)) {
            try {
                await adminDeleteUser(phone);
                setUsers(users.filter(u => u.phone !== phone));
                alert('User deleted successfully');
            } catch (err) {
                alert(`Failed to delete: ${err.detail || 'Unknown error'}`);
            }
        }
    };

    const startEdit = (user) => {
        setEditMode(user.phone);
        setEditForm({ name: user.name, masked_id: user.masked_id });
    };

    const cancelEdit = () => {
        setEditMode(null);
        setEditForm({ name: '', masked_id: '' });
    };

    const saveEdit = async (phone) => {
        try {
            await adminUpdateUser(phone, editForm);
            setUsers(users.map(u => u.phone === phone ? { ...u, ...editForm } : u));
            setEditMode(null);
        } catch (err) {
            alert(`Failed to update: ${err.detail || 'Unknown error'}`);
        }
    };

    if (loading) return <div className="processing-state"><div className="spinner"></div></div>;

    return (
        <div className="login-container" style={{ maxWidth: '900px' }}>
            <h2>Admin Dashboard</h2>
            {error && <div className="message error">{error}</div>}

            <div className="users-table-container" style={{ overflowX: 'auto', margin: '20px 0' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                    <thead>
                        <tr style={{ borderBottom: '2px solid #333' }}>
                            <th style={{ padding: '10px' }}>Name</th>
                            <th style={{ padding: '10px' }}>Phone</th>
                            <th style={{ padding: '10px' }}>Masked ID</th>
                            <th style={{ padding: '10px' }}>Registered</th>
                            <th style={{ padding: '10px' }}>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {users.map((user) => (
                            <tr key={user.phone} style={{ borderBottom: '1px solid #eee' }}>
                                <td style={{ padding: '10px' }}>
                                    {editMode === user.phone ? (
                                        <input
                                            value={editForm.name}
                                            onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                                            style={{ padding: '5px' }}
                                        />
                                    ) : user.name}
                                </td>
                                <td style={{ padding: '10px' }}>{user.phone}</td>
                                <td style={{ padding: '10px' }}>
                                    {editMode === user.phone ? (
                                        <input
                                            value={editForm.masked_id}
                                            onChange={(e) => setEditForm({ ...editForm, masked_id: e.target.value })}
                                            style={{ padding: '5px' }}
                                        />
                                    ) : user.masked_id}
                                </td>
                                <td style={{ padding: '10px' }}>{user.created_at ? new Date(user.created_at).toLocaleDateString() : 'N/A'}</td>
                                <td style={{ padding: '10px' }}>
                                    {editMode === user.phone ? (
                                        <div style={{ display: 'flex', gap: '5px' }}>
                                            <button onClick={() => saveEdit(user.phone)} className="btn-small safety-green">Save</button>
                                            <button onClick={cancelEdit} className="btn-small">Cancel</button>
                                        </div>
                                    ) : (
                                        <div style={{ display: 'flex', gap: '5px' }}>
                                            <button onClick={() => startEdit(user)} className="btn-small">Edit</button>
                                            <button onClick={() => handleDelete(user.phone)} className="btn-small danger">Delete</button>
                                        </div>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <button onClick={onBack} className="btn-secondary">Back to App</button>
            <style jsx>{`
                .btn-small {
                    padding: 5px 10px;
                    font-size: 0.8rem;
                    cursor: pointer;
                    background: #444;
                    color: white;
                    border: none;
                    border-radius: 4px;
                }
                .btn-small.danger { background: #d32f2f; }
                .btn-small.safety-green { background: #4caf50; }
                .btn-small:hover { opacity: 0.9; }
            `}</style>
        </div>
    );
};

export default AdminDashboard;
