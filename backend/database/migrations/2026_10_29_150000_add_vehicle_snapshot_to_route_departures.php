<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        Schema::table('route_departures', fn (Blueprint $table) => $table->json('vehicle_snapshot')->nullable());
    }

    public function down(): void
    {
        Schema::table('route_departures', fn (Blueprint $table) => $table->dropColumn('vehicle_snapshot'));
    }
};
