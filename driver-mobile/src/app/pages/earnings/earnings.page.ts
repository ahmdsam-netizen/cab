import { Component, OnInit } from '@angular/core';
import { ApiService } from '../../core/api.service';

export interface Bucket {
  date: string;       // YYYY-MM-DD
  amount: number;
  weekday: string;    // 'Mon', 'Tue', …
}

export interface RideRow {
  id: number;
  date: string | null;
  fare: number;
  payment_method: string | null;
  is_cash: boolean;
  cash_amount?: number;
  online_amount?: number;
  is_shared: boolean;
  pickup_address?: string | null;
  drop_address?: string | null;
}

export interface OperatorTransfer {
  id: number;
  amount: number;
  method: string | null;
  reference: string | null;
  notes: string | null;
  created_at: string | null;
}

export interface OperatorCollection {
  id: number;
  amount: number;
  source: string | null;
  trip_id: number | null;
  notes: string | null;
  created_at: string | null;
}

export interface EarningsResponse {
  ride_earnings: number;
  cash_collected: number;
  online_collected: number;
  total_collected?: number;
  money_collected_by_operator: number;
  pending_transfers: number;
  completed_transfers: number;
  operator_payments?: OperatorTransfer[];
  operator_transfers?: OperatorTransfer[];
  operator_collections?: OperatorCollection[];
  currency: string;
  period: 'week' | 'month' | 'all';
  buckets: Bucket[];
  weekly: Bucket[];
  rides: RideRow[];
}

export type EarningsTab = 'overview' | 'transfers' | 'received' | 'analytics';
type EarningsPeriod = 'today' | 'week' | 'month' | 'all';

/**
 * Driver Earnings & Payouts Page.
 *
 * Dedicated strictly to driver income:
 *  - Money Hero: Total Ride Earnings, Cash Collected, Total Collected & Operator Transfers
 *  - 3 Tabs:
 *      1. Transfers: Pending & Completed operator payout transfers
 *      2. Received: Operator collections received on behalf of the driver
 *      3. Analytics: Period filters, earnings chart, metrics & ride breakdown
 */
@Component({
  selector: 'app-earnings',
  templateUrl: './earnings.page.html',
  styleUrls: ['./earnings.page.scss'],
  standalone: false,
})
export class EarningsPage implements OnInit {
  loading = false;
  error: string | null = null;

  // Active navigation tab
  activeTab: EarningsTab = 'overview';
  private loadGeneration = 0;
  rideListLimited = false;

  // Money & stats
  rideEarnings = 0;
  cashCollected = 0;
  onlineCollected = 0;
  moneyCollectedByOperator = 0;
  pendingTransfers = 0;
  completedTransfers = 0;

  // Ledger records
  operatorTransfers: OperatorTransfer[] = [];
  operatorCollections: OperatorCollection[] = [];

  // Filter & period
  currency = 'INR';
  period: EarningsPeriod = 'today';

  periodLabelMap: Record<EarningsPeriod, string> = {
    today: 'today',
    week: 'this week',
    month: 'this month',
    all: 'all time',
  };

  periodRideTitleMap: Record<EarningsPeriod, string> = {
    today: "Today's Completed Rides",
    week: 'Weekly Completed Rides',
    month: 'Monthly Completed Rides',
    all: 'All Time Completed Rides',
  };

  periodChartTitleMap: Record<EarningsPeriod, string> = {
    today: "Today's Earnings",
    week: 'Weekly Earnings Overview',
    month: 'Monthly Earnings Overview',
    all: 'All Time Earnings Activity',
  };

  buckets: Bucket[] = [];
  rides: RideRow[] = [];

  constructor(private api: ApiService) {}

  ngOnInit(): void {
    this.load();
  }

  ionViewWillEnter(): void {
    this.load();
  }

  setTab(tab: EarningsTab): void {
    if (this.activeTab === tab) return;
    this.activeTab = tab;
  }

  setPeriod(p: EarningsPeriod): void {
    if (this.period === p) return;
    this.period = p;
    this.load();
  }

  load(): void {
    const generation = ++this.loadGeneration;
    const period = this.period;
    this.loading = true;
    this.error = null;

    this.api.get<EarningsResponse>(`/drivers/me/earnings?period=${period === 'today' ? 'week' : period}`).subscribe({
      next: (res) => {
        if (generation !== this.loadGeneration) return;
        this.loading = false;
        this.rideEarnings = res.ride_earnings ?? 0;
        this.cashCollected = res.cash_collected ?? 0;
        this.onlineCollected = res.online_collected ?? 0;
        this.moneyCollectedByOperator = res.money_collected_by_operator ?? 0;
        this.pendingTransfers = res.pending_transfers ?? 0;
        this.completedTransfers = res.completed_transfers ?? 0;
        this.operatorTransfers = res.operator_transfers || res.operator_payments || [];
        this.operatorCollections = res.operator_collections || [];
        this.currency = res.currency || 'INR';
        this.buckets = res.buckets || [];
        this.rides = res.rides || [];
        this.rideListLimited = this.rides.length >= 500;
        // Week API is a rolling seven days. Use its dated buckets for the
        // calendar week/today summary without requiring an API deployment.
        if (period === 'today' || period === 'week') {
          const start = new Date(); start.setHours(0, 0, 0, 0);
          if (period === 'week') start.setDate(start.getDate() - (start.getDay() + 6) % 7);
          const today = new Date();
          const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          this.buckets = this.buckets.filter(b => b.date >= key(start) && b.date <= key(today));
          this.rides = this.rides.filter(r => r.date && new Date(r.date) >= start && new Date(r.date) <= today);
          this.rideEarnings = this.buckets.reduce((total, b) => total + Number(b.amount || 0), 0);
        }
      },
      error: (err) => {
        if (generation !== this.loadGeneration) return;
        this.loading = false;
        this.error = err?.error?.message || 'Could not load driver earnings.';
      },
    });
  }

  // ── Computed Properties ──────────────────────────────────────────────────

  get totalCollected(): number {
    return this.cashCollected + this.onlineCollected;
  }

  get avgPerRide(): number {
    return this.rides.length > 0 ? this.rideEarnings / this.rides.length : 0;
  }

  get cashPercent(): number {
    if (this.totalCollected <= 0) return 0;
    return Math.round((this.cashCollected / this.totalCollected) * 100);
  }

  get onlinePercent(): number {
    if (this.totalCollected <= 0) return 0;
    return Math.round((this.onlineCollected / this.totalCollected) * 100);
  }

  get bestDay(): Bucket | null {
    if (!this.buckets.length) return null;
    let maxBucket: Bucket | null = null;
    for (const b of this.buckets) {
      if (!maxBucket || b.amount > maxBucket.amount) {
        maxBucket = b;
      }
    }
    return maxBucket && maxBucket.amount > 0 ? maxBucket : null;
  }

  // ── Chart Helpers ────────────────────────────────────────────────────────

  maxBucketAmount(): number {
    return Math.max(1, ...this.buckets.map((b) => b.amount));
  }

  barHeight(amount: number): number {
    const max = this.maxBucketAmount();
    if (max <= 0 || amount <= 0) return 4;
    return Math.max(4, Math.round((amount / max) * 100));
  }

  showLabel(idx: number): boolean {
    if (this.period === 'today' || this.period === 'week') return true;
    return idx % 5 === 0;
  }

  shortLabel(b: Bucket): string {
    if (!b.date) return '';
    const parts = b.date.split('-');
    return parts.length >= 3 ? `${parts[2]}/${parts[1]}` : b.date;
  }

  // ── Formatters & Icon Resolvers ──────────────────────────────────────────

  fmtDate(dt: string | null): string {
    if (!dt) return '—';
    try {
      const d = new Date(dt);
      return d.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return dt;
    }
  }

  fmtDayOnly(dt: string | null): string {
    if (!dt) return '—';
    try {
      const d = new Date(dt);
      return d.toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return dt;
    }
  }

  methodLabel(m: string | null): string {
    if (!m) return 'Direct Bank/UPI Transfer';
    const map: Record<string, string> = {
      gpay: 'Google Pay',
      bank: 'Bank Transfer (NEFT/IMPS)',
      cash: 'Cash Handover',
      upi: 'UPI Payout',
      razorpay: 'Razorpay Payout',
    };
    return map[m.toLowerCase()] || m;
  }

  methodIcon(m: string | null): string {
    if (!m) return 'swap-horizontal-outline';
    const lower = m.toLowerCase();
    if (lower.includes('bank')) return 'business-outline';
    if (lower.includes('upi') || lower.includes('gpay')) return 'phone-portrait-outline';
    if (lower.includes('cash')) return 'cash-outline';
    return 'card-outline';
  }

  collectionSourceLabel(source: string | null): string {
    if (!source) return 'Online Fare Collection';
    const map: Record<string, string> = {
      online_fare: 'Online Trip Fare',
      online_deposit: 'Advance Booking Deposit',
      fixed_booking: 'Fixed Route Booking',
      shuttle_booking: 'Shuttle Seat Booking',
      coupon_reimbursement: 'Operator Coupon Reimbursement',
      tip: 'Rider Online Tip',
      adjustment: 'Operator Credit Adjustment',
    };
    return map[source] || source.replace(/_/g, ' ');
  }

  collectionSourceIcon(source: string | null): string {
    if (!source) return 'wallet-outline';
    const map: Record<string, string> = {
      online_fare: 'car-outline',
      online_deposit: 'shield-checkmark-outline',
      fixed_booking: 'navigate-circle-outline',
      shuttle_booking: 'bus-outline',
      coupon_reimbursement: 'ticket-outline',
      tip: 'heart-circle-outline',
      adjustment: 'sparkles-outline',
    };
    return map[source] || 'wallet-outline';
  }
}
