import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

try:
    from .x_bookmarks_scrape import (
        DEFAULT_BOOKMARKS_URL,
        DEFAULT_OUT_DIR,
        DEFAULT_USER_DATA_DIR,
        X_HOME_URL,
        discover_bookmark_folders,
        download_media,
        download_videos_with_ytdlp,
        export_cookies_file,
        is_main_bookmarks_url,
        normalize_bookmark_url,
        scroll_and_collect,
        write_outputs,
    )
except ImportError:
    from x_bookmarks_scrape import (
        DEFAULT_BOOKMARKS_URL,
        DEFAULT_OUT_DIR,
        DEFAULT_USER_DATA_DIR,
        X_HOME_URL,
        discover_bookmark_folders,
        download_media,
        download_videos_with_ytdlp,
        export_cookies_file,
        is_main_bookmarks_url,
        normalize_bookmark_url,
        scroll_and_collect,
        write_outputs,
    )


def utc_now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def load_json(path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def collection_id_from_url(url):
    parsed = urlparse(normalize_bookmark_url(url))
    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) >= 3 and parts[0] == "i" and parts[1] == "bookmarks":
        return parts[2]
    if parts == ["i", "bookmarks"]:
        return "main"
    digest = hashlib.sha1(url.encode("utf-8")).hexdigest()[:10]
    return f"url_{digest}"


def collection_out_dir(base_out_dir, url):
    return base_out_dir / collection_id_from_url(url)


def collection_target(url, display_name=None, source_url=None):
    normalized_url = normalize_bookmark_url(url)
    normalized_source_url = normalize_bookmark_url(source_url or normalized_url)
    return {
        "url": normalized_url,
        "collection_id": collection_id_from_url(normalized_url),
        "display_name": display_name or None,
        "source_url": normalized_source_url,
    }


def load_collections_index(base_out_dir):
    data = load_json(base_out_dir / "collections_index.json", {"collections": []})
    if not isinstance(data, dict):
        return {"collections": []}
    collections = data.get("collections", [])
    if not isinstance(collections, list):
        collections = []
    return {
        "updated_at": data.get("updated_at"),
        "collections": collections,
    }


def existing_local_collection_entries(base_out_dir, source_url=None):
    normalized_source_url = normalize_bookmark_url(source_url or DEFAULT_BOOKMARKS_URL)
    entries = []
    seen_ids = set()

    for directory in sorted(base_out_dir.iterdir(), key=lambda path: path.name) if base_out_dir.exists() else []:
        if not directory.is_dir():
            continue
        collection_id = directory.name
        if not collection_id.isdigit():
            continue
        if collection_id in seen_ids:
            continue

        bookmarks_path = directory / "bookmarks.json"
        archive_path = directory / "bookmarks_archive.json"
        if not bookmarks_path.exists() and not archive_path.exists():
            continue

        state = load_json(directory / "pipeline_state.json", {})
        url = normalize_bookmark_url(state.get("url") or f"https://x.com/i/bookmarks/{collection_id}")
        entries.append({
            "collection_id": collection_id,
            "url": url,
            "source_url": normalize_bookmark_url(state.get("source_url") or normalized_source_url),
            "display_name": state.get("display_name"),
        })
        seen_ids.add(collection_id)

    return entries


def indexed_collection_entries_for_source(base_out_dir, source_url):
    normalized_source_url = normalize_bookmark_url(source_url)
    direct_collection_id = collection_id_from_url(normalized_source_url)
    entries = []
    seen_ids = set()

    for raw_entry in load_collections_index(base_out_dir)["collections"]:
        entry_url = normalize_bookmark_url(raw_entry.get("url", ""))
        entry_source_url = normalize_bookmark_url(raw_entry.get("source_url") or entry_url)
        entry_collection_id = raw_entry.get("collection_id") or collection_id_from_url(entry_url)

        if is_main_bookmarks_url(normalized_source_url):
            matches = entry_source_url == normalized_source_url
        else:
            matches = entry_url == normalized_source_url or entry_collection_id == direct_collection_id

        if not matches or entry_collection_id in seen_ids:
            continue

        entries.append({
            "collection_id": entry_collection_id,
            "url": entry_url,
            "source_url": entry_source_url,
            "display_name": raw_entry.get("display_name"),
        })
        seen_ids.add(entry_collection_id)

    if not entries and is_main_bookmarks_url(normalized_source_url):
        return existing_local_collection_entries(base_out_dir, normalized_source_url)

    return entries


def discover_collection_targets(args, page, source_url):
    page.goto(source_url, wait_until="domcontentloaded")
    print(f"\nOpened: {page.url}")
    if args.confirm_before_collect:
        print("After bookmark folders are visible, press Enter to discover folders...\n")
        input()

    folders = discover_bookmark_folders(page)
    if not folders:
        raise RuntimeError(
            "No bookmark folders were discovered on the main bookmarks page. "
            "Open the bookmark index in the connected account and make sure the folder list is visible."
        )

    print(f"Discovered {len(folders)} bookmark folder(s) from the main bookmarks page:")
    for folder in folders:
        print(f"- {folder['name']}: {folder['url']}")

    return [
        collection_target(folder["url"], display_name=folder["name"], source_url=source_url)
        for folder in folders
    ]


def resolve_collection_targets(args, page):
    targets = []
    seen_collection_ids = set()

    for source_url in load_urls(args):
        normalized_source_url = normalize_bookmark_url(source_url)
        if is_main_bookmarks_url(normalized_source_url):
            if args.existing_only:
                source_targets = [
                    collection_target(
                        entry["url"],
                        display_name=entry.get("display_name"),
                        source_url=normalized_source_url,
                    )
                    for entry in indexed_collection_entries_for_source(args.out_dir, normalized_source_url)
                ]
                if not source_targets:
                    raise RuntimeError(
                        "No discovered bookmark folders are saved for https://x.com/i/bookmarks yet. "
                        "Run a normal sync first so the pipeline can discover and index them."
                    )
            else:
                source_targets = discover_collection_targets(args, page, normalized_source_url)
        else:
            indexed_entries = indexed_collection_entries_for_source(args.out_dir, normalized_source_url)
            display_name = indexed_entries[0].get("display_name") if indexed_entries else None
            source_targets = [
                collection_target(
                    normalized_source_url,
                    display_name=display_name,
                    source_url=normalized_source_url,
                )
            ]

        for target in source_targets:
            if target["collection_id"] in seen_collection_ids:
                continue
            targets.append(target)
            seen_collection_ids.add(target["collection_id"])

    return targets


def entry_key(post):
    if post.get("post_url"):
        return post["post_url"]
    text = post.get("text", "")
    digest = hashlib.sha1(text.encode("utf-8")).hexdigest()
    return f"text:{digest}"


def load_archive(archive_path, out_dir):
    archive_posts = load_json(archive_path, None)
    if archive_posts is not None:
        return archive_posts

    existing_bookmarks_path = out_dir / "bookmarks.json"
    existing_posts = load_json(existing_bookmarks_path, None)
    if existing_posts is None:
        return []

    seeded_at = utc_now()
    for post in existing_posts:
        post.setdefault("pipeline_key", entry_key(post))
        post.setdefault("first_seen_at", seeded_at)
        post.setdefault("last_seen_at", seeded_at)

    print(f"Seeded archive from existing bookmarks.json with {len(existing_posts)} entries.")
    return existing_posts


def merge_new_posts(scraped_posts, archive_posts):
    archive_by_key = {entry_key(post): post for post in archive_posts}
    new_posts = []

    for post in scraped_posts:
        key = entry_key(post)
        if key in archive_by_key:
            existing = archive_by_key[key]
            existing.setdefault("first_seen_at", utc_now())
            existing["last_seen_at"] = utc_now()
            continue

        post["pipeline_key"] = key
        post["first_seen_at"] = utc_now()
        post["last_seen_at"] = post["first_seen_at"]
        archive_posts.append(post)
        archive_by_key[key] = post
        new_posts.append(post)

    return new_posts, archive_posts


def initialize_archive_posts(scraped_posts):
    initialized = []
    timestamp = utc_now()
    for post in scraped_posts:
        prepared = dict(post)
        prepared["pipeline_key"] = entry_key(prepared)
        prepared["first_seen_at"] = timestamp
        prepared["last_seen_at"] = timestamp
        initialized.append(prepared)
    return initialized


def open_browser(args):
    playwright = sync_playwright().start()
    browser = None
    if args.cdp_url:
        browser = playwright.chromium.connect_over_cdp(args.cdp_url)
        context = browser.contexts[0] if browser.contexts else browser.new_context()
        page = context.pages[0] if context.pages else context.new_page()
    else:
        context = playwright.chromium.launch_persistent_context(
            str(args.profile_dir.resolve()),
            headless=False,
            viewport={"width": 1440, "height": 1000},
        )
        page = context.new_page()

    return playwright, browser, context, page


def resolve_cookies_file(args, context):
    cookies_file = args.cookies_file
    if args.export_cookies_file:
        cookies_file = export_cookies_file(context, args.export_cookies_file)
    elif args.cdp_url and (args.yt_dlp or args.yt_dlp_fallback):
        cookies_file = export_cookies_file(context, args.out_dir / "x_cookies.txt")
    return cookies_file


def close_browser(playwright, browser, context):
    if browser:
        print("Leaving the connected browser open.")
    else:
        context.close()
    playwright.stop()


def maybe_login(args, page):
    if not args.login_first:
        return

    page.goto(X_HOME_URL, wait_until="domcontentloaded")
    print("\nAfter your X home timeline is visible, press Enter to open bookmarks...\n")
    input()


def scrape_url(page, url, rounds, pause_sec, confirm_before_collect=True):
    page.goto(url, wait_until="domcontentloaded")
    print(f"\nOpened: {page.url}")
    if confirm_before_collect:
        print("After bookmarks are visible, press Enter to collect visible entries...\n")
        input()
    return scroll_and_collect(page, rounds=rounds, pause_sec=pause_sec)


def process_collection_posts(args, posts_to_process, archive_posts, out_dir, cookies_file):
    if args.download_media and posts_to_process:
        download_media(
            posts_to_process,
            out_dir,
            yt_dlp_fallback=args.yt_dlp_fallback and not args.yt_dlp,
            cookies_file=cookies_file,
        )
    if args.yt_dlp and posts_to_process:
        download_videos_with_ytdlp(posts_to_process, out_dir, cookies_file=cookies_file)

    write_outputs(archive_posts, out_dir)


def run_collection(args, page, target, cookies_file):
    url = target["url"]
    out_dir = collection_out_dir(args.out_dir, url)
    out_dir.mkdir(parents=True, exist_ok=True)
    archive_path = out_dir / "bookmarks_archive.json"
    state_path = out_dir / "pipeline_state.json"

    archive_posts = load_archive(archive_path, out_dir)
    state = load_json(state_path, {"runs": []})

    if args.existing_only:
        scraped_posts = []
        new_posts = []
        posts_to_process = archive_posts
        print(
            "Reprocessing existing archive only: "
            f"{target['collection_id']} ({len(archive_posts)} archived entries)."
        )
    else:
        scraped_posts = scrape_url(
            page,
            url,
            args.rounds,
            args.pause_sec,
            confirm_before_collect=args.confirm_before_collect,
        )
        if args.rebuild_archive:
            archive_posts = initialize_archive_posts(scraped_posts)
            new_posts = archive_posts
            posts_to_process = archive_posts
            print(
                "Rebuilt archive from fresh scrape: "
                f"{target['collection_id']} ({len(archive_posts)} archived entries)."
            )
        else:
            new_posts, archive_posts = merge_new_posts(scraped_posts, archive_posts)
            posts_to_process = archive_posts if args.process_all else new_posts

    process_collection_posts(args, posts_to_process, archive_posts, out_dir, cookies_file)
    write_json(archive_path, archive_posts)

    run_summary = {
        "ran_at": utc_now(),
        "url": url,
        "source_url": target.get("source_url"),
        "collection_id": target["collection_id"],
        "display_name": target.get("display_name"),
        "scraped_count": len(scraped_posts),
        "new_count": len(new_posts),
        "archive_count": len(archive_posts),
        "processed_count": len(posts_to_process),
        "existing_only": args.existing_only,
        "process_all": args.process_all or args.existing_only or args.rebuild_archive,
        "rebuild_archive": args.rebuild_archive,
        "yt_dlp": args.yt_dlp,
        "download_media": args.download_media,
    }
    state.setdefault("runs", []).append(run_summary)
    state["last_run"] = run_summary
    state["collection_id"] = target["collection_id"]
    state["url"] = url
    state["source_url"] = target.get("source_url")
    state["display_name"] = target.get("display_name")
    write_json(state_path, state)

    label = target.get("display_name") or target["collection_id"]
    print(
        "Collection complete: "
        f"{label} ({target['collection_id']}): {len(scraped_posts)} scraped, "
        f"{len(new_posts)} new, {len(archive_posts)} archived, "
        f"{len(posts_to_process)} processed"
        f"{' (existing archive rerun)' if args.existing_only else ''}"
        f"{' (archive rebuilt)' if args.rebuild_archive else ''}."
    )
    return run_summary


def update_collections_index(base_out_dir, summaries):
    existing_entries = load_collections_index(base_out_dir)["collections"]
    merged_entries = {}
    ordered_ids = []

    for entry in existing_entries:
        entry_url = normalize_bookmark_url(entry.get("url", ""))
        collection_id = entry.get("collection_id") or collection_id_from_url(entry_url)
        if not collection_id:
            continue
        normalized_entry = dict(entry)
        normalized_entry["url"] = entry_url
        normalized_entry["source_url"] = normalize_bookmark_url(entry.get("source_url") or entry_url)
        merged_entries[collection_id] = normalized_entry
        ordered_ids.append(collection_id)

    for summary in summaries:
        collection_id = summary["collection_id"]
        previous = merged_entries.get(collection_id, {})
        existing_source_url = normalize_bookmark_url(previous.get("source_url") or "")
        summary_source_url = normalize_bookmark_url(summary.get("source_url") or summary["url"])
        if existing_source_url and is_main_bookmarks_url(existing_source_url) and summary_source_url == summary["url"]:
            source_url = existing_source_url
        else:
            source_url = summary_source_url or existing_source_url or summary["url"]
        merged_entries[collection_id] = {
            "collection_id": collection_id,
            "url": summary["url"],
            "source_url": source_url,
            "display_name": summary.get("display_name") or previous.get("display_name"),
            "out_dir": str(collection_out_dir(base_out_dir, summary["url"]).relative_to(base_out_dir)),
            "archive_count": summary["archive_count"],
            "new_count": summary["new_count"],
            "processed_count": summary["processed_count"],
            "existing_only": summary["existing_only"],
            "process_all": summary["process_all"],
            "rebuild_archive": summary["rebuild_archive"],
        }
        if collection_id not in ordered_ids:
            ordered_ids.append(collection_id)

    write_json(base_out_dir / "collections_index.json", {
        "updated_at": utc_now(),
        "collections": [merged_entries[collection_id] for collection_id in ordered_ids],
    })


def parse_args():
    parser = argparse.ArgumentParser(
        description="Incremental X bookmarks pipeline. Scrapes, archives, and downloads only new entries."
    )
    parser.add_argument(
        "--url",
        action="append",
        dest="urls",
        help="Bookmark URL to scrape. Repeat for multiple bookmark folders.",
    )
    parser.add_argument(
        "--urls-file",
        type=Path,
        help="Text file with one bookmark URL per line. Blank lines and # comments are ignored.",
    )
    parser.add_argument("--rounds", type=int, default=15)
    parser.add_argument("--pause-sec", type=float, default=2.5)
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument("--profile-dir", type=Path, default=DEFAULT_USER_DATA_DIR)
    parser.add_argument("--cdp-url")
    parser.add_argument("--login-first", action=argparse.BooleanOptionalAction, default=False)
    parser.add_argument(
        "--confirm-before-collect",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Wait for Enter after each bookmark page opens. Disable for UI/background runs.",
    )
    parser.add_argument("--download-media", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--yt-dlp", action="store_true")
    parser.add_argument(
        "--yt-dlp-fallback",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="After the normal direct-media download path, use yt-dlp only for posts that still have no downloaded video.",
    )
    parser.add_argument("--cookies-file", type=Path)
    parser.add_argument("--export-cookies-file", type=Path)
    parser.add_argument(
        "--process-all",
        action="store_true",
        help="Download media for the full archive instead of only newly discovered entries.",
    )
    parser.add_argument(
        "--existing-only",
        action="store_true",
        help="Do not scrape X. Reprocess the saved archive/media outputs for the selected collections only.",
    )
    parser.add_argument(
        "--rebuild-archive",
        action="store_true",
        help="Scrape X and replace the saved archive for each selected collection with the freshly scraped entries.",
    )
    return parser.parse_args()


def load_urls(args):
    urls = [normalize_bookmark_url(url) for url in (args.urls or [])]
    if args.urls_file:
        for line in args.urls_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                urls.append(normalize_bookmark_url(line))

    if not urls:
        urls.append(DEFAULT_BOOKMARKS_URL)

    return list(dict.fromkeys(urls))


def main():
    args = parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)

    if args.existing_only:
        cookies_file = args.cookies_file
        if args.cdp_url and (args.yt_dlp or args.yt_dlp_fallback or args.export_cookies_file):
            playwright, browser, context, _page = open_browser(args)
            try:
                cookies_file = resolve_cookies_file(args, context)
            finally:
                close_browser(playwright, browser, context)
        targets = resolve_collection_targets(args, None)
        summaries = []
        for target in targets:
            summaries.append(run_collection(args, None, target, cookies_file))
    else:
        playwright, browser, context, page = open_browser(args)
        try:
            cookies_file = resolve_cookies_file(args, context)

            maybe_login(args, page)

            targets = resolve_collection_targets(args, page)
            summaries = []
            for target in targets:
                summaries.append(run_collection(args, page, target, cookies_file))
        finally:
            close_browser(playwright, browser, context)

    write_json(args.out_dir / "pipeline_state.json", {
        "last_run_at": utc_now(),
        "collections": summaries,
    })
    update_collections_index(args.out_dir, summaries)

    print(f"Pipeline complete: {len(summaries)} collection(s) processed.")


if __name__ == "__main__":
    main()
