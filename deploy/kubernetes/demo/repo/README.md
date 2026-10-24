# wordcount

A small teaching project: one shell script that counts a file, and the test that says it still works.
It has no dependencies on purpose — everything here runs with what is already on the machine, so a
change is checked in under a second.

## Use

```sh
bin/wordcount.sh data/sample.txt   # -> "3 12": lines, then words
sh test/run.sh                     # the whole suite
```

## Layout

| Path | What it is |
|---|---|
| `bin/wordcount.sh` | The tool. Prints `<lines> <words>` for one file. |
| `data/` | Sample files the test counts. |
| `test/run.sh` | The suite. Prints one line per check, exits non-zero if any failed. |

## Changing it

Run `sh test/run.sh` before and after your change, and add a check for what you changed. The suite is
the project's only gate, so a change with no check in it is not finished.
