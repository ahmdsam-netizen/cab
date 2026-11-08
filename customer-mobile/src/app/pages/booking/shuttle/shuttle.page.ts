import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { ToastController } from '@ionic/angular';

import { ApiService } from '../../../core/api.service';
import { AuthService } from '../../../core/auth.service';
import { PaymentOptionsService } from '../../../core/payment-options.service';
import { PaymentChoice } from '../../../shared/payment-method-modal.component';
import { BookingService, resolveCity } from '../booking.service';
import { Place } from '../booking.models';
import { SeatCell } from '../fixed/seat-grid.component';

declare const Razorpay: any;

interface Estimate {
  estimated_fare?: number;
  city_vehicle_type_id?: number;
  vehicle_name?: string;
  available?: boolean;
  message?: string;
}
interface ShuttleBooking { id: number; trip_id?: number | null; seat_labels?: string[]; }
interface SeatMap { layout: { rows: number; cols: number }; cells: SeatCell[]; }
interface CouponPreview { base_amount: number; discount: number; final_amount: number; coupon?: { title: string } | null; }

type Step = 'pickup' | 'drop' | 'fare' | 'seats' | 'paying' | 'forming';

interface TippingConfig {
  enabled: boolean;
  values: number[];
  in_percentage: boolean;
}

/**
 * "Pool ride" — the Shuttle flow on the shared shell.
 *
 * Pickup → drop → fare → pay → wait for the pool to form. A pool is paid before
 * a car is found, so the money moves at the "pay" step and the ride sits
 * FORMING until a driver is assigned.
 *
 * The create + Razorpay + confirm path is ported from the existing customer
 * shuttle booking — same endpoints, same money handling; only the surface is
 * the new shell.
 */
@Component({
  selector: 'app-shuttle-book',
  templateUrl: './shuttle.page.html',
  styleUrls: ['./shuttle.page.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ShuttleBookPage implements OnInit {
  step: Step = 'pickup';
  readonly total = 5;

  estimate: Estimate | null = null;
  estimating = false;
  booking: ShuttleBooking | null = null;

  // Seat selection (step 4)
  seatCells: SeatCell[] = [];
  seatRows = 1;
  seatCols = 1;
  selectedSeats: string[] = [];
  seatBusy = false;
  seatError: string | null = null;

  busy = false;
  error: string | null = null;

  tipping: TippingConfig | null = null;
  selectedTipPreset: number | null = null;

  // Coupon (operator-funded): the discount comes off what the rider pays; the
  // driver still earns on the full fare (handled server-side at settlement).
  couponTitle = '';
  coupon: CouponPreview | null = null;
  couponError: string | null = null;
  couponBusy = false;

  // Payment method chooser (Online / UPI / Cash). Cash pays only the upfront
  // deposit online; the rest is cash to the driver at trip end.
  paymentModalOpen = false;
  payMethod: PaymentChoice = 'online';
  cashDepositPercent = 0;

  constructor(
    private api: ApiService,
    private auth: AuthService,
    private bookingSvc: BookingService,
    private router: Router,
    private toastCtrl: ToastController,
    private cdr: ChangeDetectorRef,
    private paymentOptions: PaymentOptionsService,
  ) {}

  async ngOnInit(): Promise<void> {
    if (!this.bookingSvc.trip.cityId) {
      try {
        const cities = await this.bookingSvc.cities();
        if (this.bookingSvc.trip.pickup) {
          const match = resolveCity(cities, this.bookingSvc.trip.pickup.lat, this.bookingSvc.trip.pickup.lng);
          if (match?.id) this.bookingSvc.setCity(match.id);
        }
        if (!this.bookingSvc.trip.cityId && cities.length) {
          this.bookingSvc.setCity(cities[0].id);
        }
      } catch {
        /* ignore */
      }
    }
    if (!this.bookingSvc.trip.cityId) {
      void this.router.navigate(['/customer-tabs/go']);
      return;
    }
    if (!this.bookingSvc.trip.rideTypeId) {
      this.bookingSvc.setMode('shuttle', 3);
    }
    if (this.bookingSvc.trip.pickup) this.step = 'drop';
    this.loadTippingConfig();
    // Know the operator's cash deposit split so the pay step can show it.
    void this.paymentOptions.load().then((m) => {
      this.cashDepositPercent = m.cash_deposit_percent || 0;
      this.cdr.markForCheck();
    });
  }

  private loadTippingConfig(): void {
    this.api.get<TippingConfig>('/operator/tipping').subscribe({
      next: (cfg) => { this.tipping = cfg.enabled ? cfg : null; this.cdr.markForCheck(); },
      error: () => { this.tipping = null; this.cdr.markForCheck(); },
    });
  }

  get fromLabel(): string { return this.bookingSvc.trip.pickup?.address ?? ''; }
  get toLabel(): string { return this.bookingSvc.trip.drop?.address ?? ''; }
  get stepIndex(): number { return { pickup: 1, drop: 2, fare: 3, seats: 4, paying: 5, forming: 5 }[this.step]; }
  get near(): { lat: number; lng: number } | undefined {
    const p = this.bookingSvc.trip.pickup;
    return p ? { lat: p.lat, lng: p.lng } : undefined;
  }

  // ---- steps 1 & 2 ------------------------------------------------------

  onPickup(place: Place): void {
    this.bookingSvc.setPickup(place);
    this.step = 'drop';
    this.cdr.markForCheck();
  }

  onDrop(place: Place): void {
    this.bookingSvc.setDrop(place);
    this.step = 'fare';
    void this.loadEstimate();
    this.cdr.markForCheck();
  }

  // ---- step 3: fare -----------------------------------------------------

  private async loadEstimate(): Promise<void> {
    let { pickup, drop, cityId, rideTypeId } = this.bookingSvc.trip;
    if (!pickup || !drop) return;

    if (!cityId) {
      const cities = await this.bookingSvc.cities().catch(() => []);
      const match = resolveCity(cities, pickup.lat, pickup.lng);
      if (match?.id) {
        cityId = match.id;
        this.bookingSvc.setCity(cityId);
      }
    }
    if (!cityId) return;

    this.estimating = true;
    this.error = null;
    // The fare is being recomputed — any applied coupon no longer matches it.
    this.coupon = null;
    this.couponError = null;
    this.cdr.markForCheck();

    try {
      const res = await this.api
        .post<Estimate>('/pricing/estimate', {
          city_id: cityId,
          vehicle_type_id: null,
          ride_type_id: rideTypeId || 3,
          pickup_lat: pickup.lat,
          pickup_lng: pickup.lng,
          drop_lat: drop.lat,
          drop_lng: drop.lng,
        })
        .toPromise();
      this.estimate = res ?? null;
      if (this.estimate?.available === false) {
        this.error = this.estimate.message || 'Pool isn\'t available for this trip yet.';
      }
    } catch (e: any) {
      this.estimate = null;
      this.error = e?.error?.message || 'We couldn\'t price this pool. Try again.';
    } finally {
      this.estimating = false;
      this.cdr.markForCheck();
    }
  }

  get fare(): number | null {
    return this.estimate?.estimated_fare ?? null;
  }

  get tipAmount(): number {
    if (!this.tipping || this.selectedTipPreset == null) return 0;
    if (this.tipping.in_percentage) {
      const base = this.fare || 0;
      return Math.max(1, Math.round((base * this.selectedTipPreset) / 100));
    }
    return this.selectedTipPreset;
  }

  get couponDiscount(): number {
    return this.coupon?.discount ?? 0;
  }

  get payableTotal(): number {
    return Math.max(0, (this.fare || 0) - this.couponDiscount) + this.tipAmount;
  }

  applyCoupon(): void {
    const code = this.couponTitle.trim();
    if (!code || this.couponBusy) return;
    const { pickup, drop, cityId } = this.bookingSvc.trip;
    if (!pickup || !drop || !cityId) { this.couponError = 'Add a pickup and drop first.'; this.cdr.markForCheck(); return; }

    this.couponBusy = true;
    this.couponError = null;
    this.cdr.markForCheck();

    this.api.post<CouponPreview>('/shuttle/coupon-preview', {
      city_vehicle_type_id: this.estimate?.city_vehicle_type_id ?? null,
      city_id: cityId,
      vehicle_type_id: null,
      pickup_lat: pickup.lat,
      pickup_lng: pickup.lng,
      drop_lat: drop.lat,
      drop_lng: drop.lng,
      coupon_title: code,
    }).subscribe({
      next: (res) => { this.coupon = res; this.couponBusy = false; this.cdr.markForCheck(); },
      error: (err) => { this.coupon = null; this.couponBusy = false; this.couponError = err?.error?.message || 'Coupon could not be applied.'; this.cdr.markForCheck(); },
    });
  }

  removeCoupon(): void {
    this.couponTitle = '';
    this.coupon = null;
    this.couponError = null;
    this.cdr.markForCheck();
  }

  pickTipPreset(val: number): void {
    this.selectedTipPreset = this.selectedTipPreset === val ? null : val;
    this.cdr.markForCheck();
  }

  tipPresetLabel(val: number): string {
    return this.tipping?.in_percentage ? `${val}%` : `₹${val}`;
  }

  get canConfirm(): boolean {
    return !!this.fare && this.estimate?.available !== false;
  }

  // ---- step 4: pick a seat ---------------------------------------------

  /**
   * Confirm the pool → create the pending booking (with the tip baked in) so it
   * has a journey to show a seat map for, then open the seat picker. The booking
   * sits PAYMENT_PENDING until the rider pays; backing out cancels it.
   */
  /** Fare-step CTA. A pool is prepaid, so pick how to pay before we create the
   *  booking — the booking is tagged with the method (cash charges only the
   *  upfront deposit online). If a pending booking already exists, reopen seats. */
  choosePayment(): void {
    if (!this.canConfirm || this.busy) return;
    if (this.booking?.id) { void this.confirm(this.payMethod); return; }
    this.paymentModalOpen = true;
    this.cdr.markForCheck();
  }

  /** Chosen from the shared payment sheet. */
  onPayMethod(method: PaymentChoice): void {
    this.paymentModalOpen = false;
    this.payMethod = method;
    void this.confirm(method);
  }

  async confirm(method: PaymentChoice = this.payMethod): Promise<void> {
    if (!this.canConfirm || this.busy) return;
    const { pickup, drop, cityId, scope } = this.bookingSvc.trip;
    if (!pickup || !drop || !cityId) { this.error = 'Missing trip details.'; return; }

    this.busy = true;
    this.error = null;
    this.cdr.markForCheck();

    try {
      if (!this.booking?.id) {
        const res = await this.api.post<{ booking?: ShuttleBooking }>('/shuttle/bookings', {
          city_vehicle_type_id: this.estimate?.city_vehicle_type_id ?? null,
          city_id: cityId,
          vehicle_type_id: null,
          scope,
          pickup_address: pickup.address,
          pickup_lat: pickup.lat,
          pickup_lng: pickup.lng,
          drop_address: drop.address,
          drop_lat: drop.lat,
          drop_lng: drop.lng,
          tip_amount: this.tipAmount,
          coupon_title: this.couponTitle.trim() || undefined,
          payment_method: method === 'cash' ? 'cash' : 'razorpay',
        }, { 'Idempotency-Key': this.uuid('shuttle') }).toPromise();
        const b = res?.booking ?? null;
        if (!b?.id) throw new Error('Booking failed.');
        this.booking = b;
      }
      await this.loadSeatMap();
      this.step = 'seats';
    } catch (err: any) {
      this.error = err?.error?.message || 'Could not open seat selection.';
    } finally {
      this.busy = false;
      this.cdr.markForCheck();
    }
  }

  /** For a cash pool: the upfront deposit charged online now (rest is cash). */
  get cashDeposit(): number {
    if (this.payMethod !== 'cash' || this.cashDepositPercent <= 0) return 0;
    return Math.round(this.payableTotal * this.cashDepositPercent / 100);
  }
  get cashBalance(): number {
    return Math.max(0, this.payableTotal - this.cashDeposit);
  }
  /** What the rider actually pays online at the pay step. */
  get payNowAmount(): number {
    return this.payMethod === 'cash' ? this.cashDeposit : this.payableTotal;
  }

  private async loadSeatMap(): Promise<void> {
    if (!this.booking?.id) return;
    const res = await this.api
      .get<{ seat_map: SeatMap }>(`/shuttle/bookings/${this.booking.id}/seats`)
      .toPromise();
    const map = res?.seat_map;
    this.seatRows = map?.layout?.rows ?? 1;
    this.seatCols = map?.layout?.cols ?? 1;
    this.seatCells = map?.cells ?? [];
  }

  /** Tapping a free seat picks it (one seat per rider) and holds it server-side. */
  onSeatPick(label: string): void {
    if (this.seatBusy) return;
    this.selectedSeats = this.selectedSeats.includes(label) ? [] : [label];
    if (this.selectedSeats.length === 0) { this.cdr.markForCheck(); return; }
    this.holdSeats();
  }

  private holdSeats(): void {
    if (!this.booking?.id || this.selectedSeats.length === 0) { this.cdr.markForCheck(); return; }
    this.seatBusy = true;
    this.seatError = null;
    this.cdr.markForCheck();

    this.api.post<{ seat_map?: SeatMap }>(
      `/shuttle/bookings/${this.booking.id}/seats`,
      { labels: this.selectedSeats },
    ).subscribe({
      next: (res) => {
        this.seatBusy = false;
        if (res?.seat_map?.cells) this.seatCells = res.seat_map.cells;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.seatBusy = false;
        this.selectedSeats = [];
        this.seatError = err?.error?.message || 'That seat was just taken. Pick another.';
        void this.loadSeatMap().finally(() => this.cdr.markForCheck());
      },
    });
  }

  get canPayForSeat(): boolean {
    return this.selectedSeats.length > 0 && !this.seatBusy;
  }

  continueToPay(): void {
    if (!this.canPayForSeat) { this.seatError = 'Pick a seat to continue.'; this.cdr.markForCheck(); return; }
    void this.router.navigateByUrl('/customer-tabs/shuttle-rides');
  }

  // ---- step 5: pay ------------------------------------------------------

  pay(): void {
    if (this.busy) return;
    if (!this.booking?.id) { this.error = 'Missing booking. Please start again.'; this.cdr.markForCheck(); return; }

    this.busy = true;
    this.error = null;
    this.cdr.markForCheck();

    void this.startRazorpay(this.booking);
  }

  private async startRazorpay(booking: ShuttleBooking): Promise<void> {
    if (typeof Razorpay === 'undefined') {
      this.busy = false;
      await this.toast('Payment library not loaded. Check your connection.', 'danger');
      this.cdr.markForCheck();
      return;
    }

    let order: { razorpay: { key_id: string; order_id: string; amount_paise: number; currency: string } };
    try {
      order = (await this.api
        .post<any>(`/shuttle/bookings/${booking.id}/razorpay-order`, {}, { 'Idempotency-Key': this.uuid('shuttle-pay') })
        .toPromise());
    } catch (err: any) {
      this.busy = false;
      await this.toast(err?.error?.message || 'Could not start payment.', 'danger');
      this.cdr.markForCheck();
      return;
    }

    const user = this.auth.getUser();
    const rzp = new Razorpay({
      key: order.razorpay.key_id,
      order_id: order.razorpay.order_id,
      amount: order.razorpay.amount_paise,
      currency: order.razorpay.currency,
      name: 'DreamCabs',
      description: `Shuttle booking ${booking.id}`,
      prefill: {
        name: user?.name || '',
        email: user?.email || '',
        contact: user?.phone || '',
        ...(this.payMethod === 'gpay' ? { method: 'upi' } : {}),
      },
      ...(this.payMethod === 'gpay'
        ? {
            method: {
              upi: true,
              card: false,
              netbanking: false,
              wallet: false,
              emi: false,
              paylater: false,
            },
            upi: {
              flow: 'intent',
            },
            config: {
              display: {
                blocks: {
                  upi: {
                    name: 'Pay via Google Pay / UPI',
                    instruments: [
                      {
                        method: 'upi',
                        flows: ['intent'],
                        apps: ['google_pay', 'phonepe', 'paytm', 'bhim'],
                      },
                    ],
                  },
                },
                sequence: ['block.upi'],
                preferences: { show_default_blocks: false },
              },
            },
          }
        : {}),
      theme: { color: '#12B35B' },
      handler: (resp: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) =>
        this.confirmPayment(booking, resp),
      modal: {
        ondismiss: async () => {
          this.busy = false;
          await this.toast('Payment cancelled. Your pool booking is pending payment.', 'danger');
          this.cdr.markForCheck();
        },
      },
    });
    rzp.on('payment.failed', async (resp: any) => {
      this.busy = false;
      await this.toast(resp?.error?.description || 'Payment failed.', 'danger');
      this.cdr.markForCheck();
    });
    rzp.open();
  }

  private confirmPayment(
    booking: ShuttleBooking,
    payment: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string },
  ): void {
    this.api.post<{ booking?: ShuttleBooking; message?: string }>(
      `/shuttle/bookings/${booking.id}/confirm-payment`,
      payment,
      { 'Idempotency-Key': this.uuid('shuttle-confirm') },
    ).subscribe({
      next: (res) => {
        this.busy = false;
        const tripId = res?.booking?.trip_id;
        this.bookingSvc.reset();
        if (tripId) {
          void this.router.navigateByUrl(`/customer-tabs/trip/${tripId}`, { replaceUrl: true });
        } else {
          // No car yet — the pool is forming.
          this.step = 'forming';
        }
        this.cdr.markForCheck();
      },
      error: (err) => { this.busy = false; this.error = err?.error?.message || 'Payment verification failed.'; this.cdr.markForCheck(); },
    });
  }

  // ---- forming ----------------------------------------------------------

  viewPools(): void {
    this.bookingSvc.reset();
    void this.router.navigate(['/customer-tabs/shuttle-rides']);
  }

  // ---- nav --------------------------------------------------------------

  back(): void {
    this.error = null;
    switch (this.step) {
      case 'drop': this.step = 'pickup'; break;
      case 'fare': this.step = 'drop'; break;
      case 'seats':
        // Leaving seat selection abandons the pending booking + its held seat;
        // a fresh one is made if the rider confirms again.
        this.cancelPendingBooking();
        this.step = 'fare';
        break;
      case 'paying': this.step = 'seats'; break;
      default: void this.router.navigate(['/customer-tabs/go']);
    }
    this.cdr.markForCheck();
  }

  /** Cancel the current PAYMENT_PENDING booking and clear the seat state. */
  private cancelPendingBooking(): void {
    const b = this.booking;
    this.booking = null;
    this.selectedSeats = [];
    this.seatCells = [];
    this.seatError = null;
    if (b?.id) {
      this.api.post(`/shuttle/bookings/${b.id}/cancel`, {}).subscribe({ next: () => {}, error: () => {} });
    }
  }

  private uuid(prefix: string): string {
    try { return `${prefix}-${(crypto as any).randomUUID()}`; }
    catch { return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`; }
  }

  private async toast(message: string, color: 'success' | 'danger'): Promise<void> {
    const t = await this.toastCtrl.create({ message, duration: 2600, color });
    await t.present();
  }
}
