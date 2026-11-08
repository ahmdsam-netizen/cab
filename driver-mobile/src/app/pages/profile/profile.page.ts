import { DRIVER_MAP_STYLE } from '../../core/driver-map';
import { Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AlertController, Platform, ViewDidEnter, ViewWillLeave } from '@ionic/angular';
import { PushService } from '../../core/push.service';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { forkJoin, of, Subscription } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { ApiService } from '../../core/api.service';
import { AuthService, AuthUser } from '../../core/auth.service';
import { DriverOnboardingDraftService } from '../../core/driver-onboarding-draft.service';
import { GeolocationService } from '../../core/geolocation.service';
import { PlacesService, PlaceSuggestion } from '../../core/places.service';
import { ApprovedDriverGuard } from '../../core/approved-driver.guard';
import { DriverServiceAccess } from '../../core/driver-service-access';

declare const google: any;

type DocStatus = 'idle' | 'uploading' | 'done' | 'error';
type ServiceScope = 'local' | 'outstation' | 'both';
type ServiceMode = 'private' | 'fixed' | 'shuttle';
type LabelType = 'text' | 'number' | 'date' | 'url';

interface CityOpt { id: number; name: string; country_code: string | null; }
interface StandOpt { id: number; name: string; }
interface VehicleTypeOpt { id: number; name: string; description: string | null; image_url: string | null; }
interface CityVehicleOpt { id: number; display_name: string; max_people: number; luggage_capacity: number; vehicle_type_id: number; ride_type_id: number | null; image_url?: string | null; }
interface FleetOpt { id: number; name: string; city_id: number | null; }
interface DocumentLabelDef { id: number; label: string; label_type: LabelType; mandatory: boolean; sort_order: number; }
interface RideModeOption { id: number; scope: ServiceScope; mode: ServiceMode; name: string; display_name?: string | null; image_url: string | null; sort_order: number; }
interface RideScopeOption { id: number; scope: ServiceScope; name: string; sort_order: number; modes: RideModeOption[]; }
interface CatalogDoc {
  id: number;
  name: string;
  no_of_images: number;
  category: string;
  required: string | null;
  gallery_restricted: boolean;
  instructions: string | null;
  labels: DocumentLabelDef[];
}
interface ExistingUpload {
  id: number;
  document_id: number | null;
  image_index: number | null;
  status: 'uploaded' | 'approved' | 'rejected';
  rejection_reason: string | null;
  file_url: string;
  uploaded_at: string | null;
  label_values?: Record<string, string> | null;
  vehicle_type_id?: number | null;
}
interface DocImageSlot {
  index: number;
  file: File | null;
  status: DocStatus;
  error?: string;
  existing: ExistingUpload | null;
}
interface DocUploadState {
  doc: CatalogDoc;
  uploads: DocImageSlot[];
  labelValues: Record<string, string>;
}

@Component({
  selector: 'app-profile',
  templateUrl: './profile.page.html',
  styleUrls: ['./profile.page.scss'],
  standalone: false,
})
export class ProfilePage implements OnInit, OnDestroy {
  @ViewChild('addressFieldWrap') addressFieldWrap?: ElementRef<HTMLElement>;
  @ViewChild('addressMapEl') addressMapEl?: ElementRef<HTMLElement>;

  // Tab segment switcher: 'profile' | 'vehicle' | 'documents'
  activeSegment: 'profile' | 'vehicle' | 'documents' = 'profile';
  editingProfile = false;
  accountWallet: number | null = null;
  serviceAccess: DriverServiceAccess | null = null;
  serviceAccessTab: 'stands' | 'routes' = 'stands';
  serviceAccessLoading = false;
  serviceAccessFailed = false;

  get showAccountOverview(): boolean {
    return !this.onboarding && this.activeSegment === 'profile' && !this.editingProfile;
  }

  backToAccount(): void {
    this.activeSegment = 'profile'; this.editingProfile = false;
  }

  editAccountProfile(): void {
    this.activeSegment = 'profile'; this.editingProfile = true;
  }

  openAccountPage(path: string): void { void this.router.navigateByUrl(path); }

  async signOutAccount(): Promise<void> {
    const alert = await this.alerts.create({ header: 'Log out?', message: 'You will need to sign in again to access your driver account.', buttons: [{ text: 'Cancel', role: 'cancel' }, { text: 'Log out', role: 'confirm' }] });
    await alert.present();
    if ((await alert.onDidDismiss()).role !== 'confirm') return;
    try { await this.push.unregister(); } catch { /* best-effort */ }
    this.api.post('/me/logout', {}).subscribe({ next: () => void this.finishAccountLogout(), error: () => void this.finishAccountLogout() });
  }

  private async finishAccountLogout(): Promise<void> {
    await this.auth.logout();
    void this.router.navigateByUrl('/auth/login', { replaceUrl: true });
  }

  // Personal Profile fields
  photoFile: File | null = null;
  photoPreview: string | null = null;
  private photoDraftReady: Promise<void> = Promise.resolve();
  readonly defaultAvatar = 'assets/default-avatar.svg';
  name = '';
  email = '';
  phone = '';
  dob = '';
  address = '';

  // Phone Change Modal State
  showPhoneModal = false;
  phoneStep: 'input' | 'otp' = 'input';
  newPhone = '';
  otpCode = '';
  phoneBusy = false;
  phoneError: string | null = null;
  resendCountdown = 0;
  private resendTimer: any = null;

  // Registered Area & Vehicle data (read-only view)
  cities: CityOpt[] = [];
  vehicleTypes: VehicleTypeOpt[] = [];
  cityVehicles: CityVehicleOpt[] = [];
  fleets: FleetOpt[] = [];
  rideScopes: RideScopeOption[] = [];

  city_id: number | null = null;
  city_ids: number[] = [];
  cityModalOpen = false;
  citySearch = '';
  hasDriverProfile = false;
  registrationStands: StandOpt[] = [];
  selectedStandIds: number[] = [];
  standsLoading = false;
  standsLoadFailed = false;
  private standsRequest?: Subscription;
  selectedScopes: Set<'local' | 'outstation'> = new Set(['local']);
  service_scope: ServiceScope | null = null;
  service_mode: ServiceMode | null = null;
  vehicle_type_id: number | null = null;
  city_vehicle_type_id: number | null = null;
  vehicle_model_year = '';
  vehicle_color = '';
  vehicle_reg_no = '';
  fleet_id: number | null = null;

  // Onboarding registration steps: 'profile' | 'vehicle' | 'documents'
  onboardingStep: 'profile' | 'vehicle' | 'documents' = 'profile';
  ride_type_id: number | null = null;
  rideModes: Array<RideModeOption & { key: string }> = [];
  selectedRideKey: string | null = null;
  submitting = false;

  // Address autocomplete (Google Places)
  addressQuery = '';
  addressSuggestions: PlaceSuggestion[] = [];
  addressLoading = false;
  mapPickerOpen = false;
  mapLoading = false;
  mapError: string | null = null;
  mapSelectedAddress = '';
  mapSelectedPosition: { lat: number; lng: number } | null = null;
  private addressMap: any = null;
  private addressMapMarker: any = null;
  private addressMapClickListener: any = null;
  private addressSkipNextQueryEmit = false;
  private addressDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private routeSub?: Subscription;

  readonly maxDob = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  })();

  private deviceInfo: { app_version?: string; os_version?: string; device_type?: string } = {};

  // Verification Documents fields
  docs: DocUploadState[] = [];
  driverApproved = false;
  profileLoaded = false;
  registeredVehicleImageUrl: string | null = null;
  documentsRefreshInFlight = false;

  busy = false;
  error: string | null = null;
  message: string | null = null;
  onboarding = false;
  private touchStartX = 0;
  private touchStartY = 0;
  private backSub?: Subscription;

  constructor(
    private api: ApiService,
    private auth: AuthService,
    private draft: DriverOnboardingDraftService,
    private router: Router,
    private route: ActivatedRoute,
    private geo: GeolocationService,
    private places: PlacesService,
    private platform: Platform,
    private alerts: AlertController,
    private push: PushService,
  ) {}

  get onboardingTitle(): string {
    if (this.onboardingStep === 'profile') return 'Personal Profile';
    if (this.onboardingStep === 'vehicle') return 'Vehicle & Service';
    return 'Verification Documents';
  }

  get onboardingSubtitle(): string {
    if (this.onboardingStep === 'profile') return 'Step 1 of 3: Enter your personal details and address.';
    if (this.onboardingStep === 'vehicle') return 'Step 2 of 3: Choose your operating city, service mode, and vehicle.';
    return 'Step 3 of 3: Upload your required verification documents.';
  }

  goToOnboardingStep(step: 'profile' | 'vehicle' | 'documents'): void {
    if (step === 'profile') {
      this.backToProfileStep();
    } else if (step === 'vehicle') {
      if (this.onboardingStep === 'documents') {
        this.backToVehicleStep();
      } else {
        this.submitProfile();
      }
    } else if (step === 'documents') {
      if (this.onboardingStep === 'vehicle') {
        this.submitRegistration();
      }
    }
  }

  onTouchStart(ev: TouchEvent): void {
    if (!this.onboarding) return;
    this.touchStartX = ev.touches[0].clientX;
    this.touchStartY = ev.touches[0].clientY;
  }

  onTouchEnd(ev: TouchEvent): void {
    if (!this.onboarding) return;
    const diffX = ev.changedTouches[0].clientX - this.touchStartX;
    const diffY = Math.abs(ev.changedTouches[0].clientY - this.touchStartY);

    // Swipe right (from left to right) > 70px
    if (diffX > 70 && diffY < 60) {
      this.handleOnboardingBack();
    }
  }

  handleOnboardingBack(): void {
    if (this.onboardingStep === 'documents') {
      this.backToVehicleStep();
    } else if (this.onboardingStep === 'vehicle') {
      this.backToProfileStep();
    }
  }

  ionViewDidEnter(): void {
    this.refreshDocumentStep(false);
    if (!this.onboarding && this.activeSegment === 'vehicle') this.loadServiceAccess();
    this.backSub = this.platform.backButton.subscribeWithPriority(99, () => {
      if (this.onboarding && this.onboardingStep !== 'profile') {
        this.handleOnboardingBack();
      }
    });
  }

  ionViewWillLeave(): void {
    this.backSub?.unsubscribe();
  }

  ngOnInit(): void {
    this.onboarding = window.location.search.includes('next=registration');

    this.routeSub = this.route.queryParams.subscribe((params) => {
      if (params['tab'] === 'documents') {
        this.activeSegment = 'documents';
      } else if (params['tab'] === 'vehicle') {
        this.switchSegment('vehicle');
      } else if (params['tab'] === 'profile') {
        this.activeSegment = 'profile';
        this.editingProfile = true;
      }
    });

    const me = this.auth.getUser();
    if (me) {
      this.name = me.name && me.name !== 'User' ? me.name : '';
      this.email = me.email && !me.email.endsWith('@otp.local') ? me.email : '';
      this.phone = me.phone || '';
      if (me.avatar_url) this.photoPreview = this.auth.resolveAvatarUrl(me);
    }

    if (this.onboarding) {
      const draftData = this.draft.getProfile();
      if (draftData) {
        if (draftData.name) this.name = draftData.name;
        if (draftData.email) this.email = draftData.email;
        if (draftData.dob) this.dob = draftData.dob;
        if (draftData.address) {
          this.address = draftData.address;
          this.addressQuery = draftData.address;
          this.addressSkipNextQueryEmit = true;
        }
      }
      this.photoDraftReady = this.draft.getPhotoFile(me?.id ?? 0).then(draftPhoto => {
        if (draftPhoto && !this.photoFile) {
          this.photoFile = draftPhoto;
          const reader = new FileReader();
          reader.onload = () => { this.photoPreview = reader.result as string; };
          reader.readAsDataURL(draftPhoto);
        }
      }).catch(() => { this.error = 'Could not restore your saved photo. Please select it again.'; });
    }

    void this.initDeviceInfo();
    this.loadCatalogData();
    this.reload();
  }

  ngOnDestroy(): void {
    this.routeSub?.unsubscribe();
    this.standsRequest?.unsubscribe();
    if (this.addressDebounceTimer) clearTimeout(this.addressDebounceTimer);
    if (this.resendTimer) {
      clearInterval(this.resendTimer);
      this.resendTimer = null;
    }
  }

  openPhoneModal(): void {
    this.showPhoneModal = true;
    this.phoneStep = 'input';
    this.newPhone = '';
    this.otpCode = '';
    this.phoneError = null;
    this.phoneBusy = false;
  }

  closePhoneModal(): void {
    if (this.phoneBusy) return;
    this.showPhoneModal = false;
    this.phoneError = null;
    if (this.resendTimer) {
      clearInterval(this.resendTimer);
      this.resendTimer = null;
    }
  }

  sendPhoneOtp(): void {
    const phone = this.newPhone.trim();
    if (!phone) {
      this.phoneError = 'Please enter a valid phone number.';
      return;
    }
    this.phoneError = null;
    this.phoneBusy = true;

    this.api.post<{ ok: boolean; resend_in?: number; message?: string }>('/me/phone/change/start', { phone }).subscribe({
      next: (res) => {
        this.phoneBusy = false;
        this.phoneStep = 'otp';
        this.otpCode = '';
        this.startResendCountdown(res.resend_in || 30);
      },
      error: (err) => {
        this.phoneBusy = false;
        this.phoneError = err?.error?.message || 'Could not send verification code.';
      },
    });
  }

  verifyPhoneOtp(): void {
    const code = this.otpCode.trim();
    if (!code) {
      this.phoneError = 'Please enter the verification code.';
      return;
    }
    this.phoneError = null;
    this.phoneBusy = true;

    this.api.post<{ ok: boolean; user: AuthUser; message?: string }>('/me/phone/change/verify', {
      phone: this.newPhone.trim(),
      code,
    }).subscribe({
      next: (res) => {
        this.phoneBusy = false;
        if (res.user) {
          this.auth.updateUser(res.user);
          this.phone = res.user.phone || this.newPhone.trim();
        }
        this.message = 'Phone number updated successfully.';
        this.closePhoneModal();
      },
      error: (err) => {
        this.phoneBusy = false;
        this.phoneError = err?.error?.message || 'Verification failed. Please check the code.';
      },
    });
  }

  private startResendCountdown(sec: number): void {
    this.resendCountdown = sec;
    if (this.resendTimer) clearInterval(this.resendTimer);
    this.resendTimer = setInterval(() => {
      if (this.resendCountdown > 0) {
        this.resendCountdown--;
      } else {
        clearInterval(this.resendTimer);
        this.resendTimer = null;
      }
    }, 1000);
  }

  switchSegment(seg: 'profile' | 'vehicle' | 'documents'): void {
    this.activeSegment = seg;
    if (seg === 'profile') this.editingProfile = false;
    this.error = null;
    this.message = null;
    if (seg === 'vehicle' && !this.onboarding) this.loadServiceAccess();
  }

  loadServiceAccess(): void {
    if (this.serviceAccessLoading) return;
    this.serviceAccessLoading = true;
    this.serviceAccessFailed = false;
    this.api.get<DriverServiceAccess>('/drivers/me/service-access').subscribe({
      next: access => {
        this.serviceAccess = access;
        this.serviceAccessLoading = false;
      },
      error: () => {
        this.serviceAccess = null;
        this.serviceAccessLoading = false;
        this.serviceAccessFailed = true;
      },
    });
  }

  loadCatalogData(): void {
    forkJoin({
      cities: this.api.get<{ data: CityOpt[] }>('/catalog/cities').pipe(catchError(() => of({ data: [] as CityOpt[] }))),
      vehicleTypes: this.api.get<{ data: VehicleTypeOpt[] }>('/catalog/vehicle-types').pipe(catchError(() => of({ data: [] as VehicleTypeOpt[] }))),
      fleets: this.api.get<{ data: FleetOpt[] }>('/catalog/fleets').pipe(catchError(() => of({ data: [] as FleetOpt[] }))),
    }).subscribe({
      next: ({ cities, vehicleTypes, fleets }) => {
        this.cities = cities.data ?? [];
        this.vehicleTypes = vehicleTypes.data ?? [];
        this.fleets = fleets.data ?? [];

        if (this.city_id && this.vehicle_type_id) {
          this.loadCityVehicles();
        }
      },
    });
  }

  reloadAll(): void {
    this.reload();
    this.refreshDocumentStep(true);
  }

  reload(): void {
    if (!this.onboarding) this.api.get<{ balance: number }>('/drivers/me/wallet').subscribe({ next: res => this.accountWallet = Number.isFinite(Number(res.balance)) && res.balance != null ? Number(res.balance) : null, error: () => this.accountWallet = null });
    this.error = null;
    this.message = null;
    this.busy = true;

    this.api.get<{
      driver: {
        ride_type_id?: number | null;
        image_url?: string | null;
        city_id?: number | null;
        city_ids?: number[] | null;
        cities?: Array<{ id: number; name: string }> | null;
        vehicle_type_id?: number | null;
        city_vehicle_type_id?: number | null;
        fleet_id?: number | null;
        vehicle_model?: string | null;
        vehicle_color?: string | null;
        vehicle_reg_no?: string | null;
        service_scope?: ServiceScope | null;
        service_mode?: ServiceMode | null;
        approval_status?: string;
        dob?: string | null;
        address?: string | null;
      } | null;
      user: AuthUser;
      documents?: ExistingUpload[];
    }>('/drivers/me').subscribe({
      next: (res) => {
        this.profileLoaded = true;
        this.hasDriverProfile = !!res.driver;
        this.registeredVehicleImageUrl = res.driver?.image_url ?? null;
        this.busy = false;
        if (res.user) {
          this.auth.updateUser(res.user);
          this.name = res.user.name && res.user.name !== 'User' ? res.user.name : this.name;
          this.email = res.user.email && !res.user.email.endsWith('@otp.local') ? res.user.email : '';
          this.phone = res.user.phone || this.phone;
          if (res.user.avatar_url && !this.photoFile) {
            this.photoPreview = this.auth.resolveAvatarUrl(res.user);
          }
        }
        if (res.driver) {
          if (res.driver.dob) this.dob = res.driver.dob;
          if (res.driver.address) this.address = res.driver.address;
          if (res.driver.city_ids && Array.isArray(res.driver.city_ids) && res.driver.city_ids.length > 0) {
            this.city_ids = res.driver.city_ids;
          } else if (res.driver.city_id) {
            this.city_ids = [res.driver.city_id];
          }
          this.city_id = this.city_ids[0] ?? res.driver.city_id ?? this.city_id;
          this.ride_type_id = res.driver.ride_type_id ?? this.ride_type_id;
          this.vehicle_type_id = res.driver.vehicle_type_id ?? this.vehicle_type_id;
          this.city_vehicle_type_id = res.driver.city_vehicle_type_id ?? this.city_vehicle_type_id;
          this.fleet_id = res.driver.fleet_id ?? this.fleet_id;
          this.vehicle_model_year = res.driver.vehicle_model ?? this.vehicle_model_year;
          this.vehicle_color = res.driver.vehicle_color ?? this.vehicle_color;
          this.vehicle_reg_no = res.driver.vehicle_reg_no ?? this.vehicle_reg_no;
          this.service_scope = res.driver.service_scope ?? this.service_scope;
          if (this.service_scope === 'both') {
            this.selectedScopes = new Set(['local', 'outstation']);
          } else if (this.service_scope === 'outstation') {
            this.selectedScopes = new Set(['outstation']);
          } else if (this.service_scope === 'local') {
            this.selectedScopes = new Set(['local']);
          }
          this.service_mode = res.driver.service_mode ?? this.service_mode;
          this.driverApproved = res.driver.approval_status === 'approved';

          if (this.onboarding && this.city_id) this.loadRegistrationRideModes(this.city_id);
          if (this.city_id && this.vehicle_type_id) this.loadCityVehicles();
        }
        this.refreshDocumentStep(false);
      },
      error: (err) => {
        this.busy = false;
        this.profileLoaded = false;
        this.registeredVehicleImageUrl = null;
        this.error = driverProfileErrorMessage(err);
      },
    });
  }

  // ── Computed Registered Info for Clean Read-Only View ──────

  get cityNameDisplay(): string {
    if (!this.profileLoaded) return 'Profile unavailable';
    if (this.city_ids && this.city_ids.length > 0) {
      const names = this.cities.filter((c) => this.city_ids.includes(c.id)).map((c) => c.name);
      if (names.length) return names.join(', ');
    }
    if (!this.city_id) return 'Not registered';
    const c = this.cities.find((city) => city.id === this.city_id);
    return c ? c.name : 'Registered City';
  }

  get serviceScopeDisplay(): string {
    if (!this.profileLoaded) return 'Profile unavailable';
    if (!this.service_scope) return 'Not registered';
    if (this.service_scope === 'both') return 'Local & Outstation Service';
    return this.service_scope === 'outstation' ? 'Outstation Service' : 'Local Service';
  }

  get serviceModeDisplay(): string {
    if (!this.profileLoaded) return 'Profile unavailable';
    if (!this.service_mode) return 'Not registered';
    if (this.service_mode === 'fixed') return 'Fixed Route';
    if (this.service_mode === 'shuttle') return 'Shared Shuttle';
    return 'Private Taxi';
  }

  get serviceModeIcon(): string {
    if (this.service_mode === 'fixed') return 'git-branch-outline';
    if (this.service_mode === 'shuttle') return 'bus-outline';
    return 'car-outline';
  }

  get fleetNameDisplay(): string {
    if (!this.fleet_id) return 'Independent Driver (No Fleet)';
    const f = this.fleets.find((fl) => fl.id === this.fleet_id);
    return f ? f.name : 'Assigned Fleet';
  }

  get selectedVehicleTypeOpt(): VehicleTypeOpt | undefined {
    return this.vehicleTypes.find((v) => v.id === this.vehicle_type_id);
  }

  get selectedCityVehicleOpt(): CityVehicleOpt | undefined {
    return this.cityVehicles.find((v) => v.id === this.city_vehicle_type_id);
  }

  private loadCityVehicles(): void {
    if (!this.city_id || !this.vehicle_type_id) return;
    this.api.get<{ data: CityVehicleOpt[] }>(`/catalog/cities/${this.city_id}/vehicles?vehicle_type_id=${this.vehicle_type_id}`).pipe(
      catchError(() => of({ data: [] as CityVehicleOpt[] })),
    ).subscribe({
      next: (res) => {
        this.cityVehicles = this.dedupeVehicles(res.data ?? []);
      },
    });
  }

  /**
   * A car set up for several services (Private/Fixed/Shuttle) comes back as
   * multiple rows with the same name — the driver picks their CAR, not a service,
   * so show each vehicle once. Preference when collapsing duplicates:
   *   1. the row the driver already registered with (keep their choice visible),
   *   2. a row wired to a service (non-null ride type) over an unconfigured leftover,
   *   3. otherwise the first one seen.
   */
  private dedupeVehicles(rows: CityVehicleOpt[]): CityVehicleOpt[] {
    const byName = new Map<string, CityVehicleOpt>();
    for (const row of rows) {
      const key = (row.display_name || '').trim().toLowerCase();
      const current = byName.get(key);
      if (!current) { byName.set(key, row); continue; }
      // Never replace the driver's already-selected vehicle.
      if (current.id === this.city_vehicle_type_id) continue;
      if (row.id === this.city_vehicle_type_id) { byName.set(key, row); continue; }
      // Prefer a service-wired row over an unconfigured (null ride type) leftover.
      if (current.ride_type_id == null && row.ride_type_id != null) byName.set(key, row);
    }
    return Array.from(byName.values());
  }

  get dobDisplay(): string {
    if (!this.dob) return '';
    try {
      const d = new Date(this.dob + 'T00:00:00');
      if (isNaN(d.getTime())) return this.dob;
      return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    } catch {
      return this.dob;
    }
  }

  // ── Address Autocomplete & Map ─────────────────────────────

  async onAddressQueryChange(val: string): Promise<void> {
    if (this.addressSkipNextQueryEmit) {
      this.addressSkipNextQueryEmit = false;
      return;
    }
    this.address = '';
    const q = val.trim();
    if (this.addressDebounceTimer) clearTimeout(this.addressDebounceTimer);
    if (!q || q.length < 3) {
      this.addressSuggestions = [];
      this.addressLoading = false;
      return;
    }
    this.addressLoading = true;
    this.addressDebounceTimer = setTimeout(async () => {
      try {
        this.addressSuggestions = await this.places.autocompleteSearch(q);
      } catch {
        this.addressSuggestions = [];
      } finally {
        this.addressLoading = false;
      }
    }, 250);
  }

  async pickAddress(s: PlaceSuggestion): Promise<void> {
    this.addressLoading = true;
    try {
      const d = await this.places.getPlaceDetail(s.place_id);
      if (d?.description) {
        this.address = d.description;
        this.addressSkipNextQueryEmit = true;
        this.addressQuery = d.description;
        this.addressSuggestions = [];
      } else {
        this.address = s.description;
        this.addressSkipNextQueryEmit = true;
        this.addressQuery = s.description;
        this.addressSuggestions = [];
      }
    } catch {
      this.address = s.description;
      this.addressSkipNextQueryEmit = true;
      this.addressQuery = s.description;
      this.addressSuggestions = [];
    } finally {
      this.addressLoading = false;
    }
  }

  scrollAddressFieldIntoView(): void {
    setTimeout(() => {
      this.addressFieldWrap?.nativeElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 300);
  }

  async openAddressMap(): Promise<void> {
    this.mapPickerOpen = true;
    this.mapLoading = true;
    this.mapError = null;
    this.mapSelectedAddress = '';
    this.mapSelectedPosition = null;

    let lat = 34.0837;
    let lng = 74.7973;
    try {
      const pos = await this.geo.getCurrentPosition({ timeout: 5000, enableHighAccuracy: true });
      if (pos) { lat = pos.lat; lng = pos.lng; }
    } catch { /* ignore fallback */ }

    this.mapSelectedPosition = { lat, lng };

    // The picker can be opened before the address autocomplete has loaded the
    // Google Maps SDK (e.g. tapping the map icon straight away in onboarding),
    // so ensure it's loaded before we try to draw the map.
    try {
      await this.places.ensureLoaded();
    } catch {
      this.mapLoading = false;
      this.mapError = 'Could not load the map. Check your connection and try again.';
      return;
    }

    setTimeout(() => this.initAddressMap(lat, lng), 250);
  }

  closeAddressMap(): void {
    this.mapPickerOpen = false;
    if (this.addressMapClickListener && typeof google !== 'undefined') {
      google.maps.event.removeListener(this.addressMapClickListener);
      this.addressMapClickListener = null;
    }
  }

  confirmMapAddress(): void {
    const chosen = this.mapSelectedAddress.trim();
    if (!chosen && !this.mapSelectedPosition) return;
    this.address = chosen || `${this.mapSelectedPosition!.lat.toFixed(5)}, ${this.mapSelectedPosition!.lng.toFixed(5)}`;
    this.addressSkipNextQueryEmit = true;
    this.addressQuery = this.address;
    this.addressSuggestions = [];
    this.closeAddressMap();
  }

  private initAddressMap(lat: number, lng: number): void {
    if (!this.addressMapEl?.nativeElement) return;
    if (typeof google === 'undefined' || !google.maps) {
      this.mapLoading = false;
      this.mapError = 'Google Maps SDK not loaded.';
      return;
    }
    const center = { lat, lng };
    this.addressMap = new google.maps.Map(this.addressMapEl.nativeElement, {
      ...DRIVER_MAP_STYLE,
      center,
      disableDefaultUI: true,
      zoomControl: true,
    });
    this.addressMapMarker = new google.maps.Marker({
      position: center,
      map: this.addressMap,
      draggable: true,
    });

    this.reverseGeocodeMapPosition(lat, lng);
    this.addressMapClickListener = this.addressMap.addListener('click', (e: any) => {
      if (!e.latLng) return;
      const p = { lat: e.latLng.lat(), lng: e.latLng.lng() };
      this.addressMapMarker.setPosition(p);
      this.mapSelectedPosition = p;
      this.reverseGeocodeMapPosition(p.lat, p.lng);
    });

    this.addressMapMarker.addListener('dragend', () => {
      const pos = this.addressMapMarker.getPosition();
      if (!pos) return;
      const p = { lat: pos.lat(), lng: pos.lng() };
      this.mapSelectedPosition = p;
      this.reverseGeocodeMapPosition(p.lat, p.lng);
    });

    this.mapLoading = false;
  }

  private reverseGeocodeMapPosition(lat: number, lng: number): void {
    if (typeof google === 'undefined' || !google.maps || !google.maps.Geocoder) {
      this.mapSelectedAddress = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      return;
    }
    this.mapLoading = true;
    const geocoder = new google.maps.Geocoder();
    geocoder.geocode({ location: { lat, lng } }, (results: any[], status: string) => {
      this.mapLoading = false;
      if (status === 'OK' && results && results[0]) {
        this.mapSelectedAddress = results[0].formatted_address;
      } else {
        this.mapSelectedAddress = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      }
    });
  }

  private async initDeviceInfo(): Promise<void> {
    try { this.deviceInfo.device_type = Capacitor.getPlatform(); } catch { /* ignore */ }
    try {
      if (typeof navigator !== 'undefined') {
        this.deviceInfo.os_version = parseOsVersion(navigator.userAgent);
      }
    } catch { /* ignore */ }
    try {
      if (Capacitor.isNativePlatform()) {
        const info = await CapacitorApp.getInfo();
        this.deviceInfo.app_version = info.version?.slice(0, 32);
      }
    } catch { /* ignore */ }
  }

  onPhotoError(ev: Event): void {
    const i = ev.target as HTMLImageElement;
    if (i && i.src.indexOf('default-avatar') === -1) i.src = this.defaultAvatar;
  }

  async onPhotoChange(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    if (!file) return;
    if (!file.type.startsWith('image/') || file.size > 4 * 1024 * 1024) {
      this.error = 'Choose an image of 4 MB or smaller.';
      input.value = '';
      return;
    }
    this.error = null;
    this.photoFile = file;
    const reader = new FileReader();
    reader.onload = () => { this.photoPreview = reader.result as string; };
    reader.readAsDataURL(file);
    if (this.onboarding) {
      try { await this.draft.setPhotoFile(file, this.auth.getUser()?.id ?? 0); }
      catch { this.error = 'Could not keep your photo for later. Please select it again before continuing.'; }
    }
  }

  async submitProfile(): Promise<void> {
    await this.photoDraftReady;
    this.error = null;
    const name = this.name.trim();
    const email = this.email.trim();
    if (!name) { this.error = 'Please enter your name.'; return; }
    if (this.onboarding && !email) { this.error = 'Please enter your email address.'; return; }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { this.error = 'Please enter a valid email address.'; return; }
    if (this.onboarding) {
      if (!this.dob) { this.error = 'Please select your date of birth.'; return; }
      if (!this.address) { this.error = 'Please pick your address from the suggestions.'; return; }
    }

    if (this.onboarding) {
      this.busy = true;
      try {
      await this.draft.setProfile({
        name,
        email,
        dob: this.dob,
        address: this.address,
        app_version: this.deviceInfo.app_version?.slice(0, 32),
        os_version: this.deviceInfo.os_version?.slice(0, 32),
        device_type: this.deviceInfo.device_type?.slice(0, 64),
      }, this.photoFile, this.auth.getUser()?.id ?? 0);
      } catch {
        this.error = 'Could not save your registration draft. Please try again.';
        return;
      } finally { this.busy = false; }
      // Advance to step 2 (vehicle & service) — this is where registration is
      // actually submitted. Previously this just saved a local draft and stopped,
      // leaving the driver stuck on the profile screen.
      this.error = null;
      this.message = null;
      this.onboardingStep = 'vehicle';
      return;
    }

    const fd = new FormData();
    fd.append('name', name);
    if (email) fd.append('email', email);
    if (this.photoFile) fd.append('photo', this.photoFile);

    this.busy = true;
    this.api.postForm<{ user: AuthUser }>('/me/profile', fd).subscribe({
      next: (res) => {
        this.auth.updateUser(res.user);
        this.busy = false;
        this.message = 'Profile updated successfully.';
      },
      error: (err) => {
        this.error = err?.error?.message || 'Could not save profile.';
        this.busy = false;
      },
    });
  }

  // ── Onboarding step 2 — vehicle & service ──────────────────

  backToProfileStep(): void {
    this.error = null;
    this.message = null;
    this.onboardingStep = 'profile';
  }

  openCityModal(): void {
    if (this.submitting) return;
    this.citySearch = '';
    this.cityModalOpen = true;
  }

  closeCityModal(): void {
    if (!this.cityModalOpen) return;
    this.cityModalOpen = false;
    if ((this.city_ids[0] ?? null) !== this.city_id) this.onOnboardingCityChange();
  }

  toggleCity(cityId: number): void {
    this.city_ids = [Number(cityId)];
  }

  isCitySelected(cityId: number): boolean {
    if (!this.city_ids) return false;
    return this.city_ids.includes(Number(cityId));
  }

  get selectedCityNames(): string {
    if (!this.city_ids || !this.city_ids.length) return '';
    const names = this.cities
      .filter((c) => this.city_ids.includes(Number(c.id)))
      .map((c) => c.name);
    return names.join(', ');
  }

  get filteredCities(): CityOpt[] {
    const q = (this.citySearch || '').trim().toLowerCase();
    if (!q) return this.cities;
    return this.cities.filter((c) => c.name.toLowerCase().includes(q));
  }

  /** City chosen: reset dependent picks and load the city's ride products. */
  onOnboardingCityChange(): void {
    this.city_id = this.city_ids[0] ?? null;

    this.selectedRideKey = null;
    this.ride_type_id = null;
    this.service_scope = null;
    this.service_mode = null;
    this.vehicle_type_id = null;
    this.city_vehicle_type_id = null;
    this.cityVehicles = [];
    this.rideModes = [];
    this.loadRegistrationStands();
    if (!this.city_id) return;
    this.loadRegistrationRideModes(this.city_id);
  }

  private loadRegistrationRideModes(cityId: number): void {
    this.api.get<{ scopes: RideScopeOption[] }>(`/catalog/cities/${cityId}/driver-ride-products`).pipe(
      catchError(() => of({ scopes: [] as RideScopeOption[] })),
    ).subscribe({
      next: (res) => {
        if (this.city_id !== cityId) return;
        const modes: Array<RideModeOption & { key: string }> = [];
        for (const sc of res.scopes ?? []) {
          for (const m of sc.modes ?? []) {
            modes.push({ ...m, name: m.display_name || m.name, key: `${m.scope}:${m.mode}:${m.id}` });
          }
        }
        this.rideModes = modes;
        this.selectedRideKey = modes.find(mode => mode.id === this.ride_type_id && mode.mode === this.service_mode)?.key ?? null;
        this.syncServiceScopeFromSelection();
      },
    });
  }

  loadRegistrationStands(): void {
    this.standsRequest?.unsubscribe();
    this.registrationStands = [];
    this.selectedStandIds = [];
    this.standsLoading = false;
    this.standsLoadFailed = false;
    if (this.hasDriverProfile || !this.city_id) return;

    this.standsLoading = true;
    this.standsRequest = this.api.get<{ data: StandOpt[] }>(`/catalog/cities/${this.city_id}/registration-stands`).subscribe({
      next: ({ data }) => {
        this.registrationStands = data;
        this.standsLoading = false;
      },
      error: () => {
        this.standsLoadFailed = true;
        this.standsLoading = false;
      },
    });
  }

  toggleRegistrationStand(id: number): void {
    if (this.selectedStandIds.includes(id)) {
      this.selectedStandIds = this.selectedStandIds.filter(standId => standId !== id);
    } else if (this.selectedStandIds.length < 2) {
      this.selectedStandIds = [...this.selectedStandIds, id];
    }
  }

  toggleServiceScope(scope: 'local' | 'outstation'): void {
    if (this.selectedScopes.has(scope)) {
      if (this.selectedScopes.size > 1) {
        this.selectedScopes.delete(scope);
      }
    } else {
      this.selectedScopes.add(scope);
    }
    this.syncServiceScopeFromSelection();
  }

  isScopeSelected(scope: 'local' | 'outstation'): boolean {
    return this.selectedScopes.has(scope);
  }

  get filteredRideModes(): Array<RideModeOption & { key: string }> {
    return this.rideModes.filter((m) => m.scope === 'both' || this.selectedScopes.has(m.scope as 'local' | 'outstation'));
  }

  private syncServiceScopeFromSelection(): void {
    const hasLocal = this.selectedScopes.has('local');
    const hasOutstation = this.selectedScopes.has('outstation');
    if (hasLocal && hasOutstation) {
      this.service_scope = 'both';
    } else if (hasOutstation) {
      this.service_scope = 'outstation';
    } else {
      this.service_scope = 'local';
    }

    if (this.selectedRideKey) {
      const current = this.rideModes.find((x) => x.key === this.selectedRideKey);
      if (current && current.scope !== 'both' && !this.selectedScopes.has(current.scope as 'local' | 'outstation')) {
        const next = this.filteredRideModes[0];
        if (next) {
          this.selectRideMode(next);
        } else {
          this.selectedRideKey = null;
          this.ride_type_id = null;
          this.service_mode = null;
        }
      }
    } else if (this.filteredRideModes.length) {
      this.selectRideMode(this.filteredRideModes[0]);
    }
  }

  selectRideMode(m: RideModeOption & { key: string }): void {
    this.selectedRideKey = m.key;
    this.onRideModeChange();
  }

  selectVehicleType(vId: number): void {
    this.vehicle_type_id = vId;
    this.onOnboardingVehicleTypeChange();
  }

  selectCityVehicle(cvId: number): void {
    this.city_vehicle_type_id = cvId;
  }

  getServiceModeIcon(mode?: string | null): string {
    const m = (mode || '').toLowerCase();
    if (m === 'fixed') return 'bus-outline';
    if (m === 'shuttle') return 'git-network-outline';
    return 'car-sport-outline';
  }

  getVehicleTypeIconByName(name?: string | null): string {
    const n = (name || '').toLowerCase();
    if (n.includes('bike') || n.includes('moto') || n.includes('two')) return 'bicycle-outline';
    if (n.includes('auto') || n.includes('rickshaw')) return 'car-outline';
    if (n.includes('sedan')) return 'car-sport-outline';
    if (n.includes('suv') || n.includes('muv') || n.includes('innova')) return 'car-sport';
    if (n.includes('hatch')) return 'car-outline';
    return 'car-sport-outline';
  }

  /** Ride product chosen: derive ride_type_id + scope + mode from the pick. */
  onRideModeChange(): void {
    const m = this.rideModes.find((x) => x.key === this.selectedRideKey);
    this.ride_type_id = m ? m.id : null;
    this.service_mode = m ? m.mode : null;
    const hasLocal = this.selectedScopes.has('local');
    const hasOutstation = this.selectedScopes.has('outstation');
    if (hasLocal && hasOutstation) {
      this.service_scope = 'both';
    } else if (hasOutstation) {
      this.service_scope = 'outstation';
    } else {
      this.service_scope = 'local';
    }
  }

  /** Vehicle type chosen: reload the city's vehicles for that type. */
  onOnboardingVehicleTypeChange(): void {
    this.city_vehicle_type_id = null;
    this.cityVehicles = [];
    this.loadCityVehicles();
  }

  /** Final step — submit the whole registration (profile + vehicle) to the server. */
  async submitRegistration(): Promise<void> {
    await this.photoDraftReady;
    this.error = null;
    this.message = null;

    const chosenCityIds = this.city_ids && this.city_ids.length ? this.city_ids : (this.city_id ? [this.city_id] : []);
    if (!chosenCityIds.length) { this.error = 'Please select your operating city.'; return; }
    if (!this.hasDriverProfile && (chosenCityIds.length !== 1 || this.selectedStandIds.length !== 2)) {
      this.error = 'Select one operating city and exactly two stands.';
      return;
    }
    if (!this.ride_type_id || !this.service_scope || !this.service_mode) { this.error = 'Please select your service.'; return; }
    if (!this.vehicle_type_id) { this.error = 'Please select your vehicle type.'; return; }
    if (!this.city_vehicle_type_id) { this.error = 'Please select your vehicle.'; return; }
    const regNo = this.vehicle_reg_no.trim();
    if (!regNo) { this.error = 'Please enter your vehicle registration number.'; return; }
    const year = this.vehicle_model_year.trim();
    if (year && !/^\d{4}$/.test(year)) { this.error = 'Model year must be a 4-digit year.'; return; }

    const profile = this.draft.getProfile();
    const fd = new FormData();
    fd.append('name', (profile?.name || this.name).trim());
    const email = (profile?.email || this.email).trim();
    if (email) fd.append('email', email);
    const dob = profile?.dob || this.dob;
    if (dob) fd.append('dob', dob);
    const address = profile?.address || this.address;
    if (address) fd.append('address', address);

    fd.append('ride_type_id', String(this.ride_type_id));
    fd.append('vehicle_type_id', String(this.vehicle_type_id));
    fd.append('city_vehicle_type_id', String(this.city_vehicle_type_id));
    fd.append('city_id', String(chosenCityIds[0]));
    chosenCityIds.forEach((cid) => fd.append('city_ids[]', String(cid)));
    if (!this.hasDriverProfile) this.selectedStandIds.forEach(id => fd.append('stand_ids[]', String(id)));
    fd.append('service_scope', this.service_scope);
    fd.append('service_mode', this.service_mode);
    const vtName = this.selectedVehicleTypeOpt?.name;
    if (vtName) fd.append('vehicle_type', vtName);
    if (year) fd.append('vehicle_model', year);
    if (this.vehicle_color.trim()) fd.append('vehicle_color', this.vehicle_color.trim());
    fd.append('vehicle_reg_no', regNo);
    if (this.fleet_id) fd.append('fleet_id', String(this.fleet_id));

    const photo = this.photoFile;
    if (photo) fd.append('photo', photo);
    if (this.deviceInfo.app_version) fd.append('app_version', this.deviceInfo.app_version.slice(0, 32));
    if (this.deviceInfo.os_version) fd.append('os_version', this.deviceInfo.os_version.slice(0, 32));
    if (this.deviceInfo.device_type) fd.append('device_type', this.deviceInfo.device_type.slice(0, 64));

    this.submitting = true;
    this.api.postForm<{ driver: unknown; user: AuthUser }>('/drivers/register', fd).subscribe({
      next: async (res) => {
        this.hasDriverProfile = true;
        if (res.user) this.auth.updateUser(res.user);
        try { await this.draft.clear(this.auth.getUser()?.id ?? 0); }
        catch { this.error = 'Registration saved, but the local draft could not be cleared.'; }
        this.photoFile = null;
        this.submitting = false;
        this.message = 'Last step! Upload your documents to get on the road.';
        this.onboardingStep = 'documents';
        this.refreshDocuments();
      },
      error: (err) => {
        this.submitting = false;
        this.error = err?.error?.message || 'Could not submit your registration. Please check the details and try again.';
      },
    });
  }

  backToVehicleStep(): void {
    this.error = null;
    this.message = null;
    this.onboardingStep = 'vehicle';
  }

  finishOnboardingDocuments(): void {
    if (!this.requiredDocsSubmitted) {
      this.error = 'Please upload your required documents before continuing.';
      return;
    }
    ApprovedDriverGuard.setStatePending();
    this.router.navigateByUrl('/tabs/dashboard', { replaceUrl: true });
  }

  isDocRequired(doc: CatalogDoc): boolean {
    const req = (doc.required || '').toString().toLowerCase();
    return req.startsWith('mandatory') || req === 'required' || req === '1' || req === 'true';
  }

  getSlotOverallStatus(slot: DocUploadState): 'approved' | 'pending' | 'rejected' | 'missing' {
    const statuses = slot.uploads.map((u) => u.existing?.status);
    if (statuses.some((s) => s === 'rejected')) return 'rejected';
    if (slot.uploads.length > 0 && slot.uploads.every((u) => u.existing?.status === 'approved')) return 'approved';
    if (slot.uploads.some((u) => !!u.existing)) return 'pending';
    return 'missing';
  }

  get uploadedMandatoryCount(): number {
    const mandatory = this.docs.filter((s) => this.isDocRequired(s.doc));
    if (!mandatory.length) {
      return this.docs.filter((s) => s.uploads.some((u) => !!u.existing)).length;
    }
    return mandatory.filter((s) => s.uploads.every((u) => !!u.existing && u.existing.status !== 'rejected')).length;
  }

  get totalMandatoryCount(): number {
    const mandatory = this.docs.filter((s) => this.isDocRequired(s.doc));
    return mandatory.length || this.docs.length;
  }

  /**
   * True when:
   * 1. No documents are configured in the system (docs.length === 0), OR
   * 2. All configured documents are optional (no mandatory documents), OR
   * 3. All mandatory documents have their required image slots uploaded and not rejected.
   */
  get requiredDocsSubmitted(): boolean {
    if (!this.docs.length) return true; // nothing to upload
    const mandatory = this.docs.filter((s) => this.isDocRequired(s.doc));
    if (!mandatory.length) return true; // All documents are optional
    return mandatory.every((s) => s.uploads.every((u) => !!u.existing && u.existing.status !== 'rejected'));
  }

  /** A driver picked a file for one document image slot. */
  onDocFileSelected(slot: DocUploadState, image: DocImageSlot, ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = ''; // let the same file be re-picked after an error
    if (!file) return;
    this.uploadDocSlot(slot, image, file);
  }

  /** Upload (or re-upload) one document image to the server. */
  private uploadDocSlot(slot: DocUploadState, image: DocImageSlot, file: File): void {
    image.file = file;
    image.status = 'uploading';
    image.error = undefined;
    this.error = null;

    const fd = new FormData();
    fd.append('document_id', String(slot.doc.id));
    fd.append('image_index', String(image.index));
    fd.append('file', file);
    const labels = slot.labelValues || {};
    if (Object.keys(labels).length) fd.append('label_values', JSON.stringify(labels));
    if (this.vehicle_type_id) fd.append('vehicle_type_id', String(this.vehicle_type_id));

    this.api.postForm<{ document?: ExistingUpload }>('/drivers/documents', fd).subscribe({
      next: () => {
        image.status = 'done';
        image.file = null;
        this.refreshDocuments(); // reconcile: server now marks it uploaded/pending
      },
      error: (err) => {
        image.status = 'error';
        image.error = err?.error?.message || 'Upload failed. Please try again.';
      },
    });
  }

  // ── Document View & Download Logic ─────────────────────────

  refreshDocuments(): void {
    this.refreshDocumentStep(true);
  }

  private refreshDocumentStep(showErrors: boolean): void {
    if (this.documentsRefreshInFlight) return;
    this.documentsRefreshInFlight = true;

    forkJoin({
      docs: this.api.get<{ data: CatalogDoc[] }>('/catalog/documents').pipe(
        catchError((err) => {
          if (showErrors) this.error = err?.error?.message || 'Could not refresh required documents.';
          return of({ data: this.docs.map((slot) => slot.doc) });
        }),
      ),
      driver: this.api
        .get<{ driver: Record<string, unknown> | null; documents: ExistingUpload[] }>('/drivers/me')
        .pipe(catchError((err) => {
          if (showErrors) this.error = err?.error?.message || 'Could not refresh your verification status.';
          const fallbackDocs: ExistingUpload[] = [];
          for (const slot of this.docs) {
            for (const upload of slot.uploads) {
              if (upload.existing) fallbackDocs.push(upload.existing);
            }
          }
          return of({ driver: null, documents: fallbackDocs });
        })),
    }).subscribe({
      next: ({ docs, driver }) => {
        this.mergeDocumentStep(docs.data ?? [], driver.documents ?? []);
        this.applyDriverApprovalRefresh(driver.driver);
      },
      complete: () => { this.documentsRefreshInFlight = false; },
    });
  }

  private mergeDocumentStep(catalogDocs: CatalogDoc[], uploads: ExistingUpload[]): void {
    const previousByDocId = new Map<number, DocUploadState>();
    for (const slot of this.docs) previousByDocId.set(slot.doc.id, slot);

    const existingByDocId = new Map<number, ExistingUpload[]>();
    for (const upload of uploads) {
      if (upload.document_id == null) continue;
      const list = existingByDocId.get(upload.document_id) ?? [];
      list.push(upload);
      existingByDocId.set(upload.document_id, list);
    }
    existingByDocId.forEach((list) => {
      list.sort((a, b) => b.id - a.id);
    });

    this.docs = catalogDocs.map((doc) => {
      const previous = previousByDocId.get(doc.id);
      const existingList = [...(existingByDocId.get(doc.id) ?? [])];
      const slotCount = Math.max(1, doc.no_of_images || 1);
      const unmapped = existingList.filter(row => row.image_index == null || row.image_index > slotCount || row.image_index < 1);
      const uploadsState: DocImageSlot[] = Array.from({ length: slotCount }, (_, idx) => {
        const imageIndex = idx + 1;
        const exact = existingList.find((row) => row.image_index === imageIndex) ?? null;
        const fallback = !exact ? unmapped.shift() ?? null : null;
        return {
          index: imageIndex,
          file: previous?.uploads[idx]?.file ?? null,
          status: previous?.uploads[idx]?.status ?? 'idle',
          error: previous?.uploads[idx]?.error,
          existing: exact ?? fallback,
        };
      });

      return {
        doc,
        uploads: uploadsState,
        labelValues: this.mergeLabelValues(doc, { ...existingList[0]?.label_values, ...previous?.labelValues }),
      };
    });
  }

  private mergeLabelValues(doc: CatalogDoc, current: Record<string, string> | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const label of doc.labels) out[label.label] = current?.[label.label] ?? '';
    return out;
  }

  private applyDriverApprovalRefresh(driver: Record<string, unknown> | null): void {
    if (!driver) return;
    const status = driver?.['approval_status'] as string | null | undefined;
    if (status === 'approved') {
      this.driverApproved = true;
      ApprovedDriverGuard.setStateApproved();
      return;
    }
    this.driverApproved = false;
  }

  viewDoc(upload: DocImageSlot): void {
    this.fetchDoc(upload, false);
  }

  downloadDoc(upload: DocImageSlot): void {
    this.fetchDoc(upload, true);
  }

  private fetchDoc(upload: DocImageSlot, asDownload: boolean): void {
    if (!upload.existing?.file_url) return;
    let apiPath = this.toApiPath(upload.existing.file_url);
    if (!apiPath) return;
    if (asDownload) {
      apiPath += apiPath.includes('?') ? '&download=1' : '?download=1';
    }
    this.api.getBlob(apiPath).subscribe({
      next: (blob) => {
        const objectUrl = URL.createObjectURL(blob);
        if (asDownload) {
          const a = document.createElement('a');
          a.href = objectUrl;
          const safeName = `doc-${upload.existing!.id}-image-${upload.index}`.replace(/[^a-z0-9._-]+/gi, '_');
          a.download = safeName.includes('.')
            ? safeName
            : `${safeName}.${(blob.type || 'application/octet-stream').split('/')[1] || 'bin'}`;
          document.body.appendChild(a);
          a.click();
          a.remove();
        } else {
          window.open(objectUrl, '_blank');
        }
        setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      },
      error: (err) => {
        this.error = err?.status === 401 ? 'Session expired — sign in again.' : 'Could not load the file. Please try again.';
      },
    });
  }

  private toApiPath(absoluteUrl: string): string | null {
    try {
      const parsed = new URL(absoluteUrl);
      let p = parsed.pathname + parsed.search;
      if (p.startsWith('/api/')) p = p.slice(4);
      else if (p.startsWith('/api')) p = p.slice(4);
      return p || null;
    } catch {
      return null;
    }
  }
}

function parseOsVersion(ua: string | undefined | null): string | undefined {
  if (!ua) return undefined;
  const patterns: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
    [/Android\s([\d._]+)/i,           (m) => `Android ${m[1]}`],
    [/iPhone OS\s([\d_]+)/i,          (m) => `iOS ${m[1].replace(/_/g, '.')}`],
    [/CPU OS\s([\d_]+)\s+like Mac/i,  (m) => `iOS ${m[1].replace(/_/g, '.')}`],
    [/Mac OS X\s([\d._]+)/i,          (m) => `macOS ${m[1].replace(/_/g, '.')}`],
    [/Windows NT\s([\d.]+)/i,         (m) => `Windows NT ${m[1]}`],
    [/CrOS\s[^\s]+\s([\d.]+)/i,       (m) => `ChromeOS ${m[1]}`],
    [/Linux/i,                        () => 'Linux'],
  ];
  for (const [rx, fmt] of patterns) {
    const m = ua.match(rx);
    if (m) return fmt(m).slice(0, 32);
  }
  return 'Web';
}
import { driverProfileErrorMessage } from '../../core/profile-error.helper';
