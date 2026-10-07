param(
    [string]$Target = (Join-Path $HOME ".omo\agent\extensions")
)

$dst = Join-Path $Target "omo-limitless"
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item (Join-Path $PSScriptRoot "extension\*") $dst -Recurse -Force
Copy-Item (Join-Path $PSScriptRoot "extension\limitless.mjs") (Join-Path $dst "index.js") -Force
Write-Host "installed -> $dst"
Write-Host "In a running omo session type /reload."
