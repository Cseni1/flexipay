#!/usr/bin/env bash
# Fails if the other product's brand name appears in FlexiPay's real-code folders.
# Scope: apps/, packages/, contracts/, config/, scripts/. Excluded: any demo-data/ folder
# (the agreed one is scripts/seed/demo-data/, for sample data a human adds for the pitch),
# docs/ and legacy/ (outside the scope anyway).
# Usage: check-separation.sh            check tracked files in the working tree (CI)
#        check-separation.sh --staged   check the staged content (pre-commit)
set -euo pipefail

PATTERN='flexi[w]ork' # the brackets keep this file from matching itself
FOLDERS=(apps packages contracts config scripts)
EXCLUDE=(':(exclude,glob)**/demo-data/**')

cd "$(git rev-parse --show-toplevel)"
cached=""
if [ "${1:-}" = --staged ]; then
	cached="--cached"
fi

found=0
if git grep $cached -n -i -I -E "$PATTERN" -- "${FOLDERS[@]}" "${EXCLUDE[@]}"; then
	found=1
fi
if git ls-files $cached -- "${FOLDERS[@]}" "${EXCLUDE[@]}" | grep -i -E "$PATTERN"; then
	found=1
fi

if [ "$found" = 1 ]; then
	echo "Separation check failed: the name above must not appear in apps/, packages/, contracts/, config/ or scripts/." >&2
	echo "Sample data that needs it belongs in a demo-data/ folder." >&2
	exit 1
fi
echo "Separation check passed."
