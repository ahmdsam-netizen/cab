<?php

namespace Tests\Feature;

use App\Models\City;
use App\Models\CitySetting;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class SupportInfoCityScopeTest extends TestCase
{
    use RefreshDatabase;

    public function test_empty_missing_and_unknown_city_never_borrow_contacts(): void
    {
        Sanctum::actingAs(User::factory()->create());
        $other = City::create(['name' => 'Configured', 'country_code' => 'IN']);
        CitySetting::create(['city_id' => $other->id, 'emergency_no' => 'configured-emergency',
            'emergency_police_no' => 'configured-police', 'customer_support_no' => 'customer-line',
            'driver_support_no' => 'driver-line', 'support_email' => 'support@example.test']);
        $empty = City::create(['name' => 'Empty', 'country_code' => 'IN']);
        CitySetting::create(['city_id' => $empty->id]);
        $missing = City::create(['name' => 'Missing', 'country_code' => 'IN']);
        foreach (['?city_id='.$empty->id, '?city_id='.$missing->id, '?city_id=999999', ''] as $query) {
            $this->getJson('/api/support-info'.$query)->assertOk()
                ->assertJsonPath('emergency_no', null)->assertJsonPath('emergency_police_no', null)
                ->assertJsonPath('customer_support_no', null)->assertJsonPath('driver_support_no', null)
                ->assertJsonPath('support_email', null);
        }
        $this->getJson('/api/support-info?city_id='.$other->id)->assertOk()
            ->assertJsonPath('city_id', $other->id)->assertJsonPath('emergency_no', 'configured-emergency')
            ->assertJsonPath('emergency_police_no', 'configured-police');
    }

    public function test_missing_customer_number_is_not_replaced_with_driver_number(): void
    {
        Sanctum::actingAs(User::factory()->create());
        $city = City::create(['name' => 'Driver only', 'country_code' => 'IN']);
        CitySetting::create(['city_id' => $city->id, 'driver_support_no' => 'driver-line']);
        $this->getJson('/api/support-info?city_id='.$city->id)->assertOk()
            ->assertJsonPath('customer_support_no', null)->assertJsonPath('driver_support_no', 'driver-line');
    }
}
