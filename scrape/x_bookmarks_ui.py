import json
import subprocess
import sys
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

try:
    from .x_bookmarks_pipeline import collection_id_from_url, indexed_collection_entries_for_source
    from .x_bookmarks_scrape import is_main_bookmarks_url, normalize_bookmark_url
except ImportError:
    from x_bookmarks_pipeline import collection_id_from_url, indexed_collection_entries_for_source
    from x_bookmarks_scrape import is_main_bookmarks_url, normalize_bookmark_url


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_DIR = SCRIPT_DIR.parent
URLS_FILE = SCRIPT_DIR / "bookmark_urls.txt"
OUT_DIR = SCRIPT_DIR / "x_bookmarks_output"
PIPELINE_SCRIPT = SCRIPT_DIR / "x_bookmarks_pipeline.py"
SCRAPE_SCRIPT = SCRIPT_DIR / "x_bookmarks_scrape.py"

PROCESS = None
LOG_LINES = []
LOG_LOCK = threading.Lock()


def now_label():
    return datetime.now().strftime("%H:%M:%S")


def add_log(line):
    with LOG_LOCK:
        LOG_LINES.append(f"[{now_label()}] {line}")
        del LOG_LINES[:-500]


def read_log_lines():
    with LOG_LOCK:
        return list(LOG_LINES)


def normalize_urls(urls):
    normalized = [normalize_bookmark_url(url) for url in urls if url and url.strip()]
    return list(dict.fromkeys(url for url in normalized if url))


def read_urls():
    if not URLS_FILE.exists():
        return []
    urls = []
    for line in URLS_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            urls.append(line)
    return normalize_urls(urls)


def write_urls(urls):
    URLS_FILE.write_text(
        "# One X bookmarks URL per line.\n"
        "# The main bookmarks page can be included as:\n"
        "# https://x.com/i/bookmarks\n"
        + "\n".join(normalize_urls(urls))
        + "\n",
        encoding="utf-8",
    )


def load_json(path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return default


def collection_summary(url):
    normalized_url = normalize_bookmark_url(url)
    collection_id = collection_id_from_url(normalized_url)
    out_dir = OUT_DIR / collection_id
    archive = load_json(out_dir / "bookmarks_archive.json", [])
    state = load_json(out_dir / "pipeline_state.json", {})
    media_dir = out_dir / "media"
    image_count = len(list((media_dir / "images").glob("*"))) if media_dir.exists() else 0
    video_count = len(list((media_dir / "videos").glob("*"))) if media_dir.exists() else 0
    thumb_count = len(list((media_dir / "video_thumbnails").glob("*"))) if media_dir.exists() else 0
    last_run = state.get("last_run", {})
    last_run_mode = None
    if last_run:
        if last_run.get("rebuild_archive"):
            last_run_mode = "Rebuilt archive"
        elif last_run.get("existing_only"):
            last_run_mode = "Repaired downloads"
        elif last_run.get("process_all"):
            last_run_mode = "Full sync"
        else:
            last_run_mode = "Synced bookmarks"
    display_name = state.get("display_name") or last_run.get("display_name")
    if not display_name and collection_id == "main":
        display_name = "Main bookmarks"
    return {
        "id": collection_id,
        "url": normalized_url,
        "source_url": state.get("source_url") or last_run.get("source_url") or normalized_url,
        "display_name": display_name,
        "archive_count": len(archive),
        "new_count": last_run.get("new_count"),
        "processed_count": last_run.get("processed_count"),
        "last_run_at": last_run.get("ran_at"),
        "last_run_mode": last_run_mode,
        "images": image_count,
        "videos": video_count,
        "thumbnails": thumb_count,
        "has_report": (out_dir / "bookmarks_report.md").exists(),
        "has_json": (out_dir / "bookmarks.json").exists(),
    }


def collection_summaries(urls):
    summaries = []
    seen_ids = set()

    for url in normalize_urls(urls):
        indexed_entries = indexed_collection_entries_for_source(OUT_DIR, url)
        if indexed_entries:
            for entry in indexed_entries:
                summary = collection_summary(entry["url"])
                summary["source_url"] = entry.get("source_url") or summary.get("source_url")
                summary["display_name"] = entry.get("display_name") or summary.get("display_name")
                if summary["id"] in seen_ids:
                    continue
                summaries.append(summary)
                seen_ids.add(summary["id"])
            continue

        if is_main_bookmarks_url(url):
            continue

        summary = collection_summary(url)
        if summary["id"] in seen_ids:
            continue
        summaries.append(summary)
        seen_ids.add(summary["id"])

    return summaries


def run_pipeline(options):
    global PROCESS
    urls = normalize_urls(options.get("urls") or read_urls())
    command = [
        sys.executable,
        str(PIPELINE_SCRIPT),
        "--cdp-url",
        options.get("cdp_url") or "http://127.0.0.1:9222",
        "--rounds",
        str(options.get("rounds") or 15),
        "--pause-sec",
        str(options.get("pause_sec") or 2.5),
        "--no-confirm-before-collect",
    ]
    for url in urls:
        command.extend(["--url", url])
    if options.get("yt_dlp"):
        command.append("--yt-dlp")
    if options.get("process_all"):
        command.append("--process-all")
    if options.get("existing_only"):
        command.append("--existing-only")
    if options.get("rebuild_archive"):
        command.append("--rebuild-archive")
    if not options.get("download_media", True):
        command.append("--no-download-media")

    add_log("Starting pipeline.")
    add_log(" ".join(command))
    PROCESS = subprocess.Popen(
        command,
        cwd=str(REPO_DIR),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    assert PROCESS.stdout is not None
    for line in PROCESS.stdout:
        add_log(line.rstrip())
    code = PROCESS.wait()
    add_log(f"Pipeline exited with code {code}.")
    PROCESS = None


def run_rename_files(options):
    global PROCESS
    urls = normalize_urls(options.get("urls") or read_urls())
    if not urls:
        add_log("No bookmark URLs saved. Nothing to rename.")
        return

    add_log("Starting rename-only run.")
    overall_code = 0
    for url in urls:
        indexed_entries = indexed_collection_entries_for_source(OUT_DIR, url)
        targets = indexed_entries or (
            [] if is_main_bookmarks_url(url) else [{"collection_id": collection_id_from_url(url), "url": url}]
        )
        if not targets:
            add_log(f"Rename files skipped for {url}: no discovered bookmark collections are saved yet.")
            continue

        for target in targets:
            collection_id = target["collection_id"]
            out_dir = OUT_DIR / collection_id
            if not (out_dir / "bookmarks.json").exists() and not (out_dir / "bookmarks_archive.json").exists():
                add_log(f"Rename files skipped for {collection_id}: no bookmarks.json or bookmarks_archive.json found.")
                continue
            command = [
                sys.executable,
                str(SCRAPE_SCRIPT),
                "--rename-existing-only",
                "--out-dir",
                str(out_dir),
            ]
            label = target.get("display_name") or collection_id
            add_log(f"Rename files for {label} ({collection_id}).")
            add_log(" ".join(command))
            PROCESS = subprocess.Popen(
                command,
                cwd=str(REPO_DIR),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            assert PROCESS.stdout is not None
            for line in PROCESS.stdout:
                add_log(line.rstrip())
            code = PROCESS.wait()
            add_log(f"Rename-only exited for {collection_id} with code {code}.")
            if code != 0:
                overall_code = code
            PROCESS = None

    add_log(f"Rename-only run finished with code {overall_code}.")


def json_response(handler, payload, status=200):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def text_response(handler, body, content_type="text/html; charset=utf-8", status=200):
    data = body.encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


HTML = r"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>X Bookmark Pipeline</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #1d252d;
      --muted: #617080;
      --line: #d9e0e7;
      --panel: #f7f9fb;
      --accent: #0b7a75;
      --accent-2: #9a4d12;
      --danger: #a33131;
      --bg: #ffffff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", Arial, sans-serif;
      color: var(--ink);
      background: var(--bg);
    }
    header {
      border-bottom: 1px solid var(--line);
      padding: 18px 24px 14px;
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 16px;
    }
    h1, h2, h3 { margin: 0; }
    h1 { font-size: 24px; font-weight: 650; }
    main {
      display: grid;
      grid-template-columns: minmax(420px, 560px) minmax(0, 1fr);
      min-height: calc(100vh - 68px);
    }
    aside {
      border-right: 1px solid var(--line);
      background: var(--panel);
      padding: 18px;
    }
    section { padding: 18px 22px; }
    label {
      display: block;
      font-size: 13px;
      color: var(--muted);
      margin: 12px 0 6px;
    }
    input[type="text"], input[type="number"], textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 9px 10px;
      font: inherit;
      background: white;
    }
    textarea { min-height: 200px; resize: vertical; }
    .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .toolbar { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px; }
    .toolbar.compact { margin-top: 0; }
    .check { display: flex; gap: 8px; align-items: center; margin-top: 12px; color: var(--ink); }
    button, .link-button {
      border: 1px solid var(--accent);
      background: var(--accent);
      color: white;
      border-radius: 6px;
      padding: 9px 12px;
      font: inherit;
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 38px;
    }
    button.secondary, .link-button.secondary {
      background: white;
      color: var(--accent);
    }
    button.danger {
      border-color: var(--danger);
      background: var(--danger);
    }
    button:disabled { opacity: .55; cursor: not-allowed; }
    .small-button {
      min-height: 32px;
      padding: 6px 10px;
      font-size: 13px;
    }
    .list {
      display: grid;
      gap: 8px;
      margin-top: 12px;
    }
    .list-item, .card {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: white;
    }
    .list-item {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 8px;
      align-items: start;
      padding: 10px;
    }
    .list-item .toolbar.compact {
      width: 100%;
      justify-content: flex-start;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 12px;
      margin-top: 12px;
    }
    .card { padding: 12px; }
    .mono, .url {
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .url, .muted, .status {
      color: var(--muted);
    }
    .status {
      font-size: 13px;
      margin-top: 6px;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
      margin: 12px 0;
    }
    .stat {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 8px;
      background: var(--panel);
      min-height: 54px;
    }
    .stat strong { display: block; font-size: 18px; }
    .stat span { color: var(--muted); font-size: 12px; }
    .section-label {
      margin-top: 16px;
      font-size: 13px;
      color: var(--muted);
      font-weight: 600;
    }
    .subtle {
      margin-top: 8px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }
    .editor-panel {
      margin-top: 14px;
      padding-top: 14px;
      border-top: 1px solid var(--line);
    }
    .advanced-panel {
      margin-top: 14px;
      padding-top: 14px;
      border-top: 1px solid var(--line);
      display: none;
    }
    .advanced-panel.open {
      display: block;
    }
    .mode-actions {
      display: grid;
      gap: 10px;
      margin-top: 14px;
    }
    .mode-actions button {
      justify-content: flex-start;
      text-align: left;
      min-height: 52px;
    }
    .mode-actions strong {
      display: block;
      font-size: 14px;
      font-weight: 650;
    }
    .mode-actions span {
      display: block;
      font-size: 12px;
      opacity: 0.9;
    }
    .card-help {
      margin-top: 10px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.4;
      min-height: 34px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 4px 8px;
      font-size: 12px;
      color: var(--muted);
      background: white;
      margin-top: 8px;
    }
    pre {
      height: 300px;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      background: #111820;
      color: #e7edf3;
      white-space: pre-wrap;
      font-size: 12px;
    }
    .running { color: var(--accent-2); font-weight: 650; }
    @media (max-width: 980px) {
      main { grid-template-columns: 1fr; }
      aside { border-right: 0; border-bottom: 1px solid var(--line); }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>X Bookmark Pipeline</h1>
      <div class="status" id="status">Loading...</div>
    </div>
    <button class="secondary" onclick="refresh()" title="Reload saved URLs, collection summaries, and the live run log.">Refresh</button>
  </header>
  <main>
    <aside>
      <label for="new-url">Add bookmark source URL</label>
      <div class="row">
        <div style="flex:1">
          <input id="new-url" type="text" placeholder="https://x.com/i/bookmarks">
        </div>
        <button onclick="addUrl()" title="Save this bookmark source URL to the list below.">Add</button>
      </div>

      <div class="toolbar">
        <button class="secondary" onclick="addMainSource()" title="Insert the main X bookmarks URL. The pipeline will discover bookmark folders from it.">Add Main</button>
        <button class="secondary" onclick="addExample()" title="Insert an example direct bookmark folder URL so you can see the targeted format.">Add Folder Example</button>
        <button class="secondary" onclick="toggleBulkEditor()" title="Edit the full saved source URL list as plain text, one URL per line.">Bulk Edit</button>
      </div>

      <div class="section-label">Saved Sources</div>
      <div id="url-list" class="list"></div>

      <div id="bulk-editor" class="editor-panel" style="display:none">
        <label for="urls">Bulk edit source URLs</label>
        <textarea id="urls" spellcheck="false"></textarea>
        <div class="toolbar">
          <button onclick="saveUrls()" title="Replace the saved source URL list with the lines currently in this editor.">Save URLs</button>
          <button class="secondary" onclick="cancelBulkEdit()" title="Close bulk edit without applying the current text changes.">Cancel</button>
        </div>
      </div>

      <label for="cdp">CDP browser URL</label>
      <input id="cdp" type="text" value="http://127.0.0.1:9222">
      <div class="subtle">Use a Chrome or Edge window already logged into X with remote debugging enabled.</div>

      <div class="mode-actions">
        <button id="run" onclick="runPipeline()" title="Open each saved bookmarks page, collect new posts from X, and run the normal media download flow.">
          <div>
            <strong>Sync bookmarks</strong>
            <span>Check X for new bookmarks and run normal media recovery.</span>
          </div>
        </button>
        <button id="rerun" class="secondary" onclick="rerunAll()" title="Skip scraping X and retry downloads using the saved archive data for every saved collection.">
          <div>
            <strong>Repair downloads</strong>
            <span>Retry downloads from saved archive data without scraping X again.</span>
          </div>
        </button>
        <button id="rebuild" class="secondary" onclick="rebuildAll()" title="Scrape X again and replace each saved archive with the fresh results while keeping existing media files.">
          <div>
            <strong>Rebuild archive</strong>
            <span>Fresh scrape that replaces the saved archive and keeps existing media files.</span>
          </div>
        </button>
        <button id="rename" class="secondary" onclick="renameAll()" title="Rename existing downloaded files from saved data without scraping X or downloading anything.">
          <div>
            <strong>Rename files</strong>
            <span>Retitle existing media files from saved post data only.</span>
          </div>
        </button>
      </div>

      <div class="toolbar">
        <button id="stop" class="danger" onclick="stopPipeline()" title="Terminate the currently running pipeline process.">Stop</button>
        <button id="advanced-toggle" class="secondary" onclick="toggleAdvanced()" title="Show or hide less common run settings such as scroll rounds and download options.">Advanced</button>
      </div>

      <div id="advanced-panel" class="advanced-panel">
        <div class="subtle">Only change these if X is slow or you need different download behavior.</div>
        <div class="row">
          <div style="flex:1">
            <label for="rounds">Scroll rounds</label>
            <input id="rounds" type="number" min="1" value="15">
          </div>
          <div style="flex:1">
            <label for="pause">Pause seconds</label>
            <input id="pause" type="number" min="0" step="0.5" value="2.5">
          </div>
        </div>
        <label class="check"><input id="media" type="checkbox" checked> Download images and thumbnails</label>
        <label class="check"><input id="ytdlp" type="checkbox"> Try real video downloads with yt-dlp</label>
      </div>
    </aside>
    <section>
      <h2>Collections</h2>
      <div id="collections" class="grid"></div>
      <div class="row" style="justify-content:space-between; margin-top:22px; align-items:end;">
        <h2>Run Log</h2>
        <button class="secondary small-button" onclick="copyLog()" title="Copy the current run log to the clipboard.">Copy Log</button>
      </div>
      <pre id="log"></pre>
    </section>
  </main>
<script>
let urlDraft = [];
let bulkOpen = false;
let bulkDirty = false;
let advancedOpen = false;

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

function normalizeUrls(urls) {
  return [...new Set(urls.map(x => x.trim()).filter(Boolean))];
}

function editorUrls() {
  return normalizeUrls(document.getElementById('urls').value.split(/\r?\n/));
}

function syncEditorFromDraft() {
  document.getElementById('urls').value = urlDraft.join('\n');
}

function syncAdvancedPanel() {
  const panel = document.getElementById('advanced-panel');
  const toggle = document.getElementById('advanced-toggle');
  panel.classList.toggle('open', advancedOpen);
  toggle.textContent = advancedOpen ? 'Hide Advanced' : 'Advanced';
}

function collectRunOptions(urls) {
  return {
    urls,
    cdp_url: document.getElementById('cdp').value,
    rounds: Number(document.getElementById('rounds').value),
    pause_sec: Number(document.getElementById('pause').value),
    download_media: document.getElementById('media').checked,
    yt_dlp: document.getElementById('ytdlp').checked,
    process_all: false,
    existing_only: false,
    rebuild_archive: false
  };
}

function sourceLabel(url) {
  return url === 'https://x.com/i/bookmarks' ? 'Main bookmarks discovery' : url;
}

function renderUrlList() {
  const root = document.getElementById('url-list');
  if (!urlDraft.length) {
    root.innerHTML = '<div class="muted">No bookmark sources saved.</div>';
    return;
  }
  root.innerHTML = urlDraft.map(url => `
    <div class="list-item">
      <div>
        <div>${sourceLabel(url)}</div>
        <div class="mono">${url}</div>
      </div>
      <div class="toolbar compact">
        <button class="secondary small-button" onclick='runSingle(${JSON.stringify(url)})' title="Run this saved bookmark source for a normal sync.">Sync</button>
        <button class="secondary small-button" onclick='rerunSingle(${JSON.stringify(url)})' title="Retry downloads for collections resolved from this saved source using existing archive data only.">Repair</button>
        <button class="secondary small-button" onclick='rebuildSingle(${JSON.stringify(url)})' title="Rescrape collections resolved from this saved source and replace their saved archives while keeping existing media files.">Rebuild</button>
        <button class="secondary small-button" onclick='renameSingle(${JSON.stringify(url)})' title="Rename existing downloaded files for collections resolved from this saved source without scraping X or downloading anything.">Rename</button>
        <button class="secondary small-button" onclick='removeUrl(${JSON.stringify(url)})' title="Remove this URL from the saved list. Existing output files stay on disk.">Remove</button>
      </div>
    </div>
  `).join('');
}

function renderCollections(items) {
  const root = document.getElementById('collections');
  if (!items.length) {
    root.innerHTML = '<div class="muted">No collections discovered yet.</div>';
    return;
  }
  root.innerHTML = items.map(item => `
    <article class="card">
      <h3>${item.display_name || item.id}</h3>
      ${item.display_name ? `<div class="muted mono">${item.id}</div>` : ''}
      <div class="url">${item.url}</div>
      ${item.source_url && item.source_url !== item.url ? `<div class="muted">Source: ${item.source_url}</div>` : ''}
      ${item.last_run_mode ? `<div class="badge">${item.last_run_mode}</div>` : ''}
      <div class="stats">
        <div class="stat"><strong>${item.archive_count}</strong><span>Archived</span></div>
        <div class="stat"><strong>${item.new_count ?? '-'}</strong><span>New</span></div>
        <div class="stat"><strong>${item.processed_count ?? '-'}</strong><span>Processed</span></div>
        <div class="stat"><strong>${item.images}</strong><span>Images</span></div>
        <div class="stat"><strong>${item.videos}</strong><span>Videos</span></div>
        <div class="stat"><strong>${item.thumbnails}</strong><span>Thumbs</span></div>
      </div>
      <div class="status">${item.last_run_at || 'No run yet'}</div>
      <div class="card-help">Sync checks X for new posts. Repair retries downloads from saved data. Rebuild replaces the saved archive but keeps existing downloads.</div>
      <div class="toolbar">
        <button class="secondary small-button" onclick='runSingle(${JSON.stringify(item.url)})' title="Scrape this saved bookmarks URL for new posts and run normal media downloads.">Sync</button>
        <button class="secondary small-button" onclick='rerunSingle(${JSON.stringify(item.url)})' title="Retry downloads for this saved collection using its existing archive data only.">Repair</button>
        <button class="secondary small-button" onclick='rebuildSingle(${JSON.stringify(item.url)})' title="Rescrape this bookmarks URL and replace its saved archive while keeping existing media files.">Rebuild</button>
        <button class="secondary small-button" onclick='renameSingle(${JSON.stringify(item.url)})' title="Rename existing downloaded files for this collection without scraping X or downloading anything.">Rename</button>
        <button class="secondary small-button" onclick='removeUrl(${JSON.stringify(item.url)})' title="Remove this URL from the saved list. Existing output files stay on disk.">Remove</button>
        <a class="link-button secondary small-button" href="/output/${item.id}/bookmarks_report.md" target="_blank" title="Open the generated Markdown report for this collection.">Report</a>
        <a class="link-button secondary small-button" href="/output/${item.id}/bookmarks.json" target="_blank" title="Open the generated JSON data for this collection.">JSON</a>
      </div>
    </article>
  `).join('');
}

function toggleAdvanced() {
  advancedOpen = !advancedOpen;
  syncAdvancedPanel();
}

async function copyLog() {
  const text = document.getElementById('log').textContent || '';
  try {
    await navigator.clipboard.writeText(text);
    document.getElementById('status').textContent = 'Run log copied';
  } catch (error) {
    document.getElementById('status').textContent = 'Copy failed';
  }
}

async function refresh() {
  const data = await api('/api/status');
  document.getElementById('status').innerHTML = data.running ? '<span class="running">Pipeline running</span>' : 'Ready';
  if (!bulkDirty) {
    urlDraft = data.urls;
    if (bulkOpen) syncEditorFromDraft();
  }
  document.getElementById('run').disabled = data.running;
  document.getElementById('rerun').disabled = data.running;
  document.getElementById('rebuild').disabled = data.running;
  document.getElementById('rename').disabled = data.running;
  document.getElementById('stop').disabled = !data.running;
  document.getElementById('log').textContent = data.log.join('\n');
  renderUrlList();
  renderCollections(data.collections);
}

async function persistUrls(urls) {
  urlDraft = normalizeUrls(urls);
  await api('/api/urls', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({urls: urlDraft})
  });
  bulkDirty = false;
  if (bulkOpen) syncEditorFromDraft();
  await refresh();
}

async function saveUrls() {
  await persistUrls(editorUrls());
}

function toggleBulkEditor() {
  bulkOpen = !bulkOpen;
  document.getElementById('bulk-editor').style.display = bulkOpen ? 'block' : 'none';
  if (bulkOpen) {
    syncEditorFromDraft();
    bulkDirty = false;
  }
}

function cancelBulkEdit() {
  bulkDirty = false;
  syncEditorFromDraft();
  bulkOpen = false;
  document.getElementById('bulk-editor').style.display = 'none';
}

async function addUrl() {
  const input = document.getElementById('new-url');
  const url = input.value.trim();
  if (!url) return;
  await persistUrls([...urlDraft, url]);
  input.value = '';
}

async function addExample() {
  await persistUrls([...urlDraft, 'https://x.com/i/bookmarks/1792081909171814531']);
}

async function addMainSource() {
  await persistUrls([...urlDraft, 'https://x.com/i/bookmarks']);
}

async function removeUrl(url) {
  await persistUrls(urlDraft.filter(item => item !== url));
}

async function runSingle(url) {
  await api('/api/run', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(collectRunOptions([url]))
  });
  await refresh();
}

async function rerunSingle(url) {
  const options = collectRunOptions([url]);
  options.existing_only = true;
  options.process_all = true;
  await api('/api/run', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(options)
  });
  await refresh();
}

async function rebuildSingle(url) {
  if (!confirm('Rebuild archive for this collection?\n\nThis will replace the saved bookmarks_archive.json with a fresh scrape, but it will keep existing downloads.')) {
    return;
  }
  const options = collectRunOptions([url]);
  options.process_all = true;
  options.rebuild_archive = true;
  await api('/api/run', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(options)
  });
  await refresh();
}

async function renameSingle(url) {
  await api('/api/rename', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({urls: [url]})
  });
  await refresh();
}

async function runPipeline() {
  if (bulkOpen && bulkDirty) {
    await saveUrls();
  }
  await api('/api/run', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(collectRunOptions(urlDraft))
  });
  await refresh();
}

async function rerunAll() {
  if (bulkOpen && bulkDirty) {
    await saveUrls();
  }
  const options = collectRunOptions(urlDraft);
  options.existing_only = true;
  options.process_all = true;
  await api('/api/run', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(options)
  });
  await refresh();
}

async function rebuildAll() {
  if (bulkOpen && bulkDirty) {
    await saveUrls();
  }
  if (!confirm('Rebuild archive for all saved collections?\n\nThis will replace each saved bookmarks_archive.json from a fresh scrape, but it will keep existing downloads.')) {
    return;
  }
  const options = collectRunOptions(urlDraft);
  options.process_all = true;
  options.rebuild_archive = true;
  await api('/api/run', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(options)
  });
  await refresh();
}

async function renameAll() {
  if (bulkOpen && bulkDirty) {
    await saveUrls();
  }
  await api('/api/rename', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({urls: urlDraft})
  });
  await refresh();
}

async function stopPipeline() {
  await api('/api/stop', {method: 'POST'});
  await refresh();
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('urls').addEventListener('input', () => {
    bulkDirty = true;
  });
  document.getElementById('new-url').addEventListener('keydown', async (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      await addUrl();
    }
  });
  syncAdvancedPanel();
});

refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/":
            text_response(self, HTML)
            return
        if parsed.path == "/api/status":
            urls = read_urls()
            json_response(self, {
                "running": PROCESS is not None and PROCESS.poll() is None,
                "urls": urls,
                "collections": collection_summaries(urls),
                "log": read_log_lines(),
            })
            return
        if parsed.path.startswith("/output/"):
            relative = Path(unquote(parsed.path.removeprefix("/output/")))
            target = (OUT_DIR / relative).resolve()
            if not str(target).startswith(str(OUT_DIR.resolve())) or not target.exists() or target.is_dir():
                text_response(self, "Not found", "text/plain; charset=utf-8", 404)
                return
            content_type = "application/json; charset=utf-8" if target.suffix == ".json" else "text/plain; charset=utf-8"
            text_response(self, target.read_text(encoding="utf-8"), content_type)
            return
        text_response(self, "Not found", "text/plain; charset=utf-8", 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length).decode("utf-8") if length else "{}"
        payload = json.loads(body or "{}")

        if parsed.path == "/api/urls":
            write_urls(normalize_urls(payload.get("urls", [])))
            json_response(self, {"ok": True})
            return

        if parsed.path == "/api/run":
            global PROCESS
            if PROCESS is not None and PROCESS.poll() is None:
                json_response(self, {"ok": False, "error": "Pipeline is already running."}, 409)
                return
            thread = threading.Thread(target=run_pipeline, args=(payload,), daemon=True)
            thread.start()
            json_response(self, {"ok": True})
            return

        if parsed.path == "/api/rename":
            if PROCESS is not None and PROCESS.poll() is None:
                json_response(self, {"ok": False, "error": "Pipeline is already running."}, 409)
                return
            thread = threading.Thread(target=run_rename_files, args=(payload,), daemon=True)
            thread.start()
            json_response(self, {"ok": True})
            return

        if parsed.path == "/api/stop":
            if PROCESS is not None and PROCESS.poll() is None:
                add_log("Stopping pipeline by user request.")
                PROCESS.terminate()
            json_response(self, {"ok": True})
            return

        text_response(self, "Not found", "text/plain; charset=utf-8", 404)

    def log_message(self, format, *args):
        return


def main():
    port = 8765
    if "--port" in sys.argv:
        index = sys.argv.index("--port")
        port = int(sys.argv[index + 1])
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"X Bookmark Pipeline UI: http://127.0.0.1:{port}")
    print("Press Ctrl+C to stop.")
    server.serve_forever()


if __name__ == "__main__":
    main()
