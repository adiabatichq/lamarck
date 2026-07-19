#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_PATH="${ROOT_DIR}/helper/ax-helper.swift"
OUT_DIR="${ROOT_DIR}/bin"
OUT_PATH="${OUT_DIR}/ax-helper"
DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-13.0}"
SWIFTC_BIN="${SWIFTC:-swiftc}"
BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/lamarck-macos-ax-helper.XXXXXX")"

cleanup() {
  rm -rf "${BUILD_DIR}"
}
trap cleanup EXIT

mkdir -p "${OUT_DIR}" "${BUILD_DIR}/module-cache"

build_slice() {
  local arch="$1"
  local output="$2"
  CLANG_MODULE_CACHE_PATH="${BUILD_DIR}/module-cache" \
    "${SWIFTC_BIN}" \
      -O \
      -target "${arch}-apple-macosx${DEPLOYMENT_TARGET}" \
      "${SOURCE_PATH}" \
      -o "${output}"
}

build_slice arm64 "${BUILD_DIR}/ax-helper-arm64"
build_slice x86_64 "${BUILD_DIR}/ax-helper-x86_64"

lipo -create \
  "${BUILD_DIR}/ax-helper-arm64" \
  "${BUILD_DIR}/ax-helper-x86_64" \
  -output "${OUT_PATH}"

chmod 755 "${OUT_PATH}"

if command -v codesign >/dev/null 2>&1; then
  codesign --force --sign - "${OUT_PATH}" >/dev/null
fi

file "${OUT_PATH}"
