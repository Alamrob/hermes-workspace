[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$runtimeRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$containerName = "proptimiza-runtime-pg17-$([Guid]::NewGuid().ToString('N'))"
$testPassword = "runtime-test-$([Guid]::NewGuid().ToString('N'))"
$containerStarted = $false
$previousTestDatabaseUrl = $env:TEST_DATABASE_URL

try {
  $containerId = & docker run --detach --rm --name $containerName --publish 127.0.0.1::5432 --env "POSTGRES_PASSWORD=$testPassword" postgres:17
  if ($LASTEXITCODE -ne 0) { throw 'docker run failed' }
  $containerStarted = $true

  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    & docker exec $containerName pg_isready --username postgres --dbname postgres *> $null
    if ($LASTEXITCODE -eq 0) {
      $ready = $true
      break
    }
    Start-Sleep -Seconds 1
  }
  if (-not $ready) { throw 'PostgreSQL 17 did not become ready in 30 seconds' }

  $portMapping = & docker port $containerName 5432/tcp
  if ($LASTEXITCODE -ne 0) { throw 'docker port failed' }
  $publishedPort = ($portMapping.Trim() -split ':')[-1]
  if ($publishedPort -notmatch '^\d+$') { throw "Unexpected Docker port mapping: $portMapping" }

  $escapedPassword = [Uri]::EscapeDataString($testPassword)
  $env:TEST_DATABASE_URL = "postgresql://postgres:$escapedPassword@127.0.0.1:$publishedPort/postgres"
  Push-Location $runtimeRoot
  try {
    & pnpm --ignore-workspace run test:integration
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL integration tests failed' }
  }
  finally {
    Pop-Location
  }
}
finally {
  if ($containerStarted) {
    & docker rm --force $containerName *> $null
  }
  if ($null -eq $previousTestDatabaseUrl) {
    Remove-Item Env:TEST_DATABASE_URL -ErrorAction SilentlyContinue
  }
  else {
    $env:TEST_DATABASE_URL = $previousTestDatabaseUrl
  }
}
