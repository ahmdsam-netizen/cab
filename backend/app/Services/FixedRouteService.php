<?php

namespace App\Services;

use App\Exceptions\ReservationException;
use App\Models\City;
use App\Models\CityVehicleType;
use App\Models\FixedSeatHold;
use App\Models\Route;
use App\Models\RouteDeparture;
use App\Models\SeatReservation;
use App\Models\RouteStop;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;

class FixedRouteService
{
    public function __construct(
        private readonly FixedAvailabilityService $availability,
        private readonly FixedPricingService $pricing,
        private readonly VehicleFamilyImageService $vehicleImages,
    ) {}

    public function customerRoutes(array|int $filters): Collection
    {
        if (is_int($filters)) {
            $filters = ['city_id' => $filters];
        }

        $limit = min(100, max(1, (int) ($filters['limit'] ?? 60)));
        $userLat = isset($filters['lat']) && is_numeric($filters['lat']) ? (float) $filters['lat'] : null;
        $userLng = isset($filters['lng']) && is_numeric($filters['lng']) ? (float) $filters['lng'] : null;

        $query = Route::query()
            ->with(['stops', 'cityVehicleType'])
            ->where('mode', 'fixed')
            ->where('is_active', true)
            ->where(function ($q) {
                $q->whereNull('city_vehicle_type_id')
                    ->orWhereHas('cityVehicleType', fn ($cvt) => $cvt->where('is_active', true));
            })
            ->when(isset($filters['scope']), fn ($q) => $q->where('scope', $filters['scope']))
            ->when(isset($filters['city_id']), function ($q) use ($filters) {
                $cityId = (int) $filters['city_id'];
                $cityName = City::where('id', $cityId)->value('name');

                $q->where(function ($inner) use ($cityId, $cityName) {
                    $inner->where('city_id', $cityId)
                        ->orWhere('origin_city_id', $cityId)
                        ->orWhere('dest_city_id', $cityId);

                    if ($cityName) {
                        $term = '%' . str_replace(['%', '_'], ['\\%', '\\_'], trim($cityName)) . '%';
                        $inner->orWhere('name', 'like', $term)
                            ->orWhere('origin_name', 'like', $term)
                            ->orWhere('dest_name', 'like', $term)
                            ->orWhereHas('stops', fn ($stop) => $stop->where('name', 'like', $term));
                    }
                });
            })
            ->when(isset($filters['origin_city_id']), fn ($q) => $q->where('origin_city_id', (int) $filters['origin_city_id']))
            ->when(isset($filters['dest_city_id']), fn ($q) => $q->where('dest_city_id', (int) $filters['dest_city_id']))
            ->when(!empty($filters['q']), function ($q) use ($filters) {
                $term = '%' . str_replace(['%', '_'], ['\\%', '\\_'], trim((string) $filters['q'])) . '%';
                $mode = $filters['search_by'] ?? 'all';
                $q->where(function ($inner) use ($term, $mode) {
                    if ($mode === 'destination') {
                        $inner->where('dest_name', 'like', $term);
                    } elseif ($mode === 'origin') {
                        $inner->where('origin_name', 'like', $term);
                    } elseif ($mode === 'stop') {
                        $inner->whereHas('stops', fn ($stop) => $stop->where('name', 'like', $term));
                    } else {
                        $inner->where('name', 'like', $term)
                            ->orWhere('origin_name', 'like', $term)
                            ->orWhere('dest_name', 'like', $term)
                            ->orWhereHas('stops', fn ($stop) => $stop->where('name', 'like', $term));
                    }
                });
            })
            ->orderBy('sort_order')
            ->orderBy('id');

        // With coordinates, rank all matches before selecting the closest results.
        if ($userLat === null || $userLng === null) {
            $query->limit($limit);
        }

        $routes = $query->get();
        $images = $this->vehicleImages->preloadForPlatform();
        $mapped = $routes->map(fn (Route $route) => $this->shapeCustomerRoute($route, $userLat, $userLng, $images));

        if ($userLat !== null && $userLng !== null) {
            $mapped = $mapped->sortBy(function ($r) {
                return $r['distance_to_start'] ?? PHP_INT_MAX;
            })->values();
        }

        return $mapped->take($limit)->values();
    }

    public function adminRoutes(City $city): Collection
    {
        return Route::query()
            ->with('stops')
            ->where('city_id', $city->id)
            ->where('mode', 'fixed')
            ->orderBy('sort_order')
            ->orderBy('id')
            ->get()
            ->map(fn (Route $route) => $this->shapeAdminRoute($route));
    }

    public function createAdminRoute(City $city, array $data): Route
    {
        $this->assertStopPlanIsValid($data['stops'] ?? []);

        return DB::transaction(function () use ($city, $data) {
            $route = Route::query()->create($this->routeAttributes($city, $data));
            $this->syncStops($route, $data['stops'] ?? []);

            return $route->fresh(['stops']);
        });
    }

    /**
     * Create a route from a bulk My Maps import: only what the map holds (name +
     * line + endpoints), attached to the given vehicle. No stops, no price, and
     * inactive — it shows in that vehicle's ungrouped list as "Needs pricing"
     * until an admin opens it, adds a fare (and stops), and saves.
     */
    public function createBulkRoute(City $city, int $cityVehicleTypeId, array $draft): Route
    {
        $attrs = $this->routeAttributes($city, [
            'scope' => 'local',
            'name' => $draft['name'] ?? 'Imported route',
            'origin_name' => $draft['origin_name'] ?: 'Start',
            'dest_name' => $draft['dest_name'] ?: 'End',
            'origin_lat' => $draft['origin_lat'],
            'origin_lng' => $draft['origin_lng'],
            'dest_lat' => $draft['dest_lat'],
            'dest_lng' => $draft['dest_lng'],
            'path_polyline' => $draft['path'] ?? null,
            'city_vehicle_type_id' => $cityVehicleTypeId,
            'fare_config' => [],   // no price yet → "Needs pricing"
            'is_active' => false,  // not bookable until priced
        ]);

        // No route_stops — stops aren't in the map; added when the admin finishes.
        return Route::query()->create($attrs);
    }

    public function copyAdminRoute(City $city, Route $route, string $name, bool $reverse): Route
    {
        $this->availability->assertCityOwnsRoute($city, $route);

        return DB::transaction(function () use ($city, $route, $name, $reverse) {
            $source = Route::query()->whereKey($route->id)->lockForUpdate()->firstOrFail();
            $this->availability->assertCityOwnsRoute($city, $source);
            $copy = $source->replicate()->unsetRelations();
            $copy->name = $name;
            $copy->is_active = false;
            if ($reverse) {
                foreach ([['origin_name', 'dest_name'], ['origin_lat', 'dest_lat'], ['origin_lng', 'dest_lng'], ['origin_city_id', 'dest_city_id']] as [$origin, $destination]) {
                    $copy->$origin = $source->$destination;
                    $copy->$destination = $source->$origin;
                }
                $copy->path_polyline = is_array($source->path_polyline) ? array_reverse($source->path_polyline) : null;
            }
            $copy->save();
            // Removed stops are history for the original route, not part of its current plan.
            $stops = $source->stops()->orderBy('id')->get()->reject(
                fn (RouteStop $stop) => stripos((string) $stop->unavailable_reason, 'removed from active route') !== false
            )->values();
            if ($reverse) $stops = $stops->reverse()->values();
            foreach ($stops as $index => $stop) {
                $newStop = $stop->replicate()->unsetRelations();
                $newStop->route_id = $copy->id;
                $newStop->seq = $index + 1;
                if ($reverse) {
                    $newStop->is_pickup = $stop->is_drop;
                    $newStop->is_drop = $stop->is_pickup;
                }
                $newStop->save();
            }
            // Stands, schedules, departures and bookings remain on the original route.
            return $copy->fresh(['stops']);
        });
    }

    public function updateAdminRoute(City $city, Route $route, array $data): Route
    {
        $this->availability->assertCityOwnsRoute($city, $route);
        $this->assertStopPlanIsValid($data['stops'] ?? []);

        return DB::transaction(function () use ($city, $route, $data) {
            $route->loadMissing('stops');
            $this->assertRouteEditIsSafe($route, $data);
            $route->fill($this->routeAttributes($city, $data))->save();
            $this->syncStops($route, $data['stops'] ?? []);

            return $route->fresh(['stops']);
        });
    }

    public function shapeCustomerRoute(Route $route, ?float $userLat = null, ?float $userLng = null, ?Collection $images = null): array
    {
        $this->availability->assertFixedRoute($route);
        $route->loadMissing('cityVehicleType');
        $family = $route->cityVehicleType?->display_name;
        $image = $this->vehicleImages->resolveForVehicle(
            $route->city_id, $family,
            preloadedImages: $images?->get(mb_strtolower(trim((string) $family)), collect()),
        );

        $stops = [];
        $nearestPickup = null;
        $minPickupDist = INF;
        $hasCoords = $userLat !== null && $userLng !== null;

        if ($route->relationLoaded('stops')) {
            foreach ($route->stops as $stop) {
                $stopLat = (float) $stop->lat;
                $stopLng = (float) $stop->lng;
                $distMeters = null;
                $walkMinutes = null;

                if ($hasCoords && $stopLat != 0.0 && $stopLng != 0.0) {
                    $distMeters = $this->calculateDistanceMeters($userLat, $userLng, $stopLat, $stopLng);
                    $walkMinutes = max(1, (int) round($distMeters / 75.0)); // ~4.5 km/h average walking speed
                }

                $isPickup = (bool) $stop->is_pickup;
                $isActive = (bool) $stop->is_active;
                $isAvailable = !(bool) $stop->is_temporarily_unavailable;

                if ($hasCoords && $isPickup && $isActive && $isAvailable && $distMeters !== null) {
                    if ($distMeters < $minPickupDist) {
                        $minPickupDist = $distMeters;
                        $nearestPickup = [
                            'id' => $stop->id,
                            'name' => $stop->name,
                            'seq' => (int) $stop->seq,
                            'lat' => $stopLat,
                            'lng' => $stopLng,
                            'distance_meters' => $distMeters,
                            'walk_minutes' => $walkMinutes,
                        ];
                    }
                }

                $stops[] = [
                    'id' => $stop->id,
                    'seq' => (int) $stop->seq,
                    'name' => $stop->name,
                    'lat' => $stopLat,
                    'lng' => $stopLng,
                    'is_pickup' => $isPickup,
                    'is_drop' => (bool) $stop->is_drop,
                    'is_active' => $isActive,
                    'is_temporarily_unavailable' => (bool) $stop->is_temporarily_unavailable,
                    'unavailable_reason' => $stop->unavailable_reason,
                    'distance_meters' => $distMeters,
                    'walk_minutes' => $walkMinutes,
                    'is_nearest_pickup' => false,
                ];
            }

            if ($nearestPickup !== null) {
                foreach ($stops as &$s) {
                    if ($s['id'] === $nearestPickup['id']) {
                        $s['is_nearest_pickup'] = true;
                        break;
                    }
                }
                unset($s);
            }
        }

        // The vehicle's starting location stays the first stop in route order,
        // even when a later pickup is closer to the customer.
        $startingStop = collect($stops)->sortBy('seq')->first();

        return [
            'id' => $route->id,
            'city_id' => $route->city_id,
            'origin_city_id' => $route->origin_city_id,
            'dest_city_id' => $route->dest_city_id,
            'city_name' => $route->relationLoaded('city') ? $route->city?->name : null,
            'origin_city_name' => $route->relationLoaded('originCity') ? $route->originCity?->name : null,
            'dest_city_name' => $route->relationLoaded('destCity') ? $route->destCity?->name : null,
            'name' => $route->name,
            'scope' => $route->scope,
            'mode' => $route->mode,
            'origin_name' => $route->origin_name,
            'dest_name' => $route->dest_name,
            'origin_lat' => (float) $route->origin_lat,
            'origin_lng' => (float) $route->origin_lng,
            'dest_lat' => (float) $route->dest_lat,
            'dest_lng' => (float) $route->dest_lng,
            'path_polyline' => is_array($route->path_polyline) ? $route->path_polyline : null,
            'flat_fare' => $this->pricing->routeFare($route),
            'booking_window_hours' => (int) $route->booking_window_hours,
            'waiting_time_per_stop_minutes' => (int) $route->waiting_time_per_stop_minutes,
            'luggage_surcharge_amount' => (float) $route->luggage_surcharge_amount,
            'max_luggage_per_vehicle' => (int) $route->max_luggage_per_vehicle,
            'stops' => $stops,
            'starting_stop' => $startingStop,
            'distance_to_start' => $startingStop['distance_meters'] ?? null,
            'nearest_pickup_stop' => $nearestPickup,
            'distance_to_nearest_pickup' => $nearestPickup ? $nearestPickup['distance_meters'] : null,
            'image_url' => $image['image_url'],
        ];
    }

    public function calculateDistanceMeters(float $lat1, float $lng1, float $lat2, float $lng2): int
    {
        $earthRadius = 6371000;
        $latFrom = deg2rad($lat1);
        $lngFrom = deg2rad($lng1);
        $latTo = deg2rad($lat2);
        $lngTo = deg2rad($lng2);

        $latDelta = $latTo - $latFrom;
        $lngDelta = $lngTo - $lngFrom;

        $angle = 2 * asin(sqrt(pow(sin($latDelta / 2), 2) +
            cos($latFrom) * cos($latTo) * pow(sin($lngDelta / 2), 2)));

        return (int) round($angle * $earthRadius);
    }

    public function shapeAdminRoute(Route $route): array
    {
        $base = $this->shapeCustomerRoute($route);

        $base['city_id'] = $route->city_id;
        $base['origin_city_id'] = $route->origin_city_id;
        $base['dest_city_id'] = $route->dest_city_id;
        $base['city_vehicle_type_id'] = $route->city_vehicle_type_id;
        $base['path_polyline'] = is_array($route->path_polyline) ? $route->path_polyline : null;
        $base['fare_config'] = is_array($route->fare_config) ? $route->fare_config : [];
        $base['is_active'] = (bool) $route->is_active;
        $base['sort_order'] = (int) $route->sort_order;
        $base['luggage_surcharge_amount'] = (float) $route->luggage_surcharge_amount;
        $base['max_luggage_per_vehicle'] = (int) $route->max_luggage_per_vehicle;
        $base['fixed_settings_json'] = is_array($route->fixed_settings_json) ? $route->fixed_settings_json : null;
        $base['created_at'] = optional($route->created_at)->toIso8601String();
        $base['updated_at'] = optional($route->updated_at)->toIso8601String();

        return $base;
    }

    private function routeAttributes(City $city, array $data): array
    {
        $fareConfig = is_array($data['fare_config'] ?? null) ? $data['fare_config'] : [];
        $fixedSettings = $this->fixedSettings($data['fixed_settings_json'] ?? null);

        // Vehicle is now OPTIONAL and allocation-irrelevant — kept only as a
        // convenience prefill for capacity when provided. The route owns its own
        // seats/luggage via explicit input (falling back to the vehicle, then a
        // sensible default, only when input is absent).
        $vehicle = isset($data['city_vehicle_type_id']) && $data['city_vehicle_type_id'] !== null
            ? CityVehicleType::query()->where('city_id', $city->id)->find((int) $data['city_vehicle_type_id'])
            : null;

        $luggage = $data['max_luggage_per_vehicle'] ?? $vehicle?->luggage_capacity ?? 0;

        return [
            'city_id' => $city->id,
            'scope' => $data['scope'],
            'mode' => 'fixed',
            'origin_city_id' => $data['scope'] === 'outstation' ? ($data['origin_city_id'] ?? null) : null,
            'dest_city_id' => $data['scope'] === 'outstation' ? ($data['dest_city_id'] ?? null) : null,
            'name' => trim((string) $data['name']),
            'origin_name' => trim((string) $data['origin_name']),
            'dest_name' => trim((string) $data['dest_name']),
            'origin_lat' => $data['origin_lat'],
            'origin_lng' => $data['origin_lng'],
            'dest_lat' => $data['dest_lat'],
            'dest_lng' => $data['dest_lng'],
            'path_polyline' => $data['path_polyline'] ?? null,
            'corridor_buffer_m' => $data['corridor_buffer_m'] ?? 300,
            'city_vehicle_type_id' => $vehicle?->id,
            'fare_config' => [
                'seat_fare' => isset($fareConfig['seat_fare']) ? (float) $fareConfig['seat_fare'] : null,
                'commission_type' => ($fareConfig['commission_type'] ?? 'percent') === 'fixed' ? 'fixed' : 'percent',
                'commission_percent' => isset($fareConfig['commission_percent']) ? (float) $fareConfig['commission_percent'] : null,
                'fixed_commission' => isset($fareConfig['fixed_commission']) ? (float) $fareConfig['fixed_commission'] : null,
            ],
            'booking_window_hours' => (int) ($data['booking_window_hours'] ?? 6),
            'waiting_time_per_stop_minutes' => (int) ($data['waiting_time_per_stop_minutes'] ?? 0),
            'luggage_surcharge_amount' => (float) ($data['luggage_surcharge_amount'] ?? 0),
            'max_luggage_per_vehicle' => max(0, (int) $luggage),
            'fixed_settings_json' => $fixedSettings,
            'advance_required' => false,
            'board_anywhere' => false,
            'is_active' => (bool) ($data['is_active'] ?? true),
            'sort_order' => (int) ($data['sort_order'] ?? 0),
        ];
    }


    private function fixedSettings(mixed $settings): array
    {
        $settings = is_array($settings) ? $settings : [];
        $boardingConfirmationMode = $settings['boarding_confirmation_mode'] ?? 'driver_only';

        return [
            'auto_no_show_enabled' => true,
            'stop_arrival_radius_m' => max(5, min(1000, (int) ($settings['stop_arrival_radius_m'] ?? 150))),
            'driver_missed_stop_grace_minutes' => max(0, min(180, (int) ($settings['driver_missed_stop_grace_minutes'] ?? 3))),
            'customer_pickup_radius_m' => max(5, min(1000, (int) ($settings['customer_pickup_radius_m'] ?? 150))),
            'vehicle_approaching_alert_radius_m' => max(5, min(5000, (int) ($settings['vehicle_approaching_alert_radius_m'] ?? 500))),
            'customer_grace_minutes' => max(0, min(180, (int) ($settings['customer_grace_minutes'] ?? 2))),
            'boarding_confirmation_mode' => in_array($boardingConfirmationMode, ['driver_only', 'customer_otp', 'driver_customer'], true)
                ? $boardingConfirmationMode
                : 'driver_only',
        ];
    }

    private function syncStops(Route $route, array $stops): void
    {
        $existing = $route->stops()->get()->keyBy('id');
        $keptIds = [];

        foreach (array_values($stops) as $index => $stop) {
            $stopId = isset($stop['id']) ? (int) $stop['id'] : null;
            $attributes = [
                'route_id' => $route->id,
                'seq' => (int) ($stop['seq'] ?? ($index + 1)),
                'name' => trim((string) $stop['name']),
                'lat' => $stop['lat'],
                'lng' => $stop['lng'],
                'is_pickup' => (bool) ($stop['is_pickup'] ?? true),
                'is_drop' => (bool) ($stop['is_drop'] ?? true),
                'is_active' => (bool) ($stop['is_active'] ?? true),
                'is_temporarily_unavailable' => (bool) ($stop['is_temporarily_unavailable'] ?? false),
                'unavailable_reason' => isset($stop['unavailable_reason']) && trim((string) $stop['unavailable_reason']) !== ''
                    ? trim((string) $stop['unavailable_reason'])
                    : null,
            ];

            if ($stopId && $existing->has($stopId)) {
                $existing[$stopId]->update($attributes);
                $keptIds[] = $stopId;
                continue;
            }

            $created = RouteStop::query()->create($attributes);
            $keptIds[] = (int) $created->id;
        }

        $route->stops()
            ->whereNotIn('id', $keptIds ?: [0])
            ->update([
                'is_active' => false,
                'is_temporarily_unavailable' => true,
                'unavailable_reason' => 'Removed from active route by admin.',
            ]);
    }

    private function assertStopPlanIsValid(array $stops): void
    {
        if (count($stops) < 2) {
            throw new ReservationException('Add at least two stops for this fixed route.', 422);
        }

        $seenSeq = [];
        $pickupSeqs = [];
        $dropSeqs = [];

        foreach (array_values($stops) as $index => $stop) {
            $seq = (int) ($stop['seq'] ?? ($index + 1));
            if ($seq < 1) {
                throw new ReservationException('Stop order must start from 1.', 422);
            }
            if (isset($seenSeq[$seq])) {
                throw new ReservationException('Two fixed route stops cannot have the same order number.', 422);
            }
            $seenSeq[$seq] = true;

            if ((bool) ($stop['is_pickup'] ?? true)) {
                $pickupSeqs[] = $seq;
            }
            if ((bool) ($stop['is_drop'] ?? true)) {
                $dropSeqs[] = $seq;
            }
        }

        if (!$pickupSeqs || !$dropSeqs) {
            throw new ReservationException('Fixed route needs at least one pickup stop and one drop stop.', 422);
        }

        if (min($pickupSeqs) >= max($dropSeqs)) {
            throw new ReservationException('At least one drop stop must come after a pickup stop.', 422);
        }
    }

    private function assertRouteEditIsSafe(Route $route, array $data): void
    {
        if (!$this->hasActiveFixedUsage($route)) {
            return;
        }

        // Vehicle no longer participates in allocation, so changing it mid-bookings
        // is harmless — the previous guard against it has been removed.

        foreach (['origin_lat', 'origin_lng', 'dest_lat', 'dest_lng'] as $coordinateField) {
            if (array_key_exists($coordinateField, $data) && round((float) $data[$coordinateField], 6) !== round((float) $route->{$coordinateField}, 6)) {
                throw new ReservationException('This route has active fixed bookings. Origin and destination coordinates cannot be changed right now.', 422);
            }
        }

        $currentStops = $route->stops->sortBy('seq')->values();
        $incomingStops = collect($data['stops'] ?? [])->values();
        $currentIds = $currentStops->pluck('id')->map(fn ($id) => (int) $id)->all();
        $incomingIds = $incomingStops->pluck('id')->filter()->map(fn ($id) => (int) $id)->all();

        if ($currentIds !== $incomingIds) {
            throw new ReservationException('This route has active fixed bookings. Stop additions/removals are blocked until the live vehicle is finished.', 422);
        }

        foreach ($currentStops as $index => $stop) {
            $next = $incomingStops[$index] ?? null;
            if (!$next || (int) ($next['id'] ?? 0) !== (int) $stop->id) {
                throw new ReservationException('This route has active fixed bookings. Stop order cannot be changed right now.', 422);
            }

            $latChanged = round((float) ($next['lat'] ?? 0), 6) !== round((float) $stop->lat, 6);
            $lngChanged = round((float) ($next['lng'] ?? 0), 6) !== round((float) $stop->lng, 6);
            $flagsChanged = (bool) ($next['is_pickup'] ?? false) !== (bool) $stop->is_pickup
                || (bool) ($next['is_drop'] ?? false) !== (bool) $stop->is_drop;

            if ($latChanged || $lngChanged || $flagsChanged) {
                throw new ReservationException('This route has active fixed bookings. Stop coordinates and pickup/drop flags cannot be changed right now.', 422);
            }
        }

        $currentPath = is_array($route->path_polyline) ? $route->path_polyline : [];
        $nextPath = is_array($data['path_polyline'] ?? null) ? $data['path_polyline'] : [];
        if (json_encode($currentPath) !== json_encode($nextPath)) {
            throw new ReservationException('This route has active fixed bookings. Route path cannot be changed until the live vehicle is finished.', 422);
        }
    }

    private function hasActiveFixedUsage(Route $route): bool
    {
        return RouteDeparture::query()
            ->where('route_id', $route->id)
            ->whereNotIn('status', ['COMPLETED', 'CANCELLED'])
            ->where(function ($query) {
                $query->whereHas('seatReservations', fn ($q) => $q->whereIn('status', SeatReservation::ACTIVE_STATUSES))
                    ->orWhereHas('fixedSeatHolds', fn ($q) => $q->where('status', 'HELD')->where('expires_at', '>', now()));
            })
            ->exists()
            || SeatReservation::query()
                ->where('route_id', $route->id)
                ->whereIn('status', SeatReservation::ACTIVE_STATUSES)
                ->exists()
            || FixedSeatHold::query()
                ->whereHas('routeDeparture', fn ($query) => $query->where('route_id', $route->id))
                ->where('status', 'HELD')
                ->where('expires_at', '>', now())
                ->exists();
    }

}
