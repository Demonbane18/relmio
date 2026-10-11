# Exact native skipped-test index

Observed default gate: 2026-10-10, main `2a112767aa857bf359d51db1b6f950b21a80c81b` plus the local QA diff, 1,823 tests, 1,719 pass, 0 fail, 104 skip. This is the full skipped-test ledger from the saved native run, not a pass list. [Reason buckets](skipped-tests.md) distinguish Linux/POSIX and Windows file-symlink limitations. When a test supplies no printed reason, it remains explicitly unspecified; no Windows success is inferred.

1. a symlinked installed CLI runs the version command # SKIP
2. device sign-in saves one images session and returns no secrets # the Codex images store exists only in the Linux sidecar container; NTFS has no POSIX modes
3. polling honours the 5 s floor and keeps the pending sign-in until it succeeds # the Codex images store exists only in the Linux sidecar container; NTFS has no POSIX modes
4. declined and expired sign-ins end in off and clear the pending code # the Codex images store exists only in the Linux sidecar container; NTFS has no POSIX modes
5. starting again replaces the pending sign-in and cancel clears it # the Codex images store exists only in the Linux sidecar container; NTFS has no POSIX modes
6. a 404 on the device code request means device code sign-in is off; other start failures stay generic # the Codex images store exists only in the Linux sidecar container; NTFS has no POSIX modes
7. refresh persists in-flight first, then stores the rotated pair # the Codex images store exists only in the Linux sidecar container; NTFS has no POSIX modes
8. lease sends residency only from a valid claim # the Codex images store exists only in the Linux sidecar container; NTFS has no POSIX modes
9. refresh answers that need a new sign-in mark reauthorize and never retry the token # the Codex images store exists only in the Linux sidecar container; NTFS has no POSIX modes
10. a transport error or unreadable answer after sending never replays the refresh token # the Codex images store exists only in the Linux sidecar container; NTFS has no POSIX modes
11. other refresh errors restore the session so a later lease can retry # the Codex images store exists only in the Linux sidecar container; NTFS has no POSIX modes
12. a session left in-flight by a crash requires a new sign-in # the Codex images store exists only in the Linux sidecar container; NTFS has no POSIX modes
13. the lock excludes other work and is replaced only when stale # the Codex images store exists only in the Linux sidecar container; NTFS has no POSIX modes
14. concurrent leases refresh the token once # the Codex images store exists only in the Linux sidecar container; NTFS has no POSIX modes
15. storage refuses symlinks, hard links and loose permissions # the Codex images store exists only in the Linux sidecar container; NTFS has no POSIX modes
16. sign-out clears local state even when revocation fails # the Codex images store exists only in the Linux sidecar container; NTFS has no POSIX modes
17. sign-out also removes leftover temp records but never follows links or touches other names # the Codex images store exists only in the Linux sidecar container; NTFS has no POSIX modes
18. the CLI prints one JSON line per command and never a secret # the Codex images store exists only in the Linux sidecar container; NTFS has no POSIX modes
19. startup script exits 1 without echoing a short secret # start.sh is a Linux container POSIX script; native Windows has no sh unless absolute RELMIO_TEST_POSIX_SHELL is set.
20. curl installer reuses an installed Node 24 runtime # SKIP
21. curl installer explains when no controlling terminal is available # SKIP
22. curl installer gives an installed runtime its controlling terminal after a piped shell handoff # SKIP
23. curl installer gives a portable runtime its controlling terminal after a piped shell handoff # SKIP
24. curl installer downloads, verifies, and removes a temporary Node runtime # SKIP
25. curl installer gives Git Bash a temporary Windows Node runtime even with installed Node 24 # SKIP
26. curl installer refuses a temporary Node runtime with the wrong checksum # SKIP
27. legacy and replacement child links reject without changing outside inode # the guard is a remote Linux /bin/sh script over Linux paths
28. the counts the running sidecar wrote come back as its usage command prints them # the request count store exists only in the Linux sidecar container; NTFS has no POSIX modes
29. unsafe publication permissions # SKIP
30. inspection rejects symlinked control files # SKIP
31. POSIX inspection rejects otherwise-private files owned by another account # SKIP
32. POSIX refuses a custom Relmio root beneath a non-sticky group-writable parent # SKIP
33. POSIX # POSIX owner-mode checks cannot pass on NTFS
34. the counts the running sidecar wrote come back as its usage command prints them # the request count store exists only in the Linux sidecar container; NTFS has no POSIX modes
35. generated credential initializer obeys root plus CHOWN-only ownership model # the initializer runs only under the Linux container's /bin/sh
36. every file the image copies is readable by the node user that runs it # POSIX modes decide readability inside the Linux image
37. processes share one npm check through the store, except a check dated in the future # the model-check store exists only in the Linux sidecar container; NTFS has no POSIX modes
38. status reads the last shared npm check as it is and writes nothing; listing still makes the 12 h check # the model-check store exists only in the Linux sidecar container; NTFS has no POSIX modes
39. a failure hides a model by its source and the mode, and status rows say what n8n lists # the model-check store exists only in the Linux sidecar container; NTFS has no POSIX modes
40. with checks on, n8n keeps the full list until a model answers, from one background run that listing never awaits # the model-check store exists only in the Linux sidecar container; NTFS has no POSIX modes
41. a background run that stops or leaves a model unanswered pauses background checks for an hour # the model-check store exists only in the Linux sidecar container; NTFS has no POSIX modes
42. turning checks off, or an outdated approval, stops a background run before its next probe # the model-check store exists only in the Linux sidecar container; NTFS has no POSIX modes
43. turning checks off while a probe waits for its lease sends no probe # the model-check store exists only in the Linux sidecar container; NTFS has no POSIX modes
44. close() aborts work in flight, stops a background run before its next probe and starts no new run # the model-check store exists only in the Linux sidecar container; NTFS has no POSIX modes
45. each probe answer is saved, skipped or ends the run as classified # the model-check store exists only in the Linux sidecar container; NTFS has no POSIX modes
46. a probe is one tiny streamed request at the lowest listed reasoning effort, with a fresh lease each time # the model-check store exists only in the Linux sidecar container; NTFS has no POSIX modes
47. a run stops at its budget, cutting the probe in flight # the model-check store exists only in the Linux sidecar container; NTFS has no POSIX modes
48. turning checks on probes first, then saves the setting and approval in one write # the model-check store exists only in the Linux sidecar container; NTFS has no POSIX modes
49. turning checks off makes no network call, clears the approval and reports from the cached catalog # the model-check store exists only in the Linux sidecar container; NTFS has no POSIX modes
50. passive learning writes once per change, only for catalog models, and never throws # the model-check store exists only in the Linux sidecar container; NTFS has no POSIX modes
51. an unsafe or corrupt store reads as missing, and only turning checks off may replace a safe corrupt file # the model-check store exists only in the Linux sidecar container; NTFS has no POSIX modes
52. the store lock serializes writers, waits for a live holder until a deadline and replaces only a stale one # the model-check store exists only in the Linux sidecar container; NTFS has no POSIX modes
53. the CLI prints one JSON line per command and never the token # the model-check store exists only in the Linux sidecar container; NTFS has no POSIX modes
54. checks-on answers by its deadline and still saves the setting # the model-check store exists only in the Linux sidecar container; NTFS has no POSIX modes
55. the sidecar's own discovery keeps the counts and writes them when the handler closes # the request count store exists only in the Linux sidecar container; NTFS has no POSIX modes
56. down fails closed on missing or mismatched checkout ownership # executable fake Docker boundary is POSIX-only
57. Assistant mode persists generated secrets and drives exact profile cleanup # executable fake Docker boundary is POSIX-only
58. failed up preserves diagnostic state and reports the exact cleanup # executable fake Docker boundary is POSIX-only
59. successful config removes its generated policy without creating ownership # executable fake Docker boundary is POSIX-only
60. Assistant config validation leaves no generated secret or search files # executable fake Docker boundary is POSIX-only
61. config rejects a group or world-readable .env on POSIX # POSIX permission bits are unavailable on Windows
62. Docker selection overrides and remote contexts fail before Compose mutation # executable fake Docker boundary is POSIX-only
63. collector rejects a symlinked runtime source instead of following it # Windows denied file-symlink creation; this fixture requires symlink privilege or Developer Mode. Security settings were not changed.
64. young foreign PID namespaces keep an absent or reused-looking owner frozen until its lease expires # Linux PID-namespace leases exist only in container storage; NTFS has no POSIX modes
65. an expired foreign namespace lease is reclaimed before a healthy refresh # Linux PID-namespace leases exist only in container storage; NTFS has no POSIX modes
66. expired foreign lease recovery never replays a refresh whose freeze was persisted before a crash # Linux PID-namespace leases exist only in container storage; NTFS has no POSIX modes
67. group- or world-accessible registration storage fails closed # NTFS has no POSIX mode bits; Windows storage is held to owner-only ACLs instead
68. preserves quoting through a real POSIX shell # Remote VPS command is a POSIX /bin/sh script; native Windows has no /bin/sh unless RELMIO_TEST_POSIX_SHELL is set.
69. child file symlink # Windows denied file-symlink creation; this fixture requires symlink privilege or Developer Mode. Security settings were not changed.
70. inherited builder overrides exit 78 before the command # Remote VPS command is a POSIX /bin/sh script; native Windows has no /bin/sh unless RELMIO_TEST_POSIX_SHELL is set.
71. disabled or invalid BuildKit selection cannot reach the command # Remote VPS command is a POSIX /bin/sh script; native Windows has no /bin/sh unless RELMIO_TEST_POSIX_SHELL is set.
72. fresh empty namespace only, no preexisting credential adoption # fresh-session file ownership is enforced inside the Linux runtime container
73. symlinks, hardlinks, public file modes and oversized auth fail closed # fresh-session file ownership is enforced inside the Linux runtime container
74. errors never reveal private directory, provider credentials or JSON # fresh-session file ownership is enforced inside the Linux runtime container
75. the guide preference is never read through a link, from a FIFO or past 1 KB # SKIP
76. the guide preference is written only into a private root this user owns, never creating its parents # SKIP
77. counts add up per UTC day and model, with tokens only from completed responses # the request count store exists only in the Linux sidecar container; NTFS has no POSIX modes
78. a model is named once OpenAI accepts the request or the last catalog lists it; two writers merge # the request count store exists only in the Linux sidecar container; NTFS has no POSIX modes
79. day rollover keeps the 31 most recent UTC days on disk; the view covers the last 30 # the request count store exists only in the Linux sidecar container; NTFS has no POSIX modes
80. each day names at most 64 models and folds the rest into other; the view keeps the 64 busiest # the request count store exists only in the Linux sidecar container; NTFS has no POSIX modes
81. the last plan-usage event is kept until a later completed response clears it # the request count store exists only in the Linux sidecar container; NTFS has no POSIX modes
82. counts are written 30 seconds after the first one, once per wait, and close writes the rest # the request count store exists only in the Linux sidecar container; NTFS has no POSIX modes
83. a failed write keeps its counts for the next one, and odd input never throws # the request count store exists only in the Linux sidecar container; NTFS has no POSIX modes
84. the next write replaces a malformed stored record, and an unsafe one is never touched # the request count store exists only in the Linux sidecar container; NTFS has no POSIX modes
85. a sidecar's stored record is printed as it is, and an unsafe one is refused # the request count store exists only in the Linux sidecar container; NTFS has no POSIX modes
86. confirmed build lease confines state and removes only its created tree # SKIP
87. nonbuilding operation holds a lease without creating Buildx state # SKIP
88. build failure still cleans verified state and preserves the primary failure # SKIP
89. cleanup retains the entire tree and lock on symlink ambiguity # SKIP
90. cleanup retains the entire tree and lock on hardlink ambiguity # SKIP
91. cleanup retains the entire tree and lock on special file ambiguity # SKIP
92. cleanup retains the entire tree and lock on group-writable entry ambiguity # SKIP
93. cleanup rejects a nested same-device mount before any deletion # SKIP
94. cleanup rejects a foreign owner without deleting prior verified entries # SKIP
95. pre-existing lock is not adopted or cleaned # SKIP
96. state replacement cannot authorize deleting another inode # SKIP
97. OAuth ignore guard accepts only absent or exact owned context policy # SKIP
98. interrupted build leaves its state and lease for explicit inspection # SKIP
99. unknown non-build outcome after a successful build retains real state and lock despite responsive cleanup # SKIP
100. operation error remains primary when verified cleanup succeeds # SKIP
101. disconnect after lock creation reports the exact retained lease without cleanup # SKIP
102. review rejects a hard-linked or symlinked checkpoint without changing the outside sentinel # SKIP
103. a checkpoint hard-linked between attestation and upload is rejected before upload # SKIP
104. a checkpoint linked outside after upload is rejected before marker publication # SKIP
