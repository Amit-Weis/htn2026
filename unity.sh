#!/usr/bin/env bash
# unity-context.sh - dump the current state of a Unity project as markdown
# for an LLM agent to consume.
#
# usage:
#   ./unity-context.sh                    # scan cwd, print to stdout
#   ./unity-context.sh -r ~/dev/MyGame    # scan a specific project
#   ./unity-context.sh -o context.md      # write to file
#   ./unity-context.sh --full             # include class/method signatures
#   ./unity-context.sh --no-git           # skip git section

set -uo pipefail

ROOT="."
OUT=""
FULL=0
SHOW_GIT=1
MAX_SCRIPTS=80
RECENT_DAYS=7

while [[ $# -gt 0 ]]; do
  case "$1" in
    -r|--root)    ROOT="$2"; shift 2 ;;
    -o|--out)     OUT="$2"; shift 2 ;;
    --full)       FULL=1; shift ;;
    --no-git)     SHOW_GIT=0; shift ;;
    --max-scripts) MAX_SCRIPTS="$2"; shift 2 ;;
    --days)       RECENT_DAYS="$2"; shift 2 ;;
    -h|--help)    sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

ROOT="${ROOT%/}"
[[ -z "$ROOT" ]] && ROOT="/"

if [[ ! -d "$ROOT/Assets" || ! -d "$ROOT/ProjectSettings" ]]; then
  echo "error: $ROOT doesn't look like a Unity project (no Assets/ + ProjectSettings/)" >&2
  exit 1
fi

[[ -n "$OUT" ]] && exec > >(tee "$OUT")

# find that skips generated / vendor dirs
uf() {
  find "$ROOT" \
    \( -name Library -o -name Temp -o -name Obj -o -name obj -o -name bin \
       -o -name Logs -o -name Build -o -name Builds -o -name .git -o -name .vs \
       -o -name UserSettings -o -name MemoryCaptures -o -name Recordings \) -prune -o \
    "$@" -print 2>/dev/null
}

count() { # count files under Assets/ only
  find "$ROOT/Assets" \( -name Library -o -name Temp -o -name obj -o -name bin \) -prune -o \
    -type f -name "$1" -print 2>/dev/null | wc -l | tr -d ' '
}
rel()   { sed "s|^$ROOT/||"; }
val()   { # val <file> <key>  -> first value of a yaml-ish key
  grep -m1 -E "^\s*$2:" "$1" 2>/dev/null | sed -E "s/^\s*$2:\s*//" | tr -d '\r'
}

echo "# Unity project context"
echo
echo "- generated: $(date -u '+%Y-%m-%d %H:%M UTC')"
echo "- root: \`$(cd "$ROOT" && pwd)\`"

# ---------------------------------------------------------------- editor + settings
PV="$ROOT/ProjectSettings/ProjectVersion.txt"
[[ -f "$PV" ]] && echo "- unity version: $(val "$PV" m_EditorVersion)"

PS="$ROOT/ProjectSettings/ProjectSettings.asset"
if [[ -f "$PS" ]]; then
  echo "- product: $(val "$PS" productName) (company: $(val "$PS" companyName))"
  AIH=$(val "$PS" activeInputHandler)
  case "$AIH" in
    0) echo "- input: legacy Input Manager" ;;
    1) echo "- input: new Input System package" ;;
    2) echo "- input: both (legacy + new)" ;;
  esac
  SB=$(val "$PS" scriptingBackend)
  [[ -n "$SB" ]] && echo "- scripting backend: $SB (0=Mono, 1=IL2CPP)"
fi

MF="$ROOT/Packages/manifest.json"
if [[ -f "$MF" ]]; then
  if   grep -q 'render-pipelines.universal' "$MF"; then echo "- render pipeline: URP"
  elif grep -q 'render-pipelines.high-definition' "$MF"; then echo "- render pipeline: HDRP"
  else echo "- render pipeline: Built-in (no SRP package)"; fi
fi

# ---------------------------------------------------------------- asset inventory
echo
echo "## Asset inventory"
echo
printf '| type | count |\n|---|---|\n'
printf '| scripts (.cs) | %s |\n'      "$(count '*.cs')"
printf '| scenes (.unity) | %s |\n'    "$(count '*.unity')"
printf '| prefabs | %s |\n'            "$(count '*.prefab')"
printf '| scriptable/.asset | %s |\n'  "$(count '*.asset')"
printf '| materials | %s |\n'          "$(count '*.mat')"
printf '| shaders | %s |\n'            "$(($(count '*.shader') + $(count '*.shadergraph')))"
printf '| models (fbx/obj/blend) | %s |\n' "$(($(count '*.fbx') + $(count '*.obj') + $(count '*.blend')))"
printf '| textures (png/jpg/tga/psd) | %s |\n' "$(($(count '*.png') + $(count '*.jpg') + $(count '*.tga') + $(count '*.psd')))"
printf '| audio (wav/mp3/ogg) | %s |\n' "$(($(count '*.wav') + $(count '*.mp3') + $(count '*.ogg')))"
printf '| animations/controllers | %s |\n' "$(($(count '*.anim') + $(count '*.controller')))"
printf '| asmdef | %s |\n'             "$(count '*.asmdef')"

echo
echo "### Top-level folders under Assets/"
echo '```'
find "$ROOT/Assets" -mindepth 1 -maxdepth 2 -type d \
  ! -path '*/.*' 2>/dev/null | rel | sort | head -60
echo '```'

for SPECIAL in Resources StreamingAssets Editor Plugins; do
  HITS=$(uf -type d -name "$SPECIAL" | rel | sort)
  [[ -n "$HITS" ]] && echo "- \`$SPECIAL\` dirs: $(echo "$HITS" | tr '\n' ' ')"
done

# ---------------------------------------------------------------- scenes
echo
echo "## Scenes"
echo
EBS="$ROOT/ProjectSettings/EditorBuildSettings.asset"
if [[ -f "$EBS" ]]; then
  echo "In build settings (in order):"
  echo '```'
  paste -d'|' \
    <(grep -E '^\s*- enabled:' "$EBS" | sed -E 's/.*enabled: //') \
    <(grep -E '^\s*path:' "$EBS" | sed -E 's/.*path: //') 2>/dev/null \
    | awk -F'|' '{print ($1==1?"[x] ":"[ ] ") $2}'
  echo '```'
fi
echo "All scene files:"
echo '```'
uf -type f -name '*.unity' | rel | sort
echo '```'

# ---------------------------------------------------------------- packages
if [[ -f "$MF" ]]; then
  echo
  echo "## Packages (manifest.json)"
  echo '```'
  sed -n '/"dependencies"/,/^\s*}/p' "$MF" | grep -E '"com\.|"scopedRegistries' \
    | sed -E 's/^\s*//; s/,$//'
  echo '```'
fi

ASM=$(uf -type f -name '*.asmdef')
if [[ -n "$ASM" ]]; then
  echo
  echo "## Assembly definitions"
  echo '```'
  while IFS= read -r f; do
    NAME=$(tr -d '\n' < "$f" | grep -oE '"name"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed -E 's/.*:[[:space:]]*"//; s/"$//')
    echo "$(echo "$f" | rel)  ->  ${NAME:-?}"
  done <<< "$ASM"
  echo '```'
fi

# ---------------------------------------------------------------- scripts
echo
echo "## Scripts"
echo
SCRIPTS=$(uf -type f -name '*.cs' | rel | sort)
TOTAL=$(echo "$SCRIPTS" | grep -c . || true)
echo "$TOTAL C# files. Showing up to $MAX_SCRIPTS with declared types."
echo '```'
i=0
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  i=$((i+1)); [[ $i -gt $MAX_SCRIPTS ]] && { echo "... ($((TOTAL-MAX_SCRIPTS)) more)"; break; }
  LC=$(wc -l < "$ROOT/$f" | tr -d ' ')
  TYPES=$(grep -hoE '(public|internal|private|abstract|sealed|static|partial|\s)*(class|struct|interface|enum)\s+[A-Za-z0-9_]+(\s*:\s*[A-Za-z0-9_.<>, ]+)?' "$ROOT/$f" 2>/dev/null \
          | sed -E 's/^\s+//; s/\s+/ /g' | paste -sd'; ' - | cut -c1-160)
  printf '%-58s %5sL  %s\n' "$f" "$LC" "${TYPES:-—}"
done <<< "$SCRIPTS"
echo '```'

if [[ $FULL -eq 1 ]]; then
  echo
  echo "### Public API surface (fields / methods / serialized)"
  echo '```'
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    SIG=$(grep -nE '^\s*(\[SerializeField\]|public\s+[A-Za-z0-9_<>\[\]\.]+\s+[A-Za-z0-9_]+)' "$ROOT/$f" \
          | sed -E 's/\s+/ /g' | head -25)
    [[ -n "$SIG" ]] && { echo "--- $f"; echo "$SIG"; echo; }
  done <<< "$SCRIPTS"
  echo '```'
fi

# ---------------------------------------------------------------- tags / layers
TM="$ROOT/ProjectSettings/TagManager.asset"
if [[ -f "$TM" ]]; then
  echo
  echo "## Tags & layers"
  echo '```'
  echo "tags:   $(sed -n '/^\s*tags:/,/^\s*layers:/p' "$TM" | grep -E '^\s*- ' | sed 's/^\s*- //' | tr '\n' '|' | sed 's/|/, /g; s/, $//')"
  echo "layers: $(sed -n '/^\s*layers:/,/^\s*m_SortingLayers:/p' "$TM" | grep -E '^\s*- .+' | sed 's/^\s*- //' | tr '\n' '|' | sed 's/|/, /g; s/, $//')"
  echo '```'
fi

# ---------------------------------------------------------------- recent activity
echo
echo "## Recently modified (last $RECENT_DAYS days)"
echo '```'
uf -type f \( -name '*.cs' -o -name '*.unity' -o -name '*.prefab' -o -name '*.asset' \) \
   -newermt "-${RECENT_DAYS} days" | rel | sort | head -50
echo '```'

# ---------------------------------------------------------------- git
if [[ $SHOW_GIT -eq 1 ]] && git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  echo
  echo "## Git"
  echo '```'
  echo "branch: $(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
  echo
  echo "last commits:"
  git -C "$ROOT" log --oneline -10 2>/dev/null
  echo
  echo "working tree:"
  git -C "$ROOT" status --porcelain 2>/dev/null | grep -v '\.meta$' | head -40
  DIRTY=$(git -C "$ROOT" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  echo "($DIRTY changed paths incl. .meta)"
  echo '```'
fi

# ---------------------------------------------------------------- warnings
echo
echo "## Notes for the agent"
echo
echo "- Every asset has a sibling \`.meta\` file; never move/delete one without the other."
echo "- \`Library/\`, \`Temp/\`, \`obj/\`, \`Build*/\` are generated and were excluded from this scan."
echo "- Scene and prefab files are YAML with GUID references; edit them via scripts/editor tooling, not by hand, unless the change is trivial."
MISSING=$(uf -type f -name '*.cs' | while read -r f; do [[ -f "$f.meta" ]] || echo "$f"; done | rel | head -10)
[[ -n "$MISSING" ]] && { echo "- scripts missing .meta files:"; echo "$MISSING" | sed 's/^/  - /'; }

exit 0
