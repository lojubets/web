#!/bin/bash
set -euo pipefail

if ! command -v turso >/dev/null 2>&1; then
  echo "The turso CLI is not installed. See https://docs.turso.tech/cli/installation" >&2
  exit 1
fi

# `turso auth whoami` exits 0 whether or not you're logged in, so we have to
# look at what it prints rather than its exit code.
turso_logged_in() {
  ! turso auth whoami 2>&1 | grep -qi "not logged in"
}

if ! turso_logged_in; then
  echo "You are not logged in to the turso CLI."
  read -r -p "Log in now with 'turso auth login'? [Y/n] " answer
  case "${answer:-Y}" in
    [Yy]*) turso auth login ;;
    *)
      echo "Aborting: run 'turso auth login' and then run this script again." >&2
      exit 1
      ;;
  esac
  if ! turso_logged_in; then
    echo "Still not logged in to the turso CLI. Aborting." >&2
    exit 1
  fi
fi

mkdir -p dumps

turso db shell lojubets '.dump' > dumps/turso-lojubets-$(date +%Y%m%d%H%M%S).sql
turso db shell lojubets-dev '.dump' > dumps/turso-lojubets-dev-$(date +%Y%m%d%H%M%S).sql
