Stop-Process -Name chrome,msedge -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
& $edge "--remote-debugging-port=9222" "--remote-debugging-address=127.0.0.1" "--user-data-dir=C:\ML\vs_projects\social_extract\scrape\edge_x_profile_9222" "--new-window" "https://x.com/i/bookmarks"
