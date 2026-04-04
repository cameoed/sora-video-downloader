#!/usr/bin/env python3
"""
Fetch all Sora drafts and publish each as an unlisted shared link.
Writes the resulting post permalinks to a txt file for use with sora-dl.py.

This keeps the original batch flow, and adds a single-draft mode used by the app.
"""

import argparse
import asyncio
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE_URL = "https://sora.chatgpt.com"
DRAFTS_LIMIT = 30
MAX_POST_TEXT = 1999
FAST_RATE_LIMIT_BASE_DELAY_S = 15
MAX_RATE_LIMIT_RETRIES = 12
MAX_RATE_LIMIT_DELAY_S = 21600
MAX_SERVER_RETRIES = 3
MAX_AUTH_RETRIES = 1
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
)


def make_headers(token: str, cookie: str = "", user_agent: str = DEFAULT_USER_AGENT) -> dict:
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "*/*",
        "Origin": "https://sora.chatgpt.com",
        "Referer": "https://sora.chatgpt.com/drafts",
        "User-Agent": user_agent or DEFAULT_USER_AGENT,
    }
    if cookie:
        headers["Cookie"] = cookie
    return headers


def _do_request(method: str, path: str, headers: dict, body: dict | None = None) -> tuple[int, dict, dict]:
    url = BASE_URL + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, dict(resp.headers), json.loads(resp.read())
    except urllib.error.HTTPError as e:
        try:
            body_bytes = e.read()
        except Exception:
            body_bytes = b""
        try:
            resp_body = json.loads(body_bytes)
        except Exception:
            resp_body = {"raw": body_bytes.decode(errors="replace")}
        return e.code, dict(e.headers), resp_body


def _retry_after_s(headers: dict) -> float | None:
    val = headers.get("Retry-After") or headers.get("retry-after")
    if val is None:
        return None
    try:
        return float(val)
    except ValueError:
        return None


async def api_get(headers: dict, path: str) -> dict:
    loop = asyncio.get_event_loop()
    status, _, body = await loop.run_in_executor(None, _do_request, "GET", path, headers, None)
    if status != 200:
        raise RuntimeError(f"GET {path} -> {status}: {body}")
    return body


async def api_post_with_retry(
    headers: dict,
    path: str,
    body: dict,
    delay_s: float,
) -> tuple[dict | None, str | None]:
    rate_attempt = 0
    server_attempt = 0
    auth_attempt = 0

    while True:
        loop = asyncio.get_event_loop()
        status, resp_headers, resp_body = await loop.run_in_executor(
            None, _do_request, "POST", path, headers, body
        )

        if status == 200:
            return resp_body, None

        if status == 401:
            if auth_attempt < MAX_AUTH_RETRIES:
                auth_attempt += 1
                print("  Token expired — re-use a fresh token with --token.", file=sys.stderr)
            return None, "401 Unauthorized"

        if status == 429:
            rate_attempt += 1
            if rate_attempt > MAX_RATE_LIMIT_RETRIES:
                return None, f"429 rate limit exceeded after {MAX_RATE_LIMIT_RETRIES} retries"

            retry_s = _retry_after_s(resp_headers)
            backoff_s = min(
                MAX_RATE_LIMIT_DELAY_S,
                FAST_RATE_LIMIT_BASE_DELAY_S * (2 ** (rate_attempt - 1)),
            )
            wait_s = max(retry_s or 0, backoff_s)
            print(
                f"  Rate limited, waiting {wait_s:.0f}s (retry {rate_attempt}/{MAX_RATE_LIMIT_RETRIES})...",
                flush=True,
            )
            await asyncio.sleep(wait_s)
            continue

        if status >= 500:
            server_attempt += 1
            if server_attempt > MAX_SERVER_RETRIES:
                return None, f"{status} server error after {MAX_SERVER_RETRIES} retries"
            wait_s = max(delay_s, 5 * server_attempt)
            print(
                f"  Server error {status}, retrying in {wait_s:.0f}s ({server_attempt}/{MAX_SERVER_RETRIES})...",
                flush=True,
            )
            await asyncio.sleep(wait_s)
            continue

        err = resp_body.get("error", {})
        msg = err.get("message") if isinstance(err, dict) else str(resp_body)
        return None, f"{status}: {msg}"


def truncate_text(text: str) -> str:
    if not text or len(text) <= MAX_POST_TEXT:
        return text or ""
    suffix = "..."
    limit = MAX_POST_TEXT - len(suffix)
    cut = text[:limit]
    last_space = cut.rfind(" ", int(limit * 0.6))
    if last_space > 0:
        cut = cut[:last_space]
    return cut.rstrip() + suffix


def draft_label(draft: dict) -> str:
    label = draft.get("prompt") or draft.get("caption") or draft.get("title") or draft.get("id") or "untitled"
    return str(label)[:70]


def draft_generation_id(draft: dict) -> str | None:
    kind = draft.get("kind")
    draft_id = draft.get("id", "")
    if kind == "sora_draft":
        return draft.get("generation_id") or draft_id
    if not kind and draft.get("assets"):
        return draft_id
    return None


def draft_existing_permalink(draft: dict) -> str | None:
    post_wrapper = draft.get("post")
    if isinstance(post_wrapper, dict):
        inner = post_wrapper.get("post")
        if isinstance(inner, dict):
            permalink = inner.get("permalink")
            if permalink:
                return permalink
    preview = draft.get("preview_asset") or {}
    post_wrapper2 = preview.get("post")
    if isinstance(post_wrapper2, dict):
        inner2 = post_wrapper2.get("post")
        if isinstance(inner2, dict):
            permalink2 = inner2.get("permalink")
            if permalink2:
                return permalink2
    return None


def draft_post_body(draft: dict) -> dict | None:
    kind = draft.get("kind")
    draft_id = draft.get("id", "")

    if kind == "sora_draft":
        generation_id = draft.get("generation_id") or draft_id
        post_kind = "sora"
        text = draft.get("prompt") or draft.get("title") or ""
    elif not kind and draft.get("assets"):
        generation_id = draft_id
        post_kind = "sora_edit"
        text = draft.get("caption") or ""
    else:
        return None

    return {
        "attachments_to_create": [{"generation_id": generation_id, "kind": post_kind}],
        "post_text": truncate_text(text),
        "destinations": [{"type": "shared_link_unlisted"}],
    }


def load_done_ids(done_path: str) -> set[str]:
    try:
        with open(done_path) as f:
            return set(line.strip() for line in f if line.strip())
    except FileNotFoundError:
        return set()


def save_done_id(done_path: str, gen_id: str) -> None:
    with open(done_path, "a") as f:
        f.write(gen_id + "\n")


async def fetch_all_drafts(headers: dict) -> list[dict]:
    drafts: list[dict] = []
    cursor: str | None = None
    page = 0

    while True:
        page += 1
        path = f"/backend/project_y/profile/drafts/v2?limit={DRAFTS_LIMIT}"
        if cursor:
            path += f"&cursor={urllib.parse.quote(cursor)}"

        print(f"  Fetching drafts page {page}...", flush=True)
        data = await api_get(headers, path)

        items = data.get("items", [])
        if not items:
            break

        drafts.extend(items)
        print(f"  Got {len(items)} drafts ({len(drafts)} total)")

        cursor = data.get("cursor")
        if not cursor:
            break

    return drafts


async def publish_single_draft(headers: dict, draft: dict, delay_s: float) -> tuple[dict, int]:
    body = draft_post_body(draft)
    generation_id = draft_generation_id(draft) or ""
    if body is None:
        return {
            "ok": False,
            "error": "unsupported_draft_kind",
            "permalink": "",
            "generation_id": generation_id,
            "draft_id": str(draft.get("id") or ""),
            "response": None,
            "status": 0,
        }, 1

    resp, err = await api_post_with_retry(headers, "/backend/project_y/post", body, delay_s)
    permalink = ""
    if isinstance(resp, dict):
      permalink = str((resp.get("post") or {}).get("permalink") or "")
    payload = {
        "ok": err is None and bool(permalink),
        "error": err or ("" if permalink else "missing_permalink"),
        "permalink": permalink,
        "generation_id": generation_id,
        "draft_id": str(draft.get("id") or ""),
        "response": resp,
        "status": 200 if permalink and err is None else 0,
    }
    return payload, 0 if payload["ok"] else 1


async def main() -> None:
    parser = argparse.ArgumentParser(description="Publish Sora drafts as unlisted links.")
    parser.add_argument("--token", default=os.environ.get("SORA_TOKEN"), metavar="TOKEN")
    parser.add_argument("--cookie", default=os.environ.get("SORA_COOKIE"), metavar="STR")
    parser.add_argument("--out", default="sora-links.txt", metavar="FILE")
    parser.add_argument("--delay", type=float, default=4.0, metavar="SECS")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--recover", action="store_true")
    parser.add_argument("--user-agent", default=DEFAULT_USER_AGENT, metavar="UA")
    parser.add_argument("--single-draft-json", metavar="FILE")
    parser.add_argument("--json-output", action="store_true")
    args = parser.parse_args()

    if not args.token:
        print("ERROR: provide --token or set SORA_TOKEN env var.", file=sys.stderr)
        sys.exit(1)

    headers = make_headers(args.token, args.cookie or "", args.user_agent or DEFAULT_USER_AGENT)

    if args.single_draft_json:
        with open(os.path.expanduser(args.single_draft_json), "r", encoding="utf-8") as f:
            draft = json.load(f)
        payload, code = await publish_single_draft(headers, draft, args.delay)
        if args.json_output:
            print(json.dumps(payload))
        else:
            if payload["ok"]:
                print(payload["permalink"])
            else:
                print(f"ERROR: {payload['error']}", file=sys.stderr)
        sys.exit(code)

    print("Fetching all drafts...")
    try:
        drafts = await fetch_all_drafts(headers)
    except Exception as e:
        print(f"ERROR fetching drafts: {e}", file=sys.stderr)
        sys.exit(1)

    print(f"Found {len(drafts)} total drafts.\n")

    publishable = [d for d in drafts if draft_post_body(d) is not None]
    skipped_count = len(drafts) - len(publishable)
    print(f"Publishable: {len(publishable)}  |  Skipped (unsupported kind): {skipped_count}")

    if args.dry_run:
        print("\n[dry-run] Would publish:")
        for i, d in enumerate(publishable, 1):
            body = draft_post_body(d)
            dest = body["destinations"][0]["type"] if body else "?"
            print(f"  [{i}/{len(publishable)}] ({dest}) {draft_label(d)}")
        return

    if args.recover:
        out_path = os.path.expanduser(args.out)
        try:
            with open(out_path) as f:
                existing = set(line.strip() for line in f if line.strip())
                permalinks = list(existing)
        except FileNotFoundError:
            existing = set()
            permalinks = []

        recovered = 0
        for d in drafts:
            permalink = draft_existing_permalink(d)
            if permalink and permalink not in existing:
                permalinks.append(permalink)
                existing.add(permalink)
                recovered += 1
                print(f"  recovered: {permalink}")

        with open(out_path, "w") as f:
            f.write("\n".join(permalinks) + ("\n" if permalinks else ""))

        print(f"\nRecovered {recovered} new permalinks. Total in {out_path}: {len(permalinks)}")
        if permalinks:
            print(f"\nDownload all:")
            print(f"  xargs -a '{out_path}' python3 sora-dl.py --out-dir ~/Downloads/sora")
        return

    out_path = os.path.expanduser(args.out)
    done_path = out_path + ".done"
    done_ids = load_done_ids(done_path)

    if done_ids:
        print(f"Loaded {len(done_ids)} already-posted IDs from {done_path}")

    todo = [d for d in publishable if draft_generation_id(d) not in done_ids]
    already_done = len(publishable) - len(todo)
    if already_done:
        print(f"Skipping {already_done} already-posted drafts.")
    print(f"To post: {len(todo)}\n")

    try:
        with open(out_path) as f:
            permalinks = [line.strip() for line in f if line.strip()]
    except FileNotFoundError:
        permalinks = []

    posted = 0
    failed = 0

    for i, draft in enumerate(todo, 1):
        body = draft_post_body(draft)
        gen_id = draft_generation_id(draft)
        label = draft_label(draft)
        print(f"[{i}/{len(todo)}] Posting: {label}", flush=True)

        resp, err = await api_post_with_retry(headers, "/backend/project_y/post", body, args.delay)

        if err:
            print(f"  ERROR: {err}", file=sys.stderr)
            failed += 1
        else:
            permalink = str((resp or {}).get("post", {}).get("permalink") or "")
            if permalink:
                permalinks.append(permalink)
                posted += 1
                if gen_id:
                    save_done_id(done_path, gen_id)
                print(f"  -> {permalink}")
            else:
                print(f"  ERROR: no permalink in response: {resp}", file=sys.stderr)
                failed += 1

        with open(out_path, "w") as f:
            f.write("\n".join(permalinks) + ("\n" if permalinks else ""))

        if i < len(todo):
            await asyncio.sleep(args.delay)

    print(f"\nDone. Posted: {posted}, Failed: {failed}")
    print(f"Permalinks written to: {out_path}")
    if permalinks:
        print(f"\nDownload all:")
        print(f"  xargs -a '{out_path}' python3 sora-dl.py --out-dir ~/Downloads/sora")


if __name__ == "__main__":
    asyncio.run(main())
