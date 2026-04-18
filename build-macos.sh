#!/usr/bin/env bash

set -euo pipefail

MODE="${1:-release}"
RELEASE_STRATEGY="${2:-${MACOS_RELEASE_STRATEGY:-local}}"
INSTALL="${INSTALL:-0}"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAURI_TARGET_DIR="$PROJECT_ROOT/src-tauri/target"
CREATED_DMG_PATH=""

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

ensure_release_strategy() {
  case "$RELEASE_STRATEGY" in
    local|sign|publish)
      ;;
    *)
      printf 'Unsupported macOS release strategy: %s\n' "$RELEASE_STRATEGY" >&2
      printf 'Supported strategies: local, sign, publish\n' >&2
      exit 1
      ;;
  esac
}

find_latest_match() {
  local dir="$1"
  local pattern="$2"
  local matches=()

  shopt -s nullglob
  matches=("$dir"/$pattern)
  shopt -u nullglob

  if [[ "${#matches[@]}" -eq 0 ]]; then
    return 1
  fi

  ls -td "${matches[@]}" 2>/dev/null | head -n 1
}

has_real_signing_identity() {
  [[ -n "${APPLE_SIGNING_IDENTITY:-}" && "${APPLE_SIGNING_IDENTITY}" != "-" ]]
}

has_app_store_connect_credentials() {
  [[ -n "${APPLE_API_ISSUER:-}" && -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_KEY_PATH:-}" ]]
}

has_apple_id_notarization_credentials() {
  [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]
}

has_notarization_credentials() {
  has_app_store_connect_credentials || has_apple_id_notarization_credentials
}

ensure_signing_requirements() {
  if ! has_real_signing_identity; then
    printf 'A Developer ID signing identity is required for "%s" mode.\n' "$RELEASE_STRATEGY" >&2
    printf 'Set APPLE_SIGNING_IDENTITY to the value from `security find-identity -v -p codesigning`.\n' >&2
    exit 1
  fi
}

ensure_notarization_requirements() {
  if ! has_notarization_credentials; then
    printf 'Notarization credentials are required for publish mode.\n' >&2
    printf 'Provide either APPLE_API_ISSUER + APPLE_API_KEY + APPLE_API_KEY_PATH or APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID.\n' >&2
    exit 1
  fi

  if [[ -n "${APPLE_API_KEY_PATH:-}" && ! -f "${APPLE_API_KEY_PATH}" ]]; then
    printf 'APPLE_API_KEY_PATH does not exist: %s\n' "${APPLE_API_KEY_PATH}" >&2
    exit 1
  fi
}

app_bundle_version() {
  local app_path="$1"
  /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app_path/Contents/Info.plist"
}

app_bundle_executable() {
  local app_path="$1"
  /usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app_path/Contents/Info.plist"
}

app_bundle_arch() {
  local app_path="$1"
  local executable_name=""
  local raw_archs=""

  executable_name="$(app_bundle_executable "$app_path")"
  raw_archs="$(lipo -archs "$app_path/Contents/MacOS/$executable_name")"

  if [[ "$raw_archs" == *"arm64"* && "$raw_archs" == *"x86_64"* ]]; then
    printf 'universal'
  elif [[ "$raw_archs" == "arm64" ]]; then
    printf 'aarch64'
  elif [[ "$raw_archs" == "x86_64" ]]; then
    printf 'x86_64'
  else
    printf '%s' "${raw_archs// /_}"
  fi
}

sign_app_bundle() {
  local app_path="$1"
  local identity="${APPLE_SIGNING_IDENTITY:--}"
  local codesign_args=(--force --deep --sign "$identity")

  write_step "Signing macOS app bundle"
  if [[ "$identity" == "-" ]]; then
    printf 'Using ad hoc signature for local validation.\n'
    codesign_args+=(--timestamp=none)
  else
    printf 'Using signing identity: %s\n' "$identity"
    codesign_args+=(--options runtime --timestamp)
  fi

  run_command codesign "${codesign_args[@]}" "$app_path"
  run_command codesign --verify --deep --strict --verbose=4 "$app_path"
}

run_tauri_bundle() {
  local build_mode="$1"

  if [[ "$build_mode" == "debug" ]]; then
    run_command npm run tauri build -- --debug --bundles app,dmg
  else
    run_command npm run tauri build -- --bundles app,dmg
  fi
}

run_tauri_bundle_without_signing() {
  local build_mode="$1"

  if [[ "$build_mode" == "debug" ]]; then
    run_command npm run tauri build -- --debug --bundles app --no-sign
  else
    run_command npm run tauri build -- --bundles app --no-sign
  fi
}

create_dmg_from_signed_app() {
  local build_mode="$1"
  local app_path="$2"
  local identity="${APPLE_SIGNING_IDENTITY:--}"
  local bundle_root="$TAURI_TARGET_DIR/$build_mode/bundle"
  local dmg_root="$bundle_root/dmg"
  local app_name=""
  local app_version=""
  local app_arch=""
  local dmg_path=""
  local staging_dir=""

  app_name="$(basename "$app_path" .app)"
  app_version="$(app_bundle_version "$app_path")"
  app_arch="$(app_bundle_arch "$app_path")"
  dmg_path="$dmg_root/${app_name}_${app_version}_${app_arch}.dmg"
  staging_dir="$(mktemp -d)"

  mkdir -p "$dmg_root"
  rm -f "$dmg_root"/*.dmg

  write_step "Creating DMG from signed app bundle"
  run_command ditto "$app_path" "$staging_dir/$(basename "$app_path")"
  run_command ln -s /Applications "$staging_dir/Applications"
  run_command hdiutil create -volname "$app_name" -srcfolder "$staging_dir" -ov -format UDZO "$dmg_path"

  if [[ "$identity" != "-" ]]; then
    write_step "Signing DMG"
    run_command codesign --force --sign "$identity" --timestamp "$dmg_path"
    run_command codesign --verify --verbose=4 "$dmg_path"
  fi

  rm -rf "$staging_dir"
  CREATED_DMG_PATH="$dmg_path"
}

verify_app_bundle() {
  local app_path="$1"

  write_step "Verifying macOS app bundle"
  run_command codesign --verify --deep --strict --verbose=4 "$app_path"
}

verify_dmg_signature() {
  local dmg_path="$1"

  write_step "Verifying DMG signature"
  run_command codesign --verify --verbose=4 "$dmg_path"
}

verify_dmg_contents() {
  local dmg_path="$1"
  local app_name="$2"
  local mount_dir=""

  mount_dir="$(mktemp -d)"

  write_step "Verifying app inside DMG"
  run_command hdiutil attach "$dmg_path" -mountpoint "$mount_dir" -nobrowse -quiet
  run_command codesign --verify --deep --strict --verbose=4 "$mount_dir/$app_name"
  run_command hdiutil detach "$mount_dir" -quiet
  rm -rf "$mount_dir"
}

show_release_notes() {
  case "$RELEASE_STRATEGY" in
    local)
      write_step "Signing note"
      printf 'The app and DMG now keep a valid ad hoc signature for local installation tests.\n'
      printf 'Gatekeeper still requires a real Apple Developer ID signature and notarization.\n'
      ;;
    sign)
      write_step "Release note"
      printf 'Developer ID signing is enabled, but notarization was skipped.\n'
      printf 'For public downloads, use publish mode so Gatekeeper can verify the app without manual bypass.\n'
      ;;
    publish)
      write_step "Release note"
      printf 'Tauri performed Developer ID signing and attempted notarization using your Apple credentials.\n'
      printf 'If Apple accepted the submission, the generated app and DMG are ready for distribution.\n'
      ;;
  esac
}

show_outputs() {
  local build_mode="$1"
  local bundle_root="$TAURI_TARGET_DIR/$build_mode/bundle"
  local app_path=""
  local dmg_path=""

  if [[ -d "$bundle_root/macos" ]]; then
    app_path="$(find_latest_match "$bundle_root/macos" '*.app' || true)"
  fi

  if [[ -d "$bundle_root/dmg" ]]; then
    dmg_path="$(find_latest_match "$bundle_root/dmg" '*.dmg' || true)"
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
ensure_release_strategy

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
    ensure_command hdiutil "Install Xcode Command Line Tools first so hdiutil is available."
    ensure_command ditto "macOS ditto is required to preserve the app bundle signature."
    write_step "Running $MODE package build ($RELEASE_STRATEGY)"

    case "$RELEASE_STRATEGY" in
      local)
        run_tauri_bundle_without_signing "$MODE"

        app_path="$(find_latest_match "$TAURI_TARGET_DIR/$MODE/bundle/macos" '*.app' || true)"
        if [[ -z "$app_path" ]]; then
          printf 'No .app bundle found under %s\n' "$TAURI_TARGET_DIR/$MODE/bundle/macos" >&2
          exit 1
        fi

        sign_app_bundle "$app_path"
        create_dmg_from_signed_app "$MODE" "$app_path"
        verify_app_bundle "$app_path"
        verify_dmg_contents "$CREATED_DMG_PATH" "$(basename "$app_path")"
        ;;
      sign)
        ensure_signing_requirements
        run_tauri_bundle "$MODE"

        app_path="$(find_latest_match "$TAURI_TARGET_DIR/$MODE/bundle/macos" '*.app' || true)"
        dmg_path="$(find_latest_match "$TAURI_TARGET_DIR/$MODE/bundle/dmg" '*.dmg' || true)"
        if [[ -z "$app_path" || -z "$dmg_path" ]]; then
          printf 'Expected signed .app and .dmg outputs under %s\n' "$TAURI_TARGET_DIR/$MODE/bundle" >&2
          exit 1
        fi

        verify_app_bundle "$app_path"
        verify_dmg_signature "$dmg_path"
        verify_dmg_contents "$dmg_path" "$(basename "$app_path")"
        ;;
      publish)
        ensure_signing_requirements
        ensure_notarization_requirements
        run_tauri_bundle "$MODE"

        app_path="$(find_latest_match "$TAURI_TARGET_DIR/$MODE/bundle/macos" '*.app' || true)"
        dmg_path="$(find_latest_match "$TAURI_TARGET_DIR/$MODE/bundle/dmg" '*.dmg' || true)"
        if [[ -z "$app_path" || -z "$dmg_path" ]]; then
          printf 'Expected signed .app and .dmg outputs under %s\n' "$TAURI_TARGET_DIR/$MODE/bundle" >&2
          exit 1
        fi

        verify_app_bundle "$app_path"
        verify_dmg_signature "$dmg_path"
        verify_dmg_contents "$dmg_path" "$(basename "$app_path")"
        ;;
    esac

    show_outputs "$MODE"
    show_release_notes
    ;;
  *)
    printf 'Unsupported mode: %s\n' "$MODE" >&2
    printf 'Supported modes: release, debug, frontend, check\n' >&2
    exit 1
    ;;
esac

write_step "All done"
