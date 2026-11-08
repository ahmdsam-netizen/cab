<?php

namespace Tests\Feature;

use App\Models\DepartureSeat;
use App\Models\Driver;
use App\Models\RouteDeparture;
use App\Models\SeatReservation;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Laravel\Sanctum\Sanctum;
use Tests\Support\SeatLayoutFactory;
use Tests\TestCase;

/**
 * M6 — driver-side plumbing for seat layouts:
 *   - GET /api/fixed/driver/routes/{route}/layouts lists city-scoped layouts
 *   - POST /api/fixed/driver/vehicles accepts vehicle_seat_layout_id and
 *     snapshots that layout's seats into departure_seats
 *   - a foreign-city layout is rejected
 *   - manifest returns seat_labels[] per passenger
 */
class FixedDriverSeatLayoutTest extends TestCase
{
    use RefreshDatabase;

    private int $cityId;
    private int $otherCityId;
    private int $vehicleTypeId;
    private int $primaryLayoutId;
    private int $foreignLayoutId;

    protected function setUp(): void
    {
        parent::setUp();

        $this->cityId = DB::table('cities')->insertGetId([
            'name' => 'M6 City', 'country_code' => 'IN',
            'created_at' => now(), 'updated_at' => now(),
        ]);
        $this->otherCityId = DB::table('cities')->insertGetId([
            'name' => 'Other City', 'country_code' => 'IN',
            'created_at' => now(), 'updated_at' => now(),
        ]);
        $this->vehicleTypeId = DB::table('vehicle_types')->insertGetId([
            'name' => 'Ertiga', 'sort_order' => 1, 'is_active' => true,
            'created_at' => now(), 'updated_at' => now(),
        ]);

        $this->primaryLayoutId = SeatLayoutFactory::standardErtiga6P($this->cityId, $this->vehicleTypeId);
        $this->foreignLayoutId = SeatLayoutFactory::standardErtiga6P($this->otherCityId, $this->vehicleTypeId, 'Ertiga foreign');
    }

    private function makeRoute(string $name = 'R1'): int
    {
        return DB::table('routes')->insertGetId([
            'city_id' => $this->cityId, 'scope' => 'local', 'mode' => 'fixed', 'name' => $name,
            'origin_name' => "$name O", 'dest_name' => "$name D",
            'origin_lat' => 34.0, 'origin_lng' => 74.0, 'dest_lat' => 34.1, 'dest_lng' => 74.1,
            'fare_config' => json_encode(['seat_fare' => 120]),
            'max_luggage_per_vehicle' => 3,
            'is_active' => true,
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    private function assignedDriver(int $routeId, ?int $vehicleTypeId = null): User
    {
        $vehicleTypeId ??= $this->vehicleTypeId;
        $vehicleId = DB::table('city_vehicle_types')->insertGetId(['city_id' => $this->cityId,
            'vehicle_type_id' => $vehicleTypeId, 'display_name' => 'Driver vehicle '.$vehicleTypeId,
            'is_active' => true, 'max_people' => 6, 'luggage_capacity' => 2]);
        $user = User::factory()->create();
        $user->addRole('driver');
        $driver = Driver::query()->create([
            'user_id' => $user->id,
            'city_id' => $this->cityId,
            'vehicle_type_id' => $vehicleTypeId,
            'city_vehicle_type_id' => $vehicleId,
            'approval_status' => 'approved',
            'service_scope' => 'local',
            'service_mode' => 'fixed',
            'is_online' => true,
            'last_online_at' => now(),
        ]);
        $driver->forceFill(['active_service_mode' => 'fixed', 'active_service_scope' => 'local'])->save();

        $gid = DB::table('route_groups')->insertGetId([
            'city_id' => $this->cityId, 'name' => 'G', 'is_active' => true,
            'created_at' => now(), 'updated_at' => now(),
        ]);
        DB::table('route_group_route')->insert([
            'route_group_id' => $gid, 'route_id' => $routeId,
            'created_at' => now(), 'updated_at' => now(),
        ]);
        DB::table('driver_route_group')->insert([
            'driver_user_id' => $user->id, 'route_group_id' => $gid,
            'created_at' => now(), 'updated_at' => now(),
        ]);

        return $user;
    }

    public function test_layouts_endpoint_lists_only_this_city(): void
    {
        $routeId = $this->makeRoute();
        $user = $this->assignedDriver($routeId);

        Sanctum::actingAs($user, ['act-as:driver']);
        $res = $this->getJson("/api/fixed/driver/routes/{$routeId}/layouts")->assertOk();

        $ids = collect($res->json('data'))->pluck('id')->all();
        $this->assertContains($this->primaryLayoutId, $ids);
        $this->assertNotContains($this->foreignLayoutId, $ids);
        $this->assertSame(6, $res->json('data.0.seat_count'));
    }

    public function test_open_with_explicit_layout_id_snapshots_that_layout(): void
    {
        $routeId = $this->makeRoute();
        $user = $this->assignedDriver($routeId);

        Sanctum::actingAs($user, ['act-as:driver']);
        $res = $this->postJson('/api/fixed/driver/vehicles', [
            'route_id' => $routeId,
            'vehicle_seat_layout_id' => $this->primaryLayoutId,
        ])->assertCreated();

        $depId = (int) $res->json('vehicle.id');
        $dep = RouteDeparture::query()->findOrFail($depId);

        $this->assertSame($this->primaryLayoutId, (int) $dep->vehicle_seat_layout_id);
        $this->assertSame(6, (int) $dep->capacity, 'capacity should equal the layout seat count');

        $labels = DepartureSeat::query()
            ->where('route_departure_id', $depId)
            ->orderBy('label')
            ->pluck('label')
            ->all();
        $this->assertSame(['1A', '2A', '2B', '2C', '3A', '3B'], $labels);
    }

    public function test_open_rejects_layout_from_a_different_city(): void
    {
        $routeId = $this->makeRoute();
        $user = $this->assignedDriver($routeId);

        Sanctum::actingAs($user, ['act-as:driver']);
        $this->postJson('/api/fixed/driver/vehicles', [
            'route_id' => $routeId,
            'vehicle_seat_layout_id' => $this->foreignLayoutId,
        ])->assertStatus(422);
    }

    /* ------------------------------------------------------------------ */
    /* F3 — the layout list is narrowed to the driver's own vehicle type   */
    /* ------------------------------------------------------------------ */

    public function test_layouts_endpoint_narrows_to_the_drivers_vehicle_type(): void
    {
        // A second vehicle type in the SAME city, with its own layout.
        $otherTypeId = DB::table('vehicle_types')->insertGetId([
            'name' => 'Swift', 'sort_order' => 2, 'is_active' => true,
            'created_at' => now(), 'updated_at' => now(),
        ]);
        $swiftLayoutId = SeatLayoutFactory::standardErtiga6P($this->cityId, $otherTypeId, 'Swift 4P');

        $routeId = $this->makeRoute();
        // Driver drives an Ertiga.
        $user = $this->assignedDriver($routeId, $this->vehicleTypeId);

        Sanctum::actingAs($user, ['act-as:driver']);
        $res = $this->getJson("/api/fixed/driver/routes/{$routeId}/layouts")->assertOk();

        $ids = collect($res->json('data'))->pluck('id')->all();
        $this->assertContains($this->primaryLayoutId, $ids, "the driver's own Ertiga layout is listed");
        $this->assertNotContains($swiftLayoutId, $ids, "another vehicle's layout is hidden");
    }

    public function test_open_rejects_a_layout_for_a_different_vehicle_type(): void
    {
        $otherTypeId = DB::table('vehicle_types')->insertGetId([
            'name' => 'Swift', 'sort_order' => 2, 'is_active' => true,
            'created_at' => now(), 'updated_at' => now(),
        ]);
        $swiftLayoutId = SeatLayoutFactory::standardErtiga6P($this->cityId, $otherTypeId, 'Swift 4P');

        $routeId = $this->makeRoute();
        $user = $this->assignedDriver($routeId, $this->vehicleTypeId);

        Sanctum::actingAs($user, ['act-as:driver']);
        $this->postJson('/api/fixed/driver/vehicles', [
            'route_id' => $routeId,
            'vehicle_seat_layout_id' => $swiftLayoutId,
        ])->assertStatus(422);
    }

    public function test_layouts_rejects_when_no_layout_matches_the_vehicle(): void
    {
        // The driver's vehicle type has NO layout in this city, so the filter must
        // fall back to the full city list rather than lock them out.
        $lonelyTypeId = DB::table('vehicle_types')->insertGetId([
            'name' => 'Tempo', 'sort_order' => 3, 'is_active' => true,
            'created_at' => now(), 'updated_at' => now(),
        ]);

        $routeId = $this->makeRoute();
        $user = $this->assignedDriver($routeId, $lonelyTypeId);

        Sanctum::actingAs($user, ['act-as:driver']);
        $this->getJson("/api/fixed/driver/routes/{$routeId}/layouts")->assertStatus(422)
            ->assertJsonPath('message', 'No seat layout is configured for this vehicle. Contact the admin.');
    }

    public function test_manifest_includes_seat_labels_for_each_passenger(): void
    {
        $routeId = $this->makeRoute();
        $user = $this->assignedDriver($routeId);

        // Open, book two seats, and confirm through the test-payment path.
        Sanctum::actingAs($user, ['act-as:driver']);
        $depId = (int) $this->postJson('/api/fixed/driver/vehicles', [
            'route_id' => $routeId,
            'vehicle_seat_layout_id' => $this->primaryLayoutId,
        ])->assertCreated()->json('vehicle.id');

        $pickupStopId = DB::table('route_stops')->insertGetId([
            'route_id' => $routeId, 'seq' => 1, 'name' => 'Pickup',
            'lat' => 34.0, 'lng' => 74.0,
            'is_pickup' => true, 'is_drop' => false,
            'is_active' => true, 'is_temporarily_unavailable' => false,
            'created_at' => now(), 'updated_at' => now(),
        ]);
        $dropStopId = DB::table('route_stops')->insertGetId([
            'route_id' => $routeId, 'seq' => 2, 'name' => 'Drop',
            'lat' => 34.1, 'lng' => 74.1,
            'is_pickup' => false, 'is_drop' => true,
            'is_active' => true, 'is_temporarily_unavailable' => false,
            'created_at' => now(), 'updated_at' => now(),
        ]);

        // Open boarding window on the departure so a customer can book.
        RouteDeparture::query()->whereKey($depId)->update([
            'depart_at' => now()->addHour(),
            'announced_depart_at' => now()->addHour(),
            'boarding_opened_at' => now(),
        ]);

        config()->set('services.razorpay.key_id', 'rzp_test_m6');
        $customer = User::factory()->create();
        $customer->addRole('customer');
        Sanctum::actingAs($customer, ['act-as:customer']);

        $holdId = $this->withHeaders(['Idempotency-Key' => 'm6-hold'])
            ->postJson('/api/fixed/seat-holds', [
                'route_departure_id' => $depId,
                'board_stop_id' => $pickupStopId,
                'drop_stop_id' => $dropStopId,
                'seat_labels' => ['2A', '2B'],
            ])->assertCreated()->json('hold.id');

        Sanctum::actingAs($user, ['act-as:driver']);
        $this->postJson("/api/fixed/driver/seat-holds/{$holdId}/accept")->assertOk();
        Sanctum::actingAs($customer, ['act-as:customer']);

        $reservationId = (int) $this->withHeaders(['Idempotency-Key' => 'm6-pay'])
            ->postJson("/api/fixed/seat-holds/{$holdId}/test-confirm-payment", [
                'booking_channel' => 'advance',
            ])->assertCreated()->json('reservation.id');

        Sanctum::actingAs($user, ['act-as:driver']);
        $manifest = $this->getJson("/api/fixed/departures/{$depId}/manifest")->assertOk();

        $manifest->assertJsonPath('passengers.0.id', $reservationId)
            ->assertJsonPath('passengers.0.seat_labels', ['2A', '2B']);
    }
}
