<?php

namespace Tests\Feature;

use App\Models\ManagerRole;
use App\Models\RideType;
use App\Models\User;
use App\Support\RideCatalog;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

class OperatorServiceImagesTest extends TestCase
{
    use RefreshDatabase;

    public function test_image_replacement_and_removal_apply_to_both_scopes(): void
    {
        Storage::fake('public');
        $disk = Storage::disk('public');
        $role = ManagerRole::create(['slug' => 'super_admin', 'name' => 'Super Admin', 'is_system' => true]);
        $admin = User::factory()->create(['manager_role_id' => $role->id, 'manager_all_cities' => true]);
        $admin->addRole('admin');
        $this->actingAs($admin);

        $rideType = RideType::create([
            'mode' => 'private',
            'name' => 'Private image test',
            'image_path' => 'legacy.png',
            'is_active_local' => true,
            'is_active_outstation' => true,
        ]);
        $disk->put('legacy.png', 'existing asset');

        $saved = $this->post('/api/admin/operator-settings', [
            '_method' => 'PATCH',
            'private_service_name' => 'Private Ride',
            'private_service_image' => UploadedFile::fake()->image('first.png'),
        ], ['Accept' => 'application/json'])->assertOk()->json('settings');
        $firstPath = $saved['private_service_image_path'];
        $disk->assertExists($firstPath);
        $this->getJson('/api/admin/operator-settings')->assertOk()
            ->assertJsonPath('settings.private_service_image_url', $saved['private_service_image_url']);

        foreach (RideCatalog::tree() as $scope) {
            $mode = collect($scope['modes'])->firstWhere('id', $rideType->id);
            $this->assertSame('Private Ride', $mode['display_name']);
            $this->assertSame($saved['private_service_image_url'], $mode['image_url']);
        }

        $replacement = $this->post('/api/admin/operator-settings', [
            '_method' => 'PATCH',
            'private_service_image' => UploadedFile::fake()->image('second.png'),
        ], ['Accept' => 'application/json'])->assertOk()->json('settings.private_service_image_path');
        $disk->assertExists($replacement);
        $disk->assertMissing($firstPath);

        $this->patchJson('/api/admin/operator-settings', ['private_remove_service_image' => true])
            ->assertOk()->assertJsonPath('settings.private_service_image_url', null);
        $disk->assertMissing($replacement);
        $disk->assertExists('legacy.png');
    }
}
