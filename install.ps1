# One-line install, no clone needed:
#   irm https://raw.githubusercontent.com/yjacket/omo-limitless/master/install.ps1 | iex
# Run from a clone (.\install.ps1) it copies the local files instead.
& {
	param($root)
	$ErrorActionPreference = "Stop"
	$ProgressPreference = "SilentlyContinue"
	$zip = "https://codeload.github.com/yjacket/omo-limitless/zip/refs/heads/master"
	$agent = @($env:OMO_CODING_AGENT_DIR, $env:SENPI_CODING_AGENT_DIR, $env:PI_CODING_AGENT_DIR) | Where-Object { $_ } | Select-Object -First 1
	if (-not $agent) { $agent = Join-Path $HOME ".omo\agent" }
	$ext = Join-Path $agent "extensions"
	$dst = Join-Path $ext "omo-limitless"
	$tmp = Join-Path $ext "omo-limitless.tmp-$PID"
	$work = $null
	try {
		$src = if ($root) { Join-Path $root "extension" } else { $null }
		if (-not ($src -and (Test-Path (Join-Path $src "limitless.mjs")))) {
			$work = Join-Path ([System.IO.Path]::GetTempPath()) "omo-limitless-$PID"
			New-Item -ItemType Directory -Force $work | Out-Null
			$archive = Join-Path $work "master.zip"
			Invoke-WebRequest -UseBasicParsing -Uri $zip -OutFile $archive
			Expand-Archive $archive -DestinationPath $work -Force
			$src = Join-Path $work "omo-limitless-master\extension"
		}
		New-Item -ItemType Directory -Force $ext | Out-Null
		if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
		Copy-Item $src $tmp -Recurse
		if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
		Rename-Item $tmp "omo-limitless"
		# index.js is the entry omo loads, so it goes in last: the folder is never loadable half-copied.
		Copy-Item (Join-Path $dst "limitless.mjs") (Join-Path $dst "index.js") -Force
	} finally {
		if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
		if ($work) { Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue }
	}
	Write-Host "installed -> $dst"
	Write-Host "Type /reload in running omo sessions."
} $PSScriptRoot
