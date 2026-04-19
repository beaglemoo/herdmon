/* ============================================
   MOO-UPDATER // COMMON HELPERS
   Shared across Patch Ops and Cluster Ops
   ============================================ */

(function () {
    'use strict';

    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function formatDuration(startedAt, finishedAt) {
        if (!startedAt) return '--';
        const start = new Date(startedAt);
        const end = finishedAt ? new Date(finishedAt) : new Date();
        const seconds = Math.floor((end - start) / 1000);

        if (seconds < 60) return `${seconds}s`;
        const minutes = Math.floor(seconds / 60);
        const secs = seconds % 60;
        if (minutes < 60) return `${minutes}m ${secs}s`;
        const hours = Math.floor(minutes / 60);
        return `${hours}h ${minutes % 60}m`;
    }

    function formatRelativeTime(isoString) {
        if (!isoString) return '--';
        const now = Date.now();
        const then = new Date(isoString).getTime();
        const diff = Math.floor((now - then) / 1000);

        if (diff < 10) return 'just now';
        if (diff < 60) return `${diff}s ago`;
        const minutes = Math.floor(diff / 60);
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        return new Date(isoString).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    }

    // ---- Confirm modal ----
    // Each page must include #confirmOverlay DOM. These helpers wire to it.

    let _pendingConfirm = null;
    let _confirmTrigger = null;

    function showConfirm(title, message, onConfirm, options) {
        options = options || {};
        const overlay = document.getElementById('confirmOverlay');
        if (!overlay) return;

        document.getElementById('confirmTitle').textContent = title;
        document.getElementById('confirmMessage').textContent = message;

        const proceedBtn = document.getElementById('confirmProceed');
        const cancelBtn = document.getElementById('confirmCancel');

        // Apply button tier (danger vs warning)
        proceedBtn.className = 'btn ' + (options.proceedClass || 'btn--warning');
        proceedBtn.style.display = onConfirm ? '' : 'none';
        cancelBtn.textContent = onConfirm ? 'CANCEL' : 'OK';

        _pendingConfirm = onConfirm;
        _confirmTrigger = document.activeElement;

        overlay.hidden = false;
        // Move focus into dialog
        proceedBtn.style.display !== 'none' ? proceedBtn.focus() : cancelBtn.focus();
    }

    function hideConfirm() {
        const overlay = document.getElementById('confirmOverlay');
        if (overlay) overlay.hidden = true;
        _pendingConfirm = null;
        if (_confirmTrigger) {
            _confirmTrigger.focus();
            _confirmTrigger = null;
        }
    }

    // Bind confirm modal events (call once per page)
    function initConfirmModal() {
        const overlay = document.getElementById('confirmOverlay');
        if (!overlay) return;

        document.getElementById('confirmCancel').addEventListener('click', hideConfirm);
        document.getElementById('confirmProceed').addEventListener('click', () => {
            const fn = _pendingConfirm;
            hideConfirm();
            if (fn) fn();
        });
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) hideConfirm();
        });

        // Focus trap: keep Tab inside dialog
        overlay.addEventListener('keydown', (e) => {
            if (overlay.hidden) return;
            if (e.key === 'Escape') { hideConfirm(); return; }
            if (e.key !== 'Tab') return;
            const focusable = Array.from(overlay.querySelectorAll('button:not([disabled])'));
            if (!focusable.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        });
    }

    // ---- Browser notifications ----

    function requestNotificationPermission() {
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission().catch(() => {});
        }
    }

    function sendNotification(title, body) {
        if ('Notification' in window && Notification.permission === 'granted') {
            new Notification(title, { body, icon: '/favicon.ico' });
        }
    }

    // ---- Expose ----

    window.MooCommon = {
        escapeHtml,
        formatDuration,
        formatRelativeTime,
        showConfirm,
        hideConfirm,
        initConfirmModal,
        requestNotificationPermission,
        sendNotification,
    };
})();
