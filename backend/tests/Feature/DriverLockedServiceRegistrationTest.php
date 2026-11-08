<?php

namespace Tests\Feature;

use App\Models\Driver;
use App\Models\City;
use App\Models\CityVehicleType;
use App\Models\ManagerRole;
use App\Models\Permission;
use App\Models\RouteGroup;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class DriverLockedServiceRegistrationTest extends TestCase
{
    use RefreshDatabase;

    public function test_driver_registration_requires_and_locks_service_choice(): void
    {
        $cityId = DB::table('cities')->insertGetId([
            'name' => 'Locked Service City',
            'country_code' => 'IN',
            'created_at' => now(),
            'updated_at' => now(),
        ]);
        $vehicleTypeId = DB::table('vehicle_types')->insertGetId([
            'name' => 'Sedan Locked Service',
            'sort_order' => 1,
            'is_active' => true,
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        $otherCity = City::create(['name' => 'Dummy second city', 'country_code' => 'IN']);
        $stands = collect(['Dummy stand A', 'Dummy stand B', 'Dummy stand C'])->map(
            fn ($name) => RouteGroup::create(['city_id' => $cityId, 'name' => $name, 'is_active' => true])
        );
        $foreignStand = RouteGroup::create(['city_id' => $otherCity->id, 'name' => 'Dummy foreign stand', 'is_active' => true]);
        $inactive = RouteGroup::create(['city_id' => $cityId, 'name' => 'Dummy inactive stand', 'is_active' => false]);
        $cityVehicle = CityVehicleType::create([
            'city_id' => $cityId, 'vehicle_type_id' => $vehicleTypeId, 'display_name' => 'Dummy sedan', 'is_active' => true,
        ]);
        $user = User::factory()->create(['name' => 'Dummy Signup Driver', 'dob' => '1990-05-15', 'address' => '123 Dummy Street']);
        Sanctum::actingAs($user, ['act-as:driver']);

        $this->getJson("/api/catalog/cities/{$cityId}/registration-stands")->assertOk()
            ->assertExactJson(['data' => $stands->map->only(['id', 'name'])->all()]);

        $payload = [
            'city_id' => $cityId,
            'vehicle_type_id' => $vehicleTypeId,
            'city_vehicle_type_id' => $cityVehicle->id,
            'vehicle_model' => '2023',
            'vehicle_color' => 'White',
            'vehicle_reg_no' => 'DUMMY-ONBOARD-01',
            'service_scope' => 'outstation',
            'service_mode' => 'shuttle',
            'stand_ids' => $stands->take(2)->pluck('id')->all(),
        ];
        $this->postJson('/api/drivers/register', [...$payload, 'city_ids' => [$cityId, $otherCity->id]])
            ->assertUnprocessable()->assertJsonValidationErrors('city_id');
        foreach ([[], [$stands[0]->id], $stands->pluck('id')->all(), [$stands[0]->id, $foreignStand->id], [$stands[0]->id, $inactive->id]] as $invalid) {
            $this->postJson('/api/drivers/register', [...$payload, 'stand_ids' => $invalid])
                ->assertUnprocessable()->assertJsonValidationErrors('stand_ids');
        }
        $this->postJson('/api/drivers/register', [...$payload, 'stand_ids' => [$stands[0]->id, $stands[0]->id]])
            ->assertUnprocessable()->assertJsonValidationErrors('stand_ids.0');
        $this->postJson('/api/drivers/register', [...$payload, 'service_scope' => null])
            ->assertUnprocessable()->assertJsonPath('message', 'Choose the service area before continuing.');
        $this->assertDatabaseMissing('drivers', ['user_id' => $user->id]);

        $this->postJson('/api/drivers/register', $payload)->assertOk()
            ->assertJsonPath('driver.approval_status', 'pending')
            ->assertJsonPath('driver.service_scope', 'outstation')
            ->assertJsonPath('driver.service_mode', 'shuttle');

        $driver = Driver::query()->where('user_id', $user->id)->firstOrFail();
        $this->assertSame([$cityId], $driver->city_ids);
        $role = ManagerRole::create(['slug' => 'dummy_driver_manager', 'name' => 'Dummy Driver Manager']);
        $role->permissions()->attach(Permission::firstOrCreate(['slug' => 'drivers'], ['name' => 'Drivers']));
        $admin = User::factory()->create(['manager_role_id' => $role->id, 'manager_all_cities' => true]);
        $admin->addRole('admin');
        Sanctum::actingAs($admin, ['act-as:admin']);
        $assignments = "/api/admin/drivers/{$driver->id}/route-groups";
        $this->getJson($assignments)->assertOk()->assertJsonPath('assigned_group_ids', $payload['stand_ids']);
        $this->patchJson("/api/admin/drivers/{$driver->id}", ['city_ids' => [$cityId, $otherCity->id]])->assertOk();
        $adminStandIds = [$stands[0]->id, $stands[2]->id, $foreignStand->id];
        $this->putJson($assignments, ['group_ids' => $adminStandIds])->assertOk();

        Sanctum::actingAs($user, ['act-as:driver']);
        $this->postJson('/api/drivers/register', $payload)->assertOk();
        $this->assertEqualsCanonicalizing([$cityId, $otherCity->id], $driver->fresh()->city_ids);
        $this->assertEqualsCanonicalizing($adminStandIds, DB::table('driver_route_group')->where('driver_user_id', $user->id)->pluck('route_group_id')->all());

        $driver->forceFill(['approval_status' => 'approved'])->save();

        $this->postJson('/api/drivers/register', [
            'city_id' => $cityId,
            'vehicle_type_id' => $vehicleTypeId,
            'service_scope' => 'local',
            'service_mode' => 'private',
        ])->assertStatus(422)
            ->assertJsonPath('message', 'Ride type, vehicle type, and driver service are locked after approval. Contact the operator.');
    }
}
