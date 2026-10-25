# DEMO-A: settle the output order with the human, then implement it

`bin/wordcount.sh` prints two numbers, `<lines> <words>`. A colleague reads pairs the other way round
and keeps misreading them, so the order is now an interface decision rather than a detail. It is not
yours to make alone: ask, then build what was chosen.

## How this team works

One seat: you. There is no reviewer to ask, so the completion contract's review step is satisfied by
your own passing run of `sh test/run.sh`. Do not look for a peer or wait for one.

## 1. Ask first — change nothing until the answer arrives

**Ask on the queue, and nowhere else.** Nobody is watching your terminal. A question the runtime puts on
your own screen — Claude Code's question dialog, a permission prompt, anything that waits for a keystroke
in this pane — reaches no one, and the team sits there until the talk is over. `rig queue block` is the
only way to ask here, so open no dialog of your own to begin with: once one is on your screen your turn is
suspended waiting for it, which means you cannot press `Esc`, cannot re-read this paragraph, and cannot
park the row. Only a person at that terminal can end it. Decide, and carry on.

Find your own ticket item — it is the row tagged with this ticket — then park it on the human with
exactly one either/or question:

```sh
rig queue list -a -A --json | jq -r '.[] | select((.tags // []) | index("ticket:demo-a")) | .qitemId'
rig queue block <qitem> --on human@host \
  --summary "wordcount output order: keep '<lines> <words>' (A) or switch to '<words> <lines>' (B)?" \
  --evidence-ref bin/wordcount.sh \
  --continuation "Implement the chosen order in bin/wordcount.sh and pin it in test/run.sh." \
  --wake-after 4h --json
```

The `4h` is deliberate and is not a guess about how patient the human is. This team is started about an
hour before a fifteen-minute talk, so a short timer would fire mid-demo, wake you with no answer, and
hand you a continuation that reads "implement the chosen order" — the one moment where choosing for
yourself would look reasonable. Four hours is past the end of the talk, so the timer is a backstop
against a lost row and never a nudge to decide. If you *are* woken and the item still carries no
decision: re-read the row, and stop again. Do not pick an option.

Name both options in that order so the answer can be one letter. Then **stop**: no edits, no commit,
while the item is parked. **Do not write the result file either.** The completion contract offers a
`needs-human` status for work that is stuck on a person, and it tells you to write it and ask on the
queue — but you have just asked on the queue, so the row *is* the question and the file must stay
unwritten. Writing `needs-human` here makes the team look finished rather than waiting, and the person
running this demo is watching the parked row, not the file. Write the result file only once the answer
has arrived and you are actually continuing.

The answer arrives as a resolve on that same item and wakes you; read the decision text and use it,
whatever it says.

## 2. Implement the choice

- **A** — the tool already prints the chosen order, so there is nothing to change in `bin/wordcount.sh`.
  Say so with a check rather than with an empty commit: add to `test/run.sh` a check that the output for
  `data/sample.txt` is **exactly two whitespace-separated fields** and that both are digits, which the
  existing `3 12` check does not pin (it would still pass if a third field appeared). Commit that check
  and say in the message that the order was kept deliberately.
- **B** — swap the two numbers in `bin/wordcount.sh`, update its header comment, and update every
  check in `test/run.sh` and the example in `README.md` to the new order.

Either way: run `sh test/run.sh` and see it pass, commit on the branch the contract names, and write
the result file the contract names. Keep it to those files; do not refactor anything else.
