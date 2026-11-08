<?php

namespace App\Http\Controllers\Admin;

use App\Models\City;
use App\Models\DriverLocation;
use App\Models\FixedSeatHold;
use App\Models\OperatorSetting;
use App\Models\PricingRule;
use App\Models\RouteDeparture;
use App\Models\RouteStop;
use App\Models\SeatReservation;
use App\Models\Trip;
use App\Events\FixedRouteCatalogUpdated;
use App\Services\AutoRefundService;
use App\Services\DynamicPricingService;
use App\Services\FareEstimationService;
use App\Services\FixedAvailabilityService;
use App\Services\FixedDepartureService;
use App\Services\FixedManifestService;
use App\Services\FixedRefundService;
use App\Services\GeoService;
use App\Services\ManagerScope;
use App\Services\NotificationCenter;
use App\Services\ShuttleRefundService;
use App\Services\TripStateMachineService;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class AdminTripsController
{
    public function __construct(private readonly FixedManifestService $fixedManifest) {}

    /**
     * Lists trips for the admin ride-monitoring screens.
     *
     * Filters (all optional):
     *   - category:     ongoing | completed | cancelled | scheduled | missed | pending
     *                   (preset bundles of statuses; takes precedence over `status`)
     *   - status:       single status string (overridden by category)
     *   - date_from:    YYYY-MM-DD (filters trips.created_at >=)
     *   - date_to:      YYYY-MM-DD (filters trips.created_at <= end of day)
     *   - ride_type_id: int
     *   - phone:        substring matched against customer.phone OR driver.phone
     *
     * Without any filter, defaults to "ongoing" so the admin doesn't get a wall
     * of historical trips on first load.
     */
    public function index(Request $request)
    {
        $query = Trip::query()
            ->with(['customer', 'driver', 'rideType', 'pricingRule', 'seatReservations.customer']);

        // Restrict to the manager's city scope. Super Admin sees all.
        ManagerScope::applyCityScope($query, 'city_id');

        $category = $request->query('category');
        $status = $request->query('status');

        $this->applyCategoryFilter($query, $category, $status);

        if ($from = $request->query('date_from')) {
            $query->whereDate('trips.created_at', '>=', $from);
        }
        if ($to = $request->query('date_to')) {
            $query->whereDate('trips.created_at', '<=', $to);
        }

        if ($rideTypeId = $request->query('ride_type_id')) {
            $query->where('ride_type_id', (int) $rideTypeId);
        }

        if ($cvtId = $request->query('city_vehicle_type_id')) {
            $query->where('city_vehicle_type_id', (int) $cvtId);
        }

        if ($cityId = $request->query('city_id')) {
            // Additional narrowing on top of ManagerScope — safe because
            // scoped managers' allowed set already limits which cities they
            // can see; if they pass a city_id they're not allowed to see,
            // the ManagerScope where-clause silently returns nothing.
            $query->where('city_id', (int) $cityId);
        }

        if ($phone = trim((string) $request->query('phone'))) {
            // Strip non-digits so "+91 90000-12345" matches "9000012345" in DB.
            $needle = preg_replace('/\D+/', '', $phone);
            if ($needle !== '') {
                $query->where(function ($q) use ($needle) {
                    $q->whereHas('customer', fn ($c) => $c->where('phone', 'like', "%{$needle}%"))
                      ->orWhereHas('driver', fn ($d) => $d->where('phone', 'like', "%{$needle}%"))
                      ->orWhereHas('seatReservations.customer', fn ($c) => $c->where('phone', 'like', "%{$needle}%"));
                });
            }
        }

        $perPage = (int) $request->query('per_page', 25);
        $perPage = max(1, min(100, $perPage));

        // Scheduled rides read best by pickup time (next pickup first); everything
        // else stays newest-first.
        if ($category && strtolower($category) === 'scheduled') {
            $query->orderBy('scheduled_at');
        } else {
            $query->orderByDesc('created_at');
        }

        $trips = $query->paginate($perPage);

        return response()->json(['data' => $trips]);
    }

    private function applyCategoryFilter($query, ?string $category, ?string $status): void
    {
        $category = $category ? strtolower($category) : null;

        switch ($category) {
            case 'ongoing':
                $query->whereIn('status', Trip::ACTIVE_DRIVER_STATUSES);
                return;

            case 'completed':
                $query->where('status', 'COMPLETED');
                return;

            case 'cancelled':
                // "Plain" cancellations only — no-shows live under the missed bucket.
                $query->where('status', 'CANCELLED')->whereNull('no_show_by');
                return;

            case 'missed':
                // Trips that ended because someone didn't show up.
                $query->where('status', 'CANCELLED')->whereNotNull('no_show_by');
                return;

            case 'pending':
                // Awaiting driver acceptance or driver assigned but not yet en-route.
                $query->whereIn('status', ['NEGOTIATION', 'ASSIGNED']);
                return;

            case 'scheduled':
                // Pre-booked rides that haven't finished yet — upcoming + in-progress.
                // Completed/cancelled scheduled rides fall into their own buckets.
                $query->whereNotNull('scheduled_at')
                      ->whereNotIn('status', Trip::TERMINAL_STATUSES);
                return;

            case 'all':
                if ($status) {
                    $query->where('status', $status);
                }
                return;

            default:
                if ($status) {
                    $query->where('status', $status);
                    return;
                }
                // Legacy default (kept for the existing /trips screen): hide terminals.
                $query->whereNotIn('status', ['COMPLETED', 'CANCELLED']);
        }
    }

    /**
     * Full trip detail for the admin ride-details screen — eager-loads every
     * relation the page renders (parties, pricing axes, payment with coupon
     * snapshot) plus the latest 100 driver-location pings for the map path.
     * One round trip serves the entire page.
     */
    public function show(Trip $trip)
    {
        ManagerScope::assertCityAllowed((int) $trip->city_id);

        $trip->load([
            'customer:id,name,phone,email,avatar_path',
            'driver:id,name,phone,email,avatar_path',
            'rideType:id,name',
            'cityVehicleType:id,city_id,ride_type_id,vehicle_type_id,display_name,max_people,luggage_capacity',
            'cityVehicleType.vehicleType:id,name',
            'cityVehicleType.rideType:id,name',
            'pricingRule',
            'payment:id,trip_id,method,provider,status,amount,discount_amount,paid_at,coupon_assignment_id,razorpay_payment_id,razorpay_order_id',
            'payment.couponAssignment.coupon:id,title,discount_type,discount_value',
            'routeDeparture.route:id,city_id,name,scope,mode,origin_name,dest_name',
        ]);

        // Driver profile fields (vehicle reg, brand etc) aren't on users —
        // they're on the `drivers` row keyed by user_id. Pull that separately.
        $driverProfile = $trip->driver_id
            ? \App\Models\Driver::query()
                ->where('user_id', $trip->driver_id)
                ->first([
                    'user_id', 'vehicle_type', 'vehicle_model',
                    'vehicle_color', 'vehicle_reg_no', 'rating_avg', 'rating_count',
                ])
            : null;

        // Driver path on the trip — cap to avoid sending megabytes for very
        // long rides. 100 points is enough to render a smooth polyline.
        $path = DriverLocation::query()
            ->where('trip_id', $trip->id)
            ->orderBy('recorded_at')
            ->limit(100)
            ->get(['lat', 'lng', 'recorded_at', 'bearing_deg']);

        $fixedManifest = null;
        if ($trip->routeDeparture && $trip->routeDeparture->route?->mode === 'fixed') {
            $fixedManifest = $this->fixedManifest->manifest($trip->routeDeparture);
        }

        return response()->json([
            'trip' => $trip,
            'driver_profile' => $driverProfile,
            'path' => $path,
            'fixed_manifest' => $fixedManifest,
        ]);
    }

    /**
     * Returns the latest stored driver location for a trip (used by admin ride monitoring).
     */
    public function latestLocation(Trip $trip)
    {
        $latest = DriverLocation::query()
            ->where('trip_id', $trip->id)
            ->orderByDesc('recorded_at')
            ->first();

        return response()->json([
            'trip_id' => $trip->id,
            'latest_location' => $latest,
        ]);
    }

    /**
     * Force-start a ride from the admin panel (bypasses OTP check).
     */
    public function start(
        Request $request,
        Trip $trip,
        TripStateMachineService $tripStateMachine,
        NotificationCenter $notifier,
    ) {
        ManagerScope::assertCityAllowed((int) $trip->city_id);

        if (in_array($trip->status, ['COMPLETED', 'CANCELLED', 'EN_ROUTE_DROP', 'ARRIVED_DROP'], true)) {
            return response()->json(['message' => 'Trip cannot be started in current status (' . $trip->status . ').'], 409);
        }

        if (!$trip->driver_id) {
            return response()->json(['message' => 'Cannot start a trip without an assigned driver.'], 422);
        }

        // Clear active start OTP
        $trip->forceFill([
            'start_otp' => null,
            'start_otp_expires_at' => null,
        ])->save();

        // Advance through intermediate states if needed to arrive at EN_ROUTE_DROP
        if (in_array($trip->status, ['REQUESTED', 'NEGOTIATION', 'CONFIRMED'], true)) {
            $tripStateMachine->transition($trip, 'ASSIGNED');
            $trip = $trip->fresh();
        }
        if ($trip->status === 'ASSIGNED') {
            $tripStateMachine->transition($trip, 'EN_ROUTE_PICKUP');
            $trip = $trip->fresh();
        }
        if ($trip->status === 'EN_ROUTE_PICKUP') {
            $tripStateMachine->transition($trip, 'ARRIVED_PICKUP');
            $trip = $trip->fresh();
        }
        if ($trip->status === 'ARRIVED_PICKUP') {
            $tripStateMachine->transition($trip, 'EN_ROUTE_DROP');
            $trip = $trip->fresh();
        }

        // In-app notifications
        if ($trip->driver_id) {
            $notifier->notifyUserId(
                $trip->driver_id,
                'trip_started_by_admin',
                'Trip started',
                "Trip #{$trip->id} was started by operator.",
                ['trip_id' => $trip->id, 'status' => 'EN_ROUTE_DROP'],
                'car-outline',
            );
        }
        if ($trip->customer_id) {
            $notifier->notifyUserId(
                $trip->customer_id,
                'trip_started_by_admin',
                'Trip started',
                "Your trip #{$trip->id} has begun.",
                ['trip_id' => $trip->id, 'status' => 'EN_ROUTE_DROP'],
                'car-outline',
            );
        }

        return response()->json([
            'message' => 'Trip started successfully.',
            'trip' => $trip->fresh(),
        ]);
    }

    /**
     * Cancel a ride from the admin panel.
     */
    public function cancel(
        Request $request,
        Trip $trip,
        TripStateMachineService $tripStateMachine,
        NotificationCenter $notifier,
        ShuttleRefundService $shuttleRefunds,
        FixedDepartureService $fixedDepartures,
    ) {
        ManagerScope::assertCityAllowed((int) $trip->city_id);

        $data = $request->validate([
            'reason' => ['required', 'string', 'max:500'],
            'waive_fee' => ['nullable', 'boolean'],
            'cancelled_by' => ['nullable', 'string', 'in:operator,driver,customer,system'],
        ]);

        // Fixed apps read departures and passenger reservations, not just trips.
        // Use the same cancellation/refund path as the fixed vehicle screen.
        $departure = $trip->route_departure_id
            ? RouteDeparture::query()->with('route')->findOrFail($trip->route_departure_id)
            : null;
        if ($departure && $departure->route?->mode === 'fixed') {
            if ($trip->status === 'COMPLETED') {
                return response()->json(['message' => 'Trip is already completed or cancelled.'], 409);
            }
            $city = City::query()->findOrFail($trip->city_id);
            $result = $fixedDepartures->cancelAdminDeparture($city, $departure, $request->user(), $data['reason']);
            try {
                broadcast(new FixedRouteCatalogUpdated((int) $city->id, (int) $departure->route_id, 'departure_cancelled'))->toOthers();
            } catch (\Throwable $e) {
                report($e);
            }
            return response()->json([
                'message' => 'Fixed ride and active passenger bookings cancelled with full-refund handling.',
                'trip' => $trip->fresh(),
                'cancelled_passengers' => $result['cancelled_passengers'],
                'refund_pending' => $result['refund_pending'],
            ]);
        }

        if (in_array($trip->status, ['COMPLETED', 'CANCELLED'], true)) {
            return response()->json(['message' => 'Trip is already completed or cancelled.'], 409);
        }

        $waiveFee = (bool) ($data['waive_fee'] ?? false);
        if ($waiveFee) {
            $trip->cancellation_fee_amount = 0.0;
            $trip->save();
        }

        $cancelledBy = $data['cancelled_by'] ?? AutoRefundService::BY_OPERATOR;
        $reason = $data['reason'];

        $tripStateMachine->transition($trip, 'CANCELLED', [
            'cancelled_reason' => $reason,
            'cancelled_by' => $cancelledBy,
        ]);

        $shuttleRefunds->markCancelledForTrip($trip->fresh(), $reason);

        // In-app notifications
        if ($trip->driver_id) {
            $notifier->notifyUserId(
                $trip->driver_id,
                'trip_cancelled_by_admin',
                'Trip cancelled',
                "Trip #{$trip->id} was cancelled by operator. Reason: {$reason}",
                ['trip_id' => $trip->id],
                'close-circle-outline',
            );
        }
        if ($trip->customer_id) {
            $notifier->notifyUserId(
                $trip->customer_id,
                'trip_cancelled_by_admin',
                'Trip cancelled',
                "Your trip #{$trip->id} was cancelled by operator. Reason: {$reason}",
                ['trip_id' => $trip->id],
                'close-circle-outline',
            );
        }

        return response()->json([
            'message' => 'Trip cancelled successfully.',
            'trip' => $trip->fresh(),
        ]);
    }

    /**
     * Change drop destination from admin panel with scope-aware validations and metered fare recalculation.
     */
    public function changeDrop(
        Request $request,
        Trip $trip,
        FareEstimationService $fareEstimationService,
        DynamicPricingService $dynamicPricingService,
        GeoService $geo,
        NotificationCenter $notifier,
    ) {
        ManagerScope::assertCityAllowed((int) $trip->city_id);

        $data = $request->validate([
            'drop_stop_id' => ['nullable', 'integer', 'exists:route_stops,id'],
            'drop_lat' => ['nullable', 'numeric', 'between:-90,90'],
            'drop_lng' => ['nullable', 'numeric', 'between:-180,180'],
            'drop_address' => ['nullable', 'string', 'max:500'],
        ]);

        if (in_array($trip->status, ['COMPLETED', 'CANCELLED'], true)) {
            return response()->json(['message' => 'Cannot change drop destination for a finished trip.'], 409);
        }

        $result = DB::transaction(function () use ($request, $trip, $data, $fareEstimationService, $dynamicPricingService, $geo) {
            $lockedTrip = Trip::query()->whereKey($trip->id)->lockForUpdate()->firstOrFail();

            if (in_array($lockedTrip->status, ['COMPLETED', 'CANCELLED'], true)) {
                return response()->json(['message' => 'Cannot change drop destination for a finished trip.'], 409);
            }

            $departureId = $lockedTrip->route_departure_id;
            $lockedDeparture = $departureId
                ? RouteDeparture::query()->whereKey($departureId)->lockForUpdate()->first()
                : null;

            if (!empty($data['drop_stop_id'])) {
                $stop = RouteStop::query()->findOrFail((int) $data['drop_stop_id']);
                
                $routeId = (int) ($lockedTrip->route_id ?: $lockedDeparture?->route_id);
                if ($routeId && (int) $stop->route_id !== $routeId) {
                    return response()->json(['message' => 'The selected drop stop does not belong to the same route.'], 422);
                }

                if (!$stop->is_drop) {
                    return response()->json(['message' => 'The selected stop is not designated as a drop stop.'], 422);
                }

                if (!$stop->is_active || $stop->is_temporarily_unavailable) {
                    return response()->json(['message' => 'The selected drop stop is currently unavailable.'], 422);
                }

                $reachedSeq = (int) ($lockedDeparture?->fixed_last_reached_stop_seq ?? 0);
                if ($reachedSeq > 0 && (int) $stop->seq <= $reachedSeq) {
                    return response()->json(['message' => 'The vehicle has already reached or passed this stop.'], 422);
                }

                if ($lockedTrip->pickup_stop_id) {
                    $boardStop = RouteStop::query()->find($lockedTrip->pickup_stop_id);
                    if ($boardStop && (int) $stop->seq <= (int) $boardStop->seq) {
                        return response()->json(['message' => 'Drop stop must be after the pickup stop.'], 422);
                    }
                }

                $newDropLat = (float) $stop->lat;
                $newDropLng = (float) $stop->lng;
                $dropAddress = $stop->name;
            } else {
                if (!isset($data['drop_lat']) || !isset($data['drop_lng'])) {
                    return response()->json(['message' => 'Coordinates or a valid route stop must be provided.'], 422);
                }
                $newDropLat = (float) $data['drop_lat'];
                $newDropLng = (float) $data['drop_lng'];
                $dropAddress = $data['drop_address'] ?? null;
            }

            $pickupLat = (float) $lockedTrip->pickup_lat;
            $pickupLng = (float) $lockedTrip->pickup_lng;

            // Minimum distance check between pickup and drop
            if ($pickupLat && $pickupLng) {
                $distFromPickup = $geo->haversineMeters($pickupLat, $pickupLng, $newDropLat, $newDropLng);
                if ($distFromPickup < 50) {
                    return response()->json(['message' => 'Drop location cannot be the same as the pickup location.'], 422);
                }
            }

            // If in-progress, check against driver's current position
            if (in_array($lockedTrip->status, ['EN_ROUTE_DROP', 'ARRIVED_DROP'], true)) {
                $driverLoc = DriverLocation::query()
                    ->where('trip_id', $lockedTrip->id)
                    ->orderByDesc('recorded_at')
                    ->first(['lat', 'lng']);
                if ($driverLoc && $driverLoc->lat !== null && $driverLoc->lng !== null) {
                    $distFromDriver = $geo->haversineMeters((float) $driverLoc->lat, (float) $driverLoc->lng, $newDropLat, $newDropLng);
                    if ($distFromDriver < 50) {
                        return response()->json(['message' => 'Drop location is too close to driver current position.'], 422);
                    }
                }
            }

            // City geofence check (Local non-shared rides only)
            $isLocal = ($lockedTrip->scope === 'local' || !$lockedTrip->scope) && !$lockedTrip->isShared() && !$lockedTrip->outstation_package_id;
            if ($isLocal && $lockedTrip->city_id) {
                $city = City::query()->find($lockedTrip->city_id);
                if ($city && !empty($city->boundary_polygon) && OperatorSetting::instance()->check_destination_outside_geofence) {
                    $inside = $dynamicPricingService->pointInPolygon($newDropLat, $newDropLng, $city->boundary_polygon);
                    if (!$inside) {
                        return response()->json(['message' => 'Drop location is outside the service area for ' . $city->name . '.'], 422);
                    }
                }
            }

            // Fare recalculation:
            // - Fixed corridor / shared: flat fare remains unchanged
            // - Outstation package: base package fare remains unchanged
            // - Local metered: recalculate estimated / final fare
            if ($isLocal && $lockedTrip->city_vehicle_type_id) {
                $pricingRule = $lockedTrip->pricing_rule_id
                    ? PricingRule::query()->find($lockedTrip->pricing_rule_id)
                    : PricingRule::resolveFor($lockedTrip->city_vehicle_type_id);

                if ($pricingRule) {
                    $fareInput = $fareEstimationService->fareInput($pricingRule->toArray(), $lockedTrip->outstation_package_id);
                    $estimate = $fareEstimationService->estimateFare(
                        $fareInput,
                        $pickupLat,
                        $pickupLng,
                        $newDropLat,
                        $newDropLng,
                        null,
                        null,
                        null,
                        null,
                        (float) ($lockedTrip->toll_amount ?? 0),
                    );
                    $lockedTrip->estimated_fare = $estimate['estimated_fare'];
                    if ($lockedTrip->status === 'EN_ROUTE_DROP' && $lockedTrip->final_fare !== null) {
                        $lockedTrip->final_fare = $estimate['estimated_fare'];
                    }
                }
            }

            $lockedTrip->drop_lat = $newDropLat;
            $lockedTrip->drop_lng = $newDropLng;
            if ($dropAddress) {
                $lockedTrip->drop_address = $dropAddress;
            }
            $lockedTrip->save();

            return [
                'trip' => $lockedTrip->fresh(),
                'drop_lat' => $newDropLat,
                'drop_lng' => $newDropLng,
                'drop_address' => $lockedTrip->drop_address,
            ];
        });

        if ($result instanceof \Illuminate\Http\JsonResponse) {
            return $result;
        }

        $freshTrip = $result['trip'];
        $newDropLat = $result['drop_lat'];
        $newDropLng = $result['drop_lng'];

        // In-app & push notifications dispatched strictly after commit
        $addrText = $freshTrip->drop_address ?: 'new location';
        if ($freshTrip->driver_id) {
            $notifier->notifyUserId(
                $freshTrip->driver_id,
                'trip_destination_updated',
                'Destination updated',
                "Operator updated the drop location to {$addrText}.",
                [
                    'trip_id' => $freshTrip->id,
                    'drop_lat' => $newDropLat,
                    'drop_lng' => $newDropLng,
                    'drop_address' => $freshTrip->drop_address,
                ],
                'navigate-outline',
                true,
            );
        }
        if ($freshTrip->customer_id) {
            $notifier->notifyUserId(
                $freshTrip->customer_id,
                'trip_destination_updated',
                'Destination updated',
                "Your drop location was updated to {$addrText}.",
                [
                    'trip_id' => $freshTrip->id,
                    'drop_lat' => $newDropLat,
                    'drop_lng' => $newDropLng,
                    'drop_address' => $freshTrip->drop_address,
                ],
                'navigate-outline',
                true,
            );
        }

        return response()->json([
            'message' => 'Drop location updated successfully.',
            'trip' => $freshTrip,
        ]);
    }

    /**
     * Change drop stop for an individual passenger booking on a shared / fixed departure.
     * Enforces route membership, drop eligibility, vehicle progress, and atomic per-leg seat/luggage capacity checks.
     */
    public function changePassengerDrop(
        Request $request,
        Trip $trip,
        SeatReservation $passenger,
        NotificationCenter $notifier,
    ) {
        ManagerScope::assertCityAllowed((int) $trip->city_id);

        if ($passenger->trip_id && (int) $passenger->trip_id !== (int) $trip->id) {
            abort(404);
        }
        if ($trip->route_departure_id && (int) $passenger->route_departure_id !== (int) $trip->route_departure_id) {
            abort(404);
        }

        if (in_array($trip->status, ['COMPLETED', 'CANCELLED'], true)) {
            return response()->json(['message' => 'Cannot change drop destination for a finished or cancelled trip.'], 409);
        }

        if (in_array($passenger->status, ['COMPLETED', 'DROPPED', 'CANCELLED', 'NO_SHOW'], true)) {
            return response()->json(['message' => 'Cannot change drop stop for a finished or cancelled passenger booking.'], 409);
        }

        $data = $request->validate([
            'drop_stop_id' => ['required', 'integer', 'exists:route_stops,id'],
        ]);

        $result = DB::transaction(function () use ($request, $trip, $passenger, $data) {
            // Lock trip, departure, and passenger
            $lockedTrip = Trip::query()->whereKey($trip->id)->lockForUpdate()->firstOrFail();
            $lockedPassenger = SeatReservation::query()->whereKey($passenger->id)->lockForUpdate()->firstOrFail();

            if (in_array($lockedTrip->status, ['COMPLETED', 'CANCELLED'], true)) {
                return response()->json(['message' => 'Cannot change drop destination for a finished or cancelled trip.'], 409);
            }

            if (in_array($lockedPassenger->status, ['COMPLETED', 'DROPPED', 'CANCELLED', 'NO_SHOW'], true)) {
                return response()->json(['message' => 'Cannot change drop stop for a finished or cancelled passenger booking.'], 409);
            }

            $departureId = $lockedPassenger->route_departure_id ?: $lockedTrip->route_departure_id;
            $lockedDeparture = $departureId
                ? RouteDeparture::query()->whereKey($departureId)->lockForUpdate()->first()
                : null;

            $routeId = (int) ($lockedPassenger->route_id ?: $lockedDeparture?->route_id ?: $lockedTrip->route_id);
            $newStop = RouteStop::query()->findOrFail((int) $data['drop_stop_id']);

            // 1. Enforce that the stop belongs to the same route
            if ((int) $newStop->route_id !== $routeId) {
                return response()->json(['message' => 'The selected drop stop does not belong to the same route.'], 422);
            }

            // 1a. Enforce that the stop is designated as a drop stop
            if (!$newStop->is_drop) {
                return response()->json(['message' => 'The selected stop is not designated as a drop stop.'], 422);
            }

            // 1b. Enforce that the stop is active and not temporarily unavailable
            if (!$newStop->is_active || $newStop->is_temporarily_unavailable) {
                return response()->json(['message' => 'The selected drop stop is currently unavailable.'], 422);
            }

            // Validate sequence: new drop stop must be after boarding stop
            if ($lockedPassenger->board_stop_id) {
                $boardStop = RouteStop::query()->find($lockedPassenger->board_stop_id);
                if ($boardStop && (int) $newStop->seq <= (int) $boardStop->seq) {
                    return response()->json(['message' => 'Drop stop must be after the pickup stop.'], 422);
                }
            }

            // 1c. Enforce that the stop is ahead of the vehicle
            $reachedSeq = (int) ($lockedDeparture?->fixed_last_reached_stop_seq ?? 0);
            if ($reachedSeq > 0 && (int) $newStop->seq <= $reachedSeq) {
                return response()->json(['message' => 'The vehicle has already reached or passed this stop.'], 422);
            }

            // 2. Check seat and luggage capacity on every affected leg (including zero luggage capacity)
            if ($lockedDeparture) {
                $capacity = (int) ($lockedDeparture->capacity ?: 4);
                $luggageCapacity = (int) ($lockedDeparture->luggage_capacity ?? 0);
                $passengerSeats = max(1, (int) $lockedPassenger->seats);
                $passengerLuggage = max(0, (int) ($lockedPassenger->extra_luggage_count ?? 0));
                $startSeq = $lockedPassenger->board_stop_id
                    ? (int) (RouteStop::query()->whereKey($lockedPassenger->board_stop_id)->value('seq') ?? 1)
                    : 1;
                $effectiveStartSeq = max($startSeq, $reachedSeq);

                for ($s = $effectiveStartSeq; $s < (int) $newStop->seq; $s++) {
                    $otherReserved = SeatReservation::query()
                        ->join('route_stops as bs', 'bs.id', '=', 'seat_reservations.board_stop_id')
                        ->join('route_stops as ds', 'ds.id', '=', 'seat_reservations.drop_stop_id')
                        ->where('seat_reservations.route_departure_id', $lockedDeparture->id)
                        ->where('seat_reservations.id', '!=', $lockedPassenger->id)
                        ->whereIn('seat_reservations.status', SeatReservation::ACTIVE_STATUSES)
                        ->where('bs.seq', '<=', $s)
                        ->where('ds.seq', '>=', $s + 1)
                        ->selectRaw('COALESCE(SUM(seat_reservations.seats), 0) as total_seats, COALESCE(SUM(seat_reservations.extra_luggage_count), 0) as total_luggage')
                        ->first();

                    $otherSeats = (int) ($otherReserved->total_seats ?? 0);
                    $otherLuggage = (int) ($otherReserved->total_luggage ?? 0);

                    $held = FixedSeatHold::query()
                        ->join('route_stops as bs', 'bs.id', '=', 'fixed_seat_holds.board_stop_id')
                        ->join('route_stops as ds', 'ds.id', '=', 'fixed_seat_holds.drop_stop_id')
                        ->where('fixed_seat_holds.route_departure_id', $lockedDeparture->id)
                        ->whereIn('fixed_seat_holds.status', FixedAvailabilityService::ACTIVE_HOLD_STATUSES)
                        ->where('fixed_seat_holds.expires_at', '>', now())
                        ->where('bs.seq', '<=', $s)
                        ->where('ds.seq', '>=', $s + 1)
                        ->selectRaw('COALESCE(SUM(fixed_seat_holds.seats), 0) as total_seats, COALESCE(SUM(fixed_seat_holds.extra_luggage_count), 0) as total_luggage')
                        ->first();

                    $heldSeats = (int) ($held->total_seats ?? 0);
                    $heldLuggage = (int) ($held->total_luggage ?? 0);

                    $totalOccupiedSeats = $otherSeats + $heldSeats + $passengerSeats;
                    if ($totalOccupiedSeats > $capacity) {
                        $availableSeats = max(0, $capacity - ($otherSeats + $heldSeats));
                        return response()->json([
                            'message' => "Insufficient seat capacity on route leg (Stop #{$s} to Stop #" . ($s + 1) . "). Only {$availableSeats} seat(s) available.",
                        ], 422);
                    }

                    // Strict luggage capacity check (enforced even when capacity is 0)
                    $totalOccupiedLuggage = $otherLuggage + $heldLuggage + $passengerLuggage;
                    if ($totalOccupiedLuggage > $luggageCapacity) {
                        $availableLuggage = max(0, $luggageCapacity - ($otherLuggage + $heldLuggage));
                        return response()->json([
                            'message' => "Insufficient luggage capacity on route leg (Stop #{$s} to Stop #" . ($s + 1) . "). Only {$availableLuggage} luggage space(s) available.",
                        ], 422);
                    }
                }
            }

            // 3. Save updates atomically (preserving fare and payment)
            $lockedPassenger->drop_stop_id = $newStop->id;
            $lockedPassenger->drop_lat = (float) $newStop->lat;
            $lockedPassenger->drop_lng = (float) $newStop->lng;
            $lockedPassenger->drop_address = $newStop->name;
            $lockedPassenger->save();

            if ($lockedTrip->route_departure_id === $lockedPassenger->route_departure_id && (int) $lockedTrip->customer_id === (int) $lockedPassenger->customer_id) {
                $lockedTrip->drop_lat = (float) $newStop->lat;
                $lockedTrip->drop_lng = (float) $newStop->lng;
                $lockedTrip->drop_address = $newStop->name;
                $lockedTrip->save();
            }

            return [
                'passenger' => $lockedPassenger->fresh(['boardStop', 'dropStop', 'customer']),
                'trip' => $lockedTrip->fresh(),
                'newStop' => $newStop,
            ];
        });

        if ($result instanceof \Illuminate\Http\JsonResponse) {
            return $result;
        }

        $freshPassenger = $result['passenger'];
        $freshTrip = $result['trip'];
        $newStop = $result['newStop'];

        // In-app & push notifications dispatched strictly after successful commit
        $customerName = $freshPassenger->customer?->name ?: 'Customer';
        if ($freshTrip->driver_id) {
            $notifier->notifyUserId(
                $freshTrip->driver_id,
                'passenger_destination_updated',
                'Passenger drop updated',
                "Operator updated {$customerName}'s drop to Stop #{$newStop->seq}: {$newStop->name}.",
                [
                    'trip_id' => $freshTrip->id,
                    'reservation_id' => $freshPassenger->id,
                    'drop_stop_id' => $newStop->id,
                    'drop_name' => $newStop->name,
                    'drop_lat' => (float) $newStop->lat,
                    'drop_lng' => (float) $newStop->lng,
                ],
                'navigate-outline',
                true,
            );
        }
        if ($freshPassenger->customer_id) {
            $notifier->notifyUserId(
                $freshPassenger->customer_id,
                'trip_destination_updated',
                'Destination updated',
                "Your drop stop was updated to Stop #{$newStop->seq}: {$newStop->name}.",
                [
                    'trip_id' => $freshTrip->id,
                    'reservation_id' => $freshPassenger->id,
                    'drop_stop_id' => $newStop->id,
                    'drop_name' => $newStop->name,
                    'drop_lat' => (float) $newStop->lat,
                    'drop_lng' => (float) $newStop->lng,
                ],
                'navigate-outline',
                true,
            );
        }

        return response()->json([
            'message' => "Passenger drop updated to Stop #{$newStop->seq} ({$newStop->name}).",
            'passenger' => $freshPassenger,
        ]);
    }

    /**
     * Cancel an individual passenger booking on a shared / fixed departure trip.
     * Initiates 100% full refund and releases seat/luggage capacity.
     */
    public function cancelPassenger(
        Request $request,
        Trip $trip,
        SeatReservation $passenger,
        FixedRefundService $refundService,
    ) {
        ManagerScope::assertCityAllowed((int) $trip->city_id);

        if ($passenger->trip_id && (int) $passenger->trip_id !== (int) $trip->id) {
            abort(404);
        }
        if ($trip->route_departure_id && (int) $passenger->route_departure_id !== (int) $trip->route_departure_id) {
            abort(404);
        }

        if (in_array($trip->status, ['COMPLETED', 'CANCELLED'], true)) {
            return response()->json(['message' => 'Cannot cancel passenger on a finished or cancelled trip.'], 409);
        }

        if (in_array($passenger->status, ['COMPLETED', 'DROPPED', 'CANCELLED', 'NO_SHOW'], true)) {
            return response()->json(['message' => 'Cannot cancel a finished or already cancelled passenger booking.'], 409);
        }

        $data = $request->validate([
            'reason' => ['nullable', 'string', 'max:500'],
        ]);

        $detail = 'Admin cancelled this passenger booking. Full refund was initiated.';
        if (!empty($data['reason'])) {
            $detail .= ' Reason: ' . trim($data['reason']);
        }

        $updated = $refundService->cancelBySystem($passenger, 'admin_passenger_cancelled', $request->user(), $detail);

        return response()->json([
            'message' => 'Passenger booking cancelled with full-refund handling.',
            'passenger' => $updated,
            'refund_pending' => $updated->refund_status === 'APPROVED',
        ]);
    }
}
