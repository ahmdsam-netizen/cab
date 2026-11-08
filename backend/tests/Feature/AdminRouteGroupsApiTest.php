<?php

namespace Tests\Feature;

use App\Models\Driver;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * M2 — admin route-group CRUD + membership + driver assignment + effective read.
 */
class AdminRouteGroupsApiTest extends TestCase
{
    use RefreshDatabase;

    private int $cityId;
    private int $otherCityId;

    protected function setUp(): void
    {
        parent::setUp();

        $this->cityId = $this->makeCity('Group City');
        $this->otherCityId = $this->makeCity('Other City');

        $admin = User::factory()->create(['manager_all_cities' => true]);
        $admin->addRole('admin');
        $roleId = DB::table('manager_roles')->insertGetId([
            'slug' => 'super_admin', 'name' => 'Super Admin', 'is_system' => true,
            'created_at' => now(), 'updated_at' => now(),
        ]);
        $admin->forceFill(['manager_role_id' => $roleId])->save();
        Sanctum::actingAs($admin, ['act-as:admin']);
    }

    private function makeCity(string $name): int
    {
        return DB::table('cities')->insertGetId([
            'name' => $name, 'country_code' => 'IN',
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    private function makeRoute(int $cityId, string $name, string $mode = 'fixed'): int
    {
        return DB::table('routes')->insertGetId([
            'city_id' => $cityId, 'scope' => 'local', 'mode' => $mode, 'name' => $name,
            'origin_name' => "$name O", 'dest_name' => "$name D",
            'origin_lat' => 34.0, 'origin_lng' => 74.0, 'dest_lat' => 34.1, 'dest_lng' => 74.1,
            'fare_config' => json_encode(['seat_fare' => 10]),
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    private function makeDriver(int $cityId): Driver
    {
        $user = User::factory()->create();
        return Driver::query()->create([
            'user_id' => $user->id,
            'city_id' => $cityId,
            'approval_status' => 'approved',
        ]);
    }

    private function makeCityVehicleType(int $cityId): int
    {
        $rideTypeId = DB::table('ride_types')->insertGetId([
            'name' => 'RT ' . uniqid(), 'created_at' => now(), 'updated_at' => now(),
        ]);

        return DB::table('city_vehicle_types')->insertGetId([
            'city_id' => $cityId,
            'ride_type_id' => $rideTypeId,
            'display_name' => 'Veh ' . uniqid(),
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    public function test_create_group_with_routes(): void
    {
        $r1 = $this->makeRoute($this->cityId, 'R1');
        $r2 = $this->makeRoute($this->cityId, 'R2');

        $res = $this->postJson("/api/admin/cities/{$this->cityId}/route-groups", [
            'name' => 'Airport', 'route_ids' => [$r1, $r2],
        ]);

        $res->assertCreated();
        $this->assertEqualsCanonicalizing([$r1, $r2], $res->json('route_group.route_ids'));
        $this->assertSame(2, $res->json('route_group.route_count'));
    }

    public function test_multiple_groups_share_one_generated_fleet_and_save_atomically(): void
    {
        $vehicle = $this->makeCityVehicleType($this->cityId);
        $route = $this->makeRoute($this->cityId, 'Shared');
        $driver = $this->makeDriver($this->cityId);
        $payload = ['names' => ['Morning', 'Evening'], 'route_ids' => [$route], 'vehicle_ids' => [$vehicle], 'vehicle_set_ids' => [], 'driver_user_ids' => [$driver->user_id]];
        $result = $this->postJson("/api/admin/cities/{$this->cityId}/route-groups/setup-batch", $payload)->assertCreated();
        $this->assertCount(2, $result->json('data'));
        $this->assertSame($result->json('data.0.vehicle_set_ids'), $result->json('data.1.vehicle_set_ids'));
        $this->assertSame([$route], $result->json('data.1.route_ids'));
        $this->assertSame([$driver->user_id], $result->json('data.1.driver_user_ids'));
        $this->assertDatabaseCount('vehicle_sets', 1);
        $payload['vehicle_ids'] = []; $payload['vehicle_set_ids'] = $result->json('data.0.vehicle_set_ids'); $payload['names'] = ['New draft', 'Morning'];
        $this->postJson("/api/admin/cities/{$this->cityId}/route-groups/setup-batch", $payload)->assertUnprocessable();
        $this->assertDatabaseCount('route_groups', 2); $this->assertDatabaseMissing('route_groups', ['name' => 'New draft']);
    }

    public function test_multiple_vehicles_can_join_groups_and_a_failed_batch_creates_nothing(): void
    {
        $group = $this->postJson("/api/admin/cities/{$this->cityId}/route-groups", ['name' => 'Town'])->assertCreated()->json('route_group.id');
        $payload = ['vehicles' => [
            ['vehicle_type_name' => 'Sumo', 'display_name' => 'Sumo', 'max_people' => 9, 'luggage_capacity' => 0],
            ['vehicle_type_name' => 'Bus', 'display_name' => 'Bus', 'max_people' => 30, 'luggage_capacity' => 2],
        ], 'route_group_ids' => [$group], 'set_name' => 'Town fleet'];
        $response = $this->postJson("/api/admin/cities/{$this->cityId}/vehicle-types/batch", $payload)->assertCreated();
        $this->assertCount(2, $response->json('data')); $this->assertDatabaseCount('vehicle_sets', 1);
        $set = DB::table('vehicle_sets')->first()->id;
        $this->assertDatabaseHas('route_group_vehicle_set', ['route_group_id' => $group, 'vehicle_set_id' => $set]);
        $this->assertSame(2, DB::table('city_vehicle_types')->where('vehicle_set_id', $set)->count());
        $payload['vehicles'][0]['display_name'] = 'Another Sumo';
        $this->postJson("/api/admin/cities/{$this->cityId}/vehicle-types/batch", $payload)->assertUnprocessable()->assertJsonValidationErrors('vehicles.1');
        $this->assertDatabaseCount('city_vehicle_types', 2); $this->assertDatabaseCount('vehicle_sets', 1);
        $payload['route_group_ids'] = [DB::table('route_groups')->insertGetId(['city_id' => $this->otherCityId, 'name' => 'Foreign', 'created_at' => now(), 'updated_at' => now()])];
        $this->postJson("/api/admin/cities/{$this->cityId}/vehicle-types/batch", $payload)->assertUnprocessable();
        $this->assertDatabaseCount('city_vehicle_types', 2);
    }

    public function test_workspace_setup_saves_routes_vehicles_and_drivers_together_and_can_pause_access(): void
    {
        $sumo = $this->makeCityVehicleType($this->cityId);
        $bus = $this->makeCityVehicleType($this->cityId);
        $route = $this->makeRoute($this->cityId, 'Town route');
        $driver = $this->makeDriver($this->cityId);
        $payload = ['name' => 'Town service', 'route_ids' => [$route], 'vehicle_ids' => [$sumo, $bus], 'vehicle_set_ids' => [], 'driver_user_ids' => [$driver->user_id], 'is_active' => true];
        $result = $this->postJson("/api/admin/cities/{$this->cityId}/route-groups/setup", $payload)->assertCreated();
        $group = $result->json('route_group.id');
        $set = $result->json('route_group.vehicle_set_ids.0');
        $this->assertDatabaseHas('city_vehicle_types', ['id' => $bus, 'vehicle_set_id' => $set]);
        $this->assertDatabaseHas('city_vehicle_types', ['id' => $sumo, 'vehicle_set_id' => $set]);
        $this->getJson("/api/admin/drivers/{$driver->id}/route-groups")->assertOk()->assertJsonPath('effective_routes.0.id', $route);
        $payload['vehicle_ids'] = []; $payload['vehicle_set_ids'] = [$set]; $payload['is_active'] = false; $payload['name'] = 'Renamed service';
        $this->putJson("/api/admin/cities/{$this->cityId}/route-groups/{$group}/setup", $payload)->assertOk();
        $this->getJson("/api/admin/drivers/{$driver->id}/route-groups")->assertOk()->assertJsonPath('assigned_group_ids', [$group])->assertJsonPath('effective_routes', []);
        $payload['is_active'] = true;
        $this->putJson("/api/admin/cities/{$this->cityId}/route-groups/{$group}/setup", $payload)->assertOk();
        $this->getJson("/api/admin/drivers/{$driver->id}/route-groups")->assertOk()->assertJsonPath('effective_routes.0.id', $route);
        $this->assertDatabaseCount('routes', 1); $this->assertDatabaseCount('vehicle_sets', 1);
    }

    public function test_workspace_invalid_selection_rolls_back_entire_setup_and_does_not_move_set_members(): void
    {
        $vehicle = $this->makeCityVehicleType($this->cityId);
        $foreignDriver = $this->makeDriver($this->otherCityId);
        $payload = ['name' => 'Bad service', 'route_ids' => [], 'vehicle_ids' => [$vehicle], 'vehicle_set_ids' => [], 'driver_user_ids' => [$foreignDriver->user_id]];
        $this->postJson("/api/admin/cities/{$this->cityId}/route-groups/setup", $payload)->assertUnprocessable();
        $this->assertDatabaseCount('route_groups', 0); $this->assertDatabaseCount('vehicle_sets', 0);
        $set = $this->postJson("/api/admin/cities/{$this->cityId}/vehicle-sets", ['name' => 'Existing', 'vehicle_ids' => [$vehicle]])->assertCreated()->json('vehicle_set.id');
        $payload['driver_user_ids'] = [];
        $this->postJson("/api/admin/cities/{$this->cityId}/route-groups/setup", $payload)->assertUnprocessable();
        $this->assertDatabaseCount('route_groups', 0); $this->assertDatabaseHas('city_vehicle_types', ['id' => $vehicle, 'vehicle_set_id' => $set]);
        $payload['vehicle_ids'] = []; $payload['vehicle_set_ids'] = [$set]; $payload['name'] = 'Existing set service';
        $this->postJson("/api/admin/cities/{$this->cityId}/route-groups/setup", $payload)->assertCreated();
        $this->assertDatabaseCount('vehicle_sets', 1);
    }

    public function test_vehicle_type_and_city_vehicle_can_be_created_in_one_step(): void
    {
        $payload = ['vehicle_type_name' => 'Bicycle', 'display_name' => 'Town bicycle', 'max_people' => 1, 'luggage_capacity' => 0];
        $result = $this->postJson("/api/admin/cities/{$this->cityId}/vehicle-types", $payload)->assertCreated();
        $this->assertDatabaseHas('vehicle_types', ['id' => $result->json('vehicle_type.vehicle_type_id'), 'name' => 'Bicycle']);
        $payload['display_name'] = 'Second bicycle';
        $this->postJson("/api/admin/cities/{$this->cityId}/vehicle-types", $payload)->assertCreated();
        $this->assertDatabaseCount('vehicle_types', 1);
    }

    public function test_vehicle_set_shares_groups_without_copying_routes_or_granting_driver_access(): void
    {
        $sumo = $this->makeCityVehicleType($this->cityId);
        $tavera = $this->makeCityVehicleType($this->cityId);
        $route = $this->makeRoute($this->cityId, 'Shared route');
        $group = $this->postJson("/api/admin/cities/{$this->cityId}/route-groups", [
            'name' => 'Shared work', 'city_vehicle_type_id' => $sumo, 'route_ids' => [$route],
        ])->assertCreated()->json('route_group.id');
        $set = $this->postJson("/api/admin/cities/{$this->cityId}/vehicle-sets", [
            'name' => 'Shared fleet', 'vehicle_ids' => [$sumo], 'route_group_ids' => [$group],
        ])->assertCreated()->json('vehicle_set.id');
        $this->patchJson("/api/admin/cities/{$this->cityId}/vehicle-sets/{$set}", [
            'vehicle_ids' => [$sumo, $tavera],
        ])->assertOk()->assertJsonPath('vehicle_set.route_group_ids', [$group]);
        $this->assertDatabaseHas('city_vehicle_types', ['id' => $tavera, 'vehicle_set_id' => $set]);
        $this->assertDatabaseCount('routes', 1);
        $this->assertDatabaseCount('route_group_route', 1);
        $this->getJson("/api/admin/cities/{$this->cityId}/route-groups")
            ->assertOk()->assertJsonPath('data.0.vehicle_set_ids', [$set]);
        $driver = $this->makeDriver($this->cityId);
        $driver->update(['city_vehicle_type_id' => $tavera]);
        $this->getJson("/api/admin/drivers/{$driver->id}/route-groups")
            ->assertOk()->assertJsonPath('groups.0.matches_vehicle_set', true)
            ->assertJsonPath('assigned_group_ids', [])->assertJsonPath('effective_routes', []);
        $this->putJson("/api/admin/drivers/{$driver->id}/route-groups", ['group_ids' => [$group]])
            ->assertOk()->assertJsonPath('effective_routes.0.id', $route);
        // Changing shared membership must not remove explicit assignments.
        $this->patchJson("/api/admin/cities/{$this->cityId}/vehicle-sets/{$set}", [
            'vehicle_ids' => [$sumo], 'route_group_ids' => [],
        ])->assertOk();
        $this->assertDatabaseHas('city_vehicle_types', ['id' => $tavera, 'vehicle_set_id' => null]);
        $this->getJson("/api/admin/drivers/{$driver->id}/route-groups")
            ->assertOk()->assertJsonPath('assigned_group_ids', [$group])->assertJsonPath('effective_routes.0.id', $route);
    }

    public function test_new_group_under_set_member_is_shared_and_foreign_members_are_rejected(): void
    {
        $vehicle = $this->makeCityVehicleType($this->cityId);
        $foreign = $this->makeCityVehicleType($this->otherCityId);
        $set = $this->postJson("/api/admin/cities/{$this->cityId}/vehicle-sets", [
            'name' => 'Local fleet', 'vehicle_ids' => [$vehicle],
        ])->assertCreated()->json('vehicle_set.id');
        $group = $this->postJson("/api/admin/cities/{$this->cityId}/route-groups", [
            'name' => 'New shared group', 'city_vehicle_type_id' => $vehicle,
        ])->assertCreated()->assertJsonPath('route_group.vehicle_set_ids', [$set])->json('route_group.id');
        $foreignGroup = $this->postJson("/api/admin/cities/{$this->otherCityId}/route-groups", ['name' => 'Other group'])
            ->assertCreated()->json('route_group.id');
        $this->patchJson("/api/admin/cities/{$this->cityId}/vehicle-sets/{$set}", [
            'name' => 'Wrong change', 'vehicle_ids' => [$foreign],
        ])->assertUnprocessable();
        $this->patchJson("/api/admin/cities/{$this->cityId}/vehicle-sets/{$set}", [
            'vehicle_ids' => [], 'route_group_ids' => [$foreignGroup],
        ])->assertUnprocessable();
        $this->assertDatabaseHas('vehicle_sets', ['id' => $set, 'name' => 'Local fleet']);
        $this->assertDatabaseHas('city_vehicle_types', ['id' => $vehicle, 'vehicle_set_id' => $set]);
        $this->getJson("/api/admin/cities/{$this->cityId}/vehicle-sets")
            ->assertOk()->assertJsonPath('data.0.route_group_ids', [$group]);
        $this->deleteJson("/api/admin/cities/{$this->cityId}/vehicle-sets/{$set}")->assertOk();
        $this->assertDatabaseHas('route_groups', ['id' => $group]);
        $this->assertDatabaseCount('route_group_vehicle_set', 0);
        $this->assertDatabaseHas('city_vehicle_types', ['id' => $vehicle, 'vehicle_set_id' => null]);
    }

    public function test_vehicle_can_join_an_existing_set_on_creation_but_not_a_foreign_city_set(): void
    {
        $set = $this->postJson("/api/admin/cities/{$this->cityId}/vehicle-sets", ['name' => 'Local'])
            ->assertCreated()->json('vehicle_set.id');
        $foreignSet = $this->postJson("/api/admin/cities/{$this->otherCityId}/vehicle-sets", ['name' => 'Foreign'])
            ->assertCreated()->json('vehicle_set.id');
        $type = DB::table('vehicle_types')->insertGetId(['name' => 'Tavera', 'created_at' => now(), 'updated_at' => now()]);
        $payload = ['vehicle_type_id' => $type, 'vehicle_set_id' => $set, 'display_name' => 'Tavera', 'max_people' => 7, 'luggage_capacity' => 2];
        $vehicle = $this->postJson("/api/admin/cities/{$this->cityId}/vehicle-types", $payload)
            ->assertCreated()->assertJsonPath('vehicle_type.vehicle_set_id', $set)->json('vehicle_type.id');
        $payload['display_name'] = 'Invalid vehicle'; $payload['vehicle_set_id'] = $foreignSet;
        $this->postJson("/api/admin/cities/{$this->cityId}/vehicle-types", $payload)->assertUnprocessable();
        $this->patchJson("/api/admin/cities/{$this->cityId}/vehicle-types/{$vehicle}", ['vehicle_set_id' => $foreignSet])->assertUnprocessable();
        $this->assertDatabaseHas('city_vehicle_types', ['id' => $vehicle, 'vehicle_set_id' => $set]);
        $this->assertDatabaseMissing('city_vehicle_types', ['display_name' => 'Invalid vehicle']);
    }

    public function test_cross_city_route_is_rejected(): void
    {
        $foreign = $this->makeRoute($this->otherCityId, 'Foreign');
        $this->postJson("/api/admin/cities/{$this->cityId}/route-groups", [
            'name' => 'Bad', 'route_ids' => [$foreign],
        ])->assertStatus(422);
    }

    public function test_route_without_a_price_cannot_be_grouped(): void
    {
        $routeId = $this->makeRoute($this->cityId, 'Needs pricing');
        DB::table('routes')->where('id', $routeId)->update(['fare_config' => null]);

        $this->postJson("/api/admin/cities/{$this->cityId}/route-groups", [
            'name' => 'Unpriced', 'route_ids' => [$routeId],
        ])->assertStatus(422);
        $this->assertDatabaseMissing('route_group_route', ['route_id' => $routeId]);
    }

    public function test_non_fixed_route_is_rejected(): void
    {
        $shuttle = $this->makeRoute($this->cityId, 'Shuttle', 'shuttle');
        $this->postJson("/api/admin/cities/{$this->cityId}/route-groups", [
            'name' => 'Bad', 'route_ids' => [$shuttle],
        ])->assertStatus(422);
    }

    public function test_duplicate_group_name_in_same_city_is_rejected(): void
    {
        $this->postJson("/api/admin/cities/{$this->cityId}/route-groups", ['name' => 'Airport'])->assertCreated();
        $this->postJson("/api/admin/cities/{$this->cityId}/route-groups", ['name' => 'Airport'])->assertStatus(422);
    }

    public function test_update_replaces_membership(): void
    {
        $r1 = $this->makeRoute($this->cityId, 'R1');
        $r2 = $this->makeRoute($this->cityId, 'R2');
        $r3 = $this->makeRoute($this->cityId, 'R3');
        $groupId = $this->postJson("/api/admin/cities/{$this->cityId}/route-groups", [
            'name' => 'G', 'route_ids' => [$r1],
        ])->json('route_group.id');

        $res = $this->patchJson("/api/admin/cities/{$this->cityId}/route-groups/{$groupId}", [
            'name' => 'G', 'route_ids' => [$r2, $r3],
        ]);

        $res->assertOk();
        $this->assertEqualsCanonicalizing([$r2, $r3], $res->json('route_group.route_ids'));
    }

    public function test_delete_group(): void
    {
        $groupId = $this->postJson("/api/admin/cities/{$this->cityId}/route-groups", ['name' => 'Temp'])->json('route_group.id');
        $this->deleteJson("/api/admin/cities/{$this->cityId}/route-groups/{$groupId}")->assertOk();
        $this->assertDatabaseMissing('route_groups', ['id' => $groupId]);
    }

    public function test_assign_groups_to_driver_and_effective_union(): void
    {
        $driver = $this->makeDriver($this->cityId);
        $r1 = $this->makeRoute($this->cityId, 'R1');
        $r2 = $this->makeRoute($this->cityId, 'R2');
        $r3 = $this->makeRoute($this->cityId, 'R3');
        $airport = $this->postJson("/api/admin/cities/{$this->cityId}/route-groups", ['name' => 'Airport', 'route_ids' => [$r1, $r2]])->json('route_group.id');
        $north = $this->postJson("/api/admin/cities/{$this->cityId}/route-groups", ['name' => 'North', 'route_ids' => [$r3]])->json('route_group.id');

        // Assign both → union of all three.
        $res = $this->putJson("/api/admin/drivers/{$driver->id}/route-groups", ['group_ids' => [$airport, $north]]);
        $res->assertOk();
        $this->assertEqualsCanonicalizing([$r1, $r2, $r3], collect($res->json('effective_routes'))->pluck('id')->all());

        // Reassign to just North → shrinks to R3.
        $res2 = $this->putJson("/api/admin/drivers/{$driver->id}/route-groups", ['group_ids' => [$north]]);
        $this->assertSame([$r3], collect($res2->json('effective_routes'))->pluck('id')->all());

        // Effective-routes GET agrees.
        $eff = $this->getJson("/api/admin/drivers/{$driver->id}/effective-routes");
        $this->assertSame([$r3], collect($eff->json('data'))->pluck('id')->all());
    }

    public function test_assigning_group_from_another_city_is_rejected(): void
    {
        $driver = $this->makeDriver($this->cityId);
        $foreignGroup = $this->postJson("/api/admin/cities/{$this->otherCityId}/route-groups", ['name' => 'Foreign'])->json('route_group.id');

        $this->putJson("/api/admin/drivers/{$driver->id}/route-groups", ['group_ids' => [$foreignGroup]])
            ->assertStatus(422);
    }

    public function test_deleting_a_group_removes_it_from_a_drivers_effective_routes(): void
    {
        $driver = $this->makeDriver($this->cityId);
        $r1 = $this->makeRoute($this->cityId, 'R1');
        $group = $this->postJson("/api/admin/cities/{$this->cityId}/route-groups", ['name' => 'G', 'route_ids' => [$r1]])->json('route_group.id');
        $this->putJson("/api/admin/drivers/{$driver->id}/route-groups", ['group_ids' => [$group]])->assertOk();

        $this->deleteJson("/api/admin/cities/{$this->cityId}/route-groups/{$group}")->assertOk();

        $eff = $this->getJson("/api/admin/drivers/{$driver->id}/effective-routes");
        $this->assertSame([], $eff->json('data'));
    }

    public function test_assign_drivers_to_group_from_the_group_page(): void
    {
        $driver = $this->makeDriver($this->cityId);
        $r1 = $this->makeRoute($this->cityId, 'R1');
        $group = $this->postJson("/api/admin/cities/{$this->cityId}/route-groups", ['name' => 'Airport', 'route_ids' => [$r1]])->json('route_group.id');

        $res = $this->putJson("/api/admin/cities/{$this->cityId}/route-groups/{$group}/drivers", ['driver_user_ids' => [$driver->user_id]]);
        $res->assertOk();
        $this->assertSame([$driver->user_id], $res->json('driver_user_ids'));

        $g = collect($this->getJson("/api/admin/cities/{$this->cityId}/route-groups")->json('data'))->firstWhere('id', $group);
        $this->assertSame([$driver->user_id], $g['driver_user_ids']);
        $this->assertSame(1, $g['driver_count']);

        // The driver's resolved routes now include the group's route.
        $eff = $this->getJson("/api/admin/drivers/{$driver->id}/effective-routes")->json('data');
        $this->assertSame([$r1], collect($eff)->pluck('id')->all());
    }

    public function test_group_drivers_rejects_a_driver_from_another_city(): void
    {
        $foreign = $this->makeDriver($this->otherCityId);
        $group = $this->postJson("/api/admin/cities/{$this->cityId}/route-groups", ['name' => 'G'])->json('route_group.id');

        $this->putJson("/api/admin/cities/{$this->cityId}/route-groups/{$group}/drivers", ['driver_user_ids' => [$foreign->user_id]])
            ->assertStatus(422);
    }

    public function test_create_group_binds_to_a_city_vehicle(): void
    {
        $vehId = $this->makeCityVehicleType($this->cityId);

        $res = $this->postJson("/api/admin/cities/{$this->cityId}/route-groups", [
            'name' => 'Line A', 'city_vehicle_type_id' => $vehId,
        ]);

        $res->assertCreated();
        // A bound but route-less group carries its vehicle, so it no longer
        // has to leak onto every vehicle to be discoverable.
        $this->assertSame($vehId, $res->json('route_group.city_vehicle_type_id'));
        $this->assertSame(0, $res->json('route_group.route_count'));
    }

    public function test_group_vehicle_from_another_city_is_rejected(): void
    {
        $foreignVeh = $this->makeCityVehicleType($this->otherCityId);

        $this->postJson("/api/admin/cities/{$this->cityId}/route-groups", [
            'name' => 'Bad', 'city_vehicle_type_id' => $foreignVeh,
        ])->assertStatus(422);
    }

    public function test_name_only_rename_preserves_all_assignments_and_inactive_state(): void
    {
        $vehicle = $this->makeCityVehicleType($this->cityId);
        $route = $this->makeRoute($this->cityId, 'Existing route');
        $driver = $this->makeDriver($this->cityId);
        $created = $this->postJson("/api/admin/cities/{$this->cityId}/route-groups/setup", [
            'name' => 'Original', 'is_active' => false, 'city_vehicle_type_id' => $vehicle,
            'route_ids' => [$route], 'driver_user_ids' => [$driver->user_id],
            'vehicle_ids' => [$vehicle], 'vehicle_set_ids' => [],
        ])->assertCreated()->json('route_group');
        // A name-only edit must not revalidate existing route pricing.
        DB::table('routes')->where('id', $route)->update(['fare_config' => null]);
        $url = "/api/admin/cities/{$this->cityId}/route-groups/{$created['id']}";
        $renamed = $this->patchJson($url, ['name' => 'Renamed stand'])->assertOk()->json('route_group');
        foreach (['id', 'is_active', 'city_vehicle_type_id', 'route_ids', 'driver_user_ids', 'vehicle_set_ids'] as $key) {
            $this->assertSame($created[$key], $renamed[$key]);
        }
        $this->assertSame('Renamed stand', $renamed['name']);
        $this->assertDatabaseHas('city_vehicle_types', ['id' => $vehicle, 'vehicle_set_id' => $created['vehicle_set_ids'][0]]);
        $this->postJson("/api/admin/cities/{$this->cityId}/route-groups", ['name' => 'Taken'])->assertCreated();
        $this->patchJson($url, ['name' => 'Taken'])->assertUnprocessable()->assertJsonValidationErrors('name');
        $this->patchJson($url, ['name' => ''])->assertUnprocessable()->assertJsonValidationErrors('name');
        $this->assertDatabaseHas('route_groups', ['id' => $created['id'], 'name' => 'Renamed stand']);
    }

    public function test_rename_preserves_binding_but_explicit_rebind_updates_it(): void
    {
        $v1 = $this->makeCityVehicleType($this->cityId);
        $v2 = $this->makeCityVehicleType($this->cityId);
        $groupId = $this->postJson("/api/admin/cities/{$this->cityId}/route-groups", [
            'name' => 'G', 'city_vehicle_type_id' => $v1,
        ])->json('route_group.id');

        // Rename / route-only save omits the field → binding is left intact.
        $this->patchJson("/api/admin/cities/{$this->cityId}/route-groups/{$groupId}", ['name' => 'G2'])
            ->assertOk()->assertJsonPath('route_group.city_vehicle_type_id', $v1);

        // Sending the field rebinds the group.
        $this->patchJson("/api/admin/cities/{$this->cityId}/route-groups/{$groupId}", [
            'name' => 'G2', 'city_vehicle_type_id' => $v2,
        ])->assertOk()->assertJsonPath('route_group.city_vehicle_type_id', $v2);
    }

    public function test_city_drivers_endpoint_lists_only_this_city(): void
    {
        $a = $this->makeDriver($this->cityId);
        $a->user()->update(['avatar_path' => 'avatars/driver.jpg']);
        $this->makeDriver($this->otherCityId);

        $res = $this->getJson("/api/admin/cities/{$this->cityId}/route-group-drivers");
        $res->assertOk();
        $res->assertJsonPath('data.0.avatar_url', url('/storage/avatars/driver.jpg'));
        $userIds = collect($res->json('data'))->pluck('user_id')->all();
        $this->assertContains($a->user_id, $userIds);
        $this->assertCount(1, $userIds);
    }
}
