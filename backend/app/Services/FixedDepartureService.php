<?php

namespace App\Services;

use App\Exceptions\ReservationException;
use App\Models\City;
use App\Models\CityVehicleType;
use App\Models\FixedSeatHold;
use App\Models\Driver;
use App\Models\Route;
use App\Models\RouteDeparture;
use App\Models\SeatReservation;
use App\Models\Trip;
use App\Models\User;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;

class FixedDepartureService
{
    public function __construct(
        private readonly FixedAvailabilityService $availability,
        private readonly FixedRefundService $refunds,
        private readonly FixedBookingEventService $events,
        private readonly NotificationCenter $notifier,
        private readonly VehicleFamilyImageService $vehicleImages,
        private readonly TripStateMachineService $tripStateMachine,
    ) {}

    public function customerDepartures(Route $route): Collection
    {
        $images = $this->vehicleImages->preloadForPlatform();
        return $this->availability->customerVisibleDeparturesQuery($route)
            ->get()
            ->map(fn (RouteDeparture $departure) => $this->shapeCustomerDeparture($departure, $images));
    }

    public function adminDepartures(City $city, array $filters = []): array
    {
        $perPage = (int) ($filters['per_page'] ?? 25);
        $page = (int) ($filters['page'] ?? 1);

        $query = $this->availability->adminDeparturesQuery($city)
            ->when(isset($filters['route_id']), fn ($q) => $q->where('route_id', (int) $filters['route_id']))
            ->when(isset($filters['status']) && $filters['status'] !== 'all', function ($q) use ($filters) {
                if ($filters['status'] === 'active') {
                    $q->whereNotIn('status', ['COMPLETED', 'CANCELLED']);
                } else {
                    $q->where('status', $filters['status']);
                }
            })
            ->when(isset($filters['date_from']), fn ($q) => $q->whereDate('service_date', '>=', $filters['date_from']))
            ->when(isset($filters['date_to']), fn ($q) => $q->whereDate('service_date', '<=', $filters['date_to']))
            ->when(!empty($filters['q']), function ($q) use ($filters) {
                $term = '%' . str_replace(['%', '_'], ['\\%', '\\_'], trim((string) $filters['q'])) . '%';
                $q->where(function ($inner) use ($term) {
                    $inner->where('id', 'like', $term)
                        ->orWhereHas('route', fn ($route) => $route->where('name', 'like', $term))
                        ->orWhereHas('driver', fn ($driver) => $driver->where('name', 'like', $term));
                });
            })
            ->orderByDesc('service_date')
            ->orderBy('depart_at')
            ->orderBy('id');

        $total = (clone $query)->count();
        $rows = $query->forPage($page, $perPage)->get()->map(fn (RouteDeparture $departure) => $this->shapeAdminDeparture($departure));

        return [
            'data' => $rows,
            'total' => $total,
            'page' => $page,
            'per_page' => $perPage,
        ];
    }

    public function createAdminDeparture(City $city, array $data): RouteDeparture
    {
        return DB::transaction(function () use ($city, $data) {
            $route = Route::query()->whereKey((int) $data['route_id'])->firstOrFail();
            $this->availability->assertCityOwnsRoute($city, $route);

            $departure = RouteDeparture::query()->create($this->departureAttributes($route, $data));
            if ($departure->vehicle_snapshot !== null) app(SeatMapService::class)->snapshotForDeparture($departure);

            return $departure->fresh(['route:id,city_id,name,scope,mode', 'driver:id,name']);
        });
    }

    public function updateAdminDeparture(City $city, RouteDeparture $departure, array $data): RouteDeparture
    {
        $this->availability->assertFixedDeparture($departure);
        if ($departure->route?->city_id !== $city->id) {
            abort(404);
        }

        return DB::transaction(function () use ($departure, $data) {
            /** @var RouteDeparture $locked */
            $locked = RouteDeparture::query()
                ->with('route:id,city_id,name,scope,mode')
                ->lockForUpdate()
                ->findOrFail($departure->id);

            $route = $locked->route;
            $this->assertAdminDepartureUpdateIsSafe($locked, $data);
            $locked->fill($this->departureAttributes($route, $data, $locked))->save();

            return $locked->fresh(['route:id,city_id,name,scope,mode', 'driver:id,name']);
        });
    }

    private function assertAdminDepartureUpdateIsSafe(RouteDeparture $departure, array $data): void
    {
        if ($departure->vehicle_snapshot !== null) {
            foreach (['driver_id', 'city_vehicle_type_id', 'capacity'] as $field) {
                if (array_key_exists($field, $data) && (int) $data[$field] !== (int) $departure->$field) {
                    throw new ReservationException('This departure’s vehicle and seats are fixed. Close it and open a new departure to change them.', 422);
                }
            }
        }
        if (in_array($departure->status, ['COMPLETED', 'CANCELLED'], true)) {
            throw new ReservationException('This fixed vehicle is already closed.', 422);
        }

        $activeSeats = (int) SeatReservation::query()
            ->where('route_departure_id', $departure->id)
            ->whereIn('status', SeatReservation::ACTIVE_STATUSES)
            ->sum('seats');
        $activeLuggage = (int) SeatReservation::query()
            ->where('route_departure_id', $departure->id)
            ->whereIn('status', SeatReservation::ACTIVE_STATUSES)
            ->sum('extra_luggage_count');
        $heldSeats = (int) FixedSeatHold::query()
            ->where('route_departure_id', $departure->id)
            ->where('status', 'HELD')
            ->where('expires_at', '>', now())
            ->sum('seats');
        $heldLuggage = (int) FixedSeatHold::query()
            ->where('route_departure_id', $departure->id)
            ->where('status', 'HELD')
            ->where('expires_at', '>', now())
            ->sum('extra_luggage_count');

        $minimumCapacity = $activeSeats + $heldSeats;
        $minimumLuggage = $activeLuggage + $heldLuggage;
        if (array_key_exists('capacity', $data) && (int) $data['capacity'] < $minimumCapacity) {
            throw new ReservationException("Capacity cannot be lower than {$minimumCapacity} active/held seat(s).", 422);
        }
        if (array_key_exists('luggage_capacity', $data) && (int) $data['luggage_capacity'] < $minimumLuggage) {
            throw new ReservationException("Luggage capacity cannot be lower than {$minimumLuggage} active/held luggage space(s).", 422);
        }

        $hasPassengerActivity = ($minimumCapacity + $minimumLuggage) > 0 || SeatReservation::query()->where('route_departure_id', $departure->id)->exists();
        if ($hasPassengerActivity && isset($data['route_id']) && (int) $data['route_id'] !== (int) $departure->route_id) {
            throw new ReservationException('Route cannot be changed after passengers have booked this fixed vehicle.', 422);
        }

        if (isset($data['driver_id']) && (int) $data['driver_id'] !== (int) $departure->driver_id && $departure->status !== 'FORMING') {
            throw new ReservationException('Driver can only be changed before this fixed ride starts.', 422);
        }

        if (isset($data['status']) && $data['status'] !== $departure->status) {
            throw new ReservationException('Use the fixed vehicle action buttons to start, complete, close, or cancel this ride.', 422);
        }
    }

    public function closeBookings(City $city, RouteDeparture $departure, ?User $actor = null, ?string $reason = null): RouteDeparture
    {
        $this->availability->assertFixedDeparture($departure);
        if ($departure->route?->city_id !== $city->id) {
            abort(404);
        }
        if (in_array($departure->status, ['COMPLETED', 'CANCELLED'], true)) {
            throw new ReservationException('This vehicle is already closed.', 422);
        }

        return DB::transaction(function () use ($departure, $actor, $reason) {
            /** @var RouteDeparture $dep */
            $dep = RouteDeparture::query()
                ->with(['route:id,city_id,name,scope,mode'])
                ->lockForUpdate()
                ->findOrFail($departure->id);

            $dep->update([
                'visible_to_customers' => false,
                'boarding_closed_at' => $dep->boarding_closed_at ?: now(),
            ]);

            SeatReservation::query()
                ->where('route_departure_id', $dep->id)
                ->whereIn('status', SeatReservation::ACTIVE_STATUSES)
                ->get()
                ->each(function (SeatReservation $reservation) use ($actor, $reason) {
                    $this->events->record(
                        $reservation,
                        'admin_closed_vehicle_bookings',
                        'Admin closed vehicle bookings',
                        'Admin stopped new bookings for this fixed vehicle. Existing passengers remain active and the ride can continue.',
                        ['reason' => $reason],
                        $actor,
                    );
                });

            if ($dep->driver_id) {
                $this->notifier->notifyUserId((int) $dep->driver_id, "fixed_bookings_closed", "Fixed bookings closed", "Admin closed new bookings for " . ($dep->route?->name ?: "this fixed vehicle") . ".", ["route_departure_id" => $dep->id, "route_id" => $dep->route_id], "lock");
            }

            return $dep->fresh(['route:id,city_id,name,scope,mode', 'driver:id,name']);
        });
    }

    public function cancelAdminDeparture(City $city, RouteDeparture $departure, ?User $actor = null, ?string $reason = null): array
    {
        $this->availability->assertFixedDeparture($departure);
        if ($departure->route?->city_id !== $city->id) {
            abort(404);
        }
        if (in_array($departure->status, ['COMPLETED', 'CANCELLED'], true)) {
            throw new ReservationException('This vehicle is already completed or cancelled.', 422);
        }

        $activeReservations = SeatReservation::query()
            ->where('route_departure_id', $departure->id)
            ->whereIn('status', SeatReservation::ACTIVE_STATUSES)
            ->orderBy('id')
            ->get();

        $cancelled = 0;
        $refundPending = 0;
        foreach ($activeReservations as $reservation) {
            $detail = 'Admin cancelled the whole fixed vehicle. This passenger booking was cancelled and full-refund handling was started.';
            if ($reason) {
                $detail .= ' Reason: ' . trim($reason);
            }

            $updated = $this->refunds->cancelBySystem(
                $reservation,
                'admin_vehicle_cancelled',
                $actor,
                $detail,
            );
            $cancelled++;
            if ($updated->refund_status === 'APPROVED') {
                $refundPending++;
            }
        }

        $dep = DB::transaction(function () use ($departure, $reason) {
            /** @var RouteDeparture $dep */
            $dep = RouteDeparture::query()->lockForUpdate()->findOrFail($departure->id);
            $dep->update([
                'status' => 'CANCELLED',
                'visible_to_customers' => false,
                'boarding_closed_at' => $dep->boarding_closed_at ?: now(),
            ]);

            if ($dep->trip_id) {
                $trip = Trip::query()->lockForUpdate()->find($dep->trip_id);
                if ($trip && !in_array($trip->status, ['CANCELLED', 'COMPLETED'], true)) {
                    $this->tripStateMachine->transition($trip, 'CANCELLED', [
                        'cancelled_reason' => $reason ?: 'Admin cancelled the fixed vehicle.',
                        'cancelled_by' => AutoRefundService::BY_OPERATOR,
                    ]);
                }
            }

            return $dep->fresh(['route:id,city_id,name,scope,mode', 'driver:id,name']);
        });

        if ($dep->driver_id) {
            $this->notifier->notifyUserId((int) $dep->driver_id, "fixed_vehicle_cancelled", "Fixed vehicle cancelled", "Admin cancelled " . ($dep->route?->name ?: "this fixed vehicle") . ".", ["route_departure_id" => $dep->id, "route_id" => $dep->route_id, "cancelled_passengers" => $cancelled], "alert-triangle");
        }

        return [
            'departure' => $dep,
            'cancelled_passengers' => $cancelled,
            'refund_pending' => $refundPending,
        ];
    }

    public function cancelDriverDeparture(RouteDeparture $departure, User $driver, ?string $reason = null): array
    {
        $this->availability->assertFixedDeparture($departure);
        if ((int) $departure->driver_id !== (int) $driver->id) {
            abort(403, 'You are not the assigned driver for this departure.');
        }

        if (in_array($departure->status, ['COMPLETED', 'CANCELLED'], true)) {
            throw new ReservationException('This vehicle is already completed or cancelled.', 422);
        }

        if (in_array($departure->status, ['DEPARTED'], true)) {
            throw new ReservationException('Cannot cancel vehicle once it has already departed.', 422);
        }

        $activeReservations = SeatReservation::query()
            ->where('route_departure_id', $departure->id)
            ->whereIn('status', SeatReservation::ACTIVE_STATUSES)
            ->orderBy('id')
            ->get();

        $cancelled = 0;
        $refundPending = 0;
        foreach ($activeReservations as $reservation) {
            $detail = 'Driver cancelled the scheduled departure before trip start. Your booking was cancelled and full-refund processing has been initiated.';
            if ($reason) {
                $detail .= ' Reason: ' . trim($reason);
            }

            $updated = $this->refunds->cancelBySystem(
                $reservation,
                'driver_departure_cancelled',
                $driver,
                $detail,
            );
            $cancelled++;
            if ($updated->refund_status === 'APPROVED') {
                $refundPending++;
            }
        }

        // Release any held seats on this departure
        \App\Models\FixedSeatHold::query()
            ->where('route_departure_id', $departure->id)
            ->whereIn('status', ['PENDING_DRIVER_APPROVAL', 'ACCEPTED', 'HELD'])
            ->update(['status' => 'CANCELLED']);

        \App\Models\DepartureSeat::query()
            ->where('route_departure_id', $departure->id)
            ->where('status', 'HELD')
            ->update(['status' => 'AVAILABLE']);

        $dep = DB::transaction(function () use ($departure) {
            /** @var RouteDeparture $dep */
            $dep = RouteDeparture::query()->lockForUpdate()->findOrFail($departure->id);
            $dep->update([
                'status' => 'CANCELLED',
                'visible_to_customers' => false,
                'boarding_closed_at' => $dep->boarding_closed_at ?: now(),
            ]);

            return $dep->fresh(['route:id,city_id,name,scope,mode', 'driver:id,name']);
        });

        return [
            'departure' => $dep,
            'cancelled_passengers' => $cancelled,
            'refund_pending' => $refundPending,
        ];
    }

    public function shapeCustomerDeparture(RouteDeparture $departure, ?Collection $images = null): array
    {
        $identity = app(FixedDepartureVehicleService::class)->identity($departure);
        $this->availability->assertFixedDeparture($departure);
        $departure->loadMissing(['driver:id,name', 'cityVehicleType:id,display_name,vehicle_type_id', 'cityVehicleType.vehicleType:id,name']);
        $driverProfile = $departure->driver_id
            ? Driver::query()
                ->with(['cityVehicleType:id,display_name', 'vehicleTypeRef:id,name'])
                ->where('user_id', $departure->driver_id)
                ->first(['user_id', 'city_vehicle_type_id', 'vehicle_type_id', 'vehicle_type', 'vehicle_brand', 'vehicle_model', 'vehicle_color', 'vehicle_reg_no'])
            : null;
        $family = $identity['vehicle_name'] ?? $departure->cityVehicleType?->display_name
            ?? $driverProfile?->cityVehicleType?->display_name
            ?? $driverProfile?->vehicle_type
            ?? $driverProfile?->vehicleTypeRef?->name;
        $image = $this->vehicleImages->resolveForVehicle(
            $departure->route?->city_id, $family,
            preloadedImages: $images?->get(mb_strtolower(trim((string) $family)), collect()),
        );

        return [
            'id' => $departure->id,
            'route_id' => $departure->route_id,
            'trip_id' => $departure->trip_id,
            'service_date' => optional($departure->service_date)->toDateString(),
            'depart_at' => optional($departure->depart_at)->toIso8601String(),
            'announced_depart_at' => optional($departure->announced_depart_at)->toIso8601String(),
            'capacity' => (int) $departure->capacity,
            'seats_taken' => (int) $departure->seats_taken,
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
            'first_bookable_stop_seq' => $this->availability->firstBookableStopSeq($departure),
            'fixed_last_reached_stop_seq' => $departure->fixed_last_reached_stop_seq,
            'fixed_last_reached_stop_at' => optional($departure->fixed_last_reached_stop_at)->toIso8601String(),
            'luggage_capacity' => (int) $departure->luggage_capacity,
            'luggage_taken' => (int) $departure->luggage_taken,
            'luggage_remaining' => $this->availability->luggageRemaining($departure),
            'driver' => $departure->driver?->name,
            'driver_name' => $departure->driver?->name,
            'driver_id' => $departure->driver_id,
            'city_vehicle_type_id' => $departure->city_vehicle_type_id,
            'vehicle_name' => $identity['vehicle_name'],
            'image_url' => $image['image_url'],
            'map_marker_url' => $image['map_marker_url'],
            'vehicle' => [
                'type' => $identity['vehicle_type_name'] ?? null,
                'brand' => $identity['vehicle_brand'] ?? null,
                'model' => $identity['vehicle_model'] ?? null,
                'color' => $identity['vehicle_color'] ?? null,
                'reg_no' => $identity['vehicle_reg_no'] ?? null,
                'image_url' => $image['image_url'],
                'map_marker_url' => $image['map_marker_url'],
            ],
            'vehicle_type_name' => $identity['vehicle_type_name'],
            'vehicle_brand' => $identity['vehicle_brand'],
            'vehicle_model' => $identity['vehicle_model'],
            'vehicle_color' => $identity['vehicle_color'],
            'vehicle_reg_no' => $identity['vehicle_reg_no'],
            'status' => $departure->status,
            'departure_kind' => $departure->departure_kind,
            'visible_to_customers' => (bool) $departure->visible_to_customers,
        ];
    }

    public function shapeAdminDeparture(RouteDeparture $departure): array
    {
        $identity = app(FixedDepartureVehicleService::class)->identity($departure);
        $this->availability->assertFixedDeparture($departure);
        $departure->loadMissing('route.stops', 'driver:id,name');

        $firstStop = $departure->route?->stops?->sortBy('seq')->first();
        $lastStop = $departure->route?->stops?->sortBy('seq')->last();
        $originRaw = trim((string) ($departure->route?->origin_name ?? ''));
        $destRaw = trim((string) ($departure->route?->dest_name ?? ''));
        $routeName = trim((string) ($departure->route?->name ?? ''));

        $originFromRoute = null;
        $destFromRoute = null;
        if ($routeName !== '') {
            if (str_contains($routeName, '->')) {
                $parts = explode('->', $routeName);
                $originFromRoute = trim($parts[0]);
                $destFromRoute = trim($parts[1] ?? '');
            } elseif (str_contains($routeName, '→')) {
                $parts = explode('→', $routeName);
                $originFromRoute = trim($parts[0]);
                $destFromRoute = trim($parts[1] ?? '');
            } elseif (stripos($routeName, ' to ') !== false) {
                $parts = preg_split('/ to /i', $routeName);
                $originFromRoute = trim($parts[0]);
                $destFromRoute = trim($parts[1] ?? '');
            }
        }

        $originName = $originFromRoute ?: ($firstStop?->name ?: ($originRaw !== '' && strtolower($originRaw) !== 'origin' ? $originRaw : 'Origin'));
        $destName = $destFromRoute ?: ($lastStop?->name ?: ($destRaw !== '' && strtolower($destRaw) !== 'destination' ? $destRaw : 'Destination'));

        $requestedPlatform = request()?->header('X-Platform', 'android') ?? 'android';
        $family = $identity['vehicle_name']
            ?? $departure->cityVehicleType?->display_name
            ?? $departure->driver?->cityVehicleType?->display_name
            ?? $departure->driver?->driver?->vehicle_type;
        $image = $this->vehicleImages->resolveForVehicle(
            $departure->route?->city_id,
            $family,
            $requestedPlatform
        );

        return [
            'id' => $departure->id,
            'route_id' => $departure->route_id,
            'trip_id' => $departure->trip_id,
            'route_name' => $departure->route?->name,
            'origin_name' => $originName,
            'dest_name' => $destName,
            'trip_id' => $departure->trip_id,
            'scope' => $departure->route?->scope,
            'mode' => $departure->route?->mode,
            'service_date' => $departure->service_date ? ($departure->service_date instanceof \DateTimeInterface ? $departure->service_date->toDateString() : (string) $departure->service_date) : null,
            'depart_at' => $departure->depart_at ? ($departure->depart_at instanceof \DateTimeInterface ? $departure->depart_at->toIso8601String() : (string) $departure->depart_at) : null,
            'announced_depart_at' => $departure->announced_depart_at ? ($departure->announced_depart_at instanceof \DateTimeInterface ? $departure->announced_depart_at->toIso8601String() : (string) $departure->announced_depart_at) : null,
            'actual_depart_at' => $departure->actual_depart_at ? ($departure->actual_depart_at instanceof \DateTimeInterface ? $departure->actual_depart_at->toIso8601String() : (string) $departure->actual_depart_at) : null,
            'boarding_opened_at' => $departure->boarding_opened_at ? ($departure->boarding_opened_at instanceof \DateTimeInterface ? $departure->boarding_opened_at->toIso8601String() : (string) $departure->boarding_opened_at) : null,
            'boarding_closed_at' => $departure->boarding_closed_at ? ($departure->boarding_closed_at instanceof \DateTimeInterface ? $departure->boarding_closed_at->toIso8601String() : (string) $departure->boarding_closed_at) : null,
            'capacity' => (int) $departure->capacity,
            'seats_taken' => (int) $departure->seats_taken,
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
            'first_bookable_stop_seq' => $this->availability->firstBookableStopSeq($departure),
            'fixed_last_reached_stop_seq' => $departure->fixed_last_reached_stop_seq,
            'fixed_last_reached_stop_at' => $departure->fixed_last_reached_stop_at ? ($departure->fixed_last_reached_stop_at instanceof \DateTimeInterface ? $departure->fixed_last_reached_stop_at->toIso8601String() : (string) $departure->fixed_last_reached_stop_at) : null,
            'luggage_capacity' => (int) $departure->luggage_capacity,
            'luggage_taken' => (int) $departure->luggage_taken,
            'luggage_remaining' => $this->availability->luggageRemaining($departure),
            'driver' => $departure->driver?->name,
            'driver_id' => $departure->driver_id,
            'city_vehicle_type_id' => $departure->city_vehicle_type_id,
            'image_url' => $image['image_url'],
            'map_marker_url' => $image['map_marker_url'],
            'vehicle' => [
                'type' => $identity['vehicle_type_name'] ?? null,
                'brand' => $identity['vehicle_brand'] ?? null,
                'model' => $identity['vehicle_model'] ?? null,
                'color' => $identity['vehicle_color'] ?? null,
                'reg_no' => $identity['vehicle_reg_no'] ?? null,
                'image_url' => $image['image_url'],
                'map_marker_url' => $image['map_marker_url'],
            ],
            ...$identity,
            'status' => $departure->status,
            'departure_kind' => $departure->departure_kind,
            'visible_to_customers' => (bool) $departure->visible_to_customers,
        ];
    }

    private function departureAttributes(Route $route, array $data, ?RouteDeparture $existing = null): array
    {
        $prepared = [];
        if (!$existing && !empty($data['driver_id'])) {
            $driver = Driver::where('user_id', $data['driver_id'])->firstOrFail();
            $prepared = app(FixedDepartureVehicleService::class)->prepare($route, $driver);
        }
        $serviceDate = $data['service_date'] ?? now()->toDateString();
        $announced = $data['announced_depart_at'] ?? null;
        $departAt = $data['depart_at'] ?? $announced;
        $vehicleTypeId = $data['city_vehicle_type_id'] ?? $existing?->city_vehicle_type_id ?? $route->city_vehicle_type_id;
        $capacity = $data['capacity'] ?? $existing?->capacity;
        $luggageCapacity = $data['luggage_capacity'] ?? null;

        if ($capacity === null && $vehicleTypeId) {
            $capacity = CityVehicleType::query()->whereKey($vehicleTypeId)->value('max_people');
        }
        if ($capacity === null) {
            $capacity = $existing?->capacity ?? 0;
        }
        if ($luggageCapacity === null) {
            $luggageCapacity = $existing?->luggage_capacity ?? $route->max_luggage_per_vehicle ?? 0;
        }

        return $prepared + [
            'route_id' => $route->id,
            'route_schedule_id' => null,
            'trip_id' => $existing?->trip_id,
            'driver_id' => $data['driver_id'] ?? $existing?->driver_id,
            'city_vehicle_type_id' => $vehicleTypeId,
            'vehicle_seat_layout_id' => $existing?->vehicle_seat_layout_id
                ?? app(SeatMapService::class)->resolveDefaultLayoutForRoute($route),
            'service_date' => $serviceDate,
            'departure_kind' => $data['departure_kind'] ?? ($existing?->departure_kind ?? 'driver_opened'),
            'depart_at' => $departAt,
            'announced_depart_at' => $announced,
            'actual_depart_at' => $data['actual_depart_at'] ?? $existing?->actual_depart_at,
            'boarding_opened_at' => $data['boarding_opened_at'] ?? ($existing?->boarding_opened_at ?? now()),
            'boarding_closed_at' => $data['boarding_closed_at'] ?? $existing?->boarding_closed_at,
            'visible_to_customers' => (bool) ($data['visible_to_customers'] ?? false),
            'wait_reminder_sent_at' => $existing?->wait_reminder_sent_at,
            'capacity' => (int) $capacity,
            'seats_taken' => $existing?->seats_taken ?? 0,
            'luggage_capacity' => (int) $luggageCapacity,
            'luggage_taken' => $existing?->luggage_taken ?? 0,
            'status' => $data['status'] ?? ($existing?->status ?? 'FORMING'),
        ];
    }
}
