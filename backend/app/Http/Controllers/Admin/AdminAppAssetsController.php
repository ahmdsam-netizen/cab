<?php

namespace App\Http\Controllers\Admin;

use App\Models\CityVehicleFamilyImage;
use App\Models\CityVehicleType;
use App\Models\VehicleFamilyImage;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;
use Illuminate\Validation\Rule;

class AdminAppAssetsController
{
    public function index()
    {
        $families = CityVehicleType::query()->pluck('display_name')
            ->merge(VehicleFamilyImage::query()->where('display_name', '!=', 'customer')->pluck('display_name'))
            ->map(fn ($name) => trim((string) $name))->filter()
            ->unique(fn ($name) => mb_strtolower($name))->sort()->values()
            ->map(fn ($name) => ['key' => mb_strtolower($name), 'display_name' => $name]);

        $customerMarker = VehicleFamilyImage::query()
            ->where('display_name', 'customer')
            ->where('key', 'customer_marker')
            ->first();

        return response()->json([
            'families' => $families,
            'data' => VehicleFamilyImage::query()->where('display_name', '!=', 'customer')->orderBy('display_name')->orderBy('key')->get(),
            'customer_marker' => $customerMarker,
        ]);
    }

    public function customerMarker()
    {
        $marker = VehicleFamilyImage::query()
            ->where('display_name', 'customer')
            ->where('key', 'customer_marker')
            ->first();

        return response()->json([
            'customer_marker' => $marker,
            'customer_marker_url' => $marker?->image_url,
        ]);
    }

    public function store(Request $request)
    {
        $data = $request->validate([
            'display_name' => ['required', 'string', 'max:120'],
            'key' => ['required', Rule::in(['map_marker', 'booking_card', 'customer_marker'])],
            'image' => ['required', 'file', 'mimes:jpeg,png,jpg,gif,svg,webp', 'max:4096'],
        ]);
        $family = mb_strtolower(trim($data['display_name']));
        if ($data['key'] === 'customer_marker') {
            $family = 'customer';
        }
        abort_if($family === '', 422, 'Select a vehicle family.');
        $path = $request->file('image')->store('vehicle_families/global', 'public');
        if (!$path || !Storage::disk('public')->exists($path)) {
            return response()->json(['message' => 'Failed to store image file on server.'], 500);
        }

        $existing = VehicleFamilyImage::query()->where('display_name', $family)->where('key', $data['key'])->first();
        $oldPath = $existing?->image_path;
        try {
            $image = VehicleFamilyImage::query()->updateOrCreate(
                ['display_name' => $family, 'key' => $data['key']], ['image_path' => $path],
            );
        } catch (\Throwable $error) {
            Storage::disk('public')->delete($path);
            throw $error;
        }
        $this->deleteUnusedFile($oldPath);
        return response()->json(['image' => $image, 'message' => 'Image saved for all cities and apps.'], $existing ? 200 : 201);
    }

    public function destroy(VehicleFamilyImage $asset)
    {
        $path = $asset->image_path;
        $asset->delete();
        $this->deleteUnusedFile($path);
        return response()->json(['message' => 'Image deleted for all cities and apps.']);
    }

    private function deleteUnusedFile(?string $path): void
    {
        // Migrated uploads still belong to legacy rows; never break their files.
        if ($path && !VehicleFamilyImage::query()->where('image_path', $path)->exists()
            && !CityVehicleFamilyImage::query()->where('image_path', $path)->exists()) {
            Storage::disk('public')->delete($path);
        }
    }
}
