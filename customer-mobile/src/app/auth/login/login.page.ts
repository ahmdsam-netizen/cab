import { CUSTOMER_MAP_STYLE } from '../../core/customer-map';
import { dateOfBirthError, latestAdultBirthDate } from '../../core/date-of-birth';
import { Component, ElementRef, HostListener, NgZone, OnDestroy, ViewChild } from '@angular/core';
import { Router } from '@angular/router';
import { ViewWillEnter, ViewDidEnter, ViewWillLeave, NavController } from '@ionic/angular';
import { FirebaseMessaging } from '@capacitor-firebase/messaging';
import { registerPlugin, Capacitor } from '@capacitor/core';
import { Device } from '@capacitor/device';
import { Camera } from '@capacitor/camera';
import { Contacts } from '@capacitor-community/contacts';
import { Geolocation } from '@capacitor/geolocation';
import { App as CapacitorApp } from '@capacitor/app';
import { ApiService } from '../../core/api.service';
import { AuthService, AuthUser } from '../../core/auth.service';
import { GeolocationService } from '../../core/geolocation.service';
import { PlacesService, PlaceSuggestion } from '../../core/places.service';
import { PushService } from '../../core/push.service';
import {
  mapFirebaseAuthError,
  normalizeFirebaseIdToken,
  PhoneAuthService,
} from '../../core/phone-auth.service';
import { normalizePhoneToE164 } from '../../core/phone-normalize';
import { environment } from '../../../environments/environment';

export interface SmsConsentPlugin {
  startListening(): Promise<{ started: boolean; code?: string }>;
  stopListening(): Promise<void>;
  addListener(
    eventName: 'onSmsReceived',
    listenerFunc: (data: { code: string; message: string }) => void,
  ): Promise<any>;
  removeAllListeners(): Promise<void>;
}

const SmsConsent = registerPlugin<SmsConsentPlugin>('SmsConsent');

declare const google: any;

type AuthExchangeResponse = {
  token: string;
  user: AuthUser;
};

/**
 * Flow:
 *   method  → user taps "Login with phone"
 *   phone   → enter mobile number
 *   perms   → disclosure ("we use phone/SMS/contacts/device id/files") — Allow grants all
 *   otp     → enter SMS code
 *   info    → first-time signup completes name + email + photo
 */
type Step = 'phone' | 'perms' | 'otp' | 'info' | 'success';

const RESEND_SECONDS = 60;

@Component({
  selector: 'app-login',
  templateUrl: './login.page.html',
  styleUrls: ['./login.page.scss'],
  standalone: false,
})
export class LoginPage implements ViewWillEnter, ViewDidEnter, ViewWillLeave, OnDestroy {
  @ViewChild('addressFieldWrap') addressFieldWrap?: ElementRef<HTMLElement>;
  @ViewChild('addressMapEl') addressMapEl?: ElementRef<HTMLElement>;
  @ViewChild('otpInput') otpInputEl?: ElementRef<HTMLInputElement>;
  step: Step = 'phone';
  phone = '';
  otp = '';
  otpLength = 6; // Dynamic OTP length matching backend/Firebase configuration
  otpInputFocused = false;
  phoneInputFocused = false;
  private otpAbortController?: AbortController;

  countries: Array<{ name: string; code: string; flag: string; iso: string }> = [
    { name: 'Algeria',        code: '213', flag: '🇩🇿', iso: 'DZ' },
    { name: 'Argentina',      code: '54',  flag: '🇦🇷', iso: 'AR' },
    { name: 'Australia',      code: '61',  flag: '🇦🇺', iso: 'AU' },
    { name: 'Austria',        code: '43',  flag: '🇦🇹', iso: 'AT' },
    { name: 'Bahrain',        code: '973', flag: '🇧🇭', iso: 'BH' },
    { name: 'Bangladesh',     code: '880', flag: '🇧🇩', iso: 'BD' },
    { name: 'Belgium',        code: '32',  flag: '🇧🇪', iso: 'BE' },
    { name: 'Brazil',         code: '55',  flag: '🇧🇷', iso: 'BR' },
    { name: 'Canada',         code: '1',   flag: '🇨🇦', iso: 'CA' },
    { name: 'Chile',          code: '56',  flag: '🇨🇱', iso: 'CL' },
    { name: 'China',          code: '86',  flag: '🇨🇳', iso: 'CN' },
    { name: 'Colombia',       code: '57',  flag: '🇨🇴', iso: 'CO' },
    { name: 'Denmark',        code: '45',  flag: '🇩🇰', iso: 'DK' },
    { name: 'Egypt',          code: '20',  flag: '🇪🇬', iso: 'EG' },
    { name: 'Finland',        code: '358', flag: '🇫🇮', iso: 'FI' },
    { name: 'France',         code: '33',  flag: '🇫🇷', iso: 'FR' },
    { name: 'Germany',        code: '49',  flag: '🇩🇪', iso: 'DE' },
    { name: 'Greece',         code: '30',  flag: '🇬🇷', iso: 'GR' },
    { name: 'Hong Kong',      code: '852', flag: '🇭🇰', iso: 'HK' },
    { name: 'Hungary',        code: '36',  flag: '🇭🇺', iso: 'HU' },
    { name: 'India',          code: '91',  flag: '🇮🇳', iso: 'IN' },
    { name: 'Indonesia',      code: '62',  flag: '🇮🇩', iso: 'ID' },
    { name: 'Iran',           code: '98',  flag: '🇮🇷', iso: 'IR' },
    { name: 'Iraq',           code: '964', flag: '🇮🇶', iso: 'IQ' },
    { name: 'Ireland',        code: '353', flag: '🇮🇪', iso: 'IE' },
    { name: 'Israel',         code: '972', flag: '🇮🇱', iso: 'IL' },
    { name: 'Italy',          code: '39',  flag: '🇮🇹', iso: 'IT' },
    { name: 'Japan',          code: '81',  flag: '🇯🇵', iso: 'JP' },
    { name: 'Jordan',         code: '962', flag: '🇯🇴', iso: 'JO' },
    { name: 'Kenya',          code: '254', flag: '🇰🇪', iso: 'KE' },
    { name: 'Kuwait',         code: '965', flag: '🇰🇼', iso: 'KW' },
    { name: 'Malaysia',       code: '60',  flag: '🇲🇾', iso: 'MY' },
    { name: 'Mexico',         code: '52',  flag: '🇲🇽', iso: 'MX' },
    { name: 'Morocco',        code: '212', flag: '🇲🇦', iso: 'MA' },
    { name: 'Nepal',          code: '977', flag: '🇳🇵', iso: 'NP' },
    { name: 'Netherlands',    code: '31',  flag: '🇳🇱', iso: 'NL' },
    { name: 'New Zealand',    code: '64',  flag: '🇳🇿', iso: 'NZ' },
    { name: 'Nigeria',        code: '234', flag: '🇳🇬', iso: 'NG' },
    { name: 'Norway',         code: '47',  flag: '🇳🇴', iso: 'NO' },
    { name: 'Oman',           code: '968', flag: '🇴🇲', iso: 'OM' },
    { name: 'Pakistan',       code: '92',  flag: '🇵🇰', iso: 'PK' },
    { name: 'Peru',           code: '51',  flag: '🇵🇪', iso: 'PE' },
    { name: 'Philippines',    code: '63',  flag: '🇵🇭', iso: 'PH' },
    { name: 'Poland',         code: '48',  flag: '🇵🇱', iso: 'PL' },
    { name: 'Portugal',       code: '351', flag: '🇵🇹', iso: 'PT' },
    { name: 'Qatar',          code: '974', flag: '🇶🇦', iso: 'QA' },
    { name: 'Romania',        code: '40',  flag: '🇷🇴', iso: 'RO' },
    { name: 'Russia',         code: '7',   flag: '🇷🇺', iso: 'RU' },
    { name: 'Saudi Arabia',   code: '966', flag: '🇸🇦', iso: 'SA' },
    { name: 'Singapore',      code: '65',  flag: '🇸🇬', iso: 'SG' },
    { name: 'South Africa',   code: '27',  flag: '🇿🇦', iso: 'ZA' },
    { name: 'South Korea',    code: '82',  flag: '🇰🇷', iso: 'KR' },
    { name: 'Spain',          code: '34',  flag: '🇪🇸', iso: 'ES' },
    { name: 'Sri Lanka',      code: '94',  flag: '🇱🇰', iso: 'LK' },
    { name: 'Sweden',         code: '46',  flag: '🇸🇪', iso: 'SE' },
    { name: 'Switzerland',    code: '41',  flag: '🇨🇭', iso: 'CH' },
    { name: 'Taiwan',         code: '886', flag: '🇹🇼', iso: 'TW' },
    { name: 'Thailand',       code: '66',  flag: '🇹🇭', iso: 'TH' },
    { name: 'Turkey',         code: '90',  flag: '🇹🇷', iso: 'TR' },
    { name: 'UAE',            code: '971', flag: '🇦🇪', iso: 'AE' },
    { name: 'Ukraine',        code: '380', flag: '🇺🇦', iso: 'UA' },
    { name: 'United Kingdom', code: '44',  flag: '🇬🇧', iso: 'GB' },
    { name: 'United States',  code: '1',   flag: '🇺🇸', iso: 'US' },
    { name: 'Vietnam',        code: '84',  flag: '🇻🇳', iso: 'VN' },
  ];
  country = this.countries.find(c => c.iso === 'IN') || this.countries[0]; // Default to India
  showCountryPicker = false;

  infoName = '';
  infoEmail = '';
  infoDob = '';
  /** Final picked address (the Place's formatted_address). */
  infoAddress = '';
  infoPhotoFile: File | null = null;
  infoPhotoPreview: string | null = null;

  // Address autocomplete + map picker (Google Places / Maps)
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
  /** Skip the next query-change emit after we set query from a pick(). */
  private addressSkipNextQueryEmit = false;
  private addressDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Captured once after permissions/OTP so they're ready before submitInfo runs.
  // Sent silently with the profile payload so the admin Customer module shows
  // device + app metadata without asking the user.
  private deviceInfo: { app_version?: string; os_version?: string; device_type?: string; device_id?: string } = {};

  get maxDob(): string { return latestAdultBirthDate(); }
  dobError: string | null = null;
  validateDob(): void { this.dobError = dateOfBirthError(this.infoDob); }

  resendSecondsLeft = 0;
  private resendInterval: ReturnType<typeof setInterval> | null = null;

  loading = false;
  error: string | null = null;

  constructor(
    private api: ApiService,
    private auth: AuthService,
    private router: Router,
    private navCtrl: NavController,
    private phoneAuth: PhoneAuthService,
    private push: PushService,
    private places: PlacesService,
    private geo: GeolocationService,
    private zone: NgZone,
  ) {}

  ionViewWillEnter(): void {
    if (this.auth.isLoggedIn()) {
      void this.navCtrl.navigateRoot(this.homeRouteForCurrentUser(), { animationDirection: 'forward' });
    }
  }

  ionViewDidEnter(): void {
    // Firebase reCAPTCHA is only needed for the Firebase OTP path.
    if (!this.useServerOtp && this.phoneAuth.isConfigured()) {
      this.installRecaptchaSoon();
    }
    void this.captureDeviceInfo();
  }

  /** When true, login uses the server-side MSG91 OTP instead of Firebase. */
  get useServerOtp(): boolean {
    return (environment as { useServerOtp?: boolean }).useServerOtp === true;
  }

  /**
   * Reads platform + app version + UA string once on page entry and stashes
   * them on `this.deviceInfo`. We don't `await` this from anywhere — by the
   * time the user reaches the `info` step it's already populated, and worst
   * case the fields are absent on the request (backend treats them nullable).
   */
  private async captureDeviceInfo(): Promise<void> {
    // Prefer the real device name (manufacturer + model) and OS version from
    // the Device plugin; fall back to the platform / user-agent on web.
    try {
      const d = await Device.getInfo();
      const name = [d.manufacturer, d.model]
        .map((s) => (s || '').trim())
        .filter(Boolean)
        .join(' ')
        .trim();
      if (name) this.deviceInfo.device_type = name.slice(0, 64);

      const osName =
        d.operatingSystem === 'ios'
          ? 'iOS'
          : d.operatingSystem
            ? d.operatingSystem.charAt(0).toUpperCase() + d.operatingSystem.slice(1)
            : '';
      const os = [osName, d.osVersion].filter(Boolean).join(' ').trim();
      if (os) this.deviceInfo.os_version = os.slice(0, 32);
    } catch { /* ignore — fall back below */ }
    try {
      if (!this.deviceInfo.device_type) this.deviceInfo.device_type = Capacitor.getPlatform();
    } catch { /* ignore */ }
    try {
      if (!this.deviceInfo.os_version && typeof navigator !== 'undefined') {
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

  /**
   * Called by the address `<ion-input>` on every keystroke. Debounces a
   * Places autocomplete fetch and updates the suggestions list. Typing after
   * a pick clears the locked address so the user can re-search.
   */
  onAddressQueryChange(value: string | null | undefined): void {
    const q = (value ?? '').toString();
    this.addressQuery = q;
    if (this.addressSkipNextQueryEmit) {
      this.addressSkipNextQueryEmit = false;
      return;
    }
    // Typing again invalidates the prior pick — the address isn't "locked" anymore.
    if (this.infoAddress && q !== this.infoAddress) {
      this.infoAddress = '';
    }
    if (this.addressDebounceTimer) clearTimeout(this.addressDebounceTimer);
    if (!q.trim()) {
      this.addressSuggestions = [];
      return;
    }
    this.scrollAddressFieldIntoView();
    this.addressDebounceTimer = setTimeout(() => {
      this.fetchAddressSuggestions(q);
    }, 220);
  }

  private async fetchAddressSuggestions(q: string): Promise<void> {
    this.addressLoading = true;
    try {
      this.addressSuggestions = await this.places.autocompleteSearch(q);
    } catch {
      this.addressSuggestions = [];
    } finally {
      this.addressLoading = false;
    }
  }

  scrollAddressFieldIntoView(): void {
    setTimeout(() => {
      this.addressFieldWrap?.nativeElement.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 120);
  }

  async pickAddress(s: PlaceSuggestion): Promise<void> {
    this.addressLoading = true;
    try {
      const detail = await this.places.getPlaceDetail(s.place_id);
      const formatted = detail?.description || s.description;
      this.infoAddress = formatted;
      this.addressQuery = formatted;
      this.addressSkipNextQueryEmit = true;
      this.addressSuggestions = [];
    } finally {
      this.addressLoading = false;
    }
  }

  openAddressMap(): void {
    if (this.loading) return;
    this.mapPickerOpen = true;
    this.mapError = null;
    this.mapSelectedAddress = this.infoAddress || this.addressQuery || '';
    this.mapSelectedPosition = null;
    setTimeout(() => void this.initAddressMap(), 120);
  }

  closeAddressMap(): void {
    this.mapPickerOpen = false;
  }

  confirmMapAddress(): void {
    let picked = this.mapSelectedAddress.trim();
    if (!picked && this.mapSelectedPosition) {
      picked = `${this.mapSelectedPosition.lat.toFixed(6)}, ${this.mapSelectedPosition.lng.toFixed(6)}`;
    }
    if (!picked) {
      this.mapError = 'Tap a place on the map first.';
      return;
    }
    this.infoAddress = picked;
    this.addressQuery = picked;
    this.addressSkipNextQueryEmit = true;
    this.addressSuggestions = [];
    this.mapPickerOpen = false;
  }

  private async initAddressMap(): Promise<void> {
    const el = this.addressMapEl?.nativeElement;
    if (!el) return;
    this.mapLoading = true;
    this.mapError = null;
    try {
      await this.places.ensureLoaded();
      const center = await this.initialMapCenter();
      this.addressMap = new google.maps.Map(el, {
        ...CUSTOMER_MAP_STYLE,
        center,
        zoom: 15,
        disableDefaultUI: true,
        zoomControl: true,
        gestureHandling: 'greedy',
      });
      if (this.addressMapClickListener?.remove) this.addressMapClickListener.remove();
      this.addressMapClickListener = this.addressMap.addListener('click', (ev: any) => {
        const latLng = ev?.latLng;
        if (!latLng) return;
        void this.pickAddressFromMap({ lat: latLng.lat(), lng: latLng.lng() });
      });
      await this.pickAddressFromMap(center);
    } catch {
      this.mapError = 'Could not load the map. Type and pick your address instead.';
    } finally {
      this.mapLoading = false;
    }
  }

  private async initialMapCenter(): Promise<{ lat: number; lng: number }> {
    const current = await this.geo.getCurrentPosition();
    if (current) return current;

    const typed = (this.infoAddress || this.addressQuery).trim();
    if (typed) {
      const geocoded = await this.geocodeAddress(typed);
      if (geocoded) return geocoded;
    }
    return { lat: 20.5937, lng: 78.9629 };
  }

  private geocodeAddress(address: string): Promise<{ lat: number; lng: number } | null> {
    return new Promise((resolve) => {
      const geocoder = new google.maps.Geocoder();
      geocoder.geocode({ address }, (results: any[], status: string) => {
        const loc = status === 'OK' ? results?.[0]?.geometry?.location : null;
        resolve(loc ? { lat: loc.lat(), lng: loc.lng() } : null);
      });
    });
  }

  private async pickAddressFromMap(position: { lat: number; lng: number }): Promise<void> {
    this.mapLoading = true;
    this.mapError = null;
    this.mapSelectedPosition = position;
    this.mapSelectedAddress = `${position.lat.toFixed(6)}, ${position.lng.toFixed(6)}`;
    this.setAddressMapMarker(position);
    try {
      const label = await this.places.reverseGeocode(position.lat, position.lng);
      if (label) this.mapSelectedAddress = label;
    } catch {
      /* coordinates remain selected */
    } finally {
      this.mapLoading = false;
    }
  }

  private setAddressMapMarker(position: { lat: number; lng: number }): void {
    if (!this.addressMap) return;
    if (!this.addressMapMarker) {
      this.addressMapMarker = new google.maps.Marker({
        map: this.addressMap,
        position,
        draggable: false,
      });
    } else {
      this.addressMapMarker.setPosition(position);
    }
    this.addressMap.panTo(position);
  }

  ionViewWillLeave(): void {
    this.phoneAuth.teardownRecaptcha();
    this.stopResendTimer();
  }

  ngOnDestroy(): void {
    this.stopResendTimer();
    if (this.addressDebounceTimer) clearTimeout(this.addressDebounceTimer);
    if (this.addressMapClickListener?.remove) this.addressMapClickListener.remove();
  }

  private installRecaptchaSoon(): void {
    queueMicrotask(() => {
      try {
        this.phoneAuth.setupInvisibleRecaptcha('recaptcha-container');
      } catch (e) {
        this.error = (e as Error).message;
      }
    });
  }

  get firebaseReady(): boolean {
    // Server OTP doesn't need Firebase, so the phone step is always "ready" then.
    return this.useServerOtp || this.phoneAuth.isConfigured();
  }

  get firebaseSetup(): ReturnType<PhoneAuthService['firebaseSetupStatus']> {
    return this.phoneAuth.firebaseSetupStatus();
  }

  get otpReady(): boolean {
    return this.otp.trim().length >= this.otpLength;
  }

  get otpCells(): number[] {
    return Array.from({ length: this.otpLength }, (_, i) => i);
  }

  get resendDisplay(): string {
    const s = this.resendSecondsLeft;
    return `Resend code 00:${s.toString().padStart(2, '0')}`;
  }

  isButtonDisabled(): boolean {
    if (this.step === 'phone') {
      return !this.firebaseReady || !this.phone || this.phone.trim().length !== 10;
    }
    if (this.step === 'perms') {
      return false;
    }
    if (this.step === 'otp') {
      return !this.otpReady;
    }
    if (this.step === 'info') {
      return (
        !this.infoName.trim() ||
        !this.infoDob
      );
    }
    if (this.step === 'success') {
      return false;
    }
    return true;
  }

  handlePrimaryAction(): void {
    if (this.step === 'phone') {
      this.proceedToPerms();
    } else if (this.step === 'perms') {
      void this.allowPermsAndSendOtp();
    } else if (this.step === 'otp') {
      void this.verifyOtp();
    } else if (this.step === 'info') {
      void this.submitInfo();
    } else if (this.step === 'success') {
      void this.navCtrl.navigateRoot(this.homeRouteForCurrentUser(), { animationDirection: 'forward' });
    }
  }

  // ── Step transitions ─────────────────────────────────────────────

  goBack(): void {
    if (this.step === 'perms') {
      this.denyPerms();
    } else if (this.step === 'otp') {
      this.backToPhone();
    } else if (this.step === 'info') {
      this.backToPhone();
    }
  }

  openTerms(event?: Event): void {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    void this.navCtrl.navigateForward('/terms');
  }

  openPrivacy(event?: Event): void {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    void this.navCtrl.navigateForward('/privacy');
  }

  backToPhone(): void {
    this.step = 'phone';
    this.otp = '';
    this.error = null;
    this.stopResendTimer();
    this.phoneAuth.resetOtpOnly();
    this.resetRecaptcha();
  }

  pickCountry(c: { name: string; code: string; flag: string; iso: string }): void {
    this.country = c;
    this.showCountryPicker = false;
  }

  // Step 1 → 2: validate phone, then show permissions disclosure.
  proceedToPerms(): void {
    this.error = null;
    if (!this.phone || this.phone.trim().length !== 10) {
      this.error = 'Enter a valid 10-digit mobile number.';
      return;
    }
    const normalized = normalizePhoneToE164(this.phone, this.country.code);
    if (!normalized) {
      this.error = 'Enter a valid mobile number for the selected country.';
      return;
    }
    if (!this.assertFirebaseReady()) {
      return;
    }
    void this.allowPermsAndSendOtp();
  }

  // Permissions step: Deny sends the user back to phone entry.
  denyPerms(): void {
    void this.allowPermsAndSendOtp();
  }

  // Permissions step: Allow grants what we can request, then sends the OTP.
  // Each request is isolated so one denial/failure never blocks the rest or the OTP.
  async allowPermsAndSendOtp(): Promise<void> {
    this.error = null;
    this.loading = true;
    try {
      await this.sendOtp();
    } finally {
      this.loading = false;
    }
  }

  // Sequentially prompts for every permission surfaced on the disclosure cards.
  // Native-only plugins are wrapped so they silently no-op on the web build, and
  // each request is isolated so one denial never blocks the next or the OTP.
  private async sendOtp(): Promise<void> {
    const normalized = normalizePhoneToE164(this.phone, this.country.code);
    if (!normalized) return;
    if (this.useServerOtp) {
      await this.sendServerOtp(normalized);
      return;
    }
    try {
      this.phoneAuth.setupInvisibleRecaptcha('recaptcha-container');
      await this.phoneAuth.sendOtp(normalized);
      this.step = 'otp';
      this.startResendTimer();
      this.focusOtpInput();
      this.listenForWebOtp();
      this.listenForSmsConsent();
    } catch (e) {
      this.error = mapFirebaseAuthError(e);
      this.step = 'phone';
      this.resetRecaptchaQuiet();
    }
  }

  /** Request a login code from the SMS gateway. */
  private async sendServerOtp(normalized: string): Promise<void> {
    try {
      await this.api
        .post<{ ok: boolean; resend_in?: number }>('/auth/otp/sms/start', {
          phone: normalized,
          platform: Capacitor.getPlatform() === 'ios' ? 'ios' : 'android',
        })
        .toPromise();
      this.step = 'otp';
      this.startResendTimer();
      this.focusOtpInput();
      this.listenForWebOtp();
      this.listenForSmsConsent();
    } catch (e: unknown) {
      this.error = (e as { error?: { message?: string } })?.error?.message || 'Could not send the code. Try again.';
      this.step = 'phone';
    }
  }

  @HostListener('document:visibilitychange')
  onVisibilityChange(): void {
    if (document.visibilityState === 'visible' && this.step === 'otp') {
      void this.checkClipboardForOtp();
      this.focusOtpInput();
    }
  }

  onOtpInput(event: any): void {
    const val = event?.target?.value || '';
    this.onOtpChange(val);
  }

  onOtpPaste(event: ClipboardEvent): void {
    const pasted = event.clipboardData?.getData('text') || '';
    if (pasted) {
      event.preventDefault();
      this.onOtpChange(pasted);
    }
  }

  onOtpChange(val?: string): void {
    const clean = (val || '').replace(/\D/g, '').slice(0, this.otpLength);
    this.otp = clean;
    if (this.otp.length === this.otpLength && !this.loading) {
      setTimeout(() => {
        if (this.otp.length === this.otpLength && !this.loading) {
          void this.verifyOtp();
        }
      }, 150);
    }
  }

  focusOtpInput(): void {
    if (this.otpInputEl?.nativeElement) {
      this.otpInputEl.nativeElement.focus();
    }
    setTimeout(() => {
      this.otpInputEl?.nativeElement?.focus();
    }, 150);
  }

  async checkClipboardForOtp(): Promise<void> {
    if (this.step !== 'otp' || this.otp.length === this.otpLength || this.loading) return;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        const match = text.match(/\b\d{6}\b/);
        if (match && match[0]) {
          this.onOtpChange(match[0]);
        }
      }
    } catch {
      // Ignored: clipboard permission not active
    }
  }

  private listenForWebOtp(): void {
    if (typeof window !== 'undefined' && 'credentials' in navigator && (navigator.credentials as any)?.get) {
      try {
        this.otpAbortController?.abort();
        const ac = new AbortController();
        this.otpAbortController = ac;
        (navigator.credentials as any)
          .get({
            otp: { transport: ['sms'] },
            signal: ac.signal,
          })
          .then((otpCredential: any) => {
            if (otpCredential?.code) {
              this.onOtpChange(otpCredential.code);
            }
          })
          .catch(() => {
            // Ignored: aborted or unsupported
          });
      } catch {
        // Ignored
      }
    }
  }

  private listenForSmsConsent(): void {
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
      try {
        void SmsConsent.removeAllListeners();
        void SmsConsent.addListener('onSmsReceived', (data: { code?: string; message?: string }) => {
          const code = data?.code;
          if (code) {
            this.zone.run(() => {
              this.onOtpChange(code);
            });
          }
        });
        void SmsConsent.startListening().then((res: { started?: boolean; code?: string }) => {
          const code = res?.code;
          if (code) {
            this.zone.run(() => {
              this.onOtpChange(code);
            });
          }
        }).catch(() => {});
      } catch (err) {
        console.warn('[SmsConsent] error', err);
      }
    }
  }

  async resendOtp(): Promise<void> {
    if (this.resendSecondsLeft > 0 || this.loading) return;
    this.loading = true;
    try {
      await this.sendOtp();
    } finally {
      this.loading = false;
    }
  }

  async verifyOtp(): Promise<void> {
    this.error = null;
    if (!this.otpReady) {
      this.error = 'Enter the code from your SMS.';
      return;
    }
    this.loading = true;
    try {
      const user = this.useServerOtp
        ? await this.verifyServerOtp()
        : await this.exchangeOtpToken(await this.phoneAuth.confirmOtp(this.otp.trim()));
      if (this.userNeedsProfile(user)) {
        this.infoName = user.name && user.name !== 'User' ? user.name : '';
        this.infoEmail = this.isSyntheticEmail(user.email) ? '' : user.email ?? '';
        this.infoDob = user.dob ?? '';
        this.dobError = this.infoDob ? dateOfBirthError(this.infoDob) : null;
        this.step = 'info';
        this.stopResendTimer();
        // Warm the Places API loader in the background — by the time the user
        // taps the address field, the SDK is usually already in memory.
        void this.places.ensureLoaded().catch(() => {});
      } else {
        void this.navCtrl.navigateRoot(this.homeRouteForCurrentUser(), { animationDirection: 'forward' });
      }
    } catch (e) {
      this.error = mapFirebaseAuthError(e) || 'Invalid code. Try again or request a new OTP.';
    } finally {
      this.loading = false;
    }
  }

  // ── Profile completion (first-time signup) ───────────────────────

  onPhotoSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    if (!file) return;
    this.infoPhotoFile = file;
    const reader = new FileReader();
    reader.onload = () => {
      this.infoPhotoPreview = reader.result as string;
    };
    reader.readAsDataURL(file);
  }

  async submitInfo(): Promise<void> {
    this.error = null;
    const name = this.infoName.trim();
    const email = this.infoEmail.trim();
    if (!name) {
      this.error = 'Please enter your name.';
      return;
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      this.error = 'Please enter a valid email address.';
      return;
    }
    this.validateDob();
    if (this.dobError) { this.error = this.dobError; return; }


    const fd = new FormData();
    fd.append('name', name);
    if (email) fd.append('email', email);
    // Only append non-empty values — Laravel's ConvertEmptyStringsToNull turns
    // '' into null which `nullable` skips, but belt-and-braces (and avoids
    // accidentally tripping `before:today` on a malformed string).
    if (this.infoDob) fd.append('dob', this.infoDob);
    if (this.infoAddress) fd.append('address', this.infoAddress);
    if (this.deviceInfo.app_version) fd.append('app_version', this.deviceInfo.app_version.slice(0, 32));
    if (this.deviceInfo.os_version) fd.append('os_version', this.deviceInfo.os_version.slice(0, 32));
    if (this.deviceInfo.device_type) fd.append('device_type', this.deviceInfo.device_type.slice(0, 64));
    if (this.infoPhotoFile) {
      fd.append('photo', this.infoPhotoFile);
    }

    this.loading = true;
    try {
      await new Promise<void>((resolve, reject) => {
        this.api.postForm<{ user: AuthUser }>('/me/profile', fd).subscribe({
          next: (res) => {
            this.auth.updateUser(res.user);
            resolve();
          },
          error: (err) => reject(new Error(err?.error?.errors?.dob?.[0] || err?.error?.message || 'Could not save profile.')),
        });
      });
      this.step = 'success';
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.loading = false;
    }
  }

  // ── Backend exchange ─────────────────────────────────────────────

  private exchangeOtpToken(idToken: string): Promise<AuthUser> {
    const idTokenClean = normalizeFirebaseIdToken(idToken);
    return new Promise((resolve, reject) => {
      this.api
        .post<AuthExchangeResponse>('/auth/otp/verify', {
          idToken: idTokenClean,
          intent: 'customer',
        })
        .subscribe({
          next: (res) => {
            this.auth.setSession(res.token, res.user);
            void this.push.reportDeviceInfo();
            void this.push.registerForUser();
            resolve(res.user);
          },
          error: (err) => reject(new Error(err?.error?.message || 'Sign-in failed')),
        });
    });
  }

  /** Verify the OTP server-side (MSG91 path) and start the session. */
  private verifyServerOtp(): Promise<AuthUser> {
    const normalized = normalizePhoneToE164(this.phone, this.country.code);
    return new Promise((resolve, reject) => {
      this.api
        .post<AuthExchangeResponse>('/auth/otp/sms/verify', {
          phone: normalized,
          code: this.otp.trim(),
          intent: 'customer',
        })
        .subscribe({
          next: (res) => {
            this.auth.setSession(res.token, res.user);
            void this.push.reportDeviceInfo();
            void this.push.registerForUser();
            resolve(res.user);
          },
          error: (err) => reject(new Error(err?.error?.message || 'Sign-in failed')),
        });
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private homeRouteForCurrentUser(): string {
    return this.homeRouteForUser(this.auth.getUser());
  }

  private homeRouteForUser(_user: AuthUser | null | undefined): string {
    return '/customer-tabs/go';
  }

  private isSyntheticEmail(email?: string | null): boolean {
    return !email || email.endsWith('@otp.local');
  }

  private userNeedsProfile(user: AuthUser): boolean {
    return !user.name || user.name === 'User' || dateOfBirthError(user.dob ?? '') !== null;
  }

  private assertFirebaseReady(): boolean {
    if (this.phoneAuth.isConfigured()) return true;
    if (this.phoneAuth.firebaseSetupStatus() === 'not-web-app') {
      this.error = 'Your Firebase appId is not a Web app (it must contain :web:). Use Developer sign-in.';
    } else {
      this.error = 'Firebase Web config is incomplete in environment.ts. Use Developer sign-in.';
    }
    return false;
  }

  private startResendTimer(): void {
    this.stopResendTimer();
    this.resendSecondsLeft = RESEND_SECONDS;
    this.resendInterval = setInterval(() => {
      this.resendSecondsLeft--;
      if (this.resendSecondsLeft <= 0) {
        this.stopResendTimer();
      }
    }, 1000);
  }

  private stopResendTimer(): void {
    if (this.resendInterval) {
      clearInterval(this.resendInterval);
      this.resendInterval = null;
    }
  }

  private resetRecaptcha(): void {
    this.phoneAuth.teardownRecaptcha();
    queueMicrotask(() => {
      try {
        if (this.phoneAuth.isConfigured()) {
          this.phoneAuth.setupInvisibleRecaptcha('recaptcha-container');
        }
      } catch { /* ignore */ }
    });
  }

  private resetRecaptchaQuiet(): void {
    this.phoneAuth.teardownRecaptcha();
    queueMicrotask(() => {
      try {
        this.phoneAuth.setupInvisibleRecaptcha('recaptcha-container');
      } catch { /* ignore */ }
    });
  }

}

// Extract a short OS label ("Android 7.0", "iOS 17.4", "Windows 10", …) from a
// User-Agent string so we stay well under the users.os_version varchar(32).
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
