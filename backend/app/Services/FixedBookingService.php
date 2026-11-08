<?php

namespace App\Services;

use App\Models\DepartureSeat;
use App\Models\FixedSeatHold;
use App\Models\DriverLocation;
use App\Models\Driver;
use App\Models\SeatReservation;
use App\Models\User;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Cache;

class FixedBookingService
{
    public function myBookings(User $customer, int $page = 1, int $perPage = 50): array
    {
        $perPage = max(1, min($perPage, 50));
        $page = max(1, $page);

        $paginator = SeatReservation::query()
            ->where('customer_id', $customer->id)
            ->whereHas('route', fn ($q) => $q->where('mode', 'fixed'))
            ->with([
                'route:id,name,scope,mode',
                'routeDeparture:id,route_id,trip_id,driver_id,city_vehicle_type_id,vehicle_snapshot,service_date,depart_at,announced_depart_at,status,capacity,seats_taken,luggage_capacity,luggage_taken,fixed_last_reached_stop_seq,fixed_last_reached_stop_at',
                'routeDeparture.driver:id,name,phone',
                'routeDeparture.cityVehicleType:id,display_name,vehicle_type_id',
                'routeDeparture.cityVehicleType.vehicleType:id,name',
                'boardStop:id,name,lat,lng',
                'dropStop:id,name,lat,lng',
            ])
            ->orderByDesc('id')
            ->paginate($perPage, ['*'], 'page', $page);

        return [
            'data' => $paginator->getCollection()
                ->map(fn (SeatReservation $reservation) => $this->shapeBooking($reservation))
                ->values(),
            'meta' => [
                'current_page' => $paginator->currentPage(),
                'per_page' => $paginator->perPage(),
                'total' => $paginator->total(),
                'last_page' => $paginator->lastPage(),
                'has_more' => $paginator->hasMorePages(),
            ],
        ];
    }

    public function booking(User $customer, SeatReservation $reservation): array
    {
        if ((int) $reservation->customer_id !== (int) $customer->id || $reservation->route?->mode !== 'fixed') {
            abort(404);
        }

        $reservation->loadMissing([
            'route:id,name,scope,mode',
            'route.stops' => fn ($q) => $q->orderBy('seq'),
            'routeDeparture:id,route_id,trip_id,driver_id,city_vehicle_type_id,vehicle_snapshot,service_date,depart_at,announced_depart_at,status,capacity,seats_taken,luggage_capacity,luggage_taken,fixed_last_reached_stop_seq,fixed_last_reached_stop_at',
            'routeDeparture.driver:id,name,phone',
            'routeDeparture.cityVehicleType:id,display_name,vehicle_type_id',
            'routeDeparture.cityVehicleType.vehicleType:id,name',
            'boardStop:id,name,lat,lng',
            'dropStop:id,name,lat,lng',
        ]);

        return $this->shapeBooking($reservation);
    }

    public function shapeSeatHold(FixedSeatHold $hold): array
    {
        $hold->loadMissing(['heldSeats', 'boardStop', 'dropStop', 'routeDeparture.driver', 'customer', 'couponAssignment.coupon']);

        return [
            'id' => $hold->id,
            'route_departure_id' => $hold->route_departure_id,
            'driver_id' => $hold->routeDeparture?->driver_id,
            'driver_name' => $hold->routeDeparture?->driver?->name,
            'customer_id' => $hold->customer_id,
            'customer_name' => $hold->customer?->name,
            'board_stop_id' => $hold->board_stop_id,
            'board_stop_name' => $hold->boardStop?->name,
            'board_name' => $hold->boardStop?->name,
            'board_stop' => $hold->boardStop?->name,
            'drop_stop_id' => $hold->drop_stop_id,
            'drop_stop_name' => $hold->dropStop?->name,
            'drop_name' => $hold->dropStop?->name,
            'drop_stop' => $hold->dropStop?->name,
            'route_id' => $hold->routeDeparture?->route_id,
            'route_name' => $hold->routeDeparture?->route?->name,
            'seats' => (int) $hold->seats,
            'seat_labels' => $hold->heldSeats->pluck('label')->values()->all(),
            'amount' => (float) $hold->amount,
            'original_amount' => $hold->original_amount !== null ? (float) $hold->original_amount : (float) $hold->amount,
            'discount_amount' => $hold->discount_amount !== null ? (float) $hold->discount_amount : 0.0,
            'coupon_assignment_id' => $hold->coupon_assignment_id,
            'coupon_title' => $hold->couponAssignment?->coupon?->title,
            'coupon_editable' => $hold->status === 'ACCEPTED' && $hold->expires_at?->isFuture()
                && !$hold->razorpay_order_id && !$hold->razorpay_payment_id && !$hold->payment_reference,
            'has_extra_luggage' => (bool) $hold->has_extra_luggage,
            'extra_luggage_count' => (int) $hold->extra_luggage_count,
            'luggage_surcharge_amount' => (float) $hold->luggage_surcharge_amount,
            'status' => $hold->status,
            'expires_at' => optional($hold->expires_at)->toIso8601String(),
            'payment_reference' => $hold->payment_reference,
        ];
    }

    public function shapeBooking(SeatReservation $reservation): array
    {
        $reservation->loadMissing([
            'routeDeparture.cityVehicleType:id,display_name',
            'routeDeparture.route:id,city_id,origin_city_id',
            'route:id,city_id,origin_city_id',
        ]);
        $departure = $reservation->routeDeparture;
        $identity = $departure ? app(FixedDepartureVehicleService::class)->identity($departure) : null;
        $driverProfile = $departure?->driver_id
            ? Driver::query()
                ->where('user_id', $departure->driver_id)
                ->with(['cityVehicleType:id,display_name', 'vehicleType:id,name'])
                ->first(['user_id', 'city_id', 'city_vehicle_type_id', 'vehicle_type_id', 'vehicle_type', 'vehicle_brand', 'vehicle_model', 'vehicle_color', 'vehicle_reg_no'])
            : null;

        $cityId = $departure?->route?->city_id
            ?: ($departure?->route?->origin_city_id
                ?: ($reservation->route?->city_id
                    ?: ($driverProfile?->city_id ?: null)));

        $familyName = $identity['vehicle_name'] ?? $departure?->cityVehicleType?->display_name
            ?: ($driverProfile?->cityVehicleType?->display_name
                ?: ($driverProfile?->vehicleType?->name
                    ?: ($driverProfile?->vehicle_type ?: '')));

        $requestedPlatform = request()?->header('X-Platform', 'android') ?? 'android';
        $imageService = app(\App\Services\VehicleFamilyImageService::class);
        $imagePayload = $imageService->resolveForVehicle($cityId, $familyName, $requestedPlatform);

        $latestDriverLocation = null;
        $driverLocationStale = false;
        if ($departure?->driver_id) {
            $latestDriverLocation = DriverLocation::query()
                ->where('driver_id', $departure->driver_id)
                ->orderByDesc('recorded_at')
                ->first(['lat', 'lng', 'recorded_at']);

            if ($latestDriverLocation && optional($latestDriverLocation->recorded_at)->lt(now()->subMinutes(30))) {
                $driverLocationStale = true;
            }
        }

        return [
            'id' => $reservation->id,
            'route_id' => $reservation->route_id,
            // Frozen at booking time so renaming the route never changes the
            // name shown on past rides; falls back to the live name for any
            // legacy row without a snapshot.
            'route_name' => $reservation->route_name ?: $reservation->route?->name,
            'scope' => $reservation->route?->scope,
            'route_departure_id' => $reservation->route_departure_id,
            'trip_id' => $departure?->trip_id,
            'departure_status' => $departure?->status,
            'fixed_last_reached_stop_seq' => $departure?->fixed_last_reached_stop_seq,
            'fixed_last_reached_stop_at' => optional($departure?->fixed_last_reached_stop_at)->toIso8601String(),
            'capacity' => $departure?->capacity !== null ? (int) $departure->capacity : null,
            'seats_taken' => $departure?->seats_taken !== null ? (int) $departure->seats_taken : null,
            'luggage_capacity' => $departure?->luggage_capacity !== null ? (int) $departure->luggage_capacity : null,
            'luggage_taken' => $departure?->luggage_taken !== null ? (int) $departure->luggage_taken : null,
            'driver_name' => $departure?->driver?->name,
            'driver_phone' => $departure?->driver?->phone,
            'vehicle_name' => $identity['vehicle_name'] ?? null,
            'vehicle_type_name' => $identity['vehicle_type_name'] ?? null,
            'vehicle_brand' => $identity['vehicle_brand'] ?? null,
            'vehicle_model' => $identity['vehicle_model'] ?? null,
            'vehicle_color' => $identity['vehicle_color'] ?? null,
            'vehicle_reg_no' => $identity['vehicle_reg_no'] ?? null,
            'map_marker_url' => $imagePayload['map_marker_url'],
            'image_url' => $imagePayload['image_url'],
            'vehicle' => [
                'type' => $identity['vehicle_type_name'] ?? null,
                'brand' => $identity['vehicle_brand'] ?? null,
                'model' => $identity['vehicle_model'] ?? null,
                'color' => $identity['vehicle_color'] ?? null,
                'reg_no' => $identity['vehicle_reg_no'] ?? null,
                'image_url' => $imagePayload['image_url'],
                'map_marker_url' => $imagePayload['map_marker_url'],
            ],
            'service_date' => optional($reservation->routeDeparture?->service_date)->toDateString(),
            'depart_at' => optional($reservation->routeDeparture?->depart_at)->toIso8601String(),
            'announced_depart_at' => optional($reservation->routeDeparture?->announced_depart_at)->toIso8601String(),
            'seats' => (int) $reservation->seats,
            'seat_labels' => !empty($reservation->seat_labels)
                ? (array) $reservation->seat_labels
                : DepartureSeat::query()
                    ->where('seat_reservation_id', $reservation->id)
                    ->orderBy('label')
                    ->pluck('label')
                    ->all(),
            'status' => $reservation->status,
            // The boarding code (cached by FixedBoardingOtpService, 10-min TTL)
            // is shown on the customer's own booking screen — this is the
            // permanent delivery channel for it (no SMS). The customer reads it
            // off their screen and tells it to the driver. Null in every other
            // situation. This payload is customer-only (never driver/admin view).
            'boarding_code' => in_array($reservation->status, ['BOOKED', 'CONFIRMED'], true)
                ? Cache::get(FixedBoardingOtpService::codeCacheKey($reservation->id))
                : null,
            'fixed_live_status' => $this->fixedLiveStatus($reservation),
            'payment_method' => $reservation->payment_method,
            'payment_status' => $reservation->payment_status,
            'refund_status' => $reservation->refund_status,
            'payment_reference' => $reservation->payment_reference,
            'refund_reference' => $reservation->refund_reference,
            'refund_amount' => $reservation->refund_amount !== null ? (float) $reservation->refund_amount : null,
            'booking_channel' => $reservation->booking_channel,
            'fare_amount' => $reservation->fare_amount !== null ? (float) $reservation->fare_amount : null,
            'promo_discount_amount' => $reservation->promo_discount_amount !== null ? (float) $reservation->promo_discount_amount : 0.0,
            'coupon_assignment_id' => $reservation->coupon_assignment_id,
            'has_extra_luggage' => (bool) $reservation->has_extra_luggage,
            'extra_luggage_count' => (int) $reservation->extra_luggage_count,
            'luggage_surcharge_amount' => (float) $reservation->luggage_surcharge_amount,
            'board' => $reservation->board_address ?: $reservation->boardStop?->name,
            'drop' => $reservation->drop_address ?: $reservation->dropStop?->name,
            'board_lat' => $reservation->board_lat ?? $reservation->boardStop?->lat,
            'board_lng' => $reservation->board_lng ?? $reservation->boardStop?->lng,
            'drop_lat' => $reservation->drop_lat ?? $reservation->dropStop?->lat,
            'drop_lng' => $reservation->drop_lng ?? $reservation->dropStop?->lng,
            'latest_driver_location_stale' => $driverLocationStale,
            'latest_driver_location' => $latestDriverLocation ? [
                'lat' => (float) $latestDriverLocation->lat,
                'lng' => (float) $latestDriverLocation->lng,
                'recorded_at' => optional($latestDriverLocation->recorded_at)->toIso8601String(),
            ] : null,
            'stops' => $reservation->route?->stops?->sortBy('seq')->map(fn ($s) => [
                'id' => $s->id,
                'seq' => $s->seq,
                'name' => $s->name,
                'lat' => $s->lat !== null ? (float) $s->lat : null,
                'lng' => $s->lng !== null ? (float) $s->lng : null,
                'is_pickup' => (bool) $s->is_pickup,
                'is_drop' => (bool) $s->is_drop,
            ])->values()->all() ?? [],
            'rating_score' => $reservation->rating_score !== null ? (int) $reservation->rating_score : null,
            'rating_comment' => $reservation->rating_comment,
            'created_at' => optional($reservation->created_at)->toIso8601String(),
        ];
    }

    public function fixedLiveStatus(SeatReservation $reservation): array
    {
        $reservation->loadMissing("routeDeparture:id,status", "boardStop:id,name,lat,lng", "dropStop:id,name,lat,lng");

        $base = [
            "key" => "confirmed",
            "label" => "Booking confirmed",
            "detail" => "Your fixed ride seat is booked.",
            "tone" => "primary",
            "arrived_at" => optional($reservation->fixed_stop_arrived_at)->toIso8601String(),
            "no_show_after_at" => optional($reservation->fixed_no_show_after_at)->toIso8601String(),
            "auto_outcome" => $reservation->fixed_auto_outcome,
            "refund_status" => $reservation->refund_status,
        ];

        if ($reservation->status === "BOARDED") {
            return array_merge($base, ["key" => "boarded", "label" => "Boarded", "detail" => "You have boarded this fixed ride and are on the vehicle.", "tone" => "success"]);
        }

        if ($reservation->status === "DROPPED") {
            return array_merge($base, ["key" => "dropped", "label" => "Dropped off", "detail" => "", "tone" => "success"]);
        }

        if ($reservation->status === "COMPLETED") {
            return array_merge($base, ["key" => "completed", "label" => "Ride completed", "detail" => "This fixed ride is completed.", "tone" => "success"]);
        }

        if ($reservation->status === "NO_SHOW") {
            return array_merge($base, ["key" => "customer_no_show", "label" => "No-show", "detail" => "The driver reached your pickup stop and the waiting time expired.", "tone" => "danger"]);
        }

        if ($reservation->status === "CANCELLED" && $reservation->fixed_auto_outcome === "driver_missed_stop") {
            $detail = $reservation->refund_status === "REFUNDED"
                ? "The driver missed your pickup stop. Your Razorpay refund was processed."
                : "The driver missed your pickup stop. Refund status: " . strtolower((string) $reservation->refund_status) . ".";
            return array_merge($base, ["key" => "driver_missed_stop", "label" => "Driver missed pickup", "detail" => $detail, "tone" => "warning"]);
        }

        if ($reservation->status === "CANCELLED") {
            return array_merge($base, ["key" => "cancelled", "label" => "Booking cancelled", "detail" => "This fixed booking is cancelled.", "tone" => "medium"]);
        }

        // Everything below (approaching / arrived / leaving-soon) is only real
        // once the ride has STARTED. Until the departure is dispatched, ignore any
        // arrival timestamps — even a stale one — and report only "Booking
        // confirmed", so a customer never sees "the vehicle is waiting" right after
        // paying while the vehicle is still forming at the origin. (Bug F1)
        if (!in_array($reservation->routeDeparture?->status, ["DISPATCHED", "DEPARTED"], true)) {
            return $base;
        }

        if ($reservation->fixed_no_show_after_at) {
            $deadline = $reservation->fixed_no_show_after_at;
            if ($deadline instanceof Carbon && $deadline->isFuture()) {
                return array_merge($base, ["key" => "driver_arrived", "label" => "Driver arrived", "detail" => "The vehicle is waiting at your pickup stop.", "tone" => "warning"]);
            }
            return array_merge($base, ["key" => "leaving_soon", "label" => "Leaving soon", "detail" => "Please board now. The waiting time at your pickup stop has expired.", "tone" => "danger"]);
        }

        if ($reservation->fixed_approaching_notified_at) {
            return array_merge($base, ["key" => "vehicle_approaching", "label" => "Vehicle approaching", "detail" => "Your vehicle is near your pickup stop.", "tone" => "primary"]);
        }

        return array_merge($base, ["key" => "ride_started", "label" => "Ride started", "detail" => "Your fixed ride has started. Be ready at your selected pickup stop.", "tone" => "primary"]);
    }
}
