<?php

namespace App\Http\Controllers;

use App\Models\CitySetting;
use App\Models\Driver;
use App\Models\Trip;
use Illuminate\Http\Request;

/**
 * Read-only access to the official support contacts that the admin configures
 * per city (police number, driver/customer support numbers, support email).
 *
 * The customer and driver mobile apps both call this on their "Support" tab.
 * Customers display customer_support_no; drivers display driver_support_no.
 *
 * City resolution order:
 *   1. explicit ?city_id=N
 *   2. the authenticated user's driver.city_id (if they have a driver profile)
 *   3. the customer's most recent trip's city_id (using customer_id)
 * No city or no configured contact returns null; never use another city.
 */
class SupportInfoController extends Controller
{
    public function show(Request $request)
    {
        $request->validate(['city_id' => ['sometimes', 'integer', 'min:1']]);
        $cityId = $request->query('city_id') ? (int) $request->query('city_id') : null;
        $userId = $request->user()?->id;

        if (! $cityId && $userId) {
            $driver = Driver::query()->where('user_id', $userId)->first();
            $cityId = $driver?->city_id;
        }

        if (! $cityId && $userId) {
            $latestTrip = Trip::query()->where('customer_id', $userId)->latest()->first();
            $cityId = $latestTrip?->city_id;
        }

        $settings = $cityId
            ? CitySetting::query()->where('city_id', $cityId)->first()
            : null;

        return response()->json([
            'city_id' => $cityId,
            'emergency_no' => $settings?->emergency_no,
            'emergency_police_no' => $settings?->emergency_police_no,
            'driver_support_no' => $settings?->driver_support_no,
            'customer_support_no' => $settings?->customer_support_no,
            'support_email' => $settings?->support_email,
        ]);
    }
}
