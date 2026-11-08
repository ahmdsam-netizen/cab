<?php

namespace App\Services;

use App\Models\{CityVehicleType, Driver, Route, RouteDeparture, VehicleSeatLayout};

class FixedDepartureVehicleService
{
    public const MISSING_LAYOUT = 'No seat layout is configured for this vehicle. Contact the admin.';

    public function prepare(Route $route, Driver $driver, ?int $layoutId = null): array
    {
        $driver->loadMissing('cityVehicleType', 'vehicleTypeRef');
        $typeId = $driver->vehicle_type_id ?: $driver->cityVehicleType?->vehicle_type_id;
        if (!$typeId) abort(422, 'No vehicle is assigned to your profile. Contact the admin.');
        $family = $driver->cityVehicleType?->display_name;
        $vehicles = CityVehicleType::query()->with('rideType', 'vehicleType')
            ->where('city_id', $route->city_id)->where('is_active', true)->where('vehicle_type_id', $typeId)
            ->when($family, fn ($query) => $query->whereRaw('LOWER(TRIM(display_name)) = ?', [mb_strtolower(trim($family))]))
            ->orderBy('id')->get()
            ->filter(fn ($vehicle) => !$vehicle->ride_type_id || $vehicle->rideType?->isFixed());
        $vehicle = $vehicles->firstWhere('id', $driver->city_vehicle_type_id)
            ?? $vehicles->first(fn ($vehicle) => $vehicle->rideType?->isFixed()) ?? $vehicles->first();
        if (!$vehicle) abort(422, 'Your vehicle is not configured for fixed routes in this city. Contact the admin.');

        $layouts = VehicleSeatLayout::query()->where('city_id', $route->city_id)
            ->where('vehicle_type_id', $typeId)->where('is_active', true)
            ->whereHas('cells', fn ($query) => $query->where('kind', 'seat'))
            ->withCount(['cells as seat_count' => fn ($query) => $query->where('kind', 'seat')]);
        if ($layoutId) $layouts->whereKey($layoutId);
        $layout = $layouts->orderBy('name')->orderBy('id')->first();
        if (!$layout) abort(422, $layoutId ? 'That seat layout is not available for your vehicle in this city.' : self::MISSING_LAYOUT);

        return [
            'city_vehicle_type_id' => $vehicle->id,
            'vehicle_seat_layout_id' => $layout->id,
            'capacity' => (int) $layout->seat_count,
            'vehicle_snapshot' => [
                'vehicle_name' => $vehicle->display_name,
                'vehicle_type_name' => $vehicle->vehicleType?->name,
                'vehicle_brand' => $driver->vehicle_brand,
                'vehicle_model' => $driver->vehicle_model,
                'vehicle_color' => $driver->vehicle_color,
                'vehicle_reg_no' => $driver->vehicle_reg_no,
            ],
        ];
    }

    /** Legacy departures keep their existing fallback; new ones never read live identity. */
    public function identity(RouteDeparture $departure): array
    {
        if (!array_key_exists('vehicle_snapshot', $departure->getAttributes())) {
            $departure->vehicle_snapshot = RouteDeparture::select('id', 'vehicle_snapshot')->find($departure->id)?->vehicle_snapshot;
        }
        if ($departure->vehicle_snapshot !== null) return $departure->vehicle_snapshot;
        $departure->loadMissing('cityVehicleType.vehicleType');
        $driver = $departure->driver_id ? Driver::with('cityVehicleType', 'vehicleTypeRef')->where('user_id', $departure->driver_id)->first() : null;
        return [
            'vehicle_name' => $departure->cityVehicleType?->display_name ?? $driver?->cityVehicleType?->display_name ?? $driver?->vehicle_type,
            'vehicle_type_name' => $departure->cityVehicleType?->vehicleType?->name ?? $driver?->vehicleTypeRef?->name ?? $driver?->vehicle_type,
            'vehicle_brand' => $driver?->vehicle_brand,
            'vehicle_model' => $driver?->vehicle_model,
            'vehicle_color' => $driver?->vehicle_color,
            'vehicle_reg_no' => $driver?->vehicle_reg_no,
        ];
    }
}
