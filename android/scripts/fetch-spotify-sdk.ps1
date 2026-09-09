$ErrorActionPreference = "Stop"

$destination = Join-Path $PSScriptRoot "..\app\libs\spotify-app-remote-release-0.8.0.aar"
$directory = Split-Path -Parent $destination
New-Item -ItemType Directory -Force -Path $directory | Out-Null

$url = "https://github.com/spotify/android-sdk/releases/download/v0.8.0-appremote_v2.1.0-auth/spotify-app-remote-release-0.8.0.aar"
Invoke-WebRequest -Uri $url -OutFile $destination
Write-Host "Spotify App Remote SDK downloaded to $destination"
