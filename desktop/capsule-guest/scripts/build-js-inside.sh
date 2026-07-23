#!/bin/sh

set -eu

snapshot="${LAMARCK_BUILD_SNAPSHOT:-/snapshot}"
export_root="${LAMARCK_JS_BUILD_EXPORT:-/prebuilt}"
work=/work/js-build

test "$(node --version)" = v24.10.0
test "$(npm --version)" = 11.6.1
node "$snapshot/desktop/capsule-guest/scripts/prepare-build-snapshot.mjs" verify "$snapshot"
[ -d "$export_root" ] || { echo "JavaScript build export is unavailable" >&2; exit 73; }
[ -z "$(find "$export_root" -mindepth 1 -maxdepth 1 -print -quit)" ] || {
	echo "JavaScript build export is not empty" >&2
	exit 73
}

rm -rf "$work"
mkdir -p "$work/source" "$work/home" "$work/npm-cache"
cp -a "$snapshot/." "$work/source/"
cd "$work/source"
HOME="$work/home" node \
	"$work/source/desktop/capsule-guest/scripts/verify-guest-node-closure.mjs" \
	"$work/source"
HOME="$work/home" npm ci \
	--workspace @lamarck/capsule-guest \
	--include-workspace-root=false \
	--ignore-scripts \
	--audit=false \
	--fund=false \
	--update-notifier=false \
	--registry=https://registry.npmjs.org \
	--cache="$work/npm-cache" \
	--userconfig=/dev/null
HOME="$work/home" node \
	"$work/source/desktop/capsule-guest/scripts/build-supervisor.mjs"

mkdir -p "$export_root/capsule-guest"
cp -R --no-preserve=mode,ownership,timestamps \
	"$work/source/desktop/capsule-guest/dist" "$export_root/capsule-guest/dist"
node "$snapshot/desktop/capsule-guest/scripts/generate-js-builder-inventory.mjs" \
	"$snapshot" "$work/source" "$export_root"
node "$snapshot/desktop/capsule-guest/scripts/verify-js-builder-output.mjs" \
	"$export_root" "$snapshot"
node "$snapshot/desktop/capsule-guest/scripts/prepare-build-snapshot.mjs" verify "$snapshot"
