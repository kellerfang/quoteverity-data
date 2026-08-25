#!/bin/sh
set -eu

lock_file="/var/lock/quoteverity-data-refresh.lock"
key_file="/opt/quoteverity-data/deploy_key"
run_dir=""

exec 9>"$lock_file"
flock -n 9 || exit 0

cleanup() {
  if [ -n "$run_dir" ] && [ -d "$run_dir" ]; then
    rm -rf -- "$run_dir"
  fi
}
trap cleanup EXIT INT TERM

run_dir="$(mktemp -d /opt/quoteverity-data/run.XXXXXX)"
export GIT_SSH_COMMAND="ssh -i $key_file -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes"

git clone --depth 1 git@github.com:kellerfang/quoteverity-data.git "$run_dir/repo"

docker run --rm \
  --volume "$run_dir/repo:/work" \
  --workdir /work \
  node:22-alpine \
  sh -lc 'npm install --global pnpm@11.19.0 && pnpm install --frozen-lockfile && pnpm refresh && pnpm validate'

cd "$run_dir/repo"
git config user.name "QuoteVerity Data Bot"
git config user.email "data-bot@quoteverity.com"
git add dist/model-data.json

if git diff --cached --quiet; then
  exit 0
fi

git commit -m "data: publish validated official-source snapshot"
git push origin main
