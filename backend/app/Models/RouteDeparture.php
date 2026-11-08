<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * A concrete run of a route — a shuttle departure (per schedule + date) or a
 * forming fixed-corridor vehicle. When dispatched it owns one trips row (the
 * vehicle journey); riders are seat_reservations on this departure.
 */
#[Fillable([
    'route_id', 'route_schedule_id', 'trip_id', 'driver_id', 'city_vehicle_type_id',
    'vehicle_seat_layout_id', 'vehicle_snapshot',
    'service_date', 'departure_kind', 'depart_at', 'announced_depart_at',
    'actual_depart_at', 'boarding_opened_at', 'boarding_closed_at',
    'visible_to_customers', 'wait_reminder_sent_at', 'fixed_last_reached_stop_seq', 'fixed_last_reached_stop_at', 'capacity', 'seats_taken',
    'luggage_capacity', 'luggage_taken', 'status',
])]
class RouteDeparture extends Model
{
    use HasFactory;

    protected $casts = [
        'vehicle_snapshot' => 'array',
        'service_date' => 'date',
        'depart_at' => 'datetime',
        'announced_depart_at' => 'datetime',
        'actual_depart_at' => 'datetime',
        'boarding_opened_at' => 'datetime',
        'boarding_closed_at' => 'datetime',
        'visible_to_customers' => 'boolean',
        'wait_reminder_sent_at' => 'datetime',
        'fixed_last_reached_stop_seq' => 'integer',
        'fixed_last_reached_stop_at' => 'datetime',
        'capacity' => 'integer',
        'seats_taken' => 'integer',
        'luggage_capacity' => 'integer',
        'luggage_taken' => 'integer',
    ];

    public function route(): BelongsTo
    {
        return $this->belongsTo(Route::class, 'route_id');
    }

    public function schedule(): BelongsTo
    {
        return $this->belongsTo(RouteSchedule::class, 'route_schedule_id');
    }

    public function trip(): BelongsTo
    {
        return $this->belongsTo(Trip::class, 'trip_id');
    }

    public function driver(): BelongsTo
    {
        return $this->belongsTo(User::class, 'driver_id');
    }

    public function cityVehicleType(): BelongsTo
    {
        return $this->belongsTo(CityVehicleType::class, 'city_vehicle_type_id');
    }

    public function seatLayout(): BelongsTo
    {
        return $this->belongsTo(VehicleSeatLayout::class, 'vehicle_seat_layout_id');
    }

    public function departureSeats(): HasMany
    {
        return $this->hasMany(DepartureSeat::class);
    }

    public function seatReservations(): HasMany
    {
        return $this->hasMany(SeatReservation::class);
    }

    public function fixedSeatHolds(): HasMany
    {
        return $this->hasMany(FixedSeatHold::class);
    }

    /** Seats still available on this run. */
    public function seatsRemaining(): int
    {
        return max(0, (int) $this->capacity - (int) $this->seats_taken);
    }
}
