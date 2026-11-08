<?php

namespace App\Services;

use App\Models\Driver;
use App\Models\RouteDeparture;
use App\Models\Trip;
use App\Models\ShuttleJourney;
use Illuminate\Validation\ValidationException;

class DriverServiceModeService
{
    public function assertVehicleChangeAllowed(Driver $driver, array $data): void
    {
        $fields = ['ride_type_id', 'vehicle_type_id', 'city_vehicle_type_id',
            'vehicle_reg_no', 'vehicle_brand', 'vehicle_model', 'vehicle_color', 'service_mode'];
        $changed = false;
        foreach ($fields as $field) {
            if (!array_key_exists($field, $data)) continue;
            $before = $driver->getAttribute($field);
            $after = $data[$field];
            // Form resubmissions include unchanged numeric IDs and empty nullable text.
            $normalize = str_ends_with($field, '_id')
                ? fn ($value) => $value === null || $value === '' ? null : (int) $value
                : fn ($value) => $value === null || $value === '' ? null : (string) $value;
            if ($normalize($before) !== $normalize($after)) { $changed = true; break; }
        }
        if (!$changed) return;

        if ($this->hasActiveFixedVehicle($driver) || $this->hasActivePrivateTrip($driver)
            || ShuttleJourney::query()->where('driver_id', $driver->user_id)
                ->whereNotIn('status', ['COMPLETED', 'CANCELLED'])->exists()) {
            abort(422, 'Complete or close the current ride/departure before changing this driver’s vehicle.');
        }
    }

    public function setMode(Driver $driver, ?string $mode, ?string $scope = null): Driver
    {
        if ($mode !== null && !in_array($mode, Driver::SERVICE_MODES, true)) {
            throw ValidationException::withMessages([
                'mode' => 'Unsupported driver service mode.',
            ]);
        }

        if ($scope !== null && !in_array($scope, Driver::SERVICE_SCOPES, true)) {
            throw ValidationException::withMessages([
                'scope' => 'Unsupported driver service scope.',
            ]);
        }

        if (!$driver->is_online) {
            throw ValidationException::withMessages([
                'mode' => 'Go online before choosing a service mode.',
            ]);
        }

        if ($mode !== null && (!$driver->service_scope || !$driver->service_mode)) {
            throw ValidationException::withMessages([
                'mode' => 'Choose your permanent driver service before going online.',
            ]);
        }

        $requestedScope = $scope ?? $driver->service_scope;
        $scopeAllowed = ($driver->service_scope === Driver::SERVICE_SCOPE_BOTH)
            ? in_array($requestedScope, [Driver::SERVICE_SCOPE_LOCAL, Driver::SERVICE_SCOPE_OUTSTATION, Driver::SERVICE_SCOPE_BOTH], true)
            : ($requestedScope === $driver->service_scope);

        if ($mode !== null && ($mode !== $driver->service_mode || !$scopeAllowed)) {
            throw ValidationException::withMessages([
                'mode' => 'Your driver service is locked from registration. Contact the operator to change it.',
            ]);
        }

        if ($mode === Driver::SERVICE_MODE_PRIVATE || $mode === Driver::SERVICE_MODE_SHUTTLE) {
            $this->assertNoActiveFixedVehicle($driver);
        }

        if ($mode === Driver::SERVICE_MODE_FIXED) {
            $this->assertNoActivePrivateTrip($driver);
        }

        if ($mode === null) {
            $this->assertNoActivePrivateTrip($driver);
            $this->assertNoActiveFixedVehicle($driver);
        }

        $driver->active_service_scope = $mode === null ? null : ($scope ?? $driver->service_scope);
        $driver->active_service_mode = $mode;
        $driver->save();

        return $driver->fresh();
    }

    public function assertPrivateMode(Driver $driver): void
    {
        if ($driver->active_service_mode !== Driver::SERVICE_MODE_PRIVATE) {
            abort(422, 'Choose private ride mode before accepting private rides.');
        }
    }

    public function assertFixedMode(Driver $driver, ?string $scope = null): void
    {
        if ($driver->active_service_mode !== Driver::SERVICE_MODE_FIXED) {
            abort(422, 'Choose your registered fixed service before opening this fixed vehicle.');
        }

        if ($scope !== null && !$driver->providesBoth() && $driver->service_scope !== $scope) {
            abort(422, 'This route is ' . $scope . ' but your service is ' . $driver->service_scope . '.');
        }

        $this->assertNoActivePrivateTrip($driver);
    }

    public function hasActivePrivateTrip(Driver $driver): bool
    {
        return Trip::query()
            ->where('driver_id', $driver->user_id)
            ->whereNull('route_departure_id')
            ->whereIn('status', $this->privateBlockingStatuses())
            ->exists();
    }

    public function hasActiveFixedVehicle(Driver $driver): bool
    {
        return RouteDeparture::query()
            ->where('driver_id', $driver->user_id)
            ->whereHas('route', fn ($q) => $q->where('mode', 'fixed'))
            ->whereNotIn('status', ['COMPLETED', 'CANCELLED'])
            ->exists();
    }

    private function assertNoActivePrivateTrip(Driver $driver): void
    {
        if ($this->hasActivePrivateTrip($driver)) {
            abort(422, 'Complete your private ride before opening a fixed vehicle.');
        }
    }

    private function assertNoActiveFixedVehicle(Driver $driver): void
    {
        if ($this->hasActiveFixedVehicle($driver)) {
            abort(422, 'Complete or close your fixed vehicle before changing ride mode.');
        }
    }

    private function privateBlockingStatuses(): array
    {
        return array_values(array_unique(array_merge(
            ['NEGOTIATION', 'CONFIRMED'],
            Trip::DRIVER_BUSY_STATUSES,
        )));
    }
}
