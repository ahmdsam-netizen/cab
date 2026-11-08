<?php
namespace Tests\Feature;
use App\Models\{City, CityVehicleType, Driver, ManagerRole, Permission, Route, RouteGroup, User};
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class AdminDriversRouteAllocationTest extends TestCase
{
    use RefreshDatabase;

    public function test_city_and_stand_rosters_count_assignments_before_pagination(): void
    {
        $city = City::create(['name' => 'First', 'country_code' => 'IN']);
        $other = City::create(['name' => 'Other', 'country_code' => 'IN']);
        $empty = City::create(['name' => 'Vacant', 'country_code' => 'IN']);
        $alice = Driver::create(['user_id' => User::factory()->create(['name' => 'Alice'])->id, 'city_id' => $city->id]);
        $alice->cities()->attach([$city->id, $other->id]);
        $bob = Driver::create(['user_id' => User::factory()->create(['name' => 'Bob'])->id, 'city_id' => $city->id]);
        $alice->forceFill(['created_at' => now()->subDay()])->save();
        $stand = RouteGroup::create(['city_id' => $city->id, 'name' => 'Airport', 'is_active' => true]);
        $stand->drivers()->attach($alice->user_id);
        RouteGroup::create(['city_id' => $city->id, 'name' => 'Station', 'is_active' => false]);
        $otherStand = RouteGroup::create(['city_id' => $other->id, 'name' => 'Airport', 'is_active' => true]);
        $otherStand->drivers()->attach($alice->user_id);

        $role = ManagerRole::create(['slug' => 'roster_manager', 'name' => 'Roster Manager']);
        $permission = Permission::firstOrCreate(['slug' => 'drivers'], ['name' => 'Drivers']);
        $role->permissions()->attach($permission);
        $manager = User::factory()->create(['manager_role_id' => $role->id, 'manager_all_cities' => true]);
        $manager->addRole('admin');
        Sanctum::actingAs($manager, ['act-as:admin']);

        $this->getJson('/api/admin/drivers/city-counts')->assertOk()->assertExactJson(['data' => [
            ['id' => $city->id, 'name' => 'First', 'driver_count' => 2],
            ['id' => $other->id, 'name' => 'Other', 'driver_count' => 1],
            ['id' => $empty->id, 'name' => 'Vacant', 'driver_count' => 0],
        ]]);
        $this->getJson("/api/admin/cities/{$city->id}/driver-stand-counts")->assertOk()
            ->assertJsonPath('data.0.driver_count', 1)
            ->assertJsonPath('data.1.driver_count', 0)
            ->assertJsonPath('data.1.is_active', false);
        $listUrl = '/api/admin/drivers?city_id='.$city->id;
        $this->getJson($listUrl.'&per_page=1')->assertOk()
            ->assertJsonPath('data.total', 2)
            ->assertJsonPath('data.data.0.id', $bob->id);
        $this->getJson($listUrl.'&stand_id='.$stand->id)->assertOk()
            ->assertJsonPath('data.total', 1)
            ->assertJsonPath('data.data.0.id', $alice->id)
            ->assertJsonPath('data.data.0.user.name', 'Alice')
            ->assertJsonPath('data.data.0.cities', [
                ['id' => $city->id, 'name' => 'First'],
                ['id' => $other->id, 'name' => 'Other'],
            ]);
        $this->getJson($listUrl.'&stand_id='.$stand->id.'&q=Bob')->assertOk()->assertJsonPath('data.total', 0);
        $this->getJson($listUrl.'&stand_id='.$otherStand->id)->assertUnprocessable();
        $csv = $this->get('/api/admin/drivers/export?city_id='.$city->id.'&stand_id='.$stand->id)
            ->assertOk()->streamedContent();
        $this->assertStringContainsString('Alice', $csv);
        $this->assertStringNotContainsString('Bob', $csv);

        $manager->forceFill(['manager_city_id' => $city->id, 'manager_all_cities' => false])->save();
        $this->getJson('/api/admin/drivers/city-counts')->assertOk()->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.id', $city->id);
        $this->getJson("/api/admin/cities/{$other->id}/driver-stand-counts")->assertForbidden();
        $this->getJson('/api/admin/drivers?city_id='.$other->id)->assertForbidden();
    }

    public function test_approval_views_filter_before_pagination_and_export(): void
    {
        $admin = User::factory()->create(['manager_all_cities' => true]); $admin->addRole('admin');
        $role = DB::table('manager_roles')->insertGetId(['slug' => 'super_admin', 'name' => 'Super Admin', 'is_system' => true, 'created_at' => now(), 'updated_at' => now()]);
        $admin->forceFill(['manager_role_id' => $role])->save(); Sanctum::actingAs($admin, ['act-as:admin']);
        foreach (['approved', 'pending', 'rejected'] as $status) {
            Driver::create(['user_id' => User::factory()->create(['name' => 'View '.$status])->id, 'approval_status' => $status]);
        }
        $this->getJson('/api/admin/drivers?approval_status=approved')->assertOk()
            ->assertJsonPath('data.total', 1)->assertJsonPath('data.data.0.approval_status', 'approved');
        $response = $this->getJson('/api/admin/drivers?approval_status=not_approved&per_page=1')->assertOk()
            ->assertJsonPath('data.total', 2)->assertJsonCount(1, 'data.data');
        $this->assertContains($response->json('data.data.0.approval_status'), ['pending', 'rejected']);
        $csv = $this->get('/api/admin/drivers/export?approval_status=not_approved')->assertOk()->streamedContent();
        $this->assertStringContainsString('View pending', $csv);
        $this->assertStringContainsString('View rejected', $csv);
        $this->assertStringNotContainsString('View approved', $csv);
    }
    public function test_city_vehicle_filter_and_distinct_route_allocation_summary(): void
    {
        $admin = User::factory()->create(['manager_all_cities' => true]); $admin->addRole('admin');
        $role = DB::table('manager_roles')->insertGetId(['slug' => 'super_admin', 'name' => 'Super Admin', 'is_system' => true, 'created_at' => now(), 'updated_at' => now()]);
        $admin->forceFill(['manager_role_id' => $role])->save(); Sanctum::actingAs($admin, ['act-as:admin']);
        $city = City::create(['name' => 'First', 'country_code' => 'IN']);
        $other = City::create(['name' => 'Other', 'country_code' => 'IN']);
        $rideId = DB::table('ride_types')->insertGetId(['name' => 'Fixed', 'created_at' => now(), 'updated_at' => now()]);
        $vehicle = CityVehicleType::create(['city_id' => $city->id, 'ride_type_id' => $rideId, 'display_name' => 'SUMO', 'is_active' => true]);
        $driver = Driver::create(['user_id' => User::factory()->create()->id, 'city_id' => $other->id, 'approval_status' => 'approved']);
        $driver->cities()->attach($city->id);
        Driver::create(['user_id' => User::factory()->create()->id, 'city_id' => $city->id, 'approval_status' => 'approved']);
        $route = Route::create(['city_id' => $city->id, 'name' => 'Shared', 'scope' => 'local', 'mode' => 'fixed', 'origin_name' => 'A', 'dest_name' => 'B', 'origin_lat' => 34, 'origin_lng' => 74, 'dest_lat' => 34.1, 'dest_lng' => 74.1]);
        foreach (['First group', 'Second group'] as $name) {
            $group = RouteGroup::create(['city_id' => $city->id, 'city_vehicle_type_id' => $vehicle->id, 'name' => $name, 'is_active' => true]);
            $group->routes()->attach($route->id); $group->drivers()->attach($driver->user_id);
        }
        $outside = RouteGroup::create(['city_id' => $other->id, 'name' => 'Outside', 'is_active' => true]); $outside->drivers()->attach($driver->user_id);
        $this->getJson('/api/admin/drivers?city_id='.$city->id.'&city_vehicle_type_id='.$vehicle->id)->assertOk()
            ->assertJsonPath('data.total', 1)->assertJsonPath('data.data.0.id', $driver->id)
            ->assertJsonCount(2, 'data.data.0.route_groups')->assertJsonPath('data.data.0.allocated_route_count', 1);
        $this->getJson('/api/admin/drivers?city_id='.$other->id.'&city_vehicle_type_id='.$vehicle->id)->assertOk()->assertJsonPath('data.total', 0);
        $this->getJson('/api/admin/drivers?city_id='.$other->id)->assertOk()->assertJsonCount(1, 'data.data.0.route_groups');
    }
}
