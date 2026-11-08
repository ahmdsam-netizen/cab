<?php

namespace App\Support;

class ServiceTileArtwork
{
    public static function version(string $path): string
    {
        return hash('sha256', 'service-tile-v1:' . $path);
    }

    /**
     * Create a tile-sized PNG by removing a flat backdrop connected to the
     * edges. Return null when the original is the better image to display.
     */
    public static function cutout(string $bytes): ?string
    {
        if (!function_exists('imagecreatefromstring')) {
            return null;
        }

        $size = @getimagesizefromstring($bytes);
        if (!$size || $size[0] < 3 || $size[1] < 3 || $size[0] * $size[1] > 8_000_000
            || !in_array($size[2], [IMAGETYPE_JPEG, IMAGETYPE_PNG, IMAGETYPE_WEBP], true)) {
            return null;
        }

        $scale = min(1, 352 / max($size[0], $size[1]));
        $width = (int) round($size[0] * $scale);
        $height = (int) round($size[1] * $scale);
        if ($width < 3 || $height < 3) {
            return null;
        }

        $source = @imagecreatefromstring($bytes);
        if (!$source) {
            return null;
        }
        $image = imagecreatetruecolor($width, $height);
        imagealphablending($image, false);
        imagesavealpha($image, true);
        imagecopyresampled($image, $source, 0, 0, 0, 0, $width, $height, $size[0], $size[1]);
        unset($source);

        $background = imagecolorat($image, 0, 0);
        $edge = [];
        for ($x = 0; $x < $width; $x++) {
            $edge[] = $x;
            $edge[] = ($height - 1) * $width + $x;
        }
        for ($y = 1; $y < $height - 1; $y++) {
            $edge[] = $y * $width;
            $edge[] = $y * $width + $width - 1;
        }

        $matching = [];
        foreach ($edge as $offset) {
            $color = imagecolorat($image, $offset % $width, intdiv($offset, $width));
            if ($color >> 24) {
                return null; // The original already has transparency at the edge.
            }
            if (self::matches($color, $background, 14)) {
                $matching[] = $offset;
            }
        }
        if (count($matching) < count($edge) * 0.95) {
            return null;
        }

        if ($size[2] !== IMAGETYPE_JPEG) {
            for ($y = 1; $y < $height - 1; $y++) {
                for ($x = 1; $x < $width - 1; $x++) {
                    if (imagecolorat($image, $x, $y) >> 24) {
                        return null;
                    }
                }
            }
        }

        $queue = new \SplQueue();
        $clear = 0x7f000000;
        $enqueue = static function (int $x, int $y) use ($queue, $image, $background, $clear): void {
            if (self::matches(imagecolorat($image, $x, $y), $background, 20)) {
                imagesetpixel($image, $x, $y, $clear);
                $queue->enqueue([$x, $y]);
            }
        };
        foreach ($matching as $offset) {
            $enqueue($offset % $width, intdiv($offset, $width));
        }
        $removed = 0;
        while (!$queue->isEmpty()) {
            [$x, $y] = $queue->dequeue();
            $removed++;
            if ($x > 0) $enqueue($x - 1, $y);
            if ($x + 1 < $width) $enqueue($x + 1, $y);
            if ($y > 0) $enqueue($x, $y - 1);
            if ($y + 1 < $height) $enqueue($x, $y + 1);
        }
        $fraction = $removed / ($width * $height);
        if ($fraction < 0.08 || $fraction > 0.98) {
            return null;
        }

        ob_start();
        try {
            return imagepng($image) ? ob_get_contents() : null;
        } finally {
            ob_end_clean();
        }
    }

    private static function matches(int $color, int $background, int $tolerance): bool
    {
        return ($color >> 24) === 0
            && abs((($color >> 16) & 255) - (($background >> 16) & 255)) <= $tolerance
            && abs((($color >> 8) & 255) - (($background >> 8) & 255)) <= $tolerance
            && abs(($color & 255) - ($background & 255)) <= $tolerance;
    }
}
