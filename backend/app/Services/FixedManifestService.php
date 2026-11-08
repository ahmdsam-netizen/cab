<?php

namespace App\Services;

use App\Models\CitySetting;
use App\Models\DepartureSeat;
use App\Models\FixedSeatHold;
use App\Models\RouteDeparture;
use App\Models\SeatReservation;

class FixedManifestService
{
    public function __construct(
        private readonly FixedAvailabilityService $availability,
        private readonly FixedBookingService $bookings,
    ) {}

    public function manifest(RouteDeparture $departure): array
    {
        $this->availability->assertFixedDeparture($departure);
        $departure->loadMissing([
            'route.stops' => fn ($q) => $q->orderBy('seq'),
            'driver:id,name',
            'cityVehicleType:id,display_name',
            'driver.driver:id,user_id,vehicle_type,vehicle_model',
        ]);

        $route = $departure->route;
        $legacySettings = is_array($route?->fixed_settings_json) ? $route->fixed_settings_json : [];
        $cityId = $route?->city_id ?: ($route?->origin_city_id ?: ($departure->driver?->city_id ?: null));
        $citySettings = $cityId ? CitySetting::query()->where('city_id', $cityId)->first() : null;
        if (!$citySettings) {
            $citySettings = CitySetting::query()->first();
        }

        $driverRadius = (int) ($citySettings?->fixed_stop_arrival_radius_m ?? ($legacySettings['stop_arrival_radius_m'] ?? 150));
        $approachingRadius = max($driverRadius, (int) ($citySettings?->fixed_vehicle_approaching_alert_radius_m ?? ($legacySettings['vehicle_approaching_alert_radius_m'] ?? 500)));
        $customerRadius = (int) ($citySettings?->fixed_customer_pickup_radius_m ?? ($legacySettings['customer_pickup_radius_m'] ?? 150));
        $arrivalDwellSeconds = max(0, (int) ($citySettings?->fixed_stop_arrival_dwell_seconds ?? ($legacySettings['stop_arrival_dwell_seconds'] ?? 20)));
        $waitMinutes = $route ? FixedNoShowPolicy::waitMinutes($route, $citySettings) : FixedNoShowPolicy::MIN_WAIT_MINUTES;
        $customerGraceMinutes = max(0, (int) ($citySettings?->fixed_customer_grace_minutes ?? ($legacySettings['customer_grace_minutes'] ?? 2)));
        $driverMissedGraceMinutes = max(0, (int) ($citySettings?->fixed_driver_missed_stop_grace_minutes ?? ($legacySettings['driver_missed_stop_grace_minutes'] ?? 3)));

        // Map reservation_id → sorted seat labels (M6 — driver sees "2A, 2B"
        // next to the passenger name).
        $labelsByReservation = DepartureSeat::query()
            ->where('route_departure_id', $departure->id)
            ->whereNotNull('seat_reservation_id')
            ->orderBy('label')
            ->get(['seat_reservation_id', 'label'])
            ->groupBy('seat_reservation_id')
            ->map(fn ($rows) => $rows->pluck('label')->all());

        $passengers = SeatReservation::query()
            ->where('route_departure_id', $departure->id)
            ->whereHas('route', fn ($q) => $q->where('mode', 'fixed'))
            ->with([
                'customer:id,name,phone,avatar_path,current_lat,current_lng,current_location_updated_at',
                'boardStop:id,name,lat,lng,seq',
                'dropStop:id,name,lat,lng',
            ])
            ->orderBy('id')
            ->get()
            ->map(fn (SeatReservation $reservation) => [
                'id' => $reservation->id,
                'customer_name' => $reservation->customer?->name,
                'customer_phone' => $reservation->customer?->phone,
                'customer_avatar_url' => $reservation->customer?->avatar_path
                    ? (str_starts_with($reservation->customer->avatar_path, 'http')
                        ? $reservation->customer->avatar_path
                        : url('/storage/' . ltrim($reservation->customer->avatar_path, '/')))
                    : null,
                'customer_lat' => $reservation->customer?->current_lat !== null ? (float) $reservation->customer->current_lat : null,
                'customer_lng' => $reservation->customer?->current_lng !== null ? (float) $reservation->customer->current_lng : null,
                'customer_location_updated_at' => optional($reservation->customer?->current_location_updated_at)->toIso8601String(),
                'seats' => (int) $reservation->seats,
                'seat_labels' => !empty($reservation->seat_labels) ? (array) $reservation->seat_labels : $labelsByReservation->get($reservation->id, []),
                'status' => $reservation->status,
                'boarded_at' => optional($reservation->boarded_at)->toIso8601String(),
                'fixed_live_status' => $this->bookings->fixedLiveStatus($reservation),
                'no_show_unlock_at' => optional(FixedNoShowPolicy::unlockAt($reservation, $departure, $waitMinutes))->toIso8601String(),
                'refund_status' => $reservation->refund_status,
                'fixed_auto_outcome' => $reservation->fixed_auto_outcome,
                'payment_status' => $reservation->payment_status,
                'fare_amount' => $reservation->fare_amount !== null ? (float) $reservation->fare_amount : null,
                'board_stop_id' => $reservation->board_stop_id,
                'drop_stop_id' => $reservation->drop_stop_id,
                'board' => $reservation->board_address ?: $reservation->boardStop?->name,
                'board_lat' => $reservation->board_lat !== null ? (float) $reservation->board_lat : ($reservation->boardStop?->lat !== null ? (float) $reservation->boardStop->lat : null),
                'board_lng' => $reservation->board_lng !== null ? (float) $reservation->board_lng : ($reservation->boardStop?->lng !== null ? (float) $reservation->boardStop->lng : null),
                'drop' => $reservation->drop_address ?: $reservation->dropStop?->name,
                'drop_lat' => $reservation->drop_lat !== null ? (float) $reservation->drop_lat : ($reservation->dropStop?->lat !== null ? (float) $reservation->dropStop->lat : null),
                'drop_lng' => $reservation->drop_lng !== null ? (float) $reservation->drop_lng : ($reservation->dropStop?->lng !== null ? (float) $reservation->dropStop->lng : null),
            ]);

        $firstStop = $departure->route?->stops?->sortBy('seq')->first();
        $lastStop = $departure->route?->stops?->sortBy('seq')->last();
        $originRaw = trim((string) ($departure->route?->origin_name ?? ''));
        $destRaw = trim((string) ($departure->route?->dest_name ?? ''));
        $originName = ($originRaw !== '' && strtolower($originRaw) !== 'origin') ? $originRaw : ($firstStop?->name ?: 'Origin');
        $destName = ($destRaw !== '' && strtolower($destRaw) !== 'destination') ? $destRaw : ($lastStop?->name ?: 'Destination');

        $requestedPlatform = request()?->header('X-Platform', 'android') ?? 'android';
        $imageService = app(\App\Services\VehicleFamilyImageService::class);
        $identity = app(FixedDepartureVehicleService::class)->identity($departure);
        $driverProfile = $departure->driver?->driver;
        $vtName = $identity['vehicle_name']
            ?: ($departure->cityVehicleType?->display_name
            ?: ($driverProfile?->vehicle_model ?: ($driverProfile?->vehicle_type ?: '')));
        $imagePayload = $imageService->resolveForVehicle(
            $cityId,
            $vtName,
            $requestedPlatform
        );

        return [
            'departure' => [
                'id' => $departure->id,
                'route_id' => $departure->route_id,
                'route_name' => $departure->route?->name,
                'origin_name' => $originName,
                'dest_name' => $destName,
                'service_date' => optional($departure->service_date)->toDateString(),
                'depart_at' => optional($departure->depart_at)->toIso8601String(),
                'announced_depart_at' => optional($departure->announced_depart_at)->toIso8601String(),
                'capacity' => (int) $departure->capacity,
                'seats_taken' => (int) $departure->seats_taken,
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
                'active_hold_count' => FixedSeatHold::query()
                    ->where('route_departure_id', $departure->id)
                    ->where('status', 'HELD')
                    ->where('expires_at', '>', now())
                    ->count(),
                'reservation_count' => SeatReservation::query()
                    ->where('route_departure_id', $departure->id)
                    ->whereNotIn('status', ['CANCELLED', 'NO_SHOW'])
                    ->count(),
                'total_reservation_count' => SeatReservation::query()
                    ->where('route_departure_id', $departure->id)
                    ->count(),
                'seats_remaining' => $this->availability->seatsRemaining($departure),
                'fixed_last_reached_stop_seq' => $departure->fixed_last_reached_stop_seq,
                'fixed_last_reached_stop_at' => optional($departure->fixed_last_reached_stop_at)->toIso8601String(),
                'status' => $departure->status,
            ],
            'stops' => $departure->route?->stops?->map(fn ($stop) => [
                'id' => $stop->id,
                'seq' => (int) $stop->seq,
                'name' => $stop->name,
                'lat' => $stop->lat !== null ? (float) $stop->lat : null,
                'lng' => $stop->lng !== null ? (float) $stop->lng : null,
                'is_pickup' => (bool) $stop->is_pickup,
                'is_drop' => (bool) $stop->is_drop,
                'is_active' => (bool) $stop->is_active,
                'is_temporarily_unavailable' => (bool) $stop->is_temporarily_unavailable,
            ])->values() ?? [],
            'passengers' => $passengers,
            'city_settings' => [
                'fixed_waiting_time_per_stop_minutes' => $waitMinutes,
                'fixed_stop_arrival_radius_m' => $driverRadius,
                'fixed_stop_arrival_dwell_seconds' => $arrivalDwellSeconds,
                'fixed_driver_missed_stop_grace_minutes' => $driverMissedGraceMinutes,
                'fixed_customer_pickup_radius_m' => $customerRadius,
                'fixed_vehicle_approaching_alert_radius_m' => $approachingRadius,
                'fixed_customer_grace_minutes' => $customerGraceMinutes,
            ],
        ];
    }
}
