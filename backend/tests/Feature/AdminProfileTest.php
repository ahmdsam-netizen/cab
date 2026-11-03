<?php

namespace Tests\Feature;

use App\Models\ManagerRole;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Storage;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class AdminProfileTest extends TestCase
{
    use RefreshDatabase;

    private function createAdmin(array $overrides = []): User
    {
        $role = ManagerRole::query()->firstOrCreate(
            ['slug' => 'super_admin'],
            [
                'name' => 'Super Admin',
                'is_system' => true,
            ]
        );

        $admin = User::factory()->create(array_merge([
            'name' => 'Admin User',
            'email' => 'admin@dreamcabs.local',
            'phone' => '+919900112233',
            'password' => Hash::make('password123'),
            'manager_role_id' => $role->id,
            'manager_all_cities' => true,
        ], $overrides));
        $admin->addRole('admin');
        return $admin;
    }

    public function test_admin_me_returns_profile_shape_with_phone_and_avatar(): void
    {
        $admin = $this->createAdmin([
            'name' => 'Sarah Admin',
            'phone' => '+919876543210',
            'avatar_path' => 'avatars/sarah.jpg',
        ]);
        Sanctum::actingAs($admin, ['act-as:admin']);

        $res = $this->getJson('/api/admin/me');

        $res->assertStatus(200)
            ->assertJsonPath('user.name', 'Sarah Admin')
            ->assertJsonPath('user.email', $admin->email)
            ->assertJsonPath('user.phone', '+919876543210')
            ->assertJsonPath('user.is_super_admin', true)
            ->assertJsonPath('user.avatar_path', 'avatars/sarah.jpg');
    }

    public function test_admin_can_update_profile_details_and_photo(): void
    {
        Storage::fake('public');
        $admin = $this->createAdmin();
        Sanctum::actingAs($admin, ['act-as:admin']);

        $fakePhoto = UploadedFile::fake()->image('my-avatar.jpg', 200, 200);

        $res = $this->postJson('/api/admin/me/profile', [
            'name' => 'Updated Admin Name',
            'email' => 'updated-admin@dreamcabs.local',
            'phone' => '+919812345678',
            'photo' => $fakePhoto,
        ]);

        $res->assertStatus(200)
            ->assertJsonPath('message', 'Profile updated successfully.')
            ->assertJsonPath('user.name', 'Updated Admin Name')
            ->assertJsonPath('user.email', 'updated-admin@dreamcabs.local')
            ->assertJsonPath('user.phone', '+919812345678');

        $admin->refresh();
        $this->assertSame('Updated Admin Name', $admin->name);
        $this->assertSame('updated-admin@dreamcabs.local', $admin->email);
        $this->assertSame('+919812345678', $admin->phone);
        $this->assertNotNull($admin->avatar_path);
        Storage::disk('public')->assertExists($admin->avatar_path);
    }

    public function test_admin_can_remove_photo(): void
    {
        Storage::fake('public');
        $stored = UploadedFile::fake()->image('old.png')->store('avatars', 'public');
        $admin = $this->createAdmin(['avatar_path' => $stored]);
        Sanctum::actingAs($admin, ['act-as:admin']);

        $res = $this->postJson('/api/admin/me/profile', [
            'name' => $admin->name,
            'email' => $admin->email,
            'remove_photo' => true,
        ]);

        $res->assertStatus(200)
            ->assertJsonPath('user.avatar_path', null);

        $admin->refresh();
        $this->assertNull($admin->avatar_path);
        Storage::disk('public')->assertMissing($stored);
    }

    public function test_admin_can_change_password_with_valid_current_password(): void
    {
        $admin = $this->createAdmin(['password' => Hash::make('oldSecret123')]);
        Sanctum::actingAs($admin, ['act-as:admin']);

        $res = $this->postJson('/api/admin/me/password', [
            'current_password' => 'oldSecret123',
            'password' => 'newSecret456',
            'password_confirmation' => 'newSecret456',
        ]);

        $res->assertStatus(200)
            ->assertJsonPath('message', 'Password updated successfully.');

        $admin->refresh();
        $this->assertTrue(Hash::check('newSecret456', $admin->password));
    }

    public function test_admin_password_change_fails_if_current_password_is_incorrect(): void
    {
        $admin = $this->createAdmin(['password' => Hash::make('oldSecret123')]);
        Sanctum::actingAs($admin, ['act-as:admin']);

        $res = $this->postJson('/api/admin/me/password', [
            'current_password' => 'wrongPassword',
            'password' => 'newSecret456',
            'password_confirmation' => 'newSecret456',
        ]);

        $res->assertStatus(422)
            ->assertJsonValidationErrors(['current_password']);

        $admin->refresh();
        $this->assertTrue(Hash::check('oldSecret123', $admin->password));
    }
}
