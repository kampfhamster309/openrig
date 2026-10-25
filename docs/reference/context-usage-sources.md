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
| `pi`, `omp` | the Pi-side extension `pi-openrig-context`, installed into the seat | `pi_context_usage_json` | `state/context-usage/<seat>.json` |

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
    "used_percentage": 30.72,
    "remaining_percentage": 69.28,
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

What the reader makes of it:

- **`used_percentage` must be a number for the seat to read as known.** Anything else — absent, null,
  a string — is `unknown` with reason `parse_error`. A missing file is `unknown` with reason
  `missing_sidecar`. **Unknown is never rendered as zero**, on any surface.
- **`sampled_at` decides freshness.** A sample older than ten minutes is still shown, marked stale.
- **`session_name` must be the seat's current session name.** A sidecar naming a different session is
  refused as `session_mismatch`.
- **`occupant_generation` decides the generation guard.** A sample taken before the seat's current
  occupant booted is refused as `stale_generation`, so a retained predecessor cannot drive the
  threshold under a successor that reused the name.
- **A retiring occupant's sidecar is deleted at handover**, before the successor can read it.
- `total_output_tokens` and `cost` are null wherever the runtime reports neither. An absent figure is
  never written as zero.

## Giving a Pi seat its reading

OpenRig reads the sidecar; it does not create it. For `runtime: pi` and `runtime: omp` the writer is
the Pi-side extension, and OpenRig never writes into a seat's Pi agent directory
([rig-spec.md](rig-spec.md), "Pi": OpenRig creates the seat's Pi directories and copies nothing into
them). So the extension is installed the way Pi extensions are installed, not by OpenRig.

The seat's own Pi directory is `$OPENRIG_HOME/state/pi/<seat>/agent`, so its extensions directory is
`$OPENRIG_HOME/state/pi/<seat>/agent/extensions`. A seat that loads the extension writes its own
sidecar at session start, after each model call and after each compaction; a seat that does not
simply has no reading, and shows `? —`.

Three routes, in increasing scope:

```bash
# one seat, for a try
pi --extension ./pi-openrig-context/extensions/openrig-context-usage.ts

# every Pi seat on this machine (your own ~/.pi/agent)
pi install /path/to/pi-openrig-context

# one OpenRig seat on this machine
install -m 0644 pi-openrig-context/extensions/openrig-context-usage.ts \
  "$OPENRIG_HOME/state/pi/<seat>/agent/extensions/openrig-context-usage.ts"
```

For a team pod, the container entrypoint already seeds `$OPENRIG_KIT_DIR/pi-extensions/*.ts` into
every Pi seat it provisions (`deploy/kubernetes/image/entrypoint.sh`; the kit's copies are
authoritative and are refreshed on each boot). Carrying the extension that way means the image build
places the file in the mounted kit — from its published source at build time, rather than as a
second committed copy inside OpenRig. **OpenRig does not depend on the extension's repository in any
direction; the sidecar file is the whole interface between them.**

### Automatic provisioning is not built

OpenRig provisions a Claude Code seat's collector for it. Doing the same for a Pi seat — writing the
extension into each seat's Pi extensions directory at launch — would need:

- a copy of the extension inside the OpenRig package, or a fetch of it at launch, and a decision
  about which it is (a vendored copy is a second source of truth; a fetch is a network dependency at
  seat launch and an update path);
- an update and removal story for seats whose extension is stale or no longer wanted;
- a change to the documented stance that OpenRig copies nothing into a seat's Pi agent directory, and
  to the trust question that stance avoids (an extension runs inside the seat with its permissions);
- a rule for seats the daemon did not launch (adopted and claimed seats).

That is a product decision, not an implementation detail, so it is left unmade here.

## The compaction boundary

OpenRig's automatic compaction sends Claude's `/compact` keystrokes to a seat. It is gated on the
seat's runtime being `claude-code`, so a Pi seat's sample — however high and however fresh — never
puts a keystroke on a Pi seat. Pi compacts on its own terms. The gate is covered by a test that fails
if the runtime filter is removed.

## Checking a seat's reading

```bash
rig ps --nodes --filter contextUsage.percent>=80 --json
cat "$OPENRIG_HOME/state/context-usage/<seat>.json"
```

The file's `used_percentage` should match what the seat itself shows. If a seat shows `? —`, the
usual cause is that nothing writes its sidecar: for a Pi seat, that means the extension is not
installed in that seat.
