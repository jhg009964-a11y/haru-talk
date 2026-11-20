# Builds the app screens and publishes them to GitHub Pages (gh-pages branch).
# The installed app loads them from there, so restarting the app picks up the change.
$ErrorActionPreference = "Continue"   # git writes progress to stderr; check exit codes instead
$root = $PSScriptRoot
Push-Location $root
try {
  npx vite build
  if ($LASTEXITCODE -ne 0) { throw "빌드 실패" }
  $remote = git remote get-url origin
  $tmp = Join-Path $env:TEMP "haru-pages"
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
  Copy-Item -Recurse (Join-Path $root "dist") $tmp
  New-Item -ItemType File (Join-Path $tmp ".nojekyll") | Out-Null
  Push-Location $tmp
  git init -q -b gh-pages
  git config core.autocrlf false
  git add -A 2>$null
  git -c user.name="jhg009964-a11y" -c user.email="jhg009964-a11y@users.noreply.github.com" commit -q -m "deploy $(Get-Date -Format s)"
  git push -q -f $remote gh-pages 2>$null
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) { throw "GitHub에 올리지 못했어요 (git push 실패)" }
  Remove-Item -Recurse -Force $tmp
  Write-Host "배포 완료. 1~10분 뒤 앱을 완전히 껐다 켜면 적용돼요."
} finally { Pop-Location }
