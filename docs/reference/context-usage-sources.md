# Context usage sources

Every seat shows a context percentage, or `? —` when OpenRig has no reading. This page names where
each reading comes from, the file contract behind the ones that arrive as a sidecar, and how a Pi
seat gets one.

## The sources

| Runtime | Written by | `source` label | Where |
| --- | --- | --- | --- |
| `claude-code` | OpenRig's status-line collector, provisioned into the seat's working directory | `claude_statusline_json` | `state/context-usage/<seat>.json` |
| `codex` | Codex itself, in its own rollout log | `codex_token_count_jsonl` | the seat's Codex thread, not a sidecar |
| `stub` | OpenRig's stub runtime, writing its own sidecar | `claude_statusline_json` | `state/context-usage/<seat>.json` |
| `pi` | the optional Pi extension `pi-openrig-context`, if you add it to the seat | `pi_context_usage_json` | `state/context-usage/<seat>.json` |
| `omp` | the same extension, **if** OMP loads Pi's extension API — unverified, see below | `pi_context_usage_json` | `state/context-usage/<seat>.json` |

The label is chosen from the seat's runtime, never guessed from the file: the sidecar format is
runtime-neutral, so the file cannot say who wrote it. Consumers may branch on it — the usage cost
view, for one, treats a source it does not recognize as carrying no cost rather than as a Claude
estimate.

## The sidecar contract

```text
$OPENRIG_HOME/state/context-usage/<seat>.json
```

`<seat>` is the seat's session name with every character outside `[A-Za-z0-9@._-]` replaced by `_`.
A pre-0.5.9 instance also reads `$OPENRIG_HOME/context/<seat>.json` as a fallback; new writes always
go to the canonical directory.

```json
{
  "context_window": {
    "context_window_size": 200000,
    "used_percentage": 31,
    "remaining_percentage": 69,
    "total_input_tokens": 61440,
    "total_output_tokens": null,
    "current_usage": { "runtime": "pi", "tokens": 61440, "context_window": 200000, "percent": 30.72 }
  },
  "session_id": "…",
  "session_name": "dev-build@my-rig",
  "occupant_generation": "…",
  "transcript_path": "…",
  "cost": null,
  "sampled_at": "2026-10-25T09:53:07.582Z"
}
```

`used_percentage` is a whole number, because that is how every consumer prints it; the exact figure is
kept unrounded under `current_usage.percent`.

What the reader makes of it:

- **`used_percentage` must be a number for the seat to read as known.** The reasons then split by what
  the file actually did: a **missing file** is `unknown` with reason `missing_sidecar`; a present,
  well-formed `context_window` whose `used_percentage` is **explicitly `null`** is `unknown` with
  reason `no_data` — that is a valid "no reading right now", which is what Pi writes after a
  compaction, and not a malformed file; anything genuinely **malformed** stays `unknown` with reason
  `parse_error` — no `context_window`, a `context_window` that is not an object, a `used_percentage`
  key that is absent, or one that is a non-number such as `"42"`. **Unknown is never rendered as
  zero**, on any surface.
- **`session_name` must be the seat's current session name.** A sidecar naming a different session is
  refused as `session_mismatch`.
- **`sampled_at` decides both freshness and the generation guard.** A sample older than ten minutes is
  still shown, marked stale. The `stale_generation` gate compares **`sampled_at` with the live
  occupant's `boot_at`**: a sample taken before the current occupant booted is refused, so a retained
  predecessor cannot drive the threshold under a successor that reused the name. **The store never
  reads `occupant_generation`** — the gate is the two timestamps. `occupant_generation` is carried in
  the file for consumers that need to tell occupants apart (see `SidecarRaw`'s own comment), not for
  this one.
- **A retiring occupant's sidecar is deleted at handover**, before the successor can read it. A Pi
  successor writes only at its own session start and on its own turns, so if its start sample lands
  before the handover commit deletes the file, the seat reads `missing_sidecar` until its first turn.
  That is unknown, never wrong.
- `total_output_tokens` and `cost` are null wherever the runtime reports neither. An absent figure is
  never written as zero.
- **`total_input_tokens` is what is in the context window right now**, not a running total of input
  across the session. Pi's `getContextUsage()` reports the window's current contents, and a consumer
  that wants cumulative input must not read this field as one. That is also why a Pi seat's context row
  carries no cost: the cost view takes a Pi seat's cost from its own usage entries, never from this
  sample.

## Giving a Pi seat its reading

OpenRig reads the sidecar; it does not create it. For `runtime: pi` and `runtime: omp` the writer is
the Pi extension [pi-openrig-context](https://github.com/kampfhamster309/pi-openrig-context), a
separate repository. It is an optional customization, like a `models.json` for a local model: you add
it to the seats where you want a reading. OpenRig does not ship it, does not install it, and never
writes into a seat's Pi agent directory ([rig-spec.md](rig-spec.md), "Pi": OpenRig creates the seat's
Pi directories and copies nothing into them). OpenRig does not depend on the extension's repository in
any direction; the sidecar file is the whole interface between them.

The seat's own Pi directory is `$OPENRIG_HOME/state/pi/<seat>/agent`, so its extensions directory is
`$OPENRIG_HOME/state/pi/<seat>/agent/extensions`. A seat that loads the extension writes its own
sidecar at session start, after each model call and after each compaction. A seat without it has no
reading and shows `? —`.

**A managed seat does not read `~/.pi/agent`.** Each one runs with
`PI_CODING_AGENT_DIR=$OPENRIG_HOME/state/pi/<seat>/agent`, so installing into `~/.pi/agent` reaches
only your own plain Pi sessions, never an OpenRig seat. Pi's own mechanism does reach a seat when you
point it at that seat's directory:

```bash
git clone https://github.com/kampfhamster309/pi-openrig-context

# one OpenRig seat, Pi's own install mechanism (preferred)
PI_CODING_AGENT_DIR="$OPENRIG_HOME/state/pi/<seat>/agent" pi install ./pi-openrig-context

# the same seat, by copying the file
install -m 0644 pi-openrig-context/extensions/openrig-context-usage.ts \
  "$OPENRIG_HOME/state/pi/<seat>/agent/extensions/openrig-context-usage.ts"

# one plain Pi session of yours, for a try
pi --extension ./pi-openrig-context/extensions/openrig-context-usage.ts
```

**In a team pod** the extension goes the way `kit/pi/models.json` and the heartbeat extension go: the
kit is the `openrig-kit` ConfigMap, which kustomize generates from files under `deploy/kubernetes/kit`,
and the entrypoint copies `$OPENRIG_KIT_DIR/pi-extensions/*.ts` into each Pi seat. To add it, copy
`extensions/openrig-context-usage.ts` into your kit's `pi-extensions/` and add a line next to the
heartbeat's in `kustomization.yaml`:

```yaml
      - openrig-context-usage.ts=kit/pi-extensions/openrig-context-usage.ts
```

The kit in this repository does not carry a copy, so there is no second source of truth to keep in step.

**OMP is unverified.** The monitor reads an `omp` seat's sidecar the same way. The runner sets
`PI_CODING_AGENT_DIR` for omp seats too (`buildPiChildEnv` in `adapters/pi-runner-protocol.ts`), so an
omp seat is named from its agent directory like a Pi one, with `OPENRIG_SESSION_NAME` as the fallback.
What is **not** established here is that OMP loads Pi extensions with the same API (`getContextUsage`,
`turn_end`); OMP is not installed in the environment this was built and proved on. If it never does, the
seat simply stays `unknown`, which is what the missing-sidecar rule is for.

## The compaction boundary

OpenRig's managed compaction sends Claude's `/compact` keystrokes to a seat. It is gated on the seat's
runtime being `claude-code`, so **a Pi seat's sample — however high and however fresh — can never
trigger OpenRig's managed compaction on that seat**. Pi compacts on its own terms. The gate is covered
by a test that fails if the runtime filter is removed.

One practical consequence of that filter: sending `/compact` to a Pi seat as a message **never compacts
it**. The Pi runner intercepts only `/abort` and `/followup`, so `/compact` arrives as a stray prompt
for the model rather than a command — which is exactly why the runtime filter has to be the thing that
stops managed compaction, and not any hope that a Pi seat can be talked out of one by text.

One deliberate exception, so the wording here is not over-broad: an **opt-in** context-usage threshold
watch (`policies/context-usage-threshold.ts`, registered by hand) performs `action: "send"` against its
target when the threshold is crossed, and a Pi seat can be that target. It sends a text notice, not
`/compact`, and it exists only because somebody configured it. Before Pi was read at all, such a watch
could already send its "can't read … context use" notice, so this is not a new capability — but it does
mean "no keystroke ever reaches a Pi seat" is too strong a claim. What is guaranteed is that no
*automatic compaction* is.

## A side effect of reading Pi seats: startup status

Adding `pi` and `omp` to the context monitor's eligible sessions also runs `normalizeStartupStatus` for
them for the first time. The Pi and OMP readiness checkers were already registered; no Pi seat ever
reached them. The visible effect: a running Pi or OMP seat whose `startup_status` was `failed` or
`attention_required` is promoted to `ready` once the adapter sees runner state `ready` (or a READY
marker with no shell in the foreground). This is read-only — session existence, the pane's foreground
command, and a capture — and none of the checker's codes are attention codes, so it never demotes a
seat. Credential and runner failures still surface as the runner's own `ERROR` or `EXITED`, which counts
as not ready. It is the same normalisation Claude and Codex seats already received.

## Checking a seat's reading

```bash
rig ps --nodes --filter contextUsage.percent>=80 --json
cat "$OPENRIG_HOME/state/context-usage/<seat>.json"
```

The file's `used_percentage` should match what the seat itself shows — **provided the extension is at
`15427a7` or newer**, the commit that samples at `turn_end` rather than at `message_end`. An older copy
reads the context one model call behind, so the sidecar can sit far below what the seat displays. If a
seat shows `? —`, the usual cause is that nothing writes its sidecar: for a Pi seat, that means the
extension is not installed in that seat.
