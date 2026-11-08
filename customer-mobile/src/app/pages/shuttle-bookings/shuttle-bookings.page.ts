import { Component, OnDestroy } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';

declare const Razorpay: any;

interface ShuttleBooking {
  id: number;
  shuttle_journey_id?: number | null;
  trip_id?: number | null;
  journey_status?: string | null;
  scope?: string | null;
  vehicle_name?: string | null;
  pickup?: { address?: string | null; lat?: number | null; lng?: number | null } | null;
  drop?: { address?: string | null; lat?: number | null; lng?: number | null } | null;
  fare_amount?: number | null;
  currency?: string | null;
  payment_method?: string | null;
  payment_status?: string | null;
  refund_status?: string | null;
  refund_reference?: string | null;
  refund_amount?: number | null;
  status: string;
  seat_labels?: string[] | null;
  boarding_mode?: string | null;
  boarding_code?: string | null;
  cancelled_reason?: string | null;
  shuttle_auto_outcome?: string | null;
  shuttle_auto_processed_at?: string | null;
  created_at?: string | null;
  upfront_amount?: number;
  cash_balance_due?: number;
}

@Component({
  selector: 'app-shuttle-bookings',
  templateUrl: './shuttle-bookings.page.html',
  styleUrls: ['./shuttle-bookings.page.scss'],
  standalone: false,
})
export class ShuttleBookingsPage implements OnDestroy {
  loading = false;
  error: string | null = null;
  bookings: ShuttleBooking[] = [];
  expandedId: number | null = null;
  payingId: number | null = null;
  private poll?: ReturnType<typeof setInterval>;
  private refreshing = false;

  constructor(
    private api: ApiService,
    private router: Router,
    private auth: AuthService,
    private route: ActivatedRoute,
  ) {}

  ionViewWillEnter(): void {
    const bookingId = Number(this.route.snapshot.queryParamMap.get('bookingId'));
    this.expandedId = bookingId > 0 ? bookingId : null;
    this.refresh();
    this.ionViewWillLeave();
    this.poll = setInterval(() => { if (!this.loading && !this.payingId) this.refresh(true); }, 5000);
  }

  ionViewWillLeave(): void { if (this.poll) clearInterval(this.poll); this.poll = undefined; }
  ngOnDestroy(): void { this.ionViewWillLeave(); }

  refresh(silent = false): void {
    if (this.refreshing) return;
    this.refreshing = true;
    this.loading = !silent;
    if (!silent) this.error = null;
    this.api.get<{ data: ShuttleBooking[] }>('/shuttle/bookings').subscribe({
      next: (res) => {
        this.bookings = res?.data || [];
        this.loading = false;
        this.refreshing = false;
      },
      error: (err) => {
        this.error = err?.error?.message || 'Could not load shuttle bookings.';
        if (!silent) this.bookings = [];
        this.loading = false;
        this.refreshing = false;
      },
    });
  }

  back(): void {
    this.router.navigateByUrl('/customer-tabs/go');
  }

  async pay(event: Event, booking: ShuttleBooking): Promise<void> {
    event.stopPropagation();
    if (this.payingId || booking.status !== 'PAYMENT_PENDING') return;
    this.payingId = booking.id;
    this.error = null;
    try {
      const res = await this.api.post<any>(`/shuttle/bookings/${booking.id}/razorpay-order`, {}).toPromise();
      if (res?.payment_required === false) {
        this.payingId = null;
        this.refresh(true);
        return;
      }
      if (typeof Razorpay === 'undefined') throw new Error('Payment library not loaded. Please try again.');
      const user = this.auth.getUser();
      const order = res.razorpay;
      const checkout = new Razorpay({
        key: order.key_id, order_id: order.order_id, amount: order.amount_paise, currency: order.currency,
        name: 'DreamCabs', description: booking.payment_method === 'cash' ? 'Cash booking deposit' : 'Shuttle booking',
        prefill: { name: user?.name || '', email: user?.email || '', contact: user?.phone || '' },
        handler: async (payment: any) => {
          try {
            await this.api.post(`/shuttle/bookings/${booking.id}/confirm-payment`, payment).toPromise();
          } catch (err: any) { this.error = err?.error?.message || 'Payment confirmation is pending. Refresh to check.'; }
          finally { this.payingId = null; this.refresh(true); }
        },
        modal: { ondismiss: () => { this.payingId = null; } },
      });
      checkout.on('payment.failed', () => { this.payingId = null; this.error = 'Payment failed. You can try again.'; });
      checkout.open();
    } catch (err: any) {
      this.payingId = null;
      this.error = err?.error?.message || err?.message || 'Could not start payment.';
    }
  }

  async cancel(event: Event, booking: ShuttleBooking): Promise<void> {
    event.stopPropagation();
    if (this.payingId) return;
    try { await this.api.post(`/shuttle/bookings/${booking.id}/cancel`, {}).toPromise(); this.refresh(true); }
    catch (err: any) { this.error = err?.error?.message || 'Could not cancel this request.'; }
  }

  toggle(booking: ShuttleBooking): void {
    this.expandedId = this.expandedId === booking.id ? null : booking.id;
  }

  openTrip(event: Event, booking: ShuttleBooking): void {
    event.stopPropagation();
    if (!booking.trip_id) return;
    this.router.navigateByUrl(`/customer-tabs/trip/${booking.trip_id}`);
  }

  title(booking: ShuttleBooking): string {
    return booking.vehicle_name || 'Shuttle ride';
  }

  routeLine(booking: ShuttleBooking): string {
    return `${booking.pickup?.address || 'Pickup'} -> ${booking.drop?.address || 'Drop'}`;
  }

  fareLine(booking: ShuttleBooking): string {
    if (booking.fare_amount == null) return '-';
    return `${booking.currency || 'INR'} ${Number(booking.fare_amount).toFixed(2)}`;
  }

  paymentLine(booking: ShuttleBooking): string {
    const method = booking.payment_method ? booking.payment_method.toUpperCase() : 'PAYMENT';
    return `${method} · ${booking.payment_status || 'UNKNOWN'}`;
  }

  refundLine(booking: ShuttleBooking): string {
    if (!booking.refund_status || booking.refund_status === 'NONE') return 'No refund';
    if (booking.refund_status === 'APPROVED') return 'Refund pending manual processing';
    if (booking.refund_status === 'REFUNDED') return 'Refunded';
    return `Refund ${booking.refund_status}`;
  }

  detailLine(booking: ShuttleBooking): string {
    if (booking.shuttle_auto_outcome === 'driver_missed_pickup') {
      return 'Driver missed pickup. Refund is pending manual Razorpay processing.';
    }
    if (booking.shuttle_auto_outcome === 'customer_no_show' || booking.status === 'NO_SHOW') {
      return 'Marked no-show. Refund is rejected for this booking.';
    }
    if (booking.status === 'CANCELLED') {
      return booking.refund_status === 'REFUNDED'
        ? 'This Shuttle booking was cancelled and refunded.'
        : 'This Shuttle booking was cancelled. Refund will be handled manually through Razorpay.';
    }
    if (booking.status === 'PENDING_DRIVER_APPROVAL') return 'Waiting for a driver to accept. No payment has been taken.';
    if (booking.status === 'PAYMENT_PENDING') return 'Driver accepted. Complete the required payment to confirm your seat.';
    if (booking.status === 'CONFIRMED') return booking.payment_method === 'cash' ? 'Booking confirmed. Pay the remaining cash to your driver at drop-off.' : 'Your Shuttle booking is confirmed.';
    if (booking.status === 'BOARDED') return 'You have boarded this Shuttle ride.';
    if (booking.status === 'DROPPED') return 'This Shuttle ride is complete.';
    return `Shuttle booking status is ${booking.status}.`;
  }

  statusClass(booking: ShuttleBooking): string {
    if (booking.status === 'CANCELLED' || booking.status === 'NO_SHOW') return 'status--danger';
    if (['PENDING_DRIVER_APPROVAL', 'PAYMENT_PENDING'].includes(booking.status)) return 'status--warning';
    if (booking.status === 'DROPPED') return 'status--success';
    return 'status--primary';
  }

  dateLine(booking: ShuttleBooking): string {
    return this.formatDate(booking.created_at);
  }

  formatDate(value?: string | null): string {
    if (!value) return '-';
    const date = new Date(value);
    return isNaN(date.getTime())
      ? value
      : date.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
}
