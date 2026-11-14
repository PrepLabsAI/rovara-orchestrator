#!/usr/bin/env bash
# Regenerate the speckit-dag fixtures used by the import tests.
#
#   SPECKIT_DAG=~/Workspaces/speckit-dag tests/contract/fixtures/speckit-dag/regenerate.sh
#
# Every fixture's recorded hash is speckit-dag's own (computed by speckit-dag itself), so the
# import's hash port is checked against the real implementation.
set -euo pipefail
OUT="$(cd "$(dirname "$0")" && pwd)"
SD="${SPECKIT_DAG:?set SPECKIT_DAG to a speckit-dag checkout}"
export PYTHONPATH="$SD"
EXAMPLE="$SD/examples/specs/001-user-auth"

echo "speckit-dag at $(git -C "$SD" rev-parse --short HEAD)"

# The example spec as published (committed and pushed in the speckit-dag repo).
(cd "$SD" && python3 -m speckit_dag examples/specs/001-user-auth --unit story) > "$OUT/units.json"

# Variants built in a throwaway git repo, so dirty/pushed reflect that repo.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/specs"
cp -R "$EXAMPLE" "$WORK/specs/001-user-auth"
git -C "$WORK" init -q
git -C "$WORK" -c user.email=t@t -c user.name=t add -A
git -C "$WORK" -c user.email=t@t -c user.name=t commit -qm init
gen() { (cd "$WORK" && python3 -m speckit_dag specs/001-user-auth "$@"); }

# Committed but never pushed (no origin): pushed=false.
gen --unit story > "$OUT/unpushed.json"
# One task's text edited: a new hash.
sed -i.bak 's/Implement password hashing helpers/Implement argon2 password hashing helpers/' "$WORK/specs/001-user-auth/tasks.md"
rm "$WORK/specs/001-user-auth/tasks.md.bak"
gen --unit story > "$OUT/dirty-edited.json"
git -C "$WORK" -c user.email=t@t -c user.name=t commit -qam edit
gen --unit story > "$OUT/edited.json"
git -C "$WORK" -c user.email=t@t -c user.name=t revert --no-edit HEAD >/dev/null
# One checkbox ticked: the same hash as the original.
sed -i.bak 's/- \[ \] T005/- [x] T005/' "$WORK/specs/001-user-auth/tasks.md"
rm "$WORK/specs/001-user-auth/tasks.md.bak"
git -C "$WORK" -c user.email=t@t -c user.name=t commit -qam tick
gen --unit story > "$OUT/ticked.json"
# A task-unit graph.
gen --unit task > "$OUT/unit-task.json"

# Hand-made graphs, re-hashed with speckit-dag's own content_hash.
python3 - "$OUT" <<'PY'
import json, sys, copy
from speckit_dag.identity import content_hash
out = sys.argv[1]
base = json.load(open(f"{out}/units.json"))
def write(name, g, rehash=True):
    if rehash:
        g["hash"] = content_hash(g)
    json.dump(g, open(f"{out}/{name}.json", "w"), indent=2, ensure_ascii=False)
cyc = copy.deepcopy(base)
cyc["edges"].append({"from": "polish", "to": "setup", "reasons": ["explicit"], "via": []})
write("cycle", cyc)
unk = copy.deepcopy(base)
unk["edges"].append({"from": "US9", "to": "polish", "reasons": ["explicit"], "via": []})
write("unknown-node", unk)
ver = copy.deepcopy(base); ver["version"] = 2
write("version", ver, rehash=False)
schema = copy.deepcopy(base); del schema["nodes"]
write("schema", schema, rehash=False)
mism = copy.deepcopy(base); mism["nodes"][0]["title"] = "Changed after hashing"
write("hash-mismatch", mism, rehash=False)
PY
echo "fixtures written to $OUT"
