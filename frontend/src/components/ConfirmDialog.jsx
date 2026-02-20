import React from 'react';

/**
 * Custom confirmation modal — replaces the blocking window.confirm() dialog.
 * Props:
 *   title   : string
 *   message : string
 *   onConfirm : () => void
 *   onCancel  : () => void
 *   confirmLabel : string (default 'Confirm')
 *   danger  : bool — if true, confirm button is styled as danger
 */
const ConfirmDialog = ({
    title = 'Are you sure?',
    message,
    onConfirm,
    onCancel,
    confirmLabel = 'Confirm',
    danger = false,
}) => (
    <div className="modal-backdrop" onClick={onCancel}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal__title">{title}</h3>
            {message && <p className="modal__body">{message}</p>}
            <div className="btn-group">
                <button className="btn btn-secondary" onClick={onCancel}>Cancel</button>
                <button
                    className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
                    onClick={onConfirm}
                >
                    {confirmLabel}
                </button>
            </div>
        </div>
    </div>
);

export default ConfirmDialog;
