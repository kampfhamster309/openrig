#!/bin/sh
# wordcount FILE -- prints "<lines> <words>" for FILE, in that order.
#
# Two numbers and nothing else, so the output is easy to compare against in a test. A file that is
# missing or unreadable is a usage error (exit 2), not a count of zero: "0 0" is a real answer about
# an empty file, and it must not be confused with "I could not read that".
set -eu

if [ $# -ne 1 ]; then
  echo "usage: wordcount FILE" >&2
  exit 2
fi

if [ ! -r "$1" ]; then
  echo "wordcount: cannot read $1" >&2
  exit 2
fi

lines=$(wc -l < "$1" | tr -d ' ')
words=$(wc -w < "$1" | tr -d ' ')
printf '%s %s\n' "$lines" "$words"
