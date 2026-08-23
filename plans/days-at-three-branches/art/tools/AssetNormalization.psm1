$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

if ($null -eq ("ThreeBranches.Art.RasterAssetNormalizer" -as [type])) {
    Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace ThreeBranches.Art
{
    public static class RasterAssetNormalizer
    {
        public static void NormalizeMatteProof(
            string sourcePath,
            string destinationPath,
            int outputWidth,
            int outputHeight,
            byte[] matteValues,
            double matteClearDistance,
            double matteOpaqueDistance,
            int alphaClearThreshold,
            int alphaOpaqueThreshold,
            int minimumIslandPixels,
            bool alignVisibleBounds,
            int targetLeft,
            int targetTop,
            int targetWidth,
            int targetHeight)
        {
            ValidateRamp(matteClearDistance, matteOpaqueDistance, "matte distance");
            ValidateRamp(alphaClearThreshold, alphaOpaqueThreshold, "alpha");
            if (matteValues == null || matteValues.Length == 0)
            {
                throw new ArgumentException("At least one matte value is required.", "matteValues");
            }

            using (Bitmap source = LoadArgb(sourcePath))
            {
                RemoveNeutralMatte(source, matteValues, matteClearDistance, matteOpaqueDistance);
                using (Bitmap resized = Resize(source, outputWidth, outputHeight))
                {
                    NormalizeAlpha(resized, alphaClearThreshold, alphaOpaqueThreshold);
                    RemoveSmallIslands(resized, minimumIslandPixels);
                    if (!alignVisibleBounds)
                    {
                        resized.Save(destinationPath, ImageFormat.Png);
                        return;
                    }

                    Rectangle targetBounds = new Rectangle(targetLeft, targetTop, targetWidth, targetHeight);
                    using (Bitmap aligned = AlignVisibleBounds(resized, targetBounds))
                    {
                        NormalizeAlpha(aligned, alphaClearThreshold, alphaOpaqueThreshold);
                        RemoveSmallIslands(aligned, minimumIslandPixels);
                        aligned.Save(destinationPath, ImageFormat.Png);
                    }
                }
            }
        }

        public static void NormalizeWhiteProofToMask(
            string sourcePath,
            string destinationPath,
            int outputWidth,
            int outputHeight,
            int whitePoint,
            double alphaScale)
        {
            using (Bitmap source = LoadArgb(sourcePath))
            {
                ConvertWhiteProofToMask(source, whitePoint, alphaScale);
                using (Bitmap output = Resize(source, outputWidth, outputHeight))
                {
                    ClearTransparentColor(output);
                    output.Save(destinationPath, ImageFormat.Png);
                }
            }
        }

        public static void NormalizeTransparentProof(
            string sourcePath,
            string destinationPath,
            int outputWidth,
            int outputHeight,
            int alphaClearThreshold,
            int alphaOpaqueThreshold,
            int minimumIslandPixels,
            bool whiteMask,
            bool alignVisibleBounds,
            int targetLeft,
            int targetTop,
            int targetWidth,
            int targetHeight)
        {
            ValidateRamp(alphaClearThreshold, alphaOpaqueThreshold, "alpha");
            using (Bitmap source = LoadArgb(sourcePath))
            using (Bitmap resized = Resize(source, outputWidth, outputHeight))
            {
                NormalizeAlpha(resized, alphaClearThreshold, alphaOpaqueThreshold);
                RemoveSmallIslands(resized, minimumIslandPixels);
                if (!alignVisibleBounds)
                {
                    if (whiteMask) ConvertExistingAlphaToWhiteMask(resized);
                    resized.Save(destinationPath, ImageFormat.Png);
                    return;
                }

                Rectangle targetBounds = new Rectangle(targetLeft, targetTop, targetWidth, targetHeight);
                using (Bitmap aligned = AlignVisibleBounds(resized, targetBounds))
                {
                    NormalizeAlpha(aligned, alphaClearThreshold, alphaOpaqueThreshold);
                    RemoveSmallIslands(aligned, minimumIslandPixels);
                    if (whiteMask) ConvertExistingAlphaToWhiteMask(aligned);
                    aligned.Save(destinationPath, ImageFormat.Png);
                }
            }
        }

        public static void ComposeCircularStatePatch(
            string basePath,
            string patchPath,
            string destinationPath,
            int centerX,
            int centerY,
            int radius)
        {
            if (radius <= 0) throw new ArgumentException("Patch radius must be positive.", "radius");
            using (Bitmap output = new Bitmap(basePath))
            using (Bitmap patch = new Bitmap(patchPath))
            {
                if (output.Width != patch.Width || output.Height != patch.Height)
                {
                    throw new ArgumentException("Base and patch images must have matching dimensions.");
                }
                if (centerX - radius < 0 || centerY - radius < 0 ||
                    centerX + radius >= output.Width || centerY + radius >= output.Height)
                {
                    throw new ArgumentException("Circular patch must remain inside the image bounds.");
                }

                int radiusSquared = radius * radius;
                for (int y = centerY - radius; y <= centerY + radius; y++)
                {
                    for (int x = centerX - radius; x <= centerX + radius; x++)
                    {
                        int deltaX = x - centerX;
                        int deltaY = y - centerY;
                        if (deltaX * deltaX + deltaY * deltaY > radiusSquared) continue;
                        output.SetPixel(x, y, patch.GetPixel(x, y));
                    }
                }
                output.Save(destinationPath, ImageFormat.Png);
            }
        }

        private static Bitmap LoadArgb(string path)
        {
            using (Bitmap source = new Bitmap(path))
            {
                Bitmap result = new Bitmap(source.Width, source.Height, PixelFormat.Format32bppArgb);
                using (Graphics graphics = Graphics.FromImage(result))
                {
                    graphics.CompositingMode = CompositingMode.SourceCopy;
                    graphics.DrawImageUnscaled(source, 0, 0);
                }
                return result;
            }
        }

        private static Bitmap Resize(Bitmap source, int width, int height)
        {
            Bitmap result = new Bitmap(width, height, PixelFormat.Format32bppArgb);
            using (Graphics graphics = Graphics.FromImage(result))
            {
                graphics.CompositingMode = CompositingMode.SourceCopy;
                graphics.CompositingQuality = CompositingQuality.HighQuality;
                graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                graphics.DrawImage(source, 0, 0, width, height);
            }
            return result;
        }

        private static Bitmap AlignVisibleBounds(Bitmap source, Rectangle targetBounds)
        {
            Rectangle sourceBounds = VisibleBounds(source);
            Bitmap result = new Bitmap(source.Width, source.Height, PixelFormat.Format32bppArgb);
            using (Graphics graphics = Graphics.FromImage(result))
            {
                graphics.CompositingMode = CompositingMode.SourceCopy;
                graphics.CompositingQuality = CompositingQuality.HighQuality;
                graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                graphics.DrawImage(source, targetBounds, sourceBounds, GraphicsUnit.Pixel);
            }
            return result;
        }

        private static Rectangle VisibleBounds(Bitmap bitmap)
        {
            Rectangle bounds = Rectangle.Empty;
            WithPixels(bitmap, delegate(byte[] pixels, int stride)
            {
                int left = bitmap.Width;
                int top = bitmap.Height;
                int right = -1;
                int bottom = -1;
                for (int y = 0; y < bitmap.Height; y++)
                {
                    for (int x = 0; x < bitmap.Width; x++)
                    {
                        if (pixels[y * stride + x * 4 + 3] == 0) continue;
                        left = Math.Min(left, x);
                        top = Math.Min(top, y);
                        right = Math.Max(right, x);
                        bottom = Math.Max(bottom, y);
                    }
                }
                if (right < left || bottom < top)
                {
                    throw new InvalidOperationException("Asset has no visible pixels.");
                }
                bounds = Rectangle.FromLTRB(left, top, right + 1, bottom + 1);
            });
            return bounds;
        }

        private static void RemoveNeutralMatte(
            Bitmap bitmap,
            byte[] matteValues,
            double clearDistance,
            double opaqueDistance)
        {
            WithPixels(bitmap, delegate(byte[] pixels, int stride)
            {
                for (int y = 0; y < bitmap.Height; y++)
                {
                    for (int x = 0; x < bitmap.Width; x++)
                    {
                        int index = y * stride + x * 4;
                        double blue = pixels[index];
                        double green = pixels[index + 1];
                        double red = pixels[index + 2];
                        double distance = Double.MaxValue;
                        double matte = matteValues[0];
                        foreach (byte candidate in matteValues)
                        {
                            double candidateDistance = Distance(red, green, blue, candidate);
                            if (candidateDistance >= distance) continue;
                            distance = candidateDistance;
                            matte = candidate;
                        }

                        double alpha = Clamp(
                            (distance - clearDistance) / (opaqueDistance - clearDistance),
                            0.0,
                            1.0);
                        if (alpha <= 0.0)
                        {
                            ClearPixel(pixels, index);
                            continue;
                        }

                        if (alpha < 1.0)
                        {
                            blue = Clamp((blue - matte * (1.0 - alpha)) / alpha, 0.0, 255.0);
                            green = Clamp((green - matte * (1.0 - alpha)) / alpha, 0.0, 255.0);
                            red = Clamp((red - matte * (1.0 - alpha)) / alpha, 0.0, 255.0);
                        }
                        pixels[index] = (byte)Math.Round(blue);
                        pixels[index + 1] = (byte)Math.Round(green);
                        pixels[index + 2] = (byte)Math.Round(red);
                        pixels[index + 3] = (byte)Math.Round(alpha * 255.0);
                    }
                }
            });
        }

        private static void ConvertWhiteProofToMask(Bitmap bitmap, int whitePoint, double alphaScale)
        {
            WithPixels(bitmap, delegate(byte[] pixels, int stride)
            {
                for (int y = 0; y < bitmap.Height; y++)
                {
                    for (int x = 0; x < bitmap.Width; x++)
                    {
                        int index = y * stride + x * 4;
                        int minimum = Math.Min(
                            pixels[index],
                            Math.Min(pixels[index + 1], pixels[index + 2]));
                        byte alpha = (byte)Math.Round(Clamp((whitePoint - minimum) * alphaScale, 0.0, 255.0));
                        if (alpha == 0)
                        {
                            ClearPixel(pixels, index);
                            continue;
                        }
                        pixels[index] = 255;
                        pixels[index + 1] = 255;
                        pixels[index + 2] = 255;
                        pixels[index + 3] = alpha;
                    }
                }
            });
        }

        private static void NormalizeAlpha(Bitmap bitmap, int clearThreshold, int opaqueThreshold)
        {
            WithPixels(bitmap, delegate(byte[] pixels, int stride)
            {
                for (int y = 0; y < bitmap.Height; y++)
                {
                    for (int x = 0; x < bitmap.Width; x++)
                    {
                        int index = y * stride + x * 4;
                        int sourceAlpha = pixels[index + 3];
                        int alpha = sourceAlpha <= clearThreshold
                            ? 0
                            : sourceAlpha >= opaqueThreshold
                                ? 255
                                : (sourceAlpha - clearThreshold) * 255 / (opaqueThreshold - clearThreshold);
                        pixels[index + 3] = (byte)alpha;
                        if (alpha == 0) ClearPixel(pixels, index);
                    }
                }
            });
        }

        private static void ClearTransparentColor(Bitmap bitmap)
        {
            WithPixels(bitmap, delegate(byte[] pixels, int stride)
            {
                for (int y = 0; y < bitmap.Height; y++)
                {
                    for (int x = 0; x < bitmap.Width; x++)
                    {
                        int index = y * stride + x * 4;
                        if (pixels[index + 3] == 0) ClearPixel(pixels, index);
                    }
                }
            });
        }

        private static void ConvertExistingAlphaToWhiteMask(Bitmap bitmap)
        {
            WithPixels(bitmap, delegate(byte[] pixels, int stride)
            {
                for (int y = 0; y < bitmap.Height; y++)
                {
                    for (int x = 0; x < bitmap.Width; x++)
                    {
                        int index = y * stride + x * 4;
                        if (pixels[index + 3] == 0)
                        {
                            ClearPixel(pixels, index);
                            continue;
                        }
                        pixels[index] = 255;
                        pixels[index + 1] = 255;
                        pixels[index + 2] = 255;
                    }
                }
            });
        }

        private static void RemoveSmallIslands(Bitmap bitmap, int minimumPixels)
        {
            if (minimumPixels <= 1) return;
            int width = bitmap.Width;
            int height = bitmap.Height;
            WithPixels(bitmap, delegate(byte[] pixels, int stride)
            {
                bool[] visited = new bool[width * height];
                int[] queue = new int[width * height];
                for (int start = 0; start < visited.Length; start++)
                {
                    int startX = start % width;
                    int startY = start / width;
                    if (visited[start] || pixels[startY * stride + startX * 4 + 3] == 0) continue;
                    int head = 0;
                    int tail = 0;
                    queue[tail++] = start;
                    visited[start] = true;
                    while (head < tail)
                    {
                        int current = queue[head++];
                        int x = current % width;
                        int y = current / width;
                        for (int offsetY = -1; offsetY <= 1; offsetY++)
                        {
                            for (int offsetX = -1; offsetX <= 1; offsetX++)
                            {
                                if (offsetX == 0 && offsetY == 0) continue;
                                int nextX = x + offsetX;
                                int nextY = y + offsetY;
                                if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) continue;
                                int next = nextY * width + nextX;
                                if (visited[next] || pixels[nextY * stride + nextX * 4 + 3] == 0) continue;
                                visited[next] = true;
                                queue[tail++] = next;
                            }
                        }
                    }
                    if (tail >= minimumPixels) continue;
                    for (int item = 0; item < tail; item++)
                    {
                        int pixel = queue[item];
                        ClearPixel(pixels, (pixel / width) * stride + (pixel % width) * 4);
                    }
                }
            });
        }

        private static void WithPixels(Bitmap bitmap, Action<byte[], int> transform)
        {
            Rectangle rectangle = new Rectangle(0, 0, bitmap.Width, bitmap.Height);
            BitmapData data = bitmap.LockBits(rectangle, ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
            try
            {
                int stride = Math.Abs(data.Stride);
                byte[] pixels = new byte[stride * bitmap.Height];
                Marshal.Copy(data.Scan0, pixels, 0, pixels.Length);
                transform(pixels, stride);
                Marshal.Copy(pixels, 0, data.Scan0, pixels.Length);
            }
            finally
            {
                bitmap.UnlockBits(data);
            }
        }

        private static void ClearPixel(byte[] pixels, int index)
        {
            pixels[index] = 0;
            pixels[index + 1] = 0;
            pixels[index + 2] = 0;
            pixels[index + 3] = 0;
        }

        private static double Distance(double red, double green, double blue, double matte)
        {
            double redDelta = red - matte;
            double greenDelta = green - matte;
            double blueDelta = blue - matte;
            return Math.Sqrt(redDelta * redDelta + greenDelta * greenDelta + blueDelta * blueDelta);
        }

        private static void ValidateRamp(double minimum, double maximum, string name)
        {
            if (minimum >= maximum)
            {
                throw new ArgumentException(name + " minimum must be less than its maximum.");
            }
        }

        private static double Clamp(double value, double minimum, double maximum)
        {
            return Math.Max(minimum, Math.Min(maximum, value));
        }
    }
}
"@
}

function Convert-MatteProof {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $SourcePath,
        [Parameter(Mandatory)] [string] $DestinationPath,
        [Parameter(Mandatory)] [int] $OutputWidth,
        [Parameter(Mandatory)] [int] $OutputHeight,
        [byte[]] $MatteValues = @(254, 243),
        [double] $MatteClearDistance = 4,
        [double] $MatteOpaqueDistance = 28,
        [int] $AlphaClearThreshold = 20,
        [int] $AlphaOpaqueThreshold = 80,
        [int] $MinimumIslandPixels = 12,
        [int[]] $TargetVisibleBounds
    )

    if (-not (Test-Path -LiteralPath $SourcePath -PathType Leaf)) {
        throw "Source image does not exist: $SourcePath"
    }
    if ($null -ne $TargetVisibleBounds -and $TargetVisibleBounds.Count -ne 4) {
        throw "TargetVisibleBounds must contain left, top, width, and height."
    }

    $destinationDirectory = Split-Path -Parent $DestinationPath
    if (-not (Test-Path -LiteralPath $destinationDirectory -PathType Container)) {
        New-Item -ItemType Directory -Path $destinationDirectory | Out-Null
    }

    $align = $null -ne $TargetVisibleBounds
    $bounds = if ($align) { $TargetVisibleBounds } else { @(0, 0, 0, 0) }
    [ThreeBranches.Art.RasterAssetNormalizer]::NormalizeMatteProof(
        $SourcePath,
        $DestinationPath,
        $OutputWidth,
        $OutputHeight,
        $MatteValues,
        $MatteClearDistance,
        $MatteOpaqueDistance,
        $AlphaClearThreshold,
        $AlphaOpaqueThreshold,
        $MinimumIslandPixels,
        $align,
        $bounds[0],
        $bounds[1],
        $bounds[2],
        $bounds[3]
    )
}

function Convert-WhiteProofToAlphaMask {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $SourcePath,
        [Parameter(Mandatory)] [string] $DestinationPath,
        [Parameter(Mandatory)] [int] $OutputWidth,
        [Parameter(Mandatory)] [int] $OutputHeight,
        [int] $WhitePoint = 253,
        [double] $AlphaScale = 2
    )

    if (-not (Test-Path -LiteralPath $SourcePath -PathType Leaf)) {
        throw "Source image does not exist: $SourcePath"
    }

    $destinationDirectory = Split-Path -Parent $DestinationPath
    if (-not (Test-Path -LiteralPath $destinationDirectory -PathType Container)) {
        New-Item -ItemType Directory -Path $destinationDirectory | Out-Null
    }

    [ThreeBranches.Art.RasterAssetNormalizer]::NormalizeWhiteProofToMask(
        $SourcePath,
        $DestinationPath,
        $OutputWidth,
        $OutputHeight,
        $WhitePoint,
        $AlphaScale
    )
}

function Convert-TransparentProof {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $SourcePath,
        [Parameter(Mandatory)] [string] $DestinationPath,
        [Parameter(Mandatory)] [int] $OutputWidth,
        [Parameter(Mandatory)] [int] $OutputHeight,
        [int] $AlphaClearThreshold = 20,
        [int] $AlphaOpaqueThreshold = 80,
        [int] $MinimumIslandPixels = 12,
        [switch] $WhiteMask,
        [int[]] $TargetVisibleBounds
    )

    if (-not (Test-Path -LiteralPath $SourcePath -PathType Leaf)) {
        throw "Source image does not exist: $SourcePath"
    }
    if ($null -ne $TargetVisibleBounds -and $TargetVisibleBounds.Count -ne 4) {
        throw "TargetVisibleBounds must contain left, top, width, and height."
    }

    $destinationDirectory = Split-Path -Parent $DestinationPath
    if (-not (Test-Path -LiteralPath $destinationDirectory -PathType Container)) {
        New-Item -ItemType Directory -Path $destinationDirectory | Out-Null
    }

    $align = $null -ne $TargetVisibleBounds
    $bounds = if ($align) { $TargetVisibleBounds } else { @(0, 0, 0, 0) }
    [ThreeBranches.Art.RasterAssetNormalizer]::NormalizeTransparentProof(
        $SourcePath,
        $DestinationPath,
        $OutputWidth,
        $OutputHeight,
        $AlphaClearThreshold,
        $AlphaOpaqueThreshold,
        $MinimumIslandPixels,
        $WhiteMask.IsPresent,
        $align,
        $bounds[0],
        $bounds[1],
        $bounds[2],
        $bounds[3]
    )
}

function Merge-CircularStatePatch {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $BasePath,
        [Parameter(Mandatory)] [string] $PatchPath,
        [Parameter(Mandatory)] [string] $DestinationPath,
        [Parameter(Mandatory)] [int] $CenterX,
        [Parameter(Mandatory)] [int] $CenterY,
        [Parameter(Mandatory)] [int] $Radius
    )

    foreach ($sourcePath in @($BasePath, $PatchPath)) {
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
            throw "Source image does not exist: $sourcePath"
        }
    }
    $destinationDirectory = Split-Path -Parent $DestinationPath
    if (-not (Test-Path -LiteralPath $destinationDirectory -PathType Container)) {
        New-Item -ItemType Directory -Path $destinationDirectory | Out-Null
    }

    [ThreeBranches.Art.RasterAssetNormalizer]::ComposeCircularStatePatch(
        $BasePath,
        $PatchPath,
        $DestinationPath,
        $CenterX,
        $CenterY,
        $Radius
    )
}

Export-ModuleMember -Function Convert-MatteProof, Convert-WhiteProofToAlphaMask, Convert-TransparentProof, Merge-CircularStatePatch
