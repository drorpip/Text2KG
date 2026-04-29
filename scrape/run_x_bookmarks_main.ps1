$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$pythonExe = Join-Path $repoRoot ".venv\Scripts\python.exe"

if (-not (Test-Path $pythonExe)) {
    throw "Python venv not found at $pythonExe"
}

& $pythonExe (Join-Path $repoRoot "scrape\x_bookmarks_pipeline.py") `
    --cdp-url "http://127.0.0.1:9222" `
    --url "https://x.com/i/bookmarks"
