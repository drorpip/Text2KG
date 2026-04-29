$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$pythonExe = Join-Path $repoRoot ".venv\Scripts\python.exe"
$browserScript = Join-Path $scriptDir "open_x_bookmarks_browser.ps1"
$uiScript = Join-Path $scriptDir "run_x_bookmarks_ui.ps1"
$ollamaHost = "http://127.0.0.1:11434"
$ollamaModel = "gemma4:e4b"

function Test-OllamaReady {
    param(
        [string]$Url
    )

    try {
        $response = Invoke-RestMethod -Uri "$Url/api/tags" -Method Get -TimeoutSec 2
        return $null -ne $response
    } catch {
        return $false
    }
}

if (-not (Test-Path $pythonExe)) {
    throw "Python venv not found at $pythonExe"
}

$env:OLLAMA_HOST = $ollamaHost
$env:OLLAMA_MEDIA_TITLE_MODEL = $ollamaModel
$env:OLLAMA_TAGS_TIMEOUT_SEC = "5"
$env:OLLAMA_GENERATE_TIMEOUT_SEC = "180"

if (-not (Test-OllamaReady -Url $ollamaHost)) {
    $ollamaCommand = Get-Command ollama -ErrorAction SilentlyContinue
    if ($ollamaCommand) {
        Start-Process -FilePath $ollamaCommand.Source `
            -ArgumentList @("serve") `
            -WindowStyle Hidden

        $started = $false
        for ($attempt = 0; $attempt -lt 15; $attempt++) {
            Start-Sleep -Seconds 1
            if (Test-OllamaReady -Url $ollamaHost) {
                $started = $true
                break
            }
        }

        if ($started) {
            Write-Host "Ollama is running at $ollamaHost"
        } else {
            Write-Host "Ollama start was requested, but the server did not become ready in time."
            Write-Host "The scraper UI will still open. Rename/title generation will use Ollama once it becomes available."
        }
    } else {
        Write-Host "Ollama was not found on PATH."
        Write-Host "The scraper UI will still open, but rename/title generation will skip Ollama until it is installed and running."
    }
} else {
    Write-Host "Ollama is already running at $ollamaHost"
}

Write-Host ""
Write-Host "Opening dedicated X browser profile..."
& powershell -ExecutionPolicy Bypass -File $browserScript

Write-Host ""
Write-Host "Starting bookmarks UI..."
Write-Host "UI URL: http://127.0.0.1:8765"
Write-Host "Source URL to keep/save: https://x.com/i/bookmarks"
Write-Host ""
Write-Host "If this browser profile is new, log in once in the opened browser window and leave it running."
Write-Host ""

& powershell -ExecutionPolicy Bypass -File $uiScript
