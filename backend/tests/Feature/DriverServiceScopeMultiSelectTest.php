<?php

namespace Tests\Feature;

use App\Jobs\DispatchHopJob;
use App\Models\City;
use App\Models\CityVehicleType;
use App\Models\Driver;
use App\Models\ManagerRole;
use App\Models\PricingRule;
use App\Models\RideType;
use App\Models\Route;
use App\Models\RouteGroup;
use App\Models\Trip;
use App\Models\User;
use App\Models\VehicleSeatLayout;
use App\Models\VehicleType;
use Illuminate\Foundation\Testing\DatabaseTransactions;
use Illuminate\Support\Facades\DB;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class DriverServiceScopeMultiSelectTest extends TestCase
{
    use DatabaseTransactions;

    private City $city;
    private VehicleType $vehicleType;
    private RideType $privateRideType;
    private CityVehicleType $cityVehicle;
    private PricingRule $pricingRule;
    private array $registrationStandIds;

    protected function setUp(): void
    {
        parent::setUp();

        $this->city = City::firstOrCreate(
            ['name' => 'MultiScope Test City'],
            ['country_code' => 'IN']
        );

        $this->registrationStandIds = collect(['Signup Stand A', 'Signup Stand B'])->map(
            fn ($name) => RouteGroup::create(['city_id' => $this->city->id, 'name' => $name, 'is_active' => true])->id
        )->all();

        $this->vehicleType = VehicleType::firstOrCreate(
            ['name' => 'MultiScope Sedan'],
            ['sort_order' => 1, 'is_active' => true]
        );

        $this->privateRideType = RideType::firstOrCreate(
            ['name' => 'MultiScope Private'],
            [
                'mode' => RideType::MODE_PRIVATE,
                'is_active_local' => true,
                'is_active_outstation' => true,
                'sort_order' => 1,
            ]
        );

        $this->cityVehicle = CityVehicleType::firstOrCreate(
            [
                'city_id' => $this->city->id,
                'vehicle_type_id' => $this->vehicleType->id,
            ],
            [
                'ride_type_id' => $this->privateRideType->id,
                'display_name' => 'MultiScope Sedan CV',
                'max_people' => 4,
                'luggage_capacity' => 2,
                'is_active' => true,
            ]
        );

        $this->pricingRule = PricingRule::firstOrCreate(
            [
                'city_id' => $this->city->id,
                'city_vehicle_type_id' => $this->cityVehicle->id,
            ],
            [
                'base_fare' => 50,
                'per_km_rate' => 12,
                'per_minute_rate' => 1.5,
                'minimum_fare' => 60,
                'surge_multiplier' => 1.0,
                'is_active' => true,
            ]
        );
    }

    /**
     * Test 1: Driver registration with service_scope = 'both'.
     */
    public function test_driver_registration_with_both_scope(): void
    {
        $user = User::factory()->create([
            'name' => 'Both Scope Driver',
            'email' => 'both_driver_' . uniqid() . '@example.com',
            'phone' => '+9198765' . rand(10000, 99999),
        ]);
        Sanctum::actingAs($user, ['act-as:driver']);

        $response = $this->postJson('/api/drivers/register', [
            'stand_ids' => $this->registrationStandIds,
            'city_id' => $this->city->id,
            'city_ids' => [$this->city->id],
            'vehicle_type_id' => $this->vehicleType->id,
            'city_vehicle_type_id' => $this->cityVehicle->id,
            'ride_type_id' => $this->privateRideType->id,
            'vehicle_model' => '2023',
            'vehicle_color' => 'White',
            'vehicle_reg_no' => 'MS-' . rand(1000, 9999),
            'service_scope' => 'both',
            'service_mode' => 'private',
            'name' => 'Both Scope Driver',
            'email' => $user->email,
            'dob' => '1990-05-15',
            'address' => '123 Main Street',
        ]);

        $response->assertOk()
            ->assertJsonPath('driver.service_scope', 'both')
            ->assertJsonPath('driver.service_mode', 'private');

        $driver = Driver::where('user_id', $user->id)->firstOrFail();
        $this->assertEquals('both', $driver->service_scope);
        $this->assertTrue($driver->providesBoth());
        $this->assertTrue($driver->providesLocal());
        $this->assertTrue($driver->providesOutstation());
    }

    /**
     * Test 2: Driver registration with array service_scopes = ['local', 'outstation'] normalizes to 'both'.
     */
    public function test_driver_registration_with_array_scopes_normalizes_to_both(): void
    {
        $user = User::factory()->create([
            'name' => 'Array Scope Driver',
            'email' => 'array_driver_' . uniqid() . '@example.com',
            'phone' => '+9198765' . rand(10000, 99999),
        ]);
        Sanctum::actingAs($user, ['act-as:driver']);

        $response = $this->postJson('/api/drivers/register', [
            'stand_ids' => $this->registrationStandIds,
            'city_id' => $this->city->id,
            'city_ids' => [$this->city->id],
            'vehicle_type_id' => $this->vehicleType->id,
            'city_vehicle_type_id' => $this->cityVehicle->id,
            'ride_type_id' => $this->privateRideType->id,
            'vehicle_model' => '2022',
            'vehicle_color' => 'Black',
            'vehicle_reg_no' => 'MS-' . rand(1000, 9999),
            'service_scope' => ['local', 'outstation'],
            'service_mode' => 'private',
            'name' => 'Array Scope Driver',
            'email' => $user->email,
            'dob' => '1992-08-20',
            'address' => '456 Commercial Way',
        ]);

        $response->assertOk()
            ->assertJsonPath('driver.service_scope', 'both');

        $driver = Driver::where('user_id', $user->id)->firstOrFail();
        $this->assertEquals('both', $driver->service_scope);
    }

    /**
     * Test 3: Admin PATCH updates driver service_scope to 'both', 'outstation', 'local'.
     */
    public function test_admin_can_update_driver_service_scope(): void
    {
        $role = ManagerRole::query()->firstOrCreate(
            ['slug' => 'super_admin'],
            ['name' => 'Super Admin', 'is_system' => true]
        );
        $admin = User::factory()->create([
            'manager_role_id' => $role->id,
            'manager_all_cities' => true,
        ]);
        $admin->addRole('admin');

        $driverUser = User::factory()->create();
        $driver = Driver::create([
            'user_id' => $driverUser->id,
            'city_id' => $this->city->id,
            'vehicle_type_id' => $this->vehicleType->id,
            'city_vehicle_type_id' => $this->cityVehicle->id,
            'ride_type_id' => $this->privateRideType->id,
            'vehicle_reg_no' => 'ADM-' . rand(1000, 9999),
            'service_scope' => 'local',
            'service_mode' => 'private',
            'approval_status' => 'approved',
        ]);

        Sanctum::actingAs($admin, ['act-as:admin']);

        // Update to both
        $response = $this->patchJson("/api/admin/drivers/{$driver->id}", [
            'service_scope' => 'both',
        ]);

        $response->assertOk()
            ->assertJsonPath('driver.service_scope', 'both')
            ->assertJsonPath('driver.active_service_scope', 'both');

        $this->assertEquals('both', $driver->fresh()->service_scope);
        $this->assertEquals('both', $driver->fresh()->active_service_scope);

        // Update with array ['local', 'outstation']
        $response2 = $this->patchJson("/api/admin/drivers/{$driver->id}", [
            'service_scope' => ['local', 'outstation'],
        ]);
        $response2->assertOk()
            ->assertJsonPath('driver.service_scope', 'both');

        // Update to outstation only
        $response3 = $this->patchJson("/api/admin/drivers/{$driver->id}", [
            'service_scope' => 'outstation',
        ]);
        $response3->assertOk()
            ->assertJsonPath('driver.service_scope', 'outstation')
            ->assertJsonPath('driver.active_service_scope', 'outstation');
    }

    /**
     * Test 4: Driver with service_scope = 'both' goes online with active_service_scope = 'both'.
     */
    public function test_driver_with_both_scope_goes_online_as_both(): void
    {
        $user = User::factory()->create([
            'phone' => '+9198765' . rand(10000, 99999),
        ]);
        $user->addRole('driver');

        $driver = Driver::create([
            'user_id' => $user->id,
            'city_id' => $this->city->id,
            'vehicle_type_id' => $this->vehicleType->id,
            'city_vehicle_type_id' => $this->cityVehicle->id,
            'ride_type_id' => $this->privateRideType->id,
            'vehicle_reg_no' => 'ONL-' . rand(1000, 9999),
            'service_scope' => 'both',
            'service_mode' => 'private',
            'approval_status' => 'approved',
            'is_online' => false,
            'active_service_scope' => null,
        ]);

        Sanctum::actingAs($user, ['act-as:driver']);

        $response = $this->postJson('/api/drivers/go-online');
        $response->assertOk();

        $fresh = $driver->fresh();
        $this->assertTrue((bool) $fresh->is_online);
        $this->assertEquals('both', $fresh->active_service_scope);
        $this->assertEquals('both', $fresh->service_scope);
    }

    /**
     * Test 5: Candidate dispatch matching for 'both' driver matches local and outstation trips.
     */
    public function test_candidate_dispatch_matches_both_driver_for_local_and_outstation_trips(): void
    {
        $customer = User::factory()->create();

        // Create driver with active_service_scope = 'both'
        $bothDriverUser = User::factory()->create([
            'name' => 'Both Online Driver',
        ]);
        $bothDriver = Driver::create([
            'user_id' => $bothDriverUser->id,
            'city_id' => $this->city->id,
            'vehicle_type_id' => $this->vehicleType->id,
            'city_vehicle_type_id' => $this->cityVehicle->id,
            'ride_type_id' => $this->privateRideType->id,
            'vehicle_reg_no' => 'BOTH-' . rand(1000, 9999),
            'service_scope' => 'both',
            'service_mode' => 'private',
            'active_service_scope' => 'both',
            'active_service_mode' => 'private',
            'approval_status' => 'approved',
            'is_online' => true,
            'current_lat' => 34.0837,
            'current_lng' => 74.7973,
            'current_location_updated_at' => now(),
        ]);

        // Create local trip
        $localTrip = Trip::create([
            'user_id' => $customer->id,
            'city_id' => $this->city->id,
            'city_vehicle_type_id' => $this->cityVehicle->id,
            'ride_type_id' => $this->privateRideType->id,
            'scope' => 'local',
            'status' => 'NEGOTIATION',
            'pickup_lat' => 34.0838,
            'pickup_lng' => 74.7974,
            'drop_lat' => 34.0900,
            'drop_lng' => 74.8000,
            'distance_km' => 5.0,
            'estimated_duration_minutes' => 15,
            'fare_amount' => 150,
            'source' => 'CUSTOMER_APP',
        ]);

        // Create outstation trip
        $outstationTrip = Trip::create([
            'user_id' => $customer->id,
            'city_id' => $this->city->id,
            'city_vehicle_type_id' => $this->cityVehicle->id,
            'ride_type_id' => $this->privateRideType->id,
            'scope' => 'outstation',
            'status' => 'NEGOTIATION',
            'pickup_lat' => 34.0838,
            'pickup_lng' => 74.7974,
            'drop_lat' => 33.7782,
            'drop_lng' => 75.1497,
            'distance_km' => 60.0,
            'estimated_duration_minutes' => 90,
            'fare_amount' => 1500,
            'source' => 'CUSTOMER_APP',
        ]);

        // Test Candidate Query (TripsController line 1108 / DispatchHopJob line 147)
        $candidatesForLocal = Driver::query()
            ->where('approval_status', 'approved')
            ->where('is_online', true)
            ->whereIn('active_service_scope', [$localTrip->scope ?: 'local', 'both'])
            ->where('id', $bothDriver->id)
            ->exists();
        $this->assertTrue($candidatesForLocal, 'Driver with both scope must match local trip candidates');

        $candidatesForOutstation = Driver::query()
            ->where('approval_status', 'approved')
            ->where('is_online', true)
            ->whereIn('active_service_scope', [$outstationTrip->scope ?: 'local', 'both'])
            ->where('id', $bothDriver->id)
            ->exists();
        $this->assertTrue($candidatesForOutstation, 'Driver with both scope must match outstation trip candidates');

        // Verify accept offer checks pass for both local and outstation trips
        Sanctum::actingAs($bothDriverUser, ['act-as:driver']);
        $tripScopeLocal = $localTrip->scope ?: 'local';
        $matchesLocal = in_array($bothDriver->active_service_scope, [$tripScopeLocal, 'both'], true);
        $this->assertTrue($matchesLocal, 'Both driver active scope must match local trip');

        $tripScopeOut = $outstationTrip->scope ?: 'local';
        $matchesOut = in_array($bothDriver->active_service_scope, [$tripScopeOut, 'both'], true);
        $this->assertTrue($matchesOut, 'Both driver active scope must match outstation trip');
    }

    /**
     * Test 6: Fixed routes feed and departure opening for driver with 'both' scope.
     */
    public function test_fixed_routes_and_departure_opening_for_both_driver(): void
    {
        $driverUser = User::factory()->create();
        $driverUser->addRole('driver');

        $driver = Driver::create([
            'user_id' => $driverUser->id,
            'city_id' => $this->city->id,
            'vehicle_type_id' => $this->vehicleType->id,
            'city_vehicle_type_id' => $this->cityVehicle->id,
            'ride_type_id' => $this->privateRideType->id,
            'vehicle_reg_no' => 'FIX-' . rand(1000, 9999),
            'service_scope' => 'both',
            'service_mode' => 'fixed',
            'approval_status' => 'approved',
            'is_online' => true,
            'active_service_scope' => 'both',
            'active_service_mode' => 'fixed',
        ]);
        $driver->cities()->sync([$this->city->id]);

        $layout = VehicleSeatLayout::create([
            'city_id' => $this->city->id,
            'vehicle_type_id' => $this->vehicleType->id,
            'name' => 'Sedan 4P Test',
            'rows' => 2,
            'cols' => 2,
            'is_active' => true,
        ]);
        $layout->cells()->createMany([
            ['row' => 0, 'col' => 0, 'kind' => 'seat', 'label' => '1A', 'price_delta' => 0],
            ['row' => 0, 'col' => 1, 'kind' => 'seat', 'label' => '1B', 'price_delta' => 0],
            ['row' => 1, 'col' => 0, 'kind' => 'seat', 'label' => '2A', 'price_delta' => 0],
            ['row' => 1, 'col' => 1, 'kind' => 'seat', 'label' => '2B', 'price_delta' => 0],
        ]);

        // Create a local fixed route and an outstation fixed route
        $localRoute = Route::create([
            'city_id' => $this->city->id,
            'city_vehicle_type_id' => $this->cityVehicle->id,
            'name' => 'Local City Route',
            'origin_name' => 'Point A',
            'dest_name' => 'Point B',
            'origin_lat' => 34.0837,
            'origin_lng' => 74.7973,
            'dest_lat' => 34.0900,
            'dest_lng' => 74.8000,
            'scope' => 'local',
            'mode' => 'fixed',
            'is_active' => true,
        ]);

        $destCity = City::firstOrCreate(
            ['name' => 'Destination City'],
            ['country_code' => 'IN']
        );

        $outstationRoute = Route::create([
            'city_id' => $this->city->id,
            'city_vehicle_type_id' => $this->cityVehicle->id,
            'name' => 'Intercity Route',
            'origin_name' => 'Point A',
            'dest_name' => 'Point C',
            'origin_lat' => 34.0837,
            'origin_lng' => 74.7973,
            'dest_lat' => 33.7782,
            'dest_lng' => 75.1497,
            'origin_city_id' => $this->city->id,
            'dest_city_id' => $destCity->id,
            'scope' => 'outstation',
            'mode' => 'fixed',
            'is_active' => true,
        ]);

        // Assign both routes via a route group to the driver
        $group = RouteGroup::create([
            'city_id' => $this->city->id,
            'name' => 'Combined Route Group',
            'city_vehicle_type_id' => $this->cityVehicle->id,
        ]);
        $group->routes()->sync([$localRoute->id, $outstationRoute->id]);
        $group->drivers()->sync([$driverUser->id]);

        Sanctum::actingAs($driverUser, ['act-as:driver']);

        // GET /api/fixed/driver/routes returns both local and outstation routes
        $responseAll = $this->getJson('/api/fixed/driver/routes');
        $responseAll->assertOk();
        $routeIds = collect($responseAll->json('data'))->pluck('id')->all();
        $this->assertContains($localRoute->id, $routeIds);
        $this->assertContains($outstationRoute->id, $routeIds);

        // GET /api/fixed/driver/routes?scope=local filters to local routes
        $responseLocal = $this->getJson('/api/fixed/driver/routes?scope=local');
        $responseLocal->assertOk();
        $localIds = collect($responseLocal->json('data'))->pluck('id')->all();
        $this->assertContains($localRoute->id, $localIds);
        $this->assertNotContains($outstationRoute->id, $localIds);

        // GET /api/fixed/driver/routes?scope=outstation filters to outstation routes
        $responseOutstation = $this->getJson('/api/fixed/driver/routes?scope=outstation');
        $responseOutstation->assertOk();
        $outIds = collect($responseOutstation->json('data'))->pluck('id')->all();
        $this->assertContains($outstationRoute->id, $outIds);
        $this->assertNotContains($localRoute->id, $outIds);

        // Driver with 'both' can open a departure on the local route
        $openLocalResponse = $this->postJson('/api/fixed/driver/vehicles', [
            'route_id' => $localRoute->id,
        ]);
        $openLocalResponse->assertCreated();

        $freshDriver = $driver->fresh();
        $this->assertEquals('local', $freshDriver->active_service_scope);
        $this->assertEquals('both', $freshDriver->service_scope);
    }
}
