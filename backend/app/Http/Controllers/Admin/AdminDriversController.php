<?php

namespace App\Http\Controllers\Admin;

use App\Events\DriverVerificationUpdated;
use App\Models\City;
use App\Models\Document;
use App\Models\Driver;
use App\Models\RouteGroup;
use App\Models\CityVehicleType;
use App\Models\DriverDocument;
use App\Models\DriverSubscription;
use App\Models\Trip;
use App\Models\User;
use App\Models\WalletTransaction;
use App\Services\PayoutLedgerService;
use App\Services\ManagerScope;
use App\Services\SmsService;
use App\Services\WalletService;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;
use Illuminate\Validation\Rule;
use Symfony\Component\HttpFoundation\StreamedResponse;

class AdminDriversController
{
    public function __construct(
        private readonly WalletService $walletService,
        private readonly PayoutLedgerService $payoutLedger,
        private readonly SmsService $smsService,
    ) {
    }

    /**
     * Lists drivers for the admin panel.
     *
     * Filters (all optional):
     *   - state:        active (default) | deactivated
     *   - vehicle_type: exact match against drivers.vehicle_type
     *   - q:            substring match against driver id, user.name, user.phone,
     *                   user.email, drivers.vehicle_reg_no
     *   - per_page:     pagination size (default 50)
     */
    public function index(Request $request)
    {
        $allowedCities = ManagerScope::cityIds($request->user());
        $drivers = $this->buildIndexQuery($request)->with(['city:id,name', 'cities:id,name'])->paginate(
            (int) ($request->query('per_page') ?? 50)
        );

        $userIds = $drivers->getCollection()->pluck('user_id');
        $groups = RouteGroup::query()
            ->whereHas('drivers', fn ($q) => $q->whereIn('users.id', $userIds))
            ->when($request->integer('city_id'), fn ($q, $cityId) => $q->where('city_id', $cityId))
            ->with(['drivers:id', 'routes:id', 'city:id,name'])->orderBy('name')->get();
        $drivers->getCollection()->transform(function (Driver $d) use ($groups, $allowedCities) {
            $assigned = $groups->filter(fn ($g) => $g->drivers->contains('id', $d->user_id));
            $cities = $d->city ? $d->cities->concat([$d->city]) : $d->cities;
            return $this->shapeRow($d) + [
                'cities' => $cities->filter(fn ($city) => $allowedCities === null || in_array($city->id, $allowedCities, true))
                    ->unique('id')->sortBy('name')->map(fn ($city) => ['id' => $city->id, 'name' => $city->name])->values(),
                'route_groups' => $assigned->map(fn ($g) => ['id' => $g->id, 'name' => $g->name,
                    'city_name' => $g->city?->name, 'is_active' => $g->is_active])->values(),
                'allocated_route_count' => $assigned->flatMap(fn ($g) => $g->routes->pluck('id'))->unique()->count(),
            ];
        });

        return response()->json(['data' => $drivers, 'allocation_filters_supported' => true]);
    }

    public function cityCounts(Request $request)
    {
        $allowedCities = ManagerScope::cityIds($request->user());
        $drivers = $this->locationDrivers($request);
        // A driver can have the same city on both the original row and the pivot.
        $memberships = (clone $drivers)->select('drivers.id as driver_id', 'drivers.city_id')
            ->whereNotNull('drivers.city_id')
            ->union($drivers->join('driver_city', 'driver_city.driver_id', '=', 'drivers.id')
                ->select('drivers.id as driver_id', 'driver_city.city_id'));
        $counts = DB::query()->fromSub($memberships, 'memberships')
            ->selectRaw('city_id, COUNT(*) as driver_count')->groupBy('city_id');

        $cities = City::query()
            ->when($allowedCities !== null, fn ($query) => $query->whereIn('cities.id', $allowedCities))
            ->leftJoinSub($counts, 'counts', 'cities.id', '=', 'counts.city_id')
            ->orderBy('cities.name')->orderBy('cities.id')
            ->get(['cities.id', 'cities.name', 'counts.driver_count']);

        return response()->json(['data' => $cities->map(fn (City $city) => [
            'id' => $city->id,
            'name' => $city->name,
            'driver_count' => (int) $city->driver_count,
        ])]);
    }

    public function cityStands(Request $request, City $city)
    {
        $drivers = $this->locationDrivers($request)->forCity($city->id);
        $counts = DB::table('driver_route_group')->whereIn('driver_user_id', $drivers->select('drivers.user_id')->toBase())
            ->selectRaw('route_group_id, COUNT(DISTINCT driver_user_id) as driver_count')
            ->groupBy('route_group_id');
        $stands = RouteGroup::query()->where('route_groups.city_id', $city->id)
            ->leftJoinSub($counts, 'counts', 'route_groups.id', '=', 'counts.route_group_id')
            ->orderBy('route_groups.name')->orderBy('route_groups.id')
            ->get(['route_groups.id', 'route_groups.name', 'route_groups.is_active', 'counts.driver_count']);

        return response()->json([
            'data' => $stands->map(fn (RouteGroup $stand) => [
                'id' => $stand->id,
                'name' => $stand->name,
                'is_active' => $stand->is_active,
                'driver_count' => (int) $stand->driver_count,
            ]),
        ]);
    }

    private function locationDrivers(Request $request): \Illuminate\Database\Eloquent\Builder
    {
        $fleets = ManagerScope::fleetIds($request->user());

        return Driver::query()->when($fleets !== null, fn ($query) => $query->whereIn('drivers.fleet_id', $fleets));
    }

    /**
     * Streams the same filtered set as a CSV download.
     */
    public function exportCsv(Request $request): StreamedResponse
    {
        $query = $this->buildIndexQuery($request);
        $state = strtolower((string) $request->query('state', 'active'));
        $filename = 'drivers-' . $state . '-' . now()->format('Ymd-His') . '.csv';

        $columns = [
            'driver_id', 'name', 'phone', 'email', 'vehicle_type', 'vehicle_reg_no',
            'approval_status', 'is_online', 'registered_on', 'last_login',
            'rides_7d', 'rides_30d', 'total_rides', 'last_ride_on',
            'deactivated_at', 'deactivated_reason',
        ];

        return response()->streamDownload(function () use ($query, $columns) {
            $out = fopen('php://output', 'w');
            fputcsv($out, $columns);

            $query->cursor()->each(function (Driver $d) use ($out) {
                $row = $this->shapeRow($d);
                fputcsv($out, [
                    $row['id'],
                    $row['user']['name'] ?? '',
                    $row['user']['phone'] ?? '',
                    $row['user']['email'] ?? '',
                    $row['vehicle_type'] ?? '',
                    $row['vehicle_reg_no'] ?? '',
                    $row['approval_status'],
                    $row['is_online'] ? 'yes' : 'no',
                    $row['registered_on'],
                    $row['last_login'] ?? '',
                    $row['rides_7d'],
                    $row['rides_30d'],
                    $row['total_rides'],
                    $row['last_ride_on'] ?? '',
                    $row['deactivated_at'] ?? '',
                    $row['deactivated_reason'] ?? '',
                ]);
            });

            fclose($out);
        }, $filename, [
            'Content-Type' => 'text/csv',
        ]);
    }

    public function setApproval(Request $request, Driver $driver)
    {
        $data = $request->validate([
            'approval_status' => ['required', 'in:approved,rejected'],
            'rejection_reason' => ['nullable', 'string', 'max:1000'],
        ]);

        if ($data['approval_status'] === 'approved') {
            // The dynamic catalog (documents.required = 'mandatory_register')
            // is the source of truth now. Each mandatory document must have all
            // of its required image slots approved before the driver can move
            // to approved.
            $mandatoryDocs = \App\Models\Document::query()
                ->forDrivers()
                ->where('required', 'mandatory_register')
                ->get(['id', 'name', 'no_of_images']);

            $missing = [];
            if ($mandatoryDocs->isNotEmpty()) {
                $approvedUploads = DriverDocument::query()
                    ->where('driver_id', $driver->id)
                    ->whereIn('document_id', $mandatoryDocs->pluck('id'))
                    ->where('status', 'approved')
                    ->get(['id', 'document_id', 'image_index'])
                    ->groupBy('document_id');

                foreach ($mandatoryDocs as $doc) {
                    $requiredSlots = max(1, (int) ($doc->no_of_images ?? 1));
                    $rows = $approvedUploads->get($doc->id, collect());
                    $approvedSlots = $rows
                        ->map(fn (DriverDocument $row) => $row->image_index !== null ? 'i:' . $row->image_index : 'r:' . $row->id)
                        ->unique()
                        ->count();

                    if ($approvedSlots < $requiredSlots) {
                        $missing[] = sprintf('%s (%d/%d)', $doc->name, $approvedSlots, $requiredSlots);
                    }
                }
            }

            // Legacy DL/RC/INSURANCE/ID rows: only block when one of them is
            // explicitly present-but-not-approved. We don't *require* them
            // anymore — fresh drivers come through the new flow only.
            $legacyPending = DriverDocument::query()
                ->where('driver_id', $driver->id)
                ->whereNull('document_id')
                ->whereNotNull('document_type')
                ->where('status', '!=', 'approved')
                ->pluck('document_type')
                ->all();
            $missing = array_merge($missing, $legacyPending);

            if (!empty($missing)) {
                return response()->json([
                    'message' => 'All required documents must be approved before approving the driver.',
                    'missing' => array_values(array_unique($missing)),
                ], 422);
            }

            $driver->approval_status = 'approved';
            $driver->approved_at = now();
            $driver->rejected_at = null;
        } else {
            $driver->approval_status = 'rejected';
            $driver->rejected_at = now();
            $driver->approved_at = null;
            $driver->is_online = false;
        }

        $driver->save();

        if ($driver->user_id) {
            try {
                broadcast(new DriverVerificationUpdated(
                    (int) $driver->user_id,
                    (int) $driver->id,
                    'approval_status',
                    null,
                    $driver->approval_status,
                ));
            } catch (\Throwable $e) {
                Log::warning('DriverVerificationUpdated broadcast failed', ['error' => $e->getMessage()]);
            }
        }

        return response()->json(['driver' => $driver->fresh()]);
    }

    public function setDocumentStatus(Request $request, DriverDocument $document)
    {
        $data = $request->validate([
            'status' => ['required', 'in:approved,rejected'],
            'rejection_reason' => ['nullable', 'string', 'max:1000'],
        ]);

        // Force the operator to give a reason on rejection so the driver gets
        // actionable feedback in the mobile app.
        if ($data['status'] === 'rejected' && empty(trim((string) ($data['rejection_reason'] ?? '')))) {
            return response()->json([
                'message' => 'A rejection reason is required when rejecting a document.',
            ], 422);
        }

        // Block document approval until the operator has set the driver's
        // vehicle registration number. Approving a document for a vehicle that
        // has no plate on file leaves the driver in an inconsistent state
        // (the dispatch flow keys off vehicle_reg_no).
        if ($data['status'] === 'approved') {
            $driver = $document->driver;
            if (!$driver || empty(trim((string) ($driver->vehicle_reg_no ?? '')))) {
                return response()->json([
                    'message' => 'Please register vehicle number first.',
                ], 422);
            }
        }

        $query = DriverDocument::query()
            ->where('driver_id', $document->driver_id);

        if ($document->document_id !== null) {
            $query->where('document_id', $document->document_id);
            if ($document->vehicle_type_id !== null) {
                $query->where('vehicle_type_id', $document->vehicle_type_id);
            } else {
                $query->whereNull('vehicle_type_id');
            }
        } else {
            $query->whereKey($document->id);
        }

        $query->update([
            'status' => $data['status'],
            'rejection_reason' => $data['status'] === 'rejected'
                ? trim($data['rejection_reason'])
                : null,
        ]);

        $freshDocument = $document->fresh('driver');
        if ($freshDocument?->driver?->user_id) {
            try {
                broadcast(new DriverVerificationUpdated(
                    (int) $freshDocument->driver->user_id,
                    (int) $freshDocument->driver_id,
                    'document_status',
                    (int) $freshDocument->id,
                    $freshDocument->status,
                ));
            } catch (\Throwable $e) {
                Log::warning('DriverVerificationUpdated broadcast failed', ['error' => $e->getMessage()]);
            }
        }

        return response()->json(['document' => $freshDocument]);
    }

    /**
     * Full driver profile used by the Approval Details page. Bundles the
     * driver row, the user, ride_type / vehicle_type labels, and every
     * uploaded document with its catalog name + label values.
     */
    public function fullProfile(Driver $driver)
    {
        $driver->load(['user', 'rideType', 'vehicleTypeRef', 'cityVehicleType', 'cities:id,name', 'city:id,name']);

        $docs = DriverDocument::query()
            ->where('driver_id', $driver->id)
            ->with(['document.labels', 'vehicleType'])
            ->orderByDesc('id')
            ->get()
            ->map(fn (DriverDocument $d) => [
                'id' => $d->id,
                'document_id' => $d->document_id,
                'document_name' => $d->document?->name,
                'document_type' => $d->document_type, // legacy enum
                'image_index' => $d->image_index,
                'vehicle_type_id' => $d->vehicle_type_id,
                'vehicle_type_name' => $d->vehicleType?->name,
                'file_path' => $d->file_path,
                'file_url' => route('admin.drivers.documents.file', [
                    'driver' => $driver->id,
                    'document' => $d->id,
                ]),
                'label_values' => $d->label_values,
                'labels_meta' => $d->document?->labels->map(fn ($l) => [
                    'label' => $l->label,
                    'label_type' => $l->label_type,
                    'mandatory' => (bool) $l->mandatory,
                ])->all() ?? [],
                'status' => $d->status,
                'rejection_reason' => $d->rejection_reason,
                'uploaded_at' => optional($d->created_at)->toIso8601String(),
            ]);

        return response()->json([
            'driver' => [
                'id' => $driver->id,
                'user_id' => $driver->user_id,
                'name' => $driver->user?->name,
                'phone' => $driver->user?->phone,
                'email' => $driver->user?->email,
                'avatar_path' => $driver->user?->avatar_path,
                'avatar_url' => $this->avatarUrl($driver->user?->avatar_path),
                'ride_type_id' => $driver->ride_type_id,
                'ride_type_name' => $driver->rideType?->name,
                'vehicle_type_id' => $driver->vehicle_type_id,
                'vehicle_type_name' => $driver->vehicleTypeRef?->name,
                'city_vehicle_type_id' => $driver->city_vehicle_type_id,
                'city_vehicle_type_name' => $driver->cityVehicleType?->display_name,
                'vehicle_reg_no' => $driver->vehicle_reg_no,
                'vehicle_model' => $driver->vehicle_model,
                'vehicle_color' => $driver->vehicle_color,
                'city_id' => $driver->city_id,
                'city_ids' => $driver->city_ids,
                'cities' => $driver->cities->map(fn ($c) => ['id' => $c->id, 'name' => $c->name])->values(),
                'city_name' => $driver->city?->name,
                'city_names' => $driver->cities->pluck('name')->join(', '),
                'service_scope' => $driver->service_scope,
                'service_mode' => $driver->service_mode,
                'approval_status' => $driver->approval_status,
                // Payout account ("driver KYC") — informational on the approval
                // panel. Verification is skippable, so it never blocks approval.
                'payout_account_status' => $driver->user?->payout_account_status ?? 'none',
                'payout_can_receive' => (bool) $driver->user?->hasVerifiedPayoutAccount(),
                'deactivated_at' => optional($driver->deactivated_at)->toIso8601String(),
                'is_online' => $driver->isOnlineFresh(),
                'created_at' => optional($driver->created_at)->toIso8601String(),
            ],
            'documents' => $docs,
            'document_requirements' => app(\App\Services\DriverDocumentRequirements::class)->forDriver($driver),
        ]);
    }

    /**
     * Driver dashboard profile for the admin detail page. Mirrors the customer
     * `show()` shape but with driver-specific fields (vehicle, rating, online,
     * approval). Wallet and rides all hang off the driver's user
     * account (trips.driver_id points to users.id).
     */
    public function profile(Driver $driver)
    {
        $driver->load([
            'rideType:id,name',
            'vehicleTypeRef:id,name',
            'cityVehicleType:id,display_name',
            'city:id,name',
            'cities:id,name',
        ]);

        $user = $driver->user;

        $totalRides = Trip::query()
            ->where('driver_id', $driver->user_id)
            ->where('status', 'COMPLETED')
            ->count();

        $activeSub = DriverSubscription::query()
            ->where('driver_user_id', $driver->user_id)
            ->where('status', DriverSubscription::STATUS_ACTIVE)
            ->where('is_queued', false)
            ->with(['plan'])
            ->latest('id')
            ->first();

        return response()->json([
            'driver' => [
                'id' => $driver->id,
                'user_id' => $driver->user_id,
                'name' => $user?->name,
                'phone' => $user?->phone,
                'email' => $user?->email,
                'avatar_path' => $user?->avatar_path,
                'avatar_url' => $this->avatarUrl($user?->avatar_path),
                'dob' => $user?->dob ? (is_string($user->dob) ? substr($user->dob, 0, 10) : optional($user->dob)->format('Y-m-d')) : null,
                'address' => $user?->address,
                'date_registered' => optional($driver->created_at)->toIso8601String(),
                'last_login_at' => optional($user?->last_login_at)->toIso8601String(),
                'app_version' => $user?->app_version,
                'os_version' => $user?->os_version,
                'device_type' => $user?->device_type,
                'push_unsubscribed' => (bool) $user?->push_unsubscribed,
                'ride_type_name' => $driver->rideType?->name,
                'vehicle_type_id' => $driver->vehicle_type_id,
                'vehicle_type_name' => $driver->vehicleTypeRef?->name,
                'city_vehicle_type_id' => $driver->city_vehicle_type_id,
                'city_vehicle_type_name' => $driver->cityVehicleType?->display_name,
                'vehicle_type' => $driver->vehicle_type,
                'vehicle_model' => $driver->vehicle_model,
                'vehicle_color' => $driver->vehicle_color,
                'vehicle_reg_no' => $driver->vehicle_reg_no,
                'city_id' => $driver->city_id,
                'city_ids' => $driver->city_ids,
                'cities' => $driver->cities->map(fn ($c) => ['id' => $c->id, 'name' => $c->name])->values(),
                'city_name' => $driver->city?->name,
                'city_names' => $driver->cities->pluck('name')->join(', '),
                'service_scope' => $driver->service_scope,
                'service_mode' => $driver->service_mode,
                'approval_status' => $driver->approval_status,
                'is_online' => $driver->isOnlineFresh(),
                'is_suspended' => (bool) $user?->is_suspended,
                'suspended_reason' => $user?->suspended_reason,
                'suspended_at' => optional($user?->suspended_at)->toIso8601String(),
                'is_active' => $driver->deactivated_at === null,
                'deactivated_at' => optional($driver->deactivated_at)->toIso8601String(),
                'deactivated_reason' => $driver->deactivated_reason,
                'rating_avg' => $driver->rating_avg,
                'rating_count' => $driver->rating_count,
                'wallet_balance' => $user ? $this->walletService->balance($user) : 0,
                'total_rides' => $totalRides,
                'current_lat' => $user?->current_lat,
                'current_lng' => $user?->current_lng,
                'current_location_updated_at' => $user?->current_location_updated_at,
                'payout_account_status' => $user?->payout_account_status ?? 'none',
                'payout_method' => $user?->payout_method,
                'payout_beneficiary_name' => $user?->payout_beneficiary_name,
                'payout_bank_last4' => $user?->payout_bank_last4,
                'payout_ifsc' => $user?->payout_ifsc,
                'payout_upi' => $user?->payout_upi,
                'active_subscription' => $activeSub ? [
                    'id' => $activeSub->id,
                    'plan_title' => $activeSub->plan?->title ?? 'Subscription Plan',
                    'amount_paid' => (float) $activeSub->amount_paid,
                    'commission_percent' => (float) $activeSub->commission_percent,
                    'pricing_model' => $activeSub->pricing_model,
                    'payment_method' => $activeSub->payment_method ?? 'wallet',
                    'starts_at' => optional($activeSub->starts_at)->toIso8601String(),
                    'expires_at' => optional($activeSub->expires_at)->toIso8601String(),
                    'auto_renew' => (bool) $activeSub->auto_renew,
                ] : null,
            ],
        ]);
    }

    public function unsubscribe(Request $request, Driver $driver)
    {
        $data = $request->validate([
            "push" => ["nullable", "boolean"],
        ]);

        $user = $driver->user;
        if (!$user) {
            abort(404, "Driver user account not found.");
        }

        if (array_key_exists("push", $data)) {
            $user->push_unsubscribed = (bool) $data["push"];
        }
        $user->save();

        return response()->json([
            "message" => "Push preference updated.",
            "driver" => $driver->fresh("user"),
        ]);
    }

    /**
     * Admin convenience OTP ("read me the code you just got") — mirrors the
     * customer flow. Does NOT verify anything; app login is unaffected.
     */
    public function sendOtp(Driver $driver, \App\Services\PhoneOtpService $phoneOtpService)
    {
        $user = $driver->user;
        if (!$user?->phone) {
            return response()->json(['message' => 'Driver has no phone on file.'], 422);
        }

        $res = $phoneOtpService->start($user->phone, 'driver');
        if (!($res['sent'] ?? false)) {
            $cooldown = $res['cooldown'] ?? 30;
            return response()->json([
                'message' => "Please wait {$cooldown} seconds before resending OTP.",
            ], 429);
        }

        Log::info('admin.driver.send_otp', [
            'driver_id' => $driver->id,
            'phone' => $user->phone,
        ]);

        return response()->json([
            'message' => 'OTP sent successfully.',
        ]);
    }

    public function block(Request $request, Driver $driver)
    {
        $data = $request->validate([
            'reason' => ['required', 'string', 'max:500'],
        ]);

        $user = $driver->user;
        if (!$user) {
            abort(404, 'Driver user account not found.');
        }

        $user->is_suspended = true;
        $user->suspended_reason = $data['reason'];
        $user->suspended_at = now();
        $user->save();

        // A blocked driver must not keep receiving dispatches.
        $driver->is_online = false;
        $driver->save();

        return response()->json(['message' => 'Driver blocked.', 'driver' => $driver->fresh('user')]);
    }

    public function unblock(Driver $driver)
    {
        $user = $driver->user;
        if (!$user) {
            abort(404, 'Driver user account not found.');
        }

        $user->is_suspended = false;
        $user->suspended_reason = null;
        $user->suspended_at = null;
        $user->save();

        return response()->json(['message' => 'Driver unblocked.', 'driver' => $driver->fresh('user')]);
    }

    public function verifyPayoutAccount(Driver $driver)
    {
        $user = $driver->user;
        if (! $user) {
            abort(404, 'Driver user account not found.');
        }

        /** @var \App\Services\PayoutAccountService $payoutService */
        $payoutService = app(\App\Services\PayoutAccountService::class);
        $payoutService->markVerified($user);

        /** @var \App\Services\HeldEarningsService $heldService */
        $heldService = app(\App\Services\HeldEarningsService::class);
        $res = $heldService->releaseAllForDriver($user);

        return response()->json([
            'message' => 'Driver payout account verified and held earnings released.',
            'released_count' => $res['released'] ?? 0,
            'released_amount' => ($res['amount_paise'] ?? 0) / 100,
            'payout_status' => $user->fresh()->payout_account_status,
        ]);
    }

    public function destroy(Request $request, Driver $driver)
    {
        $data = $request->validate([
            'reason' => ['required', 'string', 'max:50'],
        ]);

        $user = $driver->user;
        if (!$user) {
            abort(404, 'Driver user account not found.');
        }

        // Mirror the customer delete: stash the reason for later audit, then
        // soft-delete the account. The driver profile is deactivated too so it
        // drops out of the active roster immediately.
        $user->suspended_reason = '[DELETED] ' . $data['reason'];
        $user->suspended_at = now();
        $user->save();

        $driver->deactivated_at = now();
        $driver->deactivated_reason = '[DELETED] ' . $data['reason'];
        $driver->is_online = false;
        $driver->save();

        $user->delete();

        return response()->json(['message' => 'Driver deleted.']);
    }

    public function rides(Driver $driver)
    {
        return response()->json($this->driverRidesPayload($driver, cancelled: false));
    }

    public function cancelledRides(Driver $driver)
    {
        return response()->json($this->driverRidesPayload($driver, cancelled: true));
    }

    /**
     * Rides feed for the driver detail page. A driver's row is the vehicle-level
     * trip. For a fixed/shuttle trip the riders live in seat_reservations on the
     * departure, so the rider name(s) + collected payment/refunds are resolved
     * from there; a solo/private trip carries its own customer_id + fare instead.
     */
    private function driverRidesPayload(Driver $driver, bool $cancelled): array
    {
        $trips = Trip::query()
            ->where('driver_id', $driver->user_id)
            ->when(
                $cancelled,
                fn ($q) => $q->where('status', 'CANCELLED'),
                fn ($q) => $q->where('status', '!=', 'CANCELLED'),
            )
            ->with(['customer:id,name', 'rideType:id,name', 'route:id,mode,name', 'routeDeparture.route:id,mode,name'])
            ->orderByDesc('created_at')
            ->limit(200)
            ->get();

        // Batch-load the passenger seats for every fixed departure in one query
        // (kept out of the trip payload — we only read names/amounts off them).
        $departureIds = $trips->pluck('route_departure_id')->filter()->unique()->values();
        $seatsByDeparture = $departureIds->isEmpty()
            ? collect()
            : \App\Models\SeatReservation::query()
                ->whereIn('route_departure_id', $departureIds)
                ->with('customer:id,name')
                ->get()
                ->groupBy('route_departure_id');

        $rows = $trips->map(fn (Trip $t) => $this->driverRideRow(
            $t,
            $t->route_departure_id ? ($seatsByDeparture[$t->route_departure_id] ?? collect()) : collect(),
        ));

        return [
            'data' => ['data' => $rows->values()],
            'summary' => [
                'rides_count' => $rows->count(),
                'fares_collected' => round((float) $rows->sum(fn ($r) => $r['paid_amount'] ?? 0), 2),
                'refunded' => round((float) $rows->sum(fn ($r) => $r['refund_amount'] ?? 0), 2),
            ],
        ];
    }

    /**
     * @param  \Illuminate\Support\Collection<int, \App\Models\SeatReservation>  $seats
     */
    private function driverRideRow(Trip $t, $seats): array
    {
        $row = $t->toArray();

        $riderName = $t->customer?->name;
        $riderExtra = 0;
        $paidAmount = (float) ($t->final_fare ?? $t->estimated_fare ?? 0);
        $refundAmount = 0.0;   // money actually returned (REFUNDED)
        $refundDue = 0.0;      // owed but not yet paid out (APPROVED)
        $paymentMethod = $t->payment_method;
        $paymentStatus = $t->payment_method ? 'PAID' : null;

        if ($t->route_departure_id !== null) {
            // Prefer the seats linked to THIS trip; fall back to the whole
            // departure if none are linked yet (trip just started).
            $mine = $seats->where('trip_id', $t->id)->values();
            if ($mine->isEmpty()) {
                $mine = $seats->values();
            }

            $names = $mine->map(fn ($r) => $r->customer?->name)->filter()->values();
            $riderName = $names->first();
            $riderExtra = max(0, $names->count() - 1);

            $paidAmount = (float) $mine->where('payment_status', 'PAID')->sum('fare_amount');
            $refundAmount = (float) $mine->where('refund_status', 'REFUNDED')->sum('refund_amount');
            $refundDue = (float) $mine->where('refund_status', 'APPROVED')->sum('refund_amount');

            $methods = $mine->pluck('payment_method')->filter()->unique();
            $paymentMethod = $methods->count() === 1 ? $methods->first() : ($methods->count() > 1 ? 'mixed' : null);
            $allPaid = $mine->isNotEmpty() && $mine->every(fn ($r) => $r->payment_status === 'PAID');
            $paymentStatus = $allPaid ? 'PAID' : ($paidAmount > 0 ? 'PARTIAL' : 'PENDING');
        }

        $row['rider_name'] = $riderName;
        $row['rider_extra_count'] = $riderExtra;
        $row['payment_method'] = $paymentMethod;
        $row['payment_status'] = $paymentStatus;
        $row['paid_amount'] = round($paidAmount, 2);
        $row['refund_amount'] = round($refundAmount, 2);
        $row['refund_due'] = round($refundDue, 2);
        $row['refund_status'] = $refundAmount > 0 ? 'REFUNDED' : ($refundDue > 0 ? 'APPROVED' : 'NONE');

        return $row;
    }

    public function walletTransactions(Driver $driver)
    {
        $rows = WalletTransaction::query()
            ->where('user_id', $driver->user_id)
            ->with(['createdBy:id,name'])
            ->orderByDesc('created_at')
            ->paginate(50);

        return response()->json(['data' => $rows]);
    }

    /**
     * Pending driver transfers worklist: every driver the operator owes money to
     * (online fares/deposits/coupon reimbursements held by operator > transfers made).
     */
    public function payoutsDue()
    {
        return response()->json($this->payoutLedger->pendingTransfersWorklist());
    }

    /**
     * Summary for the Record-transfer modal: money collected vs transferred.
     */
    public function payoutSummary(Driver $driver)
    {
        $user = $driver->user;
        if (! $user) {
            return response()->json(['message' => 'This driver has no linked user account.'], 422);
        }

        $summary = $this->payoutLedger->summary($user);
        $walletBalance = $this->walletService->balance($user);

        return response()->json([
            'money_collected' => $summary['money_collected'],
            'money_transferred' => $summary['money_transferred'],
            'pending_payout' => $summary['pending_payout'],
            'completed_payout' => $summary['completed_payout'],
            // Aliases for Driver Detail modal
            'balance' => $walletBalance,
            'earned_remaining' => $summary['pending_payout'],
            'deposits_remaining' => max(0.0, $walletBalance),
            'total_paid_out' => $summary['completed_payout'],
            'payout_method' => $user->payout_method,
            'payout_beneficiary_name' => $user->payout_beneficiary_name,
            'payout_bank_last4' => $user->payout_bank_last4,
            'payout_ifsc' => $user->payout_ifsc,
            'payout_upi' => $user->payout_upi,
            'phone' => $user->phone,
            'name' => $user->name,
        ]);
    }

    /**
     * Record a payout transfer from operator to driver (GPay/bank/cash/upi).
     * Records into DriverPayoutLedger (System 2: Payout Ledger).
     * NEVER debits or modifies driver's wallet (System 1: Wallet).
     */
    public function recordPayout(Request $request, Driver $driver)
    {
        $data = $request->validate([
            'amount' => ['required', 'numeric', 'min:0.01', 'max:10000000'],
            'method' => ['required', 'in:gpay,bank,cash,upi,other'],
            'reference' => ['nullable', 'string', 'max:120'],
            'note' => ['nullable', 'string', 'max:300'],
        ]);

        $user = $driver->user;
        if (!$user) {
            return response()->json(['message' => 'This driver has no linked user account.'], 422);
        }

        $amount = round((float) $data['amount'], 2);

        try {
            $transfer = $this->payoutLedger->recordTransfer(
                $user,
                $amount,
                $data['method'],
                $data['reference'] ?? null,
                $data['note'] ?? null,
                $request->user(),
            );
        } catch (\RuntimeException $e) {
            return response()->json(['message' => $e->getMessage()], 422);
        }

        return response()->json([
            'message' => 'Payout transfer recorded successfully.',
            'transfer' => $transfer,
            'summary' => $this->payoutLedger->summary($user),
        ], 201);
    }

    /**
     * Driver's standalone wallet breakdown & transactions (platform charges only).
     */
    public function wallet(Driver $driver)
    {
        $user = $driver->user;
        if (!$user) {
            return response()->json(['message' => 'This driver has no linked user account.'], 422);
        }

        $breakdown = $this->walletService->breakdown($user);
        $transactions = WalletTransaction::query()
            ->where('user_id', $user->id)
            ->with('createdBy:id,name')
            ->orderByDesc('id')
            ->limit(100)
            ->get();

        return response()->json([
            'breakdown' => $breakdown,
            'transactions' => $transactions,
        ]);
    }

    /**
     * Admin manual wallet adjustment (credit or debit platform charges).
     */
    public function adjustWallet(Request $request, Driver $driver)
    {
        $data = $request->validate([
            'type' => ['required', 'in:credit,debit'],
            'amount' => ['required', 'numeric', 'min:0.01', 'max:1000000'],
            'reason' => ['required', 'string', 'max:255'],
        ]);

        $user = $driver->user;
        if (!$user) {
            return response()->json(['message' => 'This driver has no linked user account.'], 422);
        }

        $amount = round((float) $data['amount'], 2);
        $type = $data['type'] === 'credit' ? WalletTransaction::TYPE_CREDIT : WalletTransaction::TYPE_DEBIT;

        if ($type === WalletTransaction::TYPE_DEBIT) {
            try {
                $this->walletService->universalValidation($user, $amount);
            } catch (\RuntimeException $e) {
                return response()->json(['message' => $e->getMessage()], 422);
            }
        }

        $txn = $this->walletService->recordTransaction(
            $user,
            $type,
            $amount,
            $data['reason'],
            null,
            $request->user()
        );

        return response()->json([
            'message' => 'Wallet balance adjusted.',
            'transaction' => $txn,
            'breakdown' => $this->walletService->breakdown($user),
        ], 201);
    }

    /**
     * Driver's earnings & payouts summary.
     */
    public function settlement(Driver $driver)
    {
        $user = $driver->user;
        if (! $user) {
            return response()->json(['message' => 'This driver has no linked user account.'], 422);
        }

        return response()->json([
            'earnings' => $this->payoutLedger->earningsSummary($user),
            'payout_summary' => $this->payoutLedger->summary($user),
            'transfers' => \App\Models\DriverPayoutLedger::query()
                ->where('driver_user_id', $user->id)
                ->where('type', \App\Models\DriverPayoutLedger::TYPE_TRANSFER)
                ->with('createdBy:id,name')
                ->orderByDesc('created_at')
                ->limit(50)
                ->get(),
        ]);
    }

    /**
     * Stream a document file back to the admin. Files are stored on the
     * non-public disk so a direct URL won't work — this endpoint
     * authenticates the request and pipes the bytes through.
     */
    public function documentFile(Driver $driver, DriverDocument $document)
    {
        if ($document->driver_id !== $driver->id) {
            abort(404);
        }
        if (!$document->file_path || !Storage::disk('local')->exists($document->file_path)) {
            abort(404, 'File not found on disk.');
        }

        $mime = Storage::disk('local')->mimeType($document->file_path) ?: 'application/octet-stream';
        $filename = basename($document->file_path);
        $download = request()->boolean('download');

        return response()->stream(
            function () use ($document) {
                $stream = Storage::disk('local')->readStream($document->file_path);
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
     * Admin uploads a document on behalf of a driver (e.g. when paperwork
     * arrives in person). Same payload shape as the driver-mobile upload —
     * document_id is preferred, vehicle_type_id is optional, label_values
     * accepted as JSON string or array.
     */
    public function uploadDocument(Request $request, Driver $driver)
    {
        $data = $request->validate([
            'document_id' => ['nullable', 'integer', 'exists:documents,id'],
            'vehicle_type_id' => ['nullable', 'integer', 'exists:vehicle_types,id'],
            'image_index' => ['nullable', 'integer', 'min:1', 'max:20'],
            'document_type' => ['nullable', 'in:DL,RC,INSURANCE,ID'],
            'label_values' => ['nullable'],
            'file' => ['required', 'file', 'max:10240'],
        ]);
        if (empty($data['document_id']) && empty($data['document_type'])) {
            return response()->json([
                'message' => 'document_id or document_type is required.',
            ], 422);
        }

        $catalogDoc = !empty($data['document_id']) ? Document::find($data['document_id']) : null;
        $maxImages = $catalogDoc ? max(1, (int) $catalogDoc->no_of_images) : 1;

        $existingUploads = DriverDocument::query()
            ->where('driver_id', $driver->id)
            ->when(!empty($data['document_id']), fn ($q) => $q->where('document_id', (int) $data['document_id']), fn ($q) => $q->where('document_type', $data['document_type']))
            ->when(array_key_exists('vehicle_type_id', $data), fn ($q) => $q->where('vehicle_type_id', $data['vehicle_type_id'] ?? null))
            ->get();

        if (isset($data['image_index'])) {
            $imageIndex = (int) $data['image_index'];
            if ($imageIndex < 1 || $imageIndex > $maxImages) {
                return response()->json([
                    'message' => "Image slot {$imageIndex} is invalid. Maximum allowed is {$maxImages}.",
                ], 422);
            }
        } else {
            // Find lowest missing or rejected slot in 1..$maxImages
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

        $labelValues = null;
        if (isset($data['label_values'])) {
            $labelValues = is_string($data['label_values'])
                ? json_decode($data['label_values'], true)
                : $data['label_values'];
            if (!is_array($labelValues)) $labelValues = null;
        }

        // Clean up previous file if overwriting
        if ($existing && $existing->file_path && Storage::disk('local')->exists($existing->file_path)) {
            Storage::disk('local')->delete($existing->file_path);
        }

        $path = $request->file('file')->store('driver-documents', 'local');

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
                userId: (int) $driver->user_id,
                driverId: (int) $driver->id,
                reason: 'Document uploaded on behalf. Account approval is pending review.',
                documentId: $doc->document_id,
                status: 'uploaded',
            ));
        } catch (\Throwable $e) {
            Log::warning('DriverVerificationUpdated broadcast failed', ['error' => $e->getMessage()]);
        }

        return response()->json(['document' => $doc->fresh()]);
    }

    /**
     * Admin edits a driver row directly — e.g. setting vehicle_reg_no that
     * the driver app no longer collects.
     */
    public function updateDriver(Request $request, Driver $driver)
    {
        if ($request->has('service_scope')) {
            $rawScope = $request->input('service_scope');
            if (is_array($rawScope)) {
                $hasLocal = in_array('local', $rawScope, true);
                $hasOutstation = in_array('outstation', $rawScope, true);
                $normalized = ($hasLocal && $hasOutstation) ? 'both' : ($hasOutstation ? 'outstation' : ($hasLocal ? 'local' : null));
                $request->merge(['service_scope' => $normalized]);
            }
        }

        $data = $request->validate([
            'vehicle_reg_no' => ['nullable', 'string', 'max:50'],
            'vehicle_brand' => ['nullable', 'string', 'max:100'],
            'vehicle_model' => ['nullable', 'string', 'max:100'],
            'vehicle_color' => ['nullable', 'string', 'max:100'],
            'ride_type_id' => ['nullable', 'integer', 'exists:ride_types,id'],
            'vehicle_type_id' => ['nullable', 'integer', 'exists:vehicle_types,id'],
            'city_vehicle_type_id' => ['sometimes', 'nullable', 'integer', 'exists:city_vehicle_types,id'],
            'city_id' => ['nullable', 'integer', 'exists:cities,id'],
            'city_ids' => ['nullable', 'array', 'min:1'],
            'city_ids.*' => ['integer', 'exists:cities,id'],
            'service_scope' => ['nullable', 'string', 'in:local,outstation,both'],
            'service_mode' => ['nullable', 'string', 'in:private,fixed,shuttle'],
            // Linked User profile fields — driver identity lives on User
            'name' => ['sometimes', 'nullable', 'string', 'max:120'],
            'phone' => ['sometimes', 'nullable', 'string', 'max:20', Rule::unique('users', 'phone')->ignore($driver->user_id)],
            'email' => ['sometimes', 'nullable', 'email', 'max:180', Rule::unique('users', 'email')->ignore($driver->user_id)],
            'dob' => ['sometimes', 'nullable', 'date', 'before:today'],
            'address' => ['sometimes', 'nullable', 'string', 'max:500'],
        ]);

        // Reject before any city, driver or user data is written.
        app(\App\Services\DriverServiceModeService::class)->assertVehicleChangeAllowed($driver, $data);

        if (array_key_exists('city_ids', $data) && is_array($data['city_ids'])) {
            $cityIds = array_values(array_unique(array_map('intval', $data['city_ids'])));
            $driver->cities()->sync($cityIds);
            if (! empty($cityIds)) {
                $driver->city_id = $cityIds[0];
            }
        } elseif (array_key_exists('city_id', $data) && $data['city_id'] !== null) {
            $driver->cities()->sync([(int) $data['city_id']]);
            $driver->city_id = (int) $data['city_id'];
        }

        if (array_key_exists('city_vehicle_type_id', $data) && ! empty($data['city_vehicle_type_id'])) {
            $cityVehicle = \App\Models\CityVehicleType::query()->find((int) $data['city_vehicle_type_id']);
            $driverCityIds = $driver->city_ids;
            $targetVehicleTypeId = $data['vehicle_type_id'] ?? $driver->vehicle_type_id;

            if (! $cityVehicle
                || ! $cityVehicle->is_active
                || (! empty($driverCityIds) && ! in_array((int) $cityVehicle->city_id, $driverCityIds, true))
                || ($targetVehicleTypeId !== null && (int) $cityVehicle->vehicle_type_id !== (int) $targetVehicleTypeId)) {
                return response()->json([
                    'message' => 'Selected city vehicle does not match this driver\'s assigned cities and vehicle type.',
                ], 422);
            }
        }

        // Split into driver-owned vs user-owned fields (phone updated via verified OTP only)
        $userKeys = ['name', 'email', 'dob', 'address'];
        $userData = array_intersect_key($data, array_flip($userKeys));
        $driverData = array_diff_key($data, array_flip(array_merge($userKeys, ['city_ids', 'phone'])));

        if (! empty($driverData)) {
            if (array_key_exists('service_scope', $driverData) && $driverData['service_scope']) {
                $driverData['active_service_scope'] = $driverData['service_scope'];
            }
            if (array_key_exists('service_mode', $driverData) && $driverData['service_mode']) {
                $driverData['active_service_mode'] = $driverData['service_mode'];
            }
            $driver->fill($driverData);
            $driver->save();
        }

        if (! empty($userData) && $driver->user) {
            $driver->user->fill($userData)->save();
        }

        return response()->json([
            'driver' => $driver->fresh(['user', 'cities:id,name', 'city:id,name', 'vehicleTypeRef:id,name', 'cityVehicleType:id,display_name']),
            'message' => 'Driver details updated successfully.',
        ]);
    }

    public function startPhoneChange(Request $request, Driver $driver, \App\Services\PhoneOtpService $phoneOtpService)
    {
        $user = $driver->user;
        if (!$user) {
            return response()->json(['message' => 'Driver has no linked user account.'], 422);
        }

        $data = $request->validate([
            'phone' => ['required', 'string', 'min:6', 'max:20'],
        ]);

        $normalized = $this->normalizePhone($data['phone']);
        $currentNormalized = $user->phone ? $this->normalizePhone($user->phone) : null;

        if ($currentNormalized && $normalized === $currentNormalized) {
            return response()->json([
                'message' => 'This is already the driver\'s current phone number.',
            ], 422);
        }

        $conflict = User::query()
            ->where('id', '!=', $user->id)
            ->where(function ($q) use ($normalized, $data) {
                $q->where('phone', $normalized)
                  ->orWhere('phone', $data['phone']);
            })
            ->exists();

        if ($conflict) {
            return response()->json([
                'message' => 'This phone number is already registered to another account.',
            ], 422);
        }

        $result = $phoneOtpService->start($normalized, 'driver', $user->id);

        if (!($result['sent'] ?? false)) {
            if (!isset($result['cooldown'])) {
                return response()->json(['message' => 'Unable to send verification code. Please try again later.'], 503);
            }
            $cooldown = $result['cooldown'] ?? 30;
            return response()->json([
                'message' => "Please wait {$cooldown} seconds before requesting another code.",
                'cooldown' => $cooldown,
            ], 429);
        }

        Log::info('admin.driver.phone_change_otp', [
            'driver_id' => $driver->id,
            'user_id' => $user->id,
            'new_phone' => $normalized,
        ]);

        return response()->json(array_filter([
            'ok' => true,
            'message' => 'Verification code sent to ' . $normalized . '.',
            'phone' => $normalized,
            'resend_in' => (int) config('services.msg91.resend_cooldown_sec', 30),
        ], static fn ($v) => $v !== null));
    }

    public function verifyPhoneChange(Request $request, Driver $driver, \App\Services\PhoneOtpService $phoneOtpService)
    {
        $user = $driver->user;
        if (!$user) {
            return response()->json(['message' => 'Driver has no linked user account.'], 422);
        }

        $data = $request->validate([
            'phone' => ['required', 'string', 'min:6', 'max:20'],
            'code' => ['required', 'string', 'regex:/^[0-9]{6}$/'],
        ]);

        $normalized = $this->normalizePhone($data['phone']);

        $conflict = User::query()
            ->where('id', '!=', $user->id)
            ->where(function ($q) use ($normalized, $data) {
                $q->where('phone', $normalized)
                  ->orWhere('phone', $data['phone']);
            })
            ->exists();

        if ($conflict) {
            return response()->json([
                'message' => 'This phone number is already registered to another account.',
            ], 422);
        }

        if (!$phoneOtpService->verifyPhoneChange($user, $normalized, $data['code'])) {
            return response()->json([
                'message' => 'Invalid or expired verification code. Please try again.',
            ], 422);
        }


        Log::info('admin.driver.phone_changed', [
            'driver_id' => $driver->id,
            'user_id' => $user->id,
            'new_phone' => $normalized,
        ]);

        return response()->json([
            'ok' => true,
            'message' => 'Driver phone number updated successfully.',
            'driver' => $driver->fresh(['user', 'cities:id,name', 'city:id,name', 'vehicleTypeRef:id,name', 'cityVehicleType:id,display_name']),
        ]);
    }

    private function normalizePhone(string $phone): string
    {
        $digits = preg_replace('/\D+/', '', $phone) ?? '';
        return $phone !== '' && $phone[0] === '+' ? '+' . $digits : $digits;
    }

    /**
     * Deactivate or reactivate a driver. Deactivation also forces them offline.
     */
    public function setActivation(Request $request, Driver $driver)
    {
        $data = $request->validate([
            'active' => ['required', 'boolean'],
            'reason' => ['nullable', 'string', 'max:1000'],
        ]);

        if ($data['active']) {
            $driver->deactivated_at = null;
            $driver->deactivated_reason = null;
        } else {
            $driver->deactivated_at = now();
            $driver->deactivated_reason = $data['reason'] ?? null;
            $driver->is_online = false;
        }

        $driver->save();

        return response()->json(['driver' => $driver->fresh()]);
    }

    /**
     * Driver leaderboard. Counts COMPLETED trips per driver in the chosen period.
     *
     * ?period=day|week|month   (default: day)
     */
    public function leaderboard(Request $request)
    {
        $period = strtolower((string) $request->query('period', 'day'));
        $since = match ($period) {
            'week' => now()->subDays(7),
            'month' => now()->subDays(30),
            default => now()->startOfDay(),
        };

        $rows = DB::table('trips')
            ->join('drivers', 'drivers.user_id', '=', 'trips.driver_id')
            ->join('users', 'users.id', '=', 'drivers.user_id')
            ->where('trips.status', 'COMPLETED')
            ->where('trips.completed_at', '>=', $since)
            ->select(
                'drivers.id as driver_id',
                'users.name as name',
                'users.phone as phone',
                'users.avatar_path as avatar_path',
                DB::raw('COUNT(trips.id) as rides')
            )
            ->groupBy('drivers.id', 'users.name', 'users.phone', 'users.avatar_path')
            ->orderByDesc('rides')
            ->limit(100)
            ->get();

        $ranked = $rows->values()->map(function ($row, $idx) {
            return [
                'driver_id' => (int) $row->driver_id,
                'name' => $row->name,
                'phone' => $row->phone,
                'avatar_path' => $row->avatar_path,
                'avatar_url' => $this->avatarUrl($row->avatar_path),
                'rides' => (int) $row->rides,
                'rank' => $idx + 1,
            ];
        });

        return response()->json([
            'period' => $period,
            'since' => $since->toIso8601String(),
            'data' => $ranked,
        ]);
    }

    /**
     * Per-driver successful / cancelled / missed counts in a date range.
     *
     * ?from=YYYY-MM-DD&to=YYYY-MM-DD (defaults to today)
     */
    public function performance(Request $request)
    {
        $from = $request->query('from')
            ? Carbon::parse((string) $request->query('from'))->startOfDay()
            : now()->startOfDay();
        $to = $request->query('to')
            ? Carbon::parse((string) $request->query('to'))->endOfDay()
            : now()->endOfDay();

        $rows = DB::table('trips')
            ->join('drivers', 'drivers.user_id', '=', 'trips.driver_id')
            ->join('users', 'users.id', '=', 'drivers.user_id')
            ->whereBetween('trips.created_at', [$from, $to])
            ->select(
                'drivers.id as driver_id',
                'users.name as name',
                'users.phone as phone',
                'users.avatar_path as avatar_path',
                DB::raw("SUM(CASE WHEN trips.status = 'COMPLETED' THEN 1 ELSE 0 END) as successful"),
                DB::raw("SUM(CASE WHEN trips.status = 'CANCELLED' AND trips.no_show_by IS NULL THEN 1 ELSE 0 END) as cancelled"),
                DB::raw("SUM(CASE WHEN trips.status = 'CANCELLED' AND trips.no_show_by IS NOT NULL THEN 1 ELSE 0 END) as missed")
            )
            ->groupBy('drivers.id', 'users.name', 'users.phone', 'users.avatar_path')
            ->orderByDesc('successful')
            ->get()
            ->map(fn ($r) => [
                'driver_id' => (int) $r->driver_id,
                'name' => $r->name,
                'phone' => $r->phone,
                'avatar_path' => $r->avatar_path,
                'avatar_url' => $this->avatarUrl($r->avatar_path),
                'successful' => (int) $r->successful,
                'cancelled' => (int) $r->cancelled,
                'missed' => (int) $r->missed,
                'total' => (int) $r->successful + (int) $r->cancelled + (int) $r->missed,
            ]);

        return response()->json([
            'from' => $from->toDateString(),
            'to' => $to->toDateString(),
            'data' => $rows,
        ]);
    }

    /**
     * @return \Illuminate\Database\Eloquent\Builder<Driver>
     *
     * Filters honored:
     *   - state:        all (default) | active | deactivated
     *   - vehicle_type: exact match
     *   - has_documents: 1 → with docs, 0 → without
     *   - q:            driver id, name, email, phone, vehicle_reg_no
     *   - date_from / date_to: drivers.created_at window (YYYY-MM-DD)
     */
    private function buildIndexQuery(Request $request)
    {
        $state = strtolower((string) $request->query('state', 'all'));
        $cityId = $request->integer('city_id');
        if ($cityId) {
            ManagerScope::assertCityAllowed($cityId, $request->user());
        }

        $filters = $request->validate([
            'stand_id' => ['sometimes', 'integer', Rule::exists('route_groups', 'id')->where('city_id', $cityId)],
        ]);
        $query = ($cityId ? $this->locationDrivers($request)->forCity($cityId) : Driver::query())
            ->with(['user', 'documents', 'vehicleTypeRef:id,name']);

        if ($state === 'deactivated') {
            $query->whereNotNull('deactivated_at');
        } elseif ($state === 'active') {
            $query->whereNull('deactivated_at');
        }
        // state=all → no activation filter

        if ($vehicleType = $request->query('vehicle_type')) {
            $query->where('vehicle_type', $vehicleType);
        }

        if (isset($filters['stand_id'])) {
            $query->whereIn('drivers.user_id', DB::table('driver_route_group')
                ->where('route_group_id', $filters['stand_id'])->select('driver_user_id'));
        }
        if ($vehicleId = $request->integer('city_vehicle_type_id')) {
            $vehicle = CityVehicleType::find($vehicleId);
            if (!$vehicle || ($request->integer('city_id') && $vehicle->city_id !== $request->integer('city_id'))) {
                $query->whereRaw('1 = 0');
            } else {
                $query->forCity($vehicle->city_id)->where(function ($q) use ($vehicle) {
                    $q->where('drivers.city_vehicle_type_id', $vehicle->id);
                    if ($vehicle->vehicle_type_id !== null) $q->orWhere('drivers.vehicle_type_id', $vehicle->vehicle_type_id);
                    $q->orWhereExists(function ($g) use ($vehicle) {
                        $g->selectRaw('1')->from('driver_route_group as drg')
                            ->join('route_groups as rg', 'rg.id', '=', 'drg.route_group_id')
                            ->whereColumn('drg.driver_user_id', 'drivers.user_id')
                            ->where('rg.city_id', $vehicle->city_id)
                            ->where(function ($bound) use ($vehicle) {
                                $bound->where('rg.city_vehicle_type_id', $vehicle->id)
                                    ->orWhereExists(function ($routes) use ($vehicle) {
                                        $routes->selectRaw('1')->from('route_group_route as rgr')
                                            ->join('routes as r', 'r.id', '=', 'rgr.route_id')
                                            ->whereColumn('rgr.route_group_id', 'rg.id')
                                            ->where('r.city_vehicle_type_id', $vehicle->id);
                                    });
                            });
                    });
                });
            }
        }
        // ?has_documents=1 → drivers with at least one driver_documents row
        // ?has_documents=0 → drivers with zero uploads
        if ($request->has('has_documents') && $request->query('has_documents') !== '') {
            if ($request->boolean('has_documents')) {
                $query->whereHas('documents');
            } else {
                $query->whereDoesntHave('documents');
            }
        }

        // ?is_online=1 → fresh-online drivers (online flag + ping within stale window)
        // ?is_online=0 → offline OR stale (older than STALE_AFTER_SECONDS)
        if ($request->has('is_online') && $request->query('is_online') !== '') {
            $staleCutoff = now()->subSeconds(Driver::STALE_AFTER_SECONDS);
            if ($request->boolean('is_online')) {
                $query->where('drivers.is_online', true)
                    ->where('drivers.last_online_at', '>=', $staleCutoff);
            } else {
                $query->where(function ($w) use ($staleCutoff) {
                    $w->where('drivers.is_online', false)
                        ->orWhereNull('drivers.last_online_at')
                        ->orWhere('drivers.last_online_at', '<', $staleCutoff);
                });
            }
        }

        // Shared by the paginated list and CSV export.
        if ($approval = $request->query('approval_status')) {
            $approval = strtolower((string) $approval);
            if ($approval === 'not_approved') {
                $query->whereIn('drivers.approval_status', ['pending', 'rejected']);
            } elseif (in_array($approval, ['approved', 'pending', 'rejected'], true)) {
                $query->where('drivers.approval_status', $approval);
            }
        }

        // Registered-on (drivers.created_at) date range
        if ($from = $request->query('date_from')) {
            try {
                $query->where('drivers.created_at', '>=', Carbon::parse((string) $from)->startOfDay());
            } catch (\Throwable $e) {
                // ignore malformed dates from the client
            }
        }
        if ($to = $request->query('date_to')) {
            try {
                $query->where('drivers.created_at', '<=', Carbon::parse((string) $to)->endOfDay());
            } catch (\Throwable $e) {
                // ignore malformed dates from the client
            }
        }

        if ($q = trim((string) $request->query('q'))) {
            $needle = $q;
            $digits = preg_replace('/\D+/', '', $q);

            $query->where(function ($w) use ($needle, $digits) {
                if (ctype_digit($needle)) {
                    $w->orWhere('drivers.id', (int) $needle);
                }
                $w->orWhere('drivers.vehicle_reg_no', 'like', "%{$needle}%")
                    ->orWhereHas('user', function ($u) use ($needle, $digits) {
                        $u->where('name', 'like', "%{$needle}%")
                            ->orWhere('email', 'like', "%{$needle}%");
                        if ($digits !== '') {
                            $u->orWhere('phone', 'like', "%{$digits}%");
                        }
                    });
            });
        }

        return $query->orderByDesc('drivers.created_at');
    }

    private function shapeRow(Driver $driver): array
    {
        $userId = $driver->user_id;
        $now = now();

        $rides7d = Trip::query()
            ->where('driver_id', $userId)
            ->where('status', 'COMPLETED')
            ->where('completed_at', '>=', $now->copy()->subDays(7))
            ->count();

        $rides30d = Trip::query()
            ->where('driver_id', $userId)
            ->where('status', 'COMPLETED')
            ->where('completed_at', '>=', $now->copy()->subDays(30))
            ->count();

        $totalRides = Trip::query()
            ->where('driver_id', $userId)
            ->where('status', 'COMPLETED')
            ->count();

        $lastRide = Trip::query()
            ->where('driver_id', $userId)
            ->where('status', 'COMPLETED')
            ->orderByDesc('completed_at')
            ->value('completed_at');

        return [
            'id' => $driver->id,
            'approval_status' => $driver->approval_status,
            // The linked catalog category is authoritative. The legacy text
            // field can drift (for example SUV MAXI vs SUMO MAXI).
            'vehicle_type' => $driver->vehicleTypeRef?->name ?? $driver->vehicle_type,
            'vehicle_reg_no' => $driver->vehicle_reg_no,
            'is_online' => $driver->isOnlineFresh(),
            'registered_on' => optional($driver->created_at)->toIso8601String(),
            'last_login' => optional($driver->user?->last_login_at)->toIso8601String(),
            'last_ride_on' => $lastRide ? Carbon::parse($lastRide)->toIso8601String() : null,
            'rides_7d' => $rides7d,
            'rides_30d' => $rides30d,
            'total_rides' => $totalRides,
            'deactivated_at' => optional($driver->deactivated_at)->toIso8601String(),
            'deactivated_reason' => $driver->deactivated_reason,
            'user' => $driver->user ? [
                'id' => $driver->user->id,
                'name' => $driver->user->name,
                'phone' => $driver->user->phone,
                'email' => $driver->user->email,
                'avatar_path' => $driver->user->avatar_path,
                'avatar_url' => $this->avatarUrl($driver->user->avatar_path),
            ] : null,
            'documents' => $driver->documents,
        ];
    }

    /**
     * Resolve the public URL the admin UI can render for a stored avatar.
     * Using url() (not Storage::url()) so the host+port match the request —
     * Storage::url() reads APP_URL from .env, which in dev often lacks the
     * artisan-serve port and yields a broken link.
     */
    private function avatarUrl(?string $path): ?string
    {
        if (!$path) {
            return null;
        }
        if (str_starts_with($path, 'http')) {
            return $path;
        }
        return url('/storage/' . ltrim($path, '/'));
    }
}
