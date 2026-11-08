<?php

namespace App\Http\Controllers\Admin;

use App\Models\Driver;
use App\Models\CityVehicleType;
use App\Models\Route;
use App\Models\RouteGroup;
use App\Services\DriverRouteAccessService;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * Admin assignment of Route Groups to a driver, plus the resolved "effective
 * routes" read. Assignment is keyed on the driver's USER id (driver_route_group
 * .driver_user_id) to stay consistent with route_departures.driver_id — the
 * fixed flow identifies a driver by user id. A driver's effective fixed routes
 * are the union of the routes in the groups assigned here (see
 * DriverRouteAccessService); the vehicle plays no part.
 */
class AdminDriverRouteGroupsController
{
    public function __construct(private readonly DriverRouteAccessService $access) {}

    public function index(Driver $driver)
    {
        $cityIds = $driver->city_ids;
        $setIds = CityVehicleType::query()->whereIn('city_id', $cityIds)
            ->where(function ($query) use ($driver) {
                $query->where('id', $driver->city_vehicle_type_id ?? 0);
                if ($driver->vehicle_type_id) $query->orWhere('vehicle_type_id', $driver->vehicle_type_id);
            })->whereNotNull('vehicle_set_id')->pluck('vehicle_set_id')->all();
        $groups = !empty($cityIds)
            ? RouteGroup::query()->whereIn('city_id', $cityIds)->with(['city:id,name', 'vehicleSets:id,name'])->orderBy('name')->get(['id', 'city_id', 'name', 'is_active'])
            : collect();

        return response()->json([
            'assigned_group_ids' => $this->assignedGroupIds($driver),
            'groups' => $groups->map(fn (RouteGroup $g) => [
                'id' => $g->id,
                'name' => $g->name,
                'city_id' => $g->city_id,
                'city_name' => $g->city?->name,
                'is_active' => (bool) $g->is_active,
                'vehicle_set_names' => $g->vehicleSets->pluck('name')->values(),
                'matches_vehicle_set' => $g->vehicleSets->contains(fn ($set) => in_array($set->id, $setIds)),
            ])->values(),
            'effective_routes' => $this->effectiveRoutesPayload($driver),
        ]);
    }

    public function sync(Request $request, Driver $driver)
    {
        $data = $request->validate([
            'group_ids' => ['present', 'array'],
            'group_ids.*' => ['integer'],
        ]);

        $groupIds = array_values(array_unique(array_map('intval', $data['group_ids'])));

        $cityIds = $driver->city_ids;
        if ($groupIds) {
            $validCount = RouteGroup::query()
                ->whereIn('id', $groupIds)
                ->whereIn('city_id', $cityIds)
                ->count();
            if ($validCount !== count($groupIds)) {
                abort(422, "Some stands do not belong to this driver's registered cities.");
            }
        }

        DB::transaction(function () use ($driver, $groupIds) {
            DB::table('driver_route_group')->where('driver_user_id', $driver->user_id)->delete();
            foreach ($groupIds as $gid) {
                DB::table('driver_route_group')->insert([
                    'driver_user_id' => $driver->user_id,
                    'route_group_id' => $gid,
                    'created_at' => now(),
                    'updated_at' => now(),
                ]);
            }
        });

        return response()->json([
            'assigned_group_ids' => $groupIds,
            'effective_routes' => $this->effectiveRoutesPayload($driver),
            'message' => 'Driver stands updated.',
        ]);
    }

    public function effectiveRoutes(Driver $driver)
    {
        return response()->json(['data' => $this->effectiveRoutesPayload($driver)]);
    }

    /** @return int[] */
    private function assignedGroupIds(Driver $driver): array
    {
        return DB::table('driver_route_group')
            ->where('driver_user_id', $driver->user_id)
            ->pluck('route_group_id')
            ->map(fn ($id) => (int) $id)
            ->all();
    }

    private function effectiveRoutesPayload(Driver $driver): array
    {
        $ids = $this->access->effectiveRouteIds((int) $driver->user_id);
        if (empty($ids)) {
            return [];
        }

        return Route::query()
            ->whereIn('id', $ids)
            ->orderBy('name')
            ->get(['id', 'name', 'origin_name', 'dest_name', 'scope', 'is_active'])
            ->map(fn (Route $r) => [
                'id' => $r->id,
                'name' => $r->name,
                'origin_name' => $r->origin_name,
                'dest_name' => $r->dest_name,
                'scope' => $r->scope,
                'is_active' => (bool) $r->is_active,
            ])
            ->all();
    }
}
