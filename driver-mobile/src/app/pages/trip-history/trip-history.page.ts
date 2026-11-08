import { Component } from '@angular/core';
import { finalize } from 'rxjs/operators';
import { ApiService } from '../../core/api.service';

type StatusFilter = 'all' | 'completed' | 'cancelled' | 'missed';
type PaymentFilter = 'all' | 'paid' | 'unpaid';

interface TripPayment {
  id: number;
  method?: string | null;
  status?: 'PENDING' | 'SUCCESS' | 'FAILED' | string | null;
  amount?: number | null;
  discount_amount?: number | null;
  paid_at?: string | null;
}

interface TripRow {
  image_url?: string | null;
  vehicle_name?: string | null;
  id: number;
  status: string;
  pickup_address?: string | null;
  drop_address?: string | null;
  pickup_lat?: number | null;
  pickup_lng?: number | null;
  drop_lat?: number | null;
  drop_lng?: number | null;
  estimated_fare?: number | null;
  final_fare?: number | null;
  currency?: string | null;
  completed_at?: string | null;
  cancelled_at?: string | null;
  created_at?: string | null;
  cancelled_reason?: string | null;
  no_show_by?: string | null;
  payment?: TripPayment | null;
}

@Component({
  selector: 'app-trip-history',
  templateUrl: './trip-history.page.html',
  styleUrls: ['./trip-history.page.scss'],
  standalone: false,
})
export class TripHistoryPage {
  loading = false;
  error: string | null = null;
  trips: TripRow[] = [];

  status: StatusFilter = 'all';
  payment: PaymentFilter = 'all';

  // Client-side date filter (does not hit the server).
  range: 'all' | 'today' | 'week' | 'month' = 'all';

  // Filter bottom-sheet state.
  filterOpen = false;

  constructor(private api: ApiService) {}
  openFilters(): void {
    this.filterOpen = true;
  }

  closeFilters(): void {
    this.filterOpen = false;
  }

  /** How many filters are away from their default 'all' value. */
  get activeFilterCount(): number {
    let count = 0;
    if (this.range !== 'all') count++;
    if (this.status !== 'all') count++;
    if (this.payment !== 'all') count++;
    return count;
  }

  resetFilters(): void {
    this.range = 'all';
    this.status = 'all';
    this.payment = 'all';
    this.refresh();
  }

  ionViewWillEnter(): void {
    this.refresh();
  }

  refresh(): void {
this.loading = true;
    this.error = null;
    const params = new URLSearchParams({
      status: this.status,
      payment: this.payment,
    }).toString();
    this.api.get<{ data: { data?: TripRow[] } }>(`/driver/trips/history?${params}`).pipe(finalize(() => this.loading = false)).subscribe({
      next: (res) => {
        const page = res.data;
        this.trips = page?.data ?? [];
      },
      error: (err) => {
        this.error = err?.error?.message || 'Could not load history';
        this.trips = [];
      },
      complete: () => {
        this.loading = false;
      },
    });
  }

  setStatus(s: StatusFilter): void {
    if (this.status === s) return;
    this.status = s;
    this.refresh();
  }

  setPayment(p: PaymentFilter): void {
    if (this.payment === p) return;
    this.payment = p;
    this.refresh();
  }

  setRange(r: 'all' | 'today' | 'week' | 'month'): void {
    this.range = r;
  }

  /**
   * Client-side date filter applied on top of the server-side status/payment
   * filters. Trips with no date fall outside today/week/month buckets.
   */
  get filteredTrips(): TripRow[] {
    const trips = [...this.trips].sort((a, b) => {
      const aDate = Date.parse(this.dateDisplay(a) || '') || 0;
      const bDate = Date.parse(this.dateDisplay(b) || '') || 0;
      return bDate - aDate || b.id - a.id;
    });
    if (this.range === 'all') return trips;

    const now = new Date();

    return trips.filter((t) => {
      const raw = this.dateDisplay(t);
      if (!raw) return false;

      const d = new Date(raw);
      if (isNaN(d.getTime())) return false;

      if (this.range === 'today') {
        return (
          d.getFullYear() === now.getFullYear() &&
          d.getMonth() === now.getMonth() &&
          d.getDate() === now.getDate()
        );
      }

      const days = (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
      if (this.range === 'week') {
        const start = new Date(now);
        start.setHours(0, 0, 0, 0);
        start.setDate(start.getDate() - (start.getDay() + 6) % 7);
        return d >= start && d <= now;
      }
      if (this.range === 'month') return days >= 0 && days <= 30;
      return true;
    });
  }

  /** Maps the Ionic color name from statusColor() to a dc-badge variant. */
  statusBadgeClass(t: TripRow): string {
    const color = this.statusColor(t);
    return this.badgeClassForColor(color);
  }

  /** Maps the Ionic color name from paymentBadge() to a dc-badge variant. */
  paymentBadgeClass(color: string): string {
    return this.badgeClassForColor(color);
  }

  private badgeClassForColor(color: string): string {
    switch (color) {
      case 'success':
        return 'dc-badge--ok';
      case 'warning':
        return 'dc-badge--warn';
      case 'danger':
        return 'dc-badge--bad';
      default:
        return 'dc-badge--muted';
    }
  }

  statusLabel(t: TripRow): string {
    if (t.status === 'COMPLETED') return 'Completed';
    if (t.status === 'CANCELLED') {
      return t.no_show_by ? 'Missed' : 'Cancelled';
    }
    return t.status;
  }

  statusColor(t: TripRow): string {
    if (t.status === 'COMPLETED') return 'success';
    if (t.status === 'CANCELLED') return t.no_show_by ? 'warning' : 'medium';
    return 'primary';
  }

  /**
   * Payment badge on each row. For the driver, "Unpaid" on a completed trip
   * means the customer hasn't settled yet — useful when chasing cash rides.
   */
  paymentBadge(t: TripRow): { label: string; color: string } | null {
    if (t.payment?.status === 'SUCCESS') {
      return { label: 'Paid', color: 'success' };
    }
    if (t.status === 'COMPLETED') {
      return { label: 'Unpaid', color: 'danger' };
    }
    return null;
  }

  fareDisplay(t: TripRow): string | null {
    const amount = t.final_fare ?? t.estimated_fare;
    if (amount == null) return null;
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: t.currency || 'INR', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(amount);
  }

  get completedFaresShown(): number {
    return this.filteredTrips.filter(t => t.status === 'COMPLETED' && (!t.currency || t.currency === 'INR'))
      .reduce((sum, t) => sum + Number(t.final_fare ?? t.estimated_fare ?? 0), 0);
  }

  get completedRidesShown(): number {
    return this.filteredTrips.filter(t => t.status === 'COMPLETED').length;
  }

  dateDisplay(t: TripRow): string | null {
    return t.completed_at || t.cancelled_at || t.created_at || null;
  }
}
