<?php

namespace App\Http\Controllers;

use App\Models\City;
use App\Models\CitySetting;
use App\Models\CityVehicleType;
use App\Models\OperatorSetting;
use App\Models\OutstationPackage;
use App\Models\RideType;
use App\Models\PricingRule;
use App\Models\Route;
use App\Models\VehicleType;
use App\Services\DynamicPricingService;
use App\Services\FareEstimationService;
use App\Services\GatewayFeeService;
use App\Services\VehicleFamilyImageService;
use App\Support\RideCatalog;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class PricingController extends Controller
{
    public function cities(Request $request)
    {
        // boundary_polygon + center are returned so the customer mobile can
        // detect when a destination is outside the service area and steer the
        // user toward the Outstation flow without an extra round-trip.
        // Payment methods are a global operator policy now (Operator Settings →
        // Payments), so every city advertises the same enabled rails.
        $allowedPaymentModes = array_map(
            'strtoupper',
            app(\App\Services\PaymentModeService::class)->operatorModes(),
        );

        $cities = City::query()
            ->where('cities.is_active', true)
            ->orderBy('cities.name')
            ->get([
                'cities.id',
                'cities.name',
                'cities.country_code',
                'cities.center_lat',
                'cities.center_lng',
                'cities.boundary_polygon',
            ])
            ->map(function ($row) use ($allowedPaymentModes) {
                $row->allowed_payment_modes = $allowedPaymentModes;
                return $row;
            });

        return response()->json(['data' => $cities]);
    }

    public function rideTypes(Request $request)
    {
        $rideTypes = RideType::query()
            ->select(['id', 'name', 'description'])
            ->orderBy('sort_order')
            ->get();

        return response()->json(['data' => $rideTypes]);
    }

    /**
     * Public catalogue for a city as a two-step tree: scope (Local / Outstation)
     * → mode (Private / Fixed / Shuttle). The customer app shows the scopes first,
     * then the modes within the chosen one. A scope is only returned if it's switched on and has at least one
     * customer-visible mode. Inactive modes are dropped; active Fixed
     * modes stay route-gated, while Shuttle can appear as quote-preview only.
     *
     * `data` is the flat list of active modes (compat for the current app, which
     * reads scope/mode/kind off a flat list); `scopes` is the grouped tree the
     * two-step picker consumes.
     */
    public function products(City $city, Request $request, VehicleFamilyImageService $imageService)
    {
        $requestedPlatform = $request->header('X-Platform') ?: $request->input('platform');
        $familyImagesMap = $imageService->loadMapForCity($city->id);

        $activeSharedRouteKeys = Route::query()
            ->where('city_id', $city->id)
            ->where('is_active', true)
            ->whereIn('mode', ['fixed', 'shuttle'])
            ->get(['scope', 'mode'])
            ->mapWithKeys(fn (Route $route) => [$route->scope . ':' . $route->mode => true]);

        // The catalogue itself is global (ride_types); only the readiness gate
        // below is per city — a Fixed mode stays hidden until this city has an
        // active fixed route to book. Shuttle is always shown (quote preview).
        $tree = collect(RideCatalog::tree(
            onlyActive: true,
            modeFilter: function (RideType $rt, string $scope) use ($activeSharedRouteKeys) {
                if ($rt->resolvedMode() !== RideType::MODE_FIXED) {
                    return true;
                }

                return $activeSharedRouteKeys->has($scope . ':fixed');
            },
        ))->map(function (array $s) use ($city, $requestedPlatform, $familyImagesMap, $imageService) {
            $modes = collect($s['modes'])->map(function (array $mode) use ($city, $requestedPlatform, $familyImagesMap, $imageService) {
                $name = trim($mode['name'] ?? '');
                $preloaded = $familyImagesMap->get(strtolower($name), collect());
                $imagePayload = $imageService->resolveForVehicle(
                    $city->id,
                    $name,
                    $requestedPlatform,
                    defaultImageUrl: $mode['image_url'] ?? null,
                    preloadedImages: $preloaded
                );

                return [
                    ...$mode,
                    'images' => $imagePayload['images'],
                    'image_url' => $imagePayload['image_url'],
                    'map_marker_url' => $imagePayload['map_marker_url'],
                ];
            })->values();

            return [
                'scope' => $s['scope'],
                'name' => $s['name'],
                'sort_order' => $s['sort_order'],
                'modes' => $modes,
            ];
        });

        // Flat list kept for older clients that haven't moved to the tree yet.
        $flat = $tree->flatMap(fn ($s) => $s['modes'])->values();

        return response()->json([
            'data' => $flat,
            'scopes' => $tree,
        ]);
    }

    public function vehicleTypes(Request $request, VehicleFamilyImageService $imageService)
    {
        $cityId = $request->query('city_id') ? (int) $request->query('city_id') : null;
        $requestedPlatform = $request->header('X-Platform') ?: $request->input('platform');
        $familyImagesMap = $cityId ? $imageService->loadMapForCity($cityId) : null;
        $cityVehicles = $cityId ? CityVehicleType::query()
            ->where('city_id', $cityId)
            ->where('is_active', true)
            ->get()
            ->keyBy('vehicle_type_id') : collect();

        $rows = VehicleType::query()
            ->where('is_active', true)
            ->orderBy('sort_order')
            ->orderBy('id')
            ->get(['id', 'name'])
            ->map(function (VehicleType $vt) use ($cityId, $requestedPlatform, $familyImagesMap, $cityVehicles, $imageService) {
                $cityVehicle = $cityVehicles->get($vt->id);
                $displayName = $cityVehicle?->display_name ? trim($cityVehicle->display_name) : trim($vt->name);
                $preloaded = $familyImagesMap?->get(strtolower($displayName))
                    ?? $familyImagesMap?->get(strtolower(trim($vt->name)))
                    ?? collect();

                $imagePayload = $imageService->resolveForVehicle(
                    $cityId,
                    $displayName,
                    $requestedPlatform,
                    preloadedImages: $preloaded
                );

                return [
                    'id' => $vt->id,
                    'name' => $displayName,
                    'global_type_name' => $vt->name,
                    'images' => $imagePayload['images'],
                    'image_url' => $imagePayload['image_url'],
                    'map_marker_url' => $imagePayload['map_marker_url'],
                ];
            });

        return response()->json(['data' => $rows]);
    }

    /**
     * Outstation fare packages for a specific vehicle — the customer app shows
     * these so the rider can pick One Way / Round Trip / per-destination before
     * booking.
     */
    public function outstationPackages(Request $request)
    {
        $data = $request->validate([
            'city_vehicle_type_id' => ['required', 'integer', 'exists:city_vehicle_types,id'],
        ]);

        $packages = OutstationPackage::query()
            ->where('city_vehicle_type_id', $data['city_vehicle_type_id'])
            ->where('is_active', true)
            ->orderBy('sort_order')
            ->orderBy('id')
            ->get(['id', 'name']);

        return response()->json(['data' => $packages]);
    }

    public function estimate(
        Request $request,
        FareEstimationService $fareEstimationService,
        DynamicPricingService $dynamicPricingService,
        GatewayFeeService $gatewayFees,
    ) {
        $data = $request->validate([
            // Primary axis: the exact per-city vehicle the customer picked.
            // Either send it directly, or send the legacy (vehicle_type_id |
            // ride_type_id) combo and the server resolves to a row.
            'city_vehicle_type_id' => ['nullable', 'integer', 'exists:city_vehicle_types,id'],
            'city_id' => ['required_without:city_vehicle_type_id', 'integer', 'exists:cities,id'],
            'vehicle_type_id' => ['nullable', 'integer', 'exists:vehicle_types,id'],
            'ride_type_id' => ['nullable', 'integer', 'exists:ride_types,id'],
            'pickup_lat' => ['required', 'numeric', 'between:-90,90'],
            'pickup_lng' => ['required', 'numeric', 'between:-180,180'],
            'drop_lat' => ['required', 'numeric', 'between:-90,90'],
            'drop_lng' => ['required', 'numeric', 'between:-180,180'],
            'route_distance_km' => ['nullable', 'numeric', 'min:0', 'max:10000'],
            'route_time_min' => ['nullable', 'numeric', 'min:0', 'max:1440'],
            'outstation_package_id' => ['nullable', 'integer', 'exists:outstation_packages,id'],
            // Toll the client read from Google for this route (₹). Honoured only
            // when the vehicle's toll_mode is 'yes'; absent/blank → no toll.
            'toll_amount' => ['nullable', 'numeric', 'min:0', 'max:100000'],
        ]);

        $cityVehicleTypeId = isset($data['city_vehicle_type_id'])
            ? (int) $data['city_vehicle_type_id']
            : CityVehicleType::resolveId(
                cityId: (int) $data['city_id'],
                rideTypeId: isset($data['ride_type_id']) ? (int) $data['ride_type_id'] : null,
                vehicleTypeId: isset($data['vehicle_type_id']) ? (int) $data['vehicle_type_id'] : null,
            );

        if (!$cityVehicleTypeId) {
            // Intelligent fallback: if the passed city_id has no vehicles configured,
            // check if the pickup coordinates fall inside an active city that does.
            if (isset($data['pickup_lat'], $data['pickup_lng'])) {
                $candidateCities = City::query()
                    ->where('is_active', true)
                    ->whereNotNull('boundary_polygon')
                    ->whereExists(function ($sub) {
                        $sub->select(DB::raw(1))
                            ->from('city_vehicle_types')
                            ->whereColumn('city_vehicle_types.city_id', 'cities.id');
                    })
                    ->get();

                foreach ($candidateCities as $cand) {
                    if ($dynamicPricingService->pointInPolygon((float) $data['pickup_lat'], (float) $data['pickup_lng'], (array) $cand->boundary_polygon)) {
                        $cityVehicleTypeId = CityVehicleType::resolveId(
                            cityId: $cand->id,
                            rideTypeId: isset($data['ride_type_id']) ? (int) $data['ride_type_id'] : null,
                            vehicleTypeId: isset($data['vehicle_type_id']) ? (int) $data['vehicle_type_id'] : null,
                        );
                        if ($cityVehicleTypeId) {
                            $data['city_id'] = $cand->id;
                            break;
                        }
                    }
                }
            }
        }

        if (!$cityVehicleTypeId) {
            return response()->json(['message' => 'No matching vehicle for this booking.'], 404);
        }

        // Toll is gated by the city setting. We never invent a number — it's
        // whatever Google gave the client, or 0.
        $cvt = CityVehicleType::query()->find($cityVehicleTypeId);
        $citySettings = $cvt ? CitySetting::query()->firstOrCreate(['city_id' => $cvt->city_id]) : null;
        $tollCharge = ($citySettings && $citySettings->toll_mode === 'yes')
            ? (float) ($data['toll_amount'] ?? 0)
            : 0.0;

        $pricingRule = PricingRule::resolveFor($cityVehicleTypeId);
        if (!$pricingRule) {
            return response()->json(['message' => 'Pricing rule not set for this vehicle.'], 404);
        }

        // Surface the destination geofence early — when the operator enabled the
        // check, refuse to quote a fare to a drop-off outside the city boundary.
        if (OperatorSetting::instance()->check_destination_outside_geofence) {
            $city = City::query()->find($pricingRule->city_id);
            if (
                $city
                && !empty($city->boundary_polygon)
                && !$dynamicPricingService->pointInPolygon(
                    (float) $data['drop_lat'],
                    (float) $data['drop_lng'],
                    $city->boundary_polygon,
                )
            ) {
                return response()->json([
                    'message' => 'Destination is outside the service area for ' . $city->name . '.',
                ], 422);
            }
        }

        $dynamicRule = $dynamicPricingService->findApplicable(
            (float) $data['pickup_lat'],
            (float) $data['pickup_lng'],
            $cityVehicleTypeId,
        );

        $dynamicFactors = $dynamicRule ? [
            'customer_factor' => (float) $dynamicRule->customer_fare_factor,
            'driver_factor' => (float) $dynamicRule->driver_fare_factor,
            'rule_id' => $dynamicRule->id,
            'fare_type' => $dynamicRule->fare_type,
            'name' => $dynamicRule->name,
            'region_visible' => $dynamicPricingService->isFareVisibleToRider($dynamicRule),
        ] : null;

        $fareInput = $fareEstimationService->fareInput(
            $pricingRule->toArray(),
            isset($data['outstation_package_id']) ? (int) $data['outstation_package_id'] : null,
        );
        $estimate = $fareEstimationService->estimateFare(
            $fareInput,
            (float) $data['pickup_lat'],
            (float) $data['pickup_lng'],
            (float) $data['drop_lat'],
            (float) $data['drop_lng'],
            $dynamicFactors,
            null,
            isset($data['route_distance_km']) ? (float) $data['route_distance_km'] : null,
            isset($data['route_time_min']) ? (float) $data['route_time_min'] : null,
            $tollCharge,
        );

        $requestedPlatform = $request->header('X-Platform') ?: $request->input('platform');
        $imagePayload = app(VehicleFamilyImageService::class)->resolveForVehicle(
            $cvt->city_id,
            $cvt->display_name,
            $requestedPlatform
        );

        return response()->json([
            'currency' => 'INR',
            ...$estimate,
            'city_vehicle_type_id' => $cvt->id,
            'vehicle_name' => $cvt->display_name,
            'images' => $imagePayload['images'],
            'image_url' => $imagePayload['image_url'],
            'map_marker_url' => $imagePayload['map_marker_url'],
            'gateway_fee' => $gatewayFees->quote((float) ($estimate['estimated_fare'] ?? 0)),
        ]);
    }


    public function shuttleQuote(
        Request $request,
        FareEstimationService $fareEstimationService,
        DynamicPricingService $dynamicPricingService,
        GatewayFeeService $gatewayFees,
    ) {
        $data = $request->validate([
            'city_vehicle_type_id' => ['nullable', 'integer', 'exists:city_vehicle_types,id'],
            'city_id' => ['required_without:city_vehicle_type_id', 'integer', 'exists:cities,id'],
            'vehicle_type_id' => ['nullable', 'integer', 'exists:vehicle_types,id'],
            'scope' => ['nullable', 'in:local,outstation'],
            'pickup_lat' => ['required', 'numeric', 'between:-90,90'],
            'pickup_lng' => ['required', 'numeric', 'between:-180,180'],
            'drop_lat' => ['required', 'numeric', 'between:-90,90'],
            'drop_lng' => ['required', 'numeric', 'between:-180,180'],
            'route_distance_km' => ['nullable', 'numeric', 'min:0', 'max:10000'],
            'route_time_min' => ['nullable', 'numeric', 'min:0', 'max:1440'],
            'toll_amount' => ['nullable', 'numeric', 'min:0', 'max:100000'],
        ]);

        $query = CityVehicleType::query()
            ->with(['rideType:id,name', 'vehicleType:id,name'])
            ->where('is_active', true)
            ->whereHas('rideType', fn ($q) => $q->where('mode', RideType::MODE_SHUTTLE)->orWhere('name', 'like', '%shuttle%'));

        if (isset($data['city_vehicle_type_id'])) {
            $query->where('id', (int) $data['city_vehicle_type_id']);
        } else {
            $query->where('city_id', (int) $data['city_id']);
            if (isset($data['vehicle_type_id'])) {
                $query->where('vehicle_type_id', (int) $data['vehicle_type_id']);
            }
        }

        $cvt = $query->orderBy('display_order')->orderBy('id')->first();
        if (!$cvt) {
            return response()->json([
                'available' => false,
                'message' => 'Shuttle is not available for this vehicle in this city yet.',
            ], 404);
        }

        $pricingRule = PricingRule::resolveFor((int) $cvt->id);
        if (!$pricingRule) {
            return response()->json([
                'available' => false,
                'message' => 'Shuttle fare is not configured for this vehicle yet.',
                'city_vehicle_type_id' => $cvt->id,
            ], 404);
        }

        if (OperatorSetting::instance()->check_destination_outside_geofence) {
            $city = City::query()->find($pricingRule->city_id);
            if (
                $city
                && !empty($city->boundary_polygon)
                && !$dynamicPricingService->pointInPolygon(
                    (float) $data['drop_lat'],
                    (float) $data['drop_lng'],
                    $city->boundary_polygon,
                )
            ) {
                return response()->json([
                    'available' => false,
                    'message' => 'Destination is outside the service area for ' . $city->name . '.',
                ], 422);
            }
        }

        $dynamicRule = $dynamicPricingService->findApplicable(
            (float) $data['pickup_lat'],
            (float) $data['pickup_lng'],
            (int) $cvt->id,
        );

        $dynamicFactors = $dynamicRule ? [
            'customer_factor' => (float) $dynamicRule->customer_fare_factor,
            'driver_factor' => (float) $dynamicRule->driver_fare_factor,
            'rule_id' => $dynamicRule->id,
            'fare_type' => $dynamicRule->fare_type,
            'name' => $dynamicRule->name,
            'region_visible' => $dynamicPricingService->isFareVisibleToRider($dynamicRule),
        ] : null;

        $citySettings = CitySetting::query()->firstOrCreate(['city_id' => $cvt->city_id]);
        $tollCharge = $citySettings->toll_mode === 'yes'
            ? (float) ($data['toll_amount'] ?? 0)
            : 0.0;

        $estimate = $fareEstimationService->estimateFare(
            $pricingRule->toArray(),
            (float) $data['pickup_lat'],
            (float) $data['pickup_lng'],
            (float) $data['drop_lat'],
            (float) $data['drop_lng'],
            $dynamicFactors,
            null,
            isset($data['route_distance_km']) ? (float) $data['route_distance_km'] : null,
            isset($data['route_time_min']) ? (float) $data['route_time_min'] : null,
            $tollCharge,
        );

        $requestedPlatform = $request->header('X-Platform') ?: $request->input('platform');
        $imagePayload = app(VehicleFamilyImageService::class)->resolveForVehicle(
            $cvt->city_id,
            $cvt->display_name,
            $requestedPlatform
        );

        return response()->json([
            'available' => true,
            'booking_enabled' => false,
            'mode' => 'shuttle',
            'currency' => 'INR',
            'city_vehicle_type_id' => $cvt->id,
            'vehicle_type_id' => $cvt->vehicle_type_id,
            'vehicle_name' => $cvt->display_name,
            'vehicle_type_name' => $cvt->vehicleType?->name,
            'images' => $imagePayload['images'],
            'image_url' => $imagePayload['image_url'],
            'map_marker_url' => $imagePayload['map_marker_url'],
            ...$estimate,
            'gateway_fee' => $gatewayFees->quote((float) ($estimate['estimated_fare'] ?? 0)),
        ]);
    }

    /**
     * Per-seat fare quote for a shared (fixed/shuttle) route. The price is flat
     * from the route's fare_config — no metered distance/time — but still runs
     * through the shared tail (tax, commission) so it matches the rest of the
     * platform.
     */
    public function seatEstimate(
        Request $request,
        FareEstimationService $fareEstimationService,
        GatewayFeeService $gatewayFees,
    ) {
        $data = $request->validate([
            'route_id' => ['required', 'integer', 'exists:routes,id'],
            'seats' => ['nullable', 'integer', 'min:1', 'max:10'],
        ]);

        $route = Route::query()->find((int) $data['route_id']);
        if (!$route || !$route->is_active) {
            return response()->json(['message' => 'Route not available.'], 404);
        }

        $fareConfig = is_array($route->fare_config) ? $route->fare_config : [];
        if (!isset($fareConfig['seat_fare']) || (float) $fareConfig['seat_fare'] <= 0) {
            return response()->json(['message' => 'Seat fare is not configured for this route.'], 404);
        }

        $seats = isset($data['seats']) ? (int) $data['seats'] : 1;

        $estimate = $fareEstimationService->seatFare($fareConfig, $seats);

        return response()->json([
            'currency' => 'INR',
            'route_id' => $route->id,
            'mode' => $route->mode,
            ...$estimate,
            'gateway_fee' => $gatewayFees->quote((float) ($estimate['estimated_fare'] ?? 0)),
        ]);
    }
}

