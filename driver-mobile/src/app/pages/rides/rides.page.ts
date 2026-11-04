import { Component, OnDestroy, OnInit } from '@angular/core';
import { AlertController, ModalController, ToastController } from '@ionic/angular';
import { Router } from '@angular/router';
import { firstValueFrom, interval, Subscription } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService, PaymentMethod } from '../../core/auth.service';
import { BackgroundLocationService } from '../../core/background-location.service';
import { GeoFix, GeolocationService } from '../../core/geolocation.service';
import { MapsLoaderService } from '../../core/maps-loader.service';
import { RealtimeService, TripCustomerLocationPayload } from '../../core/realtime.service';
import { TripSummaryModal } from './trip-summary.modal';
import { StartOtpModal } from './start-otp.modal';
import {
  coordsFromTrip,
  googleMapsDirectionsUrl,
  openExternalUrl,
} from '../../core/maps-navigation';
import {
  buildReusableCarMarkerElement,
  updateCarMarkerBearing,
  updateCarMarkerImage,
  buildPassengerMarkerElement,
} from '../../core/car-marker.helper';
import { AudioRingtoneService } from '../../core/audio-ringtone.service';
import { NavigationRouteRenderer } from '../../core/navigation-route.helper';

declare const google: any;

type AvailableTrip = {
  id: number;
  // True when the customer chose this driver specifically via /select-driver.
  // The Rides UI surfaces these requests with a "Requested for you" badge.
  is_selected_for_me?: boolean;
  pickup_address?: string | null;
  pickup_lat: number;
  pickup_lng: number;
  drop_address?: string | null;
  drop_lat: number;
  drop_lng: number;
  estimated_fare?: number | null;
  customer_offer?: number | null;
  payment_method?: PaymentMethod | null;
  service_mode?: 'private' | 'shuttle' | string | null;
  ride_type_name?: string | null;
  vehicle_name?: string | null;
  created_at?: string;
  // "Booked for a friend / family" — who the driver will actually pick up.
  is_for_other?: boolean;
  booked_for_name?: string | null;
  // Per-vehicle reverse-bidding flag. When false the driver may only accept or
  // reject — countering ("Send ₹N") is disabled. Defaults to true when absent.
  reverse_bidding_enabled?: boolean;
  is_prepaid?: boolean;
};

type ManifestPassenger = {
  id: number;
  name: string | null;
  phone: string | null;
  seats: number;
  status: string;
  board: string | null;
  board_lat: number | null;
  board_lng: number | null;
  drop: string | null;
};

type ManifestStop = { id: number; seq: number; name: string; lat: number; lng: number };

type ShuttlePoolPassenger = {
  booking_id: number;
  name: string | null;
  seat: string | null;
  status: string;
  payment_method: string | null;
  pickup: { lat: number; lng: number; address: string | null };
  drop: { lat: number; lng: number; address: string | null };
  boarded_at: string | null;
  dropped_at: string | null;
};

type ShuttlePool = {
  journey: { id: number; trip_id: number | null; status: string; capacity: number; boarding_mode?: string };
  aboard: number;
  remaining: number;
  passengers: ShuttlePoolPassenger[];
};

/**
 * What this trip pays the driver, from the server. `collect_cash` is the one
 * that changes behaviour: once fares are paid online and split automatically,
 * there is nothing to take at the kerb and the app must stop implying there is.
 */
type DriverPayout = {
  fare: number;
  commission: number;
  net: number;
  collect_cash: boolean;
  prepaid: boolean;
  label: string;
};

@Component({
  selector: 'app-rides',
  templateUrl: './rides.page.html',
  styleUrls: ['./rides.page.scss'],
  standalone: false,
})
export class RidesPage implements OnInit, OnDestroy {
  private unsubscribeStatus: (() => void) | null = null;
  private availablePoll: any = null;

  tripId: number | null = null;
  busy = false;
  message: string | null = null;
  error: string | null = null;
  lastTrip: Record<string, unknown> | null = null;

  available: AvailableTrip[] = [];
  loadingAvailable = false;

  // Shared (fixed/shuttle) journey manifest — passengers + ordered stops.
  // Null for a private trip.
  sharedManifest: { route_name?: string; passengers: ManifestPassenger[]; stops: ManifestStop[] } | null = null;

  // Shuttle pool manifest — the driver's live rider list for a multi-passenger
  // shuttle. Null unless the active trip is a shuttle pool.
  shuttlePool: ShuttlePool | null = null;

  /** Server's view of what this trip pays the driver. Null on older backends. */
  driverPayout: DriverPayout | null = null;

  negotiation: Record<string, unknown> | null = null;
  counterAmount: number | null = null;
  negBusy = false;
  /** True while the "Offer your price" panel is open from an available ride. */
  priceOpen = false;

  // Full-screen incoming trip modal & circular countdown timer
  activeIncomingTrip: AvailableTrip | null = null;
  requestCountdown = 45;
  private requestTimerSubscription?: Subscription;

  // Drag to accept slider properties
  dragProgress = 0;
  thumbTranslateX = 0;
  isDragging = false;
  private dragStartX = 0;
  private maxTrackWidth = 0;
  private draggedTrip: AvailableTrip | null = null;

  /**
   * Whether the driver may COUNTER the customer's offer ("Send ₹N"). Driven by
   * the vehicle's reverse_bidding_enabled flag on the available-trip / loaded
   * trip; defaults to true when the server omits it. When false the price panel
   * shows Accept/Reject only and counterCustomerOffer() no-ops.
   */
  allowCountering = true;

  // The route's hard fare floor, read from negotiation_config on the
  // /negotiation fetch. No offer may go below minAmount; the input validates
  // against it and the send button stays disabled below it.
  minAmount = 0;

  progressBusy = false;
  // Last breakdown returned by /driver-progress when status=COMPLETED — fed
  // into the summary modal in phase 3.
  completionBreakdown: Record<string, unknown> | null = null;
  /** What the rider still owes after their prepayment. 0 on a normal ride. */
  balanceDue = 0;

  get offers(): Record<string, unknown>[] {
    const raw = this.negotiation?.['offers'];
    return Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
  }

  get finalAmount(): unknown {
    return this.negotiation?.['final_amount'] ?? null;
  }

  /** The customer's current offer for the active/selected trip (display only). */
  get customerOffer(): number {
    const t = this.lastTrip;
    const fromTrip = t?.['customer_offer'] ?? t?.['estimated_fare'];
    const n = Number(fromTrip);
    return Number.isFinite(n) ? n : 0;
  }

  sosBusy = false;

  // Live map for the active trip — shows pickup pin + the customer's GPS as
  // they walk to the curb, plus this driver's own position for context.
  private map: any | null = null;
  private pickupMarker: any | null = null;
  private dropMarker: any | null = null;
  private customerMarker: any | null = null;
  private selfMarker: any | null = null;
  private navRoute = new NavigationRouteRenderer();
  private selfPosition: { lat: number; lng: number } | null = null;
  customerPosition: { lat: number; lng: number } | null = null;
  mapReady = false;
  private selfWatchId: string | null = null;

  constructor(
    private api: ApiService,
    private auth: AuthService,
    private bgLocation: BackgroundLocationService,
    private realtime: RealtimeService,
    private alertCtrl: AlertController,
    private toastCtrl: ToastController,
    private mapsLoader: MapsLoaderService,
    private modalCtrl: ModalController,
    private geo: GeolocationService,
    private router: Router,
    private ringtone: AudioRingtoneService,
  ) {}


  isShuttleTrip(trip: AvailableTrip | Record<string, unknown> | null | undefined = this.lastTrip): boolean {
    if (!trip) return false;
    const service = (trip as any)['service_mode'];
    const rideType = String((trip as any)['ride_type_name'] || '');
    return service === 'shuttle' || rideType.toLowerCase().includes('shuttle');
  }

  get activeTripKindLabel(): string {
    return this.isShuttleTrip(this.lastTrip) ? 'Shuttle' : 'Trip';
  }

  get activePaymentLabel(): string {
    if (this.driverPayout) return this.driverPayout.label;
    if (this.isShuttleTrip(this.lastTrip)) return 'PREPAID RAZORPAY';
    return (this.tripPaymentMethod || '—').toUpperCase();
  }

  requestKindLabel(t: AvailableTrip): string {
    return t.service_mode === 'shuttle' ? 'Shuttle request' : 'Ride request';
  }

  requestActionLabel(t: AvailableTrip): string {
    return t.service_mode === 'shuttle' ? 'Accept paid fare' : 'OK';
  }

  canSOS(): boolean {
    const status = this.lastTrip?.['status'] as string | undefined;
    if (!status) return false;
    return status !== 'COMPLETED' && status !== 'CANCELLED';
  }

  async triggerSOS(): Promise<void> {
    if (this.sosBusy) return;
    const id = (this.lastTrip?.['id'] as number | undefined) ?? this.tripId;
    if (!id) return;

    const a = await this.alertCtrl.create({
      header: 'Send SOS?',
      message: 'Admins will be alerted with your trip and current location.',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Send SOS',
          role: 'destructive',
          handler: () => {
            void this.doTriggerSOS(id);
          },
        },
      ],
    });
    await a.present();
  }

  private async doTriggerSOS(tripId: number): Promise<void> {
    this.sosBusy = true;
    const payload: { lat?: number; lng?: number } = {};
    try {
      const pos = await this.getCurrentPosition();
      if (pos) {
        payload.lat = pos.lat;
        payload.lng = pos.lng;
      }
    } catch {
      /* best-effort */
    }
    this.api.post(`/trips/${tripId}/sos`, payload).subscribe({
      next: async () => {
        const t = await this.toastCtrl.create({
          message: 'SOS sent. Help is on the way.',
          duration: 3000,
          color: 'success',
        });
        await t.present();
      },
      error: async (err: any) => {
        const t = await this.toastCtrl.create({
          message: err?.error?.message || 'Could not send SOS.',
          duration: 3000,
          color: 'danger',
        });
        await t.present();
      },
      complete: () => {
        this.sosBusy = false;
      },
    });
  }

  private async getCurrentPosition(): Promise<{ lat: number; lng: number } | null> {
    try {
      const fix = await this.geo.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: 5000,
        maximumAge: 10_000,
      });
      return fix ? { lat: fix.lat, lng: fix.lng } : null;
    } catch {
      return null;
    }
  }

  ngOnInit(): void {
    // Resume any in-flight trip first so a cold start (page reload, FCM tap,
    // app reopen) drops the driver straight into the in-trip view rather
    // than showing "Driver has an active trip" while the list stays empty.
    this.resumeActiveTrip();
    this.refreshAvailable();
    this.availablePoll = setInterval(() => {
      this.refreshAvailable();
      // Also poll for a freshly-confirmed trip so the moment the customer
      // locks the fare we slide into the in-trip view without a reload.
      if (!this.hasActiveTrip) this.resumeActiveTrip();
    }, 8000);
  }

  /** Called on every tab switch back to Rides — same auto-resume semantics. */
  ionViewWillEnter(): void {
    if (!this.lastTrip) {
      this.resumeActiveTrip();
    }
  }

  ionViewWillLeave(): void {
    this.stopRequestCountdown();
    this.ringtone.stopRinging();
  }

  /**
   * Hydrate lastTrip from /drivers/me/active-trip so the redesigned in-trip
   * view renders without requiring the driver to re-accept. Falls back to
   * silent no-op when no trip is in-flight.
   */
  private resumeActiveTrip(): void {
    this.api
      .get<{ trip: Record<string, unknown> | null }>('/drivers/me/active-trip')
      .subscribe({
        next: (res) => {
          const trip = res?.trip ?? null;
          if (!trip) return;
          if (trip['route_departure_id'] != null) {
            void this.bgLocation.stop();
            void this.router.navigateByUrl('/tabs/fixed', { replaceUrl: true });
            return;
          }
          const id = Number(trip['id']);
          if (!Number.isFinite(id) || id < 1) return;
          this.tripId = id;
          // Reuse loadTrip's hydration path — it pulls the negotiation +
          // initialises the live map + restarts location/status streams when
          // the status is still active.
          this.loadTrip();
        },
        // Silent on error — driver may not be approved yet, or offline.
        error: () => undefined,
      });
  }

  ngOnDestroy(): void {
    this.stopRequestCountdown();
    this.ringtone.stopRinging();
    if (this.unsubscribeStatus) {
      this.unsubscribeStatus();
      this.unsubscribeStatus = null;
    }
    if (this.availablePoll) {
      clearInterval(this.availablePoll);
      this.availablePoll = null;
    }
    this.stopSelfPositionWatch();
    this.navRoute.clear();
  }

  refreshAvailable(): void {
    this.loadingAvailable = true;
    this.api.get<{ data: AvailableTrip[]; reason?: string }>('/trips/available').subscribe({
      next: (res) => {
        this.available = res?.data || [];
        if (res?.reason && !this.available.length) {
          this.message = res.reason;
        }
        if (this.available.length > 0 && !this.hasActiveTrip && !this.priceOpen) {
          const currentId = this.activeIncomingTrip?.id;
          if (!currentId || !this.available.some((t) => t.id === currentId)) {
            this.activeIncomingTrip = this.available[0];
            this.startRequestCountdown();
            this.ringtone.startRinging('incoming-trip-' + this.activeIncomingTrip.id, this.requestCountdown);
          }
        } else if (this.available.length === 0) {
          this.activeIncomingTrip = null;
          this.stopRequestCountdown();
          this.ringtone.stopRinging('available-rides');
          this.ringtone.stopRinging();
        }
      },
      error: () => {
        // silent — driver may be offline / not approved yet
      },
      complete: () => {
        this.loadingAvailable = false;
      },
    });
  }

  /**
   * Per-state hero copy for the in-trip view. Mirrors the customer-side
   * statusCopy() so both sides read the same scenario.
   */
  statusCopy(): { title: string; sub: string; tone: 'primary' | 'success' | 'warning' | 'medium' } {
    const status = (this.lastTrip?.['status'] as string | undefined) ?? '';
    const shuttle = this.isShuttleTrip(this.lastTrip);
    switch (status) {
      case 'PAYMENT_PENDING':
        return { title: 'Driver approval complete', sub: 'Waiting for customer payment or deposit.', tone: 'warning' };
      case 'CONFIRMED':
        return shuttle
          ? { title: 'Shuttle request confirmed', sub: 'Accept it to start pickup flow', tone: 'primary' }
          : { title: 'Trip confirmed', sub: 'Get ready to drive to pickup', tone: 'primary' };
      case 'ASSIGNED':
        return { title: shuttle ? 'Shuttle assigned' : 'Heading to pickup', sub: 'Tap below when you start moving', tone: 'primary' };
      case 'EN_ROUTE_PICKUP':
        return { title: shuttle ? 'Driving to Shuttle pickup' : 'On the way to pickup', sub: 'Customer is waiting', tone: 'primary' };
      case 'ARRIVED_PICKUP':
        return { title: 'At pickup', sub: shuttle ? 'Ask rider for the start code before leaving' : 'Waiting for the customer to come out', tone: 'warning' };
      case 'EN_ROUTE_DROP':
        return { title: shuttle ? 'Shuttle ride in progress' : 'Trip in progress', sub: 'Driving to drop-off', tone: 'success' };
      case 'ARRIVED_DROP':
        return { title: "You've arrived at drop", sub: 'Tap below to end the ride', tone: 'success' };
      case 'COMPLETED':
        return { title: shuttle ? 'Shuttle trip complete' : 'Trip complete', sub: '', tone: 'medium' };
      case 'CANCELLED':
        return { title: shuttle ? 'Shuttle cancelled' : 'Trip cancelled', sub: '', tone: 'medium' };
      default:
        return { title: status || 'Loading…', sub: '', tone: 'medium' };
    }
  }

  /** Customer display name for the in-trip card; falls back gracefully. */
  get customerName(): string {
    const t = this.lastTrip;
    if (!t) return '';
    const direct = (t['customer_name'] as string | undefined) || '';
    if (direct) return direct;
    const customer = (t['customer'] as { name?: string } | undefined) || undefined;
    return customer?.name || 'Customer';
  }

  /** Rider's phone (the friend's number on a for-someone-else booking). */
  get customerPhone(): string {
    return ((this.lastTrip?.['customer_phone'] as string | undefined) || '').trim();
  }

  /** True when this active trip was booked for a friend / family. */
  get isForOther(): boolean {
    return !!this.lastTrip?.['is_for_other'];
  }

  /** Rider avatar: suppressed when booked for someone else (is_for_other). */
  get customerAvatarUrl(): string | null {
    if (this.isForOther) return null;
    return (this.lastTrip?.['customer_avatar_url'] as string | undefined) || null;
  }

  /** Dial the rider to coordinate pickup. */
  call(phone: string | null | undefined): void {
    const p = (phone || '').trim();
    if (p) window.location.href = `tel:${p}`;
  }

  /**
   * True when we're rendering the focused active-trip layout (vs the
   * available list). NEGOTIATION is handled by the available list / price
   * card so the driver can still bid; CONFIRMED onwards is "locked in" and
   * deserves the in-trip view with its Accept-ride / progression CTA.
   */
  get hasActiveTrip(): boolean {
    const status = (this.lastTrip?.['status'] as string | undefined) ?? '';
    if (!this.lastTrip) return false;
    return [
      'PAYMENT_PENDING',
      'CONFIRMED',
      'ASSIGNED',
      'EN_ROUTE_PICKUP',
      'ARRIVED_PICKUP',
      'EN_ROUTE_DROP',
      'ARRIVED_DROP',
    ].includes(status);
  }

  /**
   * Maps the trip's current status to the next progression action the driver
   * can take, or null when no progression is available (pre-accept, terminal).
   * Drives a single context-aware action button on the rides page.
   *
   * `kind` distinguishes the backend endpoint each label maps to:
   *   - 'accept'   → POST /trips/{id}/driver-accept (CONFIRMED → ASSIGNED)
   *   - 'progress' → PATCH /trips/{id}/driver-progress for the rest
   */
  nextAction(): { label: string; nextStatus: string; kind: 'accept' | 'progress'; confirm?: boolean } | null {
    const status = (this.lastTrip?.['status'] as string | undefined) || null;
    switch (status) {
      case 'CONFIRMED':
        return { label: this.isShuttleTrip(this.lastTrip) ? 'Accept Shuttle' : 'Accept ride', nextStatus: 'ASSIGNED', kind: 'accept' };
      case 'ASSIGNED':
        return { label: this.isShuttleTrip(this.lastTrip) ? 'Start to Shuttle pickup' : 'Start to pickup', nextStatus: 'EN_ROUTE_PICKUP', kind: 'progress' };
      case 'EN_ROUTE_PICKUP':
        return { label: "I've arrived at pickup", nextStatus: 'ARRIVED_PICKUP', kind: 'progress' };
      case 'ARRIVED_PICKUP':
        return { label: 'Start trip', nextStatus: 'EN_ROUTE_DROP', kind: 'progress' };
      case 'EN_ROUTE_DROP':
        return { label: "I've arrived at drop", nextStatus: 'ARRIVED_DROP', kind: 'progress' };
      case 'ARRIVED_DROP':
        return { label: 'Complete ride', nextStatus: 'COMPLETED', kind: 'progress', confirm: true };
      default:
        // NEGOTIATION is handled by the price card (OK / My price buttons),
        // not by the in-trip CTA, so we return null here.
        return null;
    }
  }

  async advance(): Promise<void> {
    const id = (this.lastTrip?.['id'] as number | undefined) ?? this.tripId;
    const action = this.nextAction();
    if (!id || !action || this.progressBusy) return;

    // "Start ride" (ARRIVED_PICKUP → EN_ROUTE_DROP) is gated by a start OTP the
    // rider received on their phone — open the locked verify screen instead of
    // advancing directly.
    if (action.kind === 'progress' && action.nextStatus === 'EN_ROUTE_DROP') {
      await this.startRideWithOtp(id);
      return;
    }

    if (action.confirm) {
      const ok = await this.alertCtrl.create({
        header: 'End the ride?',
        message: 'This will calculate the final fare and notify the customer to pay.',
        buttons: [
          { text: 'Not yet', role: 'cancel' },
          { text: 'End ride', role: 'destructive', handler: () => this.doAdvance(id, action.nextStatus, action.kind) },
        ],
      });
      await ok.present();
      return;
    }
    void this.doAdvance(id, action.nextStatus, action.kind);
  }

  /**
   * Start-ride OTP flow: request a code (sent to the rider's phone), then lock
   * the driver on the full-screen verify screen. The modal itself verifies via
   * /driver-progress and only dismisses with { started } on success.
   */
  private async startRideWithOtp(tripId: number): Promise<void> {
    this.progressBusy = true;
    this.error = null;
    try {
      await firstValueFrom(this.api.post(`/trips/${tripId}/start-otp`, {}));
    } catch (err: any) {
      this.error = err?.error?.message || 'Could not send the start code. Try again.';
      this.progressBusy = false;
      return;
    }

    const modal = await this.modalCtrl.create({
      component: StartOtpModal,
      cssClass: 'start-otp-modal',
      backdropDismiss: false,
      componentProps: { tripId, riderName: this.customerName },
    });
    try {
      await modal.present();
      const { data } = await modal.onWillDismiss<{ started?: boolean; trip?: Record<string, unknown> }>();
      if (data?.started && data.trip) {
        this.lastTrip = data.trip;
      }
    } finally {
      // Always re-enable the CTA, however the modal closed.
      this.progressBusy = false;
    }
  }

  private async doAdvance(tripId: number, nextStatus: string, kind: 'accept' | 'progress'): Promise<void> {
    this.progressBusy = true;
    this.error = null;
    this.message = null;

    // CONFIRMED → ASSIGNED uses /driver-accept (separate endpoint that also
    // kicks off the location stream); everything else uses /driver-progress.
    if (kind === 'accept') {
      this.api
        .post<{ trip: Record<string, unknown> }>(`/trips/${tripId}/driver-accept`, {})
        .subscribe({
          next: (res) => {
            this.lastTrip = res.trip || this.lastTrip;
            this.startTripStreams(tripId);
          },
          error: (err) => {
            this.error = err?.error?.message || 'Could not accept ride.';
          },
          complete: () => {
            this.progressBusy = false;
          },
        });
      return;
    }

    const location = await this.getCurrentPosition();
    const body: Record<string, unknown> = { status: nextStatus };
    if (location) body['location'] = location;

    // Finishing the ride is the driver's one chance to declare what the meter
    // couldn't see — a toll they paid, or waiting the rider asked for.
    if (nextStatus === 'COMPLETED') {
      const extras = await this.askForExtras();
      if (extras === null) {
        this.progressBusy = false;
        return; // driver backed out of the prompt
      }
      Object.assign(body, extras);
    }

    this.api
      .patch<{ trip: Record<string, unknown>; breakdown?: Record<string, unknown>; balance_due?: number }>(
        `/trips/${tripId}/driver-progress`,
        body,
      )
      .subscribe({
        next: (res) => {
          this.lastTrip = res.trip || this.lastTrip;
          if (res.breakdown) {
            this.completionBreakdown = res.breakdown;
          }
          this.balanceDue = res.balance_due ?? 0;
          if (nextStatus === 'COMPLETED') {
            void this.bgLocation.stop();
            this.onTripCompleted();
          }
        },
        error: (err) => {
          this.error = err?.error?.message || 'Could not advance trip.';
        },
        complete: () => {
          this.progressBusy = false;
        },
      });
  }

  /**
   * Asks the driver for anything the meter couldn't see before the ride closes:
   * a toll they paid out of pocket, or waiting the rider asked for beyond the
   * automatic timer. Both optional — the common case is tapping Finish and
   * leaving them blank.
   *
   * Returns the fields to send, or null if the driver dismissed the prompt (in
   * which case the ride is NOT completed — better to ask again than to close a
   * trip they didn't mean to close).
   */
  private async askForExtras(): Promise<Record<string, unknown> | null> {
    // Hide the toll box when tolls are off for this city — the server ignores a
    // declared toll then anyway, so there's nothing for the driver to enter.
    const tollsEnabled = this.lastTrip?.['tolls_enabled'] !== false;
    const inputs = [
      ...(tollsEnabled
        ? [{ name: 'toll', type: 'number' as const, placeholder: 'Toll you paid (₹)', min: 0 }]
        : []),
      { name: 'waiting', type: 'number' as const, placeholder: 'Extra waiting charge (₹)', min: 0 },
    ];
    const alert = await this.alertCtrl.create({
      header: 'Anything to add?',
      message: 'Leave blank if not. The rider pays any extra online — never in cash.',
      inputs,
      buttons: [
        { text: 'Back', role: 'cancel' },
        { text: 'Finish ride', role: 'confirm' },
      ],
    });

    await alert.present();
    const { data, role } = await alert.onDidDismiss();
    if (role === 'cancel' || role === 'backdrop') return null;

    const body: Record<string, unknown> = {};
    const toll = Number(data?.values?.toll);
    const waiting = Number(data?.values?.waiting);
    if (Number.isFinite(toll) && toll > 0) body['extra_toll_amount'] = toll;
    if (Number.isFinite(waiting) && waiting > 0) body['extra_waiting_amount'] = waiting;

    return body;
  }

  /**
   * Open the trip summary modal, then clear active-trip state on dismiss so
   * the rides list refreshes and the driver can pick up the next ride.
   */
  protected async onTripCompleted(): Promise<void> {
    const modal = await this.modalCtrl.create({
      component: TripSummaryModal,
      componentProps: {
        trip: this.lastTrip,
        breakdown: this.completionBreakdown,
        balanceDue: this.balanceDue,
      },
      breakpoints: [0, 0.7, 1],
      initialBreakpoint: 0.7,
    });
    await modal.present();
    await modal.onDidDismiss();

    this.tripId = null;
    this.lastTrip = null;
    this.negotiation = null;
    this.completionBreakdown = null;
    this.message = null;
    this.navRoute.clear();
    this.refreshAvailable();
  }

  /**
   * Read the vehicle's reverse-bidding flag off a trip-shaped object. Absent =
   * allowed (?? true), matching the shared contract default.
   */
  private readReverseBidding(trip: Record<string, unknown> | null | undefined): boolean {
    const raw = trip?.['reverse_bidding_enabled'];
    return raw == null ? true : !!raw;
  }

  pickAvailable(t: AvailableTrip, action: 'accept' | 'price'): void {
    this.ringtone.stopRinging();
    this.tripId = t.id;
    this.error = null;
    this.message = null;
    // Latch the vehicle's reverse-bidding rule for the price panel.
    this.allowCountering = t.service_mode === 'shuttle' ? false : (t.reverse_bidding_enabled ?? true);
    if (action === 'accept') {
      // Accept the customer's offer at face value.
      this.priceOpen = false;
      this.counterAmount = t.customer_offer ?? t.estimated_fare ?? 0;
      this.acceptCustomerOffer();
    } else {
      // Open the price panel with an empty input. A broadcast trip's floor isn't
      // known client-side until a bid exists, so the server enforces the minimum.
      this.counterAmount = null;
      this.minAmount = 0;
      this.priceOpen = true;
    }
  }

  /**
   * Statuses where the server accepts `POST /trips/{id}/location` pings. Must
   * stay in sync with backend `Trip::ACTIVE_DRIVER_STATUSES` — any wider list
   * here causes a 409 loop because the server rejects the writes.
   */
  private readonly LOCATION_STREAM_STATUSES = [
    'ASSIGNED',
    'EN_ROUTE_PICKUP',
    'ARRIVED_PICKUP',
    'EN_ROUTE_DROP',
    'ARRIVED_DROP',
  ];

  loadTrip(): void {
    const id = this.validId();
    if (id == null) return;
    this.busy = true;
    this.error = null;
    this.message = null;
    this.api
      .get<{
        trip?: Record<string, unknown>;
        negotiation?: Record<string, unknown>;
        negotiation_config?: { min_amount?: number; floor_percent?: number; estimated_fare?: number };
        driver_payout?: DriverPayout;
      }>(
        `/trips/${id}/negotiation`
      )
      .subscribe({
        next: (res) => {
          this.lastTrip = res.trip || null;
          this.negotiation = res.negotiation || null;
          // Absent on older backends — the card falls back to the fare alone.
          this.driverPayout = res.driver_payout ?? null;
          // Latch the vehicle's reverse-bidding rule from the loaded trip.
          this.allowCountering = this.readReverseBidding(this.lastTrip);
          this.maybeRefreshManifest();
          this.maybeRefreshPool();

          // Pull the city-configured negotiation floor — offers below it are rejected.
          const cfg = res['negotiation_config'] || {};
          const floor = Number(cfg.min_amount);
          this.minAmount = Number.isFinite(floor) ? floor : 0;

          // If we just loaded an in-flight trip (e.g. after a reload mid-ride),
          // bring up the live map and re-subscribe to streams.
          const status = this.lastTrip?.['status'] as string | undefined;
          if (status && status !== 'COMPLETED' && status !== 'CANCELLED') {
            void this.initLiveMap();
            this.startSelfPositionWatch();
            // Only start the location-ping stream when the server will accept
            // the writes. CONFIRMED / NEGOTIATION are not in
            // ACTIVE_DRIVER_STATUSES — pinging during those states returns 409.
            if (
              this.lastTrip?.['driver_id'] &&
              this.LOCATION_STREAM_STATUSES.includes(status)
            ) {
              this.startTripStreams(id);
            }
          }
        },
        error: (err) => {
          this.error = err?.error?.message || 'Could not load trip.';
          this.lastTrip = null;
        },
        complete: () => {
          this.busy = false;
        },
      });
  }

  get tripPaymentMethod(): PaymentMethod | null {
    const m = this.lastTrip?.['payment_method'];
    return m === 'cash' || m === 'razorpay' ? m : null;
  }

  /**
   * Is there money to take at the kerb? The server decides — under the
   * auto-split model the answer is always no, because the rider paid online and
   * the driver's share is transferred to their bank after the ride.
   */
  get collectsCash(): boolean {
    if (this.driverPayout) return this.driverPayout.collect_cash;
    return this.tripPaymentMethod === 'cash';
  }

  get acceptsTripPayment(): boolean {
    const m = this.tripPaymentMethod;
    if (!m) return true;
    const accepted = this.auth.getUser()?.accepted_payment_methods ?? ['cash', 'razorpay'];
    return accepted.includes(m);
  }

  get pickupCoords() {
    return this.lastTrip ? coordsFromTrip(this.lastTrip, 'pickup_lat', 'pickup_lng') : null;
  }

  get dropCoords() {
    return this.lastTrip ? coordsFromTrip(this.lastTrip, 'drop_lat', 'drop_lng') : null;
  }

  get canNavigatePickup(): boolean {
    return this.pickupCoords !== null;
  }

  get canNavigateDrop(): boolean {
    return this.dropCoords !== null;
  }

  get canNavigateRoute(): boolean {
    return this.pickupCoords !== null && this.dropCoords !== null;
  }

  /** From current location (or Maps default) to pickup. */
  navigateToPickup(): void {
    const dest = this.pickupCoords;
    if (!dest) return;
    openExternalUrl(googleMapsDirectionsUrl({ destination: dest, travelmode: 'driving' }));
  }

  /** From current location to drop-off. */
  navigateToDrop(): void {
    const dest = this.dropCoords;
    if (!dest) return;
    openExternalUrl(googleMapsDirectionsUrl({ destination: dest, travelmode: 'driving' }));
  }

  /** Full ride path: pickup → drop (no “my location” leg). */
  navigatePickupToDrop(): void {
    const a = this.pickupCoords;
    const b = this.dropCoords;
    if (!a || !b) return;
    openExternalUrl(googleMapsDirectionsUrl({ origin: a, destination: b, travelmode: 'driving' }));
  }

  private validId(): number | null {
    const raw = this.tripId;
    const id = raw == null || raw === ('' as unknown) ? NaN : Number(raw);
    if (!Number.isFinite(id) || id < 1) {
      this.error = 'Enter a valid trip ID';
      return null;
    }
    return id;
  }

  accept(): void {
    const id = this.validId();
    if (id == null) return;
    this.busy = true;
    this.error = null;
    this.message = null;
    this.api.post<{ trip?: Record<string, unknown> }>(`/trips/${id}/driver-accept`, {}).subscribe({
      next: (res) => {
        this.lastTrip = res.trip || null;
        this.message = this.isShuttleTrip(this.lastTrip) ? 'Shuttle accepted' : 'Ride accepted';
        this.startTripStreams(id);
      },
      error: (err) => {
        this.error = err?.error?.message || 'Accept failed';
        this.lastTrip = null;
      },
      complete: () => {
        this.busy = false;
      },
    });
  }

  private startTripStreams(tripId: number): void {
    void this.bgLocation.start(tripId);

    if (this.unsubscribeStatus) this.unsubscribeStatus();
    this.unsubscribeStatus = this.realtime.subscribeTripStatus(
      tripId,
      (payload) => {
        if (this.lastTrip) this.lastTrip['status'] = payload.status;
        this.refreshTripMarkers();
        if (payload.status === 'COMPLETED' || payload.status === 'CANCELLED') {
          void this.bgLocation.stop();
          this.stopSelfPositionWatch();
          this.navRoute.clear();
        }
      },
      (payload) => this.onCustomerLocation(payload),
      // A rider boarded / was dropped on this pool — refresh the manifest live.
      () => this.maybeRefreshPool()
    );

    void this.initLiveMap();
    this.startSelfPositionWatch();
  }

  // ─────────────────────────────────────────────────────────────────
  // Live trip map
  // ─────────────────────────────────────────────────────────────────

  private async initLiveMap(): Promise<void> {
    if (this.mapReady) {
      this.refreshTripMarkers();
      return;
    }
    try {
      await this.mapsLoader.ensureLoaded();
      const div = document.getElementById('driver-trip-map');
      if (!div) return;
      this.map = new google.maps.Map(div, {
        center: { lat: 28.6139, lng: 77.209 },
        zoom: 14,
        disableDefaultUI: true,
        // Required for AdvancedMarkerElement (the replacement for the
        // deprecated google.maps.Marker class). Use a real Cloud Map ID in
        // production for styling/POI customisation.
        mapId: 'DEMO_MAP_ID',
      });
      this.mapReady = true;
      this.refreshTripMarkers();
    } catch {
      // Maps may be unavailable (no key, offline) — page still works without it.
    }
  }

  private refreshTripMarkers(): void {
    if (!this.map || !this.lastTrip) return;
    const pickup = coordsFromTrip(this.lastTrip, 'pickup_lat', 'pickup_lng');
    const drop = coordsFromTrip(this.lastTrip, 'drop_lat', 'drop_lng');

    if (pickup) {
      if (!this.pickupMarker) {
        this.pickupMarker = new google.maps.marker.AdvancedMarkerElement({
          position: pickup,
          map: this.map,
          title: 'Pickup',
          content: buildPassengerMarkerElement({
            kind: 'pickup',
            name: this.customerName || 'Pickup',
            avatarUrl: this.customerAvatarUrl,
          }),
          zIndex: 900,
        });
      } else {
        this.pickupMarker.position = pickup;
      }
    }
    if (drop) {
      if (!this.dropMarker) {
        this.dropMarker = new google.maps.marker.AdvancedMarkerElement({
          position: drop,
          map: this.map,
          title: 'Drop',
          content: buildPassengerMarkerElement({ kind: 'drop', name: 'Drop' }),
          zIndex: 850,
        });
      } else {
        this.dropMarker.position = drop;
      }
    }

    // Directional navigation polyline corridor with repeating chevrons
    const status = String(this.lastTrip?.['status'] || '').toUpperCase();
    const isHeadingDrop = status === 'EN_ROUTE_DROP' || status === 'ARRIVED_DROP';
    const isPickupActive = status === 'ASSIGNED' || status === 'EN_ROUTE_PICKUP' || status === 'ARRIVED_PICKUP';

    if (isHeadingDrop && drop) {
      const origin = this.selfPosition || pickup;
      if (origin) {
        void this.navRoute.render(this.map, origin, drop, 'drop');
      }
    } else if (isPickupActive && pickup) {
      if (this.selfPosition) {
        void this.navRoute.render(this.map, this.selfPosition, pickup, 'pickup');
      }
    } else {
      this.navRoute.clear();
    }

    this.fitMap();
  }

  private fitMap(): void {
    if (!this.map) return;
    const bounds = new google.maps.LatLngBounds();
    let any = false;
    for (const m of [this.pickupMarker, this.dropMarker, this.customerMarker, this.selfMarker]) {
      if (m && m.position) {
        bounds.extend(m.position as any);
        any = true;
      }
    }
    if (any) this.map.fitBounds(bounds, 80);
  }

  private onCustomerLocation(p: TripCustomerLocationPayload): void {
    const loc = p.location;
    if (loc?.lat == null || loc?.lng == null) return;
    const pos = { lat: Number(loc.lat), lng: Number(loc.lng) };
    this.customerPosition = pos;
    if (!this.map) return;
    if (!this.customerMarker) {
      this.customerMarker = new google.maps.marker.AdvancedMarkerElement({
        position: pos,
        map: this.map,
        title: 'Customer',
        content: buildPassengerMarkerElement({
          kind: 'pickup',
          name: this.customerName || 'Passenger',
          isLive: true,
          avatarUrl: this.customerAvatarUrl,
        }),
        zIndex: 950,
      });
      this.fitMap();
    } else {
      this.customerMarker.position = pos;
    }
  }

  private async startSelfPositionWatch(): Promise<void> {
    if (this.selfWatchId !== null) return;
    this.selfWatchId = await this.geo.watchPosition(
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 10_000 },
      (fix, err) => {
        if (err) {
          void this.stopSelfPositionWatch();
          return;
        }
        if (fix) this.onSelfPosition(fix);
      },
    );
  }

  private async stopSelfPositionWatch(): Promise<void> {
    if (this.selfWatchId !== null) {
      await this.geo.clearWatch(this.selfWatchId);
    }
    this.selfWatchId = null;
  }

  private onSelfPosition(fix: GeoFix): void {
    if (!this.map) return;
    const p = { lat: fix.lat, lng: fix.lng };
    const hadNoSelfPosition = !this.selfPosition;
    this.selfPosition = p;
    this.navRoute.updateDriverProgress(p);
    if (hadNoSelfPosition && this.lastTrip) {
      this.refreshTripMarkers();
    }
    const markerUrl = (this.lastTrip as any)?.driver?.vehicle?.map_marker_url
      || (this.lastTrip as any)?.driver?.map_marker_url
      || (this.lastTrip as any)?.map_marker_url
      || (this.lastTrip as any)?.vehicle?.map_marker_url
      || (this.auth.getUser() as any)?.map_marker_url
      || (this.auth.getUser() as any)?.vehicle?.map_marker_url
      || null;

    if (!this.selfMarker) {
      this.selfMarker = new google.maps.marker.AdvancedMarkerElement({
        position: p,
        map: this.map,
        title: 'You',
        content: buildReusableCarMarkerElement({
          bearing: fix.bearing ?? 0,
          label: 'You',
          markerUrl,
        }),
        zIndex: 1000,
      });
      this.fitMap();
    } else {
      this.selfMarker.position = p;
      if (fix.bearing != null) {
        updateCarMarkerBearing(this.selfMarker, fix.bearing);
      }
      if (markerUrl) {
        updateCarMarkerImage(this.selfMarker, markerUrl);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Marker content builders for AdvancedMarkerElement
  // ─────────────────────────────────────────────────────────────────

  private buildPin(letter: string, color: string): HTMLElement {
    const el = document.createElement('div');
    el.style.cssText = [
      'width:28px',
      'height:36px',
      'display:flex',
      'align-items:flex-start',
      'justify-content:center',
      'padding-top:4px',
      'font-weight:700',
      'font-size:13px',
      'color:#fff',
      `background:${color}`,
      'border-radius:50% 50% 50% 0',
      'transform:rotate(-45deg) translate(0,-14px)',
      'border:2px solid #fff',
      'box-shadow:0 1px 4px rgba(0,0,0,0.4)',
    ].join(';');
    const inner = document.createElement('span');
    inner.textContent = letter;
    inner.style.cssText = 'transform:rotate(45deg);';
    el.appendChild(inner);
    return el;
  }

  private buildDot(color: string): HTMLElement {
    const el = document.createElement('div');
    el.style.cssText = [
      'width:16px',
      'height:16px',
      'border-radius:50%',
      `background:${color}`,
      'border:2px solid #fff',
      'box-shadow:0 1px 4px rgba(0,0,0,0.4)',
    ].join(';');
    return el;
  }

  private buildArrow(bearingDeg: number, color: string): HTMLElement {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'width:22px;height:22px;display:flex;align-items:center;justify-content:center;';
    const arrow = document.createElement('div');
    arrow.style.cssText = [
      `transform:rotate(${bearingDeg}deg)`,
      'width:0',
      'height:0',
      'border-left:6px solid transparent',
      'border-right:6px solid transparent',
      `border-bottom:14px solid ${color}`,
      'filter:drop-shadow(0 1px 2px rgba(0,0,0,0.4))',
    ].join(';');
    wrap.appendChild(arrow);
    return wrap;
  }

  /** A shared journey carries a route departure; private trips don't. */
  get isSharedDeparture(): boolean {
    return this.lastTrip?.['route_departure_id'] != null;
  }

  get manifestPassengers(): ManifestPassenger[] {
    return this.sharedManifest?.passengers ?? [];
  }

  /** Fetch the passenger manifest when the active trip is a shared departure. */
  private maybeRefreshManifest(): void {
    const id = this.tripId ?? (this.lastTrip?.['id'] as number | undefined);
    if (!id || !this.isSharedDeparture) {
      this.sharedManifest = null;
      return;
    }
    this.api
      .get<{ route_name?: string; passengers: ManifestPassenger[]; stops: ManifestStop[] }>(`/trips/${id}/manifest`)
      .subscribe({
        next: (res) => {
          this.sharedManifest = {
            route_name: res.route_name,
            passengers: res.passengers || [],
            stops: res.stops || [],
          };
        },
        error: () => undefined,
      });
  }

  // ─────────────────────────────────────────────────────────────────
  // Shuttle pool — the driver's live multi-passenger rider list
  // ─────────────────────────────────────────────────────────────────

  get poolPassengers(): ShuttlePoolPassenger[] {
    return this.shuttlePool?.passengers ?? [];
  }

  /** True once we've loaded a pool with at least one rider on it. */
  get isShuttlePool(): boolean {
    return !!this.shuttlePool && this.poolPassengers.length > 0;
  }

  poolStatusLabel(p: ShuttlePoolPassenger): string {
    switch (p.status) {
      case 'BOARDED': return 'Aboard';
      case 'DROPPED': return 'Dropped';
      case 'NO_SHOW': return 'No-show';
      default: return 'Waiting';
    }
  }

  /** Fetch the pool manifest when the active trip is a shuttle. */
  maybeRefreshPool(): void {
    const id = this.tripId ?? (this.lastTrip?.['id'] as number | undefined);
    if (!id || !this.isShuttleTrip(this.lastTrip)) {
      this.shuttlePool = null;
      return;
    }
    this.api.get<ShuttlePool>(`/shuttle/trips/${id}/manifest`).subscribe({
      next: (res) => { this.shuttlePool = res; },
      error: () => { this.shuttlePool = null; },
    });
  }

  async boardShuttle(bookingId: number): Promise<void> {
    const mode = this.shuttlePool?.journey?.boarding_mode ?? 'driver_only';
    // Driver-only = tap to board. Every other mode needs the rider's code first.
    if (mode === 'driver_only') {
      this.poolAction(bookingId, 'board');
      return;
    }
    if (this.busy) return;
    this.busy = true;
    this.error = null;
    // Generate the rider's code (they see it on their own screen), then ask for it.
    this.api.post(`/shuttle/bookings/${bookingId}/boarding-otp`, {}).subscribe({
      next: () => { this.busy = false; void this.promptBoardingCode(bookingId); },
      error: (err) => { this.busy = false; this.error = err?.error?.message || 'Could not start boarding.'; },
    });
  }

  private async promptBoardingCode(bookingId: number): Promise<void> {
    const alert = await this.alertCtrl.create({
      header: 'Boarding code',
      message: 'Ask the rider for their boarding code.',
      inputs: [{ name: 'code', type: 'text', attributes: { inputmode: 'numeric', maxlength: 4 }, placeholder: '4-digit code' }],
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Board', handler: (data) => this.boardWithCode(bookingId, String(data?.code || '').trim()) },
      ],
    });
    await alert.present();
  }

  private boardWithCode(bookingId: number, code: string): void {
    if (!code) { this.error = "Enter the rider's code."; return; }
    this.busy = true;
    this.error = null;
    this.api.post(`/shuttle/bookings/${bookingId}/board`, { code }).subscribe({
      next: () => this.maybeRefreshPool(),
      error: (err) => { this.error = err?.error?.message || 'Wrong or expired code.'; },
      complete: () => { this.busy = false; },
    });
  }

  dropShuttle(bookingId: number): void {
    this.poolAction(bookingId, 'drop');
  }
  private poolAction(bookingId: number, action: 'board' | 'drop'): void {
    if (this.busy) return;
    this.busy = true;
    this.error = null;
    this.api.post(`/shuttle/bookings/${bookingId}/${action}`, {}).subscribe({
      next: () => this.maybeRefreshPool(),
      error: (err) => { this.error = err?.error?.message || 'Could not update passenger'; },
      complete: () => { this.busy = false; },
    });
  }

  boardPassenger(reservationId: number): void {
    this.seatAction(reservationId, 'board');
  }
  noShowPassenger(reservationId: number): void {
    this.seatAction(reservationId, 'no-show');
  }
  private seatAction(reservationId: number, action: 'board' | 'no-show'): void {
    const id = this.tripId ?? (this.lastTrip?.['id'] as number | undefined);
    if (!id || this.busy) return;
    this.busy = true;
    this.error = null;
    this.api
      .post(`/trips/${id}/seat-reservations/${reservationId}/${action}`, {})
      .subscribe({
        next: () => this.maybeRefreshManifest(),
        error: (err) => {
          this.error = err?.error?.message || 'Could not update passenger';
        },
        complete: () => {
          this.busy = false;
        },
      });
  }

  markCustomerNoShow(): void {
    const id = this.tripId ?? (this.lastTrip?.['id'] as number | undefined);
    if (!id) return;
    this.busy = true;
    this.error = null;
    this.message = null;
    this.api
      .post<{ trip?: Record<string, unknown>; fee?: number }>(`/trips/${id}/no-show`, { role: 'customer' })
      .subscribe({
        next: (res) => {
          this.lastTrip = res.trip || null;
          const fee = res.fee ?? 0;
          this.message = `Trip cancelled (no-show). Cancellation fee ₹${fee}`;
          void this.bgLocation.stop();
        },
        error: (err) => {
          this.error = err?.error?.message || 'Could not mark no-show';
        },
        complete: () => {
          this.busy = false;
        },
      });
  }

  canDriverCancelTrip(): boolean {
    const s = String(this.lastTrip?.['status'] || '').toUpperCase();
    return ['ASSIGNED', 'EN_ROUTE_PICKUP', 'ARRIVED_PICKUP'].includes(s);
  }

  async confirmDriverCancelTrip(): Promise<void> {
    const id = this.tripId ?? (this.lastTrip?.['id'] as number | undefined);
    if (!id) return;

    const alert = await this.alertCtrl.create({
      header: 'Cancel ride?',
      subHeader: 'Emergency / breakdown cancellation',
      message: 'This will cancel the ride immediately. The customer will receive a 100% full refund.',
      inputs: [
        { name: 'reason', type: 'radio', label: 'Vehicle breakdown / flat tire', value: 'Vehicle breakdown / flat tire', checked: true },
        { name: 'reason', type: 'radio', label: 'Personal emergency', value: 'Personal emergency' },
        { name: 'reason', type: 'radio', label: 'Accident / road blocked', value: 'Accident / road blocked' },
        { name: 'reason', type: 'radio', label: 'Cannot reach pickup location', value: 'Cannot reach pickup location' },
      ],
      buttons: [
        { text: 'Keep ride', role: 'cancel' },
        {
          text: 'Cancel ride',
          role: 'destructive',
          handler: (reason: string) => {
            this.executeDriverCancelTrip(id, reason || 'Driver cancelled before pickup');
          },
        },
      ],
    });
    await alert.present();
  }

  private executeDriverCancelTrip(tripId: number, reason: string): void {
    this.busy = true;
    this.error = null;
    this.message = null;
    this.api.post<{ trip?: Record<string, unknown>; message?: string }>(`/trips/${tripId}/driver-cancel`, { reason })
      .subscribe({
        next: (res) => {
          this.lastTrip = res.trip || null;
          this.tripId = null;
          this.message = res.message || 'Ride cancelled.';
          void this.bgLocation.stop();
          this.refreshAvailable();
        },
        error: (err) => {
          this.error = err?.error?.message || 'Could not cancel ride.';
          this.busy = false;
        },
        complete: () => {
          this.busy = false;
        },
      });
  }

  reject(): void {
    const id = this.validId();
    if (id == null) return;
    this.ringtone.stopRinging();
    this.busy = true;
    this.error = null;
    this.message = null;
    this.api.post<{ message?: string }>(`/trips/${id}/driver-reject`, {}).subscribe({
      next: (res) => {
        this.ringtone.playRejectChime();
        this.message = res.message || 'Rejected';
        this.lastTrip = null;
      },
      error: (err) => {
        this.error = err?.error?.message || 'Reject failed';
      },
      complete: () => {
        this.busy = false;
      },
    });
  }

  acceptCustomerOffer(): void {
    const id = this.validId();
    if (id == null) return;
    this.ringtone.stopRinging();
    this.negBusy = true;
    this.error = null;
    this.message = null;

    this.api.post<{ negotiation: Record<string, unknown> }>(`/trips/${id}/negotiation/driver-action`, {
      action: 'ACCEPT',
    }).subscribe({
      next: (res) => {
        this.ringtone.playSuccessChime();
        this.negotiation = res.negotiation || null;
        this.message = this.isShuttleTrip(this.lastTrip) ? 'Shuttle fare accepted' : 'Offer accepted';
      },
      error: (err) => {
        this.error = err?.error?.message || 'Accept failed';
        this.negotiation = null;
      },
      complete: () => {
        this.negBusy = false;
      },
    });
  }

  counterCustomerOffer(): void {
    const id = this.validId();
    if (id == null) return;
    // Reverse bidding off for this vehicle — accept or reject only.
    if (!this.allowCountering) {
      this.message = "Countering isn't available for this vehicle — accept or reject.";
      return;
    }
    if (
      this.counterAmount == null ||
      !Number.isFinite(this.counterAmount) ||
      this.counterAmount < this.minAmount
    ) {
      this.error = 'Pick a valid price.';
      return;
    }

    this.negBusy = true;
    this.error = null;
    this.message = null;

    this.api
      .post<{ negotiation: Record<string, unknown> }>(`/trips/${id}/negotiation/driver-action`, {
        action: 'COUNTER',
        amount: this.counterAmount,
      })
      .subscribe({
        next: (res) => {
          this.negotiation = res.negotiation || null;
          this.message = `Price sent · ₹${this.counterAmount}`;
        },
        error: (err) => {
          this.error = err?.error?.message || 'Could not send price.';
          this.negotiation = null;
        },
        complete: () => {
          this.negBusy = false;
        },
      });
  }

  /* ─── Incoming Ride Modal Countdown & Actions ─── */

  private startRequestCountdown(): void {
    this.stopRequestCountdown();
    this.requestCountdown = 45;
    this.requestTimerSubscription = interval(1000).subscribe(() => {
      this.requestCountdown--;
      if (this.requestCountdown <= 0) {
        this.handleIncomingTripTimeout();
      }
    });
  }

  private stopRequestCountdown(): void {
    this.requestTimerSubscription?.unsubscribe();
    this.requestTimerSubscription = undefined;
  }

  private handleIncomingTripTimeout(): void {
    if (!this.activeIncomingTrip) return;
    const expiredId = this.activeIncomingTrip.id;
    this.available = this.available.filter((t) => t.id !== expiredId);
    this.activeIncomingTrip = this.available[0] || null;
    if (this.activeIncomingTrip) {
      this.startRequestCountdown();
      this.ringtone.startRinging('incoming-trip-' + this.activeIncomingTrip.id, this.requestCountdown);
    } else {
      this.stopRequestCountdown();
      this.ringtone.stopRinging();
    }
  }

  getCircleDashOffset(countdown: number, totalSeconds = 45): number {
    const circumference = 263.89; // 2 * PI * 42
    const validTotal = totalSeconds > 0 ? totalSeconds : 45;
    const remaining = Math.max(0, Math.min(countdown, validTotal));
    const fillRatio = (validTotal - remaining) / validTotal;
    return circumference * (1 - fillRatio);
  }

  /* ─── Drag to Accept Slider Methods ─── */

  onDragStart(event: TouchEvent | PointerEvent, trackEl: HTMLElement): void {
    if (this.busy || this.negBusy) return;
    this.isDragging = true;
    this.draggedTrip = this.activeIncomingTrip;
    const clientX = 'touches' in event ? event.touches[0].clientX : event.clientX;
    this.dragStartX = clientX;
    const trackWidth = trackEl.getBoundingClientRect().width;
    const thumbWidth = 56;
    this.maxTrackWidth = Math.max(1, trackWidth - thumbWidth);
  }

  onDragMove(event: TouchEvent | PointerEvent): void {
    if (!this.isDragging || this.maxTrackWidth <= 0) return;
    const clientX = 'touches' in event ? event.touches[0].clientX : event.clientX;
    const deltaX = Math.max(0, Math.min(clientX - this.dragStartX, this.maxTrackWidth));
    this.thumbTranslateX = deltaX;
    this.dragProgress = Math.round((deltaX / this.maxTrackWidth) * 100);
  }

  onDragEnd(): void {
    if (!this.isDragging) return;
    this.isDragging = false;
    const targetTrip = this.draggedTrip || this.activeIncomingTrip;
    this.draggedTrip = null;
    if (this.dragProgress >= 80 && targetTrip) {
      this.thumbTranslateX = this.maxTrackWidth;
      this.dragProgress = 100;
      this.acceptIncomingTrip(targetTrip);
      setTimeout(() => {
        this.thumbTranslateX = 0;
        this.dragProgress = 0;
      }, 600);
    } else {
      this.thumbTranslateX = 0;
      this.dragProgress = 0;
    }
  }

  onDragCancel(): void {
    this.isDragging = false;
    this.draggedTrip = null;
    this.thumbTranslateX = 0;
    this.dragProgress = 0;
  }

  acceptIncomingTrip(trip: AvailableTrip): void {
    this.activeIncomingTrip = null;
    this.stopRequestCountdown();
    this.pickAvailable(trip, 'accept');
  }

  declineIncomingTrip(trip: AvailableTrip): void {
    this.ringtone.stopRinging();
    this.ringtone.playRejectChime();
    this.available = this.available.filter((t) => t.id !== trip.id);
    this.activeIncomingTrip = this.available[0] || null;
    if (this.activeIncomingTrip) {
      this.startRequestCountdown();
      this.ringtone.startRinging('incoming-trip-' + this.activeIncomingTrip.id, this.requestCountdown);
    } else {
      this.stopRequestCountdown();
    }
    this.api.post(`/trips/${trip.id}/driver-reject`, {}).subscribe({ error: () => {} });
  }

  openPriceFromModal(trip: AvailableTrip): void {
    this.stopRequestCountdown();
    this.activeIncomingTrip = null;
    this.pickAvailable(trip, 'price');
  }

}
