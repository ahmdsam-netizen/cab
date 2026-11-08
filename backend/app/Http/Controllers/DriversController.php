<?php

namespace App\Http\Controllers;

use App\Events\DispatchDriverLocationUpdated;
use App\Events\DriverVerificationUpdated;
use App\Models\CitySetting;
use App\Models\City;
use App\Models\CityVehicleType;
use App\Models\Driver;
use App\Models\Fleet;
use App\Models\Document;
use App\Models\DriverDocument;
use App\Models\DriverLocation;
use App\Models\OperatorSetting;
use App\Models\Route;
use App\Models\RouteGroup;
use App\Models\Trip;
use App\Models\User;
use App\Services\DriverServiceModeService;
use App\Services\DriverRouteAccessService;
use App\Services\WalletService;
use App\Services\FixedStopAutomationService;
use App\Services\ShuttleStopAutomationService;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

class DriversController extends Controller
{
    public function register(Request $request)
    {
        return DB::transaction(function () use ($request) {
            $user = User::query()->lockForUpdate()->findOrFail($request->user()->id);

            return $this->saveRegistration($request, $user);
        });
    }

    public function registrationStands(City $city)
    {
        return response()->json(['data' => RouteGroup::query()
            ->where('city_id', $city->id)
            ->where('is_active', true)
            ->orderBy('name')
            ->get(['id', 'name'])]);
    }

    public function serviceAccess(Request $request, DriverRouteAccessService $access)
    {
        $userId = $request->user()->id;
        $driver = Driver::query()->where('user_id', $userId)->firstOrFail();
        $cityIds = $driver->city_ids;

        return response()->json([
            'cities' => City::query()->whereIn('id', $cityIds)->orderBy('name')->get(['id', 'name']),
            'stands' => RouteGroup::query()->whereHas('drivers', fn ($query) => $query->whereKey($userId))
                ->whereIn('city_id', $cityIds)->with('city:id,name')->orderBy('name')
                ->get(['id', 'city_id', 'name', 'is_active']),
            'routes' => Route::query()->whereIn('id', $access->effectiveRouteIds($userId))
                ->where('mode', 'fixed')->where('is_active', true)->whereIn('scope', $driver->allowedScopes())
                ->where(fn ($query) => $query->whereIn('city_id', $cityIds)
                    ->orWhereIn('origin_city_id', $cityIds)->orWhereIn('dest_city_id', $cityIds))
                ->orderBy('name')->get(['id', 'name', 'origin_name', 'dest_name', 'scope']),
        ]);
    }

    private function saveRegistration(Request $request, User $user)
    {
        $existing = Driver::query()->where('user_id', $user->id)->first();

        if ($request->has('service_scope') || $request->has('service_scopes')) {
            $rawScope = $request->input('service_scope') ?? $request->input('service_scopes');
            if (is_array($rawScope)) {
                $hasLocal = in_array('local', $rawScope, true);
                $hasOutstation = in_array('outstation', $rawScope, true);
                $normalized = ($hasLocal && $hasOutstation) ? 'both' : ($hasOutstation ? 'outstation' : ($hasLocal ? 'local' : null));
                $request->merge(['service_scope' => $normalized]);
            }
        }

        $data = $request->validate([
            // The 3-step wizard sends ride_type_id (Step 1) + vehicle_type_id
            // (Step 2). Free-text vehicle_type is kept for backwards compat
            // with older registrations and as a human-readable fallback.
            'ride_type_id' => ['nullable', 'integer', 'exists:ride_types,id'],
            'vehicle_type_id' => ['nullable', 'integer', 'exists:vehicle_types,id'],
            'city_vehicle_type_id' => ['nullable', 'integer', 'exists:city_vehicle_types,id'],
            'vehicle_type' => ['nullable', 'string', 'max:100'],
            'vehicle_model' => ['nullable', 'regex:/^\d{4}$/'],
            'vehicle_color' => ['nullable', 'string', 'max:100'],
            'vehicle_reg_no' => [
                'nullable',
                'string',
                'max:50',
                Rule::unique('drivers', 'vehicle_reg_no')->ignore($existing?->id),
            ],
            // Onboarding wizard now also captures the city + fleet. Both are
            // nullable (fleet = "none" allowed; city set later by admin if missing).
            'city_id' => ['nullable', 'integer', 'exists:cities,id'],
            'city_ids' => ['nullable', 'array', 'min:1'],
            'city_ids.*' => ['integer', 'exists:cities,id'],
            'fleet_id' => ['nullable', 'integer', 'exists:fleets,id'],
            'service_scope' => ['nullable', 'string', 'in:local,outstation,both'],
            'service_mode' => ['nullable', 'string', 'in:private,fixed,shuttle'],
            'name' => ['nullable', 'string', 'max:120'],
            'email' => ['nullable', 'email', 'max:190', Rule::unique('users', 'email')->ignore($user->id)],
            'dob' => ['nullable', 'date', 'before:today'],
            'address' => ['nullable', 'string', 'max:255'],
            'app_version' => ['nullable', 'string', 'max:32'],
            'os_version' => ['nullable', 'string', 'max:32'],
            'device_type' => ['nullable', 'string', 'max:64'],
            'photo' => ['nullable', 'image', 'max:4096'],
        ]);

        if ($existing) {
            app(DriverServiceModeService::class)->assertVehicleChangeAllowed($existing, $data);
        }

        $chosenCityIds = [];
        if ($existing && ! empty($existing->city_ids)) {
            $chosenCityIds = $existing->city_ids;
        } elseif (! empty($data['city_ids'])) {
            $chosenCityIds = array_values(array_unique(array_map('intval', $data['city_ids'])));
        } elseif (! empty($data['city_id'])) {
            $chosenCityIds = [(int) $data['city_id']];
        }

        $stands = collect();
        if (!$existing) {
            if (count($chosenCityIds) !== 1 || count($data['city_ids'] ?? []) > 1
                || (isset($data['city_id']) && (int) $data['city_id'] !== $chosenCityIds[0])) {
                throw ValidationException::withMessages(['city_id' => 'Select exactly one operating city.']);
            }

            $selection = $request->validate([
                'stand_ids' => ['required', 'array', 'size:2'],
                'stand_ids.*' => ['required', 'integer', 'distinct'],
            ], [
                'stand_ids.required' => 'Select exactly two stands in your operating city.',
                'stand_ids.size' => 'Select exactly two stands in your operating city.',
            ]);
            $stands = RouteGroup::query()->where('city_id', $chosenCityIds[0])
                ->where('is_active', true)->whereIn('id', $selection['stand_ids'])
                ->orderBy('id')->lockForUpdate()->get(['id']);
            if ($stands->count() !== 2) {
                throw ValidationException::withMessages(['stand_ids' => 'Select two active stands in your operating city.']);
            }
        }

        if (!$existing || $existing->approval_status !== 'approved') {
            if (empty($chosenCityIds)) {
                return response()->json(['message' => 'Please pick your city.'], 422);
            }
            foreach ([
                'service_scope' => 'Choose the service area before continuing.',
                'service_mode' => 'Choose the service type before continuing.',
                'vehicle_type_id' => 'Please pick your vehicle type.',
                'city_vehicle_type_id' => 'Please pick the city vehicle.',
                'vehicle_model' => 'Please select the model year.',
                'vehicle_color' => 'Please enter the vehicle color.',
                'vehicle_reg_no' => 'Please enter the registration number.',
            ] as $field => $message) {
                if (empty($data[$field])) {
                    return response()->json(['message' => $message], 422);
                }
            }

            $primaryCityId = $chosenCityIds[0] ?? null;
            $hasFleetChoices = Fleet::query()
                ->where('is_active', true)
                ->where(function ($q) use ($primaryCityId, $existing) {
                    $cityId = $primaryCityId ?? $existing?->city_id;
                    $q->whereNull('city_id');
                    if ($cityId) $q->orWhere('city_id', (int) $cityId);
                })
                ->exists();
            if ($hasFleetChoices && empty($data['fleet_id'])) {
                return response()->json(['message' => 'Please pick your fleet.'], 422);
            }

            $profileChecks = [
                'name' => [$data['name'] ?? $user->name, 'Please complete your profile name.'],
                'email' => [$data['email'] ?? $user->email, 'Please complete your profile email.'],
                'dob' => [$data['dob'] ?? $user->dob, 'Please complete your date of birth.'],
                'address' => [$data['address'] ?? $user->address, 'Please complete your address.'],
            ];
            foreach ($profileChecks as [$value, $message]) {
                if (empty($value) || $value === 'User' || str_ends_with((string) $value, '@otp.local')) {
                    return response()->json(['message' => $message], 422);
                }
            }
        }

        if (! empty($data['city_vehicle_type_id'])) {
            $cityVehicle = CityVehicleType::query()->find((int) $data['city_vehicle_type_id']);
            if (! $cityVehicle
                || ! $cityVehicle->is_active
                || (! empty($chosenCityIds) && ! in_array((int) $cityVehicle->city_id, $chosenCityIds, true))
                || (int) $cityVehicle->vehicle_type_id !== (int) ($data['vehicle_type_id'] ?? $existing?->vehicle_type_id)) {
                return response()->json([
                    'message' => 'Selected city vehicle does not match your city and vehicle type.',
                ], 422);
            }
        }

        if (!$existing || $existing->approval_status !== 'approved') {
            $profilePayload = [];
            foreach (['name', 'email', 'dob', 'address', 'app_version', 'os_version', 'device_type'] as $field) {
                if (array_key_exists($field, $data) && $data[$field] !== null && $data[$field] !== '') {
                    $profilePayload[$field] = $data[$field];
                }
            }
            if ($request->hasFile('photo')) {
                if ($user->avatar_path && Storage::disk('public')->exists($user->avatar_path)) {
                    Storage::disk('public')->delete($user->avatar_path);
                }
                $profilePayload['avatar_path'] = $request->file('photo')->store('avatars', 'public');
            }
            if ($profilePayload) {
                $user->fill($profilePayload);
                $user->save();
            }
        }

        // Locked fields once the driver is approved. Trying to change ride,
        // vehicle, or permanent service post-approval is a 422 — the operator
        // owns those decisions from that point on.
        if ($existing && $existing->approval_status === 'approved') {
            $tryingToChangeRide = array_key_exists('ride_type_id', $data)
                && $data['ride_type_id'] !== null
                && (int) $data['ride_type_id'] !== (int) $existing->ride_type_id;
            $tryingToChangeVehicle = array_key_exists('vehicle_type_id', $data)
                && $data['vehicle_type_id'] !== null
                && (int) $data['vehicle_type_id'] !== (int) $existing->vehicle_type_id;
            $tryingToChangeCityVehicle = array_key_exists('city_vehicle_type_id', $data)
                && $data['city_vehicle_type_id'] !== null
                && (int) $data['city_vehicle_type_id'] !== (int) $existing->city_vehicle_type_id;
            $tryingToChangeServiceScope = array_key_exists('service_scope', $data)
                && $data['service_scope'] !== null
                && $data['service_scope'] !== $existing->service_scope;
            $tryingToChangeServiceMode = array_key_exists('service_mode', $data)
                && $data['service_mode'] !== null
                && $data['service_mode'] !== $existing->service_mode;
            if ($tryingToChangeRide || $tryingToChangeVehicle || $tryingToChangeCityVehicle || $tryingToChangeServiceScope || $tryingToChangeServiceMode) {
                return response()->json([
                    'message' => 'Ride type, vehicle type, and driver service are locked after approval. Contact the operator.',
                ], 422);
            }
        }

        // If ride_type_id/vehicle_type_id are sent without a free-text
        // vehicle_type, derive a sensible label so older parts of the app that
        // read vehicle_type still get something.
        $vehicleTypeLabel = $data['vehicle_type'] ?? null;
        if (!$vehicleTypeLabel && !empty($data['vehicle_type_id'])) {
            $vt = \App\Models\VehicleType::query()->find($data['vehicle_type_id']);
            $vehicleTypeLabel = $vt?->name;
        }

        // Build the update set carefully: don't reset approval_status on a
        // re-registration, and freeze ride/vehicle type once approved.
        $payload = [
            'vehicle_type' => $vehicleTypeLabel ?? ($existing->vehicle_type ?? null),
            'vehicle_model' => $data['vehicle_model'] ?? ($existing->vehicle_model ?? null),
            'vehicle_color' => $data['vehicle_color'] ?? ($existing->vehicle_color ?? null),
            'vehicle_reg_no' => $data['vehicle_reg_no'] ?? ($existing->vehicle_reg_no ?? null),
            'city_id' => !empty($chosenCityIds) ? $chosenCityIds[0] : ($existing->city_id ?? null),
            'city_vehicle_type_id' => array_key_exists('city_vehicle_type_id', $data) ? $data['city_vehicle_type_id'] : ($existing->city_vehicle_type_id ?? null),
            'fleet_id' => array_key_exists('fleet_id', $data) ? $data['fleet_id'] : ($existing->fleet_id ?? null),
        ];
        if (!$existing) {
            $payload['approval_status'] = 'pending';
            $payload['ride_type_id'] = $data['ride_type_id'] ?? null;
            $payload['vehicle_type_id'] = $data['vehicle_type_id'] ?? null;
            $payload['service_scope'] = $data['service_scope'] ?? null;
            $payload['service_mode'] = $data['service_mode'] ?? null;
        } else {
            $payload['approval_status'] = $existing->approval_status; // preserve
            if ($existing->approval_status !== 'approved') {
                // Pre-approval: driver can still flip their choices.
                $payload['ride_type_id'] = array_key_exists('ride_type_id', $data)
                    ? $data['ride_type_id']
                    : $existing->ride_type_id;
                $payload['vehicle_type_id'] = array_key_exists('vehicle_type_id', $data)
                    ? $data['vehicle_type_id']
                    : $existing->vehicle_type_id;
                $payload['city_vehicle_type_id'] = array_key_exists('city_vehicle_type_id', $data)
                    ? $data['city_vehicle_type_id']
                    : $existing->city_vehicle_type_id;
                $payload['service_scope'] = array_key_exists('service_scope', $data)
                    ? $data['service_scope']
                    : $existing->service_scope;
                $payload['service_mode'] = array_key_exists('service_mode', $data)
                    ? $data['service_mode']
                    : $existing->service_mode;
            } else {
                // Approved: ride/vehicle frozen regardless of payload.
                $payload['ride_type_id'] = $existing->ride_type_id;
                $payload['vehicle_type_id'] = $existing->vehicle_type_id;
                $payload['city_vehicle_type_id'] = $existing->city_vehicle_type_id;
                $payload['service_scope'] = $existing->service_scope;
                $payload['service_mode'] = $existing->service_mode;
            }
        }

        $saveCities = !$existing || empty($existing->city_ids);
        if (!$saveCities) {
            unset($payload['city_id']);
        }

        $driver = Driver::query()->updateOrCreate(
            ['user_id' => $user->id],
            $payload,
        );

        if ($saveCities && ! empty($chosenCityIds)) {
            $driver->cities()->sync($chosenCityIds);
        }
        foreach ($stands as $stand) {
            $stand->drivers()->attach($user->id);
        }

        $user->addRole('driver');

        $fresh = $user->fresh();

        return response()->json([
            'driver' => $driver->fresh(['cities:id,name']),
            'user' => [
                'id' => $fresh->id,
                'name' => $fresh->name,
                'phone' => $fresh->phone,
                'email' => $fresh->email,
                'roles' => $fresh->roleNames(),
            ],
        ]);
    }

    /**
     * Current user's driver profile (if any), for mobile dashboard / status.
     */
    public function me(Request $request)
    {
        $user = $request->user();
        $driver = Driver::query()
            ->where('user_id', $user->id)
            ->with(['cities:id,name', 'cityVehicleType:id,display_name', 'vehicleTypeRef:id,name'])
            ->first();
        if ($driver) {
            $driver->append('city_ids');
            $requestedPlatform = $request->header('X-Platform', 'android');
            $imageService = app(\App\Services\VehicleFamilyImageService::class);
            $primaryCityId = $driver->city_id ?: ($driver->cities?->first()?->id);
            $familyName = $driver->cityVehicleType?->display_name ?: ($driver->vehicleTypeRef?->name ?: $driver->vehicle_type);
            $imagePayload = $imageService->resolveForVehicle(
                $primaryCityId,
                $familyName,
                $requestedPlatform
            );
            $driver->setAttribute('map_marker_url', $imagePayload['map_marker_url']);
            $driver->setAttribute('image_url', $imagePayload['image_url']);
            $driver->setAttribute('vehicle', [
                'type' => $driver->vehicle_type,
                'brand' => $driver->vehicle_brand,
                'model' => $driver->vehicle_model,
                'color' => $driver->vehicle_color,
                'reg_no' => $driver->vehicle_reg_no,
                'image_url' => $imagePayload['image_url'],
                'map_marker_url' => $imagePayload['map_marker_url'],
            ]);
        }

        $documents = [];
        if ($driver) {
            $documents = DriverDocument::query()
                ->where('driver_id', $driver->id)
                ->with('document:id,name')
                ->get()
                ->map(fn (DriverDocument $d) => [
                    'id' => $d->id,
                    'document_id' => $d->document_id,
                    'document_name' => $d->document?->name,
                    'document_type' => $d->document_type,
                    'image_index' => $d->image_index,
                    'vehicle_type_id' => $d->vehicle_type_id,
                    'status' => $d->status,
                    'rejection_reason' => $d->rejection_reason,
                    'file_url' => url('/api/drivers/me/documents/' . $d->id . '/file'),
                    'label_values' => $d->label_values,
                    'uploaded_at' => optional($d->created_at)->toIso8601String(),
                ])
                ->all();
        }

        $avatarUrl = $user->avatar_path
            ? (str_starts_with($user->avatar_path, 'http')
                ? $user->avatar_path
                : url('/storage/'.ltrim($user->avatar_path, '/')))
            : null;

        // City-level wallet warning config.
        $primaryCityId = $driver?->city_id ?: ($driver?->cities?->first()?->id);
        $citySettings = $primaryCityId
            ? CitySetting::query()->where('city_id', $primaryCityId)->first()
            : null;

        return response()->json([
            'user' => [
                'id' => $user->id,
                'name' => $user->name,
                'phone' => $user->phone,
                'email' => $user->email,
                'roles' => $user->roleNames(),
                'avatar_path' => $user->avatar_path,
                'avatar_url' => $avatarUrl,
            ],
            'driver' => $driver,
            'documents' => $documents,
            'document_requirements' => $driver ? app(\App\Services\DriverDocumentRequirements::class)->forDriver($driver) : [],
            'city_vehicle_type_config' => [
                'show_low_wallet_alert' => (bool) ($citySettings?->show_low_wallet_alert ?? true),
            ],
        ]);
    }

    /**
     * Stream the driver's own uploaded document. Same content-disposition
     * semantics as the admin equivalent — pass ?download=1 to force a
     * download instead of inline view.
     */
    public function meDocumentFile(Request $request, DriverDocument $document)
    {
        $user = $request->user();
        $driver = Driver::query()->where('user_id', $user->id)->first();
        if (!$driver || $document->driver_id !== $driver->id) {
            abort(404);
        }
        if (!$document->file_path || !\Illuminate\Support\Facades\Storage::disk('local')->exists($document->file_path)) {
            abort(404, 'File not found.');
        }

        $mime = \Illuminate\Support\Facades\Storage::disk('local')->mimeType($document->file_path) ?: 'application/octet-stream';
        $filename = basename($document->file_path);
        $download = $request->boolean('download');

        return response()->stream(
            function () use ($document) {
                $stream = \Illuminate\Support\Facades\Storage::disk('local')->readStream($document->file_path);
                if ($stream) {
                    fpassthru($stream);
                    if (is_resource($stream)) fclose($stream);
                }
            },
            200,
            [
                'Content-Type' => $mime,
                'Content-Disposition' => ($download ? 'attachment' : 'inline') . '; filename="' . $filename . '"',
            ],
        );
    }

    /**
     * Earnings summary used by the driver mobile Earnings tab.
     *
     * Returns:
     *  - total_earnings   lifetime SUM(final_fare) across the driver's completed trips
     *  - wallet_balance   placeholder until driver payouts are wired up
     *  - period           the bucket window: 'week' (last 7 days) or 'month' (last 30 days)
     *  - buckets          [{ date: YYYY-MM-DD, amount: number, weekday: short }, ...]
     *                     one entry per day in the requested window, in chronological order
     *  - weekly           [{ date, amount, weekday }, ...] always the last 7 days
     *                     so the dashboard's "weekly earnings" list stays stable
     */
    public function earnings(Request $request, \App\Services\PayoutLedgerService $payoutLedger)
    {
        $user = $request->user();
        $period = $request->query('period', 'week');
        if (!in_array($period, ['week', 'month', 'all'], true)) {
            $period = 'week';
        }

        $windowStart = null;
        if ($period === 'week') {
            $windowStart = now()->startOfDay()->subDays(6);
            $days = 7;
        } elseif ($period === 'month') {
            $windowStart = now()->startOfDay()->subDays(29);
            $days = 30;
        } else {
            $days = 30; // default chart window for all-time view
        }

        $rowsQuery = Trip::query()
            ->where('driver_id', $user->id)
            ->where('status', 'COMPLETED')
            ->whereNotNull('completed_at');

        if ($windowStart) {
            $rowsQuery->where('completed_at', '>=', $windowStart);
        }

        $rows = (clone $rowsQuery)
            ->selectRaw('DATE(completed_at) as day, COALESCE(SUM(final_fare), 0) as amount')
            ->groupBy('day')
            ->pluck('amount', 'day');

        // Backfill missing days with zero so the bar chart has even gaps.
        $buckets = [];
        $chartStart = $windowStart ?: now()->startOfDay()->subDays(29);
        for ($i = 0; $i < $days; $i++) {
            $d = $chartStart->copy()->addDays($i);
            $key = $d->toDateString();
            $buckets[] = [
                'date' => $key,
                'amount' => (float) ($rows[$key] ?? 0),
                'weekday' => $d->format('D'),
            ];
        }

        // Always also return last-7-days for the weekly breakdown list.
        $weekly = array_slice($buckets, -7);

        // Per-ride breakdown for the selected window: show fare and payment method.
        $ridesQuery = Trip::query()
            ->where('driver_id', $user->id)
            ->where('status', 'COMPLETED')
            ->whereNotNull('completed_at');

        if ($windowStart) {
            $ridesQuery->where('completed_at', '>=', $windowStart);
        }

        $rides = $ridesQuery
            ->with(['seatReservations:id,trip_id,fare_amount,payment_method'])
            ->orderByDesc('completed_at')
            ->limit(500)
            ->get(['id', 'completed_at', 'final_fare', 'payment_method', 'route_departure_id'])
            ->map(function (Trip $t) use ($user) {
                $fare = (float) ($t->final_fare ?? 0);

                // Online collected on this trip by operator (upfront deposit or full online fare)
                $onlineCollectedOnTrip = (float) \App\Models\DriverPayoutLedger::query()
                    ->where('driver_user_id', $user->id)
                    ->where('trip_id', $t->id)
                    ->where('type', \App\Models\DriverPayoutLedger::TYPE_COLLECTED)
                    ->sum('amount');

                // Determine effective payment method
                $method = $t->payment_method;
                if (!$method && $t->seatReservations->isNotEmpty()) {
                    $methods = $t->seatReservations->pluck('payment_method')->filter()->unique();
                    $method = $methods->implode(', ');
                }

                $methodStr = strtolower((string) ($method ?? ''));
                $hasCash = str_contains($methodStr, 'cash') || ($fare > $onlineCollectedOnTrip && $onlineCollectedOnTrip > 0);

                $cashPortion = $hasCash ? max(0.0, round($fare - $onlineCollectedOnTrip, 2)) : 0.0;
                if ($hasCash && $cashPortion == 0 && $onlineCollectedOnTrip == 0) {
                    $cashPortion = $fare;
                }

                return [
                    'id' => $t->id,
                    'date' => optional($t->completed_at)->toIso8601String(),
                    'fare' => round($fare, 2),
                    'payment_method' => $method ?: ($cashPortion > 0 ? 'cash' : 'online'),
                    'is_cash' => $cashPortion > 0,
                    'cash_amount' => $cashPortion,
                    'online_amount' => round(min($onlineCollectedOnTrip, $fare), 2),
                    'is_shared' => $t->route_departure_id !== null,
                ];
            })
            ->all();

        // ── Period money totals (or lifetime if 'all') ──
        $totalsQuery = Trip::query()
            ->where('driver_id', $user->id)
            ->where('status', 'COMPLETED');

        if ($windowStart) {
            $totalsQuery->where('completed_at', '>=', $windowStart);
        }

        $tripsList = $totalsQuery
            ->with(['seatReservations:id,trip_id,fare_amount,payment_method'])
            ->get(['id', 'final_fare', 'payment_method']);

        $totalRideEarnings = 0.0;
        $cashCollected = 0.0;
        $onlineCollected = 0.0;

        foreach ($tripsList as $trip) {
            $fare = (float) ($trip->final_fare ?? 0);
            $totalRideEarnings += $fare;

            // Online collected by operator on this trip
            $onlineOnTrip = (float) \App\Models\DriverPayoutLedger::query()
                ->where('driver_user_id', $user->id)
                ->where('trip_id', $trip->id)
                ->where('type', \App\Models\DriverPayoutLedger::TYPE_COLLECTED)
                ->sum('amount');

            if ($onlineOnTrip > 0) {
                $onlinePortion = min($onlineOnTrip, $fare);
                $onlineCollected += $onlinePortion;
                $cashCollected += max(0.0, round($fare - $onlinePortion, 2));
            } else {
                $m = strtolower((string) ($trip->payment_method ?? ''));
                if (!$m && $trip->seatReservations->isNotEmpty()) {
                    $m = strtolower((string) $trip->seatReservations->first()->payment_method);
                }

                if ($m === 'cash') {
                    $cashCollected += $fare;
                } else {
                    $onlineCollected += $fare;
                }
            }
        }

        // Payout Ledger summary (money operator collected for driver & transfers)
        $payoutSummary = $payoutLedger->summary($user);

        // Recent operator transfers / payments to this driver
        $recentTransfers = \App\Models\DriverPayoutLedger::query()
            ->where('driver_user_id', $user->id)
            ->where('type', \App\Models\DriverPayoutLedger::TYPE_TRANSFER)
            ->orderByDesc('created_at')
            ->limit(50)
            ->get()
            ->map(fn (\App\Models\DriverPayoutLedger $t) => [
                'id' => $t->id,
                'amount' => (float) $t->amount,
                'method' => $t->method,
                'reference' => $t->reference,
                'notes' => $t->notes,
                'created_at' => optional($t->created_at)->toIso8601String(),
            ]);

        // Recent operator collections (received on behalf of driver)
        $recentCollections = \App\Models\DriverPayoutLedger::query()
            ->where('driver_user_id', $user->id)
            ->where('type', \App\Models\DriverPayoutLedger::TYPE_COLLECTED)
            ->orderByDesc('created_at')
            ->limit(50)
            ->get()
            ->map(fn (\App\Models\DriverPayoutLedger $c) => [
                'id' => $c->id,
                'amount' => (float) $c->amount,
                'source' => $c->source,
                'trip_id' => $c->trip_id,
                'notes' => $c->notes,
                'created_at' => optional($c->created_at)->toIso8601String(),
            ]);

        return response()->json([
            'ride_earnings' => round($totalRideEarnings, 2),
            'cash_collected' => round($cashCollected, 2),
            'online_collected' => round($onlineCollected, 2),
            'total_collected' => round($totalRideEarnings, 2),
            'money_collected_by_operator' => $payoutSummary['money_collected'],
            'pending_transfers' => $payoutSummary['pending_payout'],
            'completed_transfers' => $payoutSummary['completed_payout'],
            'operator_payments' => $recentTransfers,
            'operator_transfers' => $recentTransfers,
            'operator_collections' => $recentCollections,
            'currency' => 'INR',
            'period' => $period,
            'buckets' => $buckets,
            'weekly' => $weekly,
            'rides' => $rides,
        ]);
    }

    /**
     * Returns the current driver's in-flight trip (or null). Used by the driver
     * mobile app on boot to resume the location stream and route to the
     * trip-active page after a cold start.
     */
    public function activeTrip(Request $request)
    {
        $user = $request->user();

        // Broader than Trip::ACTIVE_DRIVER_STATUSES on purpose: also surface
        // NEGOTIATION trips the customer pre-selected this driver for, and
        // CONFIRMED trips waiting for /driver-accept. Without these, a cold
        // start mid-handoff lands on "no active trip" even though the driver
        // is committed to one.
        $statuses = array_merge(['NEGOTIATION', 'CONFIRMED'], Trip::ACTIVE_DRIVER_STATUSES);

        $trip = Trip::query()
            ->where('driver_id', $user->id)
            ->whereIn('status', $statuses)
            ->orderByDesc('updated_at')
            ->first();

        if (!$trip) {
            return response()->json(['trip' => null]);
        }

        $trip->loadMissing('cityVehicleType:id,display_name,ride_type_id', 'cityVehicleType.rideType:id,name');
        $payload = $trip->toArray();
        $rideTypeName = (string) $trip->cityVehicleType?->rideType?->name;
        $payload['is_shared'] = $trip->route_departure_id !== null;
        $payload['service_mode'] = str_contains(strtolower($rideTypeName), 'shuttle') ? 'shuttle' : 'private';
        $payload['vehicle_name'] = $trip->cityVehicleType?->display_name;
        $payload['ride_type_name'] = $trip->cityVehicleType?->rideType?->name;
        $payload['is_prepaid'] = $payload['service_mode'] === 'shuttle';

        $requestedPlatform = $request->header('X-Platform', 'android');
        $imageService = app(\App\Services\VehicleFamilyImageService::class);
        $vtName = $trip->cityVehicleType?->display_name ?: $rideTypeName;
        $imagePayload = $imageService->resolveForVehicle(
            $trip->city_id,
            $vtName,
            $requestedPlatform
        );
        $payload['map_marker_url'] = $imagePayload['map_marker_url'];
        $payload['image_url'] = $imagePayload['image_url'];
        $driver = Driver::query()->where('user_id', $trip->driver_id)->first();
        $payload['vehicle'] = [
            'type' => $driver?->vehicle_type,
            'brand' => $driver?->vehicle_brand,
            'model' => $driver?->vehicle_model,
            'color' => $driver?->vehicle_color,
            'reg_no' => $driver?->vehicle_reg_no,
            'image_url' => $imagePayload['image_url'],
            'map_marker_url' => $imagePayload['map_marker_url'],
        ];

        // Whether tolls are on for this trip's city. When off, the driver app
        // hides the end-of-ride toll box (the server ignores a toll anyway).
        $payload['tolls_enabled'] = $trip->tollsEnabled();

        // Rider contact the driver should call to coordinate pickup. For a
        // "booked for a friend" trip that's the friend the booker named; for a
        // normal trip it's the account holder. (is_for_other / booked_for_* are
        // already in the toArray payload.)
        $trip->loadMissing('customer:id,name,phone,avatar_path');
        $payload['customer_name'] = $trip->booked_for_name ?: $trip->customer?->name;
        $payload['customer_phone'] = $trip->booked_for_phone ?: $trip->customer?->phone;
        $payload['customer_avatar_url'] = $trip->customer_avatar_url;

        // Shared (fixed/shuttle) journey → attach the passenger manifest + the
        // ordered route stops so the driver app can render the pickup list.
        if ($trip->route_departure_id !== null) {
            $payload = array_merge($payload, app(\App\Services\SeatReservationService::class)->manifestFor($trip));
        }

        return response()->json(['trip' => $payload]);
    }

    /**
     * Anonymized list of nearby online + approved drivers, used by the customer
     * "searching" map to render driver pins like Uber. Returns only lat/lng +
     * an opaque `id` (the driver user id) so the customer can stably animate
     * a marker between polls. Drivers already on an in-flight trip are excluded.
     *
     * Freshness window: only drivers whose latest location row was recorded in
     * the last 5 minutes are returned — staler drivers are effectively offline.
     */
    public function nearby(Request $request)
    {
        $data = $request->validate([
            'lat' => ['required', 'numeric', 'between:-90,90'],
            'lng' => ['required', 'numeric', 'between:-180,180'],
            'radius_km' => ['nullable', 'numeric', 'min:0.1', 'max:50'],
            'limit' => ['nullable', 'integer', 'min:1', 'max:100'],
            'service_mode' => ['nullable', 'in:private,fixed,shuttle'],
            'scope' => ['nullable', 'in:local,outstation'],
        ]);

        $lat = (float) $data['lat'];
        $lng = (float) $data['lng'];
        $radiusKm = (float) ($data['radius_km'] ?? 8.0);
        $limit = (int) ($data['limit'] ?? 30);

        $busyDriverIds = Trip::query()
            ->whereNotNull('driver_id')
            ->whereIn('status', Trip::DRIVER_BUSY_STATUSES)
            ->pluck('driver_id');

        $eligibleIds = Driver::query()
            ->where('approval_status', 'approved')
            ->where('is_online', true)
            ->when(isset($data['service_mode']), fn ($q) => $q->where('active_service_mode', $data['service_mode']))
            ->when(isset($data['scope']), fn ($q) => $q->whereIn('active_service_scope', [$data['scope'], Driver::SERVICE_SCOPE_BOTH]))
            ->whereNotIn('user_id', $busyDriverIds)
            ->pluck('user_id');

        if ($eligibleIds->isEmpty()) {
            return response()->json(['data' => []]);
        }

        $cutoff = now()->subMinutes(5);
        $latestPerDriver = DriverLocation::query()
            ->select('driver_id', DB::raw('MAX(recorded_at) as max_recorded_at'))
            ->whereIn('driver_id', $eligibleIds)
            ->where('recorded_at', '>=', $cutoff)
            ->groupBy('driver_id');

        $rows = DriverLocation::query()
            ->joinSub($latestPerDriver, 'latest', function ($join) {
                $join->on('driver_locations.driver_id', '=', 'latest.driver_id')
                     ->on('driver_locations.recorded_at', '=', 'latest.max_recorded_at');
            })
            ->get(['driver_locations.driver_id', 'driver_locations.lat', 'driver_locations.lng', 'driver_locations.bearing_deg']);

        $nearby = $rows
            ->map(function ($row) use ($lat, $lng) {
                $distance = $this->haversineKm($lat, $lng, (float) $row->lat, (float) $row->lng);
                return [
                    'id' => (int) $row->driver_id,
                    'lat' => (float) $row->lat,
                    'lng' => (float) $row->lng,
                    'bearing_deg' => $row->bearing_deg !== null ? (int) $row->bearing_deg : null,
                    'distance_km' => round($distance, 3),
                ];
            })
            ->filter(fn ($d) => $d['distance_km'] <= $radiusKm)
            ->sortBy('distance_km')
            ->take($limit)
            ->values();

        $requestedPlatform = $request->header('X-Platform', 'android');
        $imageService = app(\App\Services\VehicleFamilyImageService::class);
        $familyImagesMap = $imageService->preloadForPlatform($requestedPlatform);

        $driverUserIds = $nearby->pluck('id')->all();
        $drivers = Driver::query()
            ->whereIn('user_id', $driverUserIds)
            ->with(['cityVehicleType:id,display_name', 'vehicleType:id,name'])
            ->get()
            ->keyBy('user_id');

        $nearby = $nearby->map(function ($d) use ($drivers, $imageService, $familyImagesMap, $requestedPlatform) {
            $driver = $drivers->get($d['id']);
            $familyName = $driver?->cityVehicleType?->display_name ?: ($driver?->vehicleType?->name ?: $driver?->vehicle_type);
            $preloaded = $familyImagesMap?->get(strtolower(trim($familyName ?: ''))) ?? collect();
            $cityId = $driver?->city_id;
            $imagePayload = $imageService->resolveForVehicle(
                $cityId,
                $familyName,
                $requestedPlatform,
                preloadedImages: $preloaded
            );
            $d['map_marker_url'] = $imagePayload['map_marker_url'];
            $d['image_url'] = $imagePayload['image_url'];
            $d['vehicle'] = [
                'type' => $driver?->vehicle_type,
                'brand' => $driver?->vehicle_brand,
                'model' => $driver?->vehicle_model,
                'color' => $driver?->vehicle_color,
                'reg_no' => $driver?->vehicle_reg_no,
                'image_url' => $imagePayload['image_url'],
                'map_marker_url' => $imagePayload['map_marker_url'],
            ];
            return $d;
        });

        return response()->json(['data' => $nearby]);
    }

    private function haversineKm(float $lat1, float $lng1, float $lat2, float $lng2): float
    {
        $earthKm = 6371.0;
        $dLat = deg2rad($lat2 - $lat1);
        $dLng = deg2rad($lng2 - $lng1);
        $a = sin($dLat / 2) ** 2
            + cos(deg2rad($lat1)) * cos(deg2rad($lat2)) * sin($dLng / 2) ** 2;
        $c = 2 * atan2(sqrt($a), sqrt(1 - $a));
        return $earthKm * $c;
    }

    public function uploadDocument(Request $request)
    {
        // The driver wizard sends document_id (from the dynamic catalog) +
        // image_index so each required image can live in its own slot.
        // Legacy callers may still send the document_type enum — both are accepted.
        $data = $request->validate([
            'document_id' => ['nullable', 'integer', 'exists:documents,id'],
            'vehicle_type_id' => ['nullable', 'integer', 'exists:vehicle_types,id'],
            'image_index' => ['nullable', 'integer', 'min:1', 'max:20'],
            'document_type' => ['nullable', 'in:DL,RC,INSURANCE,ID'],
            'label_values' => ['nullable'],
            'file' => ['required', 'file', 'max:25600'],
        ]);

        if (empty($data['document_id']) && empty($data['document_type'])) {
            return response()->json([
                'message' => 'Either document_id (preferred) or document_type (legacy) must be provided.',
            ], 422);
        }

        $user = $request->user();
        $driver = Driver::query()->where('user_id', $user->id)->first();
        if (!$driver) {
            return response()->json(['message' => 'Driver profile not found.'], 404);
        }

        $catalogDoc = !empty($data['document_id']) ? Document::find($data['document_id']) : null;
        $maxImages = $catalogDoc ? max(1, (int) $catalogDoc->no_of_images) : 1;

        if (isset($data['image_index'])) {
            $imageIndex = (int) $data['image_index'];
            if ($imageIndex < 1 || $imageIndex > $maxImages) {
                return response()->json([
                    'message' => "Image slot {$imageIndex} is invalid. Maximum allowed is {$maxImages}.",
                ], 422);
            }
        } else {
            $existingUploads = DriverDocument::query()->where('driver_id', $driver->id)
                ->when(!empty($data['document_id']), fn ($q) => $q->where('document_id', (int) $data['document_id']), fn ($q) => $q->where('document_type', $data['document_type']))
                ->when(array_key_exists('vehicle_type_id', $data), fn ($q) => $q->where('vehicle_type_id', $data['vehicle_type_id'] ?? null))
                ->get();

            $imageIndex = null;
            for ($i = 1; $i <= $maxImages; $i++) {
                $match = $existingUploads->firstWhere('image_index', $i);
                if (!$match || $match->status === 'rejected') {
                    $imageIndex = $i;
                    break;
                }
            }

            if ($imageIndex === null) {
                $docName = $catalogDoc?->name ?? $data['document_type'] ?? 'Document';
                return response()->json([
                    'message' => "All {$maxImages} image(s) for {$docName} have already been uploaded.",
                ], 422);
            }
        }

        // Look up an existing row with the same identity + image slot.
        // Pending/rejected rows can be replaced by the driver; approved rows
        // stay locked unless an operator changes them.
        $matcher = !empty($data['document_id'])
            ? [
                'driver_id' => $driver->id,
                'document_id' => $data['document_id'],
                'vehicle_type_id' => $data['vehicle_type_id'] ?? null,
                'image_index' => $imageIndex,
            ]
            : [
                'driver_id' => $driver->id,
                'document_type' => $data['document_type'],
                'image_index' => $imageIndex,
            ];

        $existing = DriverDocument::query()->where($matcher)->first();
        // An admin upload may have no vehicle type while the app supplies the
        // driver's current type. Neither spelling may replace an approved slot.
        $approvedSlot = DriverDocument::query()->where('driver_id', $driver->id)
            ->when(!empty($data['document_id']), fn ($q) => $q->where('document_id', $data['document_id']),
                fn ($q) => $q->whereNull('document_id')->where('document_type', $data['document_type']))
            ->where('image_index', $imageIndex)
            ->where(fn ($q) => $q->whereNull('vehicle_type_id')->orWhere('vehicle_type_id', $data['vehicle_type_id'] ?? $driver->vehicle_type_id))
            ->where('status', 'approved')->exists();
        if ($approvedSlot || ($existing && $existing->status === 'approved')) {
            return response()->json([
                'message' => 'This document image is already approved and cannot be re-uploaded.',
            ], 409);
        }

        // Allow label_values to arrive either as JSON string (multipart) or as
        // a structured array (raw JSON body). Anything else gets ignored.
        $labelValues = null;
        if (isset($data['label_values'])) {
            $labelValues = is_string($data['label_values'])
                ? json_decode($data['label_values'], true)
                : $data['label_values'];
            if (!is_array($labelValues)) {
                $labelValues = null;
            }
        }

        $file = $request->file('file');
        $path = $file->store('driver-documents', 'local');

        // Clean up the previous file on disk before overwriting its row.
        if ($existing && $existing->file_path && Storage::disk('local')->exists($existing->file_path)) {
            Storage::disk('local')->delete($existing->file_path);
        }

        $doc = DriverDocument::query()->updateOrCreate(
            $matcher,
            [
                'document_id' => $data['document_id'] ?? null,
                'vehicle_type_id' => $data['vehicle_type_id'] ?? null,
                'image_index' => $imageIndex,
                'document_type' => $data['document_type'] ?? null,
                'file_path' => $path,
                'label_values' => $labelValues,
                'status' => 'uploaded',
                'rejection_reason' => null,
            ]
        );

        // When a new document is uploaded, driver approval is reset to pending until reviewed.
        $driver->approval_status = 'pending';
        $driver->is_online = false;
        $driver->save();

        try {
            broadcast(new DriverVerificationUpdated(
                userId: (int) $user->id,
                driverId: (int) $driver->id,
                reason: 'Document uploaded. Account approval is pending review.',
                documentId: $doc->document_id,
                status: 'uploaded',
            ));
        } catch (\Throwable $e) {
            Log::warning('DriverVerificationUpdated broadcast failed', ['error' => $e->getMessage()]);
        }

        return response()->json(['document' => $doc->fresh()]);
    }

    public function deleteDocument(Request $request, DriverDocument $document)
    {
        $user = $request->user();
        $driver = Driver::query()->where('user_id', $user->id)->first();
        if (!$driver || $document->driver_id !== $driver->id) {
            abort(404);
        }

        if ($driver->approval_status === 'approved' || $document->status === 'approved') {
            return response()->json([
                'message' => 'Approved document images cannot be removed from the app.',
            ], 403);
        }

        if ($document->file_path && Storage::disk('local')->exists($document->file_path)) {
            Storage::disk('local')->delete($document->file_path);
        }

        $document->delete();

        return response()->json(['ok' => true]);
    }

    private function resolveDriverCityVehicleType(Driver $driver): ?CityVehicleType
    {
        if (!$driver->city_id) {
            return null;
        }

        if ($driver->vehicle_type_id) {
            $row = CityVehicleType::query()
                ->where('city_id', $driver->city_id)
                ->where('vehicle_type_id', $driver->vehicle_type_id)
                ->orderBy('id')
                ->first();
            if ($row) {
                return $row;
            }
        }

        if ($driver->ride_type_id) {
            return CityVehicleType::query()
                ->where('city_id', $driver->city_id)
                ->where('ride_type_id', $driver->ride_type_id)
                ->orderBy('id')
                ->first();
        }

        return null;
    }

    public function goOnline(Request $request, WalletService $walletService)
    {
        $user = $request->user();
        $driver = Driver::query()->where('user_id', $user->id)->first();
        if (!$driver) {
            return response()->json(['message' => 'Driver profile not found.'], 404);
        }

        if ($driver->approval_status !== 'approved') {
            return response()->json(['message' => 'Driver is not approved.'], 422);
        }

        $requirements = app(\App\Services\DriverDocumentRequirements::class)->forDriver($driver);
        $outstanding = array_values(array_filter($requirements, fn ($doc) => $doc['status'] !== 'approved'));
        if ($outstanding) {
            return response()->json([
                'message' => 'Required documents need attention before you can go online.',
                'error_code' => 'documents_required',
                'missing' => array_column($outstanding, 'name'),
                'document_requirements' => $requirements,
            ], 422);
        }

        // Block going online once the driver's wallet falls below the configured minimum floor.
        // If floor == 0, it means unlimited (no minimum limit blocking).
        $settings = OperatorSetting::instance();
        $floor = (float) ($settings->wallet_cash_min_capping ?? 0);
        $balance = $walletService->balance($user);

        if ($floor != 0.0 && $balance < $floor) {
            $shortfall = round($floor - $balance, 2);
            return response()->json([
                'message' => 'Your wallet balance (₹' . number_format($balance, 2) . ') is below the required limit of ₹' . number_format($floor, 2) . '. Please add at least ₹' . number_format($shortfall, 2) . ' to go online.',
                'error_code' => 'wallet_below_limit',
                'balance' => $balance,
                'limit' => $floor,
                'shortfall' => $shortfall,
            ], 422);
        }

        if (!$driver->service_scope || !$driver->service_mode) {
            return response()->json([
                'message' => 'Choose your permanent driver service before going online.',
            ], 422);
        }

        $driver->is_online = true;
        $driver->active_service_scope = $driver->service_scope;
        $driver->active_service_mode = $driver->service_mode;
        $driver->last_online_at = now();
        $driver->save();

        return response()->json(['driver' => $driver->fresh()]);
    }

    public function goOffline(Request $request)
    {
        $user = $request->user();
        $driver = Driver::query()->where('user_id', $user->id)->first();
        if (!$driver) {
            return response()->json(['message' => 'Driver profile not found.'], 404);
        }

        $driver->is_online = false;
        $driver->active_service_scope = null;
        $driver->active_service_mode = null;
        $driver->last_offline_at = now();
        $driver->save();

        return response()->json(['driver' => $driver->fresh()]);
    }

    public function setServiceMode(Request $request, DriverServiceModeService $modes)
    {
        $data = $request->validate([
            'mode' => ['nullable', 'string', 'in:private,fixed,shuttle'],
            'scope' => ['nullable', 'string', 'in:local,outstation,both'],
        ]);

        $driver = Driver::query()->where('user_id', $request->user()->id)->first();
        if (!$driver) {
            return response()->json(['message' => 'Driver profile not found.'], 404);
        }

        return response()->json([
            'driver' => $modes->setMode($driver, $data['mode'] ?? null, $data['scope'] ?? null),
        ]);
    }

    /**
     * Presence heartbeat from the driver app while online (no trip in flight).
     * Inserts a driver_locations row with trip_id=null so the dispatch snapshot
     * has a fresh ping for "Free" classification. Trip-time pings still go
     * through TripTrackingController@updateLocation.
     */
    public function pingLocation(Request $request, FixedStopAutomationService $fixedStops, ShuttleStopAutomationService $shuttleStops)
    {
        $data = $request->validate([
            'lat' => ['required', 'numeric', 'between:-90,90'],
            'lng' => ['required', 'numeric', 'between:-180,180'],
            'accuracy_m' => ['nullable', 'numeric', 'min:0'],
            'speed_kmh' => ['nullable', 'numeric', 'min:0'],
            'bearing_deg' => ['nullable', 'integer', 'min:0', 'max:360'],
        ]);

        $user = $request->user();
        $driver = Driver::query()->where('user_id', $user->id)->first();
        if (!$driver) {
            return response()->json(['message' => 'Driver profile not found.'], 404);
        }

        // Scope the throttle to *presence* rows (trip_id IS NULL) so the 5s
        // trip-location stream doesn't starve the 10s presence ping. They
        // share the same table but serve different purposes — interleaving
        // them would let one block the other indefinitely.
        $minIntervalSeconds = 5;
        $last = DriverLocation::query()
            ->where('driver_id', $user->id)
            ->whereNull('trip_id')
            ->orderByDesc('recorded_at')
            ->first();

        if ($last && $last->recorded_at) {
            $ageSeconds = now()->getTimestamp() - $last->recorded_at->getTimestamp();
            if ($ageSeconds < $minIntervalSeconds) {
                return response()->json([
                    'message' => 'Throttled',
                    'location' => $last,
                ], 429);
            }
        }

        $location = DriverLocation::query()->create([
            'driver_id' => $user->id,
            'trip_id' => null,
            'lat' => (float) $data['lat'],
            'lng' => (float) $data['lng'],
            'accuracy_m' => $data['accuracy_m'] ?? null,
            'speed_kmh' => $data['speed_kmh'] ?? null,
            'bearing_deg' => $data['bearing_deg'] ?? null,
            'recorded_at' => now(),
        ]);

        // Every ping is a liveness signal: stamp last_online_at so the reaper
        // and admin freshness checks know the driver is still reachable. If the
        // reaper had already flipped is_online=false because of a transient
        // network drop, this ping re-asserts that they're online.
        $driver->forceFill([
            'is_online' => true,
            'last_online_at' => now(),
        ])->save();

        broadcast(new DispatchDriverLocationUpdated(
            location: $location->fresh(),
            driver: $driver->fresh(['user', 'vehicleTypeRef']),
        ))->toOthers();

        $fixedStops->processDriverLocation($user->id, (float) $data['lat'], (float) $data['lng']);
        $shuttleStops->processDriverLocation($user->id, (float) $data['lat'], (float) $data['lng']);

        return response()->json(['location' => $location]);
    }
}
