#!/usr/bin/env bash
#
# fix-xreal-namespaces.sh
#
# Fixes the AGP 8 manifest-merger failure:
#     Namespace 'nrsdk.pack' is used in multiple modules and/or libraries
#
# The XREAL UPM package ships several AARs that all declare package="nrsdk.pack".
# This script:
#   1. locates the XREAL package (embedded, local file:, or PackageCache)
#   2. embeds it under Packages/ so edits survive package re-resolution
#   3. rewrites the namespace in every AAR except nr_loader.aar
#   4. clears the Unity Gradle export and the Gradle transform cache
#
# Run from the Unity project root (the folder containing Assets/ and Packages/).
# Close the Unity Editor first.
#
# Usage:
#   ./fix-xreal-namespaces.sh            # apply the patch
#   ./fix-xreal-namespaces.sh --revert   # restore .bak files
#   ./fix-xreal-namespaces.sh --check    # report only, change nothing
#

set -euo pipefail

# ---------------------------------------------------------------- config ----

# The AAR that KEEPS the original namespace. Everything else gets renamed,
# so anything referencing nrsdk.pack still resolves.
KEEP_AAR="nr_loader.aar"

# Namespace we are de-duplicating.
OLD_NS="nrsdk.pack"

# Where the package gets embedded to.
EMBED_DIR="Packages/com.xreal.xr"

# ----------------------------------------------------------------- setup ----

MODE="apply"
case "${1:-}" in
  --revert) MODE="revert" ;;
  --check)  MODE="check" ;;
  --help|-h) sed -n '2,30p' "$0"; exit 0 ;;
  "") ;;
  *) echo "unknown option: $1 (try --help)" >&2; exit 1 ;;
esac

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }

for cmd in unzip zip sed find; do
  command -v "$cmd" >/dev/null 2>&1 || die "missing required command: $cmd"
done

# ------------------------------------------------------- sanity: cwd ---------

[ -d Assets ] && [ -d Packages ] \
  || die "run this from the Unity project root (no Assets/ + Packages/ here)"

say "project root: $(pwd)"

# --------------------------------------------- warn if Unity is running ------

if pgrep -f 'Unity(\.exe)?$' >/dev/null 2>&1; then
  warn "Unity looks like it is running. Close the Editor before continuing."
  printf 'continue anyway? [y/N] '
  read -r reply
  case "$reply" in [yY]*) ;; *) exit 1 ;; esac
fi

# ----------------------------------------------- locate the XREAL package ----

PKG_DIR=""

# 1. already embedded?
if [ -d "$EMBED_DIR/Runtime/Plugins/Android" ]; then
  PKG_DIR="$EMBED_DIR"
  say "found embedded package: $PKG_DIR"
fi

# 2. referenced by a local file: path in manifest.json?
if [ -z "$PKG_DIR" ] && [ -f Packages/manifest.json ]; then
  LOCAL_PATH=$(sed -n 's/.*"com\.xreal\.xr"[[:space:]]*:[[:space:]]*"file:\([^"]*\)".*/\1/p' \
                 Packages/manifest.json | head -1)
  if [ -n "$LOCAL_PATH" ]; then
    CAND="Packages/$LOCAL_PATH"
    [ -d "$CAND/Runtime/Plugins/Android" ] || CAND="$LOCAL_PATH"
    if [ -d "$CAND/Runtime/Plugins/Android" ]; then
      PKG_DIR="$CAND"
      say "found local file: package: $PKG_DIR"
    fi
  fi
fi

# 3. in the package cache (hash suffix varies per machine)
if [ -z "$PKG_DIR" ]; then
  CACHED=$(find Library/PackageCache -maxdepth 1 -type d -name 'com.xreal.xr*' 2>/dev/null | head -1)
  if [ -n "$CACHED" ]; then
    say "found cached package: $CACHED"
    if [ "$MODE" = "apply" ]; then
      say "embedding to $EMBED_DIR (survives package re-resolution)"
      rm -rf "$EMBED_DIR"
      cp -r "$CACHED" "$EMBED_DIR"
      chmod -R u+w "$EMBED_DIR"
      PKG_DIR="$EMBED_DIR"
    else
      PKG_DIR="$CACHED"
    fi
  fi
fi

[ -n "$PKG_DIR" ] || die "could not find the XREAL package. Open Unity once to resolve packages, then rerun."

AAR_DIR="$PKG_DIR/Runtime/Plugins/Android"
[ -d "$AAR_DIR" ] || die "no Android plugins folder at $AAR_DIR"

# ------------------------------------------------------------- helpers -------

ns_of() {
  unzip -p "$1" AndroidManifest.xml 2>/dev/null \
    | tr -d '\n' \
    | grep -o 'package="[^"]*"' \
    | head -1 \
    | sed 's/package="\(.*\)"/\1/'
}

# ------------------------------------------------------------- revert --------

if [ "$MODE" = "revert" ]; then
  n=0
  for bak in "$AAR_DIR"/*.aar.bak; do
    [ -e "$bak" ] || continue
    mv -f "$bak" "${bak%.bak}"
    say "restored $(basename "${bak%.bak}")"
    n=$((n + 1))
  done
  [ "$n" -gt 0 ] || warn "no .bak files found in $AAR_DIR"
  say "reverted $n file(s). Delete Library/Bee/Android and rebuild."
  exit 0
fi

# -------------------------------------------------------------- report -------

say "scanning AARs in $AAR_DIR"
DUPES=()
for f in "$AAR_DIR"/*.aar; do
  [ -e "$f" ] || continue
  ns=$(ns_of "$f")
  base=$(basename "$f")
  if [ "$ns" = "$OLD_NS" ]; then
    printf '    %-40s %s  <-- duplicate\n' "$base" "$ns"
    [ "$base" = "$KEEP_AAR" ] || DUPES+=("$f")
  else
    printf '    %-40s %s\n' "$base" "${ns:-<none>}"
  fi
done

if [ "${#DUPES[@]}" -eq 0 ]; then
  say "nothing to patch — no duplicate '$OLD_NS' namespaces (besides $KEEP_AAR)."
  [ "$MODE" = "check" ] && exit 0
else
  say "${#DUPES[@]} AAR(s) to patch ($KEEP_AAR keeps '$OLD_NS')"
fi

if [ "$MODE" = "check" ]; then
  say "check mode — no changes made."
  exit 0
fi

# --------------------------------------------------------------- patch -------

ROOT=$(pwd)

for f in "${DUPES[@]}"; do
  base=$(basename "$f")
  stem="${base%.aar}"
  suffix="${stem#nr_}"                 # nr_common -> common
  suffix=$(echo "$suffix" | tr -cd '[:alnum:]_')
  newns="$OLD_NS.$suffix"

  [ -f "$f.bak" ] || cp "$f" "$f.bak"

  W=$(mktemp -d)
  trap 'rm -rf "$W"' EXIT

  unzip -q "$f" AndroidManifest.xml -d "$W" \
    || { warn "$base has no AndroidManifest.xml, skipping"; rm -rf "$W"; continue; }

  sed -i.orig "s/package=\"${OLD_NS//./\\.}\"/package=\"$newns\"/" "$W/AndroidManifest.xml"
  rm -f "$W/AndroidManifest.xml.orig"

  ( cd "$W" && zip -q "$ROOT/$f" AndroidManifest.xml )
  rm -rf "$W"
  trap - EXIT

  check=$(ns_of "$f")
  if [ "$check" = "$newns" ]; then
    printf '    \033[1;32mok\033[0m  %-40s -> %s\n' "$base" "$newns"
  else
    warn "$base did not take the new namespace (now: ${check:-<none>}) — restoring"
    mv -f "$f.bak" "$f"
  fi
done

# --------------------------------------------------------------- clean -------

say "clearing Unity's Gradle export"
rm -rf Library/Bee/Android

say "clearing Gradle transform caches"
for d in "$HOME"/.gradle/caches/*/transforms; do
  [ -d "$d" ] && rm -rf "$d" && printf '    removed %s\n' "$d"
done

# ---------------------------------------------------------------- done -------

say "done."
cat <<'EOF'

Next steps:
  1. Open Unity (it will reimport the embedded package — this takes a minute).
  2. Build again.

If the build still fails on the same error, run:
    ./fix-xreal-namespaces.sh --check
and check that no AAR outside the package is also declaring nrsdk.pack.

To undo:
    ./fix-xreal-namespaces.sh --revert
EOF
