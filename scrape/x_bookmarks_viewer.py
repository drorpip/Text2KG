import json
import mimetypes
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse


SCRIPT_DIR = Path(__file__).resolve().parent
OUT_DIR = SCRIPT_DIR / "x_bookmarks_output"


def load_json(path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return default


def collection_dirs():
    if not OUT_DIR.exists():
        return []
    directories = []
    for path in OUT_DIR.iterdir():
        if path.is_dir() and (path / "bookmarks.json").exists():
            directories.append(path)
    return sorted(directories, key=lambda p: p.name)


def collection_info(path):
    posts = load_json(path / "bookmarks.json", [])
    with_media = 0
    image_count = 0
    video_count = 0
    thumb_count = 0
    for post in posts:
        images = post.get("downloaded_images", [])
        videos = post.get("downloaded_videos", []) + post.get("yt_dlp_downloads", [])
        thumbs = post.get("downloaded_video_thumbnails", [])
        image_count += len(images)
        video_count += len(videos)
        thumb_count += len(thumbs)
        if images or videos or thumbs:
            with_media += 1
    state = load_json(path / "pipeline_state.json", {})
    last_run = state.get("last_run", {})
    return {
        "id": path.name,
        "archive_count": len(posts),
        "posts_with_media": with_media,
        "images": image_count,
        "videos": video_count,
        "thumbnails": thumb_count,
        "last_run_at": last_run.get("ran_at"),
    }


def media_url(collection_id, rel_path):
    return f"/asset/{quote(collection_id)}/{quote(rel_path.replace('\\', '/'))}"


def post_payload(collection_id, post, index):
    images = [media_url(collection_id, path) for path in post.get("downloaded_images", [])]
    videos = [media_url(collection_id, path) for path in post.get("downloaded_videos", [])]
    videos.extend(media_url(collection_id, path) for path in post.get("yt_dlp_downloads", []))
    thumbnails = [
        media_url(collection_id, path)
        for path in post.get("downloaded_video_thumbnails", [])
    ]
    return {
        "index": index,
        "post_url": post.get("post_url"),
        "text": post.get("text", ""),
        "links": post.get("links", []),
        "images": images,
        "videos": videos,
        "thumbnails": thumbnails,
        "first_seen_at": post.get("first_seen_at"),
        "last_seen_at": post.get("last_seen_at"),
        "has_media": bool(images or videos or thumbnails),
    }


def posts_for_collection(collection_id, search_text="", media_only=False):
    path = OUT_DIR / collection_id / "bookmarks.json"
    posts = load_json(path, [])
    payload = [post_payload(collection_id, post, idx + 1) for idx, post in enumerate(posts)]
    if search_text:
        query = search_text.casefold()
        payload = [
            post for post in payload
            if query in post["text"].casefold()
            or (post["post_url"] and query in post["post_url"].casefold())
        ]
    if media_only:
        payload = [post for post in payload if post["has_media"]]
    return payload


def json_response(handler, payload, status=200):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def bytes_response(handler, data, content_type, status=200):
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
  <title>X Bookmark Viewer</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f7fa;
      --panel: #ffffff;
      --line: #d7dfe7;
      --ink: #1b2430;
      --muted: #667586;
      --accent: #156f63;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: "Segoe UI", Arial, sans-serif;
    }
    header {
      padding: 16px 20px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    h1, h2, h3 { margin: 0; }
    main {
      display: grid;
      grid-template-columns: 320px minmax(0, 1fr);
      min-height: calc(100vh - 66px);
    }
    aside {
      border-right: 1px solid var(--line);
      background: var(--panel);
      padding: 16px;
      overflow: auto;
    }
    section {
      padding: 16px 18px 28px;
      overflow: auto;
    }
    .toolbar, .filters {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
    }
    .filters {
      margin: 12px 0 16px;
    }
    input[type="text"], select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 9px 10px;
      font: inherit;
      background: white;
    }
    .check {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 14px;
    }
    button, a.button {
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
    button.secondary, a.button.secondary {
      background: white;
      color: var(--accent);
    }
    .collection-list {
      display: grid;
      gap: 10px;
      margin-top: 14px;
    }
    .collection {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: white;
      padding: 12px;
      cursor: pointer;
    }
    .collection.active {
      border-color: var(--accent);
      box-shadow: inset 0 0 0 1px var(--accent);
    }
    .meta {
      color: var(--muted);
      font-size: 12px;
      margin-top: 6px;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 8px;
      margin-top: 10px;
    }
    .stat {
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #f8fafc;
      padding: 8px;
    }
    .stat strong {
      display: block;
      font-size: 18px;
    }
    .stat span {
      color: var(--muted);
      font-size: 12px;
    }
    .posts {
      display: grid;
      gap: 16px;
    }
    .post {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      padding: 14px;
    }
    .post-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 10px;
    }
    .post-title {
      font-size: 13px;
      color: var(--muted);
    }
    .post-text {
      white-space: pre-wrap;
      line-height: 1.45;
      margin: 0;
    }
    .media-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 12px;
      margin-top: 14px;
    }
    .media-item {
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
      background: #fff;
    }
    .media-item img, .media-item video {
      display: block;
      width: 100%;
      height: auto;
      max-height: 420px;
      object-fit: contain;
      background: #edf2f7;
    }
    .media-label {
      padding: 8px 10px;
      border-top: 1px solid var(--line);
      color: var(--muted);
      font-size: 12px;
    }
    .links {
      margin-top: 12px;
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .empty {
      border: 1px dashed var(--line);
      border-radius: 8px;
      padding: 24px;
      color: var(--muted);
      background: var(--panel);
    }
    @media (max-width: 980px) {
      main { grid-template-columns: 1fr; }
      aside { border-right: 0; border-bottom: 1px solid var(--line); }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>X Bookmark Viewer</h1>
      <div class="meta">Browse downloaded posts, images, thumbnails, and videos.</div>
    </div>
    <div class="toolbar">
      <button class="secondary" onclick="refreshCollections()">Refresh</button>
    </div>
  </header>
  <main>
    <aside>
      <label for="collection-select">Collection</label>
      <select id="collection-select" onchange="changeCollection(this.value)"></select>

      <div class="collection-list" id="collection-list"></div>
    </aside>
    <section>
      <div class="filters">
        <div style="flex:1; min-width:220px">
          <input id="search" type="text" placeholder="Search post text or URL">
        </div>
        <label class="check"><input id="media-only" type="checkbox"> Media only</label>
        <button onclick="loadPosts()">Apply</button>
      </div>

      <div id="posts" class="posts"></div>
    </section>
  </main>
<script>
let collections = [];
let currentCollection = '';

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderCollections() {
  const select = document.getElementById('collection-select');
  const list = document.getElementById('collection-list');
  select.innerHTML = collections.map(item => `
    <option value="${item.id}" ${item.id === currentCollection ? 'selected' : ''}>${item.id}</option>
  `).join('');
  list.innerHTML = collections.map(item => `
    <div class="collection ${item.id === currentCollection ? 'active' : ''}" onclick="changeCollection('${item.id}')">
      <h3>${item.id}</h3>
      <div class="meta">${item.last_run_at || 'No run yet'}</div>
      <div class="stats">
        <div class="stat"><strong>${item.archive_count}</strong><span>Posts</span></div>
        <div class="stat"><strong>${item.posts_with_media}</strong><span>With Media</span></div>
        <div class="stat"><strong>${item.images}</strong><span>Images</span></div>
        <div class="stat"><strong>${item.videos}</strong><span>Videos</span></div>
      </div>
    </div>
  `).join('');
}

function mediaCard(kind, url, label) {
  if (kind === 'video') {
    return `
      <div class="media-item">
        <video controls preload="metadata" src="${url}"></video>
        <div class="media-label">${label}</div>
      </div>
    `;
  }
  return `
    <div class="media-item">
      <img src="${url}" loading="lazy" alt="${label}">
      <div class="media-label">${label}</div>
    </div>
  `;
}

function renderPosts(items) {
  const root = document.getElementById('posts');
  if (!items.length) {
    root.innerHTML = '<div class="empty">No posts matched the current collection and filters.</div>';
    return;
  }
  root.innerHTML = items.map(post => {
    const media = [
      ...post.images.map((url, idx) => mediaCard('image', url, `Image ${idx + 1}`)),
      ...post.videos.map((url, idx) => mediaCard('video', url, `Video ${idx + 1}`)),
      ...post.thumbnails.map((url, idx) => mediaCard('image', url, `Video Thumbnail ${idx + 1}`))
    ].join('');
    const links = [];
    if (post.post_url) {
      links.push(`<a class="button secondary" href="${post.post_url}" target="_blank">Open X Post</a>`);
    }
    return `
      <article class="post">
        <div class="post-header">
          <div>
            <div class="post-title">Item ${post.index}</div>
            <div class="meta">${post.first_seen_at || ''}</div>
          </div>
        </div>
        <p class="post-text">${escapeHtml(post.text)}</p>
        ${media ? `<div class="media-grid">${media}</div>` : ''}
        <div class="links">${links.join('')}</div>
      </article>
    `;
  }).join('');
}

async function loadPosts() {
  if (!currentCollection) {
    renderPosts([]);
    return;
  }
  const search = encodeURIComponent(document.getElementById('search').value);
  const mediaOnly = document.getElementById('media-only').checked ? '1' : '0';
  const items = await api(`/api/posts?collection_id=${encodeURIComponent(currentCollection)}&q=${search}&media_only=${mediaOnly}`);
  renderPosts(items.posts);
}

async function refreshCollections() {
  const data = await api('/api/collections');
  collections = data.collections;
  if (!currentCollection && collections.length) {
    currentCollection = collections[0].id;
  }
  if (currentCollection && !collections.some(item => item.id === currentCollection) && collections.length) {
    currentCollection = collections[0].id;
  }
  renderCollections();
  await loadPosts();
}

async function changeCollection(collectionId) {
  currentCollection = collectionId;
  renderCollections();
  await loadPosts();
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('search').addEventListener('keydown', async (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      await loadPosts();
    }
  });
  refreshCollections();
});
</script>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/":
            data = HTML.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        if parsed.path == "/api/collections":
            collections = [collection_info(path) for path in collection_dirs()]
            json_response(self, {"collections": collections})
            return

        if parsed.path == "/api/posts":
            query = parse_qs(parsed.query)
            collection_id = query.get("collection_id", [""])[0]
            search_text = query.get("q", [""])[0]
            media_only = query.get("media_only", ["0"])[0] == "1"
            json_response(self, {
                "posts": posts_for_collection(collection_id, search_text=search_text, media_only=media_only)
            })
            return

        if parsed.path.startswith("/asset/"):
            rest = parsed.path.removeprefix("/asset/")
            if "/" not in rest:
                self.send_error(404)
                return
            collection_id, rel_path = rest.split("/", 1)
            base = (OUT_DIR / unquote(collection_id)).resolve()
            target = (base / Path(unquote(rel_path))).resolve()
            if not str(target).startswith(str(base)) or not target.exists() or target.is_dir():
                self.send_error(404)
                return
            content_type, _ = mimetypes.guess_type(str(target))
            data = target.read_bytes()
            bytes_response(self, data, content_type or "application/octet-stream")
            return

        self.send_error(404)

    def log_message(self, format, *args):
        return


def main():
    port = 8767
    if "--port" in sys.argv:
        index = sys.argv.index("--port")
        port = int(sys.argv[index + 1])
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"X Bookmark Viewer: http://127.0.0.1:{port}")
    print("Press Ctrl+C to stop.")
    server.serve_forever()


if __name__ == "__main__":
    main()
