<?php

namespace Tests\Feature;

use App\Models\{City, CityVehicleType, DepartureSeat, Driver, Route, RouteDeparture, RouteGroup, SeatReservation, ShuttleJourney, Trip, User, VehicleType};
use App\Services\{DriverRouteAccessService, FixedBookingService, FixedDepartureService};
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Laravel\Sanctum\Sanctum;
use Tests\Support\SeatLayoutFactory;
use Tests\TestCase;

/** Vehicle-change audit and active-work regression protection. Remaining mismatch tests document gaps. */
class DriverVehicleChangeAuditTest extends TestCase
{
    use RefreshDatabase;

    private User $admin;
    private User $driverUser;
    private Driver $driver;
    private Route $route;
    private RouteGroup $stand;
    private CityVehicleType $oldVehicle;
    private CityVehicleType $newVehicle;
    private int $oldLayout;
    private int $newLayout;

    protected function setUp(): void
    {
        parent::setUp();
        $city = City::create(['name' => 'Vehicle audit city', 'country_code' => 'IN']);
        $oldType = VehicleType::create(['name' => 'SUMO', 'is_active' => true]);
        $newType = VehicleType::create(['name' => 'INNOVA', 'is_active' => true]);
        $this->oldLayout = SeatLayoutFactory::standardErtiga6P($city->id, $oldType->id, 'SUMO six seats');
        $this->newLayout = SeatLayoutFactory::standardErtiga6P($city->id, $newType->id, 'INNOVA five seats');
        DB::table('vehicle_seat_layout_cells')->where('vehicle_seat_layout_id', $this->newLayout)->where('label', '3B')->delete();
        $base = ['city_id' => $city->id, 'is_active' => true, 'max_people' => 6, 'luggage_capacity' => 2];
        $this->oldVehicle = CityVehicleType::create($base + ['vehicle_type_id' => $oldType->id, 'display_name' => 'SUMO']);
        $this->newVehicle = CityVehicleType::create($base + ['vehicle_type_id' => $newType->id, 'display_name' => 'INNOVA']);
        $this->route = Route::create(['city_id' => $city->id, 'city_vehicle_type_id' => $this->oldVehicle->id,
            'scope' => 'local', 'mode' => 'fixed', 'name' => 'Audit route', 'origin_name' => 'A', 'dest_name' => 'B',
            'origin_lat' => 34, 'origin_lng' => 74, 'dest_lat' => 34.1, 'dest_lng' => 74.1,
            'fare_config' => ['seat_fare' => 100], 'is_active' => true]);
        $this->driverUser = User::factory()->create(); $this->driverUser->addRole('driver');
        $this->driver = Driver::create(['user_id' => $this->driverUser->id, 'city_id' => $city->id,
            'vehicle_type_id' => $oldType->id, 'city_vehicle_type_id' => $this->oldVehicle->id,
            'vehicle_type' => 'SUMO', 'vehicle_reg_no' => 'OLD123', 'vehicle_color' => 'White',
            'approval_status' => 'approved', 'service_scope' => 'local', 'service_mode' => 'fixed',
            'is_online' => true, 'last_online_at' => now()]);
        $this->driver->forceFill(['active_service_mode' => 'fixed', 'active_service_scope' => 'local'])->save();
        $this->stand = RouteGroup::create(['city_id' => $city->id, 'city_vehicle_type_id' => $this->oldVehicle->id, 'name' => 'SUMO stand', 'is_active' => true]);
        $this->stand->routes()->attach($this->route->id);
        $this->stand->drivers()->attach($this->driverUser->id);
        $this->admin = User::factory()->create(['manager_all_cities' => true]); $this->admin->addRole('admin');
        $role = DB::table('manager_roles')->insertGetId(['slug' => 'super_admin', 'name' => 'Super Admin', 'is_system' => true, 'created_at' => now(), 'updated_at' => now()]);
        $this->admin->forceFill(['manager_role_id' => $role])->save();
    }

    private function changeVehicle(array $extra = []): void
    {
        Sanctum::actingAs($this->admin, ['act-as:admin']);
        $this->patchJson('/api/admin/drivers/'.$this->driver->id, $extra + [
            'vehicle_type_id' => $this->newVehicle->vehicle_type_id,
            'city_vehicle_type_id' => $this->newVehicle->id,
            'vehicle_reg_no' => 'NEW456', 'vehicle_color' => 'Silver',
        ])->assertOk();
    }

    private function openDeparture(?int $layout = null): RouteDeparture
    {
        Sanctum::actingAs($this->driverUser, ['act-as:driver']);
        $response = $this->postJson('/api/fixed/driver/vehicles', array_filter([
            'route_id' => $this->route->id, 'vehicle_seat_layout_id' => $layout,
        ]))->assertCreated();
        return RouteDeparture::findOrFail($response->json('vehicle.id'));
    }

    public function test_vehicle_change_preserves_stand_routes_but_does_not_check_stand_vehicle(): void
    {
        $this->changeVehicle();
        $this->assertSame($this->oldVehicle->id, $this->stand->fresh()->city_vehicle_type_id);
        $this->assertSame([$this->route->id], app(DriverRouteAccessService::class)->effectiveRouteIds($this->driverUser->id));
        Sanctum::actingAs($this->driverUser, ['act-as:driver']);
        $this->getJson('/api/drivers/me')->assertOk()
            ->assertJsonPath('driver.city_vehicle_type_id', $this->newVehicle->id)
            ->assertJsonPath('driver.vehicle_type_id', $this->newVehicle->vehicle_type_id)
            ->assertJsonPath('driver.vehicle_reg_no', 'NEW456')
            ->assertJsonPath('driver.vehicle_type', 'SUMO'); // Legacy text is not synchronized.
        $this->getJson('/api/fixed/driver/routes')->assertOk()->assertJsonPath('data.0.id', $this->route->id);
        $this->getJson('/api/fixed/driver/routes/'.$this->route->id.'/layouts')->assertOk()->assertJsonPath('data.0.id', $this->newLayout);
    }

    public function test_new_default_departure_uses_current_vehicle_and_matching_layout(): void
    {
        $this->changeVehicle();
        $departure = $this->openDeparture();
        $this->assertSame($this->newVehicle->id, $departure->city_vehicle_type_id);
        $this->assertSame($this->newLayout, $departure->vehicle_seat_layout_id);
        $this->assertSame(5, $departure->capacity);
        $this->assertSame('INNOVA', $departure->vehicle_snapshot['vehicle_name']);
    }

    public function test_explicit_new_vehicle_layout_has_matching_capacity_and_vehicle_identity(): void
    {
        $this->changeVehicle();
        $departure = $this->openDeparture($this->newLayout);
        $this->assertSame($this->newLayout, $departure->vehicle_seat_layout_id);
        $this->assertSame(5, $departure->capacity);
        $this->assertSame($this->newVehicle->id, $departure->city_vehicle_type_id);
    }

    public function test_completed_departure_and_booking_keep_identity_after_later_profile_and_catalog_edits(): void
    {
        $departure = $this->openDeparture($this->oldLayout);
        $booking = SeatReservation::create(['route_departure_id' => $departure->id, 'route_id' => $this->route->id,
            'customer_id' => User::factory()->create()->id, 'seats' => 1, 'seat_labels' => ['1A'],
            'fare_amount' => 100, 'status' => 'COMPLETED', 'payment_status' => 'PAID', 'booking_channel' => 'advance']);
        $departure->update(['status' => 'COMPLETED']);
        $this->changeVehicle();
        $this->oldVehicle->update(['display_name' => 'Renamed catalogue vehicle']);
        $display = app(FixedDepartureService::class)->shapeCustomerDeparture($departure->fresh());
        $this->assertSame('SUMO', $display['vehicle_name']);
        $this->assertSame('OLD123', $display['vehicle_reg_no']);
        $this->assertSame('White', $display['vehicle_color']);
        $display = app(FixedBookingService::class)->shapeBooking($booking->fresh());
        $this->assertSame('SUMO', $display['vehicle_name']);
        $this->assertSame('OLD123', $display['vehicle']['reg_no']);
        $history = app(FixedBookingService::class)->myBookings(User::findOrFail($booking->customer_id));
        $this->assertSame('SUMO', $history['data'][0]['vehicle_name']);
        $this->assertSame('OLD123', $history['data'][0]['vehicle_reg_no']);
        $this->assertSame(6, $departure->fresh()->capacity);
        $this->assertSame(100.0, $booking->fresh()->fare_amount);
    }

    public function test_missing_vehicle_layout_blocks_open_and_does_not_create_departure(): void
    {
        $this->changeVehicle();
        DB::table('vehicle_seat_layouts')->where('id', $this->newLayout)->update(['is_active' => false]);
        Sanctum::actingAs($this->driverUser, ['act-as:driver']);
        $this->postJson('/api/fixed/driver/vehicles', ['route_id' => $this->route->id])->assertStatus(422)
            ->assertJsonPath('message', 'No seat layout is configured for this vehicle. Contact the admin.');
        $this->assertSame(0, RouteDeparture::count());
    }

    public function test_open_rejects_inactive_layout_and_trip_uses_departure_vehicle(): void
    {
        $this->changeVehicle();
        Sanctum::actingAs($this->driverUser, ['act-as:driver']);
        $this->postJson('/api/fixed/driver/vehicles', ['route_id' => $this->route->id, 'vehicle_seat_layout_id' => $this->oldLayout])->assertStatus(422);
        DB::table('vehicle_seat_layouts')->where('id', $this->newLayout)->update(['is_active' => false]);
        $this->postJson('/api/fixed/driver/vehicles', ['route_id' => $this->route->id, 'vehicle_seat_layout_id' => $this->newLayout])->assertStatus(422);
        DB::table('vehicle_seat_layouts')->where('id', $this->newLayout)->update(['is_active' => true]);
        $departure = $this->openDeparture();
        $this->postJson('/api/fixed/departures/'.$departure->id.'/start')->assertOk();
        $trip = $departure->fresh()->trip;
        $this->assertNotNull($trip);
        $this->assertSame($this->newVehicle->id, $trip->city_vehicle_type_id);
    }

    public function test_admin_created_departure_with_driver_uses_same_vehicle_and_preserves_snapshot_on_updates(): void
    {
        $this->changeVehicle();
        $service = app(FixedDepartureService::class);
        $city = City::findOrFail($this->route->city_id);
        $departure = $service->createAdminDeparture($city, ['route_id' => $this->route->id, 'driver_id' => $this->driverUser->id]);
        $this->assertSame($this->newVehicle->id, $departure->city_vehicle_type_id);
        $this->assertSame(5, $departure->capacity);
        $updated = $service->updateAdminDeparture($city, $departure, ['visible_to_customers' => true]);
        $this->assertSame($this->newVehicle->id, $updated->city_vehicle_type_id);
        $this->assertSame($departure->vehicle_snapshot, $updated->vehicle_snapshot);
        $this->assertSame(5, DepartureSeat::where('route_departure_id', $departure->id)->whereNotNull('label')->count());
    }

    public function test_admin_cannot_change_vehicle_and_mode_during_active_booked_departure(): void
    {
        $departure = $this->openDeparture($this->oldLayout);
        $booking = SeatReservation::create(['route_departure_id' => $departure->id, 'route_id' => $this->route->id,
            'customer_id' => User::factory()->create()->id, 'seats' => 1, 'seat_labels' => ['1A'],
            'fare_amount' => 100, 'status' => 'BOOKED', 'payment_status' => 'PAID', 'booking_channel' => 'advance']);
        $seats = DepartureSeat::where('route_departure_id', $departure->id)->get()->toArray();
        Sanctum::actingAs($this->admin, ['act-as:admin']);
        $originalName = $this->driverUser->name;
        $this->patchJson('/api/admin/drivers/'.$this->driver->id, [
            'service_mode' => 'private', 'city_vehicle_type_id' => $this->newVehicle->id,
            'vehicle_type_id' => $this->newVehicle->vehicle_type_id, 'vehicle_reg_no' => 'NEW456',
            'name' => 'Must not partially save',
        ])->assertStatus(422)->assertJsonPath('message', 'Complete or close the current ride/departure before changing this driver’s vehicle.');
        $this->assertSame('fixed', $this->driver->fresh()->active_service_mode);
        $this->assertSame($this->oldVehicle->id, $this->driver->fresh()->city_vehicle_type_id);
        $this->assertSame($originalName, $this->driverUser->fresh()->name);
        $this->assertNotContains($departure->fresh()->status, ['COMPLETED', 'CANCELLED']);
        $this->assertSame($this->oldLayout, $departure->fresh()->vehicle_seat_layout_id);
        $this->assertSame($seats, DepartureSeat::where('route_departure_id', $departure->id)->get()->toArray());
        $this->assertSame(['1A'], $booking->fresh()->seat_labels);
        $this->assertSame(100.0, $booking->fresh()->fare_amount);
        $display = app(FixedDepartureService::class)->shapeCustomerDeparture($departure->fresh());
        $this->assertSame('SUMO', $display['vehicle_name']);
        $this->assertSame('OLD123', $display['vehicle_reg_no']);
        $this->assertSame('White', $display['vehicle_color']);
    }

    public function test_empty_open_departure_blocks_changes_but_allows_unchanged_vehicle_and_personal_edits(): void
    {
        $departure = $this->openDeparture($this->oldLayout);
        Sanctum::actingAs($this->admin, ['act-as:admin']);
        foreach ([['vehicle_reg_no' => 'NEW456'], ['vehicle_color' => 'Red'], ['service_mode' => 'shuttle']] as $payload) {
            $this->patchJson('/api/admin/drivers/'.$this->driver->id, $payload)->assertStatus(422);
        }
        $this->patchJson('/api/admin/drivers/'.$this->driver->id, [
            'name' => 'Personal edit allowed', 'vehicle_reg_no' => 'OLD123', 'vehicle_model' => '',
            'vehicle_type_id' => (string) $this->oldVehicle->vehicle_type_id,
            'city_vehicle_type_id' => (string) $this->oldVehicle->id, 'service_mode' => 'fixed',
        ])->assertOk();
        $this->assertSame('Personal edit allowed', $this->driverUser->fresh()->name);
        Sanctum::actingAs($this->driverUser, ['act-as:driver']);
        $this->postJson('/api/drivers/register', ['vehicle_reg_no' => 'APP999'])->assertStatus(422)
            ->assertJsonPath('message', 'Complete or close the current ride/departure before changing this driver’s vehicle.');
        $departure->update(['status' => 'CANCELLED']);
        $this->changeVehicle();
    }

    public function test_private_and_shuttle_assigned_trip_states_block_vehicle_changes_until_terminal(): void
    {
        foreach (['private', 'shuttle'] as $mode) {
            $rideId = DB::table('ride_types')->insertGetId(['name' => ucfirst($mode), 'mode' => $mode, 'created_at' => now(), 'updated_at' => now()]);
            $this->driver->refresh()->update(['service_mode' => $mode, 'city_vehicle_type_id' => $this->oldVehicle->id,
                'vehicle_type_id' => $this->oldVehicle->vehicle_type_id, 'vehicle_reg_no' => 'OLD123']);
            $trip = Trip::create(['customer_id' => User::factory()->create()->id, 'driver_id' => $this->driverUser->id,
                'city_id' => $this->route->city_id, 'scope' => 'local', 'city_vehicle_type_id' => $this->oldVehicle->id, 'ride_type_id' => $rideId,
                'status' => 'ASSIGNED', 'pickup_address' => 'A', 'drop_address' => 'B',
                'pickup_lat' => 34, 'pickup_lng' => 74, 'drop_lat' => 34.1, 'drop_lng' => 74.1,
                'estimated_fare' => 100, 'currency' => 'INR']);
            Sanctum::actingAs($this->admin, ['act-as:admin']);
            foreach (array_unique(array_merge(['NEGOTIATION'], Trip::DRIVER_BUSY_STATUSES)) as $status) {
                $trip->update(['status' => $status]);
                $this->patchJson('/api/admin/drivers/'.$this->driver->id, ['vehicle_reg_no' => 'NEW456'])->assertStatus(422);
                $this->assertSame('OLD123', $this->driver->fresh()->vehicle_reg_no);
            }
            $trip->update(['status' => $mode === 'private' ? 'COMPLETED' : 'CANCELLED']);
            $this->changeVehicle();
        }
    }

    public function test_assigned_shuttle_journey_is_protected_even_without_a_linked_trip(): void
    {
        $journey = ShuttleJourney::create(['city_id' => $this->route->city_id,
            'city_vehicle_type_id' => $this->oldVehicle->id, 'driver_id' => $this->driverUser->id,
            'status' => 'IN_PROGRESS', 'capacity' => 6, 'seats_taken' => 1]);
        Sanctum::actingAs($this->admin, ['act-as:admin']);
        $this->patchJson('/api/admin/drivers/'.$this->driver->id, ['vehicle_reg_no' => 'NEW456'])->assertStatus(422);
        $journey->update(['status' => 'COMPLETED']);
        $this->changeVehicle();
    }
}
