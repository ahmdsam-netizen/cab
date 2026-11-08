<?php

namespace App\Http\Controllers\Admin;

use App\Events\FixedRouteCatalogUpdated;
use App\Models\City;
use App\Models\FixedBookingSupportNote;
use App\Models\FixedSeatHold;
use App\Models\RideType;
use App\Models\RouteDeparture;
use App\Models\RouteStop;
use App\Models\SeatReservation;
use App\Models\Trip;
use App\Services\FixedAvailabilityService;
use App\Services\FixedBookingService;
use App\Services\FixedBookingEventService;
use App\Services\FixedDepartureService;
use App\Services\FixedManifestService;
use App\Services\FixedRefundService;
use App\Services\NotificationCenter;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

class AdminFixedDeparturesController
{
    public function __construct(
        private readonly FixedDepartureService $departures,
        private readonly FixedAvailabilityService $availability,
        private readonly FixedBookingService $bookings,
        private readonly FixedBookingEventService $events,
        private readonly FixedRefundService $refunds,
        private readonly FixedManifestService $manifestService,
        private readonly NotificationCenter $notifier,
    ) {}

    public function index(Request $request, City $city)
    {
        $data = $request->validate([
            'q' => ['nullable', 'string', 'max:120'],
            'route_id' => ['nullable', 'integer'],
            'status' => ['nullable', 'string', 'max:20'],
            'date_from' => ['nullable', 'date'],
            'date_to' => ['nullable', 'date'],
            'page' => ['nullable', 'integer', 'min:1'],
            'per_page' => ['nullable', 'integer', 'min:1', 'max:100'],
        ]);

        return response()->json(['data' => $this->departures->adminDepartures($city, $data)]);
    }

    public function bookings(Request $request, City $city)
    {
        $data = $request->validate([
            'q' => ['nullable', 'string', 'max:120'],
            'route_id' => ['nullable', 'integer'],
            'status' => ['nullable', 'string', 'max:30'],
            'payment_status' => ['nullable', 'string', 'max:30'],
            'refund_status' => ['nullable', 'string', 'max:30'],
            'date_from' => ['nullable', 'date'],
            'date_to' => ['nullable', 'date'],
            'booking_date_from' => ['nullable', 'date'],
            'booking_date_to' => ['nullable', 'date'],
            'ride_date_from' => ['nullable', 'date'],
            'ride_date_to' => ['nullable', 'date'],
            'page' => ['nullable', 'integer', 'min:1'],
            'per_page' => ['nullable', 'integer', 'min:1', 'max:100'],
        ]);

        $perPage = (int) ($data['per_page'] ?? 25);
        $page = (int) ($data['page'] ?? 1);
        $query = SeatReservation::query()
            ->whereHas('route', fn ($q) => $q->where('mode', 'fixed')->where('city_id', $city->id))
            ->with([
                'customer:id,name,phone',
                'route:id,name,scope,mode,city_id',
                'route.stops:id,route_id,seq,name',
                'routeDeparture:id,route_id,service_date,depart_at,announced_depart_at,status,departure_kind,driver_id,fixed_last_reached_stop_seq,fixed_last_reached_stop_at',
                'routeDeparture.driver:id,name,phone',
                'boardStop:id,name',
                'dropStop:id,name',
            ])
            ->when(isset($data['route_id']), fn ($q) => $q->where('route_id', (int) $data['route_id']))
            ->when(isset($data['status']), fn ($q) => $q->where('status', $data['status']))
            ->when(isset($data['payment_status']), fn ($q) => $q->where('payment_status', $data['payment_status']))
            ->when(isset($data['refund_status']), fn ($q) => $q->where('refund_status', $data['refund_status']))
            ->when(isset($data['booking_date_from']), fn ($q) => $q->whereDate('created_at', '>=', $data['booking_date_from']))
            ->when(isset($data['booking_date_to']), fn ($q) => $q->whereDate('created_at', '<=', $data['booking_date_to']))
            ->when(isset($data['ride_date_from']) || isset($data['date_from']), function ($q) use ($data) {
                $from = $data['ride_date_from'] ?? $data['date_from'];
                $q->whereHas('routeDeparture', fn ($dep) => $dep->whereDate('service_date', '>=', $from));
            })
            ->when(isset($data['ride_date_to']) || isset($data['date_to']), function ($q) use ($data) {
                $to = $data['ride_date_to'] ?? $data['date_to'];
                $q->whereHas('routeDeparture', fn ($dep) => $dep->whereDate('service_date', '<=', $to));
            });

        if (!empty($data['q'])) {
            $term = '%' . str_replace('%', '\\%', $data['q']) . '%';
            $query->where(function ($q) use ($term) {
                $q->where('id', 'like', $term)
                    ->orWhere('payment_reference', 'like', $term)
                    ->orWhere('board_address', 'like', $term)
                    ->orWhere('drop_address', 'like', $term)
                    ->orWhereHas('customer', fn ($customer) => $customer->where('name', 'like', $term)->orWhere('phone', 'like', $term))
                    ->orWhereHas('route', fn ($route) => $route->where('name', 'like', $term))
                    ->orWhereHas('boardStop', fn ($stop) => $stop->where('name', 'like', $term))
                    ->orWhereHas('dropStop', fn ($stop) => $stop->where('name', 'like', $term));
            });
        }

        $query->orderByDesc('id');
        $total = (clone $query)->count();
        $rows = $query->forPage($page, $perPage)->get()->map(function (SeatReservation $reservation) {
            return $this->shapeSupportBooking($reservation);
        })->values();

        return response()->json(['data' => [
            'data' => $rows,
            'total' => $total,
            'page' => $page,
            'per_page' => $perPage,
        ]]);
    }

    public function bookingTimeline(Request $request, City $city, SeatReservation $reservation)
    {
        $reservation = $this->cityScopedReservation($city, $reservation);
        $reservation->load([
            'fixedEvents.actor:id,name',
            'fixedSupportNotes.admin:id,name',
        ]);

        return response()->json([
            'data' => [
                'booking' => $this->shapeSupportBooking($reservation),
                'events' => $reservation->fixedEvents
                    ->sortBy('id')
                    ->map(fn ($event) => [
                        'id' => $event->id,
                        'event_type' => $event->event_type,
                        'title' => $event->title,
                        'detail' => $event->detail,
                        'metadata' => $event->metadata ?: [],
                        'actor_name' => $event->actor?->name,
                        'created_at' => optional($event->created_at)->toIso8601String(),
                    ])
                    ->values(),
                'notes' => $reservation->fixedSupportNotes
                    ->sortByDesc('id')
                    ->map(fn ($note) => $this->shapeSupportNote($note))
                    ->values(),
            ],
        ]);
    }

    public function storeBookingNote(Request $request, City $city, SeatReservation $reservation)
    {
        $reservation = $this->cityScopedReservation($city, $reservation);
        $data = $request->validate([
            'note' => ['required', 'string', 'min:2', 'max:2000'],
        ]);

        $note = FixedBookingSupportNote::query()->create([
            'seat_reservation_id' => $reservation->id,
            'admin_id' => $request->user()?->id,
            'note' => trim($data['note']),
        ]);

        $note->load('admin:id,name');

        return response()->json([
            'note' => $this->shapeSupportNote($note),
            'message' => 'Support note added.',
        ], 201);
    }

    public function store(Request $request, City $city)
    {
        $departure = $this->departures->createAdminDeparture($city, $this->validatePayload($request));
        $this->broadcastFixedUpdate($city, (int) $departure->route_id, 'departure_created');

        return response()->json([
            'departure' => $this->departures->shapeAdminDeparture($departure),
            'message' => 'Live fixed vehicle opened.',
        ], 201);
    }

    public function update(Request $request, City $city, RouteDeparture $departure)
    {
        $this->availability->assertFixedDeparture($departure);
        if ($departure->route?->city_id !== $city->id) {
            abort(404);
        }

        $departure = $this->departures->updateAdminDeparture($city, $departure, $this->validatePayload($request));
        $this->broadcastFixedUpdate($city, (int) $departure->route_id, 'departure_updated');

        return response()->json([
            'departure' => $this->departures->shapeAdminDeparture($departure),
            'message' => 'Live fixed vehicle updated.',
        ]);
    }

    public function closeBookings(Request $request, City $city, RouteDeparture $departure)
    {
        $data = $request->validate([
            'reason' => ['nullable', 'string', 'max:500'],
        ]);

        $departure = $this->departures->closeBookings($city, $departure, $request->user(), $data['reason'] ?? null);
        $this->broadcastFixedUpdate($city, (int) $departure->route_id, 'departure_closed');

        return response()->json([
            'departure' => $this->departures->shapeAdminDeparture($departure),
            'message' => 'Bookings closed for this vehicle. Existing passengers remain active.',
        ]);
    }

    public function manifest(Request $request, City $city, RouteDeparture $departure)
    {
        $this->availability->assertFixedDeparture($departure);
        if ($departure->route?->city_id !== $city->id) {
            abort(404);
        }

        $manifest = $this->manifestService->manifest($departure);

        return response()->json([
            'departure' => $this->departures->shapeAdminDeparture($departure),
            'passengers' => $manifest['passengers'] ?? [],
            'stops' => $manifest['stops'] ?? [],
            'trip_id' => $departure->trip_id,
        ]);
    }

    public function cancelDeparture(Request $request, City $city, RouteDeparture $departure)
    {
        $data = $request->validate([
            'reason' => ['nullable', 'string', 'max:500'],
        ]);

        $result = $this->departures->cancelAdminDeparture($city, $departure, $request->user(), $data['reason'] ?? null);
        $this->broadcastFixedUpdate($city, (int) $result['departure']->route_id, 'departure_cancelled');

        return response()->json([
            'departure' => $this->departures->shapeAdminDeparture($result['departure']),
            'cancelled_passengers' => $result['cancelled_passengers'],
            'refund_pending' => $result['refund_pending'],
            'message' => 'Vehicle cancelled. Active passenger bookings were cancelled with full-refund handling.',
        ]);
    }

    public function startDeparture(Request $request, City $city, RouteDeparture $departure)
    {
        $this->availability->assertFixedDeparture($departure);
        if ($departure->route?->city_id !== $city->id) {
            abort(404);
        }

        if (in_array($departure->status, ['COMPLETED', 'CANCELLED', 'DEPARTED'], true)) {
            return response()->json(['message' => 'Vehicle is already ' . strtolower($departure->status) . '.'], 409);
        }

        if (!$departure->driver_id) {
            return response()->json(['message' => 'Cannot start a vehicle without an assigned driver.'], 422);
        }

        $departure = DB::transaction(function () use ($departure) {
            $dep = RouteDeparture::query()->with(['route', 'driver'])->lockForUpdate()->findOrFail($departure->id);
            $route = $dep->route;
            $driverId = (int) $dep->driver_id;

            $trip = $dep->trip_id ? Trip::query()->find($dep->trip_id) : null;
            if (!$trip) {
                $originName = $route?->origin_name ?: ($route?->name ?: 'Origin');
                $destName = $route?->dest_name ?: ($route?->name ?: 'Destination');
                $originLat = (float) ($route?->origin_lat ?? 0);
                $originLng = (float) ($route?->origin_lng ?? 0);
                $destLat = (float) ($route?->dest_lat ?? 0);
                $destLng = (float) ($route?->dest_lng ?? 0);

                $fareTotal = (float) SeatReservation::query()
                    ->where('route_departure_id', $dep->id)
                    ->whereIn('status', SeatReservation::ACTIVE_STATUSES)
                    ->sum('fare_amount');

                $rideTypeId = (int) ($route?->ride_type_id
                    ?: RideType::query()->where('mode', 'fixed')->value('id')
                    ?: ($route?->cityVehicleType?->ride_type_id && RideType::query()->whereKey((int) $route->cityVehicleType->ride_type_id)->exists() ? $route->cityVehicleType->ride_type_id : null)
                    ?: RideType::query()->firstOrCreate(
                        ['name' => 'Fixed'],
                        ['description' => 'Fixed route shared ride', 'sort_order' => 30],
                    )->id);

                $trip = Trip::query()->create([
                    'customer_id' => null,
                    'driver_id' => $driverId,
                    'city_id' => $route->city_id,
                    'scope' => $route->scope ?: 'local',
                    'city_vehicle_type_id' => $dep->city_vehicle_type_id,
                    'ride_type_id' => $rideTypeId,
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
                    'driver_id' => $driverId,
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
                'actual_depart_at' => $dep->actual_depart_at ?? now(),
                'boarding_closed_at' => $dep->boarding_closed_at ?? now(),
                'visible_to_customers' => true,
                'status' => 'DEPARTED',
                'fixed_last_reached_stop_seq' => $dep->fixed_last_reached_stop_seq ?: 1,
                'fixed_last_reached_stop_at' => $dep->fixed_last_reached_stop_at ?? now(),
            ]);

            return $dep->fresh(['route.stops', 'driver:id,name']);
        });

        if ($departure->driver_id) {
            $this->notifier->notifyUserId(
                $departure->driver_id,
                'fixed_ride_started_by_admin',
                'Fixed ride started',
                'Your fixed ride departure was started by operator.',
                ['route_departure_id' => $departure->id],
                'car-outline',
            );
        }

        $activePassengerUserIds = SeatReservation::query()
            ->where('route_departure_id', $departure->id)
            ->whereIn('status', SeatReservation::ACTIVE_STATUSES)
            ->pluck('customer_id')
            ->filter()
            ->unique();

        foreach ($activePassengerUserIds as $pUserId) {
            $this->notifier->notifyUserId(
                $pUserId,
                'fixed_ride_started',
                'Fixed ride has begun',
                'Your fixed route vehicle has departed.',
                ['route_departure_id' => $departure->id],
                'car-outline',
            );
        }

        $this->broadcastFixedUpdate($city, (int) $departure->route_id, 'departure_started');

        return response()->json([
            'departure' => $this->departures->shapeAdminDeparture($departure),
            'message' => 'Fixed vehicle started.',
        ]);
    }

    public function cancelBooking(Request $request, City $city, SeatReservation $reservation)
    {
        $reservation = $this->cityScopedReservation($city, $reservation);
        $data = $request->validate([
            'reason' => ['nullable', 'string', 'max:500'],
        ]);

        $detail = 'Admin cancelled this passenger booking only. Other passengers and the vehicle continue normally.';
        if (!empty($data['reason'])) {
            $detail .= ' Reason: ' . trim($data['reason']);
        }

        $updated = $this->refunds->cancelBySystem($reservation, 'admin_passenger_cancelled', $request->user(), $detail);
        $updated = $this->cityScopedReservation($city, $updated);
        $this->broadcastFixedUpdate($city, (int) $updated->route_id, 'booking_cancelled');

        return response()->json([
            'booking' => $this->shapeSupportBooking($updated),
            'refund_status' => $updated->refund_status,
            'message' => 'Passenger booking cancelled. Other passengers were not affected.',
        ]);
    }

    public function changePassengerDrop(
        Request $request,
        City $city,
        SeatReservation $reservation,
    ) {
        $reservation = $this->cityScopedReservation($city, $reservation);

        $departure = $reservation->routeDeparture;
        if ($departure && in_array($departure->status, ['COMPLETED', 'CANCELLED'], true)) {
            return response()->json(['message' => 'Cannot change drop destination for a finished or cancelled fixed vehicle.'], 409);
        }

        if (in_array($reservation->status, ['COMPLETED', 'DROPPED', 'CANCELLED', 'NO_SHOW'], true)) {
            return response()->json(['message' => 'Cannot change drop stop for a finished or cancelled passenger booking.'], 409);
        }

        $data = $request->validate([
            'drop_stop_id' => ['required', 'integer', 'exists:route_stops,id'],
        ]);

        $result = DB::transaction(function () use ($reservation, $data) {
            /** @var SeatReservation $lockedPassenger */
            $lockedPassenger = SeatReservation::query()->whereKey($reservation->id)->lockForUpdate()->firstOrFail();

            if (in_array($lockedPassenger->status, ['COMPLETED', 'DROPPED', 'CANCELLED', 'NO_SHOW'], true)) {
                return response()->json(['message' => 'Cannot change drop stop for a finished or cancelled passenger booking.'], 409);
            }

            $lockedDeparture = $lockedPassenger->route_departure_id
                ? RouteDeparture::query()->whereKey($lockedPassenger->route_departure_id)->lockForUpdate()->first()
                : null;

            if ($lockedDeparture && in_array($lockedDeparture->status, ['COMPLETED', 'CANCELLED'], true)) {
                return response()->json(['message' => 'Cannot change drop destination for a finished or cancelled fixed vehicle.'], 409);
            }

            $routeId = (int) ($lockedPassenger->route_id ?: $lockedDeparture?->route_id);
            $newStop = RouteStop::query()->findOrFail((int) $data['drop_stop_id']);

            if ((int) $newStop->route_id !== $routeId) {
                return response()->json(['message' => 'The selected drop stop does not belong to the same route.'], 422);
            }

            if (!$newStop->is_drop) {
                return response()->json(['message' => 'The selected stop is not designated as a drop stop.'], 422);
            }

            if (!$newStop->is_active || $newStop->is_temporarily_unavailable) {
                return response()->json(['message' => 'The selected drop stop is currently unavailable.'], 422);
            }

            if ($lockedPassenger->board_stop_id) {
                $boardStop = RouteStop::query()->find($lockedPassenger->board_stop_id);
                if ($boardStop && (int) $newStop->seq <= (int) $boardStop->seq) {
                    return response()->json(['message' => 'Drop stop must be after the pickup stop.'], 422);
                }
            }

            $reachedSeq = (int) ($lockedDeparture?->fixed_last_reached_stop_seq ?? 0);
            if ($reachedSeq > 0 && (int) $newStop->seq <= $reachedSeq) {
                return response()->json(['message' => 'The vehicle has already reached or passed this stop.'], 422);
            }

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

                    $totalOccupiedLuggage = $otherLuggage + $heldLuggage + $passengerLuggage;
                    if ($totalOccupiedLuggage > $luggageCapacity) {
                        $availableLuggage = max(0, $luggageCapacity - ($otherLuggage + $heldLuggage));
                        return response()->json([
                            'message' => "Insufficient luggage capacity on route leg (Stop #{$s} to Stop #" . ($s + 1) . "). Only {$availableLuggage} luggage space(s) available.",
                        ], 422);
                    }
                }
            }

            $lockedPassenger->drop_stop_id = $newStop->id;
            $lockedPassenger->drop_lat = (float) $newStop->lat;
            $lockedPassenger->drop_lng = (float) $newStop->lng;
            $lockedPassenger->drop_address = $newStop->name;
            $lockedPassenger->save();

            $trip = null;
            if ($lockedDeparture) {
                $trip = Trip::query()
                    ->where('route_departure_id', $lockedDeparture->id)
                    ->where('customer_id', $lockedPassenger->customer_id)
                    ->lockForUpdate()
                    ->first();
                if ($trip) {
                    $trip->drop_lat = (float) $newStop->lat;
                    $trip->drop_lng = (float) $newStop->lng;
                    $trip->drop_address = $newStop->name;
                    $trip->save();
                }
            }

            return [
                'passenger' => $lockedPassenger->fresh(['boardStop', 'dropStop', 'customer']),
                'departure' => $lockedDeparture?->fresh(['driver']),
                'trip' => $trip,
                'newStop' => $newStop,
            ];
        });

        if ($result instanceof \Illuminate\Http\JsonResponse) {
            return $result;
        }

        $freshPassenger = $result['passenger'];
        $freshDeparture = $result['departure'];
        $newStop = $result['newStop'];

        $customerName = $freshPassenger->customer?->name ?: 'Passenger #' . $freshPassenger->id;
        $driverId = $freshDeparture?->driver_id ?: ($result['trip']?->driver_id ?? null);
        if ($driverId) {
            $this->notifier->notifyUserId(
                $driverId,
                'passenger_destination_updated',
                'Passenger drop updated',
                "Operator updated {$customerName}'s drop to Stop #{$newStop->seq}: {$newStop->name}.",
                [
                    'route_departure_id' => $freshDeparture?->id,
                    'reservation_id' => $freshPassenger->id,
                    'drop_stop_id' => $newStop->id,
                    'drop_name' => $newStop->name,
                    'drop_lat' => (float) $newStop->lat,
                    'drop_lng' => (float) $newStop->lng,
                ],
                'map-pin',
            );
        }

        if ($freshPassenger->customer_id) {
            $this->notifier->notifyUserId(
                $freshPassenger->customer_id,
                'passenger_destination_updated',
                'Drop destination updated',
                "Your drop destination has been updated to Stop #{$newStop->seq}: {$newStop->name}.",
                [
                    'route_departure_id' => $freshDeparture?->id,
                    'reservation_id' => $freshPassenger->id,
                    'drop_stop_id' => $newStop->id,
                    'drop_name' => $newStop->name,
                    'drop_lat' => (float) $newStop->lat,
                    'drop_lng' => (float) $newStop->lng,
                ],
                'map-pin',
            );
        }

        $this->broadcastFixedUpdate($city, (int) $freshPassenger->route_id, 'passenger_drop_updated');

        return response()->json([
            'passenger' => $freshPassenger,
            'message' => 'Passenger drop destination updated.',
        ]);
    }

    public function storeSupportAction(Request $request, City $city, SeatReservation $reservation)
    {
        $reservation = $this->cityScopedReservation($city, $reservation);
        $data = $request->validate([
            'action' => ['required', 'in:refund_resolved_manual'],
            'method' => ['required', 'in:' . implode(',', \App\Services\RefundRegisterService::METHODS)],
            'reference' => ['required', 'string', 'max:191'],
            'amount' => ['prohibited'],
            'note' => ['nullable', 'string', 'max:2000'],
        ]);

        $locked = SeatReservation::query()->findOrFail($reservation->id);
        if ($locked->payment_status !== 'PAID' || (float) $locked->refund_amount <= 0) {
            throw new \App\Exceptions\ReservationException('This booking has no unpaid refund amount to record.', 422);
        }

        try {
            app(\App\Services\RefundRegisterService::class)->markRefunded(
                'fixed', $reservation->id, $request->user(), $data['method'], $data['reference'], null,
            );

            // Support notes stay internal; the register's public refund note is separate.
            if (filled($data['note'] ?? null)) {
                FixedBookingSupportNote::query()->create([
                    'seat_reservation_id' => $reservation->id,
                    'admin_id' => $request->user()->id,
                    'note' => trim($data['note']),
                ]);
            }

            $this->broadcastFixedUpdate($city, (int) $reservation->route_id, 'refund_recorded');

            return response()->json([
                'booking' => $this->shapeSupportBooking($this->cityScopedReservation($city, $reservation->fresh())),
                'message' => 'Refund recorded. No money was sent by this action.',
            ]);
        } catch (\App\Exceptions\ReservationException $e) {
            if ($e->status === 409 && str_contains($e->getMessage(), 'Razorpay')) {
                if (filled($data['note'] ?? null)) {
                    FixedBookingSupportNote::query()->create([
                        'seat_reservation_id' => $reservation->id,
                        'admin_id' => $request->user()->id,
                        'note' => trim($data['note']),
                    ]);
                }
                $this->broadcastFixedUpdate($city, (int) $reservation->route_id, 'refund_recorded');
            }
            throw $e;
        }
    }

    private function validatePayload(Request $request): array
    {
        return $request->validate([
            'route_id' => ['required', 'integer', 'exists:routes,id'],
            'service_date' => ['nullable', 'date'],
            'departure_kind' => ['nullable', 'in:driver_opened,scheduled'],
            'depart_at' => ['nullable', 'date'],
            'announced_depart_at' => ['nullable', 'date'],
            'actual_depart_at' => ['nullable', 'date'],
            'boarding_opened_at' => ['nullable', 'date'],
            'boarding_closed_at' => ['nullable', 'date'],
            'visible_to_customers' => ['nullable', 'boolean'],
            'city_vehicle_type_id' => ['nullable', 'integer', 'exists:city_vehicle_types,id'],
            'driver_id' => ['nullable', 'integer', 'exists:users,id'],
            'capacity' => ['nullable', 'integer', 'min:1', 'max:200'],
            'luggage_capacity' => ['nullable', 'integer', 'min:0', 'max:200'],
            'status' => ['nullable', 'in:SCHEDULED,FORMING,DISPATCHED,DEPARTED,COMPLETED,CANCELLED'],
        ]);
    }
    private function broadcastFixedUpdate(City $city, ?int $routeId, string $reason): void
    {
        try {
            broadcast(new FixedRouteCatalogUpdated((int) $city->id, $routeId, $reason))->toOthers();
        } catch (\Throwable $e) {
            Log::warning('Fixed admin catalog broadcast failed', [
                'city_id' => $city->id,
                'route_id' => $routeId,
                'reason' => $reason,
                'error' => $e->getMessage(),
            ]);
        }
    }

    private function cityScopedReservation(City $city, SeatReservation $reservation): SeatReservation
    {
        $reservation = SeatReservation::query()
            ->with([
                'customer:id,name,phone',
                'route:id,name,scope,mode,city_id',
                'route.stops:id,route_id,seq,name',
                'routeDeparture:id,route_id,service_date,depart_at,announced_depart_at,status,departure_kind,driver_id,fixed_last_reached_stop_seq,fixed_last_reached_stop_at',
                'routeDeparture.driver:id,name,phone',
                'boardStop:id,name',
                'dropStop:id,name',
            ])
            ->findOrFail($reservation->id);

        if ($reservation->route?->mode !== 'fixed' || (int) $reservation->route?->city_id !== (int) $city->id) {
            abort(404);
        }

        return $reservation;
    }

    private function shapeSupportBooking(SeatReservation $reservation): array
    {
        $booking = $this->bookings->shapeBooking($reservation);
        // The boarding code is for the customer's own screen only — never admin.
        unset($booking['boarding_code']);

        $reachedStopName = null;
        $reachedSeq = $reservation->routeDeparture?->fixed_last_reached_stop_seq;
        if ($reachedSeq !== null) {
            $reachedStopName = $reservation->route?->stops?->firstWhere('seq', (int) $reachedSeq)?->name;
        }

        return array_merge($booking, [
            'fixed_last_reached_stop_name' => $reachedStopName,
            'customer_name' => $reservation->customer?->name,
            'customer_phone' => $reservation->customer?->phone,
            'driver_name' => $reservation->routeDeparture?->driver?->name,
            'driver_phone' => $reservation->routeDeparture?->driver?->phone,
            'departure_status' => $reservation->routeDeparture?->status,
            'boarded_at' => optional($reservation->boarded_at)->toIso8601String(),
            'fixed_last_reached_stop_seq' => $reservation->routeDeparture?->fixed_last_reached_stop_seq,
            'fixed_last_reached_stop_at' => optional($reservation->routeDeparture?->fixed_last_reached_stop_at)->toIso8601String(),
            'payment_reference' => $reservation->payment_reference,
            'refund_reference' => $reservation->refund_reference,
            'refund_amount' => $reservation->refund_amount !== null ? (float) $reservation->refund_amount : null,
            'fixed_auto_outcome' => $reservation->fixed_auto_outcome,
        ]);
    }

    private function shapeSupportNote(FixedBookingSupportNote $note): array
    {
        return [
            'id' => $note->id,
            'note' => $note->note,
            'admin_name' => $note->admin?->name,
            'created_at' => optional($note->created_at)->toIso8601String(),
        ];
    }

}
