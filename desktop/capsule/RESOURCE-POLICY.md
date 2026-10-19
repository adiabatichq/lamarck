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

## App and Service enablement; background diagnostics (2026-10-19)

This work follows the approved **App and Service Enablement** section of
`202607120100-Personal App Runtime Workload Conventions.md` and the supervisor,
management, networking and unattended-diagnostics sections of
`202607130100-App Capsule Security and Runtime Contract.md` and
`202607130200-Shared Linux VM Capsule Backend.md`. The existing Console details
remain the management surface, consistent with the Desktop Use/Manage ADR.
The 2026-10-19 approval supersedes the earlier Stop App session-suspension policy.

Console App details now contain one persisted App toggle and one toggle per
Service, including stopped Services. App disablement fences UI, Service and Job
admission, cancels current runs through existing cancellation, and joins process
and authority cleanup. It preserves child Service settings, Trigger settings,
history and pending work. Re-enablement restores eligible Services; it does not
open a viewer or create a Job invocation. Close UI and Stop job remain available;
Stop App and separate Service restart/resume controls are not exposed.

`app_runtime_settings` and `app_services` are part of the greenfield system.db V1
baseline. Admission installs enabled defaults once; rescans and activations do
not overwrite saved choices. App revisions fence asynchronous activation and
channel issuance. Disabled App targets use the existing unavailable-target and
pending-queue behavior. No Trigger scheduling, matching, input, queue or retry
policy is added. All schema, manifest, package and protocol versions are unchanged.
There is no migration or compatibility path and no existing user Workspace was
reset.

The existing background operation registry and Guest workload primitives own
Services as well as Jobs. A Service has no UI port; its argv, immutable activation,
SDK identity and managed CLI authority follow the existing Capsule path. Process
liveness is its health signal. Unexpected exits persist exponential backoff from
one second to sixty seconds; a run stable for sixty seconds resets crash counting.
A replacement builds before stopping its predecessor, then waits for confirmed
cleanup before creating the replacement process. Failed teardown or authority
release remains owned and visible; unconfirmed VM containment retains quarantine
and artifact pins. Confirmed Service launches retain the verified artifact for
subsequent starts without rebuilding.

Matching activation inputs share a Guest App filesystem aggregate. Exact workload
stop preserves siblings; the last owner releases that aggregate. Guest records
are retired only after exact cleanup, with bounded stop tombstones.

An authenticated App owner has one ordinary loopback-only network namespace,
held independently of filesystem aggregates. Each aggregate pins a reference;
a prepared replacement holds its reference before the old UI stops. Exact final
aggregate cleanup releases the last network lease. There are no socket programs,
routing maps, generation-specific listener addresses, or listener publication.
Viewer probes and streams use ordinary localhost in that App network.

UI replacement builds and validates the artifact while the old UI runs. Once
ready, it starts one 15-second handoff deadline, retires the old browser authority,
confirms old process-tree cleanup, and only then starts the replacement. Readiness
and viewer verification consume the same remaining deadline. At most one UI may
execute for an App, including descendants; Host ownership and Guest admission
both enforce this across aggregates. Service, Job and other App lifetimes remain
independent. Build failure preserves the running UI. A failed or cancelled runtime
handoff may leave the UI unavailable; the verified activation/artifact stays
retained without automatically executing it again. Timeout cancels the attempt,
but unconfirmed cleanup keeps admission fenced and visible until authoritative
cleanup, even when it exceeds the deadline. Explicit recovery remains available.

Stdout and stderr continuously drain. Congested Guest transport retains at most
64 KiB of pending recent output and drops older output rather than blocking the
process. The Host retains at most 128 KiB per execution, eight executions per App,
and sixty-four globally. Completed evidence expires after one hour and all
evidence is cleared after confirmed Host teardown. Diagnostics include exact App,
workload, execution and activation version attribution, bounded failures, timestamps
and discarded-byte counts. Credentials and private channel authority are redacted,
including split/truncated output. Only trusted Shell IPC may read evidence, and
an execution selector cannot cross App ownership. Nothing is automatically written
to D0 or a durable log database.

Authorized users and agents using Console can read retained diagnostics. The
canonical public CLI ADR does not specify an unattended-diagnostic read command;
a dedicated programmatic agent read surface remains a contract gap. This work
adds no CLI grammar or SDK administration API and does not promote either Trigger
proposal to approved status.

Automated verification used Node 24.19.0 and isolated fixtures, not a physical VM:

- Core lifecycle, baseline and Trigger suites: 10 files, 87 passed.
- Real Core/Guard integration: 19 passed, including App-wide admission, a
  Service-only App, bound SDK identity, existing CLI/event/cron Jobs and inputs.
- Shell Capsule/viewer/Console regression set: 31 files, 602 passed, one existing
  skip. A subsequent focused lifecycle run passed 90 tests, including the new
  check that disabling one App preserves another App's in-flight UI admission.
- Shared Capsule: 70 passed; Guest: 204 passed; public CLI: 71 passed;
  System SDK: 60 passed, including unchanged jobInput V1.
- Core, Shell, shared Capsule and Guest type checks passed. Core and Desktop
  production builds and the Guest JavaScript build passed. Module boundaries and
  diff whitespace checks passed; the checker still notes the existing location
  debt for the Core/Shell integration harness.

The native Linux Guest helper, signed Guest image and physical Capsule scenarios
were not rebuilt or exercised. Use matched Desktop and Guest artifacts for those
checks. No commit, push, packaging, publishing or release was performed.

### Focused lifecycle repairs (2026-10-19)

Persisted cleanup failure from an older Host can be discharged by confirmed full
Host teardown or backend proof of a clean boundary. A cold backend obtains the
helper's exclusive state/VM lease; availability alone is insufficient. Retained
current-boundary workload, channel and activation cleanup obligations still block
recovery. Enablement and HTTP acknowledgements do not clear those obligations.

Authenticated Service startup clears that Service's active error and its scoped
App failure projection. Unrelated workload failures and unresolved cleanup remain
visible; completed execution diagnostics and restart/backoff counting are retained.
Service observations are serialized so delayed healthy observations cannot replace
a subsequent failed outcome.

Focused regressions were integrated into the existing suites. Latest results:
Shell 610 passed with one existing skip; Guest 205 passed; shared Capsule 70 passed;
Core lifecycle, Trigger, version and real Core/Guard integration 106 passed. Core,
Shell, shared Capsule and Guest type checks passed. Desktop and Core production
builds and the Guest JavaScript build passed. The production native helper and
native tests passed strict Linux cross-target C syntax checks.

The privileged Linux runtime gate now covers the production namespace helper:
sequential same-port UI listeners, ordinary localhost communication with unchanged
Service and Job processes, failed replacement without automatic rollback,
namespace-pin retirement, and cross-App same-port isolation. The former network
BPF regression and its production routing path have been removed. The existing
OCI/runc cgroup device BPF policy is unchanged. Live Linux/VM verification remains
required; mock tests and cross-target C syntax checks do not establish native
network correctness.

### Sequential UI handoff verification (2026-10-19)

The current reload implementation removes concurrent old/new UI execution and
all handwritten network BPF hooks, maps, listener aliases and publication. App
network ownership is an authenticated, reference-counted namespace lease. UI
retirement and replacement startup are sequential; a prepared aggregate keeps
its network lease through handoff, and sibling workloads retain their leases.
The 15-second handoff deadline covers exact old teardown, replacement readiness
and browser verification. Build preparation is outside the deadline. Failure
retains the previous verified artifact without automatically executing it again.

Current validation: Shell Capsule/viewer/Console set 620 passed with one existing
skip; Guest 207 passed; shared Capsule 70 passed; Core version/Trigger suites 71
passed; real Core/Guard integration 19 passed. Final focused backend, Manager and
viewer lifecycle checks passed 262 tests after the renderer retirement changes.
Shell, Guest, shared Capsule and Core type checks passed. Desktop production and
Guest JavaScript builds passed. Module-boundary and whitespace checks passed,
with the existing integration-harness location debt unchanged. The production
network helper and its native regression passed strict Linux-target C syntax
checks. Docker has no available daemon here, so the privileged Linux gate and
matched physical Guest/VM verification could not run. No native network execution
claim is based on these mock tests or syntax checks.

Schemas remain v1 and all manifest/protocol version numbers remain unchanged.
No migrations, compatibility routing, configuration, controls, infrastructure,
commit, push, packaging or release were added or performed by this repair.
