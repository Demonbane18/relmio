# Native Windows skip coverage

2026-10-10 latest default native gate: 1,823 total, 1,719 passed, 0 failed, **104 skipped**. These are test-defined reason buckets, not successful Windows integrations. Earlier checkpoint counts are historical.

| Declared reason bucket | Count |
|---|---:|
| Model-check store Linux/POSIX filesystem contract | 18 |
| Codex image store Linux/POSIX filesystem contract | 17 |
| Request-count store Linux/POSIX filesystem contract | 12 |
| Executable fake-Docker boundary requires POSIX shell | 6 |
| Fresh-session Linux file ownership | 3 |
| Linux PID-namespace leases | 3 |
| Remote VPS /bin/sh without opted-in shell | 3 |
| Actual Windows file symlink creation denied EPERM | 2 |
| NTFS has no POSIX ACL model | 1 |
| POSIX mode/readability requires Linux | 1 |
| POSIX owner/mode unsupported on NTFS | 1 |
| POSIX permission enforcement unavailable on Windows | 1 |
| Linux-container start.sh needs POSIX shell | 1 |
| Remote Linux guard executable boundary | 1 |
| Linux initializer shell | 1 |
| SKIP without an explicit output reason | 33 |
| **Total** | **104** |

The 33 unnamed-reason cases include symlinked installed CLI; installed/portable curl, checksum and TTY fixtures (including Git Bash); POSIX private-control and guide-file ownership/FIFO/mode checks; remote-build lease/lock/cleanup invariants; and linked checkpoint review/upload guards. Read their source gating before selecting a compatible environment. Do not weaken security assertions to raise the pass count.

The [full 104-case index](skipped-test-index.md) preserves each actual skipped test title and printed reason (or explicit SKIP with no supplied reason).

Two file-symlink cases remain unverified on this host. Actual NTFS directory junction rejection and SSH hardlink checks execute and pass separately. No Developer Mode or security setting changed.

The Git Bash case additionally passed outside the default aggregate with the verified installed C:\Program Files (x86)\Git\bin\bash.exe: one native hidden-terminal fixture passed, zero failed/skipped. It uses a synthetic archive/npm child, so it does not establish authentic hosted downloads or default-browser acceptance. An earlier wrong assumed shell path timed out; that was harness setup, not a Relmio bug. Default aggregate remains 104 skips.

Linux-container tests on this Windows Docker host can supplement POSIX coverage but must be labelled Linux-container, not native NTFS. The aggregate does not establish authenticated providers/images, Gmail/Drive, ngrok or Hostinger integration.
