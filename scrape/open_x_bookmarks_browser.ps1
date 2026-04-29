$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$profileRoot = Join-Path $scriptDir "chrome_x_profile"
$chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$edgePath = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

if (-not (Test-Path $profileRoot)) {
    New-Item -ItemType Directory -Path $profileRoot | Out-Null
}

$browserPath = $null
if (Test-Path $chromePath) {
    $browserPath = $chromePath
} elseif (Test-Path $edgePath) {
    $browserPath = $edgePath
} else {
    throw "Could not find Chrome or Edge."
}

$args = @(
    "--remote-debugging-port=9222",
    "--user-data-dir=$profileRoot",
    "https://x.com/i/bookmarks"
)

Start-Process -FilePath $browserPath -ArgumentList $args

Write-Host ""
Write-Host "Opened browser with dedicated scrape profile:"
Write-Host "  $profileRoot"
Write-Host ""
Write-Host "If this is the first time:"
Write-Host "1. Log in to X in that browser window."
Write-Host "2. Make sure https://x.com/i/bookmarks stays open."
Write-Host "3. Leave that browser window running."
Write-Host ""
Write-Host "Then run:"
Write-Host "  .\scrape\run_x_bookmarks_main.ps1"
