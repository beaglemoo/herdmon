/* ============================================
   MOO-UPDATER // CLUSTER OPS
   Proxmox cluster management page
   ============================================ */

(function () {
    'use strict';

    // ---- State ----

    const state = {
        nodes: [],
        jobs: [],
        activeSSE: null,
        refreshInterval: null,
        jobPollInterval: null,
        pendingConfirm: null,
    };

    // ---- API ----

    const api = {
        async getNodes() {
            const res = await fetch('/api/cluster/nodes');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        },

        async getJobs() {
            const res = await fetch('/api/jobs');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        },

        async createJob(playbook, hosts) {
            const res = await fetch('/api/jobs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ playbook, hosts }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail || `HTTP ${res.status}`);
            }
            return res.json();
        },

        streamJob(jobId) {
            return new EventSource(`/api/jobs/${jobId}/stream`);
        },
    };

    // ---- DOM refs ----

    const $ = (sel) => document.querySelector(sel);

    const dom = {
        connectionIndicator: $('#connectionIndicator'),
        connectionLabel: $('#connectionLabel'),
        lastRefresh: $('#lastRefresh'),
        nodeGrid: $('#nodeGrid'),
        refreshNodes: $('#refreshNodes'),
        rollingRestart: $('#rollingRestart'),
        activeJobCount: $('#activeJobCount'),
        jobsList: $('#jobsList'),
        terminalOverlay: $('#terminalOverlay'),
        terminalTitle: $('#terminalTitle'),
        terminalStatus: $('#terminalStatus'),
        terminalBody: $('#terminalBody'),
        terminalOutput: $('#terminalOutput'),
        terminalClose: $('#terminalClose'),
        confirmOverlay: $('#confirmOverlay'),
        confirmTitle: $('#confirmTitle'),
        confirmMessage: $('#confirmMessage'),
        confirmCancel: $('#confirmCancel'),
        confirmProceed: $('#confirmProceed'),
    };

    // ---- Node Cards ----

    function renderNodes(nodes) {
        if (!nodes.length) {
            dom.nodeGrid.innerHTML = '<div class="node-grid__empty">No cluster nodes configured.</div>';
            return;
        }

        let html = '';
        for (const node of nodes) {
            const statusClass = node.online ? 'online' : 'offline';
            const isPbs = node.type === 'pbs';

            html += `<div class="node-card ${statusClass}">`;
            html += `<div class="node-card__header">`;
            html += `<span class="node-card__name">${escapeHtml(node.name)}</span>`;
            html += `<span class="node-card__status-dot ${statusClass}"></span>`;
            html += `</div>`;

            html += `<div class="node-card__details">`;
            html += `<div class="node-card__row"><span class="node-card__label">IP</span><span class="node-card__value">${escapeHtml(node.ip)}</span></div>`;

            if (node.online) {
                if (!isPbs) {
                    html += `<div class="node-card__row"><span class="node-card__label">CTs</span><span class="node-card__value">${node.running_cts}/${node.total_cts} running</span></div>`;
                    html += `<div class="node-card__row"><span class="node-card__label">VMs</span><span class="node-card__value">${node.running_vms}/${node.total_vms} running</span></div>`;
                }
                if (node.uptime) {
                    html += `<div class="node-card__row"><span class="node-card__label">UPTIME</span><span class="node-card__value">${escapeHtml(node.uptime)}</span></div>`;
                }
                if (node.pve_version) {
                    const ver = node.pve_version.length > 30 ? node.pve_version.substring(0, 27) + '...' : node.pve_version;
                    html += `<div class="node-card__row"><span class="node-card__label">VERSION</span><span class="node-card__value">${escapeHtml(ver)}</span></div>`;
                }
                if (node.kernel) {
                    html += `<div class="node-card__row"><span class="node-card__label">KERNEL</span><span class="node-card__value">${escapeHtml(node.kernel)}</span></div>`;
                }
            } else {
                html += `<div class="node-card__row"><span class="node-card__label">STATUS</span><span class="node-card__value node-card__value--offline">OFFLINE</span></div>`;
            }

            html += `</div>`;

            html += `<div class="node-card__actions">`;
            if (!isPbs) {
                html += `<button class="btn btn--primary btn--sm" data-action="update" data-node="${escapeHtml(node.name)}" ${node.online ? '' : 'disabled'}>UPDATE</button>`;
                html += `<button class="btn btn--danger btn--sm" data-action="reboot" data-node="${escapeHtml(node.name)}" ${node.online ? '' : 'disabled'}>REBOOT</button>`;
            } else {
                html += `<button class="btn btn--danger btn--sm" data-action="reboot-pbs" data-node="${escapeHtml(node.name)}" ${node.online ? '' : 'disabled'}>REBOOT</button>`;
            }
            html += `</div>`;

            html += `</div>`;
        }

        dom.nodeGrid.innerHTML = html;
        bindNodeEvents();
    }

    function bindNodeEvents() {
        dom.nodeGrid.querySelectorAll('[data-action]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const action = btn.dataset.action;
                const node = btn.dataset.node;
                handleNodeAction(action, node);
            });
        });
    }

    // ---- Actions ----

    function handleNodeAction(action, node) {
        if (action === 'update') {
            showConfirm(
                `Update ${node}`,
                `Run apt dist-upgrade on ${node}? This will update system packages without rebooting.`,
                () => runNodeJob('node-update', node)
            );
        } else if (action === 'reboot') {
            showConfirm(
                `Reboot ${node}`,
                `Reboot ${node}? This will gracefully shut down all CTs/VMs, update packages, reboot, then restart all workloads.`,
                () => runNodeJob('node-reboot', node)
            );
        } else if (action === 'reboot-pbs') {
            showConfirm(
                `Reboot ${node}`,
                `Reboot ${node} (Proxmox Backup Server)? The server will be unavailable during reboot.`,
                () => runNodeJob('host-reboot', node)
            );
        }
    }

    async function runNodeJob(playbook, node) {
        try {
            const result = await api.createJob(playbook, [node]);
            await pollJobs();
            openTerminal(result.job_id);
            startJobPolling();
        } catch (err) {
            showConfirm('Error', 'Failed to start job: ' + err.message, null);
        }
    }

    async function runRollingRestart() {
        try {
            const result = await api.createJob('rolling-restart', []);
            await pollJobs();
            openTerminal(result.job_id);
            startJobPolling();
        } catch (err) {
            showConfirm('Error', 'Failed to start job: ' + err.message, null);
        }
    }

    // ---- Confirm Dialog ----

    function showConfirm(title, message, onConfirm) {
        dom.confirmTitle.textContent = title;
        dom.confirmMessage.textContent = message;
        state.pendingConfirm = onConfirm;
        dom.confirmOverlay.hidden = false;

        // Hide proceed button if this is just an error message
        dom.confirmProceed.style.display = onConfirm ? '' : 'none';
        dom.confirmCancel.textContent = onConfirm ? 'CANCEL' : 'OK';
    }

    function hideConfirm() {
        dom.confirmOverlay.hidden = true;
        state.pendingConfirm = null;
    }

    // ---- Jobs ----

    function renderJobs(jobs) {
        if (!jobs.length) {
            dom.jobsList.innerHTML = '<div class="jobs-empty">No jobs yet.</div>';
            dom.activeJobCount.textContent = '';
            return;
        }

        const active = jobs.filter(j => j.status === 'running' || j.status === 'queued').length;
        dom.activeJobCount.textContent = active > 0 ? `${active} active` : '';

        let html = '';
        for (const job of jobs) {
            const duration = formatDuration(job.started_at, job.finished_at);
            const hostCount = job.hosts ? job.hosts.length : 0;
            const hostLabel = hostCount > 0
                ? `${hostCount} host${hostCount !== 1 ? 's' : ''}`
                : 'cluster';

            html += `<div class="job-card" data-job-id="${job.id}">
                <span class="job-card__status-dot ${job.status}"></span>
                <span class="job-card__playbook">${escapeHtml(job.playbook)}</span>
                <span class="job-card__hosts">${hostLabel}</span>
                <span class="job-card__duration">${duration}</span>
                <span class="job-card__status-label ${job.status}">${job.status.toUpperCase()}</span>
            </div>`;
        }

        dom.jobsList.innerHTML = html;

        dom.jobsList.querySelectorAll('.job-card').forEach(card => {
            card.addEventListener('click', () => {
                openTerminal(card.dataset.jobId);
            });
        });
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

    // ---- Terminal ----

    function openTerminal(jobId) {
        if (state.activeSSE) {
            state.activeSSE.close();
            state.activeSSE = null;
        }

        const job = state.jobs.find(j => j.id === jobId);
        const hosts = job && job.hosts && job.hosts.length > 0
            ? job.hosts.join(', ')
            : 'cluster';
        dom.terminalTitle.textContent = job
            ? `JOB // ${job.playbook} // ${hosts}`
            : `JOB // ${jobId.substring(0, 8)}`;
        dom.terminalOutput.textContent = '';
        dom.terminalStatus.textContent = 'CONNECTING';
        dom.terminalStatus.className = 'terminal__status';
        dom.terminalOverlay.hidden = false;

        const sse = api.streamJob(jobId);
        state.activeSSE = sse;

        sse.addEventListener('open', () => {
            if (job && (job.status === 'running' || job.status === 'queued')) {
                dom.terminalStatus.textContent = 'RUNNING';
                dom.terminalStatus.className = 'terminal__status running';
            }
        });

        sse.addEventListener('output', (e) => {
            if (dom.terminalStatus.textContent === 'CONNECTING') {
                dom.terminalStatus.textContent = 'RUNNING';
                dom.terminalStatus.className = 'terminal__status running';
            }
            dom.terminalOutput.textContent += e.data + '\n';
            autoScroll();
        });

        sse.addEventListener('status', (e) => {
            try {
                const data = JSON.parse(e.data);
                dom.terminalStatus.textContent = data.status.toUpperCase();
                dom.terminalStatus.className = `terminal__status ${data.status}`;
            } catch (_) {}
        });

        sse.addEventListener('done', (e) => {
            try {
                const data = JSON.parse(e.data);
                const label = data.status === 'completed' ? 'COMPLETED' : `FAILED (rc=${data.return_code})`;
                dom.terminalStatus.textContent = label;
                dom.terminalStatus.className = `terminal__status ${data.status}`;
                dom.terminalOutput.textContent += `\n--- ${label} ---\n`;
            } catch (_) {}
            sse.close();
            state.activeSSE = null;
            pollJobs();
            loadNodes();
        });

        sse.addEventListener('error', () => {
            dom.terminalStatus.textContent = 'DISCONNECTED';
            dom.terminalStatus.className = 'terminal__status failed';
            sse.close();
            state.activeSSE = null;
        });
    }

    function autoScroll() {
        const body = dom.terminalBody;
        const isNearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
        if (isNearBottom) {
            body.scrollTop = body.scrollHeight;
        }
    }

    function closeTerminal() {
        if (state.activeSSE) {
            state.activeSSE.close();
            state.activeSSE = null;
        }
        dom.terminalOverlay.hidden = true;
    }

    // ---- Data Loading ----

    async function loadNodes() {
        try {
            const data = await api.getNodes();
            state.nodes = data.nodes || [];

            dom.connectionIndicator.className = 'top-bar__indicator connected';
            dom.connectionLabel.textContent = 'CONNECTED';
            dom.lastRefresh.textContent = new Date().toLocaleTimeString('en-GB');

            renderNodes(state.nodes);
        } catch (err) {
            dom.connectionIndicator.className = 'top-bar__indicator error';
            dom.connectionLabel.textContent = 'ERROR';
            console.error('Failed to load nodes:', err);
        }
    }

    async function pollJobs() {
        try {
            const data = await api.getJobs();
            state.jobs = data.jobs || [];
            renderJobs(state.jobs);
        } catch (err) {
            console.error('Failed to poll jobs:', err);
        }
    }

    function startJobPolling() {
        if (state.jobPollInterval) clearInterval(state.jobPollInterval);
        state.jobPollInterval = setInterval(async () => {
            await pollJobs();
            const hasActive = state.jobs.some(j => j.status === 'running' || j.status === 'queued');
            if (!hasActive) {
                clearInterval(state.jobPollInterval);
                state.jobPollInterval = null;
                loadNodes();
            }
        }, 3000);
    }

    // ---- Event Binding ----

    function bindEvents() {
        dom.refreshNodes.addEventListener('click', loadNodes);

        dom.rollingRestart.addEventListener('click', () => {
            showConfirm(
                'Rolling Update & Restart All',
                'This will update and reboot pve1, pve2, and pve3 one at a time. All CTs/VMs will be gracefully shut down and restarted on each node. This will take a while.',
                runRollingRestart
            );
        });

        dom.confirmCancel.addEventListener('click', hideConfirm);
        dom.confirmProceed.addEventListener('click', () => {
            const fn = state.pendingConfirm;
            hideConfirm();
            if (fn) fn();
        });
        dom.confirmOverlay.addEventListener('click', (e) => {
            if (e.target === dom.confirmOverlay) hideConfirm();
        });

        dom.terminalClose.addEventListener('click', closeTerminal);
        dom.terminalOverlay.addEventListener('click', (e) => {
            if (e.target === dom.terminalOverlay) closeTerminal();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (!dom.confirmOverlay.hidden) hideConfirm();
                else if (!dom.terminalOverlay.hidden) closeTerminal();
            }
        });
    }

    // ---- Utilities ----

    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ---- Init ----

    async function init() {
        bindEvents();

        await Promise.allSettled([
            loadNodes(),
            pollJobs(),
        ]);

        state.refreshInterval = setInterval(loadNodes, 30000);

        const hasActive = state.jobs.some(j => j.status === 'running' || j.status === 'queued');
        if (hasActive) startJobPolling();
    }

    init();
})();
