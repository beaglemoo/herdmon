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
        updateAllPending: $('#updateAllPending'),
        remediateNfs: $('#remediateNfs'),
        activeJobCount: $('#activeJobCount'),
        jobsList: $('#jobsList'),
        terminalOverlay: $('#terminalOverlay'),
        terminalTitle: $('#terminalTitle'),
        terminalStatus: $('#terminalStatus'),
        terminalBody: $('#terminalBody'),
        terminalOutput: $('#terminalOutput'),
        terminalClose: $('#terminalClose'),
        terminalCancel: $('#terminalCancel'),
        terminalStrip: $('#terminalStrip'),
        terminalRecap: $('#terminalRecap'),
        terminalVerdict: $('#terminalVerdict'),
        stripBreadcrumb: $('#stripBreadcrumb'),
        stripElapsed: $('#stripElapsed'),
        stripTaskCount: $('#stripTaskCount'),
        stripChips: $('#stripChips'),
        stripHeartbeat: $('#stripHeartbeat'),
        filterOkLines: $('#filterOkLines'),
        verdictHeader: $('#verdictHeader'),
        verdictLabel: $('#verdictLabel'),
        verdictToggle: $('#verdictToggle'),
        verdictBody: $('#verdictBody'),
        updateAppBtn: $('#updateAppBtn'),
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
        const selectedCount = hostsWithUpdates.filter(h => state.selectedHosts.has(h.ansible_name)).length;
        const allSelected = hostsWithUpdates.length > 0 && selectedCount === hostsWithUpdates.length;
        const someSelected = selectedCount > 0 && selectedCount < hostsWithUpdates.length;
        dom.selectAllUpdates.checked = allSelected;
        dom.selectAllUpdates.indeterminate = someSelected;
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
            const timestamp = MooCommon.formatRelativeTime(job.created_at || job.started_at);
            const recapBadge = buildRecapBadge(job);

            html += `<div class="job-card" data-job-id="${job.id}">
                <span class="job-card__status-dot ${job.status}"></span>
                <span class="job-card__playbook">${escapeHtml(job.playbook)}</span>
                <span class="job-card__hosts">${hostCount} host${hostCount !== 1 ? 's' : ''}</span>
                <span class="job-card__timestamp">${timestamp}</span>
                <span class="job-card__duration">${duration}</span>
                ${recapBadge}
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

    function buildRecapBadge(job) {
        const recap = (job.verify && job.verify.recap) ? job.verify.recap : null;
        if (!recap || !Array.isArray(recap) || recap.length === 0) return '';

        const totals = recap.reduce((acc, r) => {
            acc.ok += r.ok || 0;
            acc.changed += r.changed || 0;
            acc.failed += r.failed || 0;
            acc.unreachable += r.unreachable || 0;
            return acc;
        }, { ok: 0, changed: 0, failed: 0, unreachable: 0 });

        let cls = 'recap--clean';
        if (totals.failed > 0 || totals.unreachable > 0) cls = 'recap--failed';
        else if (totals.changed > 0) cls = 'recap--changed';

        return `<span class="job-card__recap ${cls}">ok=${totals.ok} changed=${totals.changed}${totals.failed > 0 ? ` failed=${totals.failed}` : ''}</span>`;
    }

    // ---- Terminal ----

    let _termParser = null;
    let _elapsedTimer = null;
    let _heartbeatTimer = null;
    let _termStartedAt = null;
    let _currentJobId = null;
    let _filterActive = false;
    let _rawLines = [];
    let _verdictCollapsed = false;

    function resetTerminalStrip() {
        dom.terminalStrip.hidden = true;
        dom.terminalRecap.hidden = true;
        dom.terminalVerdict.hidden = true;
        dom.terminalCancel.hidden = true;
        dom.stripBreadcrumb.textContent = '';
        dom.stripElapsed.textContent = '';
        dom.stripTaskCount.textContent = '';
        dom.stripChips.innerHTML = '';
        dom.stripHeartbeat.hidden = true;
        dom.verdictBody.hidden = false;
        dom.verdictToggle.classList.remove('collapsed');
        _verdictCollapsed = false;
        clearInterval(_elapsedTimer);
        clearInterval(_heartbeatTimer);
        _elapsedTimer = null;
        _heartbeatTimer = null;
        _termStartedAt = null;
        _rawLines = [];
        _filterActive = false;
        if (dom.filterOkLines) dom.filterOkLines.checked = false;
        if (_termParser) _termParser.reset();
        _termParser = AnsibleParser.createParser();
    }

    function startElapsedTimer() {
        clearInterval(_elapsedTimer);
        _elapsedTimer = setInterval(() => {
            if (!_termStartedAt) return;
            const s = Math.floor((Date.now() - _termStartedAt) / 1000);
            const mm = String(Math.floor(s / 60)).padStart(2, '0');
            const ss = String(s % 60).padStart(2, '0');
            dom.stripElapsed.textContent = `${mm}:${ss}`;
        }, 1000);
    }

    function resetHeartbeat() {
        clearInterval(_heartbeatTimer);
        dom.stripHeartbeat.hidden = true;
        _heartbeatTimer = setInterval(() => {
            dom.stripHeartbeat.hidden = false;
        }, 10000);
    }

    function updateStripFromParser() {
        const s = _termParser.getState();
        if (s.currentPlay || s.currentTask) {
            dom.terminalStrip.hidden = false;
            let bc = '';
            if (s.currentPlay) bc += `<span class="play-name">${escapeHtml(s.currentPlay)}</span>`;
            if (s.currentTask) bc += ` › <span class="task-name">${escapeHtml(s.currentTask)}</span>`;
            dom.stripBreadcrumb.innerHTML = bc;
        }
        if (s.taskCount > 0) {
            dom.stripTaskCount.textContent = `TASK ${s.taskCount}`;
        }
        updateChips(s.hostStatuses);
    }

    function updateChips(hostStatuses) {
        const existing = {};
        dom.stripChips.querySelectorAll('.host-chip').forEach(c => {
            existing[c.dataset.host] = c;
        });

        for (const [host, status] of Object.entries(hostStatuses)) {
            if (existing[host]) {
                existing[host].className = `host-chip status-${status}`;
            } else {
                const chip = document.createElement('span');
                chip.className = `host-chip status-${status}`;
                chip.dataset.host = host;
                chip.innerHTML = `<span class="host-chip__dot"></span><span class="host-chip__name">${escapeHtml(host)}</span>`;
                dom.stripChips.appendChild(chip);
            }
        }
    }

    function renderRecapCard(recap) {
        dom.terminalRecap.hidden = false;
        let html = '<div class="recap-card__title">PLAY RECAP</div><div class="recap-card__rows">';
        for (const row of recap) {
            let cls = 'recap--clean';
            if (row.failed > 0 || row.unreachable > 0) cls = 'recap--failed';
            else if (row.changed > 0) cls = 'recap--changed';

            html += `<div class="recap-row ${cls}">
                <span class="recap-row__host">${escapeHtml(row.host)}</span>
                <span class="recap-row__stat stat-ok">ok=${row.ok}</span>
                <span class="recap-row__stat stat-changed">changed=${row.changed}</span>
                <span class="recap-row__stat stat-failed">failed=${row.failed}</span>
                <span class="recap-row__stat">unreachable=${row.unreachable}</span>
                <span class="recap-row__stat">skipped=${row.skipped}</span>
            </div>`;
        }
        html += '</div>';
        dom.terminalRecap.innerHTML = html;
    }

    function renderVerdictPanel(data) {
        const status = (data.status || 'unavailable').toLowerCase();
        const verdictMap = { ok: 'verdict--ok', degraded: 'verdict--degraded', fail: 'verdict--fail', unavailable: 'verdict--unavailable' };
        const cls = verdictMap[status] || 'verdict--unavailable';
        const labelMap = { ok: 'AI VERDICT: OK', degraded: 'AI VERDICT: DEGRADED', fail: 'AI VERDICT: FAIL', unavailable: 'AI VERDICT: UNAVAILABLE' };

        dom.verdictHeader.className = `verdict__header ${cls}`;
        dom.verdictLabel.textContent = labelMap[status] || 'AI VERDICT';
        dom.terminalVerdict.hidden = false;

        let html = '';
        if (data.error) {
            html = `<div class="verdict__summary">${escapeHtml(data.error)}</div>`;
        } else {
            if (data.summary) html += `<div class="verdict__summary">${escapeHtml(data.summary)}</div>`;
            if (data.checks && typeof data.checks === 'object') {
                html += '<table class="verdict__checks">';
                for (const [k, v] of Object.entries(data.checks)) {
                    const vs = String(v).toLowerCase();
                    const vCls = vs === 'ok' || vs === 'pass' ? 'check--ok' : (vs === 'fail' || vs === 'failed' ? 'check--fail' : 'check--warn');
                    html += `<tr><td>${escapeHtml(k)}</td><td class="${vCls}">${escapeHtml(String(v))}</td></tr>`;
                }
                html += '</table>';
            }
            if (data.concerns && Array.isArray(data.concerns) && data.concerns.length) {
                html += '<ul class="verdict__concerns">';
                for (const c of data.concerns) html += `<li>${escapeHtml(c)}</li>`;
                html += '</ul>';
            }
            if (data.actions && Array.isArray(data.actions) && data.actions.length) {
                html += '<div class="verdict__section-label">Proposed remediations:</div>';
                html += '<ul class="verdict__actions">';
                for (const a of data.actions) {
                    const targets = Array.isArray(a.targets) ? a.targets.join(', ') : '';
                    html += `<li><span class="verdict__action-type">${escapeHtml(a.type)}</span>: ${escapeHtml(targets)} &mdash; ${escapeHtml(a.reason || '')}</li>`;
                }
                html += '</ul>';
            }
            if (data.fired_actions && Array.isArray(data.fired_actions) && data.fired_actions.length) {
                html += '<div class="verdict__section-label">Auto-remediation fired:</div>';
                html += '<ul class="verdict__actions verdict__actions--fired">';
                for (const fa of data.fired_actions) {
                    const targets = Array.isArray(fa.targets) ? fa.targets.join(', ') : '';
                    html += `<li><span class="verdict__action-type">${escapeHtml(fa.type)}</span>: ${escapeHtml(targets)}`;
                    if (fa.job_id) {
                        html += ` <button class="verdict__job-link" data-job-id="${escapeHtml(fa.job_id)}">[view job]</button>`;
                    }
                    html += '</li>';
                }
                html += '</ul>';
            }
            if (!data.summary && !data.checks && !data.concerns && !data.actions && !data.fired_actions) {
                html = `<pre style="font-size:10px;color:var(--text-tertiary)">${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
            }
        }
        dom.verdictBody.innerHTML = html;

        // Wire view-job links in verdict
        dom.verdictBody.querySelectorAll('.verdict__job-link[data-job-id]').forEach(btn => {
            btn.addEventListener('click', () => {
                openTerminal(btn.dataset.jobId);
            });
        });
    }

    function applyLineFilter() {
        const lines = _rawLines;
        if (!dom.filterOkLines || !dom.filterOkLines.checked) {
            dom.terminalOutput.textContent = lines.join('\n');
        } else {
            dom.terminalOutput.textContent = lines.filter(l => !/^ok:\s/.test(l)).join('\n');
        }
    }

    function appendOutputLine(line) {
        _rawLines.push(line);
        if (dom.filterOkLines && dom.filterOkLines.checked && /^ok:\s/.test(line)) {
            return;
        }
        const body = dom.terminalBody;
        const wasAtBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
        dom.terminalOutput.textContent += line + '\n';
        if (wasAtBottom) {
            requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
        }
    }

    function openTerminal(jobId) {
        if (state.activeSSE) {
            state.activeSSE.close();
            state.activeSSE = null;
        }

        _currentJobId = jobId;
        resetTerminalStrip();

        const job = state.jobs.find(j => j.id === jobId);
        dom.terminalTitle.textContent = job
            ? `JOB // ${job.playbook} // ${(job.hosts || []).join(', ')}`
            : `JOB // ${jobId.substring(0, 8)}`;
        dom.terminalOutput.textContent = '';
        dom.terminalStatus.textContent = 'CONNECTING';
        dom.terminalStatus.className = 'terminal__status';
        dom.terminalOverlay.hidden = false;
        dom.terminalClose.focus();

        // Restore verdict from job object if already complete
        if (job && job.verify) {
            renderVerdictPanel(job.verify);
        }

        const sse = api.streamJob(jobId);
        state.activeSSE = sse;

        const isActive = job && (job.status === 'running' || job.status === 'queued');
        if (isActive) {
            dom.terminalCancel.hidden = false;
            dom.terminalCancel.disabled = false;
        }

        sse.addEventListener('open', () => {
            if (job && (job.status === 'running' || job.status === 'queued')) {
                dom.terminalStatus.textContent = 'RUNNING';
                dom.terminalStatus.className = 'terminal__status running';
                _termStartedAt = job.started_at ? new Date(job.started_at).getTime() : Date.now();
                startElapsedTimer();
                resetHeartbeat();
            }
        });

        sse.addEventListener('output', (e) => {
            if (dom.terminalStatus.textContent === 'CONNECTING') {
                dom.terminalStatus.textContent = 'RUNNING';
                dom.terminalStatus.className = 'terminal__status running';
                if (!_termStartedAt) _termStartedAt = Date.now();
                startElapsedTimer();
            }
            resetHeartbeat();

            const line = e.data;
            appendOutputLine(line);

            const parsed = _termParser.feed(line);
            if (parsed) {
                updateStripFromParser();
                if (parsed.type === 'recap_row') {
                    const s = _termParser.getState();
                    renderRecapCard(s.recap);
                }
            }
        });

        sse.addEventListener('status', (e) => {
            try {
                const data = JSON.parse(e.data);
                dom.terminalStatus.textContent = data.status.toUpperCase();
                dom.terminalStatus.className = `terminal__status ${data.status}`;
            } catch (_) {}
        });

        sse.addEventListener('done', (e) => {
            clearInterval(_elapsedTimer);
            clearInterval(_heartbeatTimer);
            dom.stripHeartbeat.hidden = true;
            dom.terminalCancel.hidden = true;

            try {
                const data = JSON.parse(e.data);
                let label;
                if (data.status === 'completed') {
                    label = 'COMPLETED';
                } else if (data.status === 'cancelled') {
                    label = data.cancel_reason ? `CANCELLED (${data.cancel_reason})` : 'CANCELLED';
                } else {
                    label = `FAILED (rc=${data.return_code})`;
                }
                dom.terminalStatus.textContent = label;
                dom.terminalStatus.className = `terminal__status ${data.status}`;
                appendOutputLine(`\n--- ${label} ---`);
                MooCommon.sendNotification('Herdmon', `${job ? job.playbook : jobId} — ${label}`);
            } catch (_) {}
            sse.close();
            state.activeSSE = null;
            pollJobs();
        });

        sse.addEventListener('verify_report', (e) => {
            try {
                const data = JSON.parse(e.data);
                renderVerdictPanel(data);
            } catch (_) {}
        });

        sse.addEventListener('error', () => {
            clearInterval(_elapsedTimer);
            clearInterval(_heartbeatTimer);
            dom.terminalStatus.textContent = 'DISCONNECTED';
            dom.terminalStatus.className = 'terminal__status failed';
            dom.terminalCancel.hidden = true;
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
        clearInterval(_elapsedTimer);
        clearInterval(_heartbeatTimer);
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
            updatePendingButton();
        } catch (err) {
            dom.connectionIndicator.className = 'top-bar__indicator error';
            dom.connectionLabel.textContent = 'ERROR';
            console.error('Failed to load hosts:', err);
        }
    }

    function getPendingHosts() {
        return state.hosts.filter(h => h.in_ansible && h.updates_count > 0);
    }

    function updatePendingButton() {
        const pending = getPendingHosts();
        dom.updateAllPending.disabled = pending.length === 0;
        if (pending.length > 0) {
            dom.updateAllPending.textContent = `UPDATE ALL PENDING (${pending.length})`;
        } else {
            dom.updateAllPending.textContent = 'UPDATE ALL PENDING';
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
            MooCommon.showConfirm('Error', 'Failed to start job: ' + err.message, null);
        } finally {
            dom.runUpdate.textContent = 'RUN UPDATE';
            dom.runUpdate.disabled = state.selectedHosts.size === 0 || !dom.playbookSelect.value;
        }
    }

    async function updateAllPending() {
        const pending = getPendingHosts();
        if (pending.length === 0) return;

        const hosts = pending.map(h => h.ansible_name);

        async function doUpdateAll() {
            dom.updateAllPending.disabled = true;
            dom.updateAllPending.textContent = 'STARTING...';
            try {
                const result = await api.createJob('update-all-pending', hosts);
                state.selectedHosts.clear();
                updateSelectedCount();
                updateSelectAllState();
                renderHostTable(state.hosts);
                await pollJobs();
                openTerminal(result.job_id);
                startJobPolling();
            } catch (err) {
                MooCommon.showConfirm('Error', 'Failed to start job: ' + err.message, null);
            } finally {
                updatePendingButton();
            }
        }

        MooCommon.showConfirm(
            'Update All Pending',
            `Run updates on ${pending.length} host${pending.length !== 1 ? 's' : ''}? This may take a while.`,
            doUpdateAll,
            { proceedClass: 'btn--warning' }
        );
    }

    async function doRemediateNfs() {
        try {
            const result = await api.createJob('remediate-nfs', []);
            await pollJobs();
            openTerminal(result.job_id);
            startJobPolling();
        } catch (err) {
            MooCommon.showConfirm('Error', 'Failed to start remediate-nfs job: ' + err.message, null);
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
        MooCommon.initConfirmModal();

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

        dom.updateAllPending.addEventListener('click', updateAllPending);

        dom.remediateNfs.addEventListener('click', () => {
            MooCommon.showConfirm(
                'Remediate NFS',
                'Remount NFS on 6 clients (paperless, nzbget, sonarr-hd, sonarr-4k, radarr, plex-lxc) and kick their services?',
                doRemediateNfs
            );
        });

        dom.updateAppBtn.addEventListener('click', () => {
            MooCommon.showConfirm(
                'Self-update Herdmon',
                'This will git pull and restart the service. Your connection may drop briefly.',
                triggerUpdateApp,
                { proceedClass: 'btn--warning' }
            );
        });

        dom.terminalClose.addEventListener('click', closeTerminal);

        dom.terminalCancel.addEventListener('click', async () => {
            if (!_currentJobId) return;
            dom.terminalCancel.disabled = true;
            try {
                await fetch(`/api/jobs/${_currentJobId}/cancel`, { method: 'POST' });
            } catch (_) {}
        });

        if (dom.filterOkLines) {
            dom.filterOkLines.addEventListener('change', applyLineFilter);
        }

        dom.verdictToggle.addEventListener('click', () => {
            _verdictCollapsed = !_verdictCollapsed;
            dom.verdictBody.hidden = _verdictCollapsed;
            dom.verdictToggle.classList.toggle('collapsed', _verdictCollapsed);
        });

        dom.terminalOverlay.addEventListener('click', (e) => {
            if (e.target === dom.terminalOverlay) closeTerminal();
        });

        // Focus trap inside terminal
        dom.terminalOverlay.addEventListener('keydown', (e) => {
            if (dom.terminalOverlay.hidden) return;
            if (e.key !== 'Tab') return;
            const focusable = Array.from(dom.terminalOverlay.querySelectorAll('button:not([disabled]):not([hidden])'));
            if (!focusable.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault(); last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault(); first.focus();
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const confirmOverlay = document.getElementById('confirmOverlay');
                if (confirmOverlay && !confirmOverlay.hidden) { MooCommon.hideConfirm(); return; }
                if (!dom.terminalOverlay.hidden) closeTerminal();
            }
        });
    }

    // ---- Version check / UPDATE APP ----

    async function checkAppVersion() {
        try {
            const res = await fetch('/api/app/version');
            if (!res.ok) return;
            const data = await res.json();
            if (data.behind) {
                dom.updateAppBtn.classList.add('has-update');
            } else {
                dom.updateAppBtn.classList.remove('has-update');
            }
        } catch (_) {}
    }

    async function triggerUpdateApp() {
        try {
            const result = await api.createJob('update-herdmon', []);
            await pollJobs();
            openTerminal(result.job_id);
            startJobPolling();
        } catch (err) {
            MooCommon.showConfirm('Error', 'Failed to start update: ' + err.message, null);
        }
    }

    // ---- Utilities ----

    const escapeHtml = MooCommon.escapeHtml;
    const formatDuration = MooCommon.formatDuration;

    // ---- Init ----

    async function init() {
        bindEvents();

        await Promise.allSettled([
            loadHosts(),
            loadPlaybooks(),
            pollJobs(),
        ]);

        state.refreshInterval = setInterval(loadHosts, 60000);
        checkAppVersion();
        setInterval(checkAppVersion, 5 * 60 * 1000);
        MooCommon.requestNotificationPermission();

        const hasActive = state.jobs.some(j => j.status === 'running' || j.status === 'queued');
        if (hasActive) startJobPolling();
    }

    init();
})();
