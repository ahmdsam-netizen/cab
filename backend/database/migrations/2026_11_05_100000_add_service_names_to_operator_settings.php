<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('operator_settings', function (Blueprint $table) {
            $table->string('private_service_name', 40)->nullable();
            $table->string('fixed_service_name', 40)->nullable();
            $table->string('shuttle_service_name', 40)->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('operator_settings', function (Blueprint $table) {
            $table->dropColumn(['private_service_name', 'fixed_service_name', 'shuttle_service_name']);
        });
    }
};
