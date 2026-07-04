param(
  [string]$DeployHookUrl = $env:RENDER_DEPLOY_HOOK_URL
)

$ErrorActionPreference = "Stop"

if (-not $DeployHookUrl) {
  throw "Set RENDER_DEPLOY_HOOK_URL or pass -DeployHookUrl."
}

Write-Host "Checking JavaScript..."
node --check server.mjs
node --check app.js

Write-Host "Checking odds JSON..."
python -m json.tool odds_preload.json | Out-Null

Write-Host "Triggering Render deploy..."
Invoke-WebRequest -Uri $DeployHookUrl -Method POST -UseBasicParsing | Out-Null

Write-Host "Deploy hook triggered."
