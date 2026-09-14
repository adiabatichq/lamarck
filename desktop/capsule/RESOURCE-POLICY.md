# Capsule startup and Runtime resource policy

Runtime startup has one 180-second Host monotonic deadline. It starts immediately
before `workload.start`, after Build, import and authenticated stream setup. The
Guest receives only the remaining duration and starts its own monotonic timer.
Port readiness, HTTP readiness and the initial viewer document consume the same
budget. Protocol and authoritative teardown keep their separate deadlines. The
Shell shows a non-blocking longer-preparation message after 60 seconds of opening.
Ordinary startup expiry rejects only that opening and runs its authenticated
App teardown before releasing commitments. Protocol/containment failures or
unconfirmed cleanup still trigger VM teardown.

Each renderer opening has an opaque operation ID bound to its owner generation.
Closing sends cancellation even before a viewer ID exists. The Manager fences
that App through backend teardown and final capability revocation. A completion
race closes the exact resulting viewer; a late cancellation cannot address a new
opening. Hiding or switching the mounted App only changes native viewer bounds.

The existing Build queue attempts each eligible item at most once per pass.
Blocked items retain order, while later cached launches still perform their own
admission. Two Build slots remain the maximum. Capacity release, acknowledged
supply and observed pressure recovery wake the queue. Build deferral uses two
pressure samples at least one second apart; recovery requires two samples below
lower thresholds. A capacity wait still requires an active finite preparation.

Runtime initial grants remain 256/512 MiB. The provisional growth ceiling is
1 GiB per workload, below the existing 2 GiB App parent limit. It is **not a
validated sufficient ceiling** for the heavy QA App. The Guest ledger still
protects management memory, the 512 MiB shared Build reserve and actual individual
Build grants, which can be 1 GiB. The VM ceiling remains 4 GiB.

Growth considers memory.current, anonymous/kernel memory, cgroup pressure and
memory-event deltas over multiple samples. VM CPU/I/O pressure influences Build
admission; CPU use is not proof of compilation progress. A controller reserves
before writing memory.max, reads back the effective limit and retains the larger
commitment on uncertainty. The next decision uses another observation. Confirmed
higher grants remain reserved while the App stays open, even after its usage
falls; only verified teardown releases them. Live limits never shrink.

Denied growth is observable. A pending viewer can wait for balloon supply or
another finite preparation to release capacity within its original 180-second
Runtime startup budget. Memory waiting never resets or extends that deadline.
Retryable supply failures keep recoverable viewers waiting for later observations;
each supply attempt retains its existing five-second acknowledgement limit.
Confirmed exhaustion, including persistent pressure at the Runtime ceiling,
produces the existing retryable resource response. This policy does not evict or
restart active Apps. Uncertain containment and invalid protocol responses retain
the existing VM failure boundary.

Memory observations stay inside the Guest controller. Only current demand,
measurement age, workload identity and growth outcome cross the authenticated
private Host–Guest control channel for resource policy. There is no retained
Host snapshot history, public diagnostic field, command or endpoint. Public CLI
response types and serialization are unchanged; ordinary App inspection does
not query Guest resources.

Shipping requires a paired Desktop and Guest rebuild, including the Guest native
network helper whose probe accepts the longer duration. The optional start-budget
field and memory-demand status extend only the private Host–Guest protocol.
Public contracts and all protocol/schema version constants remain unchanged. Do not stage the updated Desktop with an old Guest.

Validation for this patch is compilation and source review only. Live scenarios require rebuilt, matched Desktop/Guest artifacts; compilation
is not behavioral evidence. The unchanged heavy App, compilation
completion, four-/ten-App mixtures, pressure recovery, updates and cancellation
cycles have not been verified against these changes. Existing behavioral test
expectations for the old deadlines and 512 MiB controller policy were not executed
or rewritten under the restriction against test scripts.

## Contract audit and verification

Baseline: `9daa0b25bd1794892b5d6f5cc18ec0b6d55aa007`. The complete production diff
was reviewed, including the Shell renderer/preload boundary, private control
messages, lifecycle callbacks and response serialization. The entire CLI, SDK
and Core trees, App preload, CLI dispatcher and CLI gateway match the baseline.
There are no manifest, permission, public event or persisted-format changes.
The original `AppShape` and `joinRuntime` response construction are restored.
Both source and the rebuilt Host bundle construct only `{ running: boolean }`
under `runtime`, and the unchanged gateway serializes that response directly.
App inspection has no dependency on a Guest resource query.

Successful checks: Host, Guest, shared Capsule and CLI TypeScript checks; CLI,
Guest JavaScript, Electron Host and renderer builds; `git diff --check`. Builds
used Node 24.18.0 after correcting a Host build attempt that selected Node 20.
The native Guest Linux helper and a signed Guest image were not built.

The existing public CLI successfully inspected `capsule-qa-j`: version
`4248aa1ac738f1f28aebf6bccd5fe757317f7924`, no unrecorded changes, and serialized
`runtime: { "running": false }` with no added diagnostic field. This was the
existing Desktop, not a live run of the rebuilt Host. Rebuilt-Desktop response
parity and all requested workload scenarios remain unverified. Automatic approval
review rejected opening the older QA Desktop bundle; it was not used to validate
the new implementation. No testing scripts, private harnesses or pressure
overrides were run. Save/activate and external-editor/CLI event code is unchanged,
but those live scenarios were not exercised.

Production scope against the baseline: 18 files, 453 additions and 75 deletions.
The table excludes this new documentation file and ignored compilation outputs.

| File | Added | Deleted |
| --- | ---: | ---: |
| `desktop/capsule-guest/native/net-helper.c` | 1 | 1 |
| `desktop/capsule-guest/src/capacity-controller.ts` | 8 | 2 |
| `desktop/capsule-guest/src/resource-admission.ts` | 14 | 0 |
| `desktop/capsule-guest/src/resource-manager.ts` | 3 | 3 |
| `desktop/capsule-guest/src/runtime-memory.ts` | 128 | 22 |
| `desktop/capsule-guest/src/supervisor.ts` | 21 | 5 |
| `desktop/capsule/src/protocol/types.ts` | 15 | 0 |
| `desktop/capsule/src/protocol/validate.ts` | 3 | 1 |
| `desktop/shell/electron/capsule/backend.ts` | 1 | 0 |
| `desktop/shell/electron/capsule/capacity-coordinator.ts` | 86 | 10 |
| `desktop/shell/electron/capsule/macos-backend.ts` | 66 | 16 |
| `desktop/shell/electron/capsule/manager.ts` | 18 | 3 |
| `desktop/shell/electron/capsule/viewer-readiness.ts` | 15 | 2 |
| `desktop/shell/electron/main.ts` | 64 | 6 |
| `desktop/shell/electron/preload.cjs` | 2 | 1 |
| `desktop/shell/src/content/AppRuntimeView.tsx` | 5 | 2 |
| `desktop/shell/src/main.tsx` | 1 | 0 |
| `desktop/shell/src/vite-env.d.ts` | 2 | 1 |
