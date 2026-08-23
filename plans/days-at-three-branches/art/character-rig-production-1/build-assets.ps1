$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")
$registration = Get-Content -Raw (Join-Path $PSScriptRoot "registration.json") | ConvertFrom-Json
$cellSize = [int]$registration.cellSize
$sourceRoot = Join-Path $repoRoot "environments\three_branches\renderer\assets\source-art\frames\characters"
$previewPath = Join-Path $PSScriptRoot "character-cast-preview.png"

function New-TransparentBitmap {
    param([int] $Width, [int] $Height)

    return [System.Drawing.Bitmap]::new(
        $Width,
        $Height,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )
}

function Clear-TransparentColour {
    param([System.Drawing.Bitmap] $Bitmap)

    for ($y = 0; $y -lt $Bitmap.Height; $y++) {
        for ($x = 0; $x -lt $Bitmap.Width; $x++) {
            if ($Bitmap.GetPixel($x, $y).A -eq 0) {
                $Bitmap.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, 0, 0, 0))
            }
        }
    }
}

function Convert-Rectangle {
    param([object[]] $Values)

    return [System.Drawing.Rectangle]::new(
        [int]$Values[0],
        [int]$Values[1],
        [int]$Values[2],
        [int]$Values[3]
    )
}

function Write-Part {
    param(
        [System.Drawing.Bitmap] $Sheet,
        [object] $Part,
        [double] $Scale,
        [string] $DestinationPath
    )

    $source = Convert-Rectangle $Part.source
    if ($source.Left -lt 0 -or $source.Top -lt 0 -or
        $source.Right -gt $Sheet.Width -or $source.Bottom -gt $Sheet.Height) {
        throw "Source rectangle exceeds the rig sheet: $source"
    }

    $target = [System.Drawing.RectangleF]::new(
        [single]$Part.target[0],
        [single]$Part.target[1],
        [single]($source.Width * $Scale),
        [single]($source.Height * $Scale)
    )
    if ($target.Left -lt 0 -or $target.Top -lt 0 -or
        $target.Right -gt $cellSize -or $target.Bottom -gt $cellSize) {
        throw "Target rectangle exceeds the registered cell: $target"
    }

    $bitmap = New-TransparentBitmap $cellSize $cellSize
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.Clear([System.Drawing.Color]::FromArgb(0, 0, 0, 0))
        $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.DrawImage($Sheet, $target, $source, [System.Drawing.GraphicsUnit]::Pixel)
        Clear-TransparentColour $bitmap

        $directory = Split-Path -Parent $DestinationPath
        if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
            New-Item -ItemType Directory -Path $directory | Out-Null
        }
        $bitmap.Save($DestinationPath, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

foreach ($set in $registration.sets) {
    $sheetPath = Join-Path $PSScriptRoot $set.sheet
    if (-not (Test-Path -LiteralPath $sheetPath -PathType Leaf)) {
        throw "Rig sheet does not exist: $sheetPath"
    }
    $sheet = [System.Drawing.Bitmap]::FromFile($sheetPath)
    try {
        if ($sheet.Width -ne 1536 -or $sheet.Height -ne 1024) {
            throw "Rig sheet must be 1536 by 1024 pixels: $sheetPath"
        }
        $setRoot = Join-Path $sourceRoot $set.id
        Write-Part $sheet $set.base ([double]$set.scale) (Join-Path $setRoot "base.png")
        Write-Part $sheet $set.leftArm ([double]$set.scale) (Join-Path $setRoot "leftArm.png")
        Write-Part $sheet $set.rightArm ([double]$set.scale) (Join-Path $setRoot "rightArm.png")
    }
    finally {
        $sheet.Dispose()
    }
}

$preview = New-TransparentBitmap ($cellSize * $registration.sets.Count) $cellSize
$previewGraphics = [System.Drawing.Graphics]::FromImage($preview)
try {
    $previewGraphics.Clear([System.Drawing.Color]::FromArgb(0, 0, 0, 0))
    $previewGraphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
    for ($index = 0; $index -lt $registration.sets.Count; $index++) {
        $set = $registration.sets[$index]
        $setRoot = Join-Path $sourceRoot $set.id
        foreach ($partName in @("leftArm", "rightArm", "base")) {
            $part = [System.Drawing.Bitmap]::FromFile((Join-Path $setRoot "$partName.png"))
            try {
                $previewGraphics.DrawImageUnscaled($part, $index * $cellSize, 0)
            }
            finally {
                $part.Dispose()
            }
        }
    }
    Clear-TransparentColour $preview
    $preview.Save($previewPath, [System.Drawing.Imaging.ImageFormat]::Png)
}
finally {
    $previewGraphics.Dispose()
    $preview.Dispose()
}
