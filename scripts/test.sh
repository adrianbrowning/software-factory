#!/bin/sh
# Runs the named test files, or every test/*.test.ts file when none are given.
if [ "$#" -eq 0 ]; then set -- test/*.test.ts; fi
exec node --import ./test/git-env.ts --test "$@"
