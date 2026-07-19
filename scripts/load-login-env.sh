#!/usr/bin/env bash

set -euo pipefail

LOGIN_ENV_FILE="${AGENTIC_QA_LOGIN_ENV:-/Users/skaligotla/agentic-qa-credentials/login.env}"

if [[ ! -f "$LOGIN_ENV_FILE" ]]; then
  echo "::error::Login environment file not found: $LOGIN_ENV_FILE"
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$LOGIN_ENV_FILE"
set +a

for variable in \
  LOGIN_URL_UAT \
  LOGIN_URL_PROD \
  TEST_LOGIN_EMAIL \
  TEST_LOGIN_PASSWORD
do
  value="${!variable:-}"

  if [[ -z "$value" ]]; then
    echo "::error::$variable is missing from $LOGIN_ENV_FILE"
    exit 1
  fi

  echo "::add-mask::$value"

  if [[ -n "${GITHUB_ENV:-}" ]]; then
    echo "$variable=$value" >> "$GITHUB_ENV"
  fi
done

echo "Deterministic login configuration loaded."
