# DEMO-B: give wordcount a --help

`bin/wordcount.sh` prints its usage line only when it is called wrong, so there is no way to ask it
how it is used. Add one. This is deliberately small: it should take you a few minutes, start to finish.

## How this team works

One seat: you. There is no reviewer to ask, so the completion contract's review step is satisfied by
your own passing run of `sh test/run.sh`. Do not look for a peer or wait for one. Nobody is watching your
terminal either: a question or a permission prompt on your own screen reaches no one and the team waits
there forever. Nothing in this brief needs one — it settles every choice — so decide and carry on.

## The change

1. `wordcount -h` and `wordcount --help` — each **as the only argument** — print `usage: wordcount FILE`
   to **stdout** and exit `0`. The tool takes one argument, a file, so there is no "position" to get
   wrong: the flag replaces the file argument, it is not added beside it. A request for help is not an
   error, so it must not exit 2 like the existing usage failures do.
2. Nothing else changes: same output for a real file, same exit `2` for a missing file or no argument.

## The checks

Add to `test/run.sh`, in the same style as the checks already there:

- `--help` prints the usage line and exits 0.
- `-h` does the same.

Run `sh test/run.sh`, see every check pass, commit on the branch the contract names, and write the
result file the contract names. Touch only `bin/wordcount.sh` and `test/run.sh`.

**In that order, and nothing before it.** The commit exists, then `result.json` names its sha, then the
queue item closes — never the other way round. A closed row with an uncommitted tree and no result file is
not a finished ticket: the person running this demo is waiting on the result file, and nothing will come
to ask you for the rest. If you find yourself with a passing suite and no commit, that is the step you
skipped; make the commit now.
