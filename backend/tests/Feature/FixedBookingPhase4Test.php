<?php

namespace Tests\Feature;

use App\Models\Payment;
use App\Models\Route;
use App\Models\RouteDeparture;
use App\Models\RouteStop;
use App\Models\SeatReservation;
use App\Models\Trip;
use App\Models\User;
use App\Services\FixedStopAutomationService;
use App\Services\RazorpayService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Carbon;
use Laravel\Sanctum\Sanctum;
use Mockery;
use Tests\Support\SeatLayoutFactory;
use Tests\TestCase;

class FixedBookingPhase4Test extends TestCase
{
    use RefreshDatabase;

    private User $customer;
    private User $driver;
    private Route $route;
    private RouteDeparture $departure;
    private RouteStop $pickupStop;
    private RouteStop $dropStop;

    protected function setUp(): void
    {
        parent::setUp();

        $cityId = DB::table('cities')->insertGetId([
            'name' => 'Phase 4 City',
            'country_code' => 'IN',
            'created_at' => now(),
            'updated_at' => now(),
        ]);
        $vehicleTypeId = DB::table('vehicle_types')->insertGetId([
            'name' => 'Ertiga', 'sort_order' => 1, 'is_active' => true,
            'created_at' => now(), 'updated_at' => now(),
        ]);
        $layoutId = SeatLayoutFactory::standardErtiga6P($cityId, $vehicleTypeId);

        $this->customer = User::factory()->create();
        $this->customer->addRole('customer');

        $this->driver = User::factory()->create();
        $this->driver->addRole('driver');

        $this->route = Route::query()->create([
            'city_id' => $cityId,
            'scope' => 'local',
            'mode' => 'fixed',
            'name' => 'Phase 4 Fixed',
            'origin_name' => 'Start Stand',
            'dest_name' => 'Airport',
            'origin_lat' => 34.0000000,
            'origin_lng' => 74.0000000,
            'dest_lat' => 34.1000000,
            'dest_lng' => 74.1000000,
            'fare_config' => ['seat_fare' => 120],
            'booking_window_hours' => 6,
            'max_seats_per_booking' => 4,
            'waiting_time_per_stop_minutes' => 5,
            'luggage_surcharge_amount' => 25,
            'max_luggage_per_vehicle' => 3,
            'requires_prepaid' => true,
            'board_anywhere' => false,
            'is_active' => true,
        ]);

        $this->pickupStop = RouteStop::query()->create([
            'route_id' => $this->route->id,
            'seq' => 1,
            'name' => 'Start Stand',
            'lat' => 34.0000000,
            'lng' => 74.0000000,
            'is_pickup' => true,
            'is_drop' => false,
            'is_active' => true,
            'is_temporarily_unavailable' => false,
        ]);

        $this->dropStop = RouteStop::query()->create([
            'route_id' => $this->route->id,
            'seq' => 2,
            'name' => 'Airport',
            'lat' => 34.1000000,
            'lng' => 74.1000000,
            'is_pickup' => false,
            'is_drop' => true,
            'is_active' => true,
            'is_temporarily_unavailable' => false,
        ]);

        $this->departure = RouteDeparture::query()->create([
            'route_id' => $this->route->id,
            'driver_id' => $this->driver->id,
            'vehicle_seat_layout_id' => $layoutId,
            'service_date' => now()->toDateString(),
            'departure_kind' => 'driver_opened',
            'depart_at' => now()->addMinutes(90),
            'announced_depart_at' => now()->addMinutes(90),
            'boarding_opened_at' => now(),
            'visible_to_customers' => true,
            'capacity' => 4,
            'seats_taken' => 0,
            'luggage_capacity' => 3,
            'luggage_taken' => 0,
            'status' => 'FORMING',
        ]);
    }

    public function test_boarding_and_departure_are_separate_stages(): void
    {
        $this->instance(\App\Services\NotificationCenter::class,
            Mockery::mock(\App\Services\NotificationCenter::class)->shouldIgnoreMissing());
        \App\Models\Driver::query()->create([
            'user_id' => $this->driver->id,
            'city_id' => $this->route->city_id,
            'service_scope' => 'local',
            'is_online' => true,
            'active_service_mode' => 'fixed',
            'active_service_scope' => 'local',
        ]);
        Sanctum::actingAs($this->driver, ['act-as:driver']);
        $url = "/api/fixed/departures/{$this->departure->id}";
        $this->postJson($url . '/depart')->assertStatus(422);
        $this->postJson($url . '/start')->assertOk()
            ->assertJsonPath('vehicle.status', 'DISPATCHED')
            ->assertJsonPath('vehicle.first_bookable_stop_seq', 1);
        $this->departure->refresh();
        $this->assertNotNull($this->departure->trip_id);
        $this->assertNull($this->departure->actual_depart_at);
        $this->assertNull($this->departure->boarding_closed_at);
        $availability = app(\App\Services\FixedAvailabilityService::class);
        $availability->assertFutureBoardingStop($this->departure, $this->pickupStop);
        $this->postJson($url . '/start')->assertStatus(422);
        $this->postJson($url . '/depart')->assertOk()
            ->assertJsonPath('vehicle.status', 'DEPARTED')
            ->assertJsonPath('vehicle.first_bookable_stop_seq', 2);
        $this->departure->refresh();
        $this->assertNotNull($this->departure->actual_depart_at);
        $this->assertNotNull($this->departure->boarding_closed_at);
        $this->postJson($url . '/depart')->assertStatus(422);
        $this->expectException(\App\Exceptions\ReservationException::class);
        $this->expectExceptionMessage('This pickup stop has already been passed by the vehicle.');
        $availability->assertFutureBoardingStop($this->departure, $this->pickupStop);
    }

    public function test_customer_route_search_and_proximity_include_routes_beyond_default_limit(): void
    {
        for ($i = 0; $i < 61; $i++) {
            $route = $this->route->replicate();
            $route->name = $i === 60 ? 'Hidden closest route' : "Far route {$i}";
            $route->save();
            $stop = $this->pickupStop->replicate();
            $stop->route_id = $route->id;
            $stop->lat = $i === 60 ? 34.5 : 35;
            $stop->lng = 74.5;
            $stop->save();
        }
        Sanctum::actingAs($this->customer, ['act-as:customer']);
        $url = '/api/fixed/routes?city_id=' . $this->route->city_id;
        $this->getJson($url . '&q=Hidden')->assertOk()->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.name', 'Hidden closest route');
        $this->getJson($url . '&lat=34.5&lng=74.5&limit=1')->assertOk()->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.name', 'Hidden closest route');
    }

    public function test_coupon_confirmation_without_tip(): void
    {
        $this->verifyCouponConfirmation(0);
    }

    public function test_coupon_confirmation_with_tip(): void
    {
        $this->verifyCouponConfirmation(10);
    }

    public function test_production_has_no_test_payment_endpoint_even_with_test_keys(): void
    {
        $hold = app(\App\Services\FixedSeatHoldService::class)->createHold($this->customer, [
            'route_departure_id' => $this->departure->id, 'seats' => 1,
            'board_stop_id' => $this->pickupStop->id, 'drop_stop_id' => $this->dropStop->id,
        ]);
        Sanctum::actingAs($this->customer, ['*']);
        config()->set('services.razorpay.key_id', 'rzp_test_release_check');
        $this->app->instance('env', 'production');
        try {
            $this->postJson('/api/fixed/seat-holds/'.$hold->id.'/test-confirm-payment')->assertNotFound();
            $this->assertDatabaseCount('seat_reservations', 0);
        } finally {
            $this->app->instance('env', 'testing');
        }
    }

    private function approvedHoldWithAvailableCoupon(): \App\Models\FixedSeatHold
    {
        $couponId = DB::table('coupons')->insertGetId([
            'city_id' => $this->route->city_id, 'title' => 'AFTER20', 'benefit_type' => 'discount',
            'promo_type' => 'location_insensitive', 'discount_type' => 'percentage',
            'discount_value' => 20, 'is_active' => true, 'created_at' => now(), 'updated_at' => now(),
        ]);
        DB::table('coupon_assignments')->insert([
            'coupon_id' => $couponId, 'user_id' => $this->customer->id, 'reason' => 'Verification',
            'assigned_at' => now(), 'created_at' => now(), 'updated_at' => now(),
        ]);
        $service = app(\App\Services\FixedSeatHoldService::class);
        $hold = $service->createHold($this->customer, [
            'route_departure_id' => $this->departure->id, 'seats' => 1,
            'board_stop_id' => $this->pickupStop->id, 'drop_stop_id' => $this->dropStop->id,
        ]);
        $service->driverAcceptHold($this->driver, $hold);
        Sanctum::actingAs($this->customer, ['act-as:customer']);
        return $hold->fresh();
    }

    public function test_coupon_can_be_applied_and_removed_after_approval_without_releasing_seats(): void
    {
        $hold = $this->approvedHoldWithAvailableCoupon();
        $expiry = $hold->expires_at->toISOString();
        $labels = $hold->heldSeats()->pluck('label')->all();
        $url = "/api/fixed/seat-holds/{$hold->id}/coupon";
        $this->postJson($url, ['coupon_title' => 'AFTER20'])->assertOk()
            ->assertJsonPath('hold.amount', 96)->assertJsonPath('hold.discount_amount', 24)
            ->assertJsonPath('hold.coupon_title', 'AFTER20')->assertJsonPath('hold.status', 'ACCEPTED');
        $this->assertSame($expiry, $hold->fresh()->expires_at->toISOString());
        $this->assertSame($labels, $hold->heldSeats()->pluck('label')->all());
        $this->assertNull(DB::table('coupon_assignments')->where('user_id', $this->customer->id)->value('used_at'));
        $this->postJson($url, ['coupon_title' => null])->assertOk()
            ->assertJsonPath('hold.amount', 120)->assertJsonPath('hold.discount_amount', 0)
            ->assertJsonPath('hold.coupon_title', null);
    }

    public function test_hold_coupon_rejects_other_customers_and_invalid_codes_without_changing_fare(): void
    {
        $hold = $this->approvedHoldWithAvailableCoupon();
        $url = "/api/fixed/seat-holds/{$hold->id}/coupon";
        $this->postJson($url, ['coupon_title' => 'INVALID'])->assertStatus(422);
        $this->assertSame(120.0, $hold->fresh()->amount);
        $other = User::factory()->create();
        $other->addRole('customer');
        Sanctum::actingAs($other, ['act-as:customer']);
        $this->postJson($url, ['coupon_title' => 'AFTER20'])->assertNotFound();
        $this->assertSame(120.0, $hold->fresh()->amount);
    }

    public function test_hold_coupon_cannot_change_after_payment_starts_or_hold_expires(): void
    {
        $hold = $this->approvedHoldWithAvailableCoupon();
        $url = "/api/fixed/seat-holds/{$hold->id}/coupon";
        $hold->update(['razorpay_order_id' => 'order_started']);
        $this->postJson($url, ['coupon_title' => 'AFTER20'])->assertStatus(409);
        $hold->update(['razorpay_order_id' => null, 'expires_at' => now()->subSecond()]);
        $this->postJson($url, ['coupon_title' => 'AFTER20'])->assertStatus(422);
        $this->assertSame(120.0, $hold->fresh()->amount);
    }

    public function test_payment_confirms_the_coupon_amount_updated_after_driver_approval(): void
    {
        $hold = $this->approvedHoldWithAvailableCoupon();
        $this->postJson("/api/fixed/seat-holds/{$hold->id}/coupon", ['coupon_title' => 'AFTER20'])->assertOk();
        $hold->refresh()->update(['razorpay_order_id' => 'order_after_coupon']);
        $gateway = Mockery::mock(RazorpayService::class);
        $gateway->shouldReceive('verifyPaymentSignature')->once()->andReturn(true);
        $reservation = app(\App\Services\FixedSeatHoldService::class)->confirmHold($this->customer, $hold->fresh(), [
            'razorpay_order_id' => 'order_after_coupon', 'razorpay_payment_id' => 'pay_after_coupon',
            'razorpay_signature' => 'test', 'booking_channel' => 'advance',
        ], $gateway);
        $this->assertSame(96.0, (float) $reservation->fare_amount);
        $this->assertNotNull(DB::table('coupon_assignments')->where('user_id', $this->customer->id)->value('used_at'));
    }

    private function verifyCouponConfirmation(float $tip): void
    {
        $couponId = DB::table('coupons')->insertGetId([
            'city_id' => $this->route->city_id, 'title' => 'FIXED20', 'benefit_type' => 'discount',
            'promo_type' => 'location_insensitive', 'discount_type' => 'percentage',
            'discount_value' => 20, 'is_active' => true, 'created_at' => now(), 'updated_at' => now(),
        ]);
        $assignmentId = DB::table('coupon_assignments')->insertGetId([
            'coupon_id' => $couponId, 'user_id' => $this->customer->id, 'reason' => 'Verification',
            'assigned_at' => now(), 'created_at' => now(), 'updated_at' => now(),
        ]);
        $service = app(\App\Services\FixedSeatHoldService::class);
        $payload = [
            'route_departure_id' => $this->departure->id, 'seats' => 1,
            'board_stop_id' => $this->pickupStop->id, 'drop_stop_id' => $this->dropStop->id,
            'coupon_title' => 'FIXED20', 'tip_amount' => $tip,
        ];
        $preview = $service->previewCoupon($this->customer, $payload);
        $this->assertSame(24.0, $preview['discount']);
        $hold = $service->createHold($this->customer, $payload);
        $this->assertSame(96.0 + $tip, (float) $hold->amount);
        $service->driverAcceptHold($this->driver, $hold);
        $hold->refresh()->update(['razorpay_order_id' => 'order_coupon_check']);
        $gateway = Mockery::mock(RazorpayService::class);
        $gateway->shouldReceive('verifyPaymentSignature')->once()->andReturn(true);
        $reservation = $service->confirmHold($this->customer, $hold->fresh(), [
            'razorpay_order_id' => 'order_coupon_check', 'razorpay_payment_id' => 'pay_coupon_check',
            'razorpay_signature' => 'test', 'booking_channel' => 'advance',
        ], $gateway);
        $this->assertSame(96.0 + $tip, (float) $reservation->fare_amount);
        $this->assertNotNull(DB::table('coupon_assignments')->where('id', $assignmentId)->value('used_at'));
    }

    public function test_customer_cancel_more_than_30_minutes_before_departure_refunds_razorpay_and_releases_capacity(): void
    {
        $reservation = $this->createReservation(['seats' => 2, 'extra_luggage_count' => 1, 'fare_amount' => 265]);
        $this->departure->update(['seats_taken' => 2, 'luggage_taken' => 1]);
        $this->enableAutoRefund($reservation);

        $razorpay = Mockery::mock(RazorpayService::class);
        $razorpay->shouldReceive('refundPayment')
            ->once()
            ->with('pay_phase4_123', 26500, Mockery::on(fn ($notes) => ($notes['reason'] ?? null) === 'booking_cancelled'))
            ->andReturn(['id' => 'rfnd_phase4_123', 'status' => 'processed', 'amount' => 26500]);
        $this->instance(RazorpayService::class, $razorpay);

        Sanctum::actingAs($this->customer, ['act-as:customer']);

        $this->postJson("/api/fixed/bookings/{$reservation->id}/cancel")
            ->assertOk()
            ->assertJsonPath('refund_status', 'REFUNDED');

        $reservation->refresh();
        $this->assertSame('CANCELLED', $reservation->status);
        $this->assertSame('REFUNDED', $reservation->refund_status);
        $this->assertSame('REFUNDED', $reservation->payment_status);
        $this->assertSame('rfnd_phase4_123', $reservation->refund_reference);
        $this->assertSame(265.0, (float) $reservation->refund_amount);
        $this->assertSame(0, $this->departure->fresh()->seats_taken);
        $this->assertSame(0, $this->departure->fresh()->luggage_taken);
    }

    /**
     * The cancellation rule is not a clock, and no longer just "has the vehicle
     * started". It's whether the vehicle has physically reached THIS passenger's
     * own pickup stop — the same "the bus is at your stop" moment that unlocks a
     * no-show. Here the vehicle has started AND reached the passenger's stop
     * (seq 1, the origin), so their seat is spent on them and the fare is
     * forfeited, whatever the scheduled departure time.
     */
    public function test_customer_cancel_after_the_vehicle_reached_their_pickup_stop_rejects_refund_but_releases_capacity(): void
    {
        $rideTypeId = DB::table('ride_types')->insertGetId([
            'name' => 'Fixed', 'mode' => 'fixed', 'description' => 'Fixed', 'sort_order' => 1,
            'created_at' => now(), 'updated_at' => now(),
        ]);

        $trip = Trip::query()->create([
            'customer_id' => null,
            'driver_id' => $this->driver->id,
            'city_id' => $this->route->city_id,
            'ride_type_id' => $rideTypeId,
            'route_id' => $this->route->id,
            'route_departure_id' => $this->departure->id,
            'status' => 'EN_ROUTE_PICKUP',
            'estimated_fare' => 120, 'final_fare' => 120, 'currency' => 'INR',
            'pickup_lat' => 34.0, 'pickup_lng' => 74.0,
            'drop_lat' => 34.1, 'drop_lng' => 74.1,
        ]);
        $this->departure->update([
            'trip_id' => $trip->id,
            'status' => 'DEPARTED',
            // The vehicle has reached the passenger's pickup stop (seq 1).
            'fixed_last_reached_stop_seq' => 1,
            'fixed_last_reached_stop_at' => now(),
            'seats_taken' => 1,
        ]);
        $reservation = $this->createReservation(['seats' => 1, 'fare_amount' => 120]);

        $razorpay = Mockery::mock(RazorpayService::class);
        $razorpay->shouldReceive('refundPayment')->never();
        $this->instance(RazorpayService::class, $razorpay);

        Sanctum::actingAs($this->customer, ['act-as:customer']);

        $this->postJson("/api/fixed/bookings/{$reservation->id}/cancel")
            ->assertOk()
            ->assertJsonPath('refund_status', 'REJECTED');

        $reservation->refresh();
        $this->assertSame('CANCELLED', $reservation->status);
        $this->assertSame('REJECTED', $reservation->refund_status);
        $this->assertSame('PAID', $reservation->payment_status);
        $this->assertNull($reservation->refund_reference);
        $this->assertSame(0, $this->departure->fresh()->seats_taken);
    }

    /**
     * The core F4 fix: a vehicle that has STARTED but not yet reached this
     * passenger's stop still owes them a full refund — the seat can be resold to
     * someone further down the line. Passenger boards at a later stop (seq 3)
     * while the bus has only reached the origin (seq 1), so cancelling refunds in
     * full even though the trip is already running.
     */
    public function test_customer_cancel_after_start_but_before_reaching_their_stop_refunds_in_full(): void
    {
        $laterPickup = RouteStop::query()->create([
            'route_id' => $this->route->id, 'seq' => 3, 'name' => 'Midtown',
            'lat' => 34.05, 'lng' => 74.05,
            'is_pickup' => true, 'is_drop' => false, 'is_active' => true,
            'is_temporarily_unavailable' => false,
        ]);
        $laterDrop = RouteStop::query()->create([
            'route_id' => $this->route->id, 'seq' => 4, 'name' => 'Far End',
            'lat' => 34.2, 'lng' => 74.2,
            'is_pickup' => false, 'is_drop' => true, 'is_active' => true,
            'is_temporarily_unavailable' => false,
        ]);

        $rideTypeId = DB::table('ride_types')->insertGetId([
            'name' => 'Fixed', 'mode' => 'fixed', 'description' => 'Fixed', 'sort_order' => 1,
            'created_at' => now(), 'updated_at' => now(),
        ]);
        $trip = Trip::query()->create([
            'customer_id' => null,
            'driver_id' => $this->driver->id,
            'city_id' => $this->route->city_id,
            'ride_type_id' => $rideTypeId,
            'route_id' => $this->route->id,
            'route_departure_id' => $this->departure->id,
            'status' => 'EN_ROUTE_PICKUP',
            'estimated_fare' => 120, 'final_fare' => 120, 'currency' => 'INR',
            'pickup_lat' => 34.0, 'pickup_lng' => 74.0,
            'drop_lat' => 34.2, 'drop_lng' => 74.2,
        ]);
        $this->departure->update([
            'trip_id' => $trip->id,
            'status' => 'DEPARTED',
            // Bus has only reached the origin (seq 1); the passenger's stop is seq 3.
            'fixed_last_reached_stop_seq' => 1,
            'fixed_last_reached_stop_at' => now(),
            'seats_taken' => 1,
        ]);

        $reservation = $this->createReservation([
            'seats' => 1, 'fare_amount' => 120,
            'board_stop_id' => $laterPickup->id,
            'drop_stop_id' => $laterDrop->id,
        ]);
        $this->enableAutoRefund($reservation);

        $razorpay = Mockery::mock(RazorpayService::class);
        $razorpay->shouldReceive('refundPayment')
            ->once()
            ->with('pay_phase4_123', 12000, Mockery::on(fn ($notes) => ($notes['reason'] ?? null) === 'booking_cancelled'))
            ->andReturn(['id' => 'rfnd_phase4_later', 'status' => 'processed', 'amount' => 12000]);
        $this->instance(RazorpayService::class, $razorpay);

        Sanctum::actingAs($this->customer, ['act-as:customer']);

        $this->postJson("/api/fixed/bookings/{$reservation->id}/cancel")
            ->assertOk()
            ->assertJsonPath('refund_status', 'REFUNDED');

        $reservation->refresh();
        $this->assertSame('CANCELLED', $reservation->status);
        $this->assertSame('REFUNDED', $reservation->refund_status);
        $this->assertSame('REFUNDED', $reservation->payment_status);
        $this->assertSame('rfnd_phase4_later', $reservation->refund_reference);
        $this->assertSame(0, $this->departure->fresh()->seats_taken);
    }

    public function test_razorpay_refund_failure_keeps_refund_pending_and_releases_capacity(): void
    {
        $reservation = $this->createReservation(['seats' => 1, 'fare_amount' => 120]);
        $this->departure->update(['seats_taken' => 1]);
        $this->enableAutoRefund($reservation);

        $razorpay = Mockery::mock(RazorpayService::class);
        $razorpay->shouldReceive('refundPayment')
            ->once()
            ->andThrow(new \RuntimeException('Razorpay unavailable'));
        $razorpay->shouldReceive('verifyExistingRefund')->andReturn(null);
        $this->instance(RazorpayService::class, $razorpay);

        Sanctum::actingAs($this->customer, ['act-as:customer']);

        $this->postJson("/api/fixed/bookings/{$reservation->id}/cancel")
            ->assertOk()
            ->assertJsonPath('refund_status', 'APPROVED');

        $reservation->refresh();
        $this->assertSame('CANCELLED', $reservation->status);
        $this->assertSame('APPROVED', $reservation->refund_status);
        $this->assertSame('PAID', $reservation->payment_status);
        $this->assertNull($reservation->refund_reference);
        $this->assertSame(0, $this->departure->fresh()->seats_taken);
    }

    public function test_driver_location_updates_fixed_stop_progress(): void
    {
        $this->departure->update(['status' => 'DEPARTED']);

        app(FixedStopAutomationService::class)
            ->processDriverLocation($this->driver->id, 34.0000000, 74.0000000, Carbon::parse('2026-06-19 10:00:00'));

        $this->assertSame(1, $this->departure->fresh()->fixed_last_reached_stop_seq);

        app(FixedStopAutomationService::class)
            ->processDriverLocation($this->driver->id, 34.1000000, 74.1000000, Carbon::parse('2026-06-19 10:05:00'));

        $this->assertSame(2, $this->departure->fresh()->fixed_last_reached_stop_seq);
        $this->assertNotNull($this->departure->fresh()->fixed_last_reached_stop_at);
    }

    public function test_manual_fixed_stop_progress_endpoint_is_not_available(): void
    {
        $this->departure->update(['status' => 'DEPARTED']);

        Sanctum::actingAs($this->driver, ['act-as:driver']);

        $this->postJson("/api/fixed/departures/{$this->departure->id}/stops/{$this->dropStop->id}/reached")
            ->assertNotFound();

        $this->assertNull($this->departure->fresh()->fixed_last_reached_stop_seq);
    }

    public function test_driver_no_show_is_blocked_before_pickup_stop_is_reached(): void
    {
        $reservation = $this->createReservation(['seats' => 1]);
        $this->departure->update(['status' => 'DEPARTED', 'seats_taken' => 1]);

        Sanctum::actingAs($this->driver, ['act-as:driver']);

        $this->postJson("/api/fixed/bookings/{$reservation->id}/no-show")
            ->assertStatus(422);

        $this->assertSame('CONFIRMED', $reservation->fresh()->status);
        $this->assertSame(1, $this->departure->fresh()->seats_taken);
    }

    public function test_driver_no_show_rejects_refund_and_releases_capacity_after_pickup_stop_is_reached(): void
    {
        $reservation = $this->createReservation(['seats' => 2, 'extra_luggage_count' => 1, 'fare_amount' => 265]);
        $this->departure->update([
            'status' => 'DEPARTED',
            'fixed_last_reached_stop_seq' => 1,
            // Reached 6 minutes ago, so the 5-minute per-stop waiting time has
            // elapsed and the driver is allowed to mark the passenger no-show.
            'fixed_last_reached_stop_at' => now()->subMinutes(6),
            'seats_taken' => 2,
            'luggage_taken' => 1,
        ]);

        $razorpay = Mockery::mock(RazorpayService::class);
        $razorpay->shouldReceive('refundPayment')->never();
        $this->instance(RazorpayService::class, $razorpay);

        Sanctum::actingAs($this->driver, ['act-as:driver']);

        $this->postJson("/api/fixed/bookings/{$reservation->id}/no-show")
            ->assertOk()
            ->assertJsonPath('reservation.status', 'NO_SHOW')
            ->assertJsonPath('reservation.refund_status', 'REJECTED');

        $reservation->refresh();
        $this->assertSame('NO_SHOW', $reservation->status);
        $this->assertSame('REJECTED', $reservation->refund_status);
        $this->assertSame('PAID', $reservation->payment_status);
        $this->assertSame(0, $this->departure->fresh()->seats_taken);
        $this->assertSame(0, $this->departure->fresh()->luggage_taken);
    }

    public function test_driver_no_show_is_blocked_until_the_waiting_time_elapses(): void
    {
        $reservation = $this->createReservation(['seats' => 1]);
        $this->departure->update([
            'status' => 'DEPARTED',
            'fixed_last_reached_stop_seq' => 1,
            // Just reached the pickup stop — the 5-minute waiting time has not
            // passed yet, so the customer must not be marked no-show.
            'fixed_last_reached_stop_at' => now(),
            'seats_taken' => 1,
        ]);

        Sanctum::actingAs($this->driver, ['act-as:driver']);

        $this->postJson("/api/fixed/bookings/{$reservation->id}/no-show")
            ->assertStatus(422);

        $this->assertSame('CONFIRMED', $reservation->fresh()->status);
        $this->assertSame(1, $this->departure->fresh()->seats_taken);
    }


    public function test_driver_drop_off_completes_boarded_passenger_and_releases_capacity(): void
    {
        $reservation = $this->createReservation([
            "status" => "BOARDED",
            "seats" => 2,
            "extra_luggage_count" => 1,
            "boarded_at" => now(),
        ]);
        $this->departure->update(["seats_taken" => 2, "luggage_taken" => 1, "status" => "DEPARTED", "fixed_last_reached_stop_seq" => 2, "fixed_last_reached_stop_at" => now()]);

        Sanctum::actingAs($this->driver, ["act-as:driver"]);

        $this->postJson("/api/fixed/bookings/{$reservation->id}/drop")
            ->assertOk()
            ->assertJsonPath("reservation.status", "DROPPED");

        $reservation->refresh();
        $this->assertSame("DROPPED", $reservation->status);
        $this->assertNotNull($reservation->dropped_at);
        $this->assertSame(0, $this->departure->fresh()->seats_taken);
        $this->assertSame(0, $this->departure->fresh()->luggage_taken);
    }

    public function test_driver_cannot_drop_off_unboarded_passenger(): void
    {
        $reservation = $this->createReservation(["status" => "CONFIRMED"]);
        $this->departure->update(["seats_taken" => 1]);

        Sanctum::actingAs($this->driver, ["act-as:driver"]);

        $this->postJson("/api/fixed/bookings/{$reservation->id}/drop")
            ->assertStatus(422);

        $this->assertSame("CONFIRMED", $reservation->fresh()->status);
        $this->assertSame(1, $this->departure->fresh()->seats_taken);
    }


    public function test_driver_can_complete_fixed_ride_when_no_active_passengers_remain(): void
    {
        $this->departure->update([
            'status' => 'DEPARTED',
            'visible_to_customers' => true,
            'seats_taken' => 0,
            'luggage_taken' => 0,
        ]);
        $this->createReservation(['status' => 'DROPPED', 'dropped_at' => now()]);

        Sanctum::actingAs($this->driver, ['act-as:driver']);

        $this->postJson("/api/fixed/departures/{$this->departure->id}/complete")
            ->assertOk()
            ->assertJsonPath('vehicle.status', 'COMPLETED')
            ->assertJsonPath('vehicle.visible_to_customers', false);

        $this->departure->refresh();
        $this->assertSame('COMPLETED', $this->departure->status);
        $this->assertFalse((bool) $this->departure->visible_to_customers);
        $this->assertNotNull($this->departure->boarding_closed_at);
    }

    public function test_driver_cannot_complete_fixed_ride_with_active_passengers(): void
    {
        $this->departure->update(['status' => 'DEPARTED', 'seats_taken' => 1]);
        $this->createReservation(['status' => 'CONFIRMED']);

        Sanctum::actingAs($this->driver, ['act-as:driver']);

        $this->postJson("/api/fixed/departures/{$this->departure->id}/complete")
            ->assertStatus(422);

        $this->assertSame('DEPARTED', $this->departure->fresh()->status);
        $this->assertSame(1, $this->departure->fresh()->seats_taken);
    }

    public function test_cancelled_booking_cannot_be_cancelled_again_or_release_capacity_twice(): void
    {
        $reservation = $this->createReservation(['status' => 'CANCELLED']);
        $this->departure->update(['seats_taken' => 1]);

        $razorpay = Mockery::mock(RazorpayService::class);
        $razorpay->shouldReceive('refundPayment')->never();
        $this->instance(RazorpayService::class, $razorpay);

        Sanctum::actingAs($this->customer, ['act-as:customer']);

        $this->postJson("/api/fixed/bookings/{$reservation->id}/cancel")
            ->assertStatus(422);

        $this->assertSame(1, $this->departure->fresh()->seats_taken);
    }

    private function createReservation(array $overrides = []): SeatReservation
    {
        return SeatReservation::query()->create(array_merge([
            'route_departure_id' => $this->departure->id,
            'route_id' => $this->route->id,
            'customer_id' => $this->customer->id,
            'seats' => 1,
            'booking_channel' => 'advance',
            'board_stop_id' => $this->pickupStop->id,
            'board_lat' => (float) $this->pickupStop->lat,
            'board_lng' => (float) $this->pickupStop->lng,
            'board_address' => $this->pickupStop->name,
            'drop_stop_id' => $this->dropStop->id,
            'drop_lat' => (float) $this->dropStop->lat,
            'drop_lng' => (float) $this->dropStop->lng,
            'drop_address' => $this->dropStop->name,
            'fare_amount' => 120,
            'payment_method' => 'razorpay',
            'payment_status' => 'PAID',
            'payment_reference' => 'pay_phase4_123',
            'has_extra_luggage' => false,
            'extra_luggage_count' => 0,
            'luggage_surcharge_amount' => 0,
            'refund_status' => 'NONE',
            'status' => 'CONFIRMED',
        ], $overrides));
    }

    /**
     * Turns the split/refund engine on and mirrors the booking's prepayment as a
     * settlement_mode=booking Payment row — exactly what the real confirm-payment
     * flow does — so the auto-refund path actually runs against Razorpay instead
     * of silently falling through to the manual register.
     */
    private function enableAutoRefund(SeatReservation $reservation): void
    {
        config()->set('services.payments.split_enabled', true);
        config()->set('services.razorpay.key_id', 'rzp_test_phase4');

        Payment::query()->create([
            'trip_id' => null,
            'method' => 'RAZORPAY',
            'provider' => 'RAZORPAY',
            'status' => 'SUCCESS',
            'amount' => round((float) $reservation->fare_amount, 2),
            'currency' => 'INR',
            'razorpay_payment_id' => $reservation->payment_reference,
            'commission_amount' => 0,
            'paid_at' => now(),
            'settlement_mode' => Payment::SETTLE_BOOKING,
        ]);
    }
}
