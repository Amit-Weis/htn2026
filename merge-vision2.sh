#!/usr/bin/env bash
#
# merge-vision2.sh — bring the vision2 scene from vision-branch onto main, build-ready.
#
# Does a *surgical* merge (scene + its baked lighting + build-settings entry) rather
# than `git merge vision-branch`. A full branch merge would also drag across
# vision-branch's ProjectSettings/XR changes and its removal of Assets/Scripts/*,
# Assets/XR/Loaders/ARCoreLoader.asset, and the gltfast + postprocessing packages.
#
# Usage:
#   ./merge-vision2.sh [--first] [--no-push] [--dry-run]
#
#   --first     make vision2 build index 0 (the scene that launches on the headset)
#               default: appended after SampleScene
#   --no-push   commit locally, don't push
#   --dry-run   do everything, show the diff, push nothing, commit nothing

set -euo pipefail

REMOTE=origin
SRC_BRANCH=vision-branch
DST_BRANCH=main
SCENE=Assets/Scenes/vision2.unity
SCENE_GUID=cfb1bdce4cefcb44282b9218d5027fdc
BUILD_SETTINGS=ProjectSettings/EditorBuildSettings.asset

MAKE_FIRST=0
DO_PUSH=1
DRY_RUN=0
for a in "$@"; do
  case "$a" in
    --first)   MAKE_FIRST=1 ;;
    --no-push) DO_PUSH=0 ;;
    --dry-run) DRY_RUN=1; DO_PUSH=0 ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- preflight
git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repo"
[ -f ProjectSettings/ProjectVersion.txt ] || die "doesn't look like the Unity project root"

if [ -n "$(git status --porcelain)" ]; then
  die "working tree is dirty — commit or stash first (Unity likes to touch .meta files)"
fi

say "fetching $REMOTE"
git fetch "$REMOTE" --prune

git rev-parse --verify "$REMOTE/$SRC_BRANCH" >/dev/null 2>&1 || die "$REMOTE/$SRC_BRANCH not found"
git rev-parse --verify "$REMOTE/$DST_BRANCH" >/dev/null 2>&1 || die "$REMOTE/$DST_BRANCH not found"

START_REF=$(git rev-parse --abbrev-ref HEAD)
say "checking out $DST_BRANCH at $REMOTE/$DST_BRANCH"
git checkout -B "$DST_BRANCH" "$REMOTE/$DST_BRANCH"

# ---------------------------------------------------------------- copy scene + siblings
say "pulling vision2 out of $SRC_BRANCH"
PATHS=(
  "Assets/Scenes/vision2.unity"
  "Assets/Scenes/vision2.unity.meta"
  "Assets/Scenes/vision2.meta"
  "Assets/Scenes/vision2/"
)
for p in "${PATHS[@]}"; do
  if git cat-file -e "$REMOTE/$SRC_BRANCH:${p%/}" 2>/dev/null; then
    git checkout "$REMOTE/$SRC_BRANCH" -- "$p"
    echo "    + $p"
  else
    warn "not on $SRC_BRANCH, skipping: $p"
  fi
done

[ -f "$SCENE" ] || die "$SCENE didn't land — aborting"

# ---------------------------------------------------------------- dependency audit
# Every guid the scene references must resolve to a .meta in this tree, otherwise
# the scene opens with missing scripts / pink materials and the build is useless.
say "auditing scene dependencies"

mapfile -t WANTED < <(grep -oE 'guid: [0-9a-f]{32}' "$SCENE" | awk '{print $2}' | sort -u)

# guid -> path index over the whole working tree
HAVE=$(mktemp)
trap 'rm -f "$HAVE"' EXIT
while IFS= read -r -d '' m; do
  g=$(grep -m1 -oE '^guid: [0-9a-f]{32}' "$m" 2>/dev/null | awk '{print $2}') || true
  [ -n "${g:-}" ] && printf '%s\n' "$g"
done < <(find Assets Packages -name '*.meta' -print0 2>/dev/null) | sort -u > "$HAVE"

# Unity built-in resources live outside the asset database; they're not a failure.
BUILTIN_RE='^(0{16}[0-9a-f]{16}|0{32})$'

MISSING=()
for g in "${WANTED[@]}"; do
  grep -qx "$g" "$HAVE" && continue
  [[ "$g" =~ $BUILTIN_RE ]] && continue
  # package-internal assets (immutable packages have no .meta in the project) —
  # resolve them via the package cache if it's been generated.
  if [ -d Library/PackageCache ] && grep -rqs "guid: $g" Library/PackageCache 2>/dev/null; then
    continue
  fi
  MISSING+=("$g")
done

if [ "${#MISSING[@]}" -gt 0 ]; then
  warn "${#MISSING[@]} guid(s) referenced by the scene don't resolve in this tree:"
  for g in "${MISSING[@]}"; do
    src=$(git grep -l "guid: $g" "$REMOTE/$SRC_BRANCH" -- '*.meta' 2>/dev/null | head -1 || true)
    echo "      $g  ${src:+(on $SRC_BRANCH: ${src#*:})}"
  done
  warn "these are usually package assets — if Unity shows missing refs, copy the"
  warn "listed paths across too, or open the project once so Library/PackageCache exists."
else
  echo "    all ${#WANTED[@]} referenced guids resolve"
fi

# ---------------------------------------------------------------- build settings
say "registering vision2 in $BUILD_SETTINGS"
python3 - "$BUILD_SETTINGS" "$SCENE" "$SCENE_GUID" "$MAKE_FIRST" <<'PY'
import sys, re
path, scene, guid, first = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1"
src = open(path).read()

if guid in src:
    print("    already listed — leaving build settings alone")
    sys.exit(0)

entry = f"  - enabled: 1\n    path: {scene}\n    guid: {guid}\n"

m = re.search(r"^  m_Scenes:\n", src, re.M)
if not m:
    sys.exit("could not find m_Scenes in EditorBuildSettings.asset")

if first:
    out = src[:m.end()] + entry + src[m.end():]
    print("    added as build index 0")
else:
    # append after the last "  - enabled:" block, i.e. just before m_configObjects
    c = re.search(r"^  m_configObjects:", src, re.M)
    if not c:
        sys.exit("could not find m_configObjects in EditorBuildSettings.asset")
    out = src[:c.start()] + entry + src[c.start():]
    print("    appended after existing scenes")

open(path, "w").write(out)
PY

# ---------------------------------------------------------------- sanity
say "sanity checks"
grep -q "$SCENE_GUID" "$BUILD_SETTINGS" || die "build settings entry didn't stick"
head -2 "$SCENE" | grep -q '%YAML' || die "$SCENE isn't YAML — is Git LFS or a smudge filter mangling it?"
grep -q 'm_EditorVersion' ProjectSettings/ProjectVersion.txt || warn "no ProjectVersion.txt?"
echo "    ok"

git add -A -- Assets/Scenes "$BUILD_SETTINGS"

if [ -z "$(git diff --cached --name-only)" ]; then
  say "nothing to do — main already has this scene and build entry"
  exit 0
fi

echo
say "staged changes:"
git diff --cached --stat
echo

if [ "$DRY_RUN" -eq 1 ]; then
  warn "--dry-run: unstaging and restoring $DST_BRANCH, nothing committed"
  git reset --hard "$REMOTE/$DST_BRANCH"
  git checkout "$START_REF" >/dev/null 2>&1 || true
  exit 0
fi

git commit -m "Merge vision2 scene from $SRC_BRANCH and add it to build settings

Scene-only port: Assets/Scenes/vision2.unity plus its baked lighting,
registered in EditorBuildSettings so it ships in the player build.
ProjectSettings and package changes from $SRC_BRANCH intentionally not merged."

say "committed $(git rev-parse --short HEAD)"

if [ "$DO_PUSH" -eq 1 ]; then
  say "pushing to $REMOTE/$DST_BRANCH"
  git push "$REMOTE" "$DST_BRANCH"
  say "done"
else
  warn "--no-push: run 'git push $REMOTE $DST_BRANCH' when you're happy"
fi
