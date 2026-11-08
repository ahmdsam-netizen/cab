<?php

use App\Http\Controllers\AccountController;
use App\Http\Controllers\DriverPayoutController;
use App\Http\Controllers\EmergencyContactsController;
use App\Http\Controllers\SavedLocationsController;
use App\Http\Controllers\SupportInfoController;
use App\Http\Controllers\OperatorPublicController;
use App\Http\Controllers\Auth\FirebaseAuthController;
use App\Http\Controllers\DeviceTokensController;
use App\Http\Controllers\HealthController;
use App\Http\Controllers\LocationController;
use App\Http\Controllers\NotificationsController;
use App\Http\Controllers\ProfileController;
use App\Http\Controllers\PricingController;
use App\Http\Controllers\ServiceTileArtworkController;
use App\Http\Controllers\ShuttleBookingsController;
use App\Http\Controllers\ShuttleDriverController;
use App\Http\Controllers\TripsController;
use App\Http\Controllers\FixedRoutesController;
use App\Http\Controllers\FixedBookingsController;
use App\Http\Controllers\FixedDriverController;
use App\Http\Controllers\FixedSeatMapController;
use App\Http\Controllers\RefundsController;
use App\Http\Controllers\DriverManifestController;
use App\Http\Controllers\FareNegotiationController;
use App\Http\Controllers\DriversController;
use App\Http\Controllers\Admin\AdminCitiesController;
use App\Http\Controllers\Admin\AdminCityRideProductsController;
use App\Http\Controllers\Admin\AdminDocumentsController;
use App\Http\Controllers\Admin\AdminGlobalVehicleTypesController;
use App\Http\Controllers\Admin\AdminSetupProgressController;
use App\Http\Controllers\Admin\AdminRideTypesController;
use App\Http\Controllers\Admin\AdminCitySettingsController;
use App\Http\Controllers\Admin\AdminOperatorSettingsController;
use App\Http\Controllers\Admin\AdminContactDriversController;
use App\Http\Controllers\Admin\AdminDispatcherSettingsController;
use App\Http\Controllers\Admin\AdminDispatchController;
use App\Http\Controllers\Admin\AdminDriversController;
use App\Http\Controllers\Admin\AdminAnalyticsController;
use App\Http\Controllers\Admin\AdminFleetsController;
use App\Http\Controllers\Admin\AdminManualDispatchController;
use App\Http\Controllers\Admin\AdminDynamicPricingController;
use App\Http\Controllers\Admin\AdminDashboardController;
use App\Http\Controllers\Admin\AdminPricingController;
use App\Http\Controllers\Admin\AdminTripsController;
use App\Http\Controllers\Admin\AdminReportsController;
use App\Http\Controllers\Admin\FinanceController;
use App\Http\Controllers\TripTrackingController;
use App\Http\Controllers\RideAssignmentController;
use App\Http\Controllers\PaymentsController;
use App\Http\Controllers\CustomerCouponsController;
use App\Http\Controllers\CatalogController;
use App\Http\Controllers\InvoicesController;
use App\Http\Controllers\RatingsController;
use App\Http\Controllers\SafetyController;
use App\Http\Controllers\AppBannerController;
use App\Http\Controllers\Admin\AdminAppBannersController;
use App\Http\Controllers\Admin\AdminUsersController;
use App\Http\Controllers\Admin\AdminVehicleSetsController;
use App\Http\Controllers\Admin\AdminVehicleTypeImagesController;
use App\Http\Controllers\Admin\AdminVehicleTypesController;
use App\Http\Controllers\Admin\AdminOutstationPackagesController;
use App\Http\Controllers\Admin\AdminFixedRoutesController;
use App\Http\Controllers\Admin\AdminRouteGroupsController;
use App\Http\Controllers\Admin\AdminVehicleSeatLayoutsController;
use App\Http\Controllers\Admin\AdminDriverRouteGroupsController;
use App\Http\Controllers\Admin\AdminFixedDeparturesController;
use App\Http\Controllers\Admin\AdminShuttleBookingsController;
use App\Http\Controllers\Admin\AdminCouponsController;
use App\Http\Controllers\Admin\AdminPermissionsController;
use App\Http\Controllers\Admin\AdminManagerRolesController;
use App\Http\Controllers\Admin\AdminManagersController;
use App\Http\Controllers\Admin\AdminAuthController;
use App\Http\Controllers\Admin\AdminCustomersController;
use App\Http\Controllers\Admin\AdminSubscriptionsController;
use App\Http\Controllers\DriverSubscriptionsController;
use App\Http\Controllers\DriverWalletController;
use Illuminate\Support\Facades\Route;

Route::get('/', function () {
    return response()->json([
        'status' => 'ok',
        'app' => config('app.name', 'DreamCabs'),
        'version' => '1.0.0',
        'time' => now()->toIso8601String(),
    ]);
});

Route::get('/health', HealthController::class);
Route::get('/app-banners', [AppBannerController::class, 'index']);
Route::get('/app-assets/customer-marker', [\App\Http\Controllers\Admin\AdminAppAssetsController::class, 'customerMarker']);

// Admin auth (email + password)
Route::post('/admin/login', [AdminAuthController::class, 'login']);

Route::post('/auth/otp/start', [FirebaseAuthController::class, 'startOtp'])->middleware('throttle:otp');
Route::post('/auth/otp/verify', [FirebaseAuthController::class, 'verifyOtp'])->middleware('throttle:otp');

// Server-side SMS OTP via MSG91 (the non-Firebase login path).
Route::post('/auth/otp/sms/start', [\App\Http\Controllers\Auth\OtpAuthController::class, 'start'])->middleware('throttle:otp');
Route::post('/auth/otp/sms/verify', [\App\Http\Controllers\Auth\OtpAuthController::class, 'verify'])->middleware('throttle:otp');

// Profile completion (used after first-time phone OTP sign-up to capture name/email/photo).
Route::middleware('auth:sanctum')->group(function () {
    Route::post('/me/profile', [ProfileController::class, 'update']);
    Route::post('/me/phone/change/start', [ProfileController::class, 'startPhoneChange'])->middleware('throttle:otp');
    Route::post('/me/phone/change/verify', [ProfileController::class, 'verifyPhoneChange'])->middleware('throttle:otp');
});

// Per-user emergency contacts (driver + customer use the same endpoints).
Route::middleware('auth:sanctum')->group(function () {
    Route::get('/me/emergency-contacts', [EmergencyContactsController::class, 'index']);
    Route::post('/me/emergency-contacts', [EmergencyContactsController::class, 'store']);
    Route::patch('/me/emergency-contacts/{emergencyContact}', [EmergencyContactsController::class, 'update']);
    Route::delete('/me/emergency-contacts/{emergencyContact}', [EmergencyContactsController::class, 'destroy']);
});

// Official support contacts the admin sets up per city. Read-only.
Route::middleware('auth:sanctum')->get('/support-info', [SupportInfoController::class, 'show']);

// Per-user saved locations (Home, Work, etc.).
Route::middleware('auth:sanctum')->group(function () {
    Route::get('/me/saved-locations', [SavedLocationsController::class, 'index']);
    Route::post('/me/saved-locations', [SavedLocationsController::class, 'store']);
    Route::patch('/me/saved-locations/{savedLocation}', [SavedLocationsController::class, 'update']);
    Route::delete('/me/saved-locations/{savedLocation}', [SavedLocationsController::class, 'destroy']);
});

// Session + account management.
Route::middleware('auth:sanctum')->post('/me/logout', [AccountController::class, 'logout']);
Route::middleware('auth:sanctum')->delete('/me/account', [AccountController::class, 'destroy']);
Route::middleware(['auth:sanctum', 'role:driver'])->patch('/me/driver/payment-methods', [AccountController::class, 'updateDriverPaymentMethods']);

// Driver payout account ("driver KYC") — the Razorpay Route linked-account
// details the driver must register to receive their share automatically.
Route::middleware(['auth:sanctum', 'role:driver'])->group(function () {
    Route::get('/me/driver/payout-account', [DriverPayoutController::class, 'show']);
    Route::patch('/me/driver/payout-account', [DriverPayoutController::class, 'update']);
});

// Last-known location ping. Customer + driver apps POST { lat, lng } here.
Route::middleware('auth:sanctum')->post('/me/location', [LocationController::class, 'store']);

// FCM device-token registration (push notifications).
Route::middleware('auth:sanctum')->post('/me/device-tokens', [DeviceTokensController::class, 'store']);
Route::middleware('auth:sanctum')->delete('/me/device-tokens/{token}', [DeviceTokensController::class, 'destroy'])
    ->where('token', '.*');
// Device name / OS / app version captured on login (no notifications needed).
Route::middleware('auth:sanctum')->post('/me/device-info', [DeviceTokensController::class, 'saveDeviceInfo']);

// In-app notification inbox — role-agnostic (customer / driver / admin all use
// these against their own notifications).
Route::middleware('auth:sanctum')->group(function () {
    Route::get('/me/notifications', [NotificationsController::class, 'index']);
    Route::get('/me/notifications/unread-count', [NotificationsController::class, 'unreadCount']);
    Route::post('/me/notifications/read-all', [NotificationsController::class, 'markAllRead']);
    Route::post('/me/notifications/{appNotification}/read', [NotificationsController::class, 'markRead']);
});

Route::post('/pricing/estimate', [PricingController::class, 'estimate'])->middleware('throttle:booking');
Route::post('/pricing/seat-estimate', [PricingController::class, 'seatEstimate'])->middleware('throttle:booking');
Route::post('/shuttle/quote', [PricingController::class, 'shuttleQuote'])->middleware('throttle:booking');

// Public lookup endpoints for the mobile booking UI.
Route::get('/pricing/cities', [PricingController::class, 'cities']);
Route::get('/pricing/cities/{city}/products', [PricingController::class, 'products']);
Route::get('/pricing/service-tile-artwork/{rideType}/{version}', ServiceTileArtworkController::class)
    ->whereNumber('rideType')->where('version', '[a-f0-9]{64}')->name('pricing.service-tile-artwork');
Route::get('/pricing/ride-types', [PricingController::class, 'rideTypes']);
Route::get('/pricing/vehicle-types', [PricingController::class, 'vehicleTypes']);
Route::get('/pricing/outstation-packages', [PricingController::class, 'outstationPackages']);

Route::middleware(['auth:sanctum', 'role:customer'])->group(function () {
    Route::post('/trips', [TripsController::class, 'store'])->middleware('throttle:booking');
    Route::post('/trips/{trip}/cancel', [TripsController::class, 'cancel']);
    Route::post('/trips/{trip}/confirm', [TripsController::class, 'confirm']);
    // List drivers eligible for this trip + customer picks one to negotiate with.
    Route::get('/trips/{trip}/nearby-drivers', [TripsController::class, 'nearbyDrivers']);
    Route::post('/trips/{trip}/select-driver', [TripsController::class, 'selectDriver']);
    Route::post('/trips/{trip}/search-drivers', [TripsController::class, 'searchDrivers'])->middleware('throttle:booking');

});

Route::middleware(['auth:sanctum', 'role:driver'])->group(function () {
    Route::get('/trips/available', [TripsController::class, 'available']);
    Route::post('/trips/{trip}/start-otp', [TripsController::class, 'requestStartOtp'])->middleware('throttle:otp');
    Route::patch('/trips/{trip}/driver-progress', [TripsController::class, 'driverProgress']);
    Route::post('/trips/{trip}/no-show', [TripsController::class, 'markNoShow']);
    Route::post('/trips/{trip}/driver-cancel', [TripsController::class, 'driverCancel']);
    Route::post('/drivers/trips/{trip}/cancel', [TripsController::class, 'driverCancel']);

    // Shared-departure manifest: read + per-seat board / no-show.
    Route::get('/trips/{trip}/manifest', [DriverManifestController::class, 'show']);
    Route::post('/trips/{trip}/seat-reservations/{reservation}/board', [DriverManifestController::class, 'board']);
    Route::post('/trips/{trip}/seat-reservations/{reservation}/no-show', [DriverManifestController::class, 'noShow']);
});

Route::middleware(['auth:sanctum'])->group(function () {
    Route::get('/trips/{trip}/negotiation', [FareNegotiationController::class, 'show']);
    Route::get('/drivers/me', [DriversController::class, 'me']);
    // Anonymized nearby-drivers list for the customer "searching" map.
    // Returns lat/lng + opaque driver id only — no PII.
    Route::get('/drivers/nearby', [DriversController::class, 'nearby']);
});

Route::middleware(['auth:sanctum', 'role:customer'])->group(function () {
    Route::post('/trips/{trip}/negotiation/customer-offer', [FareNegotiationController::class, 'customerOffer']);
    Route::post('/trips/{trip}/negotiation/customer-confirm', [FareNegotiationController::class, 'customerConfirm']);
    // Booker reads the active start-ride OTP off their live-trip screen.
    Route::get('/trips/{trip}/start-otp', [TripsController::class, 'customerStartOtp']);
});

Route::middleware(['auth:sanctum', 'role:driver'])->group(function () {
    Route::post('/trips/{trip}/negotiation/driver-action', [FareNegotiationController::class, 'driverAction']);
});

// Driver onboarding: any authenticated user may register a vehicle profile.
// The controller is idempotent (updateOrCreate) and grants the `driver` role.
Route::middleware(['auth:sanctum'])->group(function () {
    Route::post('/drivers/register', [DriversController::class, 'register']);

    // Catalog reads — used by the driver registration wizard. Auth-only so
    // anonymous probes don't enumerate the catalog; no role required since
    // the user is still pre-driver when they fetch these.
    Route::get('/catalog/ride-types', [CatalogController::class, 'rideTypes']);
    Route::get('/catalog/vehicle-types', [CatalogController::class, 'vehicleTypes']);
    Route::get('/catalog/cities', [CatalogController::class, 'cities']);
    Route::get('/catalog/cities/{city}/registration-stands', [DriversController::class, 'registrationStands']);
    Route::get('/catalog/cities/{city}/driver-ride-products', [CatalogController::class, 'driverRideProducts']);
    Route::get('/catalog/cities/{city}/vehicles', [CatalogController::class, 'cityVehicles']);
    Route::get('/catalog/fleets', [CatalogController::class, 'fleets']);
    Route::get('/catalog/documents', [CatalogController::class, 'documents']);
});

Route::middleware(['auth:sanctum', 'role:driver'])->group(function () {
    Route::get('/drivers/me/service-access', [DriversController::class, 'serviceAccess']);
    Route::post('/drivers/documents', [DriversController::class, 'uploadDocument']);
    Route::delete('/drivers/documents/{document}', [DriversController::class, 'deleteDocument']);
    Route::get('/drivers/me/documents/{document}/file', [DriversController::class, 'meDocumentFile'])
        ->name('driver.me.documents.file');
    Route::post('/drivers/go-online', [DriversController::class, 'goOnline']);
    Route::post('/drivers/go-offline', [DriversController::class, 'goOffline']);
    Route::post('/drivers/service-mode', [DriversController::class, 'setServiceMode']);
    Route::post('/drivers/location', [DriversController::class, 'pingLocation'])->middleware('throttle:location');
    Route::get('/drivers/me/active-trip', [DriversController::class, 'activeTrip']);
    Route::get('/drivers/me/earnings', [DriversController::class, 'earnings']);

    // Driver subscriptions: browse plans, see the active plan, buy one via Wallet/UPI, cancel auto-renew.
    Route::get('/drivers/me/subscriptions/plans', [DriverSubscriptionsController::class, 'plans']);
    Route::get('/drivers/me/subscription', [DriverSubscriptionsController::class, 'current']);
    Route::post('/drivers/me/subscriptions', [DriverSubscriptionsController::class, 'purchase']);
    Route::post('/drivers/me/subscriptions/upi/create-order', [DriverSubscriptionsController::class, 'createUpiOrder']);
    Route::post('/drivers/me/subscriptions/upi/verify', [DriverSubscriptionsController::class, 'verifyUpiPurchase']);
    Route::post('/drivers/me/subscriptions/cancel', [DriverSubscriptionsController::class, 'cancel']);

    // Driver wallet: platform charges balance + deductions + Razorpay top-up.
    Route::get('/drivers/me/wallet', [DriverWalletController::class, 'show']);
    Route::post('/drivers/me/wallet/topup/razorpay', [DriverWalletController::class, 'topupRazorpay'])->middleware('idempotent');
    Route::post('/drivers/me/wallet/topup/razorpay/verify', [DriverWalletController::class, 'verifyTopupRazorpay'])->middleware('idempotent');
});

Route::middleware(['auth:sanctum', 'role:driver'])->group(function () {
    Route::post('/trips/{trip}/driver-accept', [RideAssignmentController::class, 'accept']);
    Route::post('/trips/{trip}/driver-reject', [RideAssignmentController::class, 'reject']);
    Route::get('/driver/trips/history', [RatingsController::class, 'historyDriver']);
    Route::get('/driver/trips/scheduled', [TripsController::class, 'driverScheduled']);
});

Route::middleware(['auth:sanctum', 'role:admin'])->group(function () {
    Route::get('/admin/app-assets', [\App\Http\Controllers\Admin\AdminAppAssetsController::class, 'index'])->middleware(['manager.city', 'permission:app_assets|vehicles']);
    Route::post('/admin/app-assets', [\App\Http\Controllers\Admin\AdminAppAssetsController::class, 'store'])->middleware(['manager.city', 'permission:app_assets']);
    Route::delete('/admin/app-assets/{asset}', [\App\Http\Controllers\Admin\AdminAppAssetsController::class, 'destroy'])->middleware(['manager.city', 'permission:app_assets']);
    Route::get('/admin/me', [AdminAuthController::class, 'me']);
    Route::match(['post', 'put', 'patch'], '/admin/me/profile', [AdminAuthController::class, 'updateProfile']);
    Route::match(['post', 'put', 'patch'], '/admin/me/password', [AdminAuthController::class, 'updatePassword']);
    Route::get('/admin/drivers', [AdminDriversController::class, 'index'])->middleware('permission:drivers');
    Route::get('/admin/drivers/city-counts', [AdminDriversController::class, 'cityCounts'])->middleware('permission:drivers');
    Route::get('/admin/drivers/export', [AdminDriversController::class, 'exportCsv'])->middleware('permission:drivers');
    Route::get('/admin/drivers/leaderboard', [AdminDriversController::class, 'leaderboard'])->middleware('permission:drivers');
    Route::get('/admin/drivers/performance', [AdminDriversController::class, 'performance'])->middleware('permission:drivers');
    Route::patch('/admin/drivers/{driver}/approval', [AdminDriversController::class, 'setApproval'])->middleware('permission:drivers');
    Route::patch('/admin/drivers/{driver}/activation', [AdminDriversController::class, 'setActivation'])->middleware('permission:drivers');
    Route::post('/admin/drivers/{driver}/unsubscribe', [AdminDriversController::class, 'unsubscribe'])->middleware('permission:drivers');
    Route::post('/admin/drivers/{driver}/send-otp', [AdminDriversController::class, 'sendOtp'])->middleware(['permission:drivers', 'throttle:otp']);
    Route::post('/admin/drivers/{driver}/phone/start', [AdminDriversController::class, 'startPhoneChange'])->middleware(['permission:drivers', 'throttle:otp']);
    Route::post('/admin/drivers/{driver}/phone/verify', [AdminDriversController::class, 'verifyPhoneChange'])->middleware(['permission:drivers', 'throttle:otp']);
    Route::post('/admin/drivers/{driver}/block', [AdminDriversController::class, 'block'])->middleware('permission:drivers');
    Route::post('/admin/drivers/{driver}/unblock', [AdminDriversController::class, 'unblock'])->middleware('permission:drivers');
    Route::post('/admin/drivers/{driver}/verify-payout-account', [AdminDriversController::class, 'verifyPayoutAccount'])->middleware('permission:drivers');

    // Fixed route allocation — assign route groups to a driver + read the resolved routes.
    Route::get('/admin/drivers/{driver}/route-groups', [AdminDriverRouteGroupsController::class, 'index'])->middleware('permission:drivers');
    Route::put('/admin/drivers/{driver}/route-groups', [AdminDriverRouteGroupsController::class, 'sync'])->middleware('permission:drivers');
    Route::get('/admin/drivers/{driver}/effective-routes', [AdminDriverRouteGroupsController::class, 'effectiveRoutes'])->middleware('permission:drivers');
    Route::delete('/admin/drivers/{driver}', [AdminDriversController::class, 'destroy'])->middleware('permission:drivers');
    Route::patch('/admin/drivers/documents/{document}/status', [AdminDriversController::class, 'setDocumentStatus'])->middleware('permission:drivers');
    // Payouts: the money leaves by GPay/bank OUTSIDE the app (manual by
    // design); these record the fact in the wallet ledger so balances stay
    // true. payouts-due must be registered before the {driver} routes.
    Route::get('/admin/drivers/payouts-due', [AdminDriversController::class, 'payoutsDue'])->middleware('permission:drivers');
    Route::get('/admin/drivers/{driver}/wallet/payout-summary', [AdminDriversController::class, 'payoutSummary'])->middleware('permission:drivers');
    Route::post('/admin/drivers/{driver}/wallet/payout', [AdminDriversController::class, 'recordPayout'])->middleware('permission:drivers');
    Route::get('/admin/drivers/{driver}/full', [AdminDriversController::class, 'fullProfile'])->middleware('permission:drivers');
    Route::patch('/admin/drivers/{driver}', [AdminDriversController::class, 'updateDriver'])->middleware('permission:drivers');
    Route::post('/admin/drivers/{driver}/documents', [AdminDriversController::class, 'uploadDocument'])->middleware('permission:drivers');
    Route::get('/admin/drivers/{driver}/documents/{document}/file', [AdminDriversController::class, 'documentFile'])
        ->middleware('permission:drivers')
        ->name('admin.drivers.documents.file');
    // Driver detail page (admin) — profile + rides/wallet dashboard.
    Route::get('/admin/drivers/{driver}/profile', [AdminDriversController::class, 'profile'])->middleware('permission:drivers');
    Route::get('/admin/drivers/{driver}/rides', [AdminDriversController::class, 'rides'])->middleware('permission:drivers');
    Route::get('/admin/drivers/{driver}/cancelled-rides', [AdminDriversController::class, 'cancelledRides'])->middleware('permission:drivers');
    Route::get('/admin/drivers/{driver}/wallet', [AdminDriversController::class, 'wallet'])->middleware('permission:drivers');
    Route::post('/admin/drivers/{driver}/wallet/adjust', [AdminDriversController::class, 'adjustWallet'])->middleware('permission:drivers');
    Route::get('/admin/drivers/{driver}/wallet/transactions', [AdminDriversController::class, 'walletTransactions'])->middleware('permission:drivers');
    Route::get('/admin/drivers/{driver}/settlement', [AdminDriversController::class, 'settlement'])->middleware('permission:drivers');
    Route::get('/admin/contact-drivers/audience', [AdminContactDriversController::class, 'audience'])->middleware('permission:contact_drivers');
    Route::post('/admin/contact-drivers/upload-csv', [AdminContactDriversController::class, 'uploadCsv'])->middleware('permission:contact_drivers');
    Route::post('/admin/contact-drivers/send', [AdminContactDriversController::class, 'send'])->middleware('permission:contact_drivers');
    Route::get('/admin/dispatch/snapshot', [AdminDispatchController::class, 'snapshot'])->middleware('permission:live_operations');
    Route::get('/admin/safety-events', [SafetyController::class, 'adminIndex'])->middleware('permission:safety');
    Route::get('/admin/dashboard', [AdminDashboardController::class, 'index'])->middleware('permission:dashboard');
    Route::get('/admin/reports', [AdminReportsController::class, 'index'])->middleware('permission:reports');
    Route::get('/admin/users', [AdminUsersController::class, 'index'])->middleware('permission:managers');
    Route::patch('/admin/users/{user}/role', [AdminUsersController::class, 'updateRole'])->middleware('permission:managers');

    // ── Global Subscription Plans Management ────────────────────────
    Route::get('/admin/subscription-plans', [AdminSubscriptionsController::class, 'globalIndex'])->middleware('permission:subscriptions');
    Route::post('/admin/subscription-plans', [AdminSubscriptionsController::class, 'globalStore'])->middleware('permission:subscriptions');
    Route::get('/admin/subscription-plans/{plan}', [AdminSubscriptionsController::class, 'globalShow'])->middleware('permission:subscriptions');
    Route::patch('/admin/subscription-plans/{plan}', [AdminSubscriptionsController::class, 'globalUpdate'])->middleware('permission:subscriptions');
    Route::delete('/admin/subscription-plans/{plan}', [AdminSubscriptionsController::class, 'globalDestroy'])->middleware('permission:subscriptions');

    // ── Customer Management ─────────────────────────────────────────
    Route::prefix('admin/customers')->middleware('permission:customers')->group(function () {
        Route::get('/', [AdminCustomersController::class, 'index']);
        Route::post('/import', [AdminCustomersController::class, 'importCsv']);
        Route::get('/lookup/driver', [AdminCustomersController::class, 'lookupByDriver']);
        Route::get('/lookup/ride', [AdminCustomersController::class, 'lookupByRide']);
        Route::get('/{user}', [AdminCustomersController::class, 'show']);
        Route::patch('/{user}', [AdminCustomersController::class, 'update']);
        Route::delete('/{user}', [AdminCustomersController::class, 'destroy']);
        Route::post('/{user}/block', [AdminCustomersController::class, 'block']);
        Route::post('/{user}/unblock', [AdminCustomersController::class, 'unblock']);
        Route::post('/{user}/unsubscribe', [AdminCustomersController::class, 'unsubscribe']);
        Route::post('/{user}/send-otp', [AdminCustomersController::class, 'sendOtp'])
            ->middleware('throttle:otp');
        Route::post('/{user}/phone/start', [AdminCustomersController::class, 'startPhoneChange'])
            ->middleware('throttle:otp');
        Route::post('/{user}/phone/verify', [AdminCustomersController::class, 'verifyPhoneChange'])
            ->middleware('throttle:otp');
        Route::get('/{user}/wallet/transactions', [AdminCustomersController::class, 'walletTransactions']);
        Route::get('/{user}/rides', [AdminCustomersController::class, 'rides']);
        Route::get('/{user}/cancelled-rides', [AdminCustomersController::class, 'cancelledRides']);
    });
    Route::get('/admin/cities', [AdminCitiesController::class, 'index']);
    Route::post('/admin/cities', [AdminCitiesController::class, 'store'])->middleware('permission:city_settings');
    // City-scoped admin routes — `manager.city` middleware rejects requests
    // when the caller's scoped to a different city.
    Route::middleware('manager.city')->group(function () {
        Route::get('/admin/cities/{city}', [AdminCitiesController::class, 'show']);
        Route::get('/admin/cities/{city}/driver-stand-counts', [AdminDriversController::class, 'cityStands'])->middleware('permission:drivers');
        Route::patch('/admin/cities/{city}', [AdminCitiesController::class, 'update'])->middleware('permission:city_settings');
        Route::patch('/admin/cities/{city}/polygon', [AdminCitiesController::class, 'updatePolygon'])->middleware('permission:city_settings');
        Route::delete('/admin/cities/{city}', [AdminCitiesController::class, 'destroy'])->middleware('permission:city_settings');
        Route::get('/admin/cities/{city}/setup-progress', [AdminSetupProgressController::class, 'show'])->middleware('permission:city_settings');
        // Operator-wide (global, non-city) settings.
        Route::get('/admin/operator-settings', [AdminOperatorSettingsController::class, 'show'])->middleware('permission:operator_settings');
        Route::patch('/admin/operator-settings', [AdminOperatorSettingsController::class, 'update'])->middleware('permission:operator_settings');
        Route::post('/admin/operator-settings', [AdminOperatorSettingsController::class, 'update'])->middleware('permission:operator_settings');

        Route::get('/admin/cities/{city}/settings', [AdminCitySettingsController::class, 'show'])->middleware('permission:city_settings');
        Route::patch('/admin/cities/{city}/settings', [AdminCitySettingsController::class, 'update'])->middleware('permission:city_settings');
        Route::post('/admin/cities/{city}/settings', [AdminCitySettingsController::class, 'update'])->middleware('permission:city_settings');
        Route::post('/admin/cities/{city}/copy-settings', [AdminCitySettingsController::class, 'copySettings'])->middleware('permission:city_settings');
        Route::get('/admin/cities/{city}/preview-settings', [AdminCitySettingsController::class, 'preview'])->middleware('permission:city_settings');
        Route::get('/admin/cities/{city}/dispatcher-settings', [AdminDispatcherSettingsController::class, 'index'])->middleware('permission:city_settings');
        Route::patch('/admin/cities/{city}/dispatcher-settings/{setting}', [AdminDispatcherSettingsController::class, 'update'])->middleware('permission:city_settings');

        // ── Service catalogue (ride-products): operator can toggle modes/scopes ──
        Route::get('/admin/cities/{city}/ride-products', [AdminCityRideProductsController::class, 'index'])->middleware('permission:city_settings');
        Route::patch('/admin/cities/{city}/ride-products/scopes/{scope}', [AdminCityRideProductsController::class, 'updateScope'])->middleware('permission:city_settings');
        Route::patch('/admin/cities/{city}/ride-products/scopes/{scope}/modes/{mode}', [AdminCityRideProductsController::class, 'updateMode'])->middleware('permission:city_settings');
        Route::post('/admin/cities/{city}/ride-products/scopes/{scope}/modes/{mode}', [AdminCityRideProductsController::class, 'updateMode'])->middleware('permission:city_settings');

        Route::get('/admin/cities/{city}/vehicle-types', [AdminVehicleTypesController::class, 'index'])->middleware('permission:vehicles|pricing|manual_dispatch|rides');
        Route::post('/admin/cities/{city}/vehicle-types', [AdminVehicleTypesController::class, 'store'])->middleware('permission:vehicles');
        Route::post('/admin/cities/{city}/vehicle-types/batch', [AdminVehicleTypesController::class, 'storeBatch'])->middleware('permission:vehicles');
        Route::post('/admin/cities/{city}/vehicle-types/copy-to-city', [AdminVehicleTypesController::class, 'copyToCity'])->middleware('permission:vehicles');
        Route::get('/admin/cities/{city}/vehicle-types/{vehicleType}', [AdminVehicleTypesController::class, 'show'])->middleware('permission:vehicles|pricing');
        Route::patch('/admin/cities/{city}/vehicle-types/{vehicleType}', [AdminVehicleTypesController::class, 'update'])->middleware('permission:vehicles');
        Route::post('/admin/cities/{city}/vehicle-types/{vehicleType}', [AdminVehicleTypesController::class, 'update'])->middleware('permission:vehicles');
        Route::delete('/admin/cities/{city}/vehicle-types/{vehicleType}', [AdminVehicleTypesController::class, 'destroy'])->middleware('permission:vehicles');
        Route::get('/admin/cities/{city}/vehicle-types/{vehicleType}/images', [AdminVehicleTypeImagesController::class, 'index'])->middleware('permission:app_assets|vehicles');
        Route::post('/admin/cities/{city}/vehicle-types/{vehicleType}/images', [AdminVehicleTypeImagesController::class, 'store'])->middleware('permission:app_assets');
        Route::post('/admin/cities/{city}/vehicle-types/{vehicleType}/images/{image}', [AdminVehicleTypeImagesController::class, 'update'])->middleware('permission:app_assets');
        Route::patch('/admin/cities/{city}/vehicle-types/{vehicleType}/images/{image}', [AdminVehicleTypeImagesController::class, 'update'])->middleware('permission:app_assets');
        Route::delete('/admin/cities/{city}/vehicle-types/{vehicleType}/images/{image}', [AdminVehicleTypeImagesController::class, 'destroy'])->middleware('permission:app_assets');

        // Outstation fare packages (One Way / Round Trip / …) per vehicle.
        Route::get('/admin/cities/{city}/vehicle-types/{vehicleType}/packages', [AdminOutstationPackagesController::class, 'index'])->middleware('permission:vehicles|pricing');
        Route::post('/admin/cities/{city}/vehicle-types/{vehicleType}/packages', [AdminOutstationPackagesController::class, 'store'])->middleware('permission:vehicles');
        Route::patch('/admin/cities/{city}/vehicle-types/{vehicleType}/packages/{package}', [AdminOutstationPackagesController::class, 'update'])->middleware('permission:vehicles');
        Route::delete('/admin/cities/{city}/vehicle-types/{vehicleType}/packages/{package}', [AdminOutstationPackagesController::class, 'destroy'])->middleware('permission:vehicles');

        // Vehicle Sets — per-city bundles of related vehicles.
        Route::get('/admin/cities/{city}/vehicle-sets', [AdminVehicleSetsController::class, 'index'])->middleware('permission:vehicles');
        Route::post('/admin/cities/{city}/vehicle-sets', [AdminVehicleSetsController::class, 'store'])->middleware('permission:vehicles');
        Route::patch('/admin/cities/{city}/vehicle-sets/{vehicleSet}', [AdminVehicleSetsController::class, 'update'])->middleware('permission:vehicles');
        Route::delete('/admin/cities/{city}/vehicle-sets/{vehicleSet}', [AdminVehicleSetsController::class, 'destroy'])->middleware('permission:vehicles');

    });
    Route::get('/admin/documents', [AdminDocumentsController::class, 'index'])->middleware('permission:drivers');
    Route::post('/admin/documents', [AdminDocumentsController::class, 'store'])->middleware('permission:drivers');
    Route::get('/admin/documents/{document}', [AdminDocumentsController::class, 'show'])->middleware('permission:drivers');
    Route::patch('/admin/documents/{document}', [AdminDocumentsController::class, 'update'])->middleware('permission:drivers');
    Route::post('/admin/documents/{document}/assign', [AdminDocumentsController::class, 'assign'])->middleware('permission:drivers');
    Route::delete('/admin/documents/{document}', [AdminDocumentsController::class, 'destroy'])->middleware('permission:drivers');

    Route::get('/admin/ride-types-crud', [AdminRideTypesController::class, 'index'])->middleware('permission:vehicles');
    Route::post('/admin/ride-types-crud', [AdminRideTypesController::class, 'store'])->middleware('permission:vehicles');
    Route::get('/admin/ride-types-crud/{rideType}', [AdminRideTypesController::class, 'show'])->middleware('permission:vehicles');
    Route::patch('/admin/ride-types-crud/{rideType}', [AdminRideTypesController::class, 'update'])->middleware('permission:vehicles');
    Route::delete('/admin/ride-types-crud/{rideType}', [AdminRideTypesController::class, 'destroy'])->middleware('permission:vehicles');

    Route::get('/admin/vehicle-types-global', [AdminGlobalVehicleTypesController::class, 'index'])->middleware('permission:vehicles');
    Route::post('/admin/vehicle-types-global', [AdminGlobalVehicleTypesController::class, 'store'])->middleware('permission:vehicles');
    Route::get('/admin/vehicle-types-global/{vehicleType}', [AdminGlobalVehicleTypesController::class, 'show'])->middleware('permission:vehicles');
    Route::post('/admin/vehicle-types-global/{vehicleType}', [AdminGlobalVehicleTypesController::class, 'update'])->middleware('permission:vehicles');
    Route::patch('/admin/vehicle-types-global/{vehicleType}', [AdminGlobalVehicleTypesController::class, 'update'])->middleware('permission:vehicles');
    Route::delete('/admin/vehicle-types-global/{vehicleType}', [AdminGlobalVehicleTypesController::class, 'destroy'])->middleware('permission:vehicles');
    Route::get('/admin/fleets', [AdminFleetsController::class, 'index'])->middleware('permission:fleets');
    Route::post('/admin/fleets', [AdminFleetsController::class, 'store'])->middleware('permission:fleets');
    Route::get('/admin/fleets/{fleet}', [AdminFleetsController::class, 'show'])->middleware('permission:fleets');
    Route::patch('/admin/fleets/{fleet}', [AdminFleetsController::class, 'update'])->middleware('permission:fleets');
    Route::post('/admin/fleets/{fleet}', [AdminFleetsController::class, 'update'])->middleware('permission:fleets');
    Route::delete('/admin/fleets/{fleet}', [AdminFleetsController::class, 'destroy'])->middleware('permission:fleets');
    Route::post('/admin/manual-dispatch/lookup-user', [AdminManualDispatchController::class, 'lookupUser'])->middleware('permission:manual_dispatch');
    Route::post('/admin/manual-dispatch/fare-estimate', [AdminManualDispatchController::class, 'fareEstimate'])->middleware('permission:manual_dispatch');
    Route::post('/admin/manual-dispatch/book', [AdminManualDispatchController::class, 'book'])->middleware('permission:manual_dispatch');
    Route::get('/admin/analytics/real-time', [AdminAnalyticsController::class, 'realTime'])->middleware('permission:analytics');
    Route::get('/admin/analytics/graphs', [AdminAnalyticsController::class, 'graphs'])->middleware('permission:analytics');
    Route::get('/admin/analytics/reports', [AdminAnalyticsController::class, 'reports'])->middleware('permission:reports');
    Route::get('/admin/analytics/reports/{key}', [AdminAnalyticsController::class, 'executeReport'])->middleware('permission:reports');
    Route::get('/admin/analytics/reports/{key}/export', [AdminAnalyticsController::class, 'exportReport'])->middleware('permission:reports');
    Route::get('/admin/ride-types', [AdminPricingController::class, 'rideTypes'])->middleware('permission:pricing|rides|manual_dispatch|vehicles');
    Route::get('/admin/pricing-rules', [AdminPricingController::class, 'index'])->middleware('permission:pricing');
    Route::get('/admin/pricing-rules/resolve', [AdminPricingController::class, 'resolve'])->middleware('permission:pricing|manual_dispatch');
    Route::post('/admin/pricing-rules', [AdminPricingController::class, 'store'])->middleware('permission:pricing');
    Route::patch('/admin/pricing-rules/{pricingRule}', [AdminPricingController::class, 'update'])->middleware('permission:pricing');
    Route::delete('/admin/pricing-rules/{pricingRule}', [AdminPricingController::class, 'destroy'])->middleware('permission:pricing');
    Route::get('/admin/dynamic-pricing-rules', [AdminDynamicPricingController::class, 'index'])->middleware('permission:pricing');
    Route::post('/admin/dynamic-pricing-rules', [AdminDynamicPricingController::class, 'store'])->middleware('permission:pricing');
    Route::get('/admin/dynamic-pricing-rules/{dynamicPricingRule}', [AdminDynamicPricingController::class, 'show'])->middleware('permission:pricing');
    Route::patch('/admin/dynamic-pricing-rules/{dynamicPricingRule}', [AdminDynamicPricingController::class, 'update'])->middleware('permission:pricing');
    Route::delete('/admin/dynamic-pricing-rules/{dynamicPricingRule}', [AdminDynamicPricingController::class, 'destroy'])->middleware('permission:pricing');
    Route::get('/admin/trips', [AdminTripsController::class, 'index'])->middleware('permission:rides');
    Route::get('/admin/trips/{trip}', [AdminTripsController::class, 'show'])->middleware('permission:rides');
    Route::get('/admin/trips/{trip}/latest-location', [AdminTripsController::class, 'latestLocation'])->middleware('permission:rides|live_operations');
    Route::post('/admin/trips/{trip}/start', [AdminTripsController::class, 'start'])->middleware('permission:rides');
    Route::post('/admin/trips/{trip}/cancel', [AdminTripsController::class, 'cancel'])->middleware('permission:rides');
    Route::post('/admin/trips/{trip}/change-drop', [AdminTripsController::class, 'changeDrop'])->middleware('permission:rides');
    Route::post('/admin/trips/{trip}/passengers/{passenger}/change-drop', [AdminTripsController::class, 'changePassengerDrop'])->middleware('permission:rides');
    Route::post('/admin/trips/{trip}/passengers/{passenger}/cancel', [AdminTripsController::class, 'cancelPassenger'])->middleware('permission:rides');

    Route::middleware('manager.city')->group(function () {
        // ── Promotions: coupons ─────────────────────────────────────────
        Route::get('/admin/cities/{city}/coupons', [AdminCouponsController::class, 'index'])->middleware('permission:coupons');
        Route::post('/admin/cities/{city}/coupons', [AdminCouponsController::class, 'store'])->middleware('permission:coupons');
        Route::get('/admin/cities/{city}/coupons/{coupon}', [AdminCouponsController::class, 'show'])->middleware('permission:coupons');
        Route::patch('/admin/cities/{city}/coupons/{coupon}', [AdminCouponsController::class, 'update'])->middleware('permission:coupons');
        Route::delete('/admin/cities/{city}/coupons/{coupon}', [AdminCouponsController::class, 'destroy'])->middleware('permission:coupons');
        Route::get('/admin/cities/{city}/coupons/{coupon}/assignments', [AdminCouponsController::class, 'assignments'])->middleware('permission:coupons');
        Route::post('/admin/cities/{city}/coupons/{coupon}/give', [AdminCouponsController::class, 'give'])->middleware('permission:coupons');

        // ── Driver subscription plans ───────────────────────────────────
        Route::get('/admin/cities/{city}/subscription-plans', [AdminSubscriptionsController::class, 'index'])->middleware('permission:subscriptions');
        Route::post('/admin/cities/{city}/subscription-plans', [AdminSubscriptionsController::class, 'store'])->middleware('permission:subscriptions');
        Route::get('/admin/cities/{city}/subscription-plans/{plan}', [AdminSubscriptionsController::class, 'show'])->middleware('permission:subscriptions');
        Route::patch('/admin/cities/{city}/subscription-plans/{plan}', [AdminSubscriptionsController::class, 'update'])->middleware('permission:subscriptions');
        Route::delete('/admin/cities/{city}/subscription-plans/{plan}', [AdminSubscriptionsController::class, 'destroy'])->middleware('permission:subscriptions');
    });

    // ── App Banners (Promotions / Announcements) ─────────────────────
    Route::get('/admin/app-banners', [AdminAppBannersController::class, 'index'])->middleware('permission:coupons|city_settings|operator_settings');
    Route::post('/admin/app-banners', [AdminAppBannersController::class, 'store'])->middleware('permission:coupons|city_settings|operator_settings');
    Route::get('/admin/app-banners/{banner}', [AdminAppBannersController::class, 'show'])->middleware('permission:coupons|city_settings|operator_settings');
    Route::post('/admin/app-banners/{banner}', [AdminAppBannersController::class, 'update'])->middleware('permission:coupons|city_settings|operator_settings');
    Route::patch('/admin/app-banners/{banner}', [AdminAppBannersController::class, 'update'])->middleware('permission:coupons|city_settings|operator_settings');
    Route::patch('/admin/app-banners/{banner}/toggle', [AdminAppBannersController::class, 'toggle'])->middleware('permission:coupons|city_settings|operator_settings');
    Route::delete('/admin/app-banners/{banner}', [AdminAppBannersController::class, 'destroy'])->middleware('permission:coupons|city_settings|operator_settings');

    // ── RBAC: permissions catalog (read-only) ───────────────────────
    Route::get('/admin/permissions', [AdminPermissionsController::class, 'index'])->middleware('permission:roles_permissions');

    // ── RBAC: manager roles ─────────────────────────────────────────
    Route::get('/admin/manager-roles', [AdminManagerRolesController::class, 'index'])->middleware('permission:roles_permissions|managers');
    Route::post('/admin/manager-roles', [AdminManagerRolesController::class, 'store'])->middleware('permission:roles_permissions');
    Route::get('/admin/manager-roles/{managerRole}', [AdminManagerRolesController::class, 'show'])->middleware('permission:roles_permissions|managers');
    Route::patch('/admin/manager-roles/{managerRole}', [AdminManagerRolesController::class, 'update'])->middleware('permission:roles_permissions');
    Route::delete('/admin/manager-roles/{managerRole}', [AdminManagerRolesController::class, 'destroy'])->middleware('permission:roles_permissions');

    // ── RBAC: managers (admin-side users) ───────────────────────────
    Route::get('/admin/managers', [AdminManagersController::class, 'index'])->middleware('permission:managers');
    Route::post('/admin/managers', [AdminManagersController::class, 'store'])->middleware('permission:managers');
    Route::get('/admin/managers/{user}', [AdminManagersController::class, 'show'])->middleware('permission:managers');
    Route::patch('/admin/managers/{user}', [AdminManagersController::class, 'update'])->middleware('permission:managers');
    Route::post('/admin/managers/{user}/suspend', [AdminManagersController::class, 'suspend'])->middleware('permission:managers');
    Route::post('/admin/managers/{user}/unsuspend', [AdminManagersController::class, 'unsuspend'])->middleware('permission:managers');
    Route::delete('/admin/managers/{user}', [AdminManagersController::class, 'destroy'])->middleware('permission:managers');
});

Route::middleware(['auth:sanctum', 'role:driver'])->group(function () {
    Route::post('/trips/{trip}/location', [TripTrackingController::class, 'updateLocation'])->middleware('throttle:location');
});

// Customer-side location stream — feeds the driver app's live customer marker.
Route::middleware(['auth:sanctum', 'role:customer'])->group(function () {
    Route::post('/trips/{trip}/customer-location', [TripTrackingController::class, 'updateCustomerLocation'])->middleware('throttle:location');
});

// SOS should be available to both customers and drivers.
Route::middleware(['auth:sanctum', 'role_any:customer,driver'])->post('/trips/{trip}/sos', [SafetyController::class, 'trigger']);

Route::middleware(['auth:sanctum', 'role:customer'])->group(function () {
    Route::post('/trips/{trip}/share-link', [TripTrackingController::class, 'createShareLink']);
});

Route::get('/trip-share/{token}', [TripTrackingController::class, 'showShare']);

Route::middleware(['auth:sanctum', 'role:customer'])->group(function () {
    Route::post('/trips/{trip}/coupon-preview', [PaymentsController::class, 'couponPreview']);
    // The method chooser the customer app shows before checkout — Razorpay fixes
    // an order's amount up front, so the fee has to be priced before it opens.
    Route::get('/payments/methods', [PaymentsController::class, 'paymentMethods']);
    Route::post('/trips/{trip}/pay/razorpay', [PaymentsController::class, 'payRazorpay'])->middleware('idempotent');
    Route::post('/trips/{trip}/pay/razorpay/verify', [PaymentsController::class, 'verifyRazorpay'])->middleware('idempotent');
    Route::post('/trips/{trip}/pay/cash', [PaymentsController::class, 'payCash'])->middleware('idempotent');
    Route::post('/trips/{trip}/pay/cash-deposit', [PaymentsController::class, 'payCashDeposit'])->middleware('idempotent');
    Route::get('/trips/{trip}/invoice', [InvoicesController::class, 'show']);
    Route::post('/trips/{trip}/invoice', [InvoicesController::class, 'generate']);
    Route::get('/trips/{trip}/invoice/download', [InvoicesController::class, 'download']);
    Route::post('/trips/{trip}/rating', [RatingsController::class, 'store']);
    Route::post('/trips/{trip}/tip', [TripsController::class, 'tip']);
    Route::get('/customer/trips/history', [RatingsController::class, 'historyCustomer']);
    // Must sit before the /{trip} wildcard so "scheduled" isn't read as a trip id.
    Route::get('/customer/trips/scheduled', [TripsController::class, 'customerScheduled']);
    Route::get('/customer/trips/{trip}', [RatingsController::class, 'customerTripDetail']);
    Route::get('/me/coupons', [CustomerCouponsController::class, 'index']);
});

// Public operator config slices used by the customer/driver apps.
Route::middleware('auth:sanctum')->get('/operator/tipping', [OperatorPublicController::class, 'tipping']);
Route::middleware('auth:sanctum')->get('/operator/subscription-popup', [OperatorPublicController::class, 'subscriptionPopup']);
Route::middleware('auth:sanctum')->get('/operator/driver-payment-modes', [OperatorPublicController::class, 'driverPaymentModes']);
Route::middleware('auth:sanctum')->get('/operator/payment-methods', [OperatorPublicController::class, 'paymentMethods']);

Route::post('/payments/webhook/razorpay', [PaymentsController::class, 'razorpayWebhook'])->middleware('throttle:webhooks');


// Fixed Route Module — dedicated endpoints, kept separate from legacy shared routes.
Route::middleware(['auth:sanctum', 'role:customer'])->group(function () {
    Route::get('/fixed/routes', [FixedRoutesController::class, 'index']);
    Route::get('/fixed/routes/{route}/departures', [FixedRoutesController::class, 'departures']);
    Route::get('/fixed/departures/{departure}/seat-map', [FixedSeatMapController::class, 'show']);
    Route::get('/fixed/active-hold', [FixedBookingsController::class, 'activeHold']);
    Route::get('/fixed/seat-holds/{fixedSeatHold}', [FixedBookingsController::class, 'showSeatHold']);
    Route::post('/fixed/coupon-preview', [FixedBookingsController::class, 'couponPreview'])->middleware('throttle:booking');
    Route::post('/fixed/seat-holds', [FixedBookingsController::class, 'storeSeatHold'])->middleware(['throttle:booking', 'idempotent']);
    Route::post('/fixed/seat-holds/{fixedSeatHold}/release', [FixedBookingsController::class, 'releaseSeatHold'])->middleware('throttle:booking');
    Route::post('/fixed/seat-holds/{fixedSeatHold}/coupon', [FixedBookingsController::class, 'updateSeatHoldCoupon'])->middleware('throttle:booking');
    Route::post('/fixed/seat-holds/{fixedSeatHold}/razorpay-order', [FixedBookingsController::class, 'createSeatHoldRazorpayOrder'])->middleware(['throttle:booking', 'idempotent']);
    Route::post('/fixed/seat-holds/{fixedSeatHold}/confirm-payment', [FixedBookingsController::class, 'confirmSeatHoldPayment'])->middleware(['throttle:booking', 'idempotent']);
    Route::get('/fixed/bookings', [FixedBookingsController::class, 'index']);
    Route::get('/fixed/bookings/{reservation}', [FixedBookingsController::class, 'show']);
    Route::post('/fixed/bookings/{reservation}/cancel', [FixedBookingsController::class, 'cancel'])->middleware('throttle:booking');
    Route::post('/fixed/bookings/{reservation}/rate', [FixedBookingsController::class, 'rate'])->middleware('throttle:booking');
    // B5 — "My refunds": everything owed to / returned to this customer
    // across fixed + shuttle bookings, with how and when it arrives.
    Route::get('/customer/refunds', [RefundsController::class, 'customerIndex']);

    Route::get('/shuttle/bookings', [ShuttleBookingsController::class, 'index']);
    Route::post('/shuttle/bookings', [ShuttleBookingsController::class, 'store'])->middleware(['throttle:booking', 'idempotent']);
    Route::post('/shuttle/bookings/{booking}/request-driver', [ShuttleBookingsController::class, 'requestDriver'])->middleware('throttle:booking');
    Route::post('/shuttle/coupon-preview', [ShuttleBookingsController::class, 'couponPreview'])->middleware('throttle:booking');
    Route::get('/shuttle/trips/{trip}/my-booking', [ShuttleBookingsController::class, 'forTrip']);
    Route::get('/shuttle/bookings/{booking}/seats', [ShuttleBookingsController::class, 'seatMap']);
    Route::post('/shuttle/bookings/{booking}/seats', [ShuttleBookingsController::class, 'selectSeats'])->middleware('throttle:booking');
    Route::post('/shuttle/bookings/{booking}/razorpay-order', [ShuttleBookingsController::class, 'createRazorpayOrder'])->middleware(['throttle:booking', 'idempotent']);
    Route::post('/shuttle/bookings/{booking}/confirm-payment', [ShuttleBookingsController::class, 'confirmPayment'])->middleware(['throttle:booking', 'idempotent']);
    Route::post('/shuttle/bookings/{booking}/cancel', [ShuttleBookingsController::class, 'cancel'])->middleware('throttle:booking');
});

Route::middleware(['auth:sanctum', 'role:driver'])->group(function () {
    // B5 — refunds on this driver's trips (informational: paid by the
    // company, never deducted from the driver).
    Route::get('/driver/refunds', [RefundsController::class, 'driverIndex']);

    Route::get('/fixed/driver/routes', [FixedDriverController::class, 'routes']);
    Route::get('/fixed/driver/routes/{route}/layouts', [FixedDriverController::class, 'layouts']);
    Route::get('/fixed/driver/vehicles', [FixedDriverController::class, 'vehicles']);
    Route::post('/fixed/driver/vehicles', [FixedDriverController::class, 'open'])->middleware('throttle:booking');
    Route::get('/fixed/departures/{departure}/manifest', [FixedDriverController::class, 'manifest']);
    Route::get('/fixed/driver/departures/{departure}/pending-holds', [FixedDriverController::class, 'pendingSeatHolds']);
    Route::post('/fixed/driver/seat-holds/{fixedSeatHold}/accept', [FixedDriverController::class, 'acceptSeatHold']);
    Route::post('/fixed/driver/seat-holds/{fixedSeatHold}/reject', [FixedDriverController::class, 'rejectSeatHold']);
    Route::get('/fixed/driver/departures/{departure}/seat-map', [FixedDriverController::class, 'seatMap']);
    Route::post('/fixed/driver/departures/{departure}/seats/block', [FixedDriverController::class, 'blockSeat']);
    Route::post('/fixed/driver/departures/{departure}/seats/unblock', [FixedDriverController::class, 'unblockSeat']);
    Route::post('/fixed/departures/{departure}/start', [FixedDriverController::class, 'start']);
    Route::post('/fixed/departures/{departure}/depart', [FixedDriverController::class, 'depart']);
    Route::post('/fixed/departures/{departure}/close-bookings', [FixedDriverController::class, 'closeBookings']);
    Route::post('/fixed/departures/{departure}/open-bookings', [FixedDriverController::class, 'openBookings']);
    Route::post('/fixed/departures/{departure}/complete', [FixedDriverController::class, 'complete']);
    Route::post('/fixed/bookings/{reservation}/boarding-otp', [FixedDriverController::class, 'sendBoardingOtp'])->middleware('throttle:otp');
    Route::post('/fixed/bookings/{reservation}/board', [FixedDriverController::class, 'board']);
    Route::post('/fixed/bookings/{reservation}/drop', [FixedDriverController::class, 'drop']);
    Route::post('/fixed/bookings/{reservation}/no-show', [FixedDriverController::class, 'noShow']);
    Route::post('/fixed/driver/bookings/{reservation}/cancel', [FixedDriverController::class, 'cancelPassenger'])->middleware('throttle:booking');
    Route::post('/fixed/driver/vehicles/{departure}/cancel', [FixedDriverController::class, 'cancelDeparture'])->middleware('throttle:booking');

    // Shuttle pool — driver's multi-passenger manifest + per-rider board/drop.
    Route::get('/shuttle/journeys/{journey}/manifest', [ShuttleDriverController::class, 'manifest']);
    Route::get('/shuttle/trips/{trip}/manifest', [ShuttleDriverController::class, 'manifestForTrip']);
    Route::post('/shuttle/bookings/{booking}/boarding-otp', [ShuttleDriverController::class, 'sendBoardingOtp'])->middleware('throttle:otp');
    Route::post('/shuttle/bookings/{booking}/board', [ShuttleDriverController::class, 'board']);
    Route::post('/shuttle/bookings/{booking}/drop', [ShuttleDriverController::class, 'drop']);
});

Route::middleware(['auth:sanctum', 'role:admin', 'manager.city', 'permission:rides'])->group(function () {
    // Service catalogue: scope (Local/Outstation) → mode (Private/Fixed/Shuttle)
    // toggles that gate what BOTH apps offer (customer booking + driver signup).
    Route::get('/admin/cities/{city}/ride-products', [AdminCityRideProductsController::class, 'index']);
    // Keyed by scope/mode strings, not row ids — the catalogue is global now.
    Route::patch('/admin/cities/{city}/ride-products/scopes/{scope}', [AdminCityRideProductsController::class, 'updateScope']);
    Route::patch('/admin/cities/{city}/ride-products/scopes/{scope}/modes/{mode}', [AdminCityRideProductsController::class, 'updateMode']);

    Route::get('/admin/cities/{city}/fixed-routes', [AdminFixedRoutesController::class, 'index']);
    Route::post('/admin/cities/{city}/fixed-routes/import-kml', [AdminFixedRoutesController::class, 'importKml']);
    Route::post('/admin/cities/{city}/fixed-routes/import-kml-bulk', [AdminFixedRoutesController::class, 'bulkImportKml']);
    Route::post('/admin/cities/{city}/fixed-routes', [AdminFixedRoutesController::class, 'store']);
    Route::patch('/admin/cities/{city}/fixed-routes/{route}', [AdminFixedRoutesController::class, 'update']);
    Route::post('/admin/cities/{city}/fixed-routes/{route}/copy', [AdminFixedRoutesController::class, 'copy']);

    // Route Groups — reusable bundles of fixed routes; the unit of driver route allocation.
    Route::post('/admin/cities/{city}/route-groups/setup', [AdminRouteGroupsController::class, 'setup']);
    Route::post('/admin/cities/{city}/route-groups/setup-batch', [AdminRouteGroupsController::class, 'setupBatch']);
    Route::put('/admin/cities/{city}/route-groups/{routeGroup}/setup', [AdminRouteGroupsController::class, 'setup']);
    Route::get('/admin/cities/{city}/route-groups', [AdminRouteGroupsController::class, 'index']);
    Route::post('/admin/cities/{city}/route-groups', [AdminRouteGroupsController::class, 'store']);
    Route::patch('/admin/cities/{city}/route-groups/{routeGroup}', [AdminRouteGroupsController::class, 'update']);
    Route::delete('/admin/cities/{city}/route-groups/{routeGroup}', [AdminRouteGroupsController::class, 'destroy']);
    Route::put('/admin/cities/{city}/route-groups/{routeGroup}/drivers', [AdminRouteGroupsController::class, 'syncDrivers']);
    Route::get('/admin/cities/{city}/route-group-drivers', [AdminRouteGroupsController::class, 'cityDrivers']);

    // Vehicle Seat Layouts — reusable seat maps per (city, vehicle_type). Every
    // fixed departure carries one; SeatMapService snapshots its cells into
    // departure_seats when the driver opens the vehicle.
    Route::get('/admin/cities/{city}/vehicle-seat-layouts', [AdminVehicleSeatLayoutsController::class, 'index']);
    Route::post('/admin/cities/{city}/vehicle-seat-layouts', [AdminVehicleSeatLayoutsController::class, 'store']);
    Route::get('/admin/cities/{city}/vehicle-seat-layouts/{vehicleSeatLayout}', [AdminVehicleSeatLayoutsController::class, 'show']);
    Route::patch('/admin/cities/{city}/vehicle-seat-layouts/{vehicleSeatLayout}', [AdminVehicleSeatLayoutsController::class, 'update']);
    Route::delete('/admin/cities/{city}/vehicle-seat-layouts/{vehicleSeatLayout}', [AdminVehicleSeatLayoutsController::class, 'destroy']);
    Route::get('/admin/cities/{city}/fixed-departures', [AdminFixedDeparturesController::class, 'index']);
    Route::get('/admin/cities/{city}/fixed-bookings', [AdminFixedDeparturesController::class, 'bookings']);
    Route::get('/admin/cities/{city}/shuttle-bookings', [AdminShuttleBookingsController::class, 'index']);
    Route::post('/admin/cities/{city}/shuttle-bookings/{booking}/resolve-refund', [AdminShuttleBookingsController::class, 'resolveRefund']);

    Route::get('/admin/cities/{city}/fixed-bookings/{reservation}/timeline', [AdminFixedDeparturesController::class, 'bookingTimeline']);
    Route::post('/admin/cities/{city}/fixed-bookings/{reservation}/notes', [AdminFixedDeparturesController::class, 'storeBookingNote']);
    Route::post('/admin/cities/{city}/fixed-bookings/{reservation}/cancel', [AdminFixedDeparturesController::class, 'cancelBooking']);
    Route::post('/admin/cities/{city}/fixed-bookings/{reservation}/change-drop', [AdminFixedDeparturesController::class, 'changePassengerDrop']);
    Route::post('/admin/cities/{city}/fixed-bookings/{reservation}/support-action', [AdminFixedDeparturesController::class, 'storeSupportAction']);
    Route::get('/admin/cities/{city}/fixed-departures/{departure}/manifest', [AdminFixedDeparturesController::class, 'manifest']);
    Route::get('/admin/cities/{city}/departures/{departure}/manifest', [AdminFixedDeparturesController::class, 'manifest']);
    Route::post('/admin/cities/{city}/fixed-departures', [AdminFixedDeparturesController::class, 'store']);
    Route::patch('/admin/cities/{city}/fixed-departures/{departure}', [AdminFixedDeparturesController::class, 'update']);
    Route::post('/admin/cities/{city}/fixed-departures/{departure}/close-bookings', [AdminFixedDeparturesController::class, 'closeBookings']);
    Route::post('/admin/cities/{city}/fixed-departures/{departure}/start', [AdminFixedDeparturesController::class, 'startDeparture']);
    Route::post('/admin/cities/{city}/fixed-departures/{departure}/cancel', [AdminFixedDeparturesController::class, 'cancelDeparture']);
});

// Finance section — the money-in ledger, financial-health overview (B6), and
// the customer-refund register (B5). All gated by the single `finance`
// permission so one toggle controls the whole Finance sidebar group.
Route::middleware(['auth:sanctum', 'role:admin', 'permission:finance'])->group(function () {
    Route::get('/admin/finance/overview', [FinanceController::class, 'overview']);
    Route::get('/admin/finance/money-in', [FinanceController::class, 'moneyIn']);

    // Independent financial sections
    Route::get('/admin/finance/wallets', [FinanceController::class, 'wallets']);
    Route::get('/admin/finance/transfers/pending', [FinanceController::class, 'pendingTransfers']);
    Route::get('/admin/finance/transfers/completed', [FinanceController::class, 'completedTransfers']);
    Route::get('/admin/finance/commissions', [FinanceController::class, 'commissions']);
    Route::get('/admin/finance/driver-earnings', [FinanceController::class, 'driverEarnings']);

    // The customer-refund register: who is owed money, why, and the proof
    // trail once the operator sends it (GPay/bank, outside the app).
    Route::get('/admin/refunds', [RefundsController::class, 'adminIndex']);
    Route::post('/admin/refunds/{module}/{id}/mark-refunded', [RefundsController::class, 'adminMarkRefunded'])->whereIn('module', ['fixed', 'shuttle'])->whereNumber('id');

    // Phase 4 — read-only monitors onto the auto-split engine.
    Route::get('/admin/payouts/monitor', [\App\Http\Controllers\Admin\PayoutMonitorController::class, 'payouts']);
    Route::get('/admin/ledger', [\App\Http\Controllers\Admin\PayoutMonitorController::class, 'ledger']);
});
