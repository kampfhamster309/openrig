# DEMO-C: add a top-words tool, with the rules spelled out

The project counts a file's lines and words. The next step is the more useful question: which words
are in it most. Add that as its own tool, with the rules below settled in advance so you do not have to
invent them.

## How this team works

One seat: you. There is no reviewer to ask, so the completion contract's review step is satisfied by
your own passing run of `sh test/run.sh`. Do not look for a peer or wait for one.

## The tool: `bin/top-words.sh FILE [n]`

Writes the `n` most frequent words of FILE, one per line, as `<count> <word>`.

- `n` defaults to `5`. `n < 1` is a usage error: exit `2`, message on stderr.
- A word is a maximal run of letters, digits, `'` and `-`, so `don't`, `well-known` and `3rd` are each
  one word. Everything else separates words.
- Case-insensitive for counting: `The` and `the` are the same word. Print the form that appeared
  **first** in the file.
- Sort by count descending, then by the printed word ascending, byte order. Truncate to `n` **after**
  sorting, so a tie at the cut is broken by the alphabetical rule rather than by chance.
- A missing or unreadable FILE exits `2` with a message on stderr, like `wordcount.sh` does. An empty
  file writes nothing and exits `0`.
- No dependencies beyond `sh`, `tr`, `sort`, `uniq` and `sed`.

## The checks

Add a `test/top-words.sh` with the suite in the same style as `test/run.sh`, and call it from
`test/run.sh` so one command still runs everything. Cover at least: the counts for `data/sample.txt`,
the default `n`, an explicit `n` smaller than the number of distinct words, the case-folding rule with
the first-seen spelling, the tie broken alphabetically, `n < 1` exiting 2, and an empty file.

Add a short section to `README.md` showing the command and its output for `data/sample.txt`.

## Part 2: `--min-count`, and the second file

Only after part 1 passes. `bin/top-words.sh` gains `--min-count N`, which drops words appearing fewer
than `N` times. It composes with `n` in this order: filter by count first, then sort, then truncate to
`n`. `N < 1` is a usage error, exit `2`. It works with the flag before or after the file argument, so
both `top-words.sh --min-count 2 FILE` and `top-words.sh FILE --min-count 2` are valid.

Add `data/two.txt` — a few lines of your own, at least 8 words, with one word appearing 3 times, one
exactly 2 times and at least two appearing once — and extend `test/top-words.sh` with: `--min-count 2`
keeps the 3-times and 2-times words and drops the singletons; `--min-count` with no number is a usage
error exiting 2; the flag in either position gives the same output; and `--min-count` larger than the
biggest count writes nothing and exits 0.

Add the new flag to the `README.md` section you wrote.

## Finish

Run `sh test/run.sh` and see every check pass — yours and the ones already there. Commit on the branch
the contract names, then write the result file the contract names. Touch only `bin/top-words.sh`,
`test/top-words.sh`, `test/run.sh`, `data/two.txt` and `README.md`.
