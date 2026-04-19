/* ============================================
   MOO-UPDATER // ANSIBLE OUTPUT PARSER
   Parses ansible-playbook default stdout format
   ============================================ */

(function () {
    'use strict';

    const RE_PLAY   = /^PLAY \[(.+?)\]/;
    const RE_TASK   = /^TASK \[(.+?)\]/;
    const RE_HOST   = /^(ok|changed|skipping|failed|fatal|unreachable):\s+\[([^\]]+)\]/;
    const RE_RECAP_START = /^PLAY RECAP/;
    const RE_RECAP_ROW   = /^(\S+)\s*:\s*ok=(\d+)\s+changed=(\d+)\s+unreachable=(\d+)\s+failed=(\d+)(?:\s+skipped=(\d+))?(?:\s+rescued=(\d+))?(?:\s+ignored=(\d+))?/;

    function createParser() {
        let currentPlay    = '';
        let currentTask    = '';
        let taskCount      = 0;
        let hostStatuses   = {};  // host -> most recent status string
        let recap          = [];  // list of {host, ok, changed, unreachable, failed, skipped}
        let _inRecap       = false;

        function feed(line) {
            if (RE_PLAY.test(line)) {
                const m = line.match(RE_PLAY);
                currentPlay = m[1];
                _inRecap = false;
                return { type: 'play', play: currentPlay };
            }

            if (RE_TASK.test(line)) {
                const m = line.match(RE_TASK);
                currentTask = m[1];
                taskCount++;
                return { type: 'task', task: currentTask, taskCount };
            }

            if (RE_RECAP_START.test(line)) {
                _inRecap = true;
                return { type: 'recap_start' };
            }

            if (_inRecap && RE_RECAP_ROW.test(line)) {
                const m = line.match(RE_RECAP_ROW);
                const row = {
                    host:        m[1],
                    ok:          parseInt(m[2], 10),
                    changed:     parseInt(m[3], 10),
                    unreachable: parseInt(m[4], 10),
                    failed:      parseInt(m[5], 10),
                    skipped:     parseInt(m[6] || '0', 10),
                    rescued:     parseInt(m[7] || '0', 10),
                    ignored:     parseInt(m[8] || '0', 10),
                };
                recap.push(row);
                return { type: 'recap_row', row };
            }

            if (RE_HOST.test(line)) {
                const m = line.match(RE_HOST);
                const status = m[1];
                const host   = m[2];
                hostStatuses[host] = status;
                return { type: 'host_status', host, status };
            }

            return null;
        }

        function reset() {
            currentPlay  = '';
            currentTask  = '';
            taskCount    = 0;
            hostStatuses = {};
            recap        = [];
            _inRecap     = false;
        }

        function getState() {
            return { currentPlay, currentTask, taskCount, hostStatuses, recap };
        }

        return { feed, reset, getState };
    }

    window.AnsibleParser = { createParser };
})();
