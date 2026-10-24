<#
  Windows PowerShell version of scripts/run-node-tests.sh: runs every Node.js
  test file with the built-in runner (node --test), one file at a time from its
  own package directory, and prints a pass/fail line per file plus a total.

    .\scripts\run-node-tests.ps1

  Install each service's dependencies first (npm ci / npm install in
  services/<name>); files that import a missing package are reported as SKIP.
  tests/db (real PostgreSQL) runs only when SC_DB_TEST=1 - see that file's header.
  Exit code is non-zero if any file failed.
#>
$ErrorActionPreference = "Continue"
Set-Location (Join-Path $PSScriptRoot "..")

$totalPass = 0; $totalFail = 0; $filesFailed = 0; $filesSkipped = 0
$results = New-Object System.Collections.Generic.List[string]

function Invoke-TestFile([string]$Dir, [string]$File) {
  Push-Location $Dir
  # TAP reporter: Node 23+ defaults to "spec", whose summary lines this parser doesn't read.
  $out = (node --test --test-reporter=tap $File 2>&1 | Out-String)
  Pop-Location
  if ($out -match "Cannot find package '([^']*)'") {
    $results.Add("SKIP  $Dir/$File (missing deps: $($Matches[1]) - run npm ci in $Dir)")
    $script:filesSkipped++
    return
  }
  $pass = 0; $fail = 0
  if ($out -match "(?m)^# pass (\d+)") { $pass = [int]$Matches[1] }
  if ($out -match "(?m)^# fail (\d+)") { $fail = [int]$Matches[1] }
  # A failing before() hook cancels every test in its suite: "# fail 0", "# cancelled N".
  if ($out -match "(?m)^# cancelled (\d+)") { $fail += [int]$Matches[1] }
  $script:totalPass += $pass; $script:totalFail += $fail
  if ($fail -ne 0) {
    $script:filesFailed++
    $results.Add("FAIL  $Dir/$File ($pass passed, $fail failed)")
    ($out -split "`n" | Where-Object { $_ -match "^not ok|failureType|error:" } | Select-Object -First 20) | ForEach-Object { Write-Host $_ -ForegroundColor Red }
  } else {
    $results.Add("PASS  $Dir/$File ($pass tests)")
  }
}

$dirs = @(Get-ChildItem services -Directory | ForEach-Object { "services/$($_.Name)" }) + @("shared/node-security", "shared/node-broker")
if ($env:SC_DB_TEST -eq "1") { $dirs += "tests/db" }
foreach ($dir in $dirs) {
  if (-not (Test-Path $dir)) { continue }
  if (Test-Path "$dir/tests") {
    Get-ChildItem "$dir/tests" -Filter *.test.js | ForEach-Object { Invoke-TestFile $dir "tests/$($_.Name)" }
  } else {
    Get-ChildItem $dir -Filter *.test.js | ForEach-Object { Invoke-TestFile $dir $_.Name }
  }
}

$results | ForEach-Object { Write-Host $_ }
Write-Host "-------------------------------------------------------------"
Write-Host "tests passed: $totalPass   failed: $totalFail   files failed: $filesFailed   files skipped (missing deps): $filesSkipped"
if ($filesFailed -ne 0 -or $totalFail -ne 0) { exit 1 }
