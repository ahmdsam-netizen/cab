<?php

namespace App\Http\Controllers;

use App\Events\FixedRouteCatalogUpdated;
use App\Models\Driver;
use App\Models\DriverLocation;
use App\Models\FixedSeatHold;
use App\Models\RideType;
use App\Models\Route;
use App\Models\RouteDeparture;
use App\Models\RouteStop;
use App\Models\SeatReservation;
use App\Models\Trip;
use App\Models\VehicleSeatLayout;
use App\Services\DriverRouteAccessService;
use App\Services\DriverServiceModeService;
use App\Services\CommissionSettlementService;
use App\Services\FixedAvailabilityService;
use App\Services\FixedBoardingOtpService;
use App\Services\FixedBookingEventService;
use App\Services\FixedDepartureService;
use App\Services\FixedManifestService;
use App\Services\FixedNoShowPolicy;
use App\Services\NotificationCenter;
use App\Services\FixedRouteService;
use App\Services\FixedRefundService;
use App\Services\FixedBookingService;
use App\Services\FixedSeatHoldService;
use App\Services\SeatMapService;
use App\Services\FixedDepartureVehicleService;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

class FixedDriverController extends Controller
{
    public function __construct(
        private readonly FixedManifestService $manifest,
        private readonly FixedAvailabilityService $availability,
        private readonly FixedDepartureService $departures,
        private readonly FixedRouteService $routes,
        private readonly FixedRefundService $refunds,
        private readonly FixedBookingEventService $events,
        private readonly DriverServiceModeService $serviceModes,
        private readonly NotificationCenter $notifier,
        private readonly CommissionSettlementService $settlements,
        private readonly FixedBoardingOtpService $boardingOtp,
        private readonly DriverRouteAccessService $routeAccess,
        private readonly SeatMapService $seatMap,
        private readonly FixedSeatHoldService $seatHolds,
        private readonly FixedBookingService $bookings,
    ) {}

    public function routes(Request $request)
    {
        $driver = $this->driverProfile($request);
        if ($driver->active_service_mode !== Driver::SERVICE_MODE_FIXED) {
            abort(422, 'Go online with your registered fixed service before choosing a fixed route.');
        }

        $cityIds = $driver->city_ids;
        if (empty($cityIds)) {
            abort(422, 'Your registered city is required before choosing a fixed route.');
        }

        $scope = $driver->active_service_scope ?: $driver->service_scope ?: Driver::SERVICE_SCOPE_LOCAL;

        // Route allocation is driven by the driver's assigned route groups
        // (DriverRouteAccessService) — NOT their vehicle. The driver sees the
        // fixed routes their groups grant, across all their registered cities.
        $allowedRouteIds = $this->routeAccess->effectiveRouteIds((int) $request->user()->id);
        if (empty($allowedRouteIds)) {
            return response()->json([
                'data' => [],
                'driver_cities' => [],
                'driver_scope' => $scope,
            ]);
        }

        $routesQuery = Route::query()
            ->with(['stops', 'city:id,name', 'originCity:id,name', 'destCity:id,name'])
            ->whereIn('id', $allowedRouteIds)
            ->where('mode', 'fixed')
            ->where('is_active', true)
            ->where(function ($q) use ($cityIds) {
                $q->whereIn('city_id', $cityIds)
                    ->orWhereIn('origin_city_id', $cityIds)
                    ->orWhereIn('dest_city_id', $cityIds);
            });

        $scopeFilter = $request->query('scope');
        if ($scope === Driver::SERVICE_SCOPE_BOTH) {
            if ($scopeFilter && in_array($scopeFilter, [Driver::SERVICE_SCOPE_LOCAL, Driver::SERVICE_SCOPE_OUTSTATION], true)) {
                $routesQuery->where('scope', $scopeFilter);
            } else {
                $routesQuery->whereIn('scope', [Driver::SERVICE_SCOPE_LOCAL, Driver::SERVICE_SCOPE_OUTSTATION]);
            }
        } else {
            $routesQuery->where('scope', $scope);
        }

        // If query specifies a specific city filter:
        if ($request->has('city_id') && is_numeric($request->query('city_id'))) {
            $cId = (int) $request->query('city_id');
            $routesQuery->where(function ($q) use ($cId) {
                $q->where('city_id', $cId)
                    ->orWhere('origin_city_id', $cId)
                    ->orWhere('dest_city_id', $cId);
            });
        }

        $routes = $routesQuery
            ->orderBy('sort_order')
            ->orderBy('id')
            ->get();

        // Get driver's assigned operating cities details:
        $assignedCities = \App\Models\City::whereIn('id', $cityIds)
            ->select('id', 'name')
            ->orderBy('name')
            ->get();

        return response()->json([
            'data' => $routes->map(fn (Route $route) => $this->routes->shapeCustomerRoute($route))->values(),
            'driver_cities' => $assignedCities,
            'driver_scope' => $scope,
        ]);
    }

    public function vehicles(Request $request)
    {
        $rows = RouteDeparture::query()
            ->with(['route:id,city_id,name,scope,mode,origin_name,dest_name', 'driver:id,name'])
            ->where('driver_id', $request->user()->id)
            ->whereHas('route', fn ($q) => $q->where('mode', 'fixed'))
            ->whereNotIn('status', ['COMPLETED', 'CANCELLED'])
            ->orderByRaw("CASE status WHEN 'FORMING' THEN 0 WHEN 'DISPATCHED' THEN 1 WHEN 'DEPARTED' THEN 2 ELSE 3 END")
            ->orderByDesc('id')
            ->limit(20)
            ->get()
            ->map(fn (RouteDeparture $departure) => $this->departures->shapeAdminDeparture($departure));

        return response()->json(['data' => $rows]);
    }

    /**
     * Only layouts matching the driver's vehicle in the route's city are offered.
     */
    public function layouts(Request $request, Route $route)
    {
        $this->availability->assertFixedRoute($route);
        if (!$this->routeAccess->canAccessRoute((int) $request->user()->id, (int) $route->id)) {
            abort(403, 'This fixed route is not assigned to you.');
        }

        $vehicleTypeId = $this->effectiveLayoutVehicleTypeId($route, $this->driverProfile($request));

        $layouts = VehicleSeatLayout::query()
            ->where('city_id', $route->city_id)
            ->where('is_active', true)
            ->where('vehicle_type_id', $vehicleTypeId)
            ->whereHas('cells', fn ($q) => $q->where('kind', 'seat'))
            ->withCount(['cells as seat_count' => fn ($q) => $q->where('kind', 'seat')])
            ->orderBy('name')
            ->get(['id', 'name', 'rows', 'cols'])
            ->map(fn (VehicleSeatLayout $l) => [
                'id' => (int) $l->id,
                'name' => $l->name,
                'rows' => (int) $l->rows,
                'cols' => (int) $l->cols,
                'seat_count' => (int) $l->seat_count,
            ])->values();

        return response()->json(['data' => $layouts]);
    }

    /**
     * Validate configured vehicle and layout before returning its category.
     */
    private function effectiveLayoutVehicleTypeId(Route $route, Driver $driver): int
    {
        $prepared = app(FixedDepartureVehicleService::class)->prepare($route, $driver);
        return (int) VehicleSeatLayout::findOrFail($prepared['vehicle_seat_layout_id'])->vehicle_type_id;
    }

    public function open(Request $request)
    {
        $data = $request->validate([
            'route_id' => ['required', 'integer', 'exists:routes,id'],
            'capacity' => ['nullable', 'integer', 'min:1', 'max:60'],
            'vehicle_seat_layout_id' => ['nullable', 'integer', 'exists:vehicle_seat_layouts,id'],
        ]);

        $route = Route::query()->whereKey((int) $data['route_id'])->firstOrFail();
        $this->availability->assertFixedRoute($route);

        // Allocation guard: a driver may only open a route granted by their
        // assigned route groups (not their vehicle). Mirrors routes() — without
        // this, the group filter on the list would be bypassable via direct call.
        if (!$this->routeAccess->canAccessRoute((int) $request->user()->id, (int) $route->id)) {
            abort(403, 'This fixed route is not assigned to you.');
        }

        $driver = $this->driverProfile($request);
        $this->serviceModes->assertFixedMode($driver, $route->scope ?: Driver::SERVICE_SCOPE_LOCAL);

        // Idempotent: if driver already has an active departure, return it directly
        $existing = RouteDeparture::query()
            ->where('driver_id', $request->user()->id)
            ->whereNotIn('status', ['COMPLETED', 'CANCELLED'])
            ->first();

        if ($existing) {
            return response()->json([
                'vehicle' => $this->departures->shapeAdminDeparture($existing->fresh(['route.stops', 'driver:id,name'])),
                'message' => 'Active fixed vehicle already open.',
            ], 200);
        }

        $prepared = app(FixedDepartureVehicleService::class)->prepare($route, $driver, $data['vehicle_seat_layout_id'] ?? null);
        $departure = DB::transaction(function () use ($route, $request, $driver, $prepared) {
            $departure = RouteDeparture::query()->create($prepared + [
                'route_id' => $route->id,
                'route_schedule_id' => null,
                'trip_id' => null,
                'driver_id' => $request->user()->id,
                'service_date' => now()->toDateString(),
                'departure_kind' => 'driver_opened',
                'depart_at' => null,
                'announced_depart_at' => null,
                'actual_depart_at' => null,
                'boarding_opened_at' => now(),
                'boarding_closed_at' => null,
                'visible_to_customers' => true,
                'seats_taken' => 0,
                'luggage_capacity' => (int) $route->max_luggage_per_vehicle,
                'luggage_taken' => 0,
                'status' => 'FORMING',
            ]);

            $driver->update([
                'is_online' => true,
                'active_service_mode' => Driver::SERVICE_MODE_FIXED,
                'active_service_scope' => $route->scope ?: Driver::SERVICE_SCOPE_LOCAL,
                'active_status' => Driver::ACTIVE_STATUS_DUTY,
                'last_online_at' => now(),
            ]);

            $this->seatMap->snapshotForDeparture($departure);
            return $departure;
        });

        try {
            $this->broadcastAvailability($departure, 'vehicle_opened');
        } catch (\Throwable $e) {
            Log::warning('Broadcast failed on open', ['error' => $e->getMessage()]);
        }

        return response()->json([
            'vehicle' => $this->departures->shapeAdminDeparture($departure->fresh(['route.stops', 'driver:id,name'])),
            'message' => 'Fixed vehicle opened for boarding.',
        ], 201);
    }

    public function manifest(Request $request, RouteDeparture $departure)
    {
        $this->guardDriverDeparture($request, $departure);
        return response()->json($this->manifest->manifest($departure));
    }

    public function start(Request $request, RouteDeparture $departure)
    {
        $this->guardDriverDeparture($request, $departure);
        $departure->loadMissing('route.stops');
        $this->serviceModes->assertFixedMode($this->driverProfile($request), $departure->route?->scope ?: Driver::SERVICE_SCOPE_LOCAL);

        $departure = DB::transaction(function () use ($request, $departure) {
            /** @var RouteDeparture $dep */
            $dep = RouteDeparture::query()->with('route.stops')->lockForUpdate()->findOrFail($departure->id);
            $this->guardDriverDeparture($request, $dep);

            if (in_array($dep->status, ['COMPLETED', 'CANCELLED'], true)) {
                abort(422, 'This fixed vehicle is already closed.');
            }

            if ($dep->status !== 'FORMING') {
                abort(422, 'Boarding has already started for this vehicle.');
            }

            $route = $dep->route;
            if (!$route) {
                abort(422, 'This fixed route is not available.');
            }

            $firstStop = $route->stops?->sortBy('seq')->first();
            $lastStop = $route->stops?->sortBy('seq')->last();
            $originRaw = trim((string) ($route->origin_name ?? ''));
            $destRaw = trim((string) ($route->dest_name ?? ''));
            $routeName = trim((string) ($route->name ?? ''));

            $originFallback = $firstStop?->name;
            if (!$originFallback && $routeName) {
                if (str_contains($routeName, '->')) $originFallback = trim(explode('->', $routeName)[0]);
                elseif (str_contains($routeName, '→')) $originFallback = trim(explode('→', $routeName)[0]);
                elseif (stripos($routeName, ' to ') !== false) $originFallback = trim(preg_split('/ to /i', $routeName)[0]);
            }

            $destFallback = $lastStop?->name;
            if (!$destFallback && $routeName) {
                if (str_contains($routeName, '->')) $destFallback = trim(explode('->', $routeName)[1]);
                elseif (str_contains($routeName, '→')) $destFallback = trim(explode('→', $routeName)[1]);
                elseif (stripos($routeName, ' to ') !== false) $destFallback = trim(preg_split('/ to /i', $routeName)[1]);
            }

            $originName = ($originRaw !== '' && strtolower($originRaw) !== 'origin') ? $originRaw : ($originFallback ?: 'Origin');
            $destName = ($destRaw !== '' && strtolower($destRaw) !== 'destination') ? $destRaw : ($destFallback ?: 'Destination');
            $originLat = (float) ($route->origin_lat ?: ($firstStop?->lat ?: 0));
            $originLng = (float) ($route->origin_lng ?: ($firstStop?->lng ?: 0));
            $destLat = (float) ($route->dest_lat ?: ($lastStop?->lat ?: 0));
            $destLng = (float) ($route->dest_lng ?: ($lastStop?->lng ?: 0));

            $trip = $dep->trip_id ? Trip::query()->find($dep->trip_id) : null;
            if (!$trip) {
                $fareTotal = (float) SeatReservation::query()
                    ->where('route_departure_id', $dep->id)
                    ->whereIn('status', SeatReservation::ACTIVE_STATUSES)
                    ->sum('fare_amount');

                $trip = Trip::query()->create([
                    'customer_id' => null,
                    'driver_id' => $request->user()->id,
                    'city_id' => $route->city_id,
                    'scope' => $route->scope ?: 'local',
                    'city_vehicle_type_id' => $dep->city_vehicle_type_id,
                    'ride_type_id' => $this->resolveRideTypeId($route),
                    'route_id' => $route->id,
                    'route_departure_id' => $dep->id,
                    'status' => 'EN_ROUTE_PICKUP',
                    'estimated_fare' => $fareTotal,
                    'final_fare' => $fareTotal,
                    'currency' => 'INR',
                    'pickup_address' => $originName,
                    'pickup_lat' => $originLat,
                    'pickup_lng' => $originLng,
                    'drop_address' => $destName,
                    'drop_lat' => $destLat,
                    'drop_lng' => $destLng,
                    'confirmed_at' => now(),
                    'assigned_at' => now(),
                    'en_route_pickup_at' => now(),
                ]);
            } elseif (!in_array($trip->status, ['COMPLETED', 'CANCELLED'], true)) {
                $trip->update([
                    'driver_id' => $request->user()->id,
                    'status' => 'EN_ROUTE_PICKUP',
                    'assigned_at' => $trip->assigned_at ?? now(),
                    'en_route_pickup_at' => $trip->en_route_pickup_at ?? now(),
                ]);
            }

            SeatReservation::query()
                ->where('route_departure_id', $dep->id)
                ->whereIn('status', SeatReservation::ACTIVE_STATUSES)
                ->update(['trip_id' => $trip->id]);

            try {
                app(\App\Services\BookingPaymentService::class)->linkDepartureBookings($trip, $dep->id);
            } catch (\Throwable $e) {
                Log::warning('linkDepartureBookings failed', ['error' => $e->getMessage()]);
            }

            $dep->update([
                'trip_id' => $trip->id,
                'driver_id' => $request->user()->id,
                'boarding_opened_at' => $dep->boarding_opened_at ?? now(),
                'visible_to_customers' => true,
                'status' => 'DISPATCHED',
                'fixed_last_reached_stop_seq' => $dep->fixed_last_reached_stop_seq ?: 1,
                'fixed_last_reached_stop_at' => $dep->fixed_last_reached_stop_at ?? now(),
            ]);

            return $dep->fresh(['route.stops', 'driver:id,name']);
        });

        $this->notifyFixedStarted($departure, true);

        $driver = $this->driverProfile($request);
        $driver->update([
            'is_online' => true,
            'active_service_mode' => Driver::SERVICE_MODE_FIXED,
            'active_service_scope' => $departure->route?->scope ?: Driver::SERVICE_SCOPE_LOCAL,
            'active_status' => Driver::ACTIVE_STATUS_DUTY,
            'last_online_at' => now(),
        ]);

        return response()->json([
            'vehicle' => $this->departures->shapeAdminDeparture($departure),
            'message' => 'Boarding started. The vehicle has not departed yet.',
        ]);
    }

    public function depart(Request $request, RouteDeparture $departure)
    {
        $this->guardDriverDeparture($request, $departure);
        $departure = DB::transaction(function () use ($request, $departure) {
            $dep = RouteDeparture::query()->lockForUpdate()->findOrFail($departure->id);
            $this->guardDriverDeparture($request, $dep);
            if ($dep->status !== 'DISPATCHED') {
                abort(422, 'Start boarding before departing. This vehicle may have already departed or closed.');
            }
            $dep->update([
                'status' => 'DEPARTED',
                'actual_depart_at' => now(),
                'boarding_closed_at' => now(),
            ]);
            return $dep->fresh(['route.stops', 'driver:id,name']);
        });
        $this->notifyFixedStarted($departure);
        $this->broadcastAvailability($departure, 'vehicle_departed');
        return response()->json([
            'vehicle' => $this->departures->shapeAdminDeparture($departure),
            'message' => 'Vehicle departed. Customers can still book from upcoming stops while seats are available.',
        ]);
    }

    public function closeBookings(Request $request, RouteDeparture $departure)
    {
        $this->guardDriverDeparture($request, $departure);

        $result = DB::transaction(function () use ($request, $departure) {
            $dep = RouteDeparture::query()->with('route:id,city_id,mode')->lockForUpdate()->findOrFail($departure->id);
            $this->guardDriverDeparture($request, $dep);

            if ($dep->status !== 'FORMING') {
                abort(422, 'This fixed vehicle can only be closed before the ride starts.');
            }

            $activeReservationCount = SeatReservation::query()
                ->where('route_departure_id', $dep->id)
                ->whereNotIn('status', ['CANCELLED', 'NO_SHOW'])
                ->count();
            $activeHoldCount = FixedSeatHold::query()
                ->where('route_departure_id', $dep->id)
                ->where('status', 'HELD')
                ->where('expires_at', '>', now())
                ->count();

            if ($activeReservationCount > 0 || $activeHoldCount > 0 || ($dep->seats_taken ?? 0) > 0) {
                abort(422, 'A customer has active booked seats or holds. This vehicle cannot be removed.');
            }

            $routeId = (int) $dep->route_id;
            $cityId = (int) ($dep->route?->city_id ?? 0);
            $dep->delete();

            return ['route_id' => $routeId, 'city_id' => $cityId];
        });

        if (($result['city_id'] ?? 0) > 0) {
            try {
                broadcast(new FixedRouteCatalogUpdated((int) $result['city_id'], (int) $result['route_id'], 'vehicle_removed'))->toOthers();
            } catch (\Throwable $e) {
                Log::warning('Fixed vehicle removed but broadcast failed', [
                    'route_id' => $result['route_id'] ?? null,
                    'city_id' => $result['city_id'] ?? null,
                    'error' => $e->getMessage(),
                ]);
            }
        }

        return response()->json([
            'vehicle' => null,
            'message' => 'Fixed vehicle closed and removed.',
        ]);
    }

    public function openBookings(Request $request, RouteDeparture $departure)
    {
        $this->guardDriverDeparture($request, $departure);

        $departure = DB::transaction(function () use ($request, $departure) {
            $dep = RouteDeparture::query()->lockForUpdate()->findOrFail($departure->id);
            $this->guardDriverDeparture($request, $dep);

            if (in_array($dep->status, ['COMPLETED', 'CANCELLED'], true)) {
                abort(422, 'This fixed vehicle is already closed.');
            }

            $dep->update([
                'visible_to_customers' => true,
                'boarding_closed_at' => null,
            ]);

            return $dep->fresh(['route:id,city_id,name,scope,mode,origin_name,dest_name', 'driver:id,name']);
        });

        $this->broadcastAvailability($departure, 'bookings_opened');

        return response()->json([
            'vehicle' => $this->departures->shapeAdminDeparture($departure),
            'message' => 'Fixed vehicle opened for bookings.',
        ]);
    }

    /**
     * Step 1 of boarding: generate the boarding code and show it on the
     * customer's own booking screen (no SMS; email/push per operator toggles).
     * The driver app opens the code-entry popup after this succeeds. Re-hitting
     * it acts as "Resend" (30s cooldown enforced by the service).
     */
    public function sendBoardingOtp(Request $request, SeatReservation $reservation)
    {
        $this->guardDriverReservation($request, $reservation);
        $reservation->loadMissing('routeDeparture.route:id,fixed_settings_json', 'boardStop:id,route_id,seq,name,lat,lng', 'customer:id,name,phone,email,push_unsubscribed');

        // Same preconditions as boarding itself, so a code can never be
        // requested in a state where boarding would be rejected anyway.
        if (!in_array($reservation->status, ['BOOKED', 'CONFIRMED'], true)) {
            abort(422, 'This passenger cannot be boarded from the current status.');
        }

        $departure = $reservation->routeDeparture;
        if (!$departure || !in_array($departure->status, ['DISPATCHED', 'DEPARTED'], true)) {
            abort(422, 'Start the fixed ride before boarding passengers.');
        }
        $this->recordActionPing($request, $departure, (int) $request->user()->id);
        $this->ensureStopReachedForAction($departure, $reservation->boardStop, (int) $request->user()->id, 'Reach the passenger pickup stop before boarding.');

        $result = $this->boardingOtp->send($reservation);

        if (!($result['sent'] ?? false)) {
            if (isset($result['locked_for'])) {
                return response()->json([
                    'message' => 'Too many wrong codes. Wait ' . ceil($result['locked_for'] / 60) . ' min, then resend — or mark no-show.',
                    'locked_for' => $result['locked_for'],
                ], 429);
            }
            return response()->json([
                'message' => 'Code already sent. You can resend in ' . ($result['retry_after'] ?? FixedBoardingOtpService::RESEND_COOLDOWN_SEC) . 's.',
                'retry_after' => $result['retry_after'] ?? FixedBoardingOtpService::RESEND_COOLDOWN_SEC,
            ], 429);
        }

        return response()->json([
            'message' => 'Boarding code is now showing on the passenger\'s screen.',
            'resend_after' => FixedBoardingOtpService::RESEND_COOLDOWN_SEC,
        ]);
    }

    public function board(Request $request, SeatReservation $reservation)
    {
        $data = $request->validate([
            'code' => ['required', 'digits:4'],
        ]);

        $this->guardDriverReservation($request, $reservation);
        $reservation->loadMissing('routeDeparture.route:id,fixed_settings_json', 'boardStop:id,route_id,seq,name,lat,lng');

        if (!in_array($reservation->status, ['BOOKED', 'CONFIRMED'], true)) {
            abort(422, 'This passenger cannot be boarded from the current status.');
        }

        $departure = $reservation->routeDeparture;
        if (!$departure || !in_array($departure->status, ['DISPATCHED', 'DEPARTED'], true)) {
            abort(422, 'Start the fixed ride before boarding passengers.');
        }
        $this->recordActionPing($request, $departure, (int) $request->user()->id);
        $this->ensureStopReachedForAction($departure, $reservation->boardStop, (int) $request->user()->id, 'Reach the passenger pickup stop before boarding.');

        // Boarding is code-gated: the customer reads out the code we sent
        // them and the driver types it here. Wrong/expired/locked → no board.
        $check = $this->boardingOtp->verify($reservation, $data['code']);
        if (!($check['ok'] ?? false)) {
            return match ($check['error'] ?? 'wrong') {
                'locked' => response()->json([
                    'message' => 'Too many wrong codes. Wait ' . ceil(($check['locked_for'] ?? 300) / 60) . ' min, then resend — or mark no-show.',
                    'locked_for' => $check['locked_for'] ?? 300,
                ], 429),
                'expired' => response()->json([
                    'message' => 'This code has expired. Resend a fresh code to the passenger.',
                    'expired' => true,
                ], 422),
                default => response()->json([
                    'message' => 'Wrong code. ' . ($check['attempts_left'] ?? 0) . ' ' . (($check['attempts_left'] ?? 0) === 1 ? 'try' : 'tries') . ' left.',
                    'attempts_left' => $check['attempts_left'] ?? 0,
                ], 422),
            };
        }

        $reservation->update([
            'status' => 'BOARDED',
            'boarded_at' => now(),
        ]);

        $this->events->record(
            $reservation->fresh(),
            'passenger_boarded',
            'Passenger boarded',
            'Driver verified the boarding code and marked this customer as boarded.',
            ['driver_id' => $request->user()->id, 'otp_verified' => true],
            $request->user(),
        );

        return response()->json([
            'reservation' => [
                'id' => $reservation->id,
                'status' => 'BOARDED',
                'boarded_at' => optional($reservation->fresh()->boarded_at)->toIso8601String(),
            ],
            'message' => 'Passenger marked as boarded.',
        ]);
    }

    public function drop(Request $request, SeatReservation $reservation)
    {
        $this->guardDriverReservation($request, $reservation);
        $reservation->loadMissing('routeDeparture.route:id,fixed_settings_json', 'dropStop:id,route_id,seq,name,lat,lng');

        if ($reservation->status !== 'BOARDED') {
            abort(422, 'This passenger must be boarded before drop-off.');
        }

        $departure = $reservation->routeDeparture;
        if (!$departure || !in_array($departure->status, ['DISPATCHED', 'DEPARTED'], true)) {
            abort(422, 'Start the fixed ride before dropping passengers.');
        }
        $this->recordActionPing($request, $departure, (int) $request->user()->id);
        $this->ensureStopReachedForAction($departure, $reservation->dropStop, (int) $request->user()->id, 'Reach the passenger drop stop before drop-off.');

        DB::transaction(function () use ($reservation) {
            $locked = SeatReservation::query()->lockForUpdate()->findOrFail($reservation->id);
            if ($locked->status !== 'BOARDED') {
                abort(422, 'This passenger must be boarded before drop-off.');
            }

            $locked->update([
                'status' => 'DROPPED',
                'dropped_at' => now(),
            ]);

            $this->events->record(
                $locked->fresh(),
                'passenger_dropped',
                'Passenger dropped off',
                'Driver marked this customer as dropped off at the destination stop.',
                [],
            );

            $departure = RouteDeparture::query()->lockForUpdate()->find($locked->route_departure_id);
            if ($departure) {
                $departure->update([
                    'seats_taken' => max(0, (int) $departure->seats_taken - (int) $locked->seats),
                    'luggage_taken' => max(0, (int) $departure->luggage_taken - (int) $locked->extra_luggage_count),
                ]);
            }
        });

        return response()->json([
            'reservation' => [
                'id' => $reservation->id,
                'status' => 'DROPPED',
                'dropped_at' => optional($reservation->fresh()->dropped_at)->toIso8601String(),
            ],
            'message' => 'Passenger marked as dropped off.',
        ]);
    }

    public function complete(Request $request, RouteDeparture $departure)
    {
        $this->guardDriverDeparture($request, $departure);

        $departure = DB::transaction(function () use ($request, $departure) {
            /**  RouteDeparture  */
            $dep = RouteDeparture::query()->with('trip')->lockForUpdate()->findOrFail($departure->id);
            $this->guardDriverDeparture($request, $dep);

            if (in_array($dep->status, ['COMPLETED', 'CANCELLED'], true)) {
                abort(422, 'This fixed vehicle is already closed.');
            }

            $activePassengers = SeatReservation::query()
                ->where('route_departure_id', $dep->id)
                ->whereIn('status', SeatReservation::ACTIVE_STATUSES)
                ->count();

            if ($activePassengers > 0) {
                abort(422, 'Complete boarding, drop-off, cancellation or no-show for all active passengers before closing this ride.');
            }

            $now = now();
            if ($dep->trip && !in_array($dep->trip->status, ['COMPLETED', 'CANCELLED'], true)) {
                $dep->trip->update([
                    'status' => 'COMPLETED',
                    'completed_at' => $dep->trip->completed_at ?? $now,
                    'final_fare' => $dep->trip->final_fare ?? $dep->trip->estimated_fare,
                ]);
                $this->settlements->settle($dep->trip->fresh());
            }

            $dep->update([
                'boarding_closed_at' => $dep->boarding_closed_at ?? $now,
                'visible_to_customers' => false,
                'seats_taken' => 0,
                'luggage_taken' => 0,
                'status' => 'COMPLETED',
            ]);

            return $dep->fresh(['route:id,city_id,name,scope,mode,origin_name,dest_name', 'driver:id,name']);
        });

        $this->broadcastAvailability($departure, 'vehicle_completed');
        $this->notifyFixedCompleted($departure);

        return response()->json([
            'vehicle' => $this->departures->shapeAdminDeparture($departure),
            'message' => 'Fixed ride completed.',
        ]);
    }

    public function noShow(Request $request, SeatReservation $reservation)
    {
        $this->guardDriverReservation($request, $reservation);
        $reservation->loadMissing('routeDeparture:id,route_id,status,fixed_last_reached_stop_seq', 'boardStop:id,route_id,seq,name,lat,lng');

        $departure = $reservation->routeDeparture;
        if (!$departure || !in_array($departure->status, ['DISPATCHED', 'DEPARTED'], true)) {
            abort(422, 'Start the fixed ride before marking passenger no-show.');
        }

        if (!in_array($reservation->status, ['BOOKED', 'CONFIRMED'], true)) {
            abort(422, 'Only waiting passengers can be marked no-show.');
        }

        $pickupSeq = $reservation->boardStop?->seq;
        if ($pickupSeq === null || (int) $reservation->boardStop?->route_id !== (int) $departure->route_id) {
            abort(422, 'Passenger pickup stop is not available for no-show validation.');
        }

        $this->recordActionPing($request, $departure, (int) $request->user()->id);
        $this->ensureStopReachedForAction($departure, $reservation->boardStop, (int) $request->user()->id, 'Reach the passenger pickup stop before marking no-show.');

        // Customer protection: the manual No-show button must respect the same
        // waiting timer the automatic no-show uses, so a driver can't roll into
        // the stop and instantly no-show a passenger who is walking up. Reload
        // so we see the freshly recorded reach time / arrival timer.
        $reservation->refresh()->loadMissing('boardStop:id,seq');
        $departure->refresh()->loadMissing('route:id,city_id,waiting_time_per_stop_minutes');
        $unlockAt = FixedNoShowPolicy::unlockAt($reservation, $departure);
        if ($unlockAt && now()->lessThan($unlockAt)) {
            $secs = abs(now()->diffInSeconds($unlockAt));
            abort(422, "Waiting time isn't over yet — you can mark this passenger no-show in {$secs}s.");
        }

        $updated = $this->refunds->markNoShow($reservation);
        $this->broadcastAvailability(RouteDeparture::query()->findOrFail($departure->id), 'passenger_no_show');

        return response()->json([
            'reservation' => [
                'id' => $updated->id,
                'status' => $updated->status,
                'refund_status' => $updated->refund_status,
            ],
            'message' => 'Passenger marked as no-show.',
        ]);
    }

    public function cancelPassenger(Request $request, SeatReservation $reservation)
    {
        $this->guardDriverReservation($request, $reservation);
        $data = $request->validate([
            'reason' => ['nullable', 'string', 'max:500'],
        ]);

        if (!in_array($reservation->status, ['BOOKED', 'CONFIRMED'], true)) {
            abort(422, 'This passenger booking cannot be cancelled from the current status.');
        }

        $departure = $reservation->routeDeparture;
        if ($departure && in_array($departure->status, ['DEPARTED', 'COMPLETED', 'CANCELLED'], true)) {
            abort(422, 'Cannot cancel passenger once the ride has already started.');
        }

        $reason = !empty($data['reason']) ? trim($data['reason']) : 'Driver cancelled passenger';
        $detail = 'Driver cancelled this passenger booking. Reason: ' . $reason;

        $updated = $this->refunds->cancelBySystem($reservation, 'driver_passenger_cancelled', $request->user(), $detail);
        $this->broadcastAvailability(RouteDeparture::query()->findOrFail($reservation->route_departure_id), 'passenger_cancelled');

        return response()->json([
            'reservation' => [
                'id' => $updated->id,
                'status' => $updated->status,
                'refund_status' => $updated->refund_status,
            ],
            'message' => 'Passenger booking has been cancelled.',
        ]);
    }

    public function cancelDeparture(Request $request, RouteDeparture $departure)
    {
        $this->guardDriverDeparture($request, $departure);
        $data = $request->validate([
            'reason' => ['nullable', 'string', 'max:500'],
        ]);

        $result = $this->departures->cancelDriverDeparture($departure, $request->user(), $data['reason'] ?? null);
        $this->broadcastAvailability($departure, 'departure_cancelled');

        return response()->json([
            'departure' => $this->departures->shapeAdminDeparture($result['departure']),
            'cancelled_passengers' => $result['cancelled_passengers'],
            'refund_pending' => $result['refund_pending'],
            'message' => 'Vehicle departure cancelled. Any booked passenger seats were cancelled with full refunds.',
        ]);
    }

    /**
     * Board/drop/no-show taps may carry the driver's live GPS fix (lat/lng in
     * the request body) so the stop-reached guard never depends on the
     * background location stream still being alive — the action brings its
     * own proof. The fix is stored as a normal ping (customer tracking
     * benefits too). Absent coords = old behaviour: guard falls back to the
     * most recent streamed ping (max 5 min old).
     */
    private function recordActionPing(Request $request, ?RouteDeparture $departure, int $driverId): void
    {
        $data = $request->validate([
            'lat' => ['nullable', 'numeric', 'between:-90,90'],
            'lng' => ['nullable', 'numeric', 'between:-180,180'],
        ]);

        if (!isset($data['lat'], $data['lng'])) {
            return;
        }

        DriverLocation::query()->create([
            'driver_id' => $driverId,
            'trip_id' => $departure?->trip_id,
            'lat' => (float) $data['lat'],
            'lng' => (float) $data['lng'],
            'recorded_at' => now(),
        ]);
    }

    private function ensureStopReachedForAction(?RouteDeparture $departure, ?RouteStop $stop, int $driverId, string $message): void
    {
        if (!$departure || !$stop || (int) $stop->route_id !== (int) $departure->route_id) {
            abort(422, $message);
        }

        $targetSeq = (int) $stop->seq;
        if ((int) ($departure->fixed_last_reached_stop_seq ?? 0) >= $targetSeq) {
            return;
        }

        // The arrival radius always comes from live City Settings — the same source
        // the automatic stop-reached check uses — so board/drop/no-show agree with
        // what the operator configured. Falls back to the route's own value, then a
        // floor, only when City Settings is missing. No upper cap: the operator's
        // number wins everywhere.
        $departure->loadMissing('route:id,city_id,fixed_settings_json');
        $legacy = is_array($departure->route?->fixed_settings_json) ? $departure->route->fixed_settings_json : [];
        $citySettings = \App\Models\CitySetting::query()->where('city_id', $departure->route?->city_id)->first();
        $radiusM = max(5, (int) ($citySettings?->fixed_stop_arrival_radius_m ?? ($legacy['stop_arrival_radius_m'] ?? 150)));

        $location = DriverLocation::query()
            ->where('driver_id', $driverId)
            ->where('recorded_at', '>=', now()->subMinutes(5))
            ->orderByDesc('recorded_at')
            ->first(['lat', 'lng', 'recorded_at']);

        if (!$location || $this->distanceMeters((float) $location->lat, (float) $location->lng, (float) $stop->lat, (float) $stop->lng) > $radiusM) {
            abort(422, $message);
        }

        $departure->forceFill([
            'fixed_last_reached_stop_seq' => $targetSeq,
            'fixed_last_reached_stop_at' => now(),
        ])->save();
    }

    private function distanceMeters(float $lat1, float $lng1, float $lat2, float $lng2): float
    {
        $earthM = 6371000.0;
        $dLat = deg2rad($lat2 - $lat1);
        $dLng = deg2rad($lng2 - $lng1);
        $a = sin($dLat / 2) ** 2
            + cos(deg2rad($lat1)) * cos(deg2rad($lat2)) * sin($dLng / 2) ** 2;

        return $earthM * 2 * atan2(sqrt($a), sqrt(1 - $a));
    }

    private function notifyFixedStarted(RouteDeparture $departure, bool $boarding = false): void
    {
        try {
            $departure->loadMissing("route:id,name");
            $routeName = $departure->route?->name ?: "Fixed route";
            $event = $boarding ? 'fixed_boarding_started' : 'fixed_vehicle_started';
            $title = $boarding ? 'Boarding started' : 'Vehicle departed';
            $body = $boarding ? $routeName . ' is boarding. The vehicle has not departed yet.' : $routeName . ' has departed.';
            $data = [
                "route_departure_id" => $departure->id,
                "route_id" => $departure->route_id,
                "trip_id" => $departure->trip_id,
            ];

            SeatReservation::query()
                ->where("route_departure_id", $departure->id)
                ->whereIn("status", SeatReservation::ACTIVE_STATUSES)
                ->pluck("customer_id")
                ->unique()
                ->each(fn ($customerId) => $this->notifier->notifyUserId((int) $customerId, $event, $title, $body, $data, "play-circle"));

            $this->notifier->notifyAdmins($event, $title, $body, $data + ["driver_id" => $departure->driver_id], "play-circle");
        } catch (\Throwable $e) {
            Log::warning('notifyFixedStarted failed', ['error' => $e->getMessage()]);
        }
    }

    private function notifyFixedCompleted(RouteDeparture $departure): void
    {
        try {
            $departure->loadMissing("route:id,name");
            $routeName = $departure->route?->name ?: "Fixed route";
            $this->notifier->notifyAdmins("fixed_vehicle_completed", "Fixed vehicle completed", "Driver completed " . $routeName . ".", [
                "route_departure_id" => $departure->id,
                "route_id" => $departure->route_id,
                "trip_id" => $departure->trip_id,
                "driver_id" => $departure->driver_id,
            ], "check-circle");
        } catch (\Throwable $e) {
            Log::warning('notifyFixedCompleted failed', ['error' => $e->getMessage()]);
        }
    }

    private function broadcastAvailability(RouteDeparture $departure, string $reason): void
    {
        $departure->loadMissing('route:id,city_id');
        if ($departure->route?->city_id) {
            try {
                broadcast(new FixedRouteCatalogUpdated((int) $departure->route->city_id, (int) $departure->route_id, $reason))->toOthers();
            } catch (\Throwable $e) {
                Log::warning('Fixed catalog broadcast failed', [
                    'route_departure_id' => $departure->id,
                    'route_id' => $departure->route_id,
                    'reason' => $reason,
                    'error' => $e->getMessage(),
                ]);
            }
        }
    }

    private function guardDriverDeparture(Request $request, RouteDeparture $departure): void
    {
        $this->availability->assertFixedDeparture($departure);
        $departure->loadMissing('trip:id,driver_id');

        $driverId = (int) $request->user()->id;
        $assignedDepartureDriverId = $departure->driver_id !== null ? (int) $departure->driver_id : null;
        $assignedTripDriverId = $departure->trip?->driver_id !== null ? (int) $departure->trip?->driver_id : null;

        if ($assignedDepartureDriverId !== $driverId && $assignedTripDriverId !== $driverId) {
            abort(404);
        }
    }

    private function guardDriverReservation(Request $request, SeatReservation $reservation): void
    {
        $reservation->loadMissing('route:id,mode', 'routeDeparture.trip:id,driver_id');
        if ($reservation->route?->mode !== 'fixed') {
            abort(404);
        }

        $departureDriverId = $reservation->routeDeparture?->driver_id;
        $tripDriverId = $reservation->routeDeparture?->trip?->driver_id;
        if ((int) $departureDriverId !== (int) $request->user()->id && (int) $tripDriverId !== (int) $request->user()->id) {
            abort(404);
        }
    }

    private function driverProfile(Request $request): Driver
    {
        $driver = Driver::query()->where('user_id', $request->user()->id)->first();
        if (!$driver) {
            abort(404, 'Driver profile not found.');
        }

        return $driver;
    }

    public function seatMap(Request $request, RouteDeparture $departure)
    {
        $this->guardDriverDeparture($request, $departure);
        return response()->json($this->seatMap->mapForDeparture($departure));
    }

    public function blockSeat(Request $request, RouteDeparture $departure)
    {
        $this->guardDriverDeparture($request, $departure);
        $data = $request->validate([
            'label' => ['required', 'string', 'max:20'],
        ]);

        $map = $this->seatMap->blockSeatForDeparture($departure, trim($data['label']));

        return response()->json([
            'message' => "Seat {$data['label']} marked as offline walk-in.",
            'seat_map' => $map,
            'vehicle' => $this->departures->shapeAdminDeparture($departure->fresh(['route', 'driver'])),
        ]);
    }

    public function unblockSeat(Request $request, RouteDeparture $departure)
    {
        $this->guardDriverDeparture($request, $departure);
        $data = $request->validate([
            'label' => ['required', 'string', 'max:20'],
        ]);

        $map = $this->seatMap->unblockSeatForDeparture($departure, trim($data['label']));

        return response()->json([
            'message' => "Seat {$data['label']} released back to online bookings.",
            'seat_map' => $map,
            'vehicle' => $this->departures->shapeAdminDeparture($departure->fresh(['route', 'driver'])),
        ]);
    }

    public function acceptSeatHold(Request $request, FixedSeatHold $fixedSeatHold)
    {
        $hold = $this->seatHolds->driverAcceptHold($request->user(), $fixedSeatHold);

        return response()->json([
            'message' => 'Passenger seat request accepted.',
            'hold' => $this->bookings->shapeSeatHold($hold->fresh('routeDeparture.route')),
        ]);
    }

    public function rejectSeatHold(Request $request, FixedSeatHold $fixedSeatHold)
    {
        $this->seatHolds->driverRejectHold($request->user(), $fixedSeatHold);

        return response()->json([
            'message' => 'Passenger seat request declined.',
        ]);
    }

    public function pendingSeatHolds(Request $request, RouteDeparture $departure)
    {
        $this->guardDriverDeparture($request, $departure);

        $holds = FixedSeatHold::query()
            ->where('route_departure_id', $departure->id)
            ->where('status', 'PENDING_DRIVER_APPROVAL')
            ->where('expires_at', '>', now())
            ->orderByDesc('id')
            ->get()
            ->map(fn (FixedSeatHold $h) => $this->bookings->shapeSeatHold($h));

        return response()->json(['data' => $holds]);
    }

    private function resolveRideTypeId(Route $route): int
    {
        $cvt = $route->cityVehicleType()->first();
        if ($cvt && $cvt->ride_type_id && RideType::query()->whereKey((int) $cvt->ride_type_id)->exists()) {
            return (int) $cvt->ride_type_id;
        }

        return (int) RideType::query()->firstOrCreate(
            ['name' => 'Fixed'],
            ['description' => 'Fixed route shared ride', 'sort_order' => 30],
        )->id;
    }
}
