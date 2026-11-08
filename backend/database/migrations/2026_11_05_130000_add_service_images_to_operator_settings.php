<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('operator_settings', function (Blueprint $table) {
            $table->string('private_service_image_path')->nullable();
            $table->string('fixed_service_image_path')->nullable();
            $table->string('shuttle_service_image_path')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('operator_settings', function (Blueprint $table) {
            $table->dropColumn(['private_service_image_path', 'fixed_service_image_path', 'shuttle_service_image_path']);
        });
    }
};
