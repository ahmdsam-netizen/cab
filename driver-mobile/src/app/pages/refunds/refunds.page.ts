import { Component, OnInit } from '@angular/core';
import { ApiService } from '../../core/api.service';

/** One refund on this driver's trips, shaped by GET /driver/refunds. */
export interface DriverRefundRow {
  key: string;
  module: 'fixed' | 'shuttle';
  id: number;
  customer_name: string | null;
  trip_label: string;
  travel_date: string | null;
  reason: string;
  amount: number;
  state: 'due' | 'refunded' | 'rejected' | 'none';
  refund_method_label: string | null;
  refunded_at: string | null;
  owed_since: string | null;
}

type StatusFilter = 'all' | 'due' | 'refunded';
type RangeFilter = 'all' | 'today' | 'week' | 'month';

/**
 * "Trip refunds" — informational view for the driver: which passengers on
 * their fixed/shuttle trips were (or will be) refunded and why. Refunds are
 * paid by Cabbies from company money, never from the driver.
 *
 * UI mirrors the Trip history page exactly: navy rounded header + a bottom-sheet
 * Filter modal (WHEN / STATUS pills).
 */
@Component({
  selector: 'app-driver-refunds',
  templateUrl: './refunds.page.html',
  styleUrls: ['./refunds.page.scss'],
  standalone: false,
})
export class RefundsPage implements OnInit {
  rows: DriverRefundRow[] = [];
  loading = true;
  error: string | null = null;

  status: StatusFilter = 'all';
  range: RangeFilter = 'all';
  filterOpen = false;

  constructor(private api: ApiService) {}

  ngOnInit(): void {
    this.load();
  }

  load(event?: any): void {
    this.loading = !event;
    this.error = null;
    this.api.get<{ data: DriverRefundRow[] }>('/driver/refunds').subscribe({
      next: (res) => {
        this.rows = res?.data ?? [];
        this.loading = false;
        event?.target?.complete();
      },
      error: () => {
        this.error = 'Could not load trip refunds. Pull to retry.';
        this.loading = false;
        event?.target?.complete();
      },
    });
  }

  refresh(): void {
    this.load();
  }

  // ── Filter bottom sheet ─────────────────────────────────────────
  openFilters(): void { this.filterOpen = true; }
  closeFilters(): void { this.filterOpen = false; }

  get activeFilterCount(): number {
    let n = 0;
    if (this.range !== 'all') n++;
    if (this.status !== 'all') n++;
    return n;
  }

  resetFilters(): void {
    this.range = 'all';
    this.status = 'all';
  }

  setStatus(s: StatusFilter): void { this.status = s; }
  setRange(r: RangeFilter): void { this.range = r; }

  get filteredRows(): DriverRefundRow[] {
    const min = this.rangeStart();
    return this.rows.filter((r) => {
      if (this.status !== 'all' && r.state !== this.status) return false;
      if (this.range !== 'all') {
        const d = this.rowDate(r);
        if (!d) return false;
        if (this.range === 'today') {
          const now = new Date();
          const dd = new Date(d);
          if (dd.getFullYear() !== now.getFullYear() || dd.getMonth() !== now.getMonth() || dd.getDate() !== now.getDate()) return false;
        } else if (min && d < min) {
          return false;
        }
      }
      return true;
    });
  }

  private rowDate(r: DriverRefundRow): number | null {
    const iso = r.state === 'refunded' ? (r.refunded_at || r.owed_since) : r.owed_since;
    const t = iso ? new Date(iso).getTime() : NaN;
    return isNaN(t) ? null : t;
  }

  private rangeStart(): number | null {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    if (this.range === 'week') return now - 7 * day;
    if (this.range === 'month') return now - 30 * day;
    return null;
  }

  metaDate(r: DriverRefundRow): string | null {
    return r.state === 'refunded' ? (r.refunded_at || r.owed_since) : (r.owed_since || r.travel_date);
  }

  statusLabel(r: DriverRefundRow): string {
    if (r.state === 'due') return 'Pending';
    if (r.state === 'refunded') return 'Refunded';
    return 'No refund';
  }

  badgeClass(r: DriverRefundRow): string {
    if (r.state === 'due') return 'dc-badge--warn';
    if (r.state === 'refunded') return 'dc-badge--ok';
    return 'dc-badge--muted';
  }
}
