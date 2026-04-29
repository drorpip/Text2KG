import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import unicodedata
from pathlib import Path
from urllib.parse import parse_qs, urlparse, urlunparse
from urllib.request import Request, urlopen

from playwright.sync_api import sync_playwright

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(errors="replace")

DEFAULT_BOOKMARKS_URL = "https://x.com/i/bookmarks"
X_HOME_URL = "https://x.com/home"
SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_OUT_DIR = SCRIPT_DIR / "x_bookmarks_output"

# Use a dedicated automation profile folder.
# Do NOT point this at your normal Chrome user profile.
DEFAULT_USER_DATA_DIR = SCRIPT_DIR / "playwright_x_profile"
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)
DEFAULT_OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")
DEFAULT_MEDIA_TITLE_MODEL = os.environ.get("OLLAMA_MEDIA_TITLE_MODEL", "gemma4:e4b")
DEFAULT_OLLAMA_TAGS_TIMEOUT = float(os.environ.get("OLLAMA_TAGS_TIMEOUT_SEC", "5"))
DEFAULT_OLLAMA_GENERATE_TIMEOUT = float(os.environ.get("OLLAMA_GENERATE_TIMEOUT_SEC", "180"))


def unique(values):
    return list(dict.fromkeys(value for value in values if value))


def collapse_whitespace(text):
    return re.sub(r"\s+", " ", (text or "")).strip()


def normalize_bookmark_url(url):
    url = (url or "").strip()
    if not url:
        return ""

    if "://" not in url:
        url = f"https://{url.lstrip('/')}"

    parsed = urlparse(url)
    scheme = parsed.scheme or "https"
    host = parsed.netloc.lower()
    if host.startswith("www."):
        host = host[4:]
    if host in {"twitter.com", "mobile.twitter.com"}:
        host = "x.com"

    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) >= 2 and parts[0] == "i" and parts[1] == "bookmarks":
        if len(parts) >= 3:
            return f"{scheme}://{host or 'x.com'}/i/bookmarks/{parts[2]}"
        return f"{scheme}://{host or 'x.com'}/i/bookmarks"

    path = f"/{'/'.join(parts)}" if parts else "/"
    if path != "/" and path.endswith("/"):
        path = path.rstrip("/")
    return urlunparse((scheme, host or parsed.netloc, path, "", "", ""))


def bookmark_url_parts(url):
    parsed = urlparse(normalize_bookmark_url(url))
    return [part for part in parsed.path.split("/") if part]


def is_main_bookmarks_url(url):
    return bookmark_url_parts(url) == ["i", "bookmarks"]


def clean_bookmark_folder_name(raw_text):
    lines = [collapse_whitespace(line) for line in re.split(r"[\r\n]+", raw_text or "")]
    for line in lines:
        if line and not line.lower().startswith("http"):
            return line
    return collapse_whitespace(raw_text)


def discover_bookmark_folders(page):
    pivot_selector = "a[data-testid='pivot'][href*='/i/bookmarks/'], a[role='tab'][href*='/i/bookmarks/']"
    generic_selector = "a[href*='/i/bookmarks/']"
    try:
        page.wait_for_selector(pivot_selector, timeout=10000)
    except Exception:
        page.wait_for_timeout(3000)

    anchors = page.locator(f"{pivot_selector}, {generic_selector}")
    try:
        raw_folders = anchors.evaluate_all(
            """els => els.map(a => ({
                href: a.href || '',
                text: a.innerText || a.textContent || '',
                title: a.getAttribute('title') || '',
                ariaLabel: a.getAttribute('aria-label') || '',
                role: a.getAttribute('role') || '',
                testid: a.getAttribute('data-testid') || ''
            }))"""
        )
    except Exception:
        return []

    folders = []
    seen_urls = set()
    for raw_folder in raw_folders:
        href = normalize_bookmark_url(raw_folder.get("href", ""))
        parts = bookmark_url_parts(href)
        if len(parts) < 3 or parts[0] != "i" or parts[1] != "bookmarks":
            continue
        if raw_folder.get("testid") != "pivot" and raw_folder.get("role") != "tab":
            continue

        if href in seen_urls:
            continue

        collection_id = parts[2]
        name = (
            clean_bookmark_folder_name(raw_folder.get("text"))
            or clean_bookmark_folder_name(raw_folder.get("title"))
            or clean_bookmark_folder_name(raw_folder.get("ariaLabel"))
            or f"Folder {collection_id}"
        )
        folders.append({
            "id": collection_id,
            "url": href,
            "name": name,
        })
        seen_urls.add(href)

    return folders


def normalize_x_image_url(url):
    if "pbs.twimg.com/media/" not in url:
        return url
    base = url.split("?")[0]
    return f"{base}?format=jpg&name=orig"


def media_extension(url, content_type=None):
    parsed = urlparse(url)
    suffix = Path(parsed.path).suffix
    if suffix:
        return suffix.split(":")[0]

    query = parse_qs(parsed.query)
    if query.get("format"):
        return f".{query['format'][0].split(':')[0]}"

    if content_type:
        content_type = content_type.split(";")[0].strip().lower()
        return {
            "image/jpeg": ".jpg",
            "image/jpg": ".jpg",
            "image/png": ".png",
            "image/webp": ".webp",
            "image/gif": ".gif",
            "video/mp4": ".mp4",
        }.get(content_type, ".bin")

    return ".bin"


def clean_post_text(text):
    raw_lines = [raw_line.strip() for raw_line in (text or "").splitlines()]
    raw_lines = [line for line in raw_lines if line]

    lines = []
    for index, line in enumerate(raw_lines):
        if not line:
            continue
        lower = line.lower()
        next_line = raw_lines[index + 1] if index + 1 < len(raw_lines) else ""
        if lower in {"quote", "show more", "show less"}:
            continue
        if lower.startswith("replying to "):
            continue
        if line.startswith("@"):
            continue
        if re.fullmatch(r"\d+[smhdwy]", lower):
            continue
        if next_line.startswith("@") and re.fullmatch(r"[A-Za-z0-9 ._'’\-]+", line):
            continue
        lines.append(line)
    return "\n".join(lines).strip()


def extract_primary_post_text(article):
    try:
        text_blocks = article.locator("[data-testid='tweetText']").all_inner_texts()
        cleaned_blocks = [clean_post_text(block) for block in text_blocks if clean_post_text(block)]
        if cleaned_blocks:
            return cleaned_blocks[0]
    except Exception:
        pass

    try:
        return clean_post_text(article.inner_text(timeout=2000).strip())
    except Exception:
        return ""


def slugify_label(text):
    normalized = unicodedata.normalize("NFKD", text or "")
    ascii_text = normalized.encode("ascii", "ignore").decode("ascii").lower()
    words = re.findall(r"[a-z0-9]+", ascii_text)
    return "-".join(words[:4])


def ollama_is_available(host=DEFAULT_OLLAMA_HOST):
    try:
        with urlopen(f"{host.rstrip('/')}/api/tags", timeout=DEFAULT_OLLAMA_TAGS_TIMEOUT) as response:
            return response.status == 200
    except Exception:
        return False


def ollama_generate_title(
    text,
    host=DEFAULT_OLLAMA_HOST,
    model=DEFAULT_MEDIA_TITLE_MODEL,
    timeout=DEFAULT_OLLAMA_GENERATE_TIMEOUT,
):
    prompt = (
        "Create a very short filename label for this post text.\n"
        "Find the best short name based on the meaning of the text, not the first words.\n"
        "Return only 2 to 4 plain words, no punctuation, no explanation.\n"
        "Example output: Oct 7 massacre\n\n"
        f"Post text:\n{text}"
    )
    payload = json.dumps({
        "model": model,
        "prompt": prompt,
        "stream": False,
    }).encode("utf-8")
    request = Request(
        f"{host.rstrip('/')}/api/generate",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=timeout) as response:
        body = json.loads(response.read().decode("utf-8"))
    return (body.get("response") or "").strip()


def semantic_media_title(post, host=DEFAULT_OLLAMA_HOST, model=DEFAULT_MEDIA_TITLE_MODEL):
    cached = post.get("media_title")
    if cached:
        return cached

    text = clean_post_text(post.get("text", ""))
    if not text:
        return ""
    if not ollama_is_available(host=host):
        return ""

    try:
        title = ollama_generate_title(text, host=host, model=model)
    except Exception as exc:
        print(f"Ollama media title failed: {exc}")
        return ""

    slug = slugify_label(title)
    if slug:
        post["media_title"] = slug
    return slug


def media_title_slug(post, host=DEFAULT_OLLAMA_HOST, model=DEFAULT_MEDIA_TITLE_MODEL):
    return semantic_media_title(post, host=host, model=model)


def media_basename(item_index, media_index, post, url):
    digest = hashlib.sha1(url.encode("utf-8")).hexdigest()[:10]
    slug = media_title_slug(post)
    if slug:
        return f"{slug}_{item_index:03d}_{media_index:02d}_{digest}"
    return f"item_{item_index:03d}_{media_index:02d}_{digest}"


def media_filename(item_index, media_index, post, url, content_type=None):
    extension = media_extension(url, content_type)
    return f"{media_basename(item_index, media_index, post, url)}{extension}"


def log_media_title(post, item_index, title_slug, source):
    if not title_slug:
        return
    text_preview = clean_post_text(post.get("text", "")).replace("\n", " ")
    if len(text_preview) > 120:
        text_preview = text_preview[:117] + "..."
    print(f"Media title item {item_index:03d} ({source}): {title_slug}")
    if text_preview:
        print(f"  from post: {text_preview}")


def relative_out_path(path, out_dir):
    return str(path.relative_to(out_dir))


def rename_existing_path(old_path, target_path):
    if old_path == target_path:
        return target_path, False
    target_path.parent.mkdir(parents=True, exist_ok=True)
    if target_path.exists():
        if old_path.exists():
            old_path.unlink()
        return target_path, True
    old_path.replace(target_path)
    return target_path, True


def rename_existing_media(post, out_dir, item_index):
    renamed_paths = {
        "downloaded_images": [],
        "downloaded_videos": [],
        "downloaded_video_thumbnails": [],
        "yt_dlp_downloads": [],
    }
    title_slug = post.get("media_title")
    if not title_slug:
        return renamed_paths

    old_images = list(post.get("downloaded_images", []))
    for media_index, url in enumerate(post.get("image_urls", []), 1):
        if media_index > len(old_images):
            break
        old_relative = old_images[media_index - 1]
        old_path = out_dir / old_relative
        if not old_path.exists():
            continue
        target_path = out_dir / "media" / "images" / media_filename(item_index, media_index, post, url)
        final_path, changed = rename_existing_path(old_path, target_path)
        renamed_paths["downloaded_images"].append(relative_out_path(final_path, out_dir))
        if changed:
            print(f"Renamed existing image: {old_relative} -> {relative_out_path(final_path, out_dir)}")

    old_videos = list(post.get("downloaded_videos", []))
    old_thumbnails = list(post.get("downloaded_video_thumbnails", []))
    video_counter = 0
    thumbnail_counter = 0
    for media_index, url in enumerate(post.get("video_sources", []), 1):
        if is_video_thumbnail_url(url):
            thumbnail_counter += 1
            if thumbnail_counter > len(old_thumbnails):
                continue
            old_relative = old_thumbnails[thumbnail_counter - 1]
            old_path = out_dir / old_relative
            if not old_path.exists():
                continue
            target_path = out_dir / "media" / "video_thumbnails" / media_filename(item_index, media_index, post, url)
            final_path, changed = rename_existing_path(old_path, target_path)
            renamed_paths["downloaded_video_thumbnails"].append(relative_out_path(final_path, out_dir))
            if changed:
                print(f"Renamed existing video thumbnail: {old_relative} -> {relative_out_path(final_path, out_dir)}")
        elif is_direct_video_url(url):
            video_counter += 1
            if video_counter > len(old_videos):
                continue
            old_relative = old_videos[video_counter - 1]
            old_path = out_dir / old_relative
            if not old_path.exists():
                continue
            target_path = out_dir / "media" / "videos" / media_filename(item_index, media_index, post, url)
            final_path, changed = rename_existing_path(old_path, target_path)
            renamed_paths["downloaded_videos"].append(relative_out_path(final_path, out_dir))
            if changed:
                print(f"Renamed existing video: {old_relative} -> {relative_out_path(final_path, out_dir)}")

    old_ytdlp = list(post.get("yt_dlp_downloads", []))
    for old_relative in old_ytdlp:
        old_path = out_dir / old_relative
        if not old_path.exists():
            continue
        stem = old_path.stem
        suffix = old_path.suffix
        match = re.match(r"^(?:item|.+)_(\d{3})_(.+)$", stem)
        if match and match.group(1) == f"{item_index:03d}":
            rest = match.group(2)
        else:
            rest = stem
        target_name = f"{title_slug}_{item_index:03d}_{rest}{suffix}"
        target_path = out_dir / "media" / "videos" / target_name
        final_path, changed = rename_existing_path(old_path, target_path)
        renamed_paths["yt_dlp_downloads"].append(relative_out_path(final_path, out_dir))
        if changed:
            print(f"Renamed existing yt-dlp video: {old_relative} -> {relative_out_path(final_path, out_dir)}")

    return renamed_paths


def rename_existing_media_only(posts, out_dir):
    title_enabled = ollama_is_available()
    for item_index, post in enumerate(posts, 1):
        title_slug = media_title_slug(post) if title_enabled else ""
        if title_slug:
            post["media_title"] = title_slug
            log_media_title(post, item_index, title_slug, "ollama" if title_enabled else "fallback")
        renamed_paths = rename_existing_media(post, out_dir, item_index)
        post["downloaded_images"] = renamed_paths["downloaded_images"]
        post["downloaded_videos"] = renamed_paths["downloaded_videos"]
        post["downloaded_video_thumbnails"] = renamed_paths["downloaded_video_thumbnails"]
        post["yt_dlp_downloads"] = renamed_paths["yt_dlp_downloads"]

    write_outputs(posts, out_dir)


def load_existing_posts_for_local_ops(out_dir):
    bookmarks_json_path = out_dir / "bookmarks.json"
    archive_json_path = out_dir / "bookmarks_archive.json"

    if bookmarks_json_path.exists():
        return json.loads(bookmarks_json_path.read_text(encoding="utf-8")), bookmarks_json_path
    if archive_json_path.exists():
        return json.loads(archive_json_path.read_text(encoding="utf-8")), archive_json_path
    return None, None


def is_video_thumbnail_url(url):
    parsed = urlparse(url)
    return parsed.netloc == "pbs.twimg.com" and "_thumb/" in parsed.path


def is_direct_video_url(url):
    parsed = urlparse(url)
    if parsed.path.endswith(".m3u8"):
        return False
    return parsed.netloc.endswith("video.twimg.com") or parsed.path.endswith(".mp4")


def is_stream_playlist_url(url):
    return urlparse(url).path.endswith(".m3u8")


def has_saved_video_file(post):
    video_extensions = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"}
    for field in ("downloaded_videos", "yt_dlp_downloads"):
        for path in post.get(field, []):
            if Path(path).suffix.lower() in video_extensions:
                return True
    return False


def download_url(url, destination):
    request = Request(url, headers={"User-Agent": DEFAULT_USER_AGENT})
    with urlopen(request, timeout=30) as response:
        content_type = response.headers.get("Content-Type")
        data = response.read()

    final_destination = destination.with_suffix(media_extension(url, content_type))
    final_destination.write_bytes(data)
    return final_destination


def append_unique_paths(post, field, paths, out_dir):
    existing = post.setdefault(field, [])
    seen = set(existing)
    for path in paths:
        relative = str(path.relative_to(out_dir))
        if relative not in seen:
            existing.append(relative)
            seen.add(relative)


def post_needs_video_fallback(post):
    if not post.get("post_url"):
        return False
    if has_saved_video_file(post):
        return False
    return bool(
        post.get("has_video")
        or post.get("video_sources")
        or post.get("downloaded_video_thumbnails")
        or post.get("skipped_video_sources")
    )


def download_post_video_with_ytdlp(
    post,
    out_dir,
    item_index,
    yt_dlp_path,
    cookies_from_browser=None,
    cookies_file=None,
):
    post.setdefault("yt_dlp_downloads", [])
    post.setdefault("video_download_failures", [])
    post_url = post.get("post_url")
    if not post_url:
        return False

    video_dir = out_dir / "media" / "videos"
    video_dir.mkdir(parents=True, exist_ok=True)
    file_prefix = media_title_slug(post)
    if file_prefix:
        file_prefix = f"{file_prefix}_{item_index:03d}"
    else:
        file_prefix = f"item_{item_index:03d}"

    def base_command():
        output_template = str(video_dir / f"{file_prefix}_%(id)s.%(ext)s")
        command = [
            yt_dlp_path,
            "--no-playlist",
            "--ignore-errors",
            "--no-part",
            "--retries",
            "3",
            "--fragment-retries",
            "3",
            "--retry-sleep",
            "1",
            "--print",
            "after_move:filepath",
            "-o",
            output_template,
        ]
        if cookies_file:
            command.extend(["--cookies", str(cookies_file)])
        if cookies_from_browser:
            command.extend(["--cookies-from-browser", cookies_from_browser])
        command.append(post_url)
        return command

    def collect_downloaded_paths():
        matched_paths = []
        for path in sorted(video_dir.glob(f"{file_prefix}_*")):
            if path.is_file():
                matched_paths.append(path)
        return matched_paths

    def run_attempt(command, label):
        print(f"yt-dlp ({label}): {post_url}")
        result = subprocess.run(command, capture_output=True, text=True)
        output = "\n".join(part for part in [result.stdout.strip(), result.stderr.strip()] if part).strip()
        return result, output

    attempts = [("default", base_command())]
    final_message = ""

    for attempt_index, (label, command) in enumerate(attempts, 1):
        result, output = run_attempt(command, label)
        matched_paths = collect_downloaded_paths()
        if result.returncode == 0 and matched_paths:
            append_unique_paths(post, "yt_dlp_downloads", matched_paths, out_dir)
            return True

        final_message = output or "unknown yt-dlp error"
        lower_output = final_message.lower()
        should_retry_416 = "http error 416" in lower_output and label == "default"
        should_retry_cookie = "invalid expires" in lower_output and label == "default"

        if matched_paths:
            append_unique_paths(post, "yt_dlp_downloads", matched_paths, out_dir)
            return True

        if should_retry_416 or should_retry_cookie:
            retry_command = base_command()
            retry_command[1:1] = ["--force-overwrites"]
            if should_retry_416:
                retry_command[1:1] = ["--http-chunk-size", "1M"]
            attempts.append(("retry", retry_command))
            continue

        break

    post["video_download_failures"].append(f"yt-dlp: {final_message}")
    print(f"yt-dlp failed for item {item_index}: {final_message}")
    return False


def download_media(
    posts,
    out_dir,
    yt_dlp_fallback=False,
    cookies_from_browser=None,
    cookies_file=None,
):
    image_dir = out_dir / "media" / "images"
    video_dir = out_dir / "media" / "videos"
    thumbnail_dir = out_dir / "media" / "video_thumbnails"
    image_dir.mkdir(parents=True, exist_ok=True)
    video_dir.mkdir(parents=True, exist_ok=True)
    thumbnail_dir.mkdir(parents=True, exist_ok=True)

    downloaded = 0
    skipped = 0
    failed = 0
    fallback_downloaded = 0
    fallback_attempted = 0
    yt_dlp_path = shutil.which("yt-dlp") if yt_dlp_fallback else None
    title_enabled = ollama_is_available()

    if yt_dlp_fallback and not yt_dlp_path:
        print("yt-dlp fallback requested but yt-dlp is not installed or not on PATH. Skipping fallback.")

    for item_index, post in enumerate(posts, 1):
        previous_downloaded_images = list(post.get("downloaded_images", []))
        previous_downloaded_videos = list(post.get("downloaded_videos", []))
        previous_downloaded_video_thumbnails = list(post.get("downloaded_video_thumbnails", []))
        previous_ytdlp_downloads = list(post.get("yt_dlp_downloads", []))

        post["downloaded_images"] = []
        post["downloaded_videos"] = []
        post["downloaded_video_thumbnails"] = []
        post["skipped_video_sources"] = []
        post["yt_dlp_downloads"] = []
        post.setdefault("video_download_failures", [])
        title_slug = media_title_slug(post) if title_enabled else ""
        if title_slug:
            post["media_title"] = title_slug
            log_media_title(post, item_index, title_slug, "ollama" if title_enabled else "fallback")

        post["downloaded_images"] = previous_downloaded_images
        post["downloaded_videos"] = previous_downloaded_videos
        post["downloaded_video_thumbnails"] = previous_downloaded_video_thumbnails
        post["yt_dlp_downloads"] = previous_ytdlp_downloads
        renamed_paths = rename_existing_media(post, out_dir, item_index)
        post["downloaded_images"] = renamed_paths["downloaded_images"]
        post["downloaded_videos"] = renamed_paths["downloaded_videos"]
        post["downloaded_video_thumbnails"] = renamed_paths["downloaded_video_thumbnails"]
        post["yt_dlp_downloads"] = renamed_paths["yt_dlp_downloads"]

        for media_index, url in enumerate(post.get("image_urls", []), 1):
            try:
                destination = image_dir / media_filename(item_index, media_index, post, url)
                if not destination.exists():
                    destination = download_url(url, destination)
                append_unique_paths(post, "downloaded_images", [destination], out_dir)
                downloaded += 1
                print(f"Downloaded image: {destination}")
            except Exception as exc:
                failed += 1
                print(f"Failed image download: {url} ({exc})")

        for media_index, url in enumerate(post.get("video_sources", []), 1):
            if not url.startswith(("http://", "https://")):
                post["skipped_video_sources"].append(url)
                skipped += 1
                continue

            try:
                if is_video_thumbnail_url(url):
                    destination_dir = thumbnail_dir
                    target_field = "downloaded_video_thumbnails"
                    label = "video thumbnail"
                elif is_direct_video_url(url):
                    destination_dir = video_dir
                    target_field = "downloaded_videos"
                    label = "video"
                elif is_stream_playlist_url(url):
                    post["skipped_video_sources"].append(url)
                    skipped += 1
                    continue
                else:
                    post["skipped_video_sources"].append(url)
                    skipped += 1
                    continue

                destination = destination_dir / media_filename(item_index, media_index, post, url)
                if not destination.exists():
                    destination = download_url(url, destination)
                append_unique_paths(post, target_field, [destination], out_dir)
                downloaded += 1
                print(f"Downloaded {label}: {destination}")
            except Exception as exc:
                failed += 1
                print(f"Failed video source download: {url} ({exc})")

        if yt_dlp_path and post_needs_video_fallback(post):
            fallback_attempted += 1
            if download_post_video_with_ytdlp(
                post,
                out_dir,
                item_index,
                yt_dlp_path,
                cookies_from_browser=cookies_from_browser,
                cookies_file=cookies_file,
            ):
                fallback_downloaded += 1

    print(
        f"Media download complete: {downloaded} downloaded, "
        f"{skipped} non-downloadable sources skipped, {failed} failed."
    )
    if yt_dlp_path:
        print(
            f"yt-dlp fallback complete: {fallback_downloaded} posts recovered, "
            f"{fallback_attempted - fallback_downloaded} still without a video file."
        )


def bool_to_netscape(value):
    return "TRUE" if value else "FALSE"


def export_cookies_file(context, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    cookies = context.cookies(["https://x.com", "https://twitter.com"])
    lines = [
        "# Netscape HTTP Cookie File",
        "# Generated by x_bookmarks_scrape.py from the connected browser session.",
    ]

    for cookie in cookies:
        domain = cookie["domain"]
        include_subdomains = domain.startswith(".")
        path = cookie.get("path", "/")
        secure = cookie.get("secure", False)
        expires_raw = cookie.get("expires")
        expires = int(expires_raw or 0)
        if expires < 0:
            expires = 0
        name = cookie["name"]
        value = str(cookie["value"]).replace("\t", " ").replace("\r", "").replace("\n", " ")
        lines.append(
            "\t".join([
                domain,
                bool_to_netscape(include_subdomains),
                path,
                bool_to_netscape(secure),
                str(expires),
                name,
                value,
            ])
        )

    destination.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Exported {len(cookies)} cookies to: {destination}")
    return destination


def download_videos_with_ytdlp(posts, out_dir, cookies_from_browser=None, cookies_file=None):
    yt_dlp = shutil.which("yt-dlp")
    if not yt_dlp:
        print("yt-dlp is not installed or not on PATH. Skipping real video downloads.")
        print("Install it in your venv with: python -m pip install yt-dlp")
        return

    video_dir = out_dir / "media" / "videos"
    video_dir.mkdir(parents=True, exist_ok=True)

    for item_index, post in enumerate(posts, 1):
        download_post_video_with_ytdlp(
            post,
            out_dir,
            item_index,
            yt_dlp,
            cookies_from_browser=cookies_from_browser,
            cookies_file=cookies_file,
        )


def move_existing_video_thumbnails(out_dir):
    video_dir = out_dir / "media" / "videos"
    thumbnail_dir = out_dir / "media" / "video_thumbnails"
    thumbnail_dir.mkdir(parents=True, exist_ok=True)

    moved = 0
    for path in video_dir.glob("*.jpg"):
        target = thumbnail_dir / path.name
        if target.exists():
            path.unlink()
        else:
            path.replace(target)
        moved += 1

    print(f"Moved {moved} existing JPG video thumbnails to: {thumbnail_dir}")


def extract_posts(page):
    posts = []
    seen = set()

    # X markup changes often, so this uses broad selectors first.
    articles = page.locator("article")
    count = articles.count()

    for i in range(count):
        article = articles.nth(i)
        text = extract_primary_post_text(article)

        if not text:
            continue

        links = []
        try:
            hrefs = article.locator("a").evaluate_all(
                """els => els
                    .map(a => a.href)
                    .filter(Boolean)
                """
            )
            links = unique(hrefs)
        except Exception:
            pass

        image_urls = []
        try:
            image_urls = article.locator("img").evaluate_all(
                """els => els
                    .map(img => img.currentSrc || img.src)
                    .filter(src => src && src.includes('pbs.twimg.com/media/'))
                """
            )
            image_urls = unique(normalize_x_image_url(src) for src in image_urls)
        except Exception:
            pass

        video_sources = []
        has_video = False
        try:
            has_video = article.locator("video, [data-testid='videoPlayer']").count() > 0
            video_sources = article.locator("video").evaluate_all(
                """els => els
                    .flatMap(video => [
                        video.currentSrc,
                        video.src,
                        video.poster,
                        ...Array.from(video.querySelectorAll('source')).map(source => source.src)
                    ])
                    .filter(Boolean)
                """
            )
            video_sources = unique(video_sources)
        except Exception:
            pass

        status_links = [
            link for link in links
            if "/status/" in link and not link.endswith("/analytics")
        ]
        post_url = status_links[0] if status_links else None

        key = post_url or text[:300]
        if key in seen:
            continue
        seen.add(key)

        posts.append({
            "post_url": post_url,
            "text": text,
            "links": links,
            "image_urls": image_urls,
            "video_sources": video_sources,
            "has_video": has_video,
        })

    return posts


def scroll_and_collect(page, rounds=12, pause_sec=2.5):
    all_posts = []
    seen_keys = set()

    for r in range(rounds):
        posts = extract_posts(page)

        new_count = 0
        for p in posts:
            key = p["post_url"] or p["text"][:300]
            if key not in seen_keys:
                seen_keys.add(key)
                all_posts.append(p)
                new_count += 1

        print(f"Round {r+1}/{rounds}: found {len(posts)} visible, added {new_count}, total {len(all_posts)}")

        page.mouse.wheel(0, 5000)
        time.sleep(pause_sec)

    return all_posts


def write_outputs(posts, out_dir):
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "media" / "images").mkdir(parents=True, exist_ok=True)
    (out_dir / "media" / "videos").mkdir(parents=True, exist_ok=True)
    (out_dir / "media" / "video_thumbnails").mkdir(parents=True, exist_ok=True)

    json_path = out_dir / "bookmarks.json"
    md_path = out_dir / "bookmarks_report.md"

    json_path.write_text(json.dumps(posts, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = ["# X Bookmarks Extract\n"]
    lines.append(f"Total extracted posts: {len(posts)}\n")

    for idx, post in enumerate(posts, 1):
        lines.append(f"## Item {idx}\n")
        if post.get("post_url"):
            lines.append(f"Post: {post['post_url']}")
            lines.append("")
        if post.get("media_title"):
            lines.append(f"Media title: {post['media_title']}")
            lines.append("")
        lines.append(post["text"])
        lines.append("")
        if post["links"]:
            lines.append("Links:")
            for link in post["links"]:
                lines.append(f"- {link}")
            lines.append("")
        if post["image_urls"]:
            lines.append("Images:")
            for url in post["image_urls"]:
                lines.append(f"- {url}")
            lines.append("")
        if post.get("downloaded_images"):
            lines.append("Downloaded images:")
            for path in post["downloaded_images"]:
                lines.append(f"- {path}")
            lines.append("")
        if post["video_sources"]:
            lines.append("Video sources / posters:")
            for url in post["video_sources"]:
                lines.append(f"- {url}")
            lines.append("")
        if post.get("downloaded_videos"):
            lines.append("Downloaded videos:")
            for path in post["downloaded_videos"]:
                lines.append(f"- {path}")
            lines.append("")
        if post.get("downloaded_video_thumbnails"):
            lines.append("Downloaded video thumbnails:")
            for path in post["downloaded_video_thumbnails"]:
                lines.append(f"- {path}")
            lines.append("")
        if post.get("yt_dlp_downloads"):
            lines.append("Downloaded with yt-dlp:")
            for path in post["yt_dlp_downloads"]:
                lines.append(f"- {path}")
            lines.append("")
        if post.get("video_download_failures"):
            lines.append("Video download fallback issues:")
            for issue in post["video_download_failures"]:
                lines.append(f"- {issue}")
            lines.append("")
        if post.get("skipped_video_sources"):
            lines.append("Skipped non-downloadable video sources:")
            for url in post["skipped_video_sources"]:
                lines.append(f"- {url}")
            lines.append("")

    md_path.write_text("\n".join(lines), encoding="utf-8")

    print(f"Saved: {json_path}")
    print(f"Saved: {md_path}")


def parse_args():
    parser = argparse.ArgumentParser(description="Scrape your X bookmarks into JSON and Markdown.")
    parser.add_argument(
        "--url",
        default=DEFAULT_BOOKMARKS_URL,
        help="X bookmarks URL to scrape. Defaults to your main bookmarks page.",
    )
    parser.add_argument(
        "--rounds",
        type=int,
        default=15,
        help="Number of scroll/extract rounds.",
    )
    parser.add_argument(
        "--pause-sec",
        type=float,
        default=2.5,
        help="Seconds to wait after each scroll.",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=DEFAULT_OUT_DIR,
        help="Directory for bookmarks.json, Markdown, and future media downloads.",
    )
    parser.add_argument(
        "--profile-dir",
        type=Path,
        default=DEFAULT_USER_DATA_DIR,
        help="Dedicated Playwright browser profile directory for X login cookies.",
    )
    parser.add_argument(
        "--login-first",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Open X home first so you can log in before the bookmark URL loads.",
    )
    parser.add_argument(
        "--cdp-url",
        help=(
            "Attach to an already running Chrome/Edge instance with remote debugging, "
            "for example http://127.0.0.1:9222. This avoids Playwright's login browser."
        ),
    )
    parser.add_argument(
        "--download-media",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Download captured image URLs and direct HTTP video/poster sources.",
    )
    parser.add_argument(
        "--download-existing",
        action="store_true",
        help="Download media from the existing bookmarks.json without opening a browser.",
    )
    parser.add_argument(
        "--rename-existing-only",
        action="store_true",
        help="Rename already-downloaded media from the existing bookmarks.json without scraping X or downloading files.",
    )
    parser.add_argument(
        "--yt-dlp",
        action="store_true",
        help="Use yt-dlp on each post URL to download real X videos when available.",
    )
    parser.add_argument(
        "--yt-dlp-fallback",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="After the normal direct-media download path, use yt-dlp only for posts that still have no downloaded video.",
    )
    parser.add_argument(
        "--cookies-from-browser",
        help="Pass browser cookies to yt-dlp, for example chrome, edge, or firefox.",
    )
    parser.add_argument(
        "--cookies-file",
        type=Path,
        help="Pass an existing Netscape cookies.txt file to yt-dlp.",
    )
    parser.add_argument(
        "--export-cookies-file",
        type=Path,
        help="When used with --cdp-url, export X cookies from the connected browser to this file.",
    )
    parser.add_argument(
        "--fix-thumbnail-folder",
        action="store_true",
        help="Move older JPG thumbnails out of media/videos into media/video_thumbnails.",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    out_dir = args.out_dir

    if args.fix_thumbnail_folder:
        move_existing_video_thumbnails(out_dir)

    if args.rename_existing_only:
        posts, source_path = load_existing_posts_for_local_ops(out_dir)
        if posts is None:
            print(f"No bookmarks.json or bookmarks_archive.json found in: {out_dir}")
            return
        print(f"Loaded posts for rename-only from: {source_path}")
        rename_existing_media_only(posts, out_dir)
        return

    if args.download_existing and not args.cdp_url:
        posts, source_path = load_existing_posts_for_local_ops(out_dir)
        if posts is None:
            print(f"No bookmarks.json or bookmarks_archive.json found in: {out_dir}")
            return
        print(f"Loaded posts for download-existing from: {source_path}")
        download_media(
            posts,
            out_dir,
            yt_dlp_fallback=args.yt_dlp_fallback and not args.yt_dlp,
            cookies_from_browser=args.cookies_from_browser,
            cookies_file=args.cookies_file,
        )
        if args.yt_dlp:
            download_videos_with_ytdlp(
                posts,
                out_dir,
                cookies_from_browser=args.cookies_from_browser,
                cookies_file=args.cookies_file,
            )
        write_outputs(posts, out_dir)
        return

    with sync_playwright() as p:
        browser = None
        if args.cdp_url:
            browser = p.chromium.connect_over_cdp(args.cdp_url)
            context = browser.contexts[0] if browser.contexts else browser.new_context()
            page = context.pages[0] if context.pages else context.new_page()
        else:
            context = p.chromium.launch_persistent_context(
                str(args.profile_dir.resolve()),
                headless=False,
                viewport={"width": 1440, "height": 1000},
            )
            page = context.new_page()

        cookies_file = args.cookies_file
        if args.export_cookies_file:
            cookies_file = export_cookies_file(context, args.export_cookies_file)
        elif args.cdp_url and (args.yt_dlp or args.yt_dlp_fallback) and not args.cookies_from_browser:
            cookies_file = export_cookies_file(context, out_dir / "x_cookies.txt")

        if args.download_existing:
            posts, source_path = load_existing_posts_for_local_ops(out_dir)
            if posts is None:
                print(f"No bookmarks.json or bookmarks_archive.json found in: {out_dir}")
                if browser:
                    print("Leaving the connected browser open.")
                else:
                    context.close()
                return
            print(f"Loaded posts for download-existing from: {source_path}")
            download_media(
                posts,
                out_dir,
                yt_dlp_fallback=args.yt_dlp_fallback and not args.yt_dlp,
                cookies_from_browser=args.cookies_from_browser,
                cookies_file=cookies_file,
            )
            if args.yt_dlp:
                download_videos_with_ytdlp(
                    posts,
                    out_dir,
                    cookies_from_browser=args.cookies_from_browser,
                    cookies_file=cookies_file,
                )
            write_outputs(posts, out_dir)
            if browser:
                print("Leaving the connected browser open.")
            else:
                context.close()
            return

        if args.login_first:
            page.goto(X_HOME_URL, wait_until="domcontentloaded")

            print("\nLog in to X in the opened browser if needed.")
            print("After your X home timeline is visible, press Enter here to open bookmarks...\n")
            input()

        page.goto(args.url, wait_until="domcontentloaded")

        print(f"\nOpened: {page.url}")
        print("If X still shows an error, confirm this Playwright browser is logged in to the same account.")
        print("After bookmarks are visible, press Enter here to continue...\n")
        input()

        posts = scroll_and_collect(page, rounds=args.rounds, pause_sec=args.pause_sec)
        if args.download_media:
            download_media(
                posts,
                out_dir,
                yt_dlp_fallback=args.yt_dlp_fallback and not args.yt_dlp,
                cookies_from_browser=args.cookies_from_browser,
                cookies_file=cookies_file,
            )
        if args.yt_dlp:
            download_videos_with_ytdlp(
                posts,
                out_dir,
                cookies_from_browser=args.cookies_from_browser,
                cookies_file=cookies_file,
            )
        write_outputs(posts, out_dir)

        print("\nDone. Press Enter to close browser...")
        input()
        if browser:
            print("Leaving the connected browser open.")
        else:
            context.close()


if __name__ == "__main__":
    main()
