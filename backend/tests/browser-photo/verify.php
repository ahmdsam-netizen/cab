<?php
require __DIR__.'/bootstrap.php';
$user = App\Models\User::where('email', 'dummy-photo-driver@example.test')->first();
$driver = $user ? App\Models\Driver::where('user_id', $user->id)->first() : null;
$exists = $user?->avatar_path && Illuminate\Support\Facades\Storage::disk('public')->exists($user->avatar_path);
$fixture = dirname(__DIR__, 3).'/docs/test-assets/'.(in_array('--draft', $argv ?? [], true) ? 'driver-photo-draft.png' : 'driver-photo-test.png');
$matches = $exists && hash_file('sha256', $fixture) === hash_file('sha256', Illuminate\Support\Facades\Storage::disk('public')->path($user->avatar_path));
echo json_encode(['database' => Illuminate\Support\Facades\DB::connection()->getDatabaseName(),
    'dummy_user_created' => (bool) $user, 'driver_created' => (bool) $driver,
    'approval_status' => $driver?->approval_status, 'photo_stored' => (bool) $exists,
    'stored_photo_matches_fixture' => $matches], JSON_PRETTY_PRINT).PHP_EOL;
