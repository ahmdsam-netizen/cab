<?php

namespace App\Http\Controllers;

use App\Models\Route;
use App\Services\FixedAvailabilityService;
use App\Services\FixedDepartureService;
use App\Services\FixedRouteService;
use Illuminate\Http\Request;

class FixedRoutesController extends Controller
{
    public function __construct(
        private readonly FixedRouteService $routes,
        private readonly FixedDepartureService $departures,
        private readonly FixedAvailabilityService $availability,
    ) {}

    public function index(Request $request)
    {
        $data = $request->validate([
            'city_id' => ['nullable', 'integer', 'exists:cities,id'],
            'origin_city_id' => ['nullable', 'integer', 'exists:cities,id'],
            'dest_city_id' => ['nullable', 'integer', 'exists:cities,id'],
            'scope' => ['nullable', 'in:local,outstation'],
            'q' => ['nullable', 'string', 'max:80'],
            'search_by' => ['nullable', 'in:destination,origin,stop,all'],
            'sort_by' => ['nullable', 'in:nearest_pickup'],
            'limit' => ['nullable', 'integer', 'min:1', 'max:100'],
            'lat' => ['nullable', 'numeric', 'between:-90,90'],
            'lng' => ['nullable', 'numeric', 'between:-180,180'],
        ]);

        // Existing clients without search_by retain the previous broad search.
        $data['search_by'] ??= 'all';

        return response()->json(['data' => $this->routes->customerRoutes($data)]);
    }

    public function departures(Route $route)
    {
        $this->availability->assertFixedRoute($route);
        if (!$route->is_active) {
            abort(404);
        }

        return response()->json(['data' => $this->departures->customerDepartures($route)]);
    }
}
