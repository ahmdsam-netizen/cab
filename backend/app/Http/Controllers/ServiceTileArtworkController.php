<?php

namespace App\Http\Controllers;

use App\Models\OperatorSetting;
use App\Models\RideType;
use App\Support\ServiceTileArtwork;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Storage;

class ServiceTileArtworkController extends Controller
{
    public function __invoke(RideType $rideType, string $version)
    {
        $mode = $rideType->resolvedMode();
        $path = OperatorSetting::find(1)?->getAttribute($mode . '_service_image_path') ?: $rideType->image_path;
        abort_unless($path && hash_equals(ServiceTileArtwork::version($path), $version), 404);

        $disk = Storage::disk('public');
        abort_unless($disk->exists($path), 404);

        $encoded = Cache::remember('service-tile:' . $version, now()->addDays(7), static function () use ($disk, $path) {
            $source = $disk->size($path) <= 4 * 1024 * 1024 ? $disk->get($path) : null;
            $png = $source ? ServiceTileArtwork::cutout($source) : null;

            // Cache the original-image decision too, so photos aren't decoded on every visit.
            // The database cache stores text, so encode the binary PNG.
            return $png !== null ? base64_encode($png) : false;
        });

        if ($encoded === false) {
            return $disk->response($path, headers: [
                'Cache-Control' => 'public, max-age=3600',
                'Content-Security-Policy' => 'sandbox',
                'X-Content-Type-Options' => 'nosniff',
            ]);
        }

        return response(base64_decode($encoded), 200, [
            'Content-Type' => 'image/png',
            'Cache-Control' => 'public, max-age=86400',
            'X-Content-Type-Options' => 'nosniff',
        ]);
    }
}
