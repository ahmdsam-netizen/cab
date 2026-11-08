import { Component, OnInit } from '@angular/core';
import { AlertController, ModalController, ToastController } from '@ionic/angular';
import { ApiService } from '../../core/api.service';
import { SubscriptionCheckoutModalComponent } from './subscription-checkout.modal';

interface Plan {
  id: number;
  title: string;
  subtitle: string | null;
  amount: number;
  commission_percent: number;
  pricing_model?: 'subscription' | 'commission' | 'hybrid';
  meter_type: 'rides' | 'days' | 'daily' | 'earnings';
  rides_count: number | null;
  days_count: number | null;
  earnings_threshold: number | null;
  vehicle_type_name: string | null;
  terms: string | null;
}

interface ActiveSubscription {
  id: number;
  title: string;
  subtitle: string | null;
  status: string;
  meter_type: Plan['meter_type'];
  commission_percent: number;
  pricing_model?: 'subscription' | 'commission' | 'hybrid';
  amount_paid: number;
  rides_allowed: number | null;
  rides_used: number;
  rides_remaining: number | null;
  earnings_cap: number | null;
  earnings_accrued: number;
  earnings_remaining: number | null;
  vehicle_type_name: string | null;
  starts_at: string | null;
  expires_at: string | null;
  auto_renew: boolean;
  cancelled_at: string | null;
  next_plan?: {
    title: string;
    amount: number;
  } | null;
}

/**
 * Subscriptions — the driver buys a plan to keep (usually) 100% of their fares
 * for a while instead of paying commission per ride. Shows their current active
 * plan with remaining allowance, plus the plans they can buy.
 */
@Component({
  selector: 'app-subscriptions',
  templateUrl: './subscriptions.page.html',
  styleUrls: ['./subscriptions.page.scss'],
  standalone: false,
})
export class SubscriptionsPage implements OnInit {
  loading = false;
  buyingId: number | null = null;
  error: string | null = null;

  current: ActiveSubscription | null = null;
  plans: Plan[] = [];
  wallet = 0;
  minWalletLimit = 0;
  currency = 'INR';

  /** Which tab is showing. */
  tab: 'current' | 'all' = 'current';
  /** Once the driver taps a tab we stop auto-choosing one for them. */
  private userPickedTab = false;

  constructor(
    private api: ApiService,
    private toastCtrl: ToastController,
    private alertCtrl: AlertController,
    private modalCtrl: ModalController,
  ) {}

  ngOnInit(): void { this.load(); }
  ionViewWillEnter(): void { this.load(); }

  /** Switch tabs (and remember the driver made a manual choice). */
  setTab(v: unknown): void {
    this.userPickedTab = true;
    this.tab = v === 'all' ? 'all' : 'current';
  }

  load(): void {
    this.loading = true;
    this.error = null;

    this.api.get<{
      subscription: ActiveSubscription | null;
      wallet_balance: number;
      currency: string;
    }>('/drivers/me/subscription').subscribe({
      next: (res) => {
        this.current = res.subscription ?? null;
        this.wallet = res.wallet_balance ?? 0;
        this.currency = res.currency ?? 'INR';
        if (!this.userPickedTab) {
          this.tab = this.current ? 'current' : 'all';
        }
      },
      error: () => {
        // subscription endpoint error isn't fatal — we can still browse plans
      },
    });

    this.api.get<{ balance?: number; minimum_wallet_limit?: number }>('/drivers/me/wallet').subscribe({
      next: (res) => {
        if (typeof res?.balance === 'number') this.wallet = res.balance;
        if (typeof res?.minimum_wallet_limit === 'number') this.minWalletLimit = res.minimum_wallet_limit;
      },
      error: () => undefined,
    });

    this.api.get<{ data: Plan[] }>('/drivers/me/subscriptions/plans').subscribe({
      next: (res) => {
        this.plans = res.data ?? [];
        this.loading = false;
      },
      error: (err) => {
        this.error = err?.error?.message || 'Could not load plans. Pull to refresh.';
        this.loading = false;
      },
    });
  }

  modelKey(s: ActiveSubscription | Plan): string {
    return s.pricing_model || 'subscription';
  }

  modelLabel(s: ActiveSubscription | Plan): string {
    const k = this.modelKey(s);
    if (k === 'commission') return 'Commission';
    if (k === 'hybrid') return 'Hybrid';
    return 'Subscription';
  }

  modelIcon(s: ActiveSubscription | Plan): string {
    const k = this.modelKey(s);
    if (k === 'commission') return 'percent-outline';
    if (k === 'hybrid') return 'swap-horizontal-outline';
    return 'card-outline';
  }

  meterSummary(p: Plan): string {
    switch (p.meter_type) {
      case 'rides': return `${p.rides_count} rides`;
      case 'days': return `Valid ${p.days_count} days`;
      case 'daily': return 'Valid for 1 day';
      case 'earnings': return `Until you earn ₹${p.earnings_threshold}`;
      default: return '';
    }
  }

  /** Headline progress for the active plan card. */
  remainingSummary(s: ActiveSubscription): string {
    if (s.rides_remaining != null) return `${s.rides_remaining} of ${s.rides_allowed} rides left`;
    if (s.earnings_remaining != null) return `₹${s.earnings_remaining} of ₹${s.earnings_cap} left`;
    if (s.expires_at) return `Active until ${this.fmtDate(s.expires_at)}`;
    return 'Active';
  }

  private fmtDate(iso: string): string {
    try {
      const d = new Date(iso);
      return `${d.getDate()} ${d.toLocaleString('en', { month: 'short' })}`;
    } catch { return iso; }
  }

  /** True while the driver already has an active plan (new buys queue). */
  get hasActive(): boolean {
    return !!this.current;
  }

  /** Auto-renew status line for the active plan card. */
  renewSummary(s: ActiveSubscription): string {
    if (s.cancelled_at || !s.auto_renew) {
      return s.expires_at ? `Won't renew — active until ${this.fmtDate(s.expires_at)}` : "Won't renew";
    }
    return s.expires_at ? `Auto-renews on ${this.fmtDate(s.expires_at)}` : 'Auto-renews when it ends';
  }

  async confirmBuy(p: Plan): Promise<void> {
    const modal = await this.modalCtrl.create({
      component: SubscriptionCheckoutModalComponent,
      componentProps: {
        plan: p,
        walletBalance: this.wallet,
        minWalletLimit: this.minWalletLimit,
      },
      breakpoints: [0, 0.88, 1],
      initialBreakpoint: 0.88,
    });
    await modal.present();
    const { data } = await modal.onWillDismiss();
    if (data?.confirmed) {
      if (data.paymentMethod === 'wallet') {
        this.buy(p, 'wallet');
      } else {
        this.buyViaUpi(p);
      }
    }
  }

  buy(p: Plan, paymentMethod: 'wallet' | 'upi' = 'wallet'): void {
    if (this.buyingId) return;
    this.buyingId = p.id;
    this.api.post<{ message?: string; queued?: boolean }>('/drivers/me/subscriptions', {
      plan_id: p.id,
      payment_method: paymentMethod,
    }).subscribe({
      next: async (res) => {
        this.buyingId = null;
        await this.presentToast(res?.message || (res?.queued ? 'Plan queued' : 'Subscription activated'), 'success');
        this.load();
      },
      error: async (err) => {
        this.buyingId = null;
        await this.presentToast(err?.error?.message || 'Could not subscribe', 'danger');
      },
    });
  }

  buyViaUpi(p: Plan): void {
    if (this.buyingId) return;
    this.buyingId = p.id;

    this.api.post<any>('/drivers/me/subscriptions/upi/create-order', { plan_id: p.id }).subscribe({
      next: (order) => {
        this.openRazorpayUpi(order, p);
      },
      error: async (err) => {
        this.buyingId = null;
        await this.presentToast(err?.error?.message || 'Failed to initiate UPI payment', 'danger');
      },
    });
  }

  private openRazorpayUpi(order: any, p: Plan): void {
    const Razorpay = (window as any).Razorpay;
    if (!Razorpay) {
      this.buyingId = null;
      this.presentToast('Payment system unavailable. Please try again.', 'danger');
      return;
    }

    const rzp = new Razorpay({
      key: order.key_id,
      amount: order.amount_paise,
      currency: order.currency || 'INR',
      name: 'Cabbies',
      description: `Subscription: ${p.title}`,
      order_id: order.order_id,
      handler: (response: any) => {
        this.verifyUpiSubscription(response, p);
      },
      modal: {
        ondismiss: () => {
          this.buyingId = null;
        },
      },
      theme: { color: '#00C06A' },
    });

    rzp.open();
  }

  private verifyUpiSubscription(response: any, p: Plan): void {
    this.api.post<{ message?: string; queued?: boolean }>('/drivers/me/subscriptions/upi/verify', {
      plan_id: p.id,
      razorpay_order_id: response.razorpay_order_id,
      razorpay_payment_id: response.razorpay_payment_id,
      razorpay_signature: response.razorpay_signature,
    }).subscribe({
      next: async (res) => {
        this.buyingId = null;
        await this.presentToast(res?.message || 'Subscription activated via UPI!', 'success');
        this.load();
      },
      error: async (err) => {
        this.buyingId = null;
        await this.presentToast(err?.error?.message || 'UPI verification failed', 'danger');
      },
    });
  }

  /** Confirm + turn off auto-renew (plan stays active until it expires). */
  async confirmCancel(): Promise<void> {
    const s = this.current;
    if (!s) return;
    const until = s.expires_at ? ` until ${this.fmtDate(s.expires_at)}` : ' until it expires';
    let message = `Auto-renew will be turned off. Your “${s.title}” stays active${until} and won't renew after that.`;
    if (s.next_plan) {
      message += ` Your queued plan (${s.next_plan.title}) is already paid for and will still start when this plan ends.`;
    }
    const alert = await this.alertCtrl.create({
      header: 'Cancel subscription?',
      message,
      buttons: [
        { text: 'Keep plan', role: 'cancel' },
        { text: 'Cancel plan', role: 'destructive', handler: () => this.cancel() },
      ],
    });
    await alert.present();
  }

  cancel(): void {
    this.api.post<{ message?: string }>('/drivers/me/subscriptions/cancel', {}).subscribe({
      next: async (res) => {
        await this.presentToast(res?.message || 'Auto-renew turned off', 'success');
        this.load();
      },
      error: async (err) => {
        await this.presentToast(err?.error?.message || 'Could not cancel', 'danger');
      },
    });
  }

  private async presentToast(message: string, color: 'success' | 'danger'): Promise<void> {
    const toast = await this.toastCtrl.create({ message, duration: 2500, color, position: 'bottom' });
    await toast.present();
  }
}
