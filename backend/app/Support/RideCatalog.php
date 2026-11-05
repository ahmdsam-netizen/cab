<?php

namespace App\Support;

use App\Models\RideType;
use App\Models\OperatorSetting;
use Illuminate\Support\Collection;

/**
 * The service catalogue, served from `ride_types` alone.
 *
 * The catalogue used to live in city_ride_scopes + city_ride_modes. Those are
 * gone; a ride type now carries one switch per scope (`is_active_local`,
 * `is_active_outstation`) and the settings are global rather than per city.
 *
 * The JSON shape below is byte-for-byte what the old tables produced, so the
 * customer and driver apps did not have to change: a list of scopes, each with
 * its modes. `scope.is_active` is derived — a scope is on when at least one of
 * its modes is on, which is exactly what "switch Local off and all three go
 * with it" means.
 */
class RideCatalog
{
    /** [scope key, display name, sort order]. */
    public const SCOPES = [
        ['local', 'Local', 1],
        ['outstation', 'Outstation', 2],
    ];

    /** Stable synthetic ids so clients still get one per scope. */
    private const SCOPE_IDS = ['local' => 1, 'outstation' => 2];

    public static function rideTypes(): Collection
    {
        return RideType::query()->orderBy('sort_order')->orderBy('id')->get();
    }

    public static function isActive(RideType $rt, string $scope): bool
    {
        return $scope === 'outstation' ? (bool) $rt->is_active_outstation : (bool) $rt->is_active_local;
    }

    /**
     * Build the scope → modes tree.
     *
     * @param bool $onlyActive       drop switched-off scopes and modes (customer/driver view)
     * @param callable|null $modeFilter  extra per-mode gate, fn(RideType $rt, string $scope): bool
     */
    public static function tree(bool $onlyActive = true, ?callable $modeFilter = null): array
    {
        $rideTypes = self::rideTypes();
        $settings = OperatorSetting::query()->find(1);
        $out = [];

        foreach (self::SCOPES as [$scope, $scopeName, $scopeSort]) {
            $modes = [];
            $sort = 0;
            foreach ($rideTypes as $rt) {
                $sort++;
                $on = self::isActive($rt, $scope);
                if ($onlyActive && !$on) continue;
                if ($modeFilter && !$modeFilter($rt, $scope)) continue;
                $modes[] = self::shapeMode($rt, $scope, $on, $sort, $settings);
            }

            // A scope is on when anything under it is on.
            $scopeActive = $rideTypes->contains(fn (RideType $rt) => self::isActive($rt, $scope));
            if ($onlyActive && !$modes) continue;

            $out[] = [
                'id' => self::SCOPE_IDS[$scope],
                'scope' => $scope,
                'name' => $scopeName,
                'is_active' => $scopeActive,
                'sort_order' => $scopeSort,
                'modes' => $modes,
            ];
        }

        return $out;
    }

    public static function shapeMode(RideType $rt, string $scope, bool $isActive, int $sortOrder, ?OperatorSetting $settings = null): array
    {
        $mode = $rt->resolvedMode();

        return [
            // The ride type id. Unique within a scope; clients key on scope+mode.
            'id' => $rt->id,
            'ride_type_id' => $rt->id,
            'scope' => $scope,
            'mode' => $mode,
            // Legacy alias some older clients still read.
            'kind' => $mode === RideType::MODE_PRIVATE ? $scope : $mode,
            'name' => $rt->name,
            'display_name' => $settings?->getAttribute($mode . '_service_name'),
            'image_path' => $rt->image_path,
            'image_url' => $rt->image_url,
            'is_active' => $isActive,
            'sort_order' => $sortOrder,
            'updated_at' => optional($rt->updated_at)->toIso8601String(),
        ];
    }

    /** How many (scope × mode) cells are switched on across the platform. */
    public static function bookableCount(): int
    {
        $n = 0;
        foreach (self::rideTypes() as $rt) {
            if ($rt->is_active_local) $n++;
            if ($rt->is_active_outstation) $n++;
        }
        return $n;
    }
}
