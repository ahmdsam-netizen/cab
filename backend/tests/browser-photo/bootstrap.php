<?php
// Isolated manual browser fixture. Never referenced by production routes/providers.
require dirname(__DIR__, 2).'/vendor/autoload.php';
$app = require dirname(__DIR__, 2).'/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
$connection = config('database.connections.mysql');
if (!in_array($connection['host'] ?? '', ['127.0.0.1', 'localhost'], true)) throw new RuntimeException('Photo fixture requires a loopback database.');
$connection['database'] = 'cab_photo_browser';
config(['database.connections.photo_browser' => $connection, 'database.default' => 'photo_browser',
    'cache.default' => 'array', 'session.driver' => 'array', 'queue.default' => 'sync',
    'broadcasting.default' => 'null', 'services.msg91.authkey' => '',
    'filesystems.disks.public.root' => storage_path('app/photo-browser-test'),
    'filesystems.disks.public.url' => 'http://127.0.0.1:8001/storage']);
Illuminate\Support\Facades\DB::purge();
Illuminate\Support\Facades\Http::preventStrayRequests();
return $app;
