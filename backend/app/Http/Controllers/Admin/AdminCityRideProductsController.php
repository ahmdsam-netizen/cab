<?php

namespace App\Http\Controllers\Admin;

use App\Models\City;
use App\Models\OperatorSetting;
use App\Models\RideType;
use App\Support\RideCatalog;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;

/**
 * The service catalogue as a two-tier tree: scope (Local / Outstation) → mode
 * (Private / Fixed / Shuttle). The admin Operator Settings screen renders one
 * panel per scope with the three mode switches underneath, and the customer app
 * books in the same two steps.
 *
 * The catalogue lives in `ride_types` — one row per service, carrying a switch
 * for each scope. Settings are GLOBAL: turning Shuttle off under Local turns it
 * off for every city. The routes still take a {city} so existing URLs keep
 * working, but the city no longer scopes the data.
 *
 * The customer product API still applies runtime readiness checks — a Fixed
 * mode needs a matching active route before riders see it. At least one
 * (scope × mode) cell must always stay on, or the booking screen would render
 * nothing.
 */
class AdminCityRideProductsController
{
    /** Catalogue tree for the screen. `city` is accepted but does not scope it. */
    public function index(City $city)
    {
        return response()->json([
            'city_id' => $city->id,
            'is_global' => true,
            'scopes' => RideCatalog::tree(onlyActive: false),
        ]);
    }

    /**
     * Toggle / edit one mode under one scope, e.g. Local → Shuttle. `mode` is
     * the machine key (private|fixed|shuttle), not the display name, so
     * renaming a service never changes which switch this hits.
     */
    public function updateMode(Request $request, City $city, string $scope, string $mode)
    {
        if (!in_array($scope, ['local', 'outstation'], true)) {
            abort(404);
        }

        $data = $request->validate([
            'name' => ['sometimes', 'string', 'max:120'],
            'is_active' => ['nullable', 'boolean'],
            'sort_order' => ['nullable', 'integer', 'min:0', 'max:1000'],
            'image' => ['nullable', 'file', 'image', 'max:4096'],
        ]);

        return DB::transaction(function () use ($request, $scope, $mode, $data) {
            // Serialize every catalogue write so two concurrent deactivations
            // can't both pass the "keep >= 1 bookable option" guard.
            RideType::query()->lockForUpdate()->get();

            $rideType = RideType::query()->get()->first(fn (RideType $rt) => $rt->resolvedMode() === $mode);
            if (!$rideType) {
                abort(404);
            }

            $column = $scope === 'outstation' ? 'is_active_outstation' : 'is_active_local';
            $turningOff = array_key_exists('is_active', $data)
                && !$request->boolean('is_active')
                && $rideType->{$column};

            if ($turningOff && RideCatalog::bookableCount() <= 1) {
                return response()->json([
                    'message' => 'At least one ride option must stay active.',
                ], 422);
            }

            if ($request->hasFile('image')) {
                if ($rideType->image_path && Storage::disk('public')->exists($rideType->image_path)) {
                    Storage::disk('public')->delete($rideType->image_path);
                }
                $rideType->image_path = $request->file('image')->store('city_ride_products', 'public');
            }

            if (array_key_exists('is_active', $data)) {
                $rideType->{$column} = $request->boolean('is_active');
            }
            if (array_key_exists('name', $data)) {
                $rideType->name = $data['name'];
            }
            if (array_key_exists('sort_order', $data)) {
                $rideType->sort_order = $data['sort_order'];
            }

            $rideType->save();

            return response()->json([
                'mode' => RideCatalog::shapeMode($rideType, $scope, (bool) $rideType->{$column}, (int) $rideType->sort_order, OperatorSetting::query()->find(1)),
                'scopes' => RideCatalog::tree(onlyActive: false),
                'message' => 'Ride option updated.',
            ]);
        });
    }

    /**
     * Toggle a scope master switch. A scope has no row of its own now — it is
     * on when any of its modes is on — so switching Local off switches all
     * three Local cells off, in every city, which is what the screen promises.
     */
    public function updateScope(Request $request, City $city, string $scope)
    {
        if (!in_array($scope, ['local', 'outstation'], true)) {
            abort(404);
        }

        $request->validate([
            'name' => ['sometimes', 'string', 'max:120'],
            'is_active' => ['nullable', 'boolean'],
            'sort_order' => ['nullable', 'integer', 'min:0', 'max:1000'],
        ]);

        $target = $request->boolean('is_active');

        return DB::transaction(function () use ($scope, $target) {
            RideType::query()->lockForUpdate()->get();

            $column = $scope === 'outstation' ? 'is_active_outstation' : 'is_active_local';
            $other = $scope === 'outstation' ? 'is_active_local' : 'is_active_outstation';

            // Turning a scope off must not strip the platform of every option.
            if (!$target && RideType::query()->where($other, true)->count() === 0) {
                return response()->json([
                    'message' => 'At least one ride option must stay active.',
                ], 422);
            }

            RideType::query()->update([$column => $target]);

            return response()->json([
                'scopes' => RideCatalog::tree(onlyActive: false),
                'message' => 'Scope updated.',
            ]);
        });
    }
}
