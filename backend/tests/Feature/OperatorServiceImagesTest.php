<?php

namespace Tests\Feature;

use App\Models\ManagerRole;
use App\Models\City;
use App\Models\OperatorSetting;
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

    public function test_customer_catalog_serves_a_cutout_for_existing_service_artwork(): void
    {
        Storage::fake('public');
        $disk = Storage::disk('public');
        $city = City::create(['name' => 'Tile test', 'country_code' => 'IN', 'is_active' => true]);
        RideType::create(['mode' => 'private', 'name' => 'Cutout test', 'is_active_local' => true]);
        $settings = OperatorSetting::instance();

        $image = imagecreatetruecolor(80, 60);
        $backdrop = 0xf8d7ad;
        imagefill($image, 0, 0, $backdrop);
        imagefilledrectangle($image, 20, 15, 60, 45, 0x235980);
        imagesetpixel($image, 40, 30, $backdrop); // The same color inside the artwork is retained.
        $original = $this->pngBytes($image);
        $path = 'service_images/existing.png';
        $disk->put($path, $original);
        $settings->private_service_image_path = $path;
        $settings->save();

        $product = $this->getJson("/api/pricing/cities/{$city->id}/products")
            ->assertOk()->json('scopes.0.modes.0');
        $this->assertSame($disk->url($path), $product['image_url']);
        $tile = $this->get($product['tile_image_url'])->assertOk()->assertHeader('Content-Type', 'image/png');
        $rendered = imagecreatefromstring($tile->getContent());
        $this->assertSame(127, imagecolorat($rendered, 0, 0) >> 24);
        $this->assertSame($backdrop, imagecolorat($rendered, 40, 30));
        $this->assertSame(0x235980, imagecolorat($rendered, 21, 16));
        $this->assertSame($original, $disk->get($path));

        // An upload with distinct colors at its edges should be served unchanged.
        imagefilledrectangle($image, 0, 0, 39, 59, 0x425927);
        $photo = $this->pngBytes($image);
        $replacement = 'service_images/replacement.png';
        $disk->put($replacement, $photo);
        $settings->private_service_image_path = $replacement;
        $settings->save();

        $newUrl = $this->getJson("/api/pricing/cities/{$city->id}/products")->assertOk()
            ->json('scopes.0.modes.0.tile_image_url');
        $this->assertNotSame($product['tile_image_url'], $newUrl);
        $this->get($product['tile_image_url'])->assertNotFound();
        $this->assertSame($photo, $this->get($newUrl)->assertOk()->streamedContent());
    }

    private function pngBytes(\GdImage $image): string
    {
        ob_start();
        try {
            imagepng($image);
            return ob_get_contents();
        } finally {
            ob_end_clean();
        }
    }

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
