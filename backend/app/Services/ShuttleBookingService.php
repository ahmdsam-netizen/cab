<?php

namespace App\Services;

use App\Exceptions\ReservationException;
use App\Jobs\DispatchHopJob;
use App\Models\CitySetting;
use App\Models\CityVehicleType;
use App\Models\CouponAssignment;
use App\Models\FareNegotiation;
use App\Models\PricingRule;
use App\Models\ShuttleJourney;
use App\Models\ShuttlePassengerBooking;
use App\Models\Trip;
use App\Models\User;
use Illuminate\Support\Facades\DB;

class ShuttleBookingService
{
    public function __construct(
        private readonly FareEstimationService $fares,
        private readonly ShuttleSeatMapService $seatMaps,
        private readonly CouponService $coupons,
    ) {}

    public function createBooking(User $customer, array $data): ShuttlePassengerBooking
    {
        $cvt = $this->resolveShuttleVehicle($data);
        $pricingRule = PricingRule::resolveFor((int) $cvt->id);
        if (!$pricingRule) {
            throw new ReservationException('Shuttle fare is not configured for this vehicle yet.', 404);
        }

        $estimate = $this->fares->estimateFare(
            $pricingRule->toArray(),
            (float) $data['pickup_lat'],
            (float) $data['pickup_lng'],
            (float) $data['drop_lat'],
            (float) $data['drop_lng'],
            null,
            null,
            isset($data['route_distance_km']) ? (float) $data['route_distance_km'] : null,
            isset($data['route_time_min']) ? (float) $data['route_time_min'] : null,
            (CitySetting::query()->firstOrCreate(['city_id' => $cvt->city_id])->toll_mode === 'yes') ? (float) ($data['toll_amount'] ?? 0) : 0.0,
        );

        $tipAmount = max(0.0, round((float) ($data['tip_amount'] ?? 0), 2));
        $estimatedFare = round((float) $estimate['estimated_fare'], 2);

        // Coupon (Model A — the OPERATOR funds it). The coupon discounts the fare;
        // fare_amount stores what the customer PAYS (fare − discount + tip). The
        // driver later settles on the GROSS fare (fare + tip) so the operator
        // absorbs the discount — see CommissionSettlementService::settleShuttle.
        $coupon = $this->resolveShuttleCoupon($customer, $cvt, $data, $estimatedFare);
        $discount = round((float) $coupon['discount'], 2);
        $payableFare = round(max(0.0, $estimatedFare - $discount), 2);
        $totalFare = round($payableFare + $tipAmount, 2);

        // Cash = pay a deposit online now, the rest to the driver in cash at trip end.
        $paymentMethod = strtolower((string) ($data['payment_method'] ?? 'razorpay')) === 'cash' ? 'cash' : 'razorpay';
        if ($paymentMethod === 'cash' && ! app(CashDepositService::class)->cashEnabled()) {
            throw new ReservationException('Cash is not available for this operator.', 422);
        }

        return DB::transaction(function () use ($customer, $data, $cvt, $pricingRule, $estimate, $tipAmount, $totalFare, $discount, $coupon, $paymentMethod) {
            // Pooling (decision 1A): join a still-forming journey heading the same
            // way if one fits, otherwise start a fresh one.
            $journey = $this->resolveJourneyForBooking($cvt, $data);

            return ShuttlePassengerBooking::query()->create([
                'shuttle_journey_id' => $journey->id,
                'city_id' => $cvt->city_id,
                'city_vehicle_type_id' => $cvt->id,
                'scope' => $data['scope'] ?? 'local',
                'pricing_rule_id' => $pricingRule->id,
                'customer_id' => $customer->id,
                'seats' => 1,
                'pickup_lat' => (float) $data['pickup_lat'],
                'pickup_lng' => (float) $data['pickup_lng'],
                'pickup_address' => $data['pickup_address'] ?? null,
                'drop_lat' => (float) $data['drop_lat'],
                'drop_lng' => (float) $data['drop_lng'],
                'drop_address' => $data['drop_address'] ?? null,
                'quote_distance_km' => $estimate['distance_km'] ?? null,
                'quote_time_min' => $estimate['time_min'] ?? null,
                'fare_amount' => $totalFare,
                'tip_amount' => $tipAmount,
                'coupon_assignment_id' => $coupon['assignment_id'],
                'promo_discount_amount' => $discount > 0 ? $discount : null,
                'fare_breakdown' => $estimate['fare_breakdown'] ?? [],
                'currency' => 'INR',
                'payment_method' => $paymentMethod,
                'payment_status' => 'PENDING',
                'status' => 'PENDING_DRIVER_APPROVAL',
            ]);
        });
    }

    /**
     * Read-only coupon check for the shuttle fare step. Prices the trip the same
     * way createBooking does, resolves the coupon against the pre-tip fare, and
     * returns the discount so the customer sees it before booking. Does NOT create
     * a booking or burn the coupon. Mirrors the Fixed coupon-preview.
     *
     * @return array{base_amount:float,discount:float,final_amount:float,coupon:?array{title:string}}
     */
    public function previewCoupon(User $customer, array $data): array
    {
        $cvt = $this->resolveShuttleVehicle($data);
        $pricingRule = PricingRule::resolveFor((int) $cvt->id);
        if (!$pricingRule) {
            throw new ReservationException('Shuttle fare is not configured for this vehicle yet.', 404);
        }

        $estimate = $this->fares->estimateFare(
            $pricingRule->toArray(),
            (float) $data['pickup_lat'],
            (float) $data['pickup_lng'],
            (float) $data['drop_lat'],
            (float) $data['drop_lng'],
            null,
            null,
            isset($data['route_distance_km']) ? (float) $data['route_distance_km'] : null,
            isset($data['route_time_min']) ? (float) $data['route_time_min'] : null,
            (CitySetting::query()->firstOrCreate(['city_id' => $cvt->city_id])->toll_mode === 'yes') ? (float) ($data['toll_amount'] ?? 0) : 0.0,
        );

        $baseAmount = round((float) $estimate['estimated_fare'], 2);
        $coupon = $this->resolveShuttleCoupon($customer, $cvt, $data, $baseAmount);
        $discount = round((float) $coupon['discount'], 2);

        return [
            'base_amount' => $baseAmount,
            'discount' => $discount,
            'final_amount' => round(max(0.0, $baseAmount - $discount), 2),
            'coupon' => $coupon['assignment_id'] ? ['title' => trim((string) ($data['coupon_title'] ?? ''))] : null,
        ];
    }

    /**
     * Pooling matcher (decision 1A). Returns a still-forming journey this rider
     * can share, or a fresh one. A journey is joinable when it's the same vehicle
     * type + scope, still open for riders (DISPATCH_DISABLED / FORMING), has a free
     * seat, and an existing rider's pickup AND drop are each within the city's
     * shuttle match distances of this rider's. The chosen journey is row-locked and
     * re-checked before its seat count is bumped, so two riders can't overfill it.
     *
     * NOTE: the per-rider added-delay cap (shuttle_max_passenger_delay_minutes) is a
     * routing-based refinement not evaluated here — matching is by corridor
     * (pickup-near-pickup, drop-near-drop) for now.
     */
    private function resolveJourneyForBooking(CityVehicleType $cvt, array $data): ShuttleJourney
    {
        $settings = CitySetting::query()->where('city_id', $cvt->city_id)->first();
        $pickupKm = (float) ($settings?->shuttle_pickup_match_distance_km ?? 1.5);
        $dropKm = (float) ($settings?->shuttle_drop_match_distance_km ?? 1.5);
        $scope = $data['scope'] ?? 'local';

        $pLat = (float) $data['pickup_lat'];
        $pLng = (float) $data['pickup_lng'];
        $dLat = (float) $data['drop_lat'];
        $dLng = (float) $data['drop_lng'];

        $candidates = ShuttleJourney::query()
            ->where('city_vehicle_type_id', $cvt->id)
            ->whereNull('dispatched_at')
            ->whereIn('status', ['DISPATCH_DISABLED', 'FORMING'])
            ->whereColumn('seats_taken', '<', 'capacity')
            ->orderByDesc('id')
            ->limit(25)
            ->get();

        foreach ($candidates as $candidate) {
            $anchor = ShuttlePassengerBooking::query()
                ->where('shuttle_journey_id', $candidate->id)
                ->whereIn('status', ['PENDING_DRIVER_APPROVAL', 'PAYMENT_PENDING', 'CONFIRMED', 'BOARDED'])
                ->where('scope', $scope)
                ->orderBy('id')
                ->first();
            if (! $anchor) {
                continue;
            }

            $pickupClose = $this->kmBetween($pLat, $pLng, (float) $anchor->pickup_lat, (float) $anchor->pickup_lng) <= $pickupKm;
            $dropClose = $this->kmBetween($dLat, $dLng, (float) $anchor->drop_lat, (float) $anchor->drop_lng) <= $dropKm;
            if (! $pickupClose || ! $dropClose) {
                continue;
            }

            // Lock and re-check before committing to the join.
            $locked = ShuttleJourney::query()->whereKey($candidate->id)->lockForUpdate()->first();
            if ($locked
                && $locked->dispatched_at === null
                && in_array($locked->status, ['DISPATCH_DISABLED', 'FORMING'], true)
                && (int) $locked->seats_taken < (int) $locked->capacity) {
                $locked->increment('seats_taken');

                return $locked;
            }
        }

        // Nobody to share with → a fresh journey carrying this one rider.
        return ShuttleJourney::query()->create([
            'city_id' => $cvt->city_id,
            'city_vehicle_type_id' => $cvt->id,
            'status' => 'DISPATCH_DISABLED',
            'capacity' => max(1, (int) $cvt->max_people),
            'seats_taken' => 1,
        ]);
    }

    /** Great-circle distance in kilometres. */
    private function kmBetween(float $lat1, float $lng1, float $lat2, float $lng2): float
    {
        $earthKm = 6371.0;
        $dLat = deg2rad($lat2 - $lat1);
        $dLng = deg2rad($lng2 - $lng1);
        $a = sin($dLat / 2) ** 2 + cos(deg2rad($lat1)) * cos(deg2rad($lat2)) * sin($dLng / 2) ** 2;

        return $earthKm * 2 * atan2(sqrt($a), sqrt(1 - $a));
    }

    public function createRazorpayOrder(User $customer, ShuttlePassengerBooking $booking, RazorpayService $razorpay): array
    {
        return DB::transaction(function () use ($customer, $booking, $razorpay) {
            $locked = ShuttlePassengerBooking::query()->lockForUpdate()->find($booking->id);
            if (!$locked || $locked->customer_id !== $customer->id) {
                throw new ReservationException('This Shuttle booking could not be found.', 404);
            }
            if ($locked->status !== 'PAYMENT_PENDING') {
                throw new ReservationException('This Shuttle booking is not waiting for payment.', 422);
            }
            $this->assertDriverApproved($locked);
            $this->assertCouponStillRedeemable($locked, $customer);
            if ($locked->payment_method === 'cash' && !app(CashDepositService::class)->cashEnabled()) {
                throw new ReservationException('Cash is not available.', 422);
            }
            if ((float) $locked->fare_amount <= 0) {
                throw new ReservationException('Shuttle fare is not available for this booking.', 422);
            }
            if ($locked->razorpay_order_id) {
                return $this->razorpayOrderResponse($locked);
            }

            // Cash pays only the upfront deposit online; online pays the full fare.
            $onlineAmount = strtolower((string) $locked->payment_method) === 'cash'
                ? app(CashDepositService::class)->quote((float) $locked->fare_amount)['deposit']
                : (float) $locked->fare_amount;

            if ($locked->payment_method === 'cash' && $onlineAmount <= 0) {
                $this->confirmCashBooking($locked);
                return ['payment_required' => false, 'booking_id' => $locked->id];
            }

            $amountPaise = max(100, (int) round($onlineAmount * 100));
            $receipt = 'shuttle_' . $locked->id . '_' . now()->format('YmdHis');
            $order = $razorpay->createOrder($amountPaise, $receipt);

            $locked->update([
                'payment_status' => 'ORDER_CREATED',
                'razorpay_order_id' => $order['order_id'],
            ]);

            return [
                'key_id' => (string) config('services.razorpay.key_id'),
                'order_id' => $order['order_id'],
                'amount_paise' => $order['amount'],
                'currency' => $order['currency'],
            ];
        });
    }

    public function confirmPayment(User $customer, ShuttlePassengerBooking $booking, array $data, RazorpayService $razorpay): ShuttlePassengerBooking
    {
        $confirmed = DB::transaction(function () use ($customer, $booking, $data, $razorpay) {
            $locked = ShuttlePassengerBooking::query()->lockForUpdate()->find($booking->id);
            if (!$locked || $locked->customer_id !== $customer->id) {
                throw new ReservationException("This Shuttle booking could not be found.", 404);
            }
            if ($locked->status === 'CONFIRMED' && $locked->payment_status === 'PAID'
                && $locked->razorpay_payment_id === ($data['razorpay_payment_id'] ?? null)
                && $locked->razorpay_order_id === ($data['razorpay_order_id'] ?? null)) {
                return $locked;
            }
            if (!in_array($locked->status, ["PAYMENT_PENDING", "CONFIRMED"], true)) {
                throw new ReservationException("This Shuttle booking is not waiting for payment.", 422);
            }
            $this->assertDriverApproved($locked);
            $this->assertCouponStillRedeemable($locked, $customer);

            $razorpayOrderId = trim((string) $data["razorpay_order_id"]);
            $razorpayPaymentId = trim((string) $data["razorpay_payment_id"]);
            $razorpaySignature = trim((string) $data["razorpay_signature"]);
            if (!$locked->razorpay_order_id || $locked->razorpay_order_id !== $razorpayOrderId) {
                throw new ReservationException("Payment order does not match this Shuttle booking.", 422);
            }
            if ($locked->razorpay_payment_id && $locked->razorpay_payment_id !== $razorpayPaymentId) {
                throw new ReservationException("This Shuttle booking is already linked to another payment.", 422);
            }
            if (!$razorpay->verifyPaymentSignature($razorpayOrderId, $razorpayPaymentId, $razorpaySignature)) {
                throw new ReservationException("Payment verification failed.", 422);
            }

            $locked->update([
                "payment_status" => "PAID",
                "payment_reference" => $razorpayPaymentId,
                "razorpay_payment_id" => $razorpayPaymentId,
                "razorpay_signature" => $razorpaySignature,
                "status" => "CONFIRMED",
            ]);

            $trip = $this->ensureDispatchTrip($locked);

            // Commit any seats the customer held for this booking (HELD → BOOKED).
            // No-op when the customer skipped seat selection.
            $this->seatMaps->bookSeats($locked);

            // Burn the coupon (if any) now that payment is real.
            $this->markCouponRedeemed($locked);

            $this->recordSplitCapture($locked, $trip, $razorpayPaymentId);
            app(BookingConfirmationService::class)->confirmIfReady($trip);

            return $locked->fresh();
        });

        $this->dispatchInvoiceForShuttle($confirmed, (string) ($confirmed->razorpay_payment_id ?? ''));

        return $confirmed;
    }

    /**
     * Server-verified confirmation used by the Razorpay webhook and the
     * pending-payment sweeper: Razorpay already told us the order's payment is
     * captured, so there is no checkout signature and no logged-in customer.
     * Idempotent — an already-PAID booking is returned unchanged.
     */
    public function confirmPaidServerVerified(ShuttlePassengerBooking $booking, string $razorpayPaymentId, string $source = 'webhook'): ShuttlePassengerBooking
    {
        $confirmed = DB::transaction(function () use ($booking, $razorpayPaymentId, $source) {
            $locked = ShuttlePassengerBooking::query()->lockForUpdate()->find($booking->id);
            if (!$locked) {
                throw new ReservationException('This Shuttle booking could not be found.', 404);
            }
            if ($locked->payment_status === 'PAID') {
                return $locked->fresh();
            }
            if (!in_array($locked->status, ['PAYMENT_PENDING', 'CONFIRMED'], true)) {
                throw new ReservationException('This Shuttle booking is not waiting for payment.', 422);
            }
            $this->assertDriverApproved($locked);
            $this->assertCouponStillRedeemable($locked);
            if ($locked->razorpay_payment_id && $locked->razorpay_payment_id !== $razorpayPaymentId) {
                throw new ReservationException('This Shuttle booking is already linked to another payment.', 422);
            }

            $locked->update([
                'payment_status' => 'PAID',
                'payment_reference' => $razorpayPaymentId,
                'razorpay_payment_id' => $razorpayPaymentId,
                'razorpay_signature' => 'server_verified:' . $source,
                'status' => 'CONFIRMED',
            ]);

            $trip = $this->ensureDispatchTrip($locked);

            // Commit any seats the customer held for this booking (HELD → BOOKED).
            $this->seatMaps->bookSeats($locked);

            // Burn the coupon (if any) now that payment is real.
            $this->markCouponRedeemed($locked);

            $this->recordSplitCapture($locked, $trip, $razorpayPaymentId);
            app(BookingConfirmationService::class)->confirmIfReady($trip);

            return $locked->fresh();
        });

        $this->dispatchInvoiceForShuttle($confirmed, $razorpayPaymentId);

        return $confirmed;
    }

    /**
     * Triggers Razorpay to automatically generate and email the bill/ticket to the passenger.
     */
    private function dispatchInvoiceForShuttle(ShuttlePassengerBooking $booking, string $paymentId): void
    {
        try {
            app(\App\Services\RazorpayService::class)->createInvoiceForShuttleBooking(
                $booking,
                (float) ($booking->fare_amount ?? 0),
                $paymentId
            );
        } catch (\Throwable $e) {
            \Illuminate\Support\Facades\Log::warning('Shuttle booking auto-invoice failed: ' . $e->getMessage(), [
                'shuttle_booking_id' => $booking->id,
            ]);
        }
    }

    /**
     * Phase 5 — mirror a confirmed Shuttle prepayment onto the shared money engine
     * so the driver's share is split via Route at trip completion. The commission
     * is snapshotted from the city's standard rule (the driver isn't assigned yet,
     * so no subscription override applies). No-op while the split engine is off,
     * in which case the legacy settlement path stays in charge.
     */
    private function recordSplitCapture(ShuttlePassengerBooking $booking, Trip $trip, string $razorpayPaymentId): void
    {
        $fare = (float) $booking->fare_amount;
        $commission = app(CommissionSettlementService::class)
            ->commissionForFare($trip->city_vehicle_type_id, $fare);

        // Cash: only the upfront deposit was captured online (the rest is cash to
        // the driver). The deposit settles wholly to the driver at completion and
        // the operator's commission comes from the driver's wallet — the snapshot
        // rides along to drive that debit, not a retention from the deposit.
        $cashDeposit = null;
        $cashBalance = null;
        if (strtolower((string) $booking->payment_method) === 'cash') {
            $quote = app(CashDepositService::class)->quote($fare);
            $cashDeposit = $quote['deposit'];
            $cashBalance = $quote['balance'];
        }

        // Shuttle policy: the OPERATOR bears the gateway fee. The fee base is what's
        // charged online — the full fare on an online seat, the deposit on a cash
        // seat. Online: booked against the operator's slice at settlement. Cash: the
        // deposit is wholly the driver's, so it's recorded on the payment for the
        // operator's net-settlement but NOT booked in the trip ledger (see
        // PaymentSplitService::operatorFeePaise).
        $gatewayFees = app(\App\Services\GatewayFeeService::class);
        $feeBase = $cashDeposit !== null ? (float) $cashDeposit : $fare;
        $operatorFee = $gatewayFees->operatorBears('shuttle') ? $gatewayFees->feeFor($feeBase) : 0.0;

        app(BookingPaymentService::class)->recordCapture(
            $trip->id,
            $razorpayPaymentId,
            $fare,
            (float) $commission['amount'],
            (string) ($booking->currency ?: 'INR'),
            $cashDeposit,
            $cashBalance,
            0.0,
            $operatorFee,
        );
    }

    public function shapeBooking(ShuttlePassengerBooking $booking): array
    {
        $booking->loadMissing(['journey:id,status,capacity,seats_taken,trip_id', 'cityVehicleType:id,display_name,vehicle_type_id,ride_type_id']);

        $seatLabels = \App\Models\JourneySeat::query()
            ->where('shuttle_passenger_booking_id', $booking->id)
            ->whereIn('status', ['HELD', 'BOOKED'])
            ->orderBy('label')
            ->pluck('label')
            ->all();

        // Boarding confirmation (5B): the mode the operator set, and — for otp/qr
        // modes — the rider's own system-generated code (in-app, no SMS). The
        // customer app shows the number or renders it as a QR for the driver.
        $boardingMode = (string) (CitySetting::query()
            ->where('city_id', $booking->city_id)
            ->value('shuttle_boarding_confirmation_mode') ?? 'driver_only');
        $boardingCode = $boardingMode === 'driver_only'
            ? null
            : app(ShuttleBoardingOtpService::class)->codeForCustomer($booking);

        return [
            'id' => $booking->id,
            'shuttle_journey_id' => $booking->shuttle_journey_id,
            'trip_id' => $booking->journey?->trip_id,
            'seat_labels' => $seatLabels,
            'boarding_mode' => $boardingMode,
            'boarding_code' => $boardingCode,
            'journey_status' => $booking->journey?->status,
            'city_id' => $booking->city_id,
            'city_vehicle_type_id' => $booking->city_vehicle_type_id,
            'scope' => $booking->scope ?? 'local',
            'vehicle_name' => $booking->cityVehicleType?->display_name,
            'pickup' => [
                'lat' => (float) $booking->pickup_lat,
                'lng' => (float) $booking->pickup_lng,
                'address' => $booking->pickup_address,
            ],
            'drop' => [
                'lat' => (float) $booking->drop_lat,
                'lng' => (float) $booking->drop_lng,
                'address' => $booking->drop_address,
            ],
            'fare_amount' => (float) $booking->fare_amount,
            'upfront_amount' => $booking->payment_method === 'cash'
                ? app(CashDepositService::class)->quote((float) $booking->fare_amount)['deposit'] : (float) $booking->fare_amount,
            'cash_balance_due' => $booking->payment_method === 'cash'
                ? app(CashDepositService::class)->quote((float) $booking->fare_amount)['balance'] : 0,
            'promo_discount_amount' => $booking->promo_discount_amount !== null ? (float) $booking->promo_discount_amount : 0.0,
            'currency' => $booking->currency,
            'payment_method' => $booking->payment_method,
            'payment_status' => $booking->payment_status,
            'refund_status' => $booking->refund_status,
            'refund_reference' => $booking->refund_reference,
            'refund_amount' => $booking->refund_amount,
            'status' => $booking->status,
            'cancelled_reason' => $booking->cancelled_reason,
            'shuttle_pickup_arrived_at' => optional($booking->shuttle_pickup_arrived_at)->toIso8601String(),
            'shuttle_no_show_after_at' => optional($booking->shuttle_no_show_after_at)->toIso8601String(),
            'shuttle_driver_missed_after_at' => optional($booking->shuttle_driver_missed_after_at)->toIso8601String(),
            'shuttle_auto_processed_at' => optional($booking->shuttle_auto_processed_at)->toIso8601String(),
            'shuttle_auto_outcome' => $booking->shuttle_auto_outcome,
            'booking_enabled_for_driver' => false,
            'created_at' => optional($booking->created_at)->toIso8601String(),
        ];
    }

    /** Request a driver only after the rider has selected a seat. */
    public function requestDriver(ShuttlePassengerBooking $booking): void
    {
        DB::transaction(function () use ($booking) {
            $locked = ShuttlePassengerBooking::query()->lockForUpdate()->findOrFail($booking->id);
            if ($locked->status !== 'PENDING_DRIVER_APPROVAL') {
                return;
            }
            $trip = $this->ensureDispatchTrip($locked);
            if ($trip->status !== 'NEGOTIATION') {
                throw new ReservationException('This pool has already been accepted. Please request a new booking.', 409);
            }
            $requested = ShuttlePassengerBooking::query()->where('shuttle_journey_id', $locked->shuttle_journey_id)
                ->where('status', 'PENDING_DRIVER_APPROVAL')
                ->whereIn('id', \App\Models\JourneySeat::query()->where('status', 'HELD')->select('shuttle_passenger_booking_id'));
            $fare = (float) (clone $requested)->sum('fare_amount');
            $trip->update(['estimated_fare' => $fare]);
            $trip->fareNegotiation?->offers()->where('from_role', 'customer')->update(['amount' => $fare]);
            $journey = ShuttleJourney::query()->lockForUpdate()->findOrFail($locked->shuttle_journey_id);
            if ($journey->dispatched_at === null && ((int) (clone $requested)->sum('seats') >= (int) $journey->capacity
                || ($journey->forming_deadline_at && $journey->forming_deadline_at->lte(now())))) {
                $journey->update(['dispatched_at' => now()]);
                DB::afterCommit(fn () => DispatchHopJob::startChain($trip->id, $fare));
            }
        });
    }

    public function driverApproved(Trip $trip): void
    {
        $journey = ShuttleJourney::query()->where('trip_id', $trip->id)->first();
        if (!$journey) {
            return;
        }
        $bookings = ShuttlePassengerBooking::query()->where('shuttle_journey_id', $journey->id)
            ->where('status', 'PENDING_DRIVER_APPROVAL')->lockForUpdate()->get();
        foreach ($bookings as $booking) {
            if (!\App\Models\JourneySeat::query()->where('shuttle_passenger_booking_id', $booking->id)->where('status', 'HELD')->exists()) {
                $booking->update(['status' => 'CANCELLED', 'cancelled_at' => now(), 'cancelled_reason' => 'Seat selection was not completed before driver acceptance. Please book again.']);
                $journey->decrement('seats_taken', (int) $booking->seats);
                continue;
            }
            $booking->update(['status' => 'PAYMENT_PENDING']);
            if ($booking->payment_method === 'cash' && app(CashDepositService::class)->quote((float) $booking->fare_amount)['deposit'] <= 0) {
                $this->confirmCashBooking($booking);
            }
            DB::afterCommit(function () use ($booking, $trip) {
                app(NotificationCenter::class)->notifyUserId($booking->customer_id, 'shuttle_driver_accepted',
                    'Driver accepted', 'Your driver accepted. Complete any required payment to confirm your seat.',
                    ['booking_id' => $booking->id, 'trip_id' => $trip->id]);
            });
        }
    }

    private function assertDriverApproved(ShuttlePassengerBooking $booking): Trip
    {
        $journey = ShuttleJourney::query()->findOrFail($booking->shuttle_journey_id);
        $trip = $journey->trip_id ? Trip::query()->find($journey->trip_id) : null;
        if (!$trip || !$trip->driver_id || !in_array($trip->status, ['PAYMENT_PENDING', 'CONFIRMED', 'ASSIGNED'], true)) {
            throw new ReservationException('Driver approval is required before payment.', 422);
        }
        $seats = \App\Models\JourneySeat::query()->where('shuttle_passenger_booking_id', $booking->id)
            ->whereIn('status', ['HELD', 'BOOKED'])->count();
        if ($seats !== (int) $booking->seats) {
            throw new ReservationException('Select your seat before payment.', 422);
        }
        return $trip;
    }

    private function confirmCashBooking(ShuttlePassengerBooking $booking): void
    {
        $trip = $this->assertDriverApproved($booking);
        $this->assertCouponStillRedeemable($booking);
        if (!app(CashDepositService::class)->cashEnabled()) {
            throw new ReservationException('Cash is not available.', 422);
        }
        $booking->update(['status' => 'CONFIRMED', 'payment_status' => 'PENDING']);
        $this->seatMaps->bookSeats($booking);
        $this->markCouponRedeemed($booking);
        app(BookingConfirmationService::class)->confirmIfReady($trip);
    }

    private function ensureDispatchTrip(ShuttlePassengerBooking $booking): Trip
    {
        $journey = ShuttleJourney::query()
            ->where('id', $booking->shuttle_journey_id)
            ->lockForUpdate()
            ->first();

        if (!$journey) {
            throw new ReservationException("This Shuttle journey could not be found.", 404);
        }

        if ($journey->trip_id) {
            return Trip::query()->findOrFail($journey->trip_id);
        }

        $cvt = CityVehicleType::query()->findOrFail($booking->city_vehicle_type_id);
        $fare = (float) $booking->fare_amount;

        $trip = Trip::query()->create([
            'customer_id' => $booking->customer_id,
            'driver_id' => null,
            'city_id' => $booking->city_id,
            'scope' => $booking->scope ?? 'local',
            'ride_type_id' => $cvt->ride_type_id,
            // trips.vehicle_type_id FKs to city_vehicle_types (the per-city
            // catalogue row), NOT to the global vehicle_types lookup — that one is
            // requested_vehicle_type_id. Passing the global id here only happened
            // to work while the two id sequences overlapped.
            'vehicle_type_id' => $cvt->id,
            'requested_vehicle_type_id' => $cvt->vehicle_type_id,
            'city_vehicle_type_id' => $booking->city_vehicle_type_id,
            'pricing_rule_id' => $booking->pricing_rule_id,
            'status' => 'NEGOTIATION',
            'estimated_fare' => $fare,
            'final_fare' => null,
            'currency' => $booking->currency ?: 'INR',
            // Carry the seat's method so settlement takes a cash ride's commission
            // from the driver's wallet (only the deposit was online).
            'payment_method' => $booking->payment_method,
            'pickup_address' => $booking->pickup_address,
            'pickup_lat' => (float) $booking->pickup_lat,
            'pickup_lng' => (float) $booking->pickup_lng,
            'drop_address' => $booking->drop_address,
            'drop_lat' => (float) $booking->drop_lat,
            'drop_lng' => (float) $booking->drop_lng,
            'is_manual_dispatch' => true,
            'negotiation_started_at' => now(),
        ]);

        $negotiation = FareNegotiation::query()->create([
            'trip_id' => $trip->id,
            'customer_id' => $booking->customer_id,
            'status' => 'NEGOTIATING',
        ]);

        $negotiation->offers()->create([
            'from_user_id' => $booking->customer_id,
            'from_role' => 'customer',
            'amount' => $fare,
            'status' => 'PENDING',
        ]);

        // Start the pool-forming window (decision 6C): a driver is dispatched when
        // the van fills or this deadline passes, whichever comes first. A window of
        // 0 dispatches as soon as the first rider selects a seat.
        $window = (int) (CitySetting::query()
            ->where('city_id', $booking->city_id)
            ->value('shuttle_forming_window_minutes') ?? 2);

        $journey->update([
            'trip_id' => $trip->id,
            'status' => 'FORMING',
            'forming_deadline_at' => now()->addMinutes(max(0, $window)),
        ]);

        return $trip;
    }

    /**
     * Resolve an optional customer-typed coupon against this shuttle fare. Returns
     * the assignment id + discount (0 when no coupon), or throws when the coupon is
     * invalid. baseAmount is the pre-coupon FARE (no tip). Mirrors the Fixed flow.
     *
     * @return array{assignment_id:?int,discount:float}
     */
    private function resolveShuttleCoupon(User $customer, CityVehicleType $cvt, array $data, float $baseAmount): array
    {
        $couponTitle = trim((string) ($data['coupon_title'] ?? ''));
        if ($couponTitle === '' || $baseAmount <= 0) {
            return ['assignment_id' => null, 'discount' => 0.0];
        }

        $result = $this->coupons->resolveForUser(
            code: $couponTitle,
            userId: (int) $customer->id,
            cityId: (int) $cvt->city_id,
            baseAmount: $baseAmount,
            cityVehicleTypeId: (int) $cvt->id,
            pickupLat: isset($data['pickup_lat']) ? (float) $data['pickup_lat'] : null,
            pickupLng: isset($data['pickup_lng']) ? (float) $data['pickup_lng'] : null,
            dropLat: isset($data['drop_lat']) ? (float) $data['drop_lat'] : null,
            dropLng: isset($data['drop_lng']) ? (float) $data['drop_lng'] : null,
        );

        if (! $result['ok']) {
            throw new ReservationException($result['error'], 422);
        }

        // Online payment minimum: the payable fare must stay at or above ₹1.
        if ((float) $result['final_amount'] < 1.0) {
            throw new ReservationException('This coupon makes the payable amount below the online payment minimum. Please use a smaller coupon.', 422);
        }

        return [
            'assignment_id' => (int) $result['assignment']->id,
            'discount' => (float) $result['discount'],
        ];
    }

    private function assertCouponStillRedeemable(ShuttlePassengerBooking $booking, ?User $customer = null): void
    {
        if (! $booking->coupon_assignment_id) {
            return;
        }

        $customerId = $customer ? $customer->id : $booking->customer_id;

        $assignment = CouponAssignment::query()
            ->with('coupon')
            ->where('id', $booking->coupon_assignment_id)
            ->where('user_id', $customerId)
            ->whereNull('used_at')
            ->where(function ($query) {
                $query->whereNull('expires_at')
                    ->orWhere('expires_at', '>=', now());
            })
            ->lockForUpdate()
            ->first();

        if (! $assignment || ! $assignment->coupon || ! $assignment->coupon->is_active) {
            throw new ReservationException('This coupon has expired or is no longer available.', 422);
        }

        $customerUser = $customer ?? User::query()->find($customerId);
        $cvt = CityVehicleType::query()->find($booking->city_vehicle_type_id);
        if ($customerUser && $cvt) {
            $baseFare = (float) $booking->fare_amount + (float) ($booking->promo_discount_amount ?? 0) - (float) ($booking->tip_amount ?? 0);
            $resolved = $this->resolveShuttleCoupon($customerUser, $cvt, [
                'coupon_title' => $assignment->coupon->title,
                'pickup_lat' => $booking->pickup_lat,
                'pickup_lng' => $booking->pickup_lng,
                'drop_lat' => $booking->drop_lat,
                'drop_lng' => $booking->drop_lng,
            ], $baseFare);

            if ((int) $resolved['assignment_id'] !== (int) $assignment->id
                || round((float) $resolved['discount'], 2) !== round((float) ($booking->promo_discount_amount ?? 0), 2)) {
                throw new ReservationException('This coupon is no longer valid for this shuttle booking.', 422);
            }
        }
    }

    /** Burn the coupon assignment tied to a booking once its payment confirms. */
    private function markCouponRedeemed(ShuttlePassengerBooking $booking): void
    {
        if (! $booking->coupon_assignment_id) {
            return;
        }

        CouponAssignment::query()
            ->where('id', $booking->coupon_assignment_id)
            ->whereNull('used_at')
            ->update(['used_at' => now()]);
    }

    private function resolveShuttleVehicle(array $data): CityVehicleType
    {
        $query = CityVehicleType::query()
            ->with('rideType:id,name')
            ->where('is_active', true)
            ->whereHas('rideType', fn ($q) => $q->where('mode', \App\Models\RideType::MODE_SHUTTLE));

        if (isset($data['city_vehicle_type_id'])) {
            $query->where('id', (int) $data['city_vehicle_type_id']);
        } else {
            $query->where('city_id', (int) $data['city_id']);
            if (isset($data['vehicle_type_id'])) {
                $query->where('vehicle_type_id', (int) $data['vehicle_type_id']);
            }
        }

        $cvt = $query->orderBy('display_order')->orderBy('id')->first();
        if (!$cvt) {
            $cityId = $data['city_id'] ?? null;
            if (!$cityId && isset($data['city_vehicle_type_id'])) {
                $cityId = CityVehicleType::query()->where('id', $data['city_vehicle_type_id'])->value('city_id');
            }
            if ($cityId) {
                $cvt = CityVehicleType::query()
                    ->with('rideType:id,name')
                    ->where('city_id', (int) $cityId)
                    ->where('is_active', true)
                    ->whereHas('rideType', fn ($q) => $q->where('mode', \App\Models\RideType::MODE_SHUTTLE))
                    ->orderBy('display_order')
                    ->orderBy('id')
                    ->first();
            }
        }
        if (!$cvt) {
            throw new ReservationException('Shuttle is not available for this vehicle in this city yet.', 404);
        }

        return $cvt;
    }

    private function razorpayOrderResponse(ShuttlePassengerBooking $booking): array
    {
        return [
            'key_id' => (string) config('services.razorpay.key_id'),
            'order_id' => (string) $booking->razorpay_order_id,
            'amount_paise' => max(100, (int) round(((float) $booking->fare_amount) * 100)),
            'currency' => (string) config('services.razorpay.currency', 'INR'),
        ];
    }
}
