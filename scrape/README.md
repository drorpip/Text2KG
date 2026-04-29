# X Bookmark Scraper

Scrapes visible X bookmarks with Playwright and saves:

- `x_bookmarks_output/bookmarks.json`
- `x_bookmarks_output/bookmarks_report.md`
- `x_bookmarks_output/media/images/`
- `x_bookmarks_output/media/videos/`
- `x_bookmarks_output/media/video_thumbnails/`

These output files, downloaded media, and local browser profile folders are runtime
artifacts. Keep them out of Git and recreate them locally as needed. The default local
paths are `scrape/x_bookmarks_output`, `scrape/playwright_x_profile`,
`scrape/chrome_x_profile`, and `scrape/edge_x_profile_9222`.

Run from the repo root:

```powershell
python scrape\x_bookmarks_scrape.py
```

Or install the repo into your already-activated venv once, then use the commands from
any PowerShell working directory, including `C:\ML\vs_projects\azure`:

```powershell
pip install -e C:\ML\vs_projects\social_extract
x-bookmarks-scrape
```

For the main bookmarks page:

```powershell
python scrape\x_bookmarks_scrape.py --url "https://x.com/i/bookmarks"
```

For a specific bookmark folder URL:

```powershell
python scrape\x_bookmarks_scrape.py --url "https://x.com/i/bookmarks/1796192221034684925"
```

The script opens a browser with a dedicated profile in `scrape/playwright_x_profile`.
Log in to X there once, then press Enter in the terminal after your X home timeline is
visible. The script then opens the bookmarks URL.

If X says the bookmark page does not exist, the Playwright browser is probably not
authenticated to the same account as your normal browser. X can show that message for
private/account-scoped URLs when the session does not have access.

If X login loops or resets inside the Playwright browser, use a real browser with
remote debugging instead.

Start Chrome from PowerShell:

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:TEMP\x-scrape-chrome"
```

Or start Edge:

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222 --user-data-dir="$env:TEMP\x-scrape-edge"
```

Log in to X in that browser window, open your bookmarks once to confirm access, then
run the scraper in a second PowerShell window:

```powershell
python scrape\x_bookmarks_scrape.py --cdp-url http://127.0.0.1:9222 --url "https://x.com/i/bookmarks/1796192221034684925"
```

Media download is enabled by default when scraping. It downloads captured image URLs,
direct HTTP video file URLs, and video thumbnail URLs into:

- `x_bookmarks_output/media/images/`
- `x_bookmarks_output/media/videos/`
- `x_bookmarks_output/media/video_thumbnails/`

New downloads are named from the post text when possible, using a short 2-3 word slug
plus stable suffixes to avoid collisions. Posts without usable text fall back to the
older `item_###_...` style.

If you want semantic names based on the post meaning instead of the opening words,
run a local Ollama server. When available, the scraper will ask the local model for a
short filename title such as `oct-7-massacre`.

Repair and rebuild runs also rename already-downloaded media files to the current title
when those files still exist on disk.

```powershell
python scrape\x_bookmarks_scrape.py --cdp-url http://127.0.0.1:9222
```

You can override the model with `OLLAMA_MEDIA_TITLE_MODEL` and the server URL with
`OLLAMA_HOST`. By default it uses `http://127.0.0.1:11434` and `qwen3-vl:8b`.

When X exposes only a poster, an HLS playlist (`.m3u8`), or hides the real video URL in
the page markup, the script keeps the existing direct-download path for real files and
then uses `yt-dlp` as a fallback only for posts that still have no downloaded video file.
That fallback is on by default when `yt-dlp` is installed, and you can disable it with
`--no-yt-dlp-fallback`.

To download media from an existing `bookmarks.json` without opening X again:

```powershell
python scrape\x_bookmarks_scrape.py --download-existing
```

To rename already-downloaded media from an existing `bookmarks.json` without scraping X
or downloading anything:

```powershell
python scrape\x_bookmarks_scrape.py --rename-existing-only
```

If older runs placed JPG thumbnails in `media/videos`, move them to the thumbnail folder:

```powershell
python scrape\x_bookmarks_scrape.py --fix-thumbnail-folder
```

Real X videos often are not exposed as direct URLs in the page HTML. For actual video
downloads, install `yt-dlp` and run it against the saved post URLs. If the remote-debug
Chrome/Edge window is still open, prefer `--cdp-url`; the script will export cookies
from that live browser session and pass them to `yt-dlp`.

```powershell
python -m pip install yt-dlp
python scrape\x_bookmarks_scrape.py --download-existing --yt-dlp --cdp-url http://127.0.0.1:9222
```

If you want the narrower fallback-only behavior instead of running `yt-dlp` for every
post, just install `yt-dlp` and keep the normal command:

```powershell
python -m pip install yt-dlp
python scrape\x_bookmarks_scrape.py --cdp-url http://127.0.0.1:9222
```

You can also explicitly export the cookies file:

```powershell
python scrape\x_bookmarks_scrape.py --cdp-url http://127.0.0.1:9222 --export-cookies-file scrape\x_bookmarks_output\x_cookies.txt --download-existing --yt-dlp
```

`--cookies-from-browser` can fail while the browser is open because Chrome locks its
cookie database. Closing that browser first may work, but CDP cookie export avoids the
lock.

To scrape without downloading media:

```powershell
python scrape\x_bookmarks_scrape.py --no-download-media --cdp-url http://127.0.0.1:9222
```

## Incremental pipeline

Use the pipeline when you want repeated runs to avoid processing the same bookmark
entries again and again. It keeps:

- `x_bookmarks_output/<bookmark-id>/bookmarks_archive.json`
- `x_bookmarks_output/<bookmark-id>/pipeline_state.json`
- `x_bookmarks_output/collections_index.json`
- `x_bookmarks_output/pipeline_state.json`

Run it with the same remote-debug browser session.

To use the main bookmarks page as a discovery source:

```powershell
python scrape\x_bookmarks_pipeline.py --cdp-url http://127.0.0.1:9222 --url "https://x.com/i/bookmarks"
```

When the main bookmarks page shows the folder index, the pipeline discovers the visible
folder names and URLs, then scrapes each discovered folder as its own collection. Folder
names are saved as metadata for the UI and reports, but on-disk folders still use the
stable bookmark folder ID.

To target a single bookmark folder directly:

```powershell
python scrape\x_bookmarks_pipeline.py --cdp-url http://127.0.0.1:9222 --url "https://x.com/i/bookmarks/1796192221034684925"
```

Installed-command form:

```powershell
x-bookmarks-pipeline --cdp-url http://127.0.0.1:9222 --url "https://x.com/i/bookmarks/1796192221034684925"
```

For multiple direct bookmark folders, repeat `--url`:

```powershell
python scrape\x_bookmarks_pipeline.py --cdp-url http://127.0.0.1:9222 --url "https://x.com/i/bookmarks/1796192221034684925" --url "https://x.com/i/bookmarks/1792081909171814531"
```

Or put them in [bookmark_urls.txt](C:/ML/vs_projects/social_extract/scrape/bookmark_urls.txt) and run:

```powershell
python scrape\x_bookmarks_pipeline.py --cdp-url http://127.0.0.1:9222 --urls-file scrape\bookmark_urls.txt
```

Each discovered or direct bookmark folder writes to its own folder named from the URL ID:

```text
x_bookmarks_output\
  1796192221034684925\
    bookmarks.json
    bookmarks_report.md
    bookmarks_archive.json
    pipeline_state.json
    media\
  1792081909171814531\
    bookmarks.json
    bookmarks_report.md
    bookmarks_archive.json
    pipeline_state.json
    media\
```

On later runs, only newly discovered entries are downloaded. The full archive is still
written to `bookmarks.json` and `bookmarks_report.md`.

To also try real video downloads for only new entries:

```powershell
python scrape\x_bookmarks_pipeline.py --cdp-url http://127.0.0.1:9222 --url "https://x.com/i/bookmarks/1796192221034684925" --yt-dlp
```

Or keep the default selective fallback, which only invokes `yt-dlp` for posts whose
video still was not recovered by the normal direct-download path:

```powershell
python scrape\x_bookmarks_pipeline.py --cdp-url http://127.0.0.1:9222 --url "https://x.com/i/bookmarks/1796192221034684925"
```

To reprocess media for the full archive:

```powershell
python scrape\x_bookmarks_pipeline.py --cdp-url http://127.0.0.1:9222 --process-all
```

To force a rerun after changing downloader/report logic, without scraping X again:

```powershell
python scrape\x_bookmarks_pipeline.py --url "https://x.com/i/bookmarks/1796192221034684925" --existing-only
```

Add `--yt-dlp` if you want that archive rerun to retry real video downloads too:

```powershell
python scrape\x_bookmarks_pipeline.py --url "https://x.com/i/bookmarks/1796192221034684925" --existing-only --yt-dlp
```

To replace a wrong or incomplete `bookmarks_archive.json` with a fresh scrape for that
collection, rebuild the archive:

```powershell
python scrape\x_bookmarks_pipeline.py --cdp-url http://127.0.0.1:9222 --url "https://x.com/i/bookmarks/1796192221034684925" --rebuild-archive
```

Add `--yt-dlp` if you want the rebuilt archive to retry real video downloads too:

```powershell
python scrape\x_bookmarks_pipeline.py --cdp-url http://127.0.0.1:9222 --url "https://x.com/i/bookmarks/1796192221034684925" --rebuild-archive --yt-dlp
```

## Local UI

Start the remote-debug browser first and make sure X is logged in:

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:TEMP\x-scrape-chrome"
```

Then start the local UI:

```powershell
python scrape\x_bookmarks_ui.py
```

Installed-command form:

```powershell
x-bookmarks-ui
```

Open:

```text
http://127.0.0.1:8765
```

The UI lets you edit bookmark folder URLs and then choose among three task-level
actions: `Sync bookmarks`, `Repair downloads`, and `Rebuild archive`. It also shows
per-folder counts, supports single-folder or run-all actions, lets you remove saved
URLs, and opens generated JSON/Markdown reports. Technical controls such as scroll
rounds and `yt-dlp` are kept under the `Advanced` section. It uses
`scrape\bookmark_urls.txt` as the saved URL list and runs the pipeline with
`--no-confirm-before-collect`, so it expects the CDP browser session to already have
access to X for scrape runs. Repair runs work without scraping X again, while rebuild
runs replace the saved archive with freshly scraped entries.

## Downloaded Output Viewer

Use the viewer after scraping/downloading, to browse posts together with any downloaded
images, real videos, and video thumbnails.

Start it from the repo root:

```powershell
python scrape\x_bookmarks_viewer.py
```

Installed-command form:

```powershell
x-bookmarks-viewer
```

Open:

```text
http://127.0.0.1:8767
```

The viewer reads collection folders from `scrape\x_bookmarks_output\<bookmark-id>\`
and serves local media files directly from those folders. It includes:

- collection switcher
- search by post text or post URL
- media-only filter
- inline image display
- inline video playback for downloaded videos
- links back to the original X post
