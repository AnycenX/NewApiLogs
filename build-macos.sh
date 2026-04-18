#!/usr/bin/env bash

set -euo pipefail

MODE="${1:-release}"
INSTALL="${INSTALL:-0}"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAURI_TARGET_DIR="$PROJECT_ROOT/src-tauri/target"

write_step() {
  printf '\n==> %s\n' "$1"
}

run_command() {
  printf '> %s\n' "$*"
  "$@"
}

ensure_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Command not found: %s. %s\n' "$1" "$2" >&2
    exit 1
  fi
}

maybe_load_cargo() {
  if ! command -v cargo >/dev/null 2>&1 && [[ -f "$HOME/.cargo/env" ]]; then
    # shellcheck disable=SC1090
    source "$HOME/.cargo/env"
  fi
}

sign_app_bundle() {
  local app_path="$1"
  local identity="${APPLE_SIGNING_IDENTITY:--}"

  write_step "Signing macOS app bundle"
  if [[ "$identity" == "-" ]]; then
    printf 'Using ad hoc signature for local validation.\n'
  else
    printf 'Using signing identity: %s\n' "$identity"
  fi

  run_command codesign --force --deep --sign "$identity" --timestamp=none "$app_path"
  run_command codesign --verify --deep --strict --verbose=4 "$app_path"
}

show_outputs() {
  local build_mode="$1"
  local bundle_root="$TAURI_TARGET_DIR/$build_mode/bundle"
  local app_path=""
  local dmg_path=""

  if [[ -d "$bundle_root/macos" ]]; then
    app_path="$(find "$bundle_root/macos" -maxdepth 1 -name '*.app' -print -quit)"
  fi

  if [[ -d "$bundle_root/dmg" ]]; then
    dmg_path="$(find "$bundle_root/dmg" -maxdepth 1 -name '*.dmg' -print -quit)"
  fi

  write_step "Build outputs"
  if [[ -n "$app_path" ]]; then
    printf 'app: %s\n' "$app_path"
  fi
  if [[ -n "$dmg_path" ]]; then
    printf 'dmg: %s\n' "$dmg_path"
  fi
}

cd "$PROJECT_ROOT"

ensure_command npm "Install Node.js first and make sure npm is available."
maybe_load_cargo

if [[ "$INSTALL" == "1" || ! -d "$PROJECT_ROOT/node_modules" ]]; then
  write_step "Installing frontend dependencies"
  run_command npm install
fi

case "$MODE" in
  frontend)
    write_step "Running frontend build"
    run_command npm run build
    write_step "Done"
    printf 'dist: %s\n' "$PROJECT_ROOT/dist"
    ;;
  check)
    ensure_command cargo "Install Rust first or make sure \$HOME/.cargo/bin is in PATH."
    write_step "Running cargo check"
    (
      cd "$PROJECT_ROOT/src-tauri"
      run_command cargo check
    )
    write_step "Done"
    ;;
  debug|release)
    ensure_command cargo "Install Rust first or make sure \$HOME/.cargo/bin is in PATH."
    write_step "Running $MODE package build"
    if [[ "$MODE" == "debug" ]]; then
      run_command npm run tauri build -- --debug
    else
      run_command npm run tauri build
    fi

    app_path="$(find "$TAURI_TARGET_DIR/$MODE/bundle/macos" -maxdepth 1 -name '*.app' -print -quit)"
    if [[ -z "$app_path" ]]; then
      printf 'No .app bundle found under %s\n' "$TAURI_TARGET_DIR/$MODE/bundle/macos" >&2
      exit 1
    fi

    sign_app_bundle "$app_path"
    show_outputs "$MODE"

    if [[ "${APPLE_SIGNING_IDENTITY:-}" == "" ]]; then
      write_step "Signing note"
      printf 'The app now has a valid ad hoc signature for local verification.\n'
      printf 'Gatekeeper still requires a real Apple Developer ID signature and notarization.\n'
    fi
    ;;
  *)
    printf 'Unsupported mode: %s\n' "$MODE" >&2
    printf 'Supported modes: release, debug, frontend, check\n' >&2
    exit 1
    ;;
esac

write_step "All done"
