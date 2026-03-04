/* ============================================
   MOO-UPDATER // PATCH OPS
   Main application logic
   ============================================ */

(function () {
    'use strict';

    // ---- State ----

    const state = {
        hosts: [],
        selectedHosts: new Set(),
        playbooks: [],
        jobs: [],
        expandedHostId: null,
        activeSSE: null,
        refreshInterval: null,
        jobPollInterval: null,
    };

    // ---- API ----

    const api = {
        async getHosts() {
            const res = await fetch('/api/hosts');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        },

        async getHostPackages(hostId) {
            const res = await fetch(`/api/hosts/${hostId}/packages?updates_only=true`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        },

        async getPlaybooks() {
            const res = await fetch('/api/playbooks');
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
    const $$ = (sel) => document.querySelectorAll(sel);

    const dom = {
        connectionIndicator: $('#connectionIndicator'),
        connectionLabel: $('#connectionLabel'),
        hostCount: $('#hostCount'),
        lastRefresh: $('#lastRefresh'),
        hostTableBody: $('#hostTableBody'),
        selectAllUpdates: $('#selectAllUpdates'),
        refreshHosts: $('#refreshHosts'),
        selectedCount: $('#selectedCount'),
        playbookSelect: $('#playbookSelect'),
        runUpdate: $('#runUpdate'),
        activeJobCount: $('#activeJobCount'),
        jobsList: $('#jobsList'),
        terminalOverlay: $('#terminalOverlay'),
        terminalTitle: $('#terminalTitle'),
        terminalStatus: $('#terminalStatus'),
        terminalBody: $('#terminalBody'),
        terminalOutput: $('#terminalOutput'),
        terminalClose: $('#terminalClose'),
    };

    // ---- Host Table ----

    function renderHostTable(hosts) {
        if (!hosts.length) {
            dom.hostTableBody.innerHTML = `
                <tr><td colspan="8" style="text-align:center;padding:24px;color:var(--text-tertiary);font-family:var(--font-mono);font-size:11px;">
                    No hosts found
                </td></tr>`;
            return;
        }

        let html = '';
        for (const host of hosts) {
            const hasUpdates = host.updates_count > 0;
            const hasSecurity = host.security_updates_count > 0;
            const isExpanded = state.expandedHostId === host.id;
            const isChecked = state.selectedHosts.has(host.ansible_name);
            const canCheck = host.in_ansible;

            const statusClass = host.status === 'active' ? 'active' : (host.status === 'offline' ? 'offline' : 'unknown');
            const statusLabel = host.status || 'unknown';

            html += `<tr class="${hasUpdates ? 'has-updates' : ''} ${isExpanded ? 'row-expanded' : ''}" data-host-id="${host.id}" data-ansible-name="${host.ansible_name || ''}">`;

            // Checkbox
            html += `<td class="col-check">
                <input type="checkbox" class="row-checkbox" data-ansible-name="${host.ansible_name || ''}"
                    ${canCheck ? '' : 'disabled'} ${isChecked ? 'checked' : ''}>
            </td>`;

            // Hostname
            html += `<td class="col-host"><span class="host-name" data-host-id="${host.id}">${escapeHtml(host.friendly_name)}</span></td>`;

            // IP
            html += `<td class="col-ip"><span class="ip-addr">${escapeHtml(host.ip)}</span></td>`;

            // OS
            const osLabel = [host.os_type, host.os_version].filter(Boolean).join(' ');
            html += `<td class="col-os"><span class="os-label">${escapeHtml(osLabel)}</span></td>`;

            // Updates
            html += `<td class="col-updates"><span class="update-count ${hasUpdates ? 'has-updates' : 'zero'}">${host.updates_count}</span></td>`;

            // Security
            html += `<td class="col-security"><span class="security-badge ${hasSecurity ? 'has-security' : 'zero'}">${host.security_updates_count}</span></td>`;

            // Status
            html += `<td class="col-status"><span class="status-dot ${statusClass}">${statusLabel}</span></td>`;

            // Reboot
            html += `<td class="col-reboot"><span class="reboot-tag ${host.needs_reboot ? 'needs-reboot' : 'no-reboot'}">${host.needs_reboot ? 'YES' : '--'}</span></td>`;

            html += '</tr>';

            // Expanded package detail row
            if (isExpanded) {
                html += `<tr class="package-detail-row"><td colspan="8">
                    <div class="package-detail" id="packageDetail-${host.id}">
                        <div class="package-detail__loading">Loading packages...</div>
                    </div>
                </td></tr>`;
            }
        }

        dom.hostTableBody.innerHTML = html;
        bindHostTableEvents();

        // Load packages for expanded host
        if (state.expandedHostId) {
            loadHostPackages(state.expandedHostId);
        }
    }

    function bindHostTableEvents() {
        // Checkbox changes
        dom.hostTableBody.querySelectorAll('.row-checkbox').forEach(cb => {
            cb.addEventListener('change', (e) => {
                e.stopPropagation();
                const name = cb.dataset.ansibleName;
                if (!name) return;
                if (cb.checked) {
                    state.selectedHosts.add(name);
                } else {
                    state.selectedHosts.delete(name);
                }
                updateSelectedCount();
                updateSelectAllState();
            });
        });

        // Host name click to expand
        dom.hostTableBody.querySelectorAll('.host-name').forEach(el => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                const hostId = el.dataset.hostId;
                if (state.expandedHostId === hostId) {
                    state.expandedHostId = null;
                } else {
                    state.expandedHostId = hostId;
                }
                renderHostTable(state.hosts);
            });
        });

        // Row click for checkbox (not on name or checkbox itself)
        dom.hostTableBody.querySelectorAll('tr[data-host-id]').forEach(row => {
            row.addEventListener('click', (e) => {
                if (e.target.closest('.host-name') || e.target.closest('.row-checkbox')) return;
                const cb = row.querySelector('.row-checkbox');
                if (cb && !cb.disabled) {
                    cb.checked = !cb.checked;
                    cb.dispatchEvent(new Event('change'));
                }
            });
        });
    }

    async function loadHostPackages(hostId) {
        const container = document.getElementById(`packageDetail-${hostId}`);
        if (!container) return;

        try {
            const data = await api.getHostPackages(hostId);
            const packages = data.packages || [];

            if (!packages.length) {
                container.innerHTML = `
                    <div class="package-detail__header">
                        <span class="package-detail__title">PACKAGES WITH UPDATES</span>
                        <span class="package-detail__count">0 packages</span>
                    </div>
                    <div class="package-detail__loading">No packages with pending updates.</div>`;
                return;
            }

            let html = `
                <div class="package-detail__header">
                    <span class="package-detail__title">PACKAGES WITH UPDATES</span>
                    <span class="package-detail__count">${packages.length} package${packages.length !== 1 ? 's' : ''}</span>
                </div>
                <div class="package-list">`;

            for (const pkg of packages) {
                const isSec = pkg.is_security_update;
                html += `<div class="package-item ${isSec ? 'is-security' : ''}">
                    <span class="package-item__name">${escapeHtml(pkg.name)}</span>
                    <span class="package-item__versions">
                        ${escapeHtml(truncVersion(pkg.current_version))}
                        <span class="package-item__arrow">-></span>
                        <span class="package-item__new-ver">${escapeHtml(truncVersion(pkg.available_version))}</span>
                    </span>
                </div>`;
            }

            html += '</div>';
            container.innerHTML = html;
        } catch (err) {
            container.innerHTML = `<div class="package-detail__loading">Failed to load packages: ${escapeHtml(err.message)}</div>`;
        }
    }

    function truncVersion(v) {
        if (!v) return '?';
        return v.length > 28 ? v.substring(0, 25) + '...' : v;
    }

    // ---- Selection ----

    function updateSelectedCount() {
        const count = state.selectedHosts.size;
        dom.selectedCount.textContent = `${count} selected`;
        dom.runUpdate.disabled = count === 0 || !dom.playbookSelect.value;
        dom.playbookSelect.disabled = count === 0;
    }

    function updateSelectAllState() {
        const hostsWithUpdates = state.hosts.filter(h => h.in_ansible && h.updates_count > 0);
        const allSelected = hostsWithUpdates.length > 0 && hostsWithUpdates.every(h => state.selectedHosts.has(h.ansible_name));
        dom.selectAllUpdates.checked = allSelected;
    }

    // ---- Playbooks ----

    function renderPlaybooks(playbooks) {
        let html = '<option value="">-- select playbook --</option>';
        for (const pb of playbooks) {
            html += `<option value="${escapeHtml(pb.name)}" title="${escapeHtml(pb.description)}">${escapeHtml(pb.description)}</option>`;
        }
        dom.playbookSelect.innerHTML = html;
    }

    // ---- Jobs ----

    function renderJobs(jobs) {
        if (!jobs.length) {
            dom.jobsList.innerHTML = '<div class="jobs-empty">No jobs yet. Select hosts and run an update.</div>';
            dom.activeJobCount.textContent = '';
            return;
        }

        const active = jobs.filter(j => j.status === 'running' || j.status === 'queued').length;
        dom.activeJobCount.textContent = active > 0 ? `${active} active` : '';

        let html = '';
        for (const job of jobs) {
            const duration = formatDuration(job.started_at, job.finished_at);
            const hostCount = job.hosts ? job.hosts.length : 0;

            html += `<div class="job-card" data-job-id="${job.id}">
                <span class="job-card__status-dot ${job.status}"></span>
                <span class="job-card__playbook">${escapeHtml(job.playbook)}</span>
                <span class="job-card__hosts">${hostCount} host${hostCount !== 1 ? 's' : ''}</span>
                <span class="job-card__duration">${duration}</span>
                <span class="job-card__status-label ${job.status}">${job.status.toUpperCase()}</span>
            </div>`;
        }

        dom.jobsList.innerHTML = html;

        // Bind click events
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
        // Close existing SSE
        if (state.activeSSE) {
            state.activeSSE.close();
            state.activeSSE = null;
        }

        // Find job info
        const job = state.jobs.find(j => j.id === jobId);
        dom.terminalTitle.textContent = job
            ? `JOB // ${job.playbook} // ${(job.hosts || []).join(', ')}`
            : `JOB // ${jobId.substring(0, 8)}`;
        dom.terminalOutput.textContent = '';
        dom.terminalStatus.textContent = 'CONNECTING';
        dom.terminalStatus.className = 'terminal__status';
        dom.terminalOverlay.hidden = false;

        // Open SSE stream
        const sse = api.streamJob(jobId);
        state.activeSSE = sse;

        sse.addEventListener('output', (e) => {
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

    async function loadHosts() {
        try {
            const data = await api.getHosts();
            state.hosts = data.hosts || [];

            // Update connection indicator
            dom.connectionIndicator.className = 'top-bar__indicator connected';
            dom.connectionLabel.textContent = 'CONNECTED';
            dom.hostCount.textContent = `${state.hosts.length} hosts`;
            dom.lastRefresh.textContent = new Date().toLocaleTimeString('en-GB');

            // Clean up selected hosts that no longer exist
            const validNames = new Set(state.hosts.filter(h => h.in_ansible).map(h => h.ansible_name));
            for (const name of state.selectedHosts) {
                if (!validNames.has(name)) {
                    state.selectedHosts.delete(name);
                }
            }

            renderHostTable(state.hosts);
            updateSelectedCount();
            updateSelectAllState();
        } catch (err) {
            dom.connectionIndicator.className = 'top-bar__indicator error';
            dom.connectionLabel.textContent = 'ERROR';
            console.error('Failed to load hosts:', err);
        }
    }

    async function loadPlaybooks() {
        try {
            const data = await api.getPlaybooks();
            state.playbooks = data.playbooks || [];
            renderPlaybooks(state.playbooks);
        } catch (err) {
            console.error('Failed to load playbooks:', err);
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

    // ---- Actions ----

    async function runUpdate() {
        const playbook = dom.playbookSelect.value;
        if (!playbook || state.selectedHosts.size === 0) return;

        const hosts = Array.from(state.selectedHosts);
        dom.runUpdate.disabled = true;
        dom.runUpdate.textContent = 'STARTING...';

        try {
            const result = await api.createJob(playbook, hosts);

            // Clear selection
            state.selectedHosts.clear();
            updateSelectedCount();
            updateSelectAllState();
            renderHostTable(state.hosts);

            // Refresh jobs and open terminal
            await pollJobs();
            openTerminal(result.job_id);

            // Start faster job polling while job is running
            startJobPolling();
        } catch (err) {
            alert('Failed to start job: ' + err.message);
        } finally {
            dom.runUpdate.textContent = 'RUN UPDATE';
            dom.runUpdate.disabled = state.selectedHosts.size === 0 || !dom.playbookSelect.value;
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
                // Refresh hosts to pick up updated counts
                loadHosts();
            }
        }, 3000);
    }

    // ---- Event Binding ----

    function bindEvents() {
        dom.selectAllUpdates.addEventListener('change', () => {
            const checked = dom.selectAllUpdates.checked;
            state.hosts.forEach(h => {
                if (h.in_ansible && h.updates_count > 0) {
                    if (checked) {
                        state.selectedHosts.add(h.ansible_name);
                    } else {
                        state.selectedHosts.delete(h.ansible_name);
                    }
                }
            });
            renderHostTable(state.hosts);
            updateSelectedCount();
        });

        dom.refreshHosts.addEventListener('click', loadHosts);

        dom.playbookSelect.addEventListener('change', () => {
            dom.runUpdate.disabled = state.selectedHosts.size === 0 || !dom.playbookSelect.value;
        });

        dom.runUpdate.addEventListener('click', runUpdate);

        dom.terminalClose.addEventListener('click', closeTerminal);

        dom.terminalOverlay.addEventListener('click', (e) => {
            if (e.target === dom.terminalOverlay) closeTerminal();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !dom.terminalOverlay.hidden) {
                closeTerminal();
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

        // Load everything in parallel
        await Promise.allSettled([
            loadHosts(),
            loadPlaybooks(),
            pollJobs(),
        ]);

        // Auto-refresh hosts every 60s
        state.refreshInterval = setInterval(loadHosts, 60000);

        // Check for active jobs and start polling if needed
        const hasActive = state.jobs.some(j => j.status === 'running' || j.status === 'queued');
        if (hasActive) startJobPolling();
    }

    init();
})();
