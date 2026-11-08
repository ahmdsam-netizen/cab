<?php

namespace App\Services;

use App\Events\FixedRouteCatalogUpdated;
use App\Exceptions\ReservationException;
use App\Models\CouponAssignment;
use App\Models\FixedSeatHold;
use App\Models\RouteDeparture;
use App\Models\RouteStop;
use App\Models\SeatReservation;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

class FixedSeatHoldService
{
    public function __construct(
        private readonly FixedAvailabilityService $availability,
        private readonly FixedPricingService $pricing,
        private readonly CouponService $coupons,
        private readonly FixedBookingEventService $events,
        private readonly NotificationCenter $notifier,
        private readonly SubscriptionService $subscriptions,
        private readonly SeatMapService $seatMap,
    ) {}

    public function previewCoupon(User $customer, array $data): array
    {
        $departure = RouteDeparture::query()->with("route")->findOrFail((int) $data["route_departure_id"]);
        $route = $departure->route;
        if (!$route) {
            throw new ReservationException("This fixed route is not available.", 404);
        }

        $seats = max(1, (int) ($data["seats"] ?? 1));
        $extraLuggageCount = max(0, (int) ($data["extra_luggage_count"] ?? (!empty($data["has_extra_luggage"]) ? 1 : 0)));
        $boardStop = $this->resolveStop($route->id, (int) $data["board_stop_id"], "is_pickup", "boarding");
        $dropStop = $this->resolveStop($route->id, (int) $data["drop_stop_id"], "is_drop", "drop");
        if ((int) $boardStop->seq >= (int) $dropStop->seq) {
            throw new ReservationException("Drop stop must come after the boarding stop.", 422);
        }

        $baseAmount = $this->pricing->bookingAmount($route, $seats, $extraLuggageCount);
        $coupon = $this->resolveFixedCoupon($customer, $departure, $route, $boardStop, $dropStop, $baseAmount, $data["coupon_title"] ?? null);

        return [
            "base_amount" => round($baseAmount, 2),
            "discount" => $coupon["discount"],
            "final_amount" => $coupon["final_amount"],
            "coupon" => $coupon["coupon"],
        ];
    }
    public function updateCoupon(User $customer, FixedSeatHold $hold, ?string $code): FixedSeatHold
    {
        return DB::transaction(function () use ($customer, $hold, $code) {
            $locked = FixedSeatHold::query()->lockForUpdate()->find($hold->id);
            if (!$locked || (int) $locked->customer_id !== (int) $customer->id) {
                throw new ReservationException('This seat hold could not be found.', 404);
            }
            if ($locked->status !== 'ACCEPTED' || !$locked->approved_driver_id || !$locked->expires_at || $locked->expires_at->isPast()) {
                throw new ReservationException('Coupons can only be changed on an approved, active seat request.', 422);
            }
            if ($locked->razorpay_order_id || $locked->razorpay_payment_id || $locked->payment_reference) {
                throw new ReservationException('Payment has already started. The coupon can no longer be changed.', 409);
            }
            $departure = RouteDeparture::query()->with('route')->lockForUpdate()->findOrFail($locked->route_departure_id);
            if ((int) $departure->driver_id !== (int) $locked->approved_driver_id) {
                throw new ReservationException('Driver approval is no longer valid.', 409);
            }
            $this->availability->assertBookableDeparture($departure, true);
            $route = $departure->route;
            if (!$route) throw new ReservationException('This fixed route is not available.', 404);
            $board = $this->resolveStop($route->id, (int) $locked->board_stop_id, 'is_pickup', 'boarding');
            $drop = $this->resolveStop($route->id, (int) $locked->drop_stop_id, 'is_drop', 'drop');
            $this->availability->assertFutureBoardingStop($departure, $board);
            $base = $this->pricing->bookingAmount($route, (int) $locked->seats, (int) $locked->extra_luggage_count);
            if (round($base, 2) !== round((float) ($locked->original_amount ?? $locked->amount), 2)) {
                throw new ReservationException('The fare has changed. Please request seats again.', 409);
            }
            $coupon = $this->resolveFixedCoupon($customer, $departure, $route, $board, $drop, $base, $code);
            $locked->update([
                'coupon_assignment_id' => $coupon['assignment_id'],
                'discount_amount' => $coupon['discount'],
                'amount' => round((float) $coupon['final_amount'] + (float) ($locked->tip_amount ?? 0), 2),
            ]);
            return $locked->fresh();
        });
    }

    public function createHold(User $customer, array $data): FixedSeatHold
    {
        $departure = RouteDeparture::query()->with('route')->findOrFail((int) $data['route_departure_id']);
        // Preferred path: caller passes seat_labels[] (the customer picker in M5).
        // Transition path: caller passes only `seats: N` — we auto-pick the first
        // N AVAILABLE seats on the departure. TODO M5: remove auto-pick once every
        // client sends explicit labels.
        $seatLabels = array_values(array_unique(array_map('strval', (array) ($data['seat_labels'] ?? []))));
        $requestedCount = max(0, (int) ($data['seats'] ?? 0));
        if (empty($seatLabels)) {
            if ($requestedCount < 1) {
                throw new ReservationException('Pick at least one seat.', 422);
            }
            $this->seatMap->snapshotForDeparture($departure);
            $picked = DB::table('departure_seats')
                ->where('route_departure_id', $departure->id)
                ->where('status', 'AVAILABLE')
                ->orderBy('id')
                ->limit($requestedCount)
                ->pluck('label')
                ->all();
            if (count($picked) < $requestedCount) {
                throw new ReservationException("Only ".count($picked)." seat(s) are available on this vehicle.", 422);
            }
            $seatLabels = $picked;
        }
        $seats = count($seatLabels);
        $extraLuggageCount = max(0, (int) ($data['extra_luggage_count'] ?? (!empty($data['has_extra_luggage']) ? 1 : 0)));
        $boardStopId = (int) $data['board_stop_id'];
        $dropStopId = (int) $data['drop_stop_id'];
        $hasExtraLuggage = $extraLuggageCount > 0;
        $couponTitle = $data["coupon_title"] ?? null;
        $tipAmount = max(0.0, round((float) ($data['tip_amount'] ?? 0), 2));
        // Cash = pay a deposit online now, the rest to the driver in cash at trip
        // end. Anything else is a full online prepayment.
        $paymentMethod = strtolower((string) ($data['payment_method'] ?? 'razorpay')) === 'cash' ? 'cash' : 'razorpay';

        $hold = DB::transaction(function () use ($customer, $departure, $seats, $seatLabels, $extraLuggageCount, $hasExtraLuggage, $boardStopId, $dropStopId, $couponTitle, $tipAmount, $paymentMethod) {
            $dep = RouteDeparture::query()->with('route')->lockForUpdate()->find($departure->id);
            if (!$dep) {
                throw new ReservationException('This departure could not be found.', 404);
            }

            $this->availability->assertBookableDeparture($dep, true);
            if (!$dep->driver_id) {
                throw new ReservationException('A driver must be assigned before requesting seats on this departure.', 409);
            }
            $route = $dep->route;
            if (!$route) {
                throw new ReservationException('This fixed route is not available.', 404);
            }
            if ($seats > max(1, (int) $dep->capacity)) {
                throw new ReservationException('You cannot book more seats than the vehicle capacity.', 422);
            }

            $boardStop = $this->resolveStop($route->id, $boardStopId, 'is_pickup', 'boarding');
            $dropStop = $this->resolveStop($route->id, $dropStopId, 'is_drop', 'drop');
            if ((int) $boardStop->seq >= (int) $dropStop->seq) {
                throw new ReservationException('Drop stop must come after the boarding stop.', 422);
            }
            $this->availability->assertFutureBoardingStop($dep, $boardStop);

            $this->availability->releaseCustomerHeldSeats($customer->id, $dep->id);

            $remaining = $this->availability->seatsRemainingForSegment($dep, $boardStop, $dropStop);
            if ($remaining < $seats) {
                throw new ReservationException("Only {$remaining} seat(s) are still available between those stops.", 422);
            }

            $luggageRemaining = $this->availability->luggageRemainingForSegment($dep, $boardStop, $dropStop);
            if ($extraLuggageCount > $luggageRemaining) {
                throw new ReservationException("Only {$luggageRemaining} luggage space(s) are still available between those stops.", 422);
            }

            $luggageSurcharge = $hasExtraLuggage ? (float) $route->luggage_surcharge_amount * $extraLuggageCount : 0.0;
            $baseAmount = $this->pricing->bookingAmount($route, $seats, $extraLuggageCount);
            $coupon = $this->resolveFixedCoupon($customer, $dep, $route, $boardStop, $dropStop, $baseAmount, $couponTitle);
            $amount = round((float) $coupon["final_amount"] + $tipAmount, 2);

            // Idempotent — safe to call before every hold in case snapshot hasn't run yet.
            $this->seatMap->snapshotForDeparture($dep);

            $hasDriver = $dep->driver_id !== null;
            $initialStatus = $hasDriver ? 'PENDING_DRIVER_APPROVAL' : 'HELD';
            $initialExpiry = $hasDriver ? now()->addSeconds(60) : now()->addMinutes(5);

            $newHold = FixedSeatHold::query()->create([
                'route_departure_id' => $dep->id,
                'customer_id' => $customer->id,
                'board_stop_id' => $boardStop->id,
                'drop_stop_id' => $dropStop->id,
                'seats' => $seats,
                'payment_method' => $paymentMethod,
                'amount' => $amount,
                'original_amount' => $baseAmount,
                'discount_amount' => $coupon["discount"],
                'tip_amount' => $tipAmount,
                'coupon_assignment_id' => $coupon["assignment_id"],
                'has_extra_luggage' => $hasExtraLuggage,
                'extra_luggage_count' => $extraLuggageCount,
                'luggage_surcharge_amount' => $luggageSurcharge,
                'status' => $initialStatus,
                'expires_at' => $initialExpiry,
            ]);

            // Locks the specific labels; throws 422 if any is unavailable.
            $this->seatMap->markSeatsHeld($newHold, $seatLabels);

            return $newHold;
        });

        $this->broadcastDepartureUpdate((int) $hold->route_departure_id, 'seat_hold_created');

        if ($hold->routeDeparture && $hold->routeDeparture->driver_id) {
            $dep = $hold->routeDeparture;
            $seatLabels = $hold->heldSeats->pluck('label')->values()->all();
            broadcast(new \App\Events\FixedSeatHoldRequested(
                driverUserId: (int) $dep->driver_id,
                holdId: (int) $hold->id,
                routeDepartureId: (int) $dep->id,
                customerId: (int) $customer->id,
                customerName: (string) ($customer->name ?? 'Customer'),
                customerPhone: (string) ($customer->phone ?? ''),
                seatLabels: $seatLabels,
                seats: (int) $hold->seats,
                boardStopName: (string) ($hold->boardStop?->name ?? 'Pickup'),
                dropStopName: (string) ($hold->dropStop?->name ?? 'Drop'),
                amount: (float) $hold->amount,
                expiresInSec: 60,
                expiresAt: optional($hold->expires_at)->toIso8601String(),
            ));

            $this->notifier->notifyUserId(
                (int) $dep->driver_id,
                'fixed_seat_requested',
                'New Seat Booking Request',
                "Passenger requested {$hold->seats} seat(s) for ₹{$hold->amount}.",
                [
                    'hold_id' => $hold->id,
                    'departure_id' => $dep->id,
                    'seats' => $hold->seats,
                    'amount' => $hold->amount,
                    'expires_at' => optional($hold->expires_at)->toIso8601String(),
                ],
                'car'
            );
        }

        return $hold;
    }

    public function driverAcceptHold(User $driver, FixedSeatHold $hold): FixedSeatHold
    {
        $this->availability->expireHoldIfNeeded($hold);

        return DB::transaction(function () use ($driver, $hold) {
            $lockedHold = FixedSeatHold::query()->lockForUpdate()->find($hold->id);
            if (!$lockedHold) {
                throw new ReservationException('This seat hold could not be found.', 404);
            }

            $dep = RouteDeparture::query()->lockForUpdate()->find($lockedHold->route_departure_id);
            if (!$dep || (int) $dep->driver_id !== (int) $driver->id) {
                throw new ReservationException('You are not the assigned driver for this departure.', 403);
            }

            $lockedHold = $this->availability->expireHoldIfNeeded($lockedHold);
            if ($lockedHold->status !== 'PENDING_DRIVER_APPROVAL') {
                throw new ReservationException('This seat request is no longer pending.', 422);
            }

            $lockedHold->update([
                'status' => 'ACCEPTED',
                'approved_driver_id' => $driver->id,
                'expires_at' => now()->addMinutes(5),
            ]);

            $seatLabels = $lockedHold->heldSeats->pluck('label')->values()->all();
            broadcast(new \App\Events\FixedSeatHoldAccepted(
                customerId: (int) $lockedHold->customer_id,
                holdId: (int) $lockedHold->id,
                routeDepartureId: (int) $dep->id,
                seatLabels: $seatLabels,
                amount: (float) $lockedHold->amount,
                expiresAt: $lockedHold->fresh()->expires_at->toIso8601String(),
                paymentWindowSec: 300,
            ));

            $this->notifier->notifyUserId(
                (int) $lockedHold->customer_id,
                'fixed_seat_accepted',
                'Driver Accepted Your Seat Request',
                'Your seat request was approved! Please complete payment within 5 minutes.',
                [
                    'hold_id' => $lockedHold->id,
                    'departure_id' => $dep->id,
                    'expires_at' => optional($lockedHold->expires_at)->toIso8601String(),
                ],
                'check-circle'
            );

            return $lockedHold;
        });

        try {
            app(AgenticAiService::class)->notifyDriverEvent((int) $acceptedHold->id, 'DRIVER_ACCEPTED', (int) $driver->id);
        } catch (\Throwable $e) {
            Log::warning('AgenticAiService notifyDriverEvent DRIVER_ACCEPTED failed', ['error' => $e->getMessage()]);
        }

        return $acceptedHold;
    }

    public function driverRejectHold(User $driver, FixedSeatHold $hold): void
    {
        DB::transaction(function () use ($driver, $hold) {
            $lockedHold = FixedSeatHold::query()->lockForUpdate()->find($hold->id);
            if (!$lockedHold) {
                throw new ReservationException('This seat hold could not be found.', 404);
            }

            $dep = RouteDeparture::query()->lockForUpdate()->find($lockedHold->route_departure_id);
            if (!$dep || (int) $dep->driver_id !== (int) $driver->id) {
                throw new ReservationException('You are not the assigned driver for this departure.', 403);
            }

            $lockedHold = $this->availability->expireHoldIfNeeded($lockedHold);
            if ($lockedHold->status !== 'PENDING_DRIVER_APPROVAL') {
                throw new ReservationException('This seat request is no longer pending.', 422);
            }

            $this->seatMap->releaseSeats($lockedHold);
            $lockedHold->update(['status' => 'REJECTED']);

            broadcast(new \App\Events\FixedSeatHoldRejected(
                customerId: (int) $lockedHold->customer_id,
                holdId: (int) $lockedHold->id,
                routeDepartureId: (int) $dep->id,
                reason: 'driver_rejected',
            ));

            $this->notifier->notifyUserId(
                (int) $lockedHold->customer_id,
                'fixed_seat_rejected',
                'Seat Request Declined',
                'The driver was unable to accept your seat request. No payment was charged.',
                [
                    'hold_id' => $lockedHold->id,
                    'departure_id' => $dep->id,
                ],
                'alert-circle'
            );
        });

        $this->broadcastDepartureUpdate((int) $hold->route_departure_id, 'seat_hold_released');

        try {
            app(AgenticAiService::class)->notifyDriverEvent((int) $hold->id, 'DRIVER_REJECTED', (int) $driver->id, 'driver_rejected');
        } catch (\Throwable $e) {
            Log::warning('AgenticAiService notifyDriverEvent DRIVER_REJECTED failed', ['error' => $e->getMessage()]);
        }
    }

    public function activeHoldForCustomer(User $customer): ?FixedSeatHold
    {
        $hold = FixedSeatHold::query()
            ->where('customer_id', $customer->id)
            ->whereIn('status', ['PENDING_DRIVER_APPROVAL', 'ACCEPTED', 'HELD'])
            ->where('expires_at', '>', now())
            ->latest('id')
            ->first();

        if ($hold) {
            $hold = $this->availability->expireHoldIfNeeded($hold);
            if (!in_array($hold->status, ['PENDING_DRIVER_APPROVAL', 'ACCEPTED', 'HELD'], true)) {
                return null;
            }
        }

        return $hold;
    }

    public function confirmHold(User $customer, FixedSeatHold $hold, array $data, RazorpayService $razorpayService): SeatReservation
    {
        $this->availability->expireHoldIfNeeded($hold);

        $reservation = DB::transaction(function () use ($customer, $hold, $data, $razorpayService) {
            $lockedHold = FixedSeatHold::query()->lockForUpdate()->find($hold->id);
            if (!$lockedHold || $lockedHold->customer_id !== $customer->id) {
                throw new ReservationException('This seat hold could not be found.', 404);
            }

            $lockedHold = $this->availability->expireHoldIfNeeded($lockedHold);
            if ($lockedHold->status === 'PENDING_DRIVER_APPROVAL') {
                throw new ReservationException('Driver has not accepted this seat request yet.', 422);
            }

            if ($lockedHold->status === 'CONFIRMED') {
                $existing = SeatReservation::query()
                    ->where('route_departure_id', $lockedHold->route_departure_id)
                    ->where('customer_id', $customer->id)
                    ->whereNotNull('payment_reference')
                    ->where('payment_reference', $lockedHold->payment_reference ?: $lockedHold->razorpay_payment_id)
                    ->first();
                if ($existing) {
                    return $existing;
                }
            }

            if ($lockedHold->status !== 'ACCEPTED' || !$lockedHold->approved_driver_id) {
                throw new ReservationException('This seat hold is no longer active.', 422);
            }

            $dep = RouteDeparture::query()->with('route')->lockForUpdate()->find($lockedHold->route_departure_id);
            if (!$dep) {
                throw new ReservationException('This departure could not be found.', 404);
            }
            if ((int) $dep->driver_id !== (int) $lockedHold->approved_driver_id) {
                throw new ReservationException('Driver approval is no longer valid.', 409);
            }

            $this->availability->assertBookableDeparture($dep, true);
            $route = $dep->route;
            if (!$route) {
                throw new ReservationException('This fixed route is not available.', 404);
            }

            $boardStop = $this->resolveStop($route->id, (int) $lockedHold->board_stop_id, 'is_pickup', 'boarding');
            $dropStop = $this->resolveStop($route->id, (int) $lockedHold->drop_stop_id, 'is_drop', 'drop');
            if ((int) $boardStop->seq >= (int) $dropStop->seq) {
                throw new ReservationException('Drop stop must come after the boarding stop.', 422);
            }
            $this->availability->assertFutureBoardingStop($dep, $boardStop);

            $remainingForThisHold = $this->availability->seatsRemainingForSegment($dep, $boardStop, $dropStop, $lockedHold->id);
            if ($remainingForThisHold < (int) $lockedHold->seats) {
                throw new ReservationException('The held seats are no longer available between those stops.', 422);
            }

            $extraLuggageCount = max(0, (int) $lockedHold->extra_luggage_count);
            $luggageRemainingForThisHold = $this->availability->luggageRemainingForSegment($dep, $boardStop, $dropStop, $lockedHold->id);
            if ($extraLuggageCount > $luggageRemainingForThisHold) {
                throw new ReservationException('The held extra luggage space is no longer available between those stops.', 422);
            }

            $razorpayOrderId = trim((string) $data['razorpay_order_id']);
            $razorpayPaymentId = trim((string) $data['razorpay_payment_id']);
            $razorpaySignature = trim((string) $data['razorpay_signature']);
            if (!$lockedHold->razorpay_order_id || $lockedHold->razorpay_order_id !== $razorpayOrderId) {
                throw new ReservationException('Payment order does not match this seat hold.', 422);
            }
            if ($lockedHold->razorpay_payment_id && $lockedHold->razorpay_payment_id !== $razorpayPaymentId) {
                throw new ReservationException('This seat hold is already linked to another payment.', 422);
            }
            if (!$razorpayService->verifyPaymentSignature($razorpayOrderId, $razorpayPaymentId, $razorpaySignature)) {
                Log::warning('Fixed booking Razorpay signature invalid', [
                    'fixed_seat_hold_id' => $lockedHold->id,
                    'razorpay_order_id' => $razorpayOrderId,
                    'razorpay_payment_id' => $razorpayPaymentId,
                ]);
                throw new ReservationException('Payment verification failed.', 422);
            }

            $bookingChannel = $this->resolveChannel((string) $data['booking_channel']);
            $expectedAmount = $this->pricing->bookingAmount($route, (int) $lockedHold->seats, $extraLuggageCount);
            if (round((float) ($lockedHold->original_amount ?? $lockedHold->amount), 2) !== round($expectedAmount, 2)) {
                throw new ReservationException('The hold amount is no longer valid. Please create a new hold.', 409);
            }
            $this->assertCouponStillRedeemable($lockedHold, $customer, $dep, $route, $boardStop, $dropStop, $expectedAmount);

            $commission = $this->bookingCommissionForDeparture($dep, $route, (float) $lockedHold->amount, (int) $lockedHold->seats);

            $reservation = SeatReservation::query()->create([
                'route_departure_id' => $dep->id,
                'trip_id' => $dep->trip_id,
                'route_id' => $route->id,
                'route_name' => $route->name,
                'customer_id' => $customer->id,
                'seats' => (int) $lockedHold->seats,
                'booking_channel' => $bookingChannel,
                'board_stop_id' => $boardStop->id,
                'board_lat' => (float) $boardStop->lat,
                'board_lng' => (float) $boardStop->lng,
                'board_address' => $boardStop->name,
                'drop_stop_id' => $dropStop->id,
                'drop_lat' => (float) $dropStop->lat,
                'drop_lng' => (float) $dropStop->lng,
                'drop_address' => $dropStop->name,
                'fare_amount' => (float) $lockedHold->amount,
                'tip_amount' => (float) ($lockedHold->tip_amount ?? 0),
                'commission_percent' => (float) $commission['percent'],
                'commission_amount' => (float) $commission['amount'],
                'promo_discount_amount' => $lockedHold->discount_amount !== null ? (float) $lockedHold->discount_amount : null,
                'coupon_assignment_id' => $lockedHold->coupon_assignment_id,
                'payment_method' => $lockedHold->payment_method ?? 'razorpay',
                'payment_status' => 'PAID',
                'payment_reference' => $razorpayPaymentId,
                'has_extra_luggage' => $extraLuggageCount > 0,
                'extra_luggage_count' => $extraLuggageCount,
                'luggage_surcharge_amount' => (float) $lockedHold->luggage_surcharge_amount,
                'refund_status' => 'NONE',
                'status' => 'CONFIRMED',
            ]);

            $dep->increment('seats_taken', (int) $lockedHold->seats);
            if ($extraLuggageCount > 0) {
                $dep->increment('luggage_taken', $extraLuggageCount);
            }
            $lockedHold->update([
                'status' => 'CONFIRMED',
                'payment_reference' => $razorpayPaymentId,
                'razorpay_payment_id' => $razorpayPaymentId,
                'razorpay_signature' => $razorpaySignature,
            ]);

            $this->seatMap->markSeatsBooked($lockedHold, $reservation);
            $this->markCouponRedeemed($lockedHold);

            // Phase 5 — mirror the prepayment onto the shared money engine so the
            // driver's share is split at trip completion. No-op while the split
            // engine is disabled (the legacy wallet credit still applies then).
            app(\App\Services\BookingPaymentService::class)->recordSeatCapture(
                $reservation,
                (string) $razorpayPaymentId,
            );

            $this->events->record(
                $reservation,
                'booking_confirmed',
                'Booking confirmed',
                'Customer paid by Razorpay and the fixed booking was confirmed.',
                [
                    'payment_reference' => $razorpayPaymentId,
                    'booking_channel' => $bookingChannel,
                ],
                $customer,
            );

            return $reservation;
        });

        $this->broadcastDepartureUpdate((int) $reservation->route_departure_id, 'booking_confirmed');
        $this->notifyBookingConfirmed($reservation);

        return $reservation;
    }


    /**
     * Server-verified confirmation used by the Razorpay webhook and the
     * pending-payment sweeper. By the time this runs, Razorpay itself has told
     * us (signed webhook / Orders API) that the money for this hold's order is
     * CAPTURED — so there is no checkout signature to verify and no logged-in
     * customer making the call.
     *
     * EXPIRED holds are accepted too: the customer paid, so if the seats are
     * still free we honour the booking. When confirmation is impossible
     * (seats gone, departure closed, coupon burned) this throws a
     * ReservationException and the caller auto-refunds the captured payment.
     */
    public function confirmPaidHold(FixedSeatHold $hold, string $razorpayPaymentId, string $source = 'webhook'): SeatReservation
    {
        $alreadyConfirmed = false;

        $reservation = DB::transaction(function () use ($hold, $razorpayPaymentId, $source, &$alreadyConfirmed) {
            $lockedHold = FixedSeatHold::query()->lockForUpdate()->find($hold->id);
            if (!$lockedHold) {
                throw new ReservationException('This seat hold could not be found.', 404);
            }

            // Idempotency: verify endpoint / a duplicate webhook may have
            // already confirmed this hold. Return the existing reservation.
            if ($lockedHold->status === 'CONFIRMED') {
                $existing = SeatReservation::query()
                    ->where('route_departure_id', $lockedHold->route_departure_id)
                    ->where('customer_id', $lockedHold->customer_id)
                    ->where('payment_reference', $lockedHold->payment_reference ?: $razorpayPaymentId)
                    ->first();
                if ($existing) {
                    $alreadyConfirmed = true;

                    return $existing;
                }
                throw new ReservationException('This seat hold is already confirmed.', 409);
            }

            if (!in_array($lockedHold->status, ['ACCEPTED', 'EXPIRED'], true) || !$lockedHold->approved_driver_id) {
                throw new ReservationException('This seat hold is no longer active.', 422);
            }
            if ($lockedHold->razorpay_payment_id && $lockedHold->razorpay_payment_id !== $razorpayPaymentId) {
                throw new ReservationException('This seat hold is already linked to another payment.', 422);
            }

            $customer = $lockedHold->customer()->first();
            if (!$customer) {
                throw new ReservationException('The customer for this seat hold could not be found.', 404);
            }

            $dep = RouteDeparture::query()->with('route')->lockForUpdate()->find($lockedHold->route_departure_id);
            if (!$dep) {
                throw new ReservationException('This departure could not be found.', 404);
            }

            if ((int) $dep->driver_id !== (int) $lockedHold->approved_driver_id) {
                throw new ReservationException('Driver approval is no longer valid. Please request seats again.', 409);
            }
            $cashWithoutDeposit = $source === 'cash_zero_deposit';
            if ($cashWithoutDeposit && ($lockedHold->payment_method !== 'cash'
                || !app(CashDepositService::class)->cashEnabled()
                || app(CashDepositService::class)->quote((float) $lockedHold->amount)['deposit'] > 0)) {
                throw new ReservationException('An online payment is required.', 422);
            }

            $this->availability->assertBookableDeparture($dep, true);
            $route = $dep->route;
            if (!$route) {
                throw new ReservationException('This fixed route is not available.', 404);
            }

            $boardStop = $this->resolveStop($route->id, (int) $lockedHold->board_stop_id, 'is_pickup', 'boarding');
            $dropStop = $this->resolveStop($route->id, (int) $lockedHold->drop_stop_id, 'is_drop', 'drop');
            if ((int) $boardStop->seq >= (int) $dropStop->seq) {
                throw new ReservationException('Drop stop must come after the boarding stop.', 422);
            }
            $this->availability->assertFutureBoardingStop($dep, $boardStop);

            $remainingForThisHold = $this->availability->seatsRemainingForSegment($dep, $boardStop, $dropStop, $lockedHold->id);
            if ($remainingForThisHold < (int) $lockedHold->seats) {
                throw new ReservationException('The held seats are no longer available between those stops.', 422);
            }

            $extraLuggageCount = max(0, (int) $lockedHold->extra_luggage_count);
            $luggageRemainingForThisHold = $this->availability->luggageRemainingForSegment($dep, $boardStop, $dropStop, $lockedHold->id);
            if ($extraLuggageCount > $luggageRemainingForThisHold) {
                throw new ReservationException('The held extra luggage space is no longer available between those stops.', 422);
            }

            $expectedAmount = $this->pricing->bookingAmount($route, (int) $lockedHold->seats, $extraLuggageCount);
            if (round((float) ($lockedHold->original_amount ?? $lockedHold->amount), 2) !== round($expectedAmount, 2)) {
                throw new ReservationException('The hold amount is no longer valid.', 409);
            }
            $this->assertCouponStillRedeemable($lockedHold, $customer, $dep, $route, $boardStop, $dropStop, $expectedAmount);

            $commission = $this->bookingCommissionForDeparture($dep, $route, (float) $lockedHold->amount, (int) $lockedHold->seats);

            $reservation = SeatReservation::query()->create([
                'route_departure_id' => $dep->id,
                'trip_id' => $dep->trip_id,
                'route_id' => $route->id,
                'route_name' => $route->name,
                'customer_id' => $customer->id,
                'seats' => (int) $lockedHold->seats,
                'booking_channel' => 'advance',
                'board_stop_id' => $boardStop->id,
                'board_lat' => (float) $boardStop->lat,
                'board_lng' => (float) $boardStop->lng,
                'board_address' => $boardStop->name,
                'drop_stop_id' => $dropStop->id,
                'drop_lat' => (float) $dropStop->lat,
                'drop_lng' => (float) $dropStop->lng,
                'drop_address' => $dropStop->name,
                'fare_amount' => (float) $lockedHold->amount,
                'tip_amount' => (float) ($lockedHold->tip_amount ?? 0),
                'commission_percent' => (float) $commission['percent'],
                'commission_amount' => (float) $commission['amount'],
                'promo_discount_amount' => $lockedHold->discount_amount !== null ? (float) $lockedHold->discount_amount : null,
                'coupon_assignment_id' => $lockedHold->coupon_assignment_id,
                'payment_method' => $lockedHold->payment_method ?? 'razorpay',
                'payment_status' => $cashWithoutDeposit ? 'PENDING' : 'PAID',
                'payment_reference' => $razorpayPaymentId,
                'has_extra_luggage' => $extraLuggageCount > 0,
                'extra_luggage_count' => $extraLuggageCount,
                'luggage_surcharge_amount' => (float) $lockedHold->luggage_surcharge_amount,
                'refund_status' => 'NONE',
                'status' => 'CONFIRMED',
            ]);

            $dep->increment('seats_taken', (int) $lockedHold->seats);
            if ($extraLuggageCount > 0) {
                $dep->increment('luggage_taken', $extraLuggageCount);
            }
            $lockedHold->update([
                'status' => 'CONFIRMED',
                'payment_reference' => $razorpayPaymentId,
                'razorpay_payment_id' => $cashWithoutDeposit ? null : $razorpayPaymentId,
                'razorpay_signature' => $cashWithoutDeposit ? null : 'server_verified:' . $source,
            ]);

            $this->seatMap->markSeatsBooked($lockedHold, $reservation);
            $this->markCouponRedeemed($lockedHold);

            // Phase 5 — mirror the prepayment onto the shared money engine (see
            // confirmHold). No-op while the split engine is disabled.
            if (!$cashWithoutDeposit) {
                app(\App\Services\BookingPaymentService::class)->recordSeatCapture($reservation, (string) $razorpayPaymentId);
            }

            $this->events->record(
                $reservation,
                'booking_confirmed',
                'Booking confirmed',
                $cashWithoutDeposit ? 'Driver approval completed the cash booking; no online deposit was required.' : ($source === 'sweeper'
                    ? 'Razorpay confirmed the payment during reconciliation and the fixed booking was completed automatically.'
                    : 'Razorpay confirmed the payment via webhook and the fixed booking was completed automatically.'),
                [
                    'payment_reference' => $razorpayPaymentId,
                    'booking_channel' => 'advance',
                    'confirmed_via' => $source,
                ],
                $customer,
            );

            return $reservation;
        });

        if (!$alreadyConfirmed) {
            DB::afterCommit(function () use ($reservation) {
                $this->broadcastDepartureUpdate((int) $reservation->route_departure_id, 'booking_confirmed');
                $this->notifyBookingConfirmed($reservation);
            });
        }

        return $reservation;
    }

    public function createRazorpayOrder(User $customer, FixedSeatHold $hold, RazorpayService $razorpayService, ?string $paymentMethod = null): array
    {
        $this->availability->expireHoldIfNeeded($hold);

        return DB::transaction(function () use ($customer, $hold, $razorpayService, $paymentMethod) {
            $lockedHold = FixedSeatHold::query()->lockForUpdate()->find($hold->id);
            if (!$lockedHold || $lockedHold->customer_id !== $customer->id) {
                throw new ReservationException('This seat hold could not be found.', 404);
            }

            $lockedHold = $this->availability->expireHoldIfNeeded($lockedHold);
            if ($lockedHold->status === 'CONFIRMED' && str_starts_with((string) $lockedHold->payment_reference, 'cash_fixed_')) {
                $reservation = SeatReservation::query()->where('payment_reference', $lockedHold->payment_reference)
                    ->where('customer_id', $customer->id)->firstOrFail();
                return ['payment_required' => false, 'reservation_id' => $reservation->id];
            }
            if ($lockedHold->status === 'PENDING_DRIVER_APPROVAL') {
                throw new ReservationException('Driver has not accepted this seat request yet.', 422);
            }
            if ($lockedHold->status !== 'ACCEPTED' || !$lockedHold->approved_driver_id) {
                throw new ReservationException('This seat hold is no longer active.', 422);
            }

            $dep = RouteDeparture::query()->lockForUpdate()->findOrFail($lockedHold->route_departure_id);
            if ((int) $dep->driver_id !== (int) $lockedHold->approved_driver_id) {
                throw new ReservationException('Driver approval is no longer valid.', 409);
            }
            if ($paymentMethod && $paymentMethod !== $lockedHold->payment_method) {
                if ($lockedHold->razorpay_order_id) {
                    throw new ReservationException('A payment is already in progress. Keep the same payment method or request seats again.', 409);
                }
                $lockedHold->update(['payment_method' => $paymentMethod]);
            }
            if ($lockedHold->payment_method === 'cash' && !app(CashDepositService::class)->cashEnabled()) {
                throw new ReservationException('Cash is not available.', 422);
            }
            if ($lockedHold->razorpay_order_id) {
                return $this->razorpayOrderResponse($lockedHold);
            }
            if ($lockedHold->payment_method === 'cash' && app(CashDepositService::class)->quote((float) $lockedHold->amount)['deposit'] <= 0) {
                $reservation = $this->confirmPaidHold($lockedHold, 'cash_fixed_' . $lockedHold->id, 'cash_zero_deposit');
                return ['payment_required' => false, 'reservation_id' => $reservation->id];
            }

            // Cash pays only the upfront deposit online; online pays the full fare.
            $isCash = strtolower((string) $lockedHold->payment_method) === 'cash';
            $fareOnline = $isCash
                ? app(\App\Services\CashDepositService::class)->quote((float) $lockedHold->amount)['deposit']
                : (float) $lockedHold->amount;

            // Fixed policy: the RIDER bears the gateway fee, added on top of what's
            // charged online — the full fare on an online seat, the deposit on a
            // cash seat — and shown as its own line at checkout. Must match the fee
            // recorded on the Payment at confirm (BookingPaymentService::recordSeatCapture).
            $gatewayFees = app(\App\Services\GatewayFeeService::class);
            $fee = $gatewayFees->customerBears('fixed')
                ? $gatewayFees->feeFor($fareOnline)
                : 0.0;
            $chargeOnline = round($fareOnline + $fee, 2);

            $amountPaise = max(100, (int) round($chargeOnline * 100));
            $receipt = 'fixed_' . $lockedHold->id . '_' . now()->format('YmdHis');
            $order = $razorpayService->createOrder($amountPaise, $receipt);

            $lockedHold->update([
                'razorpay_order_id' => $order['order_id'],
            ]);

            return [
                'key_id' => (string) config('services.razorpay.key_id'),
                'order_id' => $order['order_id'],
                'amount_paise' => $order['amount'],
                'currency' => $order['currency'],
                // Checkout breakdown: fare + payment charge + total to pay.
                'breakdown' => [
                    'fare' => round($fareOnline, 2),
                    'gateway_fee' => round($fee, 2),
                    'total' => $chargeOnline,
                ],
            ];
        });
    }

    private function resolveFixedCoupon(User $customer, RouteDeparture $departure, \App\Models\Route $route, RouteStop $boardStop, RouteStop $dropStop, float $baseAmount, ?string $couponTitle): array
    {
        $couponTitle = trim((string) $couponTitle);
        if ($couponTitle === '') {
            return [
                'assignment_id' => null,
                'discount' => 0.0,
                'final_amount' => round($baseAmount, 2),
                'coupon' => null,
            ];
        }

        $result = $this->coupons->resolveForUser(
            code: $couponTitle,
            userId: (int) $customer->id,
            cityId: (int) $route->city_id,
            baseAmount: (float) $baseAmount,
            cityVehicleTypeId: $departure->city_vehicle_type_id ? (int) $departure->city_vehicle_type_id : null,
            pickupLat: $boardStop->lat !== null ? (float) $boardStop->lat : null,
            pickupLng: $boardStop->lng !== null ? (float) $boardStop->lng : null,
            dropLat: $dropStop->lat !== null ? (float) $dropStop->lat : null,
            dropLng: $dropStop->lng !== null ? (float) $dropStop->lng : null,
        );

        if (!$result['ok']) {
            throw new ReservationException($result['error'], 422);
        }

        if ((float) $result['final_amount'] < 1.0) {
            throw new ReservationException('This coupon makes the payable amount below the online payment minimum. Please use a smaller coupon.', 422);
        }

        return [
            'assignment_id' => (int) $result['assignment']->id,
            'discount' => (float) $result['discount'],
            'final_amount' => (float) $result['final_amount'],
            'coupon' => [
                'assignment_id' => (int) $result['assignment']->id,
                'title' => (string) $result['assignment']->coupon->title,
            ],
        ];
    }

    private function assertCouponStillRedeemable(FixedSeatHold $hold, User $customer, RouteDeparture $departure, \App\Models\Route $route, RouteStop $boardStop, RouteStop $dropStop, float $baseAmount): void
    {
        if (!$hold->coupon_assignment_id) {
            return;
        }

        $assignment = CouponAssignment::query()
            ->with('coupon')
            ->where('id', $hold->coupon_assignment_id)
            ->where('user_id', $customer->id)
            ->whereNull('used_at')
            ->where(function ($query) {
                $query->whereNull('expires_at')
                    ->orWhere('expires_at', '>=', now());
            })
            ->lockForUpdate()
            ->first();

        if (!$assignment || !$assignment->coupon || !$assignment->coupon->is_active) {
            throw new ReservationException('This coupon has expired or is no longer available.', 422);
        }

        $resolved = $this->resolveFixedCoupon(
            $customer,
            $departure,
            $route,
            $boardStop,
            $dropStop,
            $baseAmount,
            (string) $assignment->coupon->title,
        );

        if ((int) $resolved['assignment_id'] !== (int) $assignment->id
            || round((float) $resolved['final_amount'], 2) !== round((float) $hold->amount - (float) ($hold->tip_amount ?? 0), 2)
            || round((float) $resolved['discount'], 2) !== round((float) $hold->discount_amount, 2)) {
            throw new ReservationException('This coupon is no longer valid for this fixed booking. Please create a new hold.', 422);
        }
    }

    private function markCouponRedeemed(FixedSeatHold $hold): void
    {
        if (!$hold->coupon_assignment_id) {
            return;
        }

        CouponAssignment::query()
            ->where('id', $hold->coupon_assignment_id)
            ->whereNull('used_at')
            ->update(['used_at' => now()]);
    }

    private function bookingCommissionForDeparture(RouteDeparture $departure, \App\Models\Route $route, float $fareAmount, int $seats): array
    {
        $standard = $this->pricing->bookingCommission($route, $fareAmount, $seats);
        if (!$departure->driver_id) {
            return $standard;
        }

        $departure->loadMissing("cityVehicleType:id,vehicle_type_id");
        $vehicleTypeId = $departure->cityVehicleType?->vehicle_type_id;

        $subPercent = $this->subscriptions->effectiveCommissionPercent(
            (int) $departure->driver_id,
            $vehicleTypeId ? (int) $vehicleTypeId : null,
            -1.0,
        );

        if ($subPercent < 0.0) {
            return $standard;
        }

        $fare = max(0.0, round($fareAmount, 2));
        $percent = max(0.0, $subPercent);
        $amount = round($fare * $percent / 100, 2);

        return ["percent" => round($percent, 2), "amount" => min($amount, $fare)];
    }

    private function notifyBookingConfirmed(SeatReservation $reservation): void
    {
        $reservation->loadMissing(["route:id,name", "routeDeparture:id,driver_id,route_id,service_date,depart_at,announced_depart_at"]);
        $routeName = $reservation->route?->name ?: "Fixed route";
        $data = $this->notificationData($reservation);

        $this->notifier->notifyUserId(
            $reservation->customer_id,
            "fixed_booking_confirmed",
            "Fixed booking confirmed",
            "Your booking for " . $routeName . " is confirmed.",
            $data,
            "check-circle",
        );

        $driverId = $reservation->routeDeparture?->driver_id;
        if ($driverId) {
            $this->notifier->notifyUserId(
                (int) $driverId,
                "fixed_passenger_added",
                "New fixed passenger",
                "A passenger booked seats on " . $routeName . ".",
                $data,
                "users",
            );
        }

        $this->notifier->notifyAdmins(
            "fixed_booking_created",
            "New fixed booking",
            "A customer booked seats on " . $routeName . ".",
            $data,
            "calendar",
        );

        if ($reservation->payment_status === 'PAID') {
            try {
                app(\App\Services\RazorpayService::class)->createInvoiceForFixedBooking(
                    $reservation,
                    (float) $reservation->fare_amount,
                    (string) $reservation->payment_reference
                );
            } catch (\Throwable $e) {
                \Illuminate\Support\Facades\Log::warning('Fixed booking auto-invoice failed: ' . $e->getMessage(), [
                    'reservation_id' => $reservation->id,
                ]);
            }
        }
    }

    private function notificationData(SeatReservation $reservation): array
    {
        return [
            "reservation_id" => $reservation->id,
            "route_departure_id" => $reservation->route_departure_id,
            "route_id" => $reservation->route_id,
            "trip_id" => $reservation->trip_id,
            "customer_id" => $reservation->customer_id,
            "seats" => $reservation->seats,
            "status" => $reservation->status,
        ];
    }

    private function broadcastDepartureUpdate(int $departureId, string $reason): void
    {
        $departure = RouteDeparture::query()->with('route:id,city_id')->find($departureId);
        if ($departure?->route?->city_id) {
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

    private function razorpayOrderResponse(FixedSeatHold $hold): array
    {
        return [
            'key_id' => (string) config('services.razorpay.key_id'),
            'order_id' => (string) $hold->razorpay_order_id,
            'amount_paise' => max(100, (int) round(((float) $hold->amount) * 100)),
            'currency' => (string) config('services.razorpay.currency', 'INR'),
        ];
    }
    private function resolveChannel(string $requested): string
    {
        if (!in_array($requested, ['advance', 'on_spot'], true)) {
            throw new ReservationException('This fixed route does not allow that booking channel.', 422);
        }

        return $requested;
    }

    private function resolveStop(int $routeId, int $stopId, string $flag, string $label): RouteStop
    {
        $stop = RouteStop::query()->where('route_id', $routeId)->where('id', $stopId)->first();
        if (!$stop || !$stop->{$flag}) {
            throw new ReservationException("That {$label} stop is not valid for this route.", 422);
        }
        if (!$stop->is_active || $stop->is_temporarily_unavailable) {
            throw new ReservationException("That {$label} stop is currently unavailable.", 422);
        }

        return $stop;
    }
}
