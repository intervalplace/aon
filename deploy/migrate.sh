#!/usr/bin/env bash
# Copy every object from another AON node (e.g. the old explorer) into this
# node. Objects are content-addressed and re-verified on the way in, and this
# node gossips them on to its peers.
#
#   /opt/aon/deploy/migrate.sh https://explorer.aon.network
set -euo pipefail
SRC="${1:?Usage: ./migrate.sh https://old-node.example}"
python3 - "$SRC" <<'PY'
import json, sys, urllib.request, urllib.error
src = sys.argv[1].rstrip("/"); dst = "http://127.0.0.1:8787"
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
def get(u): return json.load(opener.open(urllib.request.Request(u, headers={"accept": "application/json"}), timeout=30))
ok = fail = 0; offset = 0; reasons = {}
while True:
    page = get(f"{src}/v1/objects?limit=1000&offset={offset}")
    objs = page.get("objects", [])
    for o in objs:
        req = urllib.request.Request(dst + "/v1/objects", data=json.dumps(o).encode(), headers={"content-type": "application/json"}, method="POST")
        try:
            r = json.load(opener.open(req, timeout=30))
            if r.get("ok"):
                ok += 1
            else:
                fail += 1; k = (r.get("error") or {}).get("code", "UNKNOWN"); reasons[k] = reasons.get(k, 0) + 1
        except urllib.error.HTTPError as e:
            fail += 1
            try:
                k = (json.loads(e.read()).get("error") or {}).get("code", f"HTTP {e.code}")
            except Exception:
                k = f"HTTP {e.code}"
            reasons[k] = reasons.get(k, 0) + 1
        except Exception as e:
            fail += 1; k = type(e).__name__ + ": " + str(e)[:80]; reasons[k] = reasons.get(k, 0) + 1
    offset += len(objs)
    if len(objs) < 1000: break
print(f"Copied {ok} objects from {src} ({fail} rejected). Total there: {page.get('total')}")
for k, n in sorted(reasons.items(), key=lambda x: -x[1]):
    print(f"  rejected {n}: {k}")
PY
