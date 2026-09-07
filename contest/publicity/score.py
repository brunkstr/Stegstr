#!/usr/bin/env python3
"""Stegstr publicity-contest scorer.

Reads every kind-0 and kind-1 event on the relay (strfry scan on stdin),
attributes each pubkey to the first referral code it carried, weights the
pubkey by how real its activity looks, and writes:

  out/<date>.tsv     one line per attributed pubkey (auditable raw result)
  out/scores.json    per-code totals for the scoreboard page
  out/scores.event   a signed kind-30078 Nostr event carrying scores.json,
                     ready for `strfry import`, so the scoreboard page can
                     read it straight from wss://relay.stegstr.com

Tag format, identical to what the app and CLI write:
  ["r", "https://stegstr.com/r/CODE"]

Usage:
  strfry scan '{"kinds":[0,1]}' | score.py --key /opt/publicity/scoreboard.key \
      --participants participants.tsv --out /opt/publicity/out

No third-party modules: BIP-340 Schnorr signing is implemented below so the
relay VM needs nothing but python3.
"""
import argparse, collections, datetime, hashlib, json, os, re, sys, time

REF_PREFIX = "https://stegstr.com/r/"
CODE_RE = re.compile(r"^[A-HJ-KM-NP-Z2-9]{4,8}$")
SCOREBOARD_D = "stegstr-publicity-scores"
FULL_DAYS = 3          # notes on >= 3 distinct UTC days -> weight 1.0
LIGHT_WEIGHT = 0.2     # any notes, fewer days -> 0.2
BURST_N = 20           # > 20 new pubkeys for one code inside one minute -> flagged

# ---------------------------------------------------------------- BIP-340 ----
P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
     0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)

def tagged_hash(tag, msg):
    th = hashlib.sha256(tag.encode()).digest()
    return hashlib.sha256(th + th + msg).digest()

def point_add(p1, p2):
    if p1 is None: return p2
    if p2 is None: return p1
    x1, y1 = p1; x2, y2 = p2
    if x1 == x2 and y1 != y2: return None
    if x1 == x2:
        lam = (3 * x1 * x1 * pow(2 * y1, P - 2, P)) % P
    else:
        lam = ((y2 - y1) * pow(x2 - x1, P - 2, P)) % P
    x3 = (lam * lam - x1 - x2) % P
    return (x3, (lam * (x1 - x3) - y1) % P)

def point_mul(p, n):
    r = None
    for i in range(256):
        if (n >> i) & 1: r = point_add(r, p)
        p = point_add(p, p)
    return r

def has_even_y(p): return p[1] % 2 == 0

def pubkey_of(seckey: bytes) -> bytes:
    d0 = int.from_bytes(seckey, "big")
    assert 1 <= d0 < N, "bad secret key"
    return point_mul(G, d0)[0].to_bytes(32, "big")

def schnorr_sign(msg32: bytes, seckey: bytes, aux: bytes) -> bytes:
    d0 = int.from_bytes(seckey, "big")
    Pt = point_mul(G, d0)
    d = d0 if has_even_y(Pt) else N - d0
    t = (d ^ int.from_bytes(tagged_hash("BIP0340/aux", aux), "big")).to_bytes(32, "big")
    k0 = int.from_bytes(tagged_hash("BIP0340/nonce", t + Pt[0].to_bytes(32, "big") + msg32), "big") % N
    assert k0 != 0
    R = point_mul(G, k0)
    k = k0 if has_even_y(R) else N - k0
    e = int.from_bytes(tagged_hash("BIP0340/challenge", R[0].to_bytes(32, "big") + Pt[0].to_bytes(32, "big") + msg32), "big") % N
    return R[0].to_bytes(32, "big") + ((k + e * d) % N).to_bytes(32, "big")

def sign_event(seckey: bytes, kind: int, tags, content: str, created_at: int) -> dict:
    pk = pubkey_of(seckey).hex()
    ser = json.dumps([0, pk, created_at, kind, tags, content], separators=(",", ":"), ensure_ascii=False)
    eid = hashlib.sha256(ser.encode()).digest()
    sig = schnorr_sign(eid, seckey, os.urandom(32))
    return {"id": eid.hex(), "pubkey": pk, "created_at": created_at, "kind": kind,
            "tags": tags, "content": content, "sig": sig.hex()}

# ---------------------------------------------------------------- scoring ----
def code_from_tags(tags):
    for t in tags or []:
        if len(t) >= 2 and t[0] == "r" and isinstance(t[1], str) and t[1].startswith(REF_PREFIX):
            c = t[1][len(REF_PREFIX):].split("/")[0].split("?")[0].upper()
            if CODE_RE.match(c): return c
    return None

def load_participants(path):
    out = {}
    if not path or not os.path.exists(path): return out
    with open(path) as f:
        for line in f:
            line = line.rstrip("\n")
            if not line or line.startswith("#"): continue
            parts = line.split("\t")
            if CODE_RE.match(parts[0].strip().upper()):
                out[parts[0].strip().upper()] = (parts[1].strip() if len(parts) > 1 else "")
    return out

def day_of(ts): return datetime.datetime.utcfromtimestamp(ts).strftime("%Y-%m-%d")

def score(events, participants):
    # first code per pubkey (earliest created_at among tagged kind 0/1 events)
    first = {}                              # pubkey -> (created_at, code)
    profiled = set()                        # pubkeys with a kind 0 that has a name
    note_days = collections.defaultdict(set)
    note_count = collections.Counter()
    last_seen = {}
    for ev in events:
        pk = ev.get("pubkey"); kind = ev.get("kind"); ts = int(ev.get("created_at", 0))
        if not pk or kind not in (0, 1): continue
        last_seen[pk] = max(last_seen.get(pk, 0), ts)
        code = code_from_tags(ev.get("tags"))
        if code and (pk not in first or ts < first[pk][0]):
            first[pk] = (ts, code)
        if kind == 0:
            try:
                meta = json.loads(ev.get("content") or "{}")
                if str(meta.get("name") or meta.get("display_name") or "").strip():
                    profiled.add(pk)
            except Exception:
                pass
        elif kind == 1:
            note_days[pk].add(day_of(ts)); note_count[pk] += 1

    # burst flag: > BURST_N pubkeys first seen for one code within the same minute
    per_minute = collections.Counter((c, ts // 60) for ts, c in first.values())
    rows = []
    for pk, (ts, code) in first.items():
        days = len(note_days[pk])
        flags = []
        if per_minute[(code, ts // 60)] > BURST_N: flags.append("burst")
        if pk not in profiled: flags.append("no-profile")
        if days == 0: flags.append("no-notes")
        if flags: weight = 0.0
        elif days >= FULL_DAYS: weight = 1.0
        else: weight = LIGHT_WEIGHT
        rows.append({"pubkey": pk, "code": code, "first_seen": ts, "last_seen": last_seen.get(pk, ts),
                     "notes": note_count[pk], "days": days, "weight": weight, "flags": ",".join(flags)})
    rows.sort(key=lambda r: (r["code"], r["first_seen"]))

    codes = {}
    for r in rows:
        c = codes.setdefault(r["code"], {"code": r["code"], "participant": participants.get(r["code"], ""),
                                         "registered": r["code"] in participants, "pubkeys": 0, "full": 0,
                                         "light": 0, "unscored": 0, "flagged_burst": 0, "score": 0.0,
                                         "first_seen": r["first_seen"], "last_seen": r["last_seen"]})
        c["pubkeys"] += 1
        c["score"] += r["weight"]
        if r["weight"] == 1.0: c["full"] += 1
        elif r["weight"] > 0: c["light"] += 1
        else: c["unscored"] += 1
        if "burst" in r["flags"]: c["flagged_burst"] += 1
        c["first_seen"] = min(c["first_seen"], r["first_seen"]); c["last_seen"] = max(c["last_seen"], r["last_seen"])
    for c in codes.values(): c["score"] = round(c["score"], 1)
    ranked = sorted(codes.values(), key=lambda c: (-c["score"], -c["full"], -c["pubkeys"], c["code"]))
    for i, c in enumerate(ranked, 1): c["rank"] = i
    return rows, ranked

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--key", help="file with 64-hex secret key for signing the scoreboard event")
    ap.add_argument("--participants", help="TSV: code<TAB>display name")
    ap.add_argument("--out", default="out")
    ap.add_argument("--stdin-file", help="read events from this file instead of stdin (tests)")
    a = ap.parse_args()

    src = open(a.stdin_file) if a.stdin_file else sys.stdin
    events = []
    for line in src:
        line = line.strip()
        if not line.startswith("{"): continue
        try: events.append(json.loads(line))
        except json.JSONDecodeError: pass

    rows, ranked = score(events, load_participants(a.participants))
    now = int(time.time())
    os.makedirs(a.out, exist_ok=True)
    stamp = datetime.datetime.utcfromtimestamp(now).strftime("%Y-%m-%d")
    with open(os.path.join(a.out, f"{stamp}.tsv"), "w") as f:
        f.write("pubkey\tcode\tfirst_seen\tlast_seen\tnotes\tdays\tweight\tflags\n")
        for r in rows:
            f.write("\t".join(str(r[k]) for k in ("pubkey", "code", "first_seen", "last_seen", "notes", "days", "weight", "flags")) + "\n")
    board = {
        "generated_at": now, "relay": "wss://relay.stegstr.com", "events_scanned": len(events),
        "rules": {"full_weight_days": FULL_DAYS, "light_weight": LIGHT_WEIGHT, "burst_threshold_per_minute": BURST_N,
                  "requires": "profile with a name; at least one note"},
        "codes": ranked,
        "totals": {"pubkeys": len(rows), "score": round(sum(r["weight"] for r in rows), 1)},
    }
    content = json.dumps(board, separators=(",", ":"))
    with open(os.path.join(a.out, "scores.json"), "w") as f: f.write(content)
    if a.key:
        sk = bytes.fromhex(open(a.key).read().strip())
        ev = sign_event(sk, 30078, [["d", SCOREBOARD_D], ["title", "Stegstr publicity contest scoreboard"]], content, now)
        with open(os.path.join(a.out, "scores.event"), "w") as f: f.write(json.dumps(ev, separators=(",", ":")) + "\n")
        print(f"scoreboard pubkey {ev['pubkey']}", file=sys.stderr)
    print(f"{len(events)} events, {len(rows)} attributed pubkeys, {len(ranked)} codes", file=sys.stderr)

if __name__ == "__main__":
    main()
