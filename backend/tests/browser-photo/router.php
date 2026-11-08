<?php
if (!in_array($_SERVER['REMOTE_ADDR'] ?? '', ['127.0.0.1', '::1'], true)) { http_response_code(403); exit; }
$app = require __DIR__.'/bootstrap.php';
$app->instance(App\Services\PhoneOtpService::class, new class(new App\Services\Msg91Service) extends App\Services\PhoneOtpService {
    public function start(string $phone, ?string $platform = null, ?int $changeUserId = null): array {
        if (!in_array($phone, ['+12025550123', '+912025550123'], true) || $changeUserId !== null) return ['sent' => false];
        App\Models\PhoneOtp::updateOrCreate(['phone' => $phone], ['code_hash' => Illuminate\Support\Facades\Hash::make('123456'),
            'change_user_id' => null, 'attempts' => 0, 'expires_at' => now()->addMinutes(10), 'last_sent_at' => now()]);
        return ['sent' => true];
    }
});
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (str_starts_with($path, '/storage/')) {
    $root = realpath(storage_path('app/photo-browser-test'));
    $file = realpath(storage_path('app/photo-browser-test/'.substr($path, 9)));
    if (!$root || !$file || !str_starts_with($file, $root.DIRECTORY_SEPARATOR) || !is_file($file)) { http_response_code(404); exit; }
    header('Access-Control-Allow-Origin: *'); header('Content-Type: '.mime_content_type($file)); readfile($file); exit;
}
$request = Illuminate\Http\Request::capture();
$kernel = $app->make(Illuminate\Contracts\Http\Kernel::class);
$response = $kernel->handle($request); $response->send(); $kernel->terminate($request, $response);
