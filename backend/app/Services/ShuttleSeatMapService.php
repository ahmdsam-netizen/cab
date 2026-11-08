<?php

namespace App\Services;

use App\Exceptions\ReservationException;
use App\Models\CityVehicleType;
use App\Models\JourneySeat;
use App\Models\ShuttleJourney;
use App\Models\ShuttlePassengerBooking;
use App\Models\VehicleSeatLayout;
use Illuminate\Support\Facades\DB;

/**
 * Owns the seat-level lifecycle for a shuttle journey — the shuttle mirror of
 * SeatMapService (Fixed). The seat-layout template (VehicleSeatLayout, per
 * city + vehicle type) is shared with Fixed; only the per-journey status table
 * (journey_seats) is shuttle-specific.
 *
 *   snapshot → layout cells copied into journey_seats the first time the map is opened
 *   hold     → AVAILABLE → HELD, tied to the ShuttlePassengerBooking
 *   book     → HELD → BOOKED (on payment)
 *   release  → HELD/BOOKED → AVAILABLE (hold abandoned / cancelled / refunded)
 *
 * Unlike Fixed there is no separate hold table: a shuttle booking row exists
 * from the start of its flow, so a held seat points straight at the booking.
 */
class ShuttleSeatMapService
{
    /**
     * Pick the seat layout for a journey's vehicle. Prefer a layout designed for
     * the exact (city, vehicle type); fall back to any active layout in the city
     * so every journey has a map to show.
     */
    public function resolveLayoutForJourney(ShuttleJourney $journey): VehicleSeatLayout
    {
        $vehicleTypeId = CityVehicleType::query()
            ->whereKey($journey->city_vehicle_type_id)
            ->value('vehicle_type_id');

        $layout = null;
        if ($vehicleTypeId !== null) {
            $layout = VehicleSeatLayout::query()
                ->where('city_id', $journey->city_id)
                ->where('vehicle_type_id', $vehicleTypeId)
                ->where('is_active', true)
                ->orderBy('id')
                ->first();
        }

        $layout ??= VehicleSeatLayout::query()
            ->where('city_id', $journey->city_id)
            ->where('is_active', true)
            ->orderBy('id')
            ->first();

        $layout ??= VehicleSeatLayout::query()
            ->where('is_active', true)
            ->orderBy('id')
            ->first();

        if (!$layout) {
            throw new ReservationException(
                'No seat layout is configured for this city. Ask the operator to design one.',
                422,
            );
        }

        return $layout;
    }

    /**
     * Copy the layout's seat cells into journey_seats. Idempotent — a journey
     * that already has snapshotted seats is a no-op.
     */
    public function snapshotForJourney(ShuttleJourney $journey): void
    {
        if (JourneySeat::query()->where('shuttle_journey_id', $journey->id)->exists()) {
            return;
        }

        $layout = $this->resolveLayoutForJourney($journey);
        $layout->loadMissing('seatCells');

        $now = now();
        $rows = $layout->seatCells->map(fn ($cell) => [
            'shuttle_journey_id' => $journey->id,
            'vehicle_seat_layout_cell_id' => $cell->id,
            'label' => $cell->label,
            'category' => $cell->category,
            'price_delta' => $cell->price_delta,
            'status' => 'AVAILABLE',
            'shuttle_passenger_booking_id' => null,
            'created_at' => $now,
            'updated_at' => $now,
        ])->all();

        if (!empty($rows)) {
            DB::table('journey_seats')->insert($rows);
        }
    }

    /**
     * Render the seat map for the customer picker: the layout grid + every cell
     * (seat/blocked/aisle) with the live per-seat status. Snapshot is idempotent
     * so this is safe to call before any hold has been made.
     */
    public function mapForJourney(ShuttleJourney $journey): array
    {
        $this->snapshotForJourney($journey);

        $layout = $this->resolveLayoutForJourney($journey);
        $layout->loadMissing('cells');

        $statusByLabel = JourneySeat::query()
            ->where('shuttle_journey_id', $journey->id)
            ->get(['label', 'status'])
            ->pluck('status', 'label')
            ->all();

        $cells = $layout->cells->map(function ($cell) use ($statusByLabel) {
            $status = match ($cell->kind) {
                'seat' => $statusByLabel[$cell->label] ?? 'AVAILABLE',
                'blocked' => 'BLOCKED',
                'aisle' => 'AISLE',
                default => 'AVAILABLE',
            };

            return [
                'row' => (int) $cell->row,
                'col' => (int) $cell->col,
                'kind' => $cell->kind,
                'label' => $cell->label,
                'category' => $cell->category,
                'price_delta' => (float) $cell->price_delta,
                'status' => $status,
            ];
        })->values()->all();

        return [
            'journey' => [
                'id' => (int) $journey->id,
                'status' => $journey->status,
                'capacity' => (int) $journey->capacity,
                'seats_taken' => (int) $journey->seats_taken,
            ],
            'layout' => [
                'id' => (int) $layout->id,
                'name' => $layout->name,
                'rows' => (int) $layout->rows,
                'cols' => (int) $layout->cols,
            ],
            'cells' => $cells,
        ];
    }

    /**
     * Lock the given seat labels on the journey for this booking. Transactional +
     * lockForUpdate so two customers can't hold the same seat: the second loses
     * cleanly with a 422.
     *
     * @param string[] $labels
     */
    public function holdSeats(ShuttleJourney $journey, ShuttlePassengerBooking $booking, array $labels): void
    {
        if (empty($labels)) {
            throw new ReservationException('Pick at least one seat.', 422);
        }
        $labels = array_values(array_unique($labels));

        $this->snapshotForJourney($journey);

        DB::transaction(function () use ($journey, $booking, $labels) {
            $seats = JourneySeat::query()
                ->where('shuttle_journey_id', $journey->id)
                ->whereIn('label', $labels)
                ->lockForUpdate()
                ->get();

            if ($seats->count() !== count($labels)) {
                $missing = array_values(array_diff($labels, $seats->pluck('label')->all()));
                throw new ReservationException(
                    'Seat '.($missing[0] ?? '?').' is not on this vehicle.',
                    422,
                );
            }

            foreach ($seats as $seat) {
                // A seat this same booking already holds is fine (re-pick / retry).
                $ownedByThisBooking = $seat->shuttle_passenger_booking_id === $booking->id;
                if ($seat->status !== 'AVAILABLE' && !$ownedByThisBooking) {
                    throw new ReservationException("Seat {$seat->label} is no longer available.", 422);
                }
            }

            foreach ($seats as $seat) {
                $seat->forceFill([
                    'status' => 'HELD',
                    'shuttle_passenger_booking_id' => $booking->id,
                ])->save();
            }
        });
    }

    /**
     * Flip this booking's HELD seats to BOOKED — called on payment confirmation.
     */
    public function bookSeats(ShuttlePassengerBooking $booking): void
    {
        DB::transaction(function () use ($booking) {
            JourneySeat::query()
                ->where('shuttle_passenger_booking_id', $booking->id)
                ->where('status', 'HELD')
                ->lockForUpdate()
                ->update(['status' => 'BOOKED', 'updated_at' => now()]);
        });
    }

    /**
     * Free this booking's seats back to AVAILABLE — called when the booking is
     * abandoned, cancelled, or refunded. Clears the booking link so the next
     * customer can pick the seat again.
     */
    public function releaseSeats(ShuttlePassengerBooking $booking): void
    {
        DB::transaction(function () use ($booking) {
            JourneySeat::query()
                ->where('shuttle_passenger_booking_id', $booking->id)
                ->whereIn('status', ['HELD', 'BOOKED'])
                ->lockForUpdate()
                ->update([
                    'status' => 'AVAILABLE',
                    'shuttle_passenger_booking_id' => null,
                    'updated_at' => now(),
                ]);
        });
    }
}
