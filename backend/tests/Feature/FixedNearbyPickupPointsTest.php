<?php

namespace Tests\Feature;

use App\Models\City;
use App\Models\Route;
use App\Models\RouteStop;
use App\Models\User;
use App\Services\FixedRouteService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class FixedNearbyPickupPointsTest extends TestCase
{
    use RefreshDatabase;

    public function test_customer_routes_calculates_nearby_pickup_stop_and_walking_distance(): void
    {
        $cityId = DB::table('cities')->insertGetId([
            'name' => 'Sopore',
            'country_code' => 'IN',
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        $route = Route::query()->create([
            'city_id' => $cityId,
            'scope' => 'local',
            'mode' => 'fixed',
            'name' => 'Sopore to Baramulla Corridor',
            'origin_name' => 'Sopore Stand',
            'dest_name' => 'Baramulla Stand',
            'origin_lat' => 34.2980,
            'origin_lng' => 74.4680,
            'dest_lat' => 34.2050,
            'dest_lng' => 74.3450,
            'booking_window_hours' => 6,
            'waiting_time_per_stop_minutes' => 5,
            'luggage_surcharge_amount' => 30,
            'max_luggage_per_vehicle' => 4,
            'is_active' => true,
            'fare_config' => ['seat_fare' => 80],
        ]);

        // Stop 1: Sopore Stand (close to user: user is at 34.2990, 74.4690 ~140m away)
        RouteStop::query()->create([
            'route_id' => $route->id,
            'seq' => 1,
            'name' => 'Sopore Main Stand',
            'lat' => 34.2980,
            'lng' => 74.4680,
            'is_pickup' => true,
            'is_drop' => false,
            'is_active' => true,
            'is_temporarily_unavailable' => false,
        ]);

        // Stop 2: Sangrama Junction (~5.5km away)
        RouteStop::query()->create([
            'route_id' => $route->id,
            'seq' => 2,
            'name' => 'Sangrama Junction',
            'lat' => 34.2500,
            'lng' => 74.4200,
            'is_pickup' => true,
            'is_drop' => true,
            'is_active' => true,
            'is_temporarily_unavailable' => false,
        ]);

        // Stop 3: Baramulla Stand (drop only)
        RouteStop::query()->create([
            'route_id' => $route->id,
            'seq' => 3,
            'name' => 'Baramulla Stand',
            'lat' => 34.2050,
            'lng' => 74.3450,
            'is_pickup' => false,
            'is_drop' => true,
            'is_active' => true,
            'is_temporarily_unavailable' => false,
        ]);

        $customer = User::factory()->create();
        $customer->addRole('customer');
        Sanctum::actingAs($customer, ['act-as:customer']);

        // Query with customer coordinates near Stop 1
        $response = $this->getJson("/api/fixed/routes?city_id={$cityId}&lat=34.2990&lng=74.4690")
            ->assertOk();

        $data = $response->json('data');
        $this->assertNotEmpty($data);

        $firstRoute = $data[0];
        $this->assertNotNull($firstRoute['nearest_pickup_stop']);
        $this->assertSame('Sopore Main Stand', $firstRoute['nearest_pickup_stop']['name']);
        $this->assertLessThan(300, $firstRoute['nearest_pickup_stop']['distance_meters']);
        $this->assertGreaterThan(50, $firstRoute['nearest_pickup_stop']['distance_meters']);
        $this->assertGreaterThanOrEqual(1, $firstRoute['nearest_pickup_stop']['walk_minutes']);

        // Check stops list annotations
        $stops = $firstRoute['stops'];
        $this->assertCount(3, $stops);

        $soporeStop = collect($stops)->firstWhere('name', 'Sopore Main Stand');
        $this->assertTrue($soporeStop['is_nearest_pickup']);
        $this->assertNotNull($soporeStop['distance_meters']);
        $this->assertNotNull($soporeStop['walk_minutes']);

        $sangramaStop = collect($stops)->firstWhere('name', 'Sangrama Junction');
        $this->assertFalse($sangramaStop['is_nearest_pickup']);
        $this->assertGreaterThan(4000, $sangramaStop['distance_meters']);
    }

    public function test_customer_routes_without_coordinates_returns_null_proximity_gracefully(): void
    {
        $cityId = DB::table('cities')->insertGetId([
            'name' => 'Sopore',
            'country_code' => 'IN',
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        $route = Route::query()->create([
            'city_id' => $cityId,
            'scope' => 'local',
            'mode' => 'fixed',
            'name' => 'Sopore to Kupwara Corridor',
            'origin_name' => 'Sopore Stand',
            'dest_name' => 'Kupwara Stand',
            'origin_lat' => 34.2980,
            'origin_lng' => 74.4680,
            'dest_lat' => 34.5260,
            'dest_lng' => 74.2540,
            'booking_window_hours' => 6,
            'waiting_time_per_stop_minutes' => 5,
            'luggage_surcharge_amount' => 30,
            'max_luggage_per_vehicle' => 4,
            'is_active' => true,
            'fare_config' => ['seat_fare' => 90],
        ]);

        RouteStop::query()->create([
            'route_id' => $route->id,
            'seq' => 1,
            'name' => 'Sopore Main Stand',
            'lat' => 34.2980,
            'lng' => 74.4680,
            'is_pickup' => true,
            'is_drop' => false,
            'is_active' => true,
            'is_temporarily_unavailable' => false,
        ]);

        RouteStop::query()->create([
            'route_id' => $route->id,
            'seq' => 2,
            'name' => 'Kupwara Stand',
            'lat' => 34.5260,
            'lng' => 74.2540,
            'is_pickup' => false,
            'is_drop' => true,
            'is_active' => true,
            'is_temporarily_unavailable' => false,
        ]);

        $customer = User::factory()->create();
        $customer->addRole('customer');
        Sanctum::actingAs($customer, ['act-as:customer']);

        // Query WITHOUT lat/lng
        $response = $this->getJson("/api/fixed/routes?city_id={$cityId}")
            ->assertOk();

        $data = $response->json('data');
        $this->assertNotEmpty($data);
        $firstRoute = $data[0];
        $this->assertNull($firstRoute['nearest_pickup_stop']);
        $this->assertNull($firstRoute['distance_to_nearest_pickup']);
        $this->assertSame('Sopore Main Stand', $firstRoute['starting_stop']['name']);
        $this->assertNull($firstRoute['distance_to_start']);

        foreach ($firstRoute['stops'] as $stop) {
            $this->assertNull($stop['distance_meters']);
            $this->assertNull($stop['walk_minutes']);
            $this->assertFalse($stop['is_nearest_pickup']);
        }
    }

    public function test_customer_routes_prioritizes_first_stop_before_limiting_results(): void
    {
        $cityId = DB::table('cities')->insertGetId([
            'name' => 'Srinagar',
            'country_code' => 'IN',
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        // Route A: Originates far away in Anantnag (~50km)
        $routeFar = Route::query()->create([
            'city_id' => $cityId,
            'scope' => 'local',
            'mode' => 'fixed',
            'name' => 'Anantnag to Srinagar',
            'origin_name' => 'Anantnag Stand',
            'dest_name' => 'Lal Chowk',
            'origin_lat' => 33.7311,
            'origin_lng' => 75.1487,
            'dest_lat' => 34.0750,
            'dest_lng' => 74.8100,
            'booking_window_hours' => 6,
            'waiting_time_per_stop_minutes' => 5,
            'luggage_surcharge_amount' => 30,
            'max_luggage_per_vehicle' => 4,
            'is_active' => true,
            'sort_order' => 1, // Has lower sort order
            'fare_config' => ['seat_fare' => 150],
        ]);
        RouteStop::query()->create([
            'route_id' => $routeFar->id,
            'seq' => 1,
            'name' => 'Anantnag Bus Stand',
            'lat' => 33.7311,
            'lng' => 75.1487,
            'is_pickup' => true,
            'is_drop' => false,
            'is_active' => true,
            'is_temporarily_unavailable' => false,
        ]);
        RouteStop::query()->create([
            'route_id' => $routeFar->id,
            'seq' => 2,
            'name' => 'Lal Chowk',
            'lat' => 34.0755,
            'lng' => 74.8105,
            'is_pickup' => true,
            'is_drop' => true,
            'is_active' => true,
            'is_temporarily_unavailable' => false,
        ]);

        // Route B: Originates right in Srinagar near user (user is near Lal Chowk 34.0755, 74.8105)
        $routeNear = Route::query()->create([
            'city_id' => $cityId,
            'scope' => 'local',
            'mode' => 'fixed',
            'name' => 'Lal Chowk to Dal Lake Shuttle Corridor',
            'origin_name' => 'Lal Chowk',
            'dest_name' => 'Dal Lake Gate 1',
            'origin_lat' => 34.0750,
            'origin_lng' => 74.8100,
            'dest_lat' => 34.0880,
            'dest_lng' => 74.8300,
            'booking_window_hours' => 6,
            'waiting_time_per_stop_minutes' => 5,
            'luggage_surcharge_amount' => 20,
            'max_luggage_per_vehicle' => 4,
            'is_active' => true,
            'sort_order' => 2,
            'fare_config' => ['seat_fare' => 50],
        ]);
        RouteStop::query()->create([
            'route_id' => $routeNear->id,
            'seq' => 1,
            'name' => 'Lal Chowk Clock Tower',
            'lat' => 34.0750,
            'lng' => 74.8100,
            'is_pickup' => true,
            'is_drop' => false,
            'is_active' => true,
            'is_temporarily_unavailable' => false,
        ]);
        RouteStop::query()->create([
            'route_id' => $routeNear->id,
            'seq' => 2,
            'name' => 'Dal Gate',
            'lat' => 34.0880,
            'lng' => 74.8300,
            'is_pickup' => false,
            'is_drop' => true,
            'is_active' => true,
            'is_temporarily_unavailable' => false,
        ]);

        $customer = User::factory()->create();
        $customer->addRole('customer');
        Sanctum::actingAs($customer, ['act-as:customer']);

        // Route A passes closer to the user, but its starting stop is far away.
        $response = $this->getJson("/api/fixed/routes?city_id={$cityId}&lat=34.0755&lng=74.8105")
            ->assertOk();

        $data = $response->json('data');
        $this->assertCount(2, $data);

        // Even though Route Far had sort_order 1, Route Near must be ordered first because pickup is 70m away vs 50km
        $this->assertSame($routeNear->id, $data[0]['id']);
        $this->assertSame('Lal Chowk to Dal Lake Shuttle Corridor', $data[0]['name']);
        $this->assertSame($routeFar->id, $data[1]['id']);
        $this->assertSame('Anantnag Bus Stand', $data[1]['starting_stop']['name']);
        $this->assertSame('Lal Chowk', $data[1]['nearest_pickup_stop']['name']);
        $this->assertGreaterThan(1000, $data[1]['distance_to_start']);

        $limited = $this->getJson("/api/fixed/routes?city_id={$cityId}&lat=34.0755&lng=74.8105&limit=1")
            ->assertOk()->json('data');
        $this->assertCount(1, $limited);
        $this->assertSame($routeNear->id, $limited[0]['id']);
    }

    public function test_drop_only_and_unavailable_stops_are_not_selected_as_nearest_pickup(): void
    {
        $cityId = DB::table('cities')->insertGetId([
            'name' => 'Baramulla',
            'country_code' => 'IN',
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        $route = Route::query()->create([
            'city_id' => $cityId,
            'scope' => 'local',
            'mode' => 'fixed',
            'name' => 'Baramulla Route with Unavailable Stop',
            'origin_name' => 'Stand A',
            'dest_name' => 'Stand C',
            'origin_lat' => 34.2000,
            'origin_lng' => 74.3400,
            'dest_lat' => 34.2200,
            'dest_lng' => 74.3600,
            'booking_window_hours' => 6,
            'waiting_time_per_stop_minutes' => 5,
            'luggage_surcharge_amount' => 20,
            'max_luggage_per_vehicle' => 4,
            'is_active' => true,
            'fare_config' => ['seat_fare' => 60],
        ]);

        // User is at 34.2005, 74.3405 (~70m from Stop 1)
        // Stop 1: Very close to user, BUT is_temporarily_unavailable: true
        RouteStop::query()->create([
            'route_id' => $route->id,
            'seq' => 1,
            'name' => 'Close but Closed Stop',
            'lat' => 34.2000,
            'lng' => 74.3400,
            'is_pickup' => true,
            'is_drop' => false,
            'is_active' => true,
            'is_temporarily_unavailable' => true,
            'unavailable_reason' => 'Road construction',
        ]);

        // Stop 2: Further away (~1.5km), is_pickup: true and ACTIVE
        RouteStop::query()->create([
            'route_id' => $route->id,
            'seq' => 2,
            'name' => 'Open Pickup Stop',
            'lat' => 34.2120,
            'lng' => 74.3520,
            'is_pickup' => true,
            'is_drop' => true,
            'is_active' => true,
            'is_temporarily_unavailable' => false,
        ]);

        // Stop 3: Destination
        RouteStop::query()->create([
            'route_id' => $route->id,
            'seq' => 3,
            'name' => 'Destination Stand',
            'lat' => 34.2200,
            'lng' => 74.3600,
            'is_pickup' => false,
            'is_drop' => true,
            'is_active' => true,
            'is_temporarily_unavailable' => false,
        ]);

        $customer = User::factory()->create();
        $customer->addRole('customer');
        Sanctum::actingAs($customer, ['act-as:customer']);

        $response = $this->getJson("/api/fixed/routes?city_id={$cityId}&lat=34.2005&lng=74.3405")
            ->assertOk();

        $data = $response->json('data');
        $firstRoute = $data[0];

        // Should NOT pick the unavailable stop even though it's 70m away
        $this->assertNotNull($firstRoute['nearest_pickup_stop']);
        $this->assertSame('Open Pickup Stop', $firstRoute['nearest_pickup_stop']['name']);
        $this->assertFalse($firstRoute['stops'][0]['is_nearest_pickup']);
        $this->assertTrue($firstRoute['stops'][1]['is_nearest_pickup']);
    }

    public function test_distance_meters_math_accuracy(): void
    {
        $service = app(FixedRouteService::class);

        // Coordinates from Srinagar Clock Tower to Dal Lake Gate 1 (~2.3 km)
        $lat1 = 34.0750;
        $lng1 = 74.8100;
        $lat2 = 34.0880;
        $lng2 = 74.8300;

        $distance = $service->calculateDistanceMeters($lat1, $lng1, $lat2, $lng2);

        $this->assertGreaterThan(2000, $distance);
        $this->assertLessThan(2600, $distance);
    }
}
