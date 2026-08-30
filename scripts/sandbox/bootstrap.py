#!/usr/bin/env python3
"""Bring the throwaway Wiki.js sandbox from empty to usable, without a browser.

Finalizes the setup wizard, logs in, enables the API and mints a full-access
API key. Writes the key to sandbox.json next to this file.

Only ever run against the loopback sandbox on port 3010.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("SANDBOX_URL", "http://127.0.0.1:3010")
EMAIL = "admin@sandbox.local"
PASSWORD = "sandbox-admin-not-a-secret"
HERE = os.path.dirname(os.path.abspath(__file__))


def post(path, payload, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(
        BASE + path, data=json.dumps(payload).encode(), headers=headers
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode() or "{}")


def gql(query, variables=None, token=None):
    body = post("/graphql", {"query": query, "variables": variables or {}}, token)
    if body.get("errors"):
        raise SystemExit("GraphQL error: " + json.dumps(body["errors"])[:500])
    return body["data"]


def wait_for_boot():
    for _ in range(120):
        try:
            with urllib.request.urlopen(BASE + "/", timeout=5) as r:
                r.read(64)
            return
        except urllib.error.HTTPError:
            return
        except Exception:
            time.sleep(2)
    raise SystemExit("Wiki.js did not come up on " + BASE)


def finalize():
    try:
        post(
            "/finalize",
            {
                "adminEmail": EMAIL,
                "adminPassword": PASSWORD,
                "adminPasswordConfirm": PASSWORD,
                "siteUrl": BASE,
                "telemetry": False,
            },
        )
        print("setup finalized")
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:200]
        print("finalize returned %s (%s) - assuming already set up" % (e.code, detail))
    # Wiki.js restarts its master process after finalize.
    time.sleep(8)
    wait_for_boot()


def main():
    wait_for_boot()
    finalize()

    for attempt in range(30):
        try:
            data = gql(
                """mutation($u:String!,$p:String!){
                     authentication{ login(username:$u,password:$p,strategy:"local"){
                       jwt responseResult{ succeeded errorCode message } } } }""",
                {"u": EMAIL, "p": PASSWORD},
            )
            break
        except Exception as exc:
            if attempt == 29:
                raise
            print("login not ready (%s), retrying" % str(exc)[:80])
            time.sleep(3)

    login = data["authentication"]["login"]
    if not login.get("jwt"):
        raise SystemExit("login failed: " + json.dumps(login["responseResult"]))
    jwt = login["jwt"]
    print("logged in")

    gql(
        "mutation{ authentication{ setApiState(enabled:true){ responseResult{ succeeded message } } } }",
        token=jwt,
    )
    print("api enabled")

    created = gql(
        """mutation($n:String!){ authentication{
             createApiKey(name:$n, expiration:"1y", fullAccess:true){
               key responseResult{ succeeded errorCode message } } } }""",
        {"n": "wikijs-mcp-sandbox"},
        token=jwt,
    )["authentication"]["createApiKey"]
    if not created.get("key"):
        raise SystemExit("key creation failed: " + json.dumps(created["responseResult"]))

    out = {"url": BASE, "key": created["key"], "email": EMAIL, "password": PASSWORD}
    path = os.path.join(HERE, "sandbox.json")
    with open(path, "w") as fh:
        json.dump(out, fh, indent=1)
    os.chmod(path, 0o600)
    print("api key written to " + path)

    info = gql(
        "{ system{ info{ currentVersion dbType pagesTotal usersTotal } } }",
        token=created["key"],
    )
    print("verified with the api key: " + json.dumps(info["system"]["info"]))


if __name__ == "__main__":
    sys.exit(main())
