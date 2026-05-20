$ErrorActionPreference = "Continue"
Set-Location C:\DevApps\mission-control
& pm2 stop mission-control 2>&1 | Select-Object -Last 2
Start-Sleep -Seconds 2
& git pull origin master 2>&1 | Select-Object -Last 5

# --- sync external skills bundles --------------------------------------------
# Idempotent: clones if missing, ff-pulls if present, re-creates junctions every
# run so renamed source paths heal themselves. Best-effort - never fails the
# build.
function Sync-ExternalSkills {
  param(
    [Parameter(Mandatory)] [string] $Repo,
    [Parameter(Mandatory)] [string] $Url,
    [Parameter(Mandatory)] [string[]] $RelPaths,
    [string] $Tag
  )
  try {
    $skillsDir   = Join-Path $env:USERPROFILE ".openclaw\workspace\skills"
    $externalDir = Join-Path $skillsDir "_external"
    $repoDir     = Join-Path $externalDir $Repo

    New-Item -ItemType Directory -Force -Path $skillsDir   | Out-Null
    New-Item -ItemType Directory -Force -Path $externalDir | Out-Null

    if (Test-Path (Join-Path $repoDir ".git")) {
      Write-Host "${Tag}: pulling latest"
      & git -C $repoDir pull --ff-only 2>&1 | Select-Object -Last 3
    } else {
      Write-Host "${Tag}: cloning fresh"
      & git clone --depth 1 $Url $repoDir 2>&1 | Select-Object -Last 3
    }

    foreach ($rel in $RelPaths) {
      $src    = Join-Path $repoDir $rel
      $name   = Split-Path $rel -Leaf
      $target = Join-Path $skillsDir $name
      if (-not (Test-Path $src)) { continue }
      if (Test-Path $target) { cmd /c "rmdir `"$target`"" 2>&1 | Out-Null }
      cmd /c "mklink /J `"$target`" `"$src`"" 2>&1 | Out-Null
    }

    $names = $RelPaths | ForEach-Object { Split-Path $_ -Leaf }
    $linked = (Get-ChildItem $skillsDir -Force -Directory |
               Where-Object { $_.LinkType -eq "Junction" -and $names -contains $_.Name }).Count
    Write-Host "${Tag}: $linked / $($RelPaths.Count) junctions in place"
  } catch {
    Write-Host "${Tag}: sync skipped - $_"
  }
}

# Matt Pocock skills - the priority engineering operating model.
Sync-ExternalSkills `
  -Repo "mattpocock-skills" `
  -Url  "https://github.com/mattpocock/skills" `
  -Tag  "MP skills" `
  -RelPaths @(
    "skills\engineering\diagnose", "skills\engineering\grill-with-docs", "skills\engineering\triage",
    "skills\engineering\improve-codebase-architecture", "skills\engineering\setup-matt-pocock-skills",
    "skills\engineering\tdd", "skills\engineering\to-issues", "skills\engineering\to-prd", "skills\engineering\zoom-out",
    "skills\productivity\caveman", "skills\productivity\grill-me", "skills\productivity\write-a-skill"
  )

# GitNexus - code-intelligence MCP + 7 supporting skills.
Sync-ExternalSkills `
  -Repo "gitnexus" `
  -Url  "https://github.com/abhigyanpatwari/gitnexus" `
  -Tag  "GitNexus skills" `
  -RelPaths @(
    "gitnexus-claude-plugin\skills\gitnexus-cli",
    "gitnexus-claude-plugin\skills\gitnexus-debugging",
    "gitnexus-claude-plugin\skills\gitnexus-exploring",
    "gitnexus-claude-plugin\skills\gitnexus-guide",
    "gitnexus-claude-plugin\skills\gitnexus-impact-analysis",
    "gitnexus-claude-plugin\skills\gitnexus-pr-review",
    "gitnexus-claude-plugin\skills\gitnexus-refactoring"
  )

# Pre-warm the npx cache for gitnexus so the first MCP launch in chat is fast.
# Best-effort - skip silently if it can't run.
try {
  Write-Host "GitNexus npx: pre-warming cache"
  $job = Start-Job -ScriptBlock { & npx -y gitnexus@latest --help 2>&1 | Out-Null }
  Wait-Job -Job $job -Timeout 240 | Out-Null
  Remove-Job -Job $job -Force 2>&1 | Out-Null
} catch {
  Write-Host "GitNexus npx: pre-warm skipped - $_"
}
# -----------------------------------------------------------------------------

$env:NODE_OPTIONS = "--max-old-space-size=16384"
& npx next build 2>&1 | Select-Object -Last 8
$exit = $LASTEXITCODE
if ($exit -eq 0 -and (Test-Path ".next\BUILD_ID")) {
  # CRITICAL: PM2 daemon dies whenever the SSH session that started it ends
  # (every node process is a child of the SSH session's process group on
  # Windows OpenSSH). On 2026-05-04 this caused MC to silently die after
  # every SSH-driven deploy. Workaround: kick PM2 via the MCResurrect
  # scheduled task — schtasks spawns the process detached from any session,
  # so when SSH disconnects, the daemon survives. The task is registered as
  # OnLogon by setup-pc-mc-service (also runs on demand here).
  & pm2 restart mission-control 2>&1 | Select-Object -Last 2
  Start-Sleep -Seconds 5
  # Belt-and-braces: if pm2 daemon was started fresh by the SSH session
  # above (no prior daemon), kick MCResurrect now so the daemon is owned
  # by the schtasks-spawned process tree, not this SSH session.
  $taskExists = (schtasks /Query /TN MCResurrect 2>$null) -ne $null
  if ($taskExists) {
    Write-Host "kicking MCResurrect schtask to detach pm2 daemon"
    & schtasks /Run /TN MCResurrect 2>&1 | Out-Null
    Start-Sleep -Seconds 4
  } else {
    Write-Host "WARN: MCResurrect schtask not found — pm2 daemon may die when this SSH session ends"
    Write-Host "  fix: schtasks /Create /F /TN MCResurrect /TR `"cmd /c pm2 resurrect`" /SC ONLOGON /RL HIGHEST"
  }
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:3001/" -UseBasicParsing -TimeoutSec 15
    Write-Host "MC HTTP $($r.StatusCode)"
  } catch { Write-Host "MC FAIL $_" }
} else {
  Write-Host "Build failed"
}
