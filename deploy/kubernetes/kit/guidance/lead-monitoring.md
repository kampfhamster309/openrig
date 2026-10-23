# Monitoring the Pi builder (dev.build)

dev.build runs Pi on a local model (qwen3.8 flash next on a Strix Halo). It does not
narrate progress and it does not show up in `rig usage`. A Pi extension writes a
heartbeat for it instead. Check it with one command, not with file-change polling,
`sleep` loops or `rig capture` alone:

```sh
/etc/openrig-kit/bin/pi-seat-status            # human summary
/etc/openrig-kit/bin/pi-seat-status --json     # same, structured
```

Exit code and first line give the verdict:

| Exit | Verdict | Meaning | What to do |
|---|---|---|---|
| 0 | WORKING / IDLE | Tokens are streaming, a tool is running, or it is idle with no open work | Leave it alone. Long reasoning is normal for this model. |
| 1 | WARN | Something is slower than usual (long prefill, token gap, long tool, long call) | Check again in a few minutes. Do not nudge yet. |
| 2 | STUCK / STALLED | Past the stuck threshold, Pi exited, or idle while owning open queue work | Act: see below. |
| 3 | NO-HEARTBEAT | The extension is not loaded in this seat | Fall back to `rig ps --nodes` + `rig capture`, and tell the human. |

## What is normal for this model

Measured from 616 real model calls on this hardware:

- A model call takes about 6s typically, 27s at p90 and 64s at p99. The longest seen was
  6m12s: 8k output tokens (mostly reasoning plus a large file write) at about 22 tok/s
  with 111k context. That was healthy.
- Output streams at about 47 tok/s, slower as context grows.
- Tool calls are usually instant. p99 is 36s; builds and tests can take minutes.

So a call running for several minutes is not by itself a problem. **Silence is.** The
heartbeat updates while tokens stream, including reasoning tokens.

## Stuck thresholds (warn / stuck)

- Prompt processing with no first token: 2m / 5m
- Token stream goes silent mid-response: 1m / 3m
- One model call still streaming: 10m / 20m (likely a reasoning loop)
- One tool call: 5m / 15m (the summary shows the command, so judge whether it is a long build)
- Compaction: 5m / 10m
- Idle while owning an in-progress or pending queue item: 1m / 3m

These are first estimates. `pi-seat-status --calibrate` prints percentiles from logged
calls; mention to the human when it suggests different values.

## When it is STUCK or STALLED

1. **Stalled after compaction** (idle, owns open work): this is the most common failure.
   Re-brief it with `rig send dev-build@claude-pi-k8s "..."`: the qitem id, the slice, what
   is already done and the next concrete step. Point it at its RECAP.md.
2. **Token stream silent or prefill stuck**: the local model server may be hung. Check
   `rig capture dev-build@claude-pi-k8s --lines 30`, then tell the human; do not restart
   the model server yourself.
3. **Reasoning loop** (call running 20m+ while streaming): interrupt it and re-send a
   narrower instruction.
4. **Pi exited**: tell the human; relaunch with `rig up --existing claude-pi-k8s --fresh dev-build`
   only with their approval.

Prefer one status check every few minutes over tight loops. Each check costs you context.

## Do not

- Do not run `rig export` in the workspace repo without `-o <path>`. Its default output is
  `./rig.yaml`. The rig spec itself is in /etc/openrig-kit, which is read-only; the human
  maintains it in the cluster's ConfigMap.
- Do not push from this pod. It has no Git credentials. Commit on a branch and report the
  branch name and commit to the human.
