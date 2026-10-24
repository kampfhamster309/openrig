#!/bin/sh
# The project's whole test suite. No dependencies, no build step: one line per check on stdout, and a
# non-zero exit if any of them failed.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
tool="$root/bin/wordcount.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fail=0
check() { # <name> <want> <got>
  if [ "$2" = "$3" ]; then printf '  ok    %s\n' "$1"
  else printf '  FAIL  %s (want [%s], got [%s])\n' "$1" "$2" "$3"; fail=$((fail + 1)); fi
}

check "the sample counts 3 lines and 12 words" "3 12" "$("$tool" "$root/data/sample.txt")"

: > "$work/empty.txt"
check "an empty file is 0 0, not an error" "0 0" "$("$tool" "$work/empty.txt")"

"$tool" "$work/not-there.txt" >/dev/null 2>&1 && rc=ran || rc=$?
check "a file that is not there fails with 2" "2" "$rc"

"$tool" >/dev/null 2>&1 && rc=ran || rc=$?
check "no argument at all fails with 2" "2" "$rc"

if [ "$fail" != 0 ]; then
  printf '%s check(s) failed\n' "$fail" >&2
  exit 1
fi
echo "all checks passed"
