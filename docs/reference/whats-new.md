# What changed in OpenRig 0.7.2

This note is for an agent on an install that was just upgraded to 0.7.2. It lists only what behaves differently from
0.7.1 and what to do about it. For everything OpenRig can do, read the capability map:
`rig context get onboarding-width/public-what-you-can-do.md`. Each release replaces this file, so
`rig context get reference/whats-new.md` describes the installed version once the upgraded daemon is running. Without
a running daemon, read `$OPENRIG_HOME/reference/whats-new.md`. The daemon refreshes that copy when it starts, so right
after an upgrade it can still hold the previous version's note.

## After the upgrade

- **Restart the daemon** (`rig daemon stop`, then `rig daemon start`). Six migrations run on the first start (132, 133,
  134, 136, 138 and 139). They add records for runtime switches, stream reader actions, a seat's launch recipe, a Claude
  seat's token reference and its tool rules, and rebuild the provider usage readings table to hold labelled Claude
  token readings, keeping existing readings. No setting is added or removed.
- **The bundled openrig-core plugin goes from 0.1.18 to 0.1.19.** Only two skills changed: `delegating-work` (its
  description now also covers deciding how far to trust a delegated result) and `openrig-user` (reading a queue write,
  a seat's own Claude or Codex account, moving one seat to another login, and the MCP handoff and unclaim tools). As in
  0.7.1, startup first copies each file it replaces under `$OPENRIG_HOME/backups/managed-refresh/<id>/`, edited or not,
  and logs `[plugin-vendor] preserved previous contents of <file> at <copy> before managed refresh`. A copy doesn't mean
  anyone edited the file; if someone did, reapply the change from the copy.
- **Startup also refreshes the person-facing `rigs` skill** in `~/.claude/skills` and `~/.agents/skills`, with the same
  copy first, when OpenRig installed it (a copy installed another way is left as it is). It now says what setup and
  Codex seats write to a Codex home, offers the operator conversation to a Codex user who declined Codex's remembered
  command rule, and covers Rex.
- **Codex seats:** OpenRig's Codex plugin is openrig-core, so Codex sees it as changed. As in 0.7.1, OpenRig renews
  its own hook approval only where the installed plugin folder matches what shipped. If a Codex seat stops at Codex's
  "Hooks need review" after the upgrade, that folder held other files: review the hooks in Codex.
- **On Linux, check seats that use your session bus** (the keyring, notifications). From their next launch, restore or
  handover they get `DBUS_SESSION_BUS_ADDRESS=disabled:` unless their `env:` sets an address (see Known gaps).
- **Launch fixes reach a seat at its next launch, resume, restore or handover,** not a running process: the Read
  grants a managed Claude restore needs, a Codex seat's writable git and topology folders, a seat's own account home,
  the Linux runtime directory and member tool rules.
- **Close and reopen terminal views opened before the upgrade** (Herdr, cmux or tmux). Only views opened on 0.7.2 keep
  their tiles when a seat's session is replaced.
- **If a seat runs on a home given by `rig up --env CLAUDE_CONFIG_DIR=…` or `--env CODEX_HOME=…`,** declare it in the
  member's or rig's `env:` instead. 0.7.2 leaves both names out of `--env`, with a note.

## New things you can do

- **Move a live seat between Codex and Claude Code:** `rig seat set-runtime <seat> --runtime <claude-code|codex>
  --reason "…"`, with `--dry-run` first to see the target's settings, what is cleared and the costs. The successor
  starts beside the current occupant, reads a handover (the seat's recap, its open rows and the predecessor's screen)
  and confirms with `rig seat set-runtime <seat> --confirm <switch-id> --note "…"`. Only then does the seat move, keeping
  its address, connections, rows and claims. Without a confirmation in 180 seconds (`--confirm-timeout`) nothing
  changes; `--recover` finishes an interrupted switch. The switch starts a new conversation and isn't written back to
  the team file (`docs/reference/getting-started.md`, "Move a seat to the other runtime").
- **Run a seat on its own Claude or Codex account:** sign a home in once natively (`CLAUDE_CONFIG_DIR=<home> claude`
  then `/login`, or `CODEX_HOME=<home> codex login`), then declare that absolute path as `CLAUDE_CONFIG_DIR` or
  `CODEX_HOME` in the member's or rig's `env:`. Launch, resume, restore, handover, OpenRig's managed Codex config and
  hooks, usage limits and status follow it. `rig seat status` and `rig provider status` show the home and where it came
  from; a relative value is ignored and shown.
- **Move one seat to another login on the same conversation:** for a Codex seat on Linux, `rig provider precheck --seat
  <seat> --to-account <name>`, then `rig provider switch --seat <seat> --to-account <name>`, using a login saved in that
  seat's Codex home (`rig auth save`). It saves the outgoing login, activates the chosen one, restarts the seat in place
  and prints a restart command for every peer on that home. For a Claude seat, `--to-account <label> --token-file
  <absolute path>` moves it to its own subscription token (from `claude setup-token`, in a file only the user can read);
  OpenRig keeps the path and label, never the token. `--stored-login` moves it back.
- **Read a labelled Claude token's usage:** `rig provider status --refresh --provider claude --claude-token-file
  <absolute path> --credential-label <label>`. Each refresh spends one model turn; status and the TUI show only the
  cached reading. The label is yours, not an account Claude reported.
- **Give each Claude member its own tool rules,** even in a shared folder: `claude_permissions: { allow: [...], deny:
  [...] }` on the member, or `rig seat set-permissions <seat> --rules <json-file> --reason "…"` for an existing seat.
  The update is audited, applies at the next managed launch or resume, and leaves the permission mode alone. Rules join
  OpenRig's one `--settings` value and never go into the project's Claude settings. They're native tool rules, not OS
  isolation, and an allow list doesn't withdraw broader inherited grants. Limits are under Known gaps.
- **Say what you did about a stream item:** `rig stream act <id>` with exactly one of `--work <qitem>` (work you opened
  or joined through the queue), `--decline "<reason>"` or `--duplicate <qitem|stream id>`. Actions are append-only, the
  poster's `rig stream show` lists each reader's current action, and retention keeps an item a reader acted on. A
  reader who links different work from someone else is told about theirs.
- **Pass held work on over MCP:** `rig_queue_handoff` closes an item as handed off and opens its successor in one step,
  and `rig_queue_unclaim` puts a claim back. The MCP server has 36 tools.
- **Release a row parked on a typed blocker:** `rig queue resolve <id> --decision "<evidence>"` now also unparks a row
  blocked on `external:`, `fold:` or `auth:`, and records the evidence as a wait resolution, not a person's decision.
- **Open views in Rex:** from a Rex pane, `rig terminal open <view> --window` or the TUI opens the view as a new Rex
  session and switches the Rex app to it. `--provider rex` picks it explicitly. Outside Rex the default stays Herdr,
  then cmux (`docs/reference/terminal-sessions.md`). Not run on Linux.
- **Hand a community harness its first turn at launch:** a preset's `first_input: true` writes the first startup text
  to a private file and passes `OPENRIG_FIRST_INPUT=<path>`; the launcher hands it to the harness. The Cursor example
  uses it and now sets `startup_assisted: false`. OpenClaw gains a Gateway-client example (`openclaw-gateway.yaml`)
  beside the local one, and both resume a named conversation.
- **Start one seat of a materialized team:** after `rig import <spec> --materialize-only`, `rig launch <rig> <logical
  id>` (for example `dev.lead`) starts only that never-started seat. Teams materialized by older daemons aren't covered.
- **Clear a prompt a hook still names:** once `rig capture <seat>` shows it's gone, `rig seat clear-attention <seat>
  --reason "<what you saw>"` clears a retained permission or waiting hook, so sends and wakes go through. A refusal that
  rests on such a hook now names this step.

## Behaviour that changed

- **A working Claude seat that quotes approval text** in its output no longer refuses sends and wakes as if it were at
  a prompt, including when its input box is drawn high in a tall pane. The permission dialog, AskUserQuestion and the
  MCP menu still refuse.
- **A Claude draft whose first line is blank** reads as a draft, so a send doesn't type into it or submit it.
- **A draft-aware paste to a Claude seat** is no longer read as edited when Claude swaps its footer for "paste again to
  expand", so OpenRig no longer withholds Enter for that reason. It isn't confirmed to fix #14 (see Known gaps).
- **A send no longer answers a Pi dialog.** At an adopted Pi TUI's selector (a confirmation), an ordinary `rig send`
  used to type and press Enter, choosing the highlighted answer; it now refuses with `target_needs_input` and types
  nothing (#2015). #2026 extends this to Pi v1.4.0 extension input and editor dialogs, including help wrapped over up to
  three rows in an 80-column pane. The audited deliberate-interaction route is unchanged.
- **Runner-managed Pi seats show and cancel an extension dialog** in the pane, so nothing is approved, and need
  attention until their next agent run. On Pi and OMP seats, a second startup block joins the running turn instead of
  failing with "Agent is already processing".
- **A send to a busy Codex seat** warns that the message joins the running turn and may redirect it, and names
  `--wait-for-idle <seconds>` for separate work.
- **A seat with another pane in its tmux session** gets sends and wakes in its recorded pane instead of a refusal.
- **A wake refused at an approval prompt** retries once when the seat's attention clears, instead of waiting for the
  stuck sweep.
- **A seat held at a choice prompt that no hook announces** (a usage-limit dialog, say) now escalates once the refusal
  has held for one retry interval (`queue.wake_retry_interval_seconds`, 300 seconds by default). Choice-prompt alerts
  follow `queue.wake_human_rung`: under `explicit-only` they stay with the operator seat unless that seat is a person.
  Permission-prompt alerts post as before.
- **The parked-owner reminder waits 5 minutes** after a seat starts waiting, so a seat that just handed work off or
  asked a person isn't reminded at once; a seat at an approval or question prompt gets no grace. The reminder tells a
  seat waiting on a person to hold the row (`rig queue block <id> --on <who> --wake-after <duration>`), not ask again.
- **A dead seat's stuck-sweep finding goes to someone who can act:** the operator agent (`agents.operator_session`)
  when set, then the operator seat (`workspace.operator_seat_name`), then the row's creator, skipping any whose session
  is confirmed missing. `workspace.operator_seat_name` still decides where approvals go.
- **Rows OpenRig creates itself** (stuck-sweep findings, workflow escalations, continuity batons, diagnoses run with
  `--apply`) wake from OpenRig's own sender, with no reply line, instead of from the row's creator. When the sweep
  closes its own finding, the actor is `stuck-sweep@system`.
- **A cross-host queue write that times out reads INDETERMINATE,** not failed, and the CLI waits 15 seconds for the
  daemon's answer. When `rig queue create` gets no answer, it reads the row back once by its ID and reports an exact
  match as created. It never sends the create twice.
- **Codex seats keep write access to their git metadata** after resume, fork and a restore without a pod, so they can
  still commit, and to their own topology folder, so they keep `LEARNED.md` and their recap. `rig context recap-write`
  falls back to the daemon when the seat's sandbox refuses the write.
- **Recap writes refuse a link** at `RECAP.md` or `recap-superseded/` with `recap_write_refused`, a layout that used to
  work. Replace the link with a real file or folder.
- **`rig seat restart --keep-conversation` on a Codex seat** keeps a writable root whose path holds a space, proves the
  resume in the `CODEX_HOME` the running Codex uses, and reads complete when a directory it was given has a space. When
  the resume isn't proven, it says the pane restarted, not "nothing was restarted".
- **A Codex seat at Codex 0.164.0's sign-in chooser or API-key entry, or 0.162.1's chooser,** reports
  `attention_required` with `login_required` instead of a readiness timeout. Nothing is typed into the login screen.
- **Resume recognition:** a resumed Codex whose footer shows a display name with a reasoning label (`GPT-6.1 Sol
  medium`) or a non-`gpt` model reads as resumed, so `rig up --existing` doesn't stop. A Claude or Codex resume chooser
  drawn high in a tall pane reads as a chooser, not as resumed.
- **Codex hooks:** when a Codex home has a `hooks.json`, OpenRig puts its activity hooks there at the next Codex seat
  launch and moves its own old block out of `config.toml`. Your hooks, their order, trust and disables stay; your own
  inline hooks stay in `config.toml`. Inline hook trust is keyed by the group's actual position.
- **A managed Claude restore reads its own files without a Read approval:** the seat's marker and restore map, the
  generic or configured extra-instruction file, the restore skill files, restore maps under a configured
  `preparation_root` and the packet files are granted at launch and resume, at both the named and the real path (so
  macOS `/tmp` works).
- **After managed compaction,** a Claude seat's restore starts on the next poll instead of waiting for the screen to
  change. `rig compact --state` and seat status show an owed restore stage and its last delivery result; repeated
  failures open one queue item for the delegation owner.
- **A Claude startup refused late** (an expired login) no longer gets Enter on its next startup input: OpenRig checks
  again before pressing it and reports attention. The text may stay in the input box; don't resend it.
- **A Claude seat with the model alias `haiku` and `plan` mode** gets a line in its launch, restore and `rig seat
  status` results: Claude Code answers plan turns with Sonnet; set a full Haiku id with `rig seat set-model` to keep
  Haiku. Nothing about the launch changes.
- **The model-divergence monitor** no longer flags a Claude seat pinned to an undated id that answers with its dated
  snapshot, or one pinned to a Bedrock cross-Region profile id such as `global.anthropic.<model>`.
- **A pod seat that never launched** starts fresh from its saved launch recipe after a daemon restart, instead of
  sitting at a shell. That starts the harness and can use provider usage. Seats materialized before 0.7.2 have no recipe
  and report `attention_required`, keeping the shell.
- **`rig down` after a team's tmux server died** treats tmux's "no server running" as absence and records the seats
  stopped, so `rig archive` and `rig up` go ahead. A team of plain terminal seats restores as `fully_restored`, and
  `rig down` names the terminal sessions it stops.
- **A launch whose tmux made no session** fails with `session_not_created` or `session_unconfirmed` instead of reporting
  the seat launched. The message says which directory must be writable.
- **Terminal tiles survive a seat's session replacement:** a tile waits up to 30 seconds for the same session and seat
  identity, then reattaches. A fresh replacement's result says how to reopen the view. Input still queued when a
  terminal client disconnects is dropped, not typed.
- **Reopening a Herdr view** with `--provider herdr` adds a workspace each time. From inside Herdr, `rig terminal open
  <view> --window` focuses a matching one. The `openrig-herdr` skill now says so.
- **A service bundle install without Docker Compose v2** stops with `compose_missing` before writing the target or
  creating the team. `rig bundle install --plan` warns instead.
- **`rig export`** copies the declared culture file beside the YAML for a local daemon, and names agent refs that leave
  the folder and a rig still named `starter`.
- **`rig daemon start`:** a backlog of queue wakes no longer holds startup past the CLI's readiness wait. When the
  database-conflict check can't tell (no `lsof`, a timeout, a listener that doesn't answer), startup warns that
  ownership is unknown, under either `daemon.db_conflict` setting.
- **Proof and scope:** proof-source monitoring watches the missions root, not the whole workspace parent. `rig proof
  add <absolute path>` finds a slice in another catalogued project. `rig scope mission create` writes
  `metadata.name`; an older mission without it needs the line added before it compiles. `rig queue whoami` resolves a
  project-tagged row against its catalogued project.
- **Slack:** a registered person's reply to a question parked on someone else reaches the agent as their own message
  and leaves the question parked.
- **`rig context get reference/acp-agents.md`** now returns the guide `rig acp run --help` names.
- **TUI and dashboard:** the focused Table and Overview pages load health findings instead of staying `Not assessed`,
  the activity stream keeps its connection state across pages, and the dashboard shows "boot not tracked" for a skipped
  kernel boot.
- **The kernel operator's guidance** puts a project task on the chosen team's queue rather than doing it itself.
- **`rig auth switch` and `rig provider switch`'s printed undo** say a restored Codex login isn't verified and may need
  a fresh sign-in.

## Output that changed shape

- **`rig capture` and the MCP capture tool** add `promptPane: { width, height, hint }` when a seat at a prompt has a
  pane smaller than 80x24, and the CLI prints the resize hint on stderr.
- **`rig seat status`** shows the seat's runtime home and where it came from, any ignored home, a Claude token
  reference and member tool rules. `--json` always has `permissions.account.advisories`, empty unless a note applies.
- **`rig stream show`** lists each reader's current action, flags `parallelWork`, and reads `readers: "unavailable"`
  from an older daemon. The expired-cursor 410 says how `--since` resumes.
- **Slack posts start with their sender** (`From <seat>`, with ` on <machine>` when known), and a wake-rung escalation
  reads `Waiting on <seat>: <summary>`. Rows from Slack read `<address> via Slack: …`.
- **A wake from a row OpenRig created** ends with "↩ Sent by OpenRig itself, not by a seat. Act on the row it names."
- **Stuck-sweep findings** name the rule that chose their recovery seat, and a stalled-after-claim age counts from the
  stall, not from the claim.
- **The parked diagnosis** reports `activity.since`.
- **Cross-host queue writes:** a timed-out forward's 502 carries `outcome: "indeterminate"`, the CLI's headline reads
  "queue request got no answer in time (routing to host '…')", and a read-back reports "The create committed after all:
  row … (read back by its ID)".
- **`rig queue update --help` and the `closure_fields_not_admitted` refusal** say how to cancel a row.
- **`rig ps --nodes --json`** carries `login_required` for a Codex seat at sign-in; a restore result marks a plain
  terminal seat `noConversation`.
- **A send to a seat mid-switch** is held at once: `outcome: retained`, `reason: runtime_switch_in_progress`.
- **New codes:** `permission_rules_unavailable` (a fork whose source rules can't be read), `occupant_retired_by_switch`
  and `switch_not_committed` (the two processes of a runtime switch), `runtime_unchanged` and the `runtime_switch_*`
  refusals, `session_not_created`, `session_unconfirmed`, `compose_missing`, `rex_outcome_unknown`,
  `invalid_claude_token_selection`, and input checks on `rig stream act`.
- **Help:** 14 subcommands that had no summary have one, and `rig skill audit` ends by saying it doesn't judge whether
  a refresh is safe, naming the read-only `rig skill loadout` check.

## What to stop doing

- **Don't pass `CLAUDE_CONFIG_DIR` or `CODEX_HOME` with `rig up --env`.** Declare the home in `env:`.
- **Don't rebuild a team to move one seat** to the other runtime or another login. Use `rig seat set-runtime` or
  `rig provider switch --seat`.
- **Don't close and re-create to pass work on over MCP.** Use `rig_queue_handoff`.
- **Don't cancel with `--state canceled --closure-reason canceled`.** Use `--state done --closure-reason canceled`.
- **Don't take the first `qitem-…` from `rig queue create`'s merged output.** The request ID on stderr isn't a row:
  read `qitemId` from stdout and check the exit code.
- **Don't retry a cross-host queue write that timed out.** Reconcile by its ID first.
- **Don't reopen a Herdr view with `--provider herdr` to get back to it.** Focus it, or use `--window` from inside Herdr.
- **Don't put one member's tool rules in a shared project's Claude settings.** Use `claude_permissions`.

## Known gaps in 0.7.2

- **On Linux, a seat now gets the daemon's runtime directory with a session bus address that can't connect** (#2036).
  When the daemon has an absolute `XDG_RUNTIME_DIR`, a seat launched, restored or handed over gets it with
  `DBUS_SESSION_BUS_ADDRESS=disabled:`, so its D-Bus clients don't find your session bus on their own. This is a
  default, not isolation: `systemctl --user` reaches your user service manager from a seat. A shell startup file that
  sets only `XDG_RUNTIME_DIR` now leaves the seat with `disabled:`; to use a session bus, set the address in the rig's
  or member's `env:`. A Codex seat's stdio MCP server still needs `env_vars = ["XDG_RUNTIME_DIR"]` in Codex's
  `config.toml` to see the variable. macOS, a daemon started without `XDG_RUNTIME_DIR` and
  `terminal.inherit_tmux_environment` on are unchanged.
- **Per-member Claude tool rules** (#1914): member denies aren't claimed to hold in bypass mode (`full_bypass`).
  Handover and restore carry the rules, but aren't proven to keep the same conversation. Checked natively: two seats in
  one folder each enforce their own rules, a managed policy wins, and fresh, resume and fork launches enforce them.
- **Going back to 0.7.1:** like any version before #1914, it drops the stored member rules from launch, so set
  equivalent native rules first (`docs/reference/rig-spec.md`, "Downgrade"). It also refuses a community preset that
  sets `first_input`. No other way back to 0.7.1 has been tested.
- **Pi dialog recognition is a bounded screen check.** #2015 recognizes Pi's selector by its own chrome; with more than
  six non-blank rows after its border, or under a widget that draws its own border, a send goes through as before.
  #2026 adds Pi v1.4.0's extension input and editor dialogs; clipped or incomplete help, help wrapped over more than
  three rows and custom extension screens keep their earlier reading, and a draft that copies a dialog's whole frame
  reads as that dialog. Each was checked natively on its own cases (#2015 its confirmation dialog, #2026 the input and
  editor dialogs on its own build), not on every layout. Check the pane before sending to an adopted Pi seat that may be
  at a dialog. Neither
  check was repeated on the final 0.7.2 build.
- **In draft-aware mode, an agent's multi-line message to a Claude seat can remain unsubmitted when the paste changes
  Claude's footer hint.** OpenRig withholds Enter, leaving the text in the composer and later sends waiting. Observed on
  Claude 2.1.309 with both 0.7.0 and the 0.7.1 pre-cut build. 0.7.2 treats the "paste again to expand" hint as part of
  the composer, but the original failure didn't reproduce in its native check, so this isn't confirmed fixed; #14
  remains open.
- **An idle Claude seat whose recent output quotes prompt text** can still read as at a prompt and refuse sends, as can
  a seat with a draft, a mode bar OpenRig doesn't recognise or an unframed input box. Check the pane.
- **A Claude startup refusal that arrives after OpenRig's last check can still race Enter.** If a seat with an expired
  login shows staged text in its input box, sign in, then clear or send that text yourself.
- **A managed Claude restore can still ask for a Read approval** when `policies.claude_compaction.message_file_path` is
  relative, or for a packet file after a resume changed the conversation id. The session transcript isn't granted. A native
  check on Claude 2.1.309 passed the Read grants with no approval prompt; a complete restore with no help isn't claimed.
- **`rig seat set-runtime`:** Claude launch additions such as an agent file aren't applied to a switched seat, startup
  slash commands aren't run, and a person typing into the old pane of a draft-aware seat stops the switch (the current
  occupant keeps the seat). A message sent during a switch is held and must be sent again.
- **A seat's own account:** a conversation saved under a seat's earlier home doesn't resume in its new one, and live
  usage refresh (`rig provider status --refresh`) still reads only the daemon's own logins. `rig provider switch --seat`
  moves a Codex seat on Linux only. Other seats on that Codex home keep the old login until their next token refresh,
  then stop: run the restart command the switch printed for each.
- **Seat account and runtime moves weren't run with real accounts before this release** (#1895, #1937, #1972, #1980).
  The tests use stubs; check a moved seat's account and conversation yourself after the first move.
- **A Codex seat whose queue-state folder or team workspace path holds a space** can still read as not resumed after an
  ordinary resume or restore. An in-place restart is fixed.
- **Choice-prompt alerts go to a person one at a time per machine.** While the first one's seat stays blocked, later
  choice alerts wait unposted; they're visible as rows.
- **Herdr's own status for a seat can read idle or unknown while OpenRig shows it waiting** (`needs-input`). Use
  OpenRig's view or the Feed to find waiting seats.
- **Proof-source watching still recurses through a large missions tree,** and the reported Linux daemon stalls (#1813)
  weren't reproduced to confirm that the narrower watch helps.
- **A Claude seat signed in with a long-lived token (`claude setup-token`) gets no automatic usage reading;** the reader
  reports `not_subscription_login`. Read one on demand with `rig provider status --refresh --provider claude
  --claude-token-file <path> --credential-label <label>`, which spends a model turn.
- **A new Claude seat's startup text can stay in its input box unsent.** If a fresh Claude seat sits idle with text at
  its prompt, press Enter in its pane, or ask the person to.
- **Claude seats on a macOS native install can read as needing attention after a restore.** Check the pane before
  acting on it.
- **A Slack channel-mapping change needs a daemon restart.** Don't use `rig slack disable` then `enable` for it: enabling
  marks any alerts waiting to post to Slack as already seen.
- **Ubuntu 22.04's tmux 3.2a:** the query known to crash its server is gone, but a narrower race remains. Avoid 3.2a
  (`tmux -V`).
- **`rig daemon start` can take 20 to 40 seconds** before its listener warning, longer than the TUI's 30-second "restore
  everything" wait. On a slow host, start the daemon yourself first.
- **A launch that warns "Scoped tmux environment unavailable; retaining the previous environment"** didn't give that seat
  the clean environment. Check `env` in the seat before relying on OpenRig's variables.
- **A Herdr tile over SSH** doesn't come back by itself after a Herdr restart. Reopen it with `rig terminal open <view>
  --provider herdr`, which adds a new workspace; close the old one.
- **Delegated decisions:** the ask is created before the decision, so without quiet hours it can post to the person
  first. Pair a decision room with quiet hours, or decide before asking.
- **`restore-check` still treats a missing startup file as rig-wide.** Trust `rig up --existing`'s per-seat result.
- **Managed Claude launch requires `/usr/bin/env` support for `-0` and `-u`** (option support checked on GNU coreutils
  and macOS 15; BusyBox and older macOS unverified). Without the required option support, launch stops instead of
  falling back to credential-bearing command-line arguments.
