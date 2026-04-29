# X Bookmarks Quick Start

Use this from `C:\ML\vs_projects\social_extract`.

## Normal Start

Run the one-shot workflow:

```powershell
powershell -ExecutionPolicy Bypass -File .\scrape\start_x_bookmarks_workflow.ps1
```

What it does:

- starts Ollama if needed
- uses `gemma4:e4b` for semantic media titles
- uses `180` seconds for Ollama title generation
- opens the dedicated X browser profile
- starts the local bookmarks UI

## First-Time Login

When the browser opens:

1. Log in to X.
2. Open `https://x.com/i/bookmarks`.
3. Leave that browser window running.

Then in the UI:

1. Open `http://127.0.0.1:8765`
2. Keep only `https://x.com/i/bookmarks` as the saved source
3. Click `Sync bookmarks`

## Rename Only

If you only want semantic file rename from existing saved collections:

```powershell
$env:OLLAMA_MEDIA_TITLE_MODEL="gemma4:e4b"
$env:OLLAMA_GENERATE_TIMEOUT_SEC="180"
powershell -ExecutionPolicy Bypass -File .\scrape\run_x_bookmarks_ui.ps1
```

Then click `Rename files` in the UI.

## If Ollama Is Slow

Raise the timeout and relaunch the UI:

```powershell
$env:OLLAMA_MEDIA_TITLE_MODEL="gemma4:e4b"
$env:OLLAMA_GENERATE_TIMEOUT_SEC="300"
powershell -ExecutionPolicy Bypass -File .\scrape\run_x_bookmarks_ui.ps1
```

## Useful Commands

Open dedicated browser only:

```powershell
powershell -ExecutionPolicy Bypass -File .\scrape\open_x_bookmarks_browser.ps1
```

Run main bookmarks sync from CLI:

```powershell
powershell -ExecutionPolicy Bypass -File .\scrape\run_x_bookmarks_main.ps1
```

Open UI only:

```powershell
powershell -ExecutionPolicy Bypass -File .\scrape\run_x_bookmarks_ui.ps1
```

## Notes

- The main source should be `https://x.com/i/bookmarks`
- Folder discovery happens from that page
- Existing numeric bookmark folders under `scrape\x_bookmarks_output` are reused for rename and repair
