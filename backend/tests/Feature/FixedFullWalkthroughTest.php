<?php

namespace Tests\Feature;

use App\Models\Driver;
use App\Models\Route;
use App\Models\RouteDeparture;
use App\Models\RouteStop;
use App\Models\SeatReservation;
use App\Models\User;
use App\Services\FixedBoardingOtpService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Laravel\Sanctum\Sanctum;
use Tests\Support\SeatLayoutFactory;
use Tests\TestCase;

class FixedFullWalkthroughTest extends TestCase
{
    use RefreshDatabase;

    public function test_fixed_flow_walkthrough_from_admin_setup_to_driver_completion_and_admin_timeline(): void
    {
        config()->set('services.razorpay.key_id', 'rzp_test_walkthrough');

        $cityId = DB::table('cities')->insertGetId([
            'name' => 'Walkthrough City',
            'country_code' => 'IN',
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        DB::table('ride_types')->insert([
            'id' => 1,
            'name' => 'Fixed Test Vehicle',
            'description' => 'Fixed walkthrough ride type',
            'sort_order' => 1,
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        $vehicleId = DB::table('city_vehicle_types')->insertGetId([
            'city_id' => $cityId,
            'ride_type_id' => 1,
            'display_name' => 'Walkthrough Hatchback',
            'display_order' => 1,
            'max_people' => 4,
            'luggage_capacity' => 3,
            'is_active' => true,
            'created_at' => now(),
            'updated_at' => now(),
        ]);
        $vehicleTypeId = DB::table('vehicle_types')->insertGetId([
            'name' => 'Ertiga', 'sort_order' => 1, 'is_active' => true,
            'created_at' => now(), 'updated_at' => now(),
        ]);
        SeatLayoutFactory::standardErtiga6P($cityId, $vehicleTypeId);
        $fixedRideId = DB::table('ride_types')->insertGetId(['name' => 'Walkthrough Fixed', 'mode' => 'fixed', 'created_at' => now(), 'updated_at' => now()]);
        DB::table('city_vehicle_types')->where('id', $vehicleId)->update(['vehicle_type_id' => $vehicleTypeId, 'ride_type_id' => $fixedRideId]);

        $admin = User::factory()->create(['manager_all_cities' => true]);
        $admin->addRole('admin');
        $roleId = DB::table('manager_roles')->insertGetId([
            'slug' => 'super_admin',
            'name' => 'Super Admin',
            'is_system' => true,
            'created_at' => now(),
            'updated_at' => now(),
        ]);
        $admin->forceFill(['manager_role_id' => $roleId])->save();

        $driver = User::factory()->create();
        $driver->addRole('driver');
        Driver::query()->create([
            'user_id' => $driver->id,
            'city_id' => $cityId,
            'vehicle_type_id' => $vehicleTypeId,
            'city_vehicle_type_id' => $vehicleId,
            'approval_status' => 'approved',
            'service_scope' => 'local',
            'service_mode' => 'fixed',
            'is_online' => true,
            'last_online_at' => now(),
        ]);

        $customer = User::factory()->create();
        $customer->addRole('customer');

        Sanctum::actingAs($admin, ['act-as:admin']);
        $routeId = $this->postJson("/api/admin/cities/{$cityId}/fixed-routes", [
            'scope' => 'local',
            'name' => 'Walkthrough Fixed',
            'origin_name' => 'Central Stand',
            'dest_name' => 'Airport Gate',
            'origin_lat' => 34.0000000,
            'origin_lng' => 74.0000000,
            'dest_lat' => 34.1000000,
            'dest_lng' => 74.1000000,
            'city_vehicle_type_id' => $vehicleId,
            'booking_window_hours' => 6,
            'max_seats_per_booking' => 4,
            'waiting_time_per_stop_minutes' => 5,
            'luggage_surcharge_amount' => 25,
            'max_luggage_per_vehicle' => 3,
            'requires_prepaid' => true,
            'is_active' => true,
            'fare_config' => ['seat_fare' => 120],
            'stops' => [
                [
                    'seq' => 1,
                    'name' => 'Central Stand',
                    'lat' => 34.0000000,
                    'lng' => 74.0000000,
                    'is_pickup' => true,
                    'is_drop' => false,
                    'is_active' => true,
                    'is_temporarily_unavailable' => false,
                ],
                [
                    'seq' => 2,
                    'name' => 'Airport Gate',
                    'lat' => 34.1000000,
                    'lng' => 74.1000000,
                    'is_pickup' => false,
                    'is_drop' => true,
                    'is_active' => true,
                    'is_temporarily_unavailable' => false,
                ],
            ],
        ])->assertCreated()->json('route.id');

        $this->getJson("/api/admin/cities/{$cityId}/fixed-routes")
            ->assertOk()
            ->assertJsonPath('data.0.name', 'Walkthrough Fixed');

        // Route allocation (group-based): grant the driver a route group holding
        // this route so they may see and open it. The vehicle no longer decides.
        $groupId = DB::table('route_groups')->insertGetId([
            'city_id' => $cityId, 'name' => 'Walkthrough Group', 'is_active' => true,
            'created_at' => now(), 'updated_at' => now(),
        ]);
        DB::table('route_group_route')->insert([
            'route_group_id' => $groupId, 'route_id' => $routeId,
            'created_at' => now(), 'updated_at' => now(),
        ]);
        DB::table('driver_route_group')->insert([
            'driver_user_id' => $driver->id, 'route_group_id' => $groupId,
            'created_at' => now(), 'updated_at' => now(),
        ]);

        Sanctum::actingAs($driver, ['act-as:driver']);
        $this->postJson('/api/drivers/service-mode', ['mode' => 'fixed'])
            ->assertOk()
            ->assertJsonPath('driver.active_service_mode', 'fixed');

        $departureId = $this->postJson('/api/fixed/driver/vehicles', [
            'route_id' => $routeId,
            'capacity' => 4,
        ])->assertCreated()
            ->assertJsonPath('vehicle.status', 'FORMING')
            ->assertJsonPath('vehicle.visible_to_customers', true)
            ->json('vehicle.id');

        $pickupStop = RouteStop::query()->where('route_id', $routeId)->where('is_pickup', true)->firstOrFail();
        $dropStop = RouteStop::query()->where('route_id', $routeId)->where('is_drop', true)->firstOrFail();

        Sanctum::actingAs($customer, ['act-as:customer']);
        $this->getJson("/api/fixed/routes?city_id={$cityId}")
            ->assertOk()
            ->assertJsonPath('data.0.id', $routeId);

        // Layout is now the source of truth for capacity — the standardErtiga6P
        // layout has 6 seats, so the driver's `capacity: 4` is overridden.
        $this->getJson("/api/fixed/routes/{$routeId}/departures")
            ->assertOk()
            ->assertJsonPath('data.0.id', $departureId)
            ->assertJsonPath('data.0.seats_remaining', 6);

        $holdId = $this->withHeaders(['Idempotency-Key' => 'walkthrough-hold'])
            ->postJson('/api/fixed/seat-holds', [
                'route_departure_id' => $departureId,
                'board_stop_id' => $pickupStop->id,
                'drop_stop_id' => $dropStop->id,
                'seats' => 1,
                'has_extra_luggage' => false,
                'extra_luggage_count' => 0,
            ])->assertCreated()
            ->json('hold.id');

        Sanctum::actingAs($driver, ['act-as:driver']);
        $this->postJson("/api/fixed/driver/seat-holds/{$holdId}/accept")
            ->assertOk();

        Sanctum::actingAs($customer, ['act-as:customer']);
        $reservationId = $this->withHeaders(['Idempotency-Key' => 'walkthrough-test-pay'])
            ->postJson("/api/fixed/seat-holds/{$holdId}/test-confirm-payment", [
                'booking_channel' => 'advance',
            ])->assertCreated()
            ->assertJsonPath('reservation.status', 'CONFIRMED')
            ->assertJsonPath('reservation.payment_status', 'PAID')
            ->json('reservation.id');

        $this->assertSame(1, RouteDeparture::query()->findOrFail($departureId)->seats_taken);

        Sanctum::actingAs($driver, ['act-as:driver']);
        $this->getJson("/api/fixed/departures/{$departureId}/manifest")
            ->assertOk()
            ->assertJsonPath('passengers.0.id', $reservationId)
            ->assertJsonPath('passengers.0.status', 'CONFIRMED');

        $this->postJson("/api/fixed/departures/{$departureId}/start")
            ->assertOk()
            ->assertJsonPath('vehicle.status', 'DISPATCHED');

        RouteDeparture::query()->findOrFail($departureId)->update(['fixed_last_reached_stop_seq' => (int) $pickupStop->seq, 'fixed_last_reached_stop_at' => now()]);

        // Boarding is OTP-gated: issue the passenger's code, then board with it.
        $this->postJson("/api/fixed/bookings/{$reservationId}/boarding-otp")->assertOk();
        $code = Cache::get(FixedBoardingOtpService::codeCacheKey($reservationId));
        $this->postJson("/api/fixed/bookings/{$reservationId}/board", ['code' => $code])
            ->assertOk()
            ->assertJsonPath('reservation.status', 'BOARDED');

        $this->postJson("/api/fixed/departures/{$departureId}/depart")
            ->assertOk()
            ->assertJsonPath('vehicle.status', 'DEPARTED');

        RouteDeparture::query()->findOrFail($departureId)->update(['fixed_last_reached_stop_seq' => (int) $dropStop->seq, 'fixed_last_reached_stop_at' => now()]);

        $this->postJson("/api/fixed/bookings/{$reservationId}/drop")
            ->assertOk()
            ->assertJsonPath('reservation.status', 'DROPPED');

        $this->postJson("/api/fixed/departures/{$departureId}/complete")
            ->assertOk()
            ->assertJsonPath('vehicle.status', 'COMPLETED')
            ->assertJsonPath('vehicle.visible_to_customers', false);

        $reservation = SeatReservation::query()->findOrFail($reservationId);
        $this->assertSame('DROPPED', $reservation->status);
        $this->assertSame(0, RouteDeparture::query()->findOrFail($departureId)->seats_taken);

        Sanctum::actingAs($admin, ['act-as:admin']);
        $this->getJson("/api/admin/cities/{$cityId}/fixed-bookings/{$reservationId}/timeline")
            ->assertOk()
            ->assertJsonPath('data.booking.id', $reservationId)
            ->assertJsonPath('data.booking.status', 'DROPPED')
            ->assertJsonFragment(['event_type' => 'booking_confirmed'])
            ->assertJsonFragment(['event_type' => 'passenger_boarded'])
            ->assertJsonFragment(['event_type' => 'passenger_dropped']);

        $this->assertSame('COMPLETED', RouteDeparture::query()->findOrFail($departureId)->status);
        $this->assertSame('fixed', Route::query()->findOrFail($routeId)->mode);
    }
}
