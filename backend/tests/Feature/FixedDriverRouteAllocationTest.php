<?php

namespace Tests\Feature;

use App\Models\Driver;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Laravel\Sanctum\Sanctum;
use Tests\Support\SeatLayoutFactory;
use Tests\TestCase;

/**
 * M3 — the gate cutover. Proves the driver's fixed-route list and open() come
 * from assigned route groups (not the vehicle), narrowed by the driver's online
 * city + scope, and that open() is entitlement-guarded.
 */
class FixedDriverRouteAllocationTest extends TestCase
{
    use RefreshDatabase;

    private int $cityId;
    private int $vehicleTypeId;

    protected function setUp(): void
    {
        parent::setUp();
        $this->cityId = DB::table('cities')->insertGetId([
            'name' => 'Alloc City', 'country_code' => 'IN',
            'created_at' => now(), 'updated_at' => now(),
        ]);
        $vehicleTypeId = DB::table('vehicle_types')->insertGetId([
            'name' => 'Ertiga', 'sort_order' => 1, 'is_active' => true,
            'created_at' => now(), 'updated_at' => now(),
        ]);
        SeatLayoutFactory::standardErtiga6P($this->cityId, $vehicleTypeId);
        $this->vehicleTypeId = $vehicleTypeId;
    }

    private function makeRoute(string $name, string $scope = 'local'): int
    {
        return DB::table('routes')->insertGetId([
            'city_id' => $this->cityId, 'scope' => $scope, 'mode' => 'fixed', 'name' => $name,
            'origin_name' => "$name O", 'dest_name' => "$name D",
            'origin_lat' => 34.0, 'origin_lng' => 74.0, 'dest_lat' => 34.1, 'dest_lng' => 74.1,
            'fare_config' => json_encode(['seat_fare' => 100]),
            'is_active' => true,
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    private function makeGroupWithRoutes(string $name, array $routeIds): int
    {
        $gid = DB::table('route_groups')->insertGetId([
            'city_id' => $this->cityId, 'name' => $name, 'is_active' => true,
            'created_at' => now(), 'updated_at' => now(),
        ]);
        foreach ($routeIds as $rid) {
            DB::table('route_group_route')->insert([
                'route_group_id' => $gid, 'route_id' => $rid,
                'created_at' => now(), 'updated_at' => now(),
            ]);
        }
        return $gid;
    }

    /** @return User the driver's user (online, fixed, local, in the city). */
    private function onlineFixedDriver(): User
    {
        $vehicleId = DB::table('city_vehicle_types')->insertGetId(['city_id' => $this->cityId,
            'vehicle_type_id' => $this->vehicleTypeId, 'display_name' => 'Ertiga', 'is_active' => true,
            'max_people' => 6, 'luggage_capacity' => 2]);
        $user = User::factory()->create();
        $user->addRole('driver');
        $driver = Driver::query()->create([
            'user_id' => $user->id,
            'city_id' => $this->cityId,
            'vehicle_type_id' => $this->vehicleTypeId,
            'city_vehicle_type_id' => $vehicleId,
            'approval_status' => 'approved',
            'service_scope' => 'local',
            'service_mode' => 'fixed',
            'is_online' => true,
            'last_online_at' => now(),
        ]);
        $driver->forceFill(['active_service_mode' => 'fixed', 'active_service_scope' => 'local'])->save();

        return $user;
    }

    private function assignGroup(User $driverUser, int $groupId): void
    {
        DB::table('driver_route_group')->insert([
            'driver_user_id' => $driverUser->id, 'route_group_id' => $groupId,
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    private function routeIds($response): array
    {
        return collect($response->json('data'))->pluck('id')->all();
    }

    public function test_driver_sees_only_routes_from_assigned_groups(): void
    {
        $user = $this->onlineFixedDriver();
        $r1 = $this->makeRoute('R1');
        $r2 = $this->makeRoute('R2');
        $this->makeRoute('R3'); // exists but in no group of this driver
        $this->assignGroup($user, $this->makeGroupWithRoutes('Airport', [$r1, $r2]));

        Sanctum::actingAs($user, ['act-as:driver']);
        $res = $this->getJson('/api/fixed/driver/routes')->assertOk();
        $this->assertEqualsCanonicalizing([$r1, $r2], $this->routeIds($res));
    }

    public function test_unassigned_driver_sees_no_routes(): void
    {
        $user = $this->onlineFixedDriver();
        $this->makeRoute('R1');

        Sanctum::actingAs($user, ['act-as:driver']);
        $this->getJson('/api/fixed/driver/routes')->assertOk()->assertJson(['data' => []]);
    }

    public function test_scope_still_narrows_the_list(): void
    {
        $user = $this->onlineFixedDriver(); // online scope = local
        $local = $this->makeRoute('LocalR', 'local');
        $outstation = $this->makeRoute('OutR', 'outstation');
        $this->assignGroup($user, $this->makeGroupWithRoutes('Mixed', [$local, $outstation]));

        Sanctum::actingAs($user, ['act-as:driver']);
        $res = $this->getJson('/api/fixed/driver/routes')->assertOk();
        $this->assertSame([$local], $this->routeIds($res)); // outstation hidden while online local
    }

    public function test_open_allowed_for_assigned_route(): void
    {
        $user = $this->onlineFixedDriver();
        $r1 = $this->makeRoute('R1');
        $this->assignGroup($user, $this->makeGroupWithRoutes('G', [$r1]));

        Sanctum::actingAs($user, ['act-as:driver']);
        $this->postJson('/api/fixed/driver/vehicles', ['route_id' => $r1, 'capacity' => 4])
            ->assertCreated()
            ->assertJsonPath('vehicle.status', 'FORMING');
    }

    public function test_open_forbidden_for_unassigned_route(): void
    {
        $user = $this->onlineFixedDriver();
        $r1 = $this->makeRoute('R1'); // assigned
        $r2 = $this->makeRoute('R2'); // NOT assigned
        $this->assignGroup($user, $this->makeGroupWithRoutes('G', [$r1]));

        Sanctum::actingAs($user, ['act-as:driver']);
        $this->postJson('/api/fixed/driver/vehicles', ['route_id' => $r2, 'capacity' => 4])
            ->assertStatus(403);
    }

    public function test_two_drivers_same_city_have_independent_lists(): void
    {
        $a = $this->onlineFixedDriver();
        $b = $this->onlineFixedDriver();
        $r1 = $this->makeRoute('R1');
        $r2 = $this->makeRoute('R2');
        $r5 = $this->makeRoute('R5');
        $this->assignGroup($a, $this->makeGroupWithRoutes('Airport', [$r1, $r2]));
        $this->assignGroup($b, $this->makeGroupWithRoutes('North', [$r5]));

        Sanctum::actingAs($a, ['act-as:driver']);
        $this->assertEqualsCanonicalizing([$r1, $r2], $this->routeIds($this->getJson('/api/fixed/driver/routes')));

        Sanctum::actingAs($b, ['act-as:driver']);
        $this->assertSame([$r5], $this->routeIds($this->getJson('/api/fixed/driver/routes')));
    }
}
