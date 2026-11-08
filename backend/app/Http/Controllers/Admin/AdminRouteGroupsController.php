<?php

namespace App\Http\Controllers\Admin;

use App\Models\City;
use App\Models\Driver;
use App\Models\Route;
use App\Models\RouteGroup;
use App\Models\CityVehicleType;
use App\Models\VehicleSet;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;

/**
 * Admin CRUD for Route Groups — the reusable bundles of fixed routes that drive
 * driver route allocation. A group is city-scoped and holds fixed routes
 * (many-to-many). Only mode='fixed' routes in the same city may be attached.
 */
class AdminRouteGroupsController
{
    public function setupBatch(Request $request, City $city)
    {
        $data = $request->validate(['names' => ['required', 'array', 'min:1', 'max:30'], 'names.*' => ['required', 'string', 'max:120', 'distinct:ignore_case']]);
        $groups = DB::transaction(function () use ($request, $city, $data) {
            $body = $request->except('names');
            $groups = [];
            foreach ($data['names'] as $name) {
                $body['name'] = trim($name);
                $response = $this->setup(new Request($body), $city);
                $group = $response->getData(true)['route_group'];
                $groups[] = $group;
                // All groups in this quick batch use the same fleet. Reuse the
                // first group's generated set instead of moving its vehicles.
                $body['vehicle_ids'] = [];
                $body['vehicle_set_ids'] = $group['vehicle_set_ids'];
            }
            return $groups;
        });
        return response()->json(['data' => $groups, 'message' => count($groups).' stands created.'], 201);
    }

    public function setup(Request $request, City $city, ?RouteGroup $routeGroup = null)
    {
        if ($routeGroup) $this->assertCityOwnsGroup($city, $routeGroup);
        $data = $this->validatePayload($request, $city, $routeGroup);
        $sharing = $request->validate([
            'driver_user_ids' => ['present', 'array'], 'driver_user_ids.*' => ['integer'],
            'vehicle_set_ids' => ['present', 'array'],
            'vehicle_set_ids.*' => ['integer', Rule::exists('vehicle_sets', 'id')->where('city_id', $city->id)],
            'vehicle_ids' => ['present', 'array'],
            'vehicle_ids.*' => ['integer', Rule::exists('city_vehicle_types', 'id')->where('city_id', $city->id)],
        ]);
        $routeIds = $this->validRouteIds($city, $data['route_ids'] ?? []);
        $driverIds = array_values(array_unique($sharing['driver_user_ids']));
        if ($driverIds && Driver::query()->forCity((int) $city->id)->whereIn('user_id', $driverIds)->count() !== count($driverIds)) {
            abort(422, 'Some drivers are not registered in this city.');
        }
        $isNew = $routeGroup === null;
        $group = DB::transaction(function () use ($city, $routeGroup, $data, $sharing, $routeIds, $driverIds) {
            $vehicleIds = array_values(array_unique($sharing['vehicle_ids']));
            $members = CityVehicleType::query()->whereIn('id', $vehicleIds)->lockForUpdate()->get();
            if ($members->contains(fn ($vehicle) => $vehicle->vehicle_set_id !== null)) {
                abort(422, 'A selected vehicle already belongs to a set. Select its existing vehicle set instead.');
            }
            $group = $routeGroup ?? new RouteGroup(['city_id' => $city->id]);
            $group->fill([
                'name' => trim($data['name']), 'is_active' => $data['is_active'] ?? true,
                'city_vehicle_type_id' => $data['city_vehicle_type_id'] ?? null,
            ])->save();
            $setIds = $sharing['vehicle_set_ids'];
            if ($vehicleIds) {
                // Build sharing as part of group setup, without moving members of other sets.
                $baseName = mb_substr($group->name, 0, 100).' vehicles';
                $setName = $baseName;
                for ($suffix = 2; VehicleSet::query()->where('city_id', $city->id)->where('name', $setName)->exists(); $suffix++) {
                    $setName = $baseName.' ('.$suffix.')';
                }
                $set = VehicleSet::query()->create(['city_id' => $city->id, 'name' => $setName, 'sort_order' => 0]);
                CityVehicleType::query()->whereIn('id', $vehicleIds)->update(['vehicle_set_id' => $set->id]);
                $setIds[] = $set->id;
            }
            $group->routes()->sync($routeIds);
            $group->drivers()->sync($driverIds);
            $group->vehicleSets()->sync(array_unique($setIds));
            return $group;
        });
        return response()->json(['route_group' => $this->shape($group->fresh(['routes', 'drivers', 'vehicleSets'])), 'message' => 'Stand setup saved.'], $isNew ? 201 : 200);
    }

    public function index(City $city)
    {
        $groups = RouteGroup::query()
            ->where('city_id', $city->id)
            ->with(['routes:id,name', 'drivers:id', 'vehicleSets:id,name'])
            ->orderBy('name')
            ->get();

        return response()->json(['data' => $groups->map(fn (RouteGroup $g) => $this->shape($g))->values()]);
    }

    public function store(Request $request, City $city)
    {
        $data = $this->validatePayload($request, $city, null);
        $routeIds = array_key_exists('route_ids', $data) ? $this->validRouteIds($city, $data['route_ids'] ?? []) : null;

        $group = RouteGroup::query()->create([
            'city_id' => $city->id,
            'city_vehicle_type_id' => $data['city_vehicle_type_id'] ?? null,
            'name' => trim($data['name']),
            'is_active' => $data['is_active'] ?? true,
        ]);

        if (array_key_exists('route_ids', $data)) {
            $group->routes()->sync($routeIds);
        }

        // Groups created for a set member are shared with the set immediately.
        $setId = isset($data['city_vehicle_type_id'])
            ? CityVehicleType::query()->whereKey($data['city_vehicle_type_id'])->value('vehicle_set_id') : null;
        if ($setId) {
            $group->vehicleSets()->syncWithoutDetaching([$setId]);
        }

        return response()->json([
            'route_group' => $this->shape($group->fresh(['routes', 'drivers', 'vehicleSets'])),
            'message' => 'Stand created.',
        ], 201);
    }

    public function update(Request $request, City $city, RouteGroup $routeGroup)
    {
        $this->assertCityOwnsGroup($city, $routeGroup);
        $data = $this->validatePayload($request, $city, $routeGroup);
        $routeIds = array_key_exists('route_ids', $data) ? $this->validRouteIds($city, $data['route_ids'] ?? []) : null;

        $update = [
            'name' => trim($data['name']),
            'is_active' => $data['is_active'] ?? $routeGroup->is_active,
        ];
        // Only rebind when the caller sends the field — so a plain rename or a
        // route-only save never clears an existing binding.
        if (array_key_exists('city_vehicle_type_id', $data)) {
            $update['city_vehicle_type_id'] = $data['city_vehicle_type_id'];
        }
        $routeGroup->update($update);

        if (array_key_exists('route_ids', $data)) {
            $routeGroup->routes()->sync($routeIds);
        }

        return response()->json([
            'route_group' => $this->shape($routeGroup->fresh(['routes', 'drivers', 'vehicleSets'])),
            'message' => 'Stand updated.',
        ]);
    }

    public function destroy(City $city, RouteGroup $routeGroup)
    {
        $this->assertCityOwnsGroup($city, $routeGroup);
        $routeGroup->delete(); // FK cascade clears route_group_route + driver_route_group

        return response()->json(['message' => 'Stand deleted.']);
    }

    /**
     * Set which drivers hold this group (group-centric assignment, the mirror of
     * the per-driver panel). driver_user_ids are users.id — the key the pivot and
     * the fixed flow use. Each must be a driver registered in this city.
     */
    public function syncDrivers(Request $request, City $city, RouteGroup $routeGroup)
    {
        $this->assertCityOwnsGroup($city, $routeGroup);

        $data = $request->validate([
            'driver_user_ids' => ['present', 'array'],
            'driver_user_ids.*' => ['integer'],
        ]);

        $ids = array_values(array_unique(array_map('intval', $data['driver_user_ids'])));
        if ($ids) {
            $validCount = Driver::query()->whereIn('user_id', $ids)->forCity((int) $city->id)->count();
            if ($validCount !== count($ids)) {
                abort(422, 'Some drivers are not registered in this city.');
            }
        }

        $routeGroup->drivers()->sync($ids);

        return response()->json([
            'driver_user_ids' => $ids,
            'message' => 'Stand drivers updated.',
        ]);
    }

    /** Lightweight list of the city's drivers for the assignment picker. */
    public function cityDrivers(City $city)
    {
        $drivers = Driver::query()
            ->forCity((int) $city->id)
            ->with(['user:id,name,phone,avatar_path', 'cities:id,name'])
            ->get()
            ->map(fn (Driver $d) => [
                'id' => (int) $d->id,
                'user_id' => (int) $d->user_id,
                'name' => $d->user?->name ?: ('Driver #' . $d->user_id),
                'phone' => $d->user?->phone,
                'avatar_url' => $d->user?->avatar_path
                    ? (str_starts_with($d->user->avatar_path, 'http') ? $d->user->avatar_path : url('/storage/'.ltrim($d->user->avatar_path, '/')))
                    : null,
                // Vehicle fields live on the driver, so the vehicle workspace
                // reads the driver ⇄ city-vehicle link from here. vehicle_type_id
                // is needed to keep reassignment inside the driver's own type.
                'city_vehicle_type_id' => $d->city_vehicle_type_id !== null ? (int) $d->city_vehicle_type_id : null,
                'vehicle_type_id' => $d->vehicle_type_id !== null ? (int) $d->vehicle_type_id : null,
                'vehicle_reg_no' => $d->vehicle_reg_no,
                'vehicle_model' => $d->vehicle_model,
                'vehicle_color' => $d->vehicle_color,
            ])
            ->filter(fn ($d) => $d['user_id'] > 0)
            ->sortBy('name')
            ->values();

        return response()->json(['data' => $drivers]);
    }

    private function validatePayload(Request $request, City $city, ?RouteGroup $group): array
    {
        return $request->validate([
            'name' => [
                'required', 'string', 'max:120',
                Rule::unique('route_groups', 'name')
                    ->where(fn ($q) => $q->where('city_id', $city->id))
                    ->ignore($group?->id),
            ],
            'is_active' => ['nullable', 'boolean'],
            'city_vehicle_type_id' => [
                'nullable', 'integer',
                Rule::exists('city_vehicle_types', 'id')->where(fn ($q) => $q->where('city_id', $city->id)),
            ],
            'route_ids' => ['nullable', 'array'],
            'route_ids.*' => ['integer'],
        ]);
    }

    /**
     * Keep only route ids that are fixed routes in this city; reject the whole
     * request if any id is cross-city, non-fixed, or missing — so a group can
     * never silently point at a route it shouldn't.
     *
     * @return int[]
     */
    private function validRouteIds(City $city, array $routeIds): array
    {
        $routeIds = array_values(array_unique(array_map('intval', $routeIds)));
        if (empty($routeIds)) {
            return [];
        }

        $routes = Route::query()
            ->whereIn('id', $routeIds)
            ->where('city_id', $city->id)
            ->where('mode', 'fixed')
            ->get(['id', 'fare_config']);

        $valid = $routes->pluck('id')->map(fn ($id) => (int) $id)->all();

        if (array_diff($routeIds, $valid)) {
            abort(422, 'Some selected routes are not fixed routes in this city.');
        }

        // A bulk-imported route with no fare is "Needs pricing" — it must not be
        // grouped (and so go live) until an admin adds a price to it.
        $needsPricing = $routes->contains(fn ($r) => ! (is_array($r->fare_config)
            && isset($r->fare_config['seat_fare'])
            && (float) $r->fare_config['seat_fare'] > 0));
        if ($needsPricing) {
            abort(422, 'Add a price to these routes before adding them to a stand — they are still marked “Needs pricing”.');
        }

        return $valid;
    }

    private function assertCityOwnsGroup(City $city, RouteGroup $group): void
    {
        if ((int) $group->city_id !== (int) $city->id) {
            abort(404);
        }
    }

    private function shape(RouteGroup $group): array
    {
        $routes = $group->relationLoaded('routes') ? $group->routes : collect();
        $driverIds = $group->relationLoaded('drivers')
            ? $group->drivers->pluck('id')->map(fn ($id) => (int) $id)->values()
            : collect();

        return [
            'id' => $group->id,
            'name' => $group->name,
            'is_active' => (bool) $group->is_active,
            'city_vehicle_type_id' => $group->city_vehicle_type_id !== null ? (int) $group->city_vehicle_type_id : null,
            'route_ids' => $routes->pluck('id')->map(fn ($id) => (int) $id)->values(),
            'route_count' => $routes->count(),
            'driver_user_ids' => $driverIds,
            'driver_count' => $driverIds->count(),
            'vehicle_set_ids' => $group->vehicleSets->pluck('id')->map(fn ($id) => (int) $id)->values(),
        ];
    }
}
