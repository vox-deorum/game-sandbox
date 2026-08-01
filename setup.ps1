$ErrorActionPreference = 'Stop'

Set-Location $PSScriptRoot

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    irm https://astral.sh/uv/install.ps1 | iex
    $env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
}

uv run --no-project python scripts/setup.py @args
exit $LASTEXITCODE
