$ErrorActionPreference = "Stop"

Import-Module (Join-Path $PSScriptRoot "..\tools\AssetNormalization.psm1") -Force

$assets = @(
    "villager-felt-cap-rig",
    "villager-quilted-cap-rig",
    "villager-linen-bonnet-rig"
)

foreach ($asset in $assets) {
    Convert-MatteProof `
        -SourcePath (Join-Path $PSScriptRoot "$asset-raw.png") `
        -DestinationPath (Join-Path $PSScriptRoot "$asset.png") `
        -OutputWidth 1536 `
        -OutputHeight 1024 `
        -MatteValues @(243, 245, 247, 249, 251, 253, 255) `
        -MatteClearDistance 8 `
        -MatteOpaqueDistance 30 `
        -AlphaClearThreshold 20 `
        -AlphaOpaqueThreshold 80 `
        -MinimumIslandPixels 12
}
