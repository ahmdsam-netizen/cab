<?php
$app = require __DIR__.'/bootstrap.php';
$connection = config('database.connections.photo_browser');
$pdo = new PDO('mysql:host='.$connection['host'].';port='.($connection['port'] ?? 3306), $connection['username'], $connection['password']);
$pdo->exec('CREATE DATABASE IF NOT EXISTS cab_photo_browser CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
Illuminate\Support\Facades\Artisan::call('migrate', ['--force' => true]);
$city = App\Models\City::firstOrCreate(['name' => 'Photo Test City'], ['country_code' => 'IN', 'is_active' => true]);
$ride = App\Models\RideType::firstOrCreate(['name' => 'Photo Test Fixed'], ['mode' => 'fixed', 'is_active_local' => true, 'is_active_outstation' => false]);
$type = App\Models\VehicleType::firstOrCreate(['name' => 'Photo Test SUMO'], ['is_active' => true]);
App\Models\CityVehicleType::firstOrCreate(['city_id' => $city->id, 'display_name' => 'Photo Test SUMO'], [
    'ride_type_id' => $ride->id, 'vehicle_type_id' => $type->id, 'max_people' => 6, 'luggage_capacity' => 2, 'is_active' => true]);
echo "Isolated photo test database and vehicle catalogue ready. No driver account pre-created.\n";
