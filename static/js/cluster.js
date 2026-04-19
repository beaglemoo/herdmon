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
                html += `<button class="btn btn--warning btn--sm" data-action="update" data-node="${escapeHtml(node.name)}" ${node.online ? '' : 'disabled'}>UPDATE</button>`;
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
                () => runNodeJob('node-update', node),
                { proceedClass: 'btn--warning' }
            );
        } else if (action === 'reboot') {
            showConfirm(
                `Reboot ${node}`,
                `Reboot ${node}? This will gracefully shut down all CTs/VMs, update packages, reboot, then restart all workloads.`,
                () => runNodeJob('node-reboot', node),
                { proceedClass: 'btn--danger' }
            );
        } else if (action === 'reboot-pbs') {
            showConfirm(
                `Reboot ${node}`,
                `Reboot ${node} (Proxmox Backup Server)? The server will be unavailable during reboot.`,
                () => runNodeJob('host-reboot', node),
                { proceedClass: 'btn--danger' }
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

    const showConfirm = MooCommon.showConfirm;
    const hideConfirm = MooCommon.hideConfirm;

    // ---- Jobs ----

    function buildRecapBadge(job) {
        const recap = (job.verify && job.verify.recap) ? job.verify.recap : null;
        if (!recap || !Array.isArray(recap) || recap.length === 0) return '';
        const totals = recap.reduce((acc, r) => {
            acc.ok += r.ok || 0; acc.changed += r.changed || 0;
            acc.failed += r.failed || 0; acc.unreachable += r.unreachable || 0;
            return acc;
        }, { ok: 0, changed: 0, failed: 0, unreachable: 0 });
        let cls = 'recap--clean';
        if (totals.failed > 0 || totals.unreachable > 0) cls = 'recap--failed';
        else if (totals.changed > 0) cls = 'recap--changed';
        return `<span class="job-card__recap ${cls}">ok=${totals.ok} changed=${totals.changed}${totals.failed > 0 ? ` failed=${totals.failed}` : ''}</span>`;
    }

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
            const hostLabel = hostCount > 0 ? `${hostCount} host${hostCount !== 1 ? 's' : ''}` : 'cluster';
            const timestamp = MooCommon.formatRelativeTime(job.created_at || job.started_at);
            const recapBadge = buildRecapBadge(job);

            html += `<div class="job-card" data-job-id="${job.id}">
                <span class="job-card__status-dot ${job.status}"></span>
                <span class="job-card__playbook">${escapeHtml(job.playbook)}</span>
                <span class="job-card__hosts">${hostLabel}</span>
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

    // ---- Terminal ----

    let _termParser = null;
    let _elapsedTimer = null;
    let _heartbeatTimer = null;
    let _termStartedAt = null;
    let _currentJobId = null;
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
        _heartbeatTimer = setInterval(() => { dom.stripHeartbeat.hidden = false; }, 10000);
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
        if (s.taskCount > 0) dom.stripTaskCount.textContent = `TASK ${s.taskCount}`;
        updateChips(s.hostStatuses);
    }

    function updateChips(hostStatuses) {
        const existing = {};
        dom.stripChips.querySelectorAll('.host-chip').forEach(c => { existing[c.dataset.host] = c; });
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
            if (!data.summary && !data.checks && !data.concerns) {
                html = `<pre style="font-size:10px;color:var(--text-tertiary)">${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
            }
        }
        dom.verdictBody.innerHTML = html;
    }

    function applyLineFilter() {
        if (!dom.filterOkLines || !dom.filterOkLines.checked) {
            dom.terminalOutput.textContent = _rawLines.join('\n');
        } else {
            dom.terminalOutput.textContent = _rawLines.filter(l => !/^ok:\s/.test(l)).join('\n');
        }
    }

    function appendOutputLine(line) {
        _rawLines.push(line);
        if (dom.filterOkLines && dom.filterOkLines.checked && /^ok:\s/.test(line)) return;
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
        const hosts = job && job.hosts && job.hosts.length > 0 ? job.hosts.join(', ') : 'cluster';
        dom.terminalTitle.textContent = job
            ? `JOB // ${job.playbook} // ${hosts}`
            : `JOB // ${jobId.substring(0, 8)}`;
        dom.terminalOutput.textContent = '';
        dom.terminalStatus.textContent = 'CONNECTING';
        dom.terminalStatus.className = 'terminal__status';
        dom.terminalOverlay.hidden = false;
        dom.terminalClose.focus();

        if (job && job.verify) renderVerdictPanel(job.verify);

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
                if (parsed.type === 'recap_row') renderRecapCard(_termParser.getState().recap);
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
                if (data.status === 'completed') label = 'COMPLETED';
                else if (data.status === 'cancelled') label = data.cancel_reason ? `CANCELLED (${data.cancel_reason})` : 'CANCELLED';
                else label = `FAILED (rc=${data.return_code})`;
                dom.terminalStatus.textContent = label;
                dom.terminalStatus.className = `terminal__status ${data.status}`;
                appendOutputLine(`\n--- ${label} ---`);
                MooCommon.sendNotification('Herdmon', `${job ? job.playbook : jobId} — ${label}`);
            } catch (_) {}
            sse.close();
            state.activeSSE = null;
            pollJobs();
            loadNodes();
        });

        sse.addEventListener('verify_report', (e) => {
            try { renderVerdictPanel(JSON.parse(e.data)); } catch (_) {}
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
        if (isNearBottom) body.scrollTop = body.scrollHeight;
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
            showConfirm('Error', 'Failed to start update: ' + err.message, null);
        }
    }

    // ---- Event Binding ----

    function bindEvents() {
        MooCommon.initConfirmModal();

        dom.refreshNodes.addEventListener('click', loadNodes);

        dom.rollingRestart.addEventListener('click', () => {
            const nodeNames = state.nodes.map(n => n.name).join(', ') || 'all nodes';
            showConfirm(
                'Rolling Update & Restart All',
                `This will update and reboot ${nodeNames} one at a time. All CTs/VMs will be gracefully shut down and restarted on each node. This will take a while.`,
                runRollingRestart,
                { proceedClass: 'btn--danger' }
            );
        });

        dom.updateAppBtn.addEventListener('click', () => {
            showConfirm(
                'Self-update Herdmon',
                'This will git pull and restart the service. Your connection may drop briefly.',
                triggerUpdateApp,
                { proceedClass: 'btn--warning' }
            );
        });

        dom.terminalCancel.addEventListener('click', async () => {
            if (!_currentJobId) return;
            dom.terminalCancel.disabled = true;
            try { await fetch(`/api/jobs/${_currentJobId}/cancel`, { method: 'POST' }); } catch (_) {}
        });

        if (dom.filterOkLines) {
            dom.filterOkLines.addEventListener('change', applyLineFilter);
        }

        dom.verdictToggle.addEventListener('click', () => {
            _verdictCollapsed = !_verdictCollapsed;
            dom.verdictBody.hidden = _verdictCollapsed;
            dom.verdictToggle.classList.toggle('collapsed', _verdictCollapsed);
        });

        dom.terminalClose.addEventListener('click', closeTerminal);
        dom.terminalOverlay.addEventListener('click', (e) => {
            if (e.target === dom.terminalOverlay) closeTerminal();
        });

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
                if (confirmOverlay && !confirmOverlay.hidden) { hideConfirm(); return; }
                if (!dom.terminalOverlay.hidden) closeTerminal();
            }
        });
    }

    // ---- Utilities ----

    const escapeHtml = MooCommon.escapeHtml;
    const formatDuration = MooCommon.formatDuration;

    // ---- Init ----

    async function init() {
        bindEvents();

        await Promise.allSettled([
            loadNodes(),
            pollJobs(),
        ]);

        state.refreshInterval = setInterval(loadNodes, 30000);
        checkAppVersion();
        setInterval(checkAppVersion, 5 * 60 * 1000);

        const hasActive = state.jobs.some(j => j.status === 'running' || j.status === 'queued');
        if (hasActive) startJobPolling();
    }

    init();
})();
