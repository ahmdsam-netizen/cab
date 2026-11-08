import { Component, OnInit } from '@angular/core';
import { AlertController, ToastController } from '@ionic/angular';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';

declare const Razorpay: any;

interface WalletBreakdown {
  balance: number;
  minimum_wallet_limit: number;
  maximum_wallet_limit: number;
  commission_charges: number;
  subscription_charges: number;
  other_platform_charges: number;
  wallet_recharges: number;
  cashbacks: number;
  total_deductions: number;
}

interface Txn {
  id: number;
  type: string;
  amount: number;
  reason: string | null;
  is_debit: boolean;
  created_at: string | null;
}

interface WalletResponse {
  balance: number;
  minimum_wallet_limit: number;
  maximum_wallet_limit: number;
  currency: string;
  breakdown: WalletBreakdown;
  recent_deductions: Txn[];
  recent_recharges: Txn[];
  transactions: Txn[];
}

type Segment = 'overview' | 'deductions' | 'recharges';

/**
 * Driver Wallet Page (System 1: Driver Wallet).
 *
 * Dedicated strictly to platform charges (liabilities):
 *   - Commission charges
 *   - Subscription charges
 *   - Other platform deductions
 *   - Wallet recharges / top-ups
 *   - Minimum wallet limit
 *
 * Earnings and operator payouts live independently in the Earnings tab.
 */
@Component({
  selector: 'app-wallet',
  templateUrl: './wallet.page.html',
  styleUrls: ['./wallet.page.scss'],
  standalone: false,
})
export class WalletPage implements OnInit {
  loading = false;
  error: string | null = null;
  toppingUp = false;

  segment: Segment = 'overview';
  currency = 'INR';

  balance = 0;
  minLimit = 0;
  maxLimit = 0;
  breakdown: WalletBreakdown | null = null;
  deductions: Txn[] = [];
  recharges: Txn[] = [];
  allTransactions: Txn[] = [];

  constructor(
    private api: ApiService,
    private auth: AuthService,
    private toastCtrl: ToastController,
    private alertCtrl: AlertController,
  ) {}

  ngOnInit(): void {
    this.load();
  }

  ionViewWillEnter(): void {
    this.load();
  }

  get inDebt(): boolean {
    return this.balance < 0;
  }

  get isBelowLimit(): boolean {
    return this.balance < this.minLimit;
  }

  get availableFloat(): number {
    return Math.max(0, this.balance - this.minLimit);
  }

  load(): void {
    this.loading = true;
    this.error = null;
    this.api.get<WalletResponse>('/drivers/me/wallet').subscribe({
      next: (res) => {
        this.loading = false;
        this.balance = res.balance;
        this.minLimit = res.minimum_wallet_limit;
        this.maxLimit = res.maximum_wallet_limit;
        this.currency = res.currency || 'INR';
        this.breakdown = res.breakdown;
        this.deductions = res.recent_deductions || [];
        this.recharges = res.recent_recharges || [];
        this.allTransactions = res.transactions || [];
      },
      error: (err) => {
        this.loading = false;
        this.error = err?.error?.message || 'Failed to load wallet data.';
      },
    });
  }

  setSegment(value: any): void {
    if (value) {
      this.segment = value as Segment;
    }
  }

  async promptTopUp(): Promise<void> {
    const alert = await this.alertCtrl.create({
      header: 'Recharge Wallet',
      message: 'Enter the amount in ₹ to add to your driver wallet.',
      inputs: [
        {
          name: 'amount',
          type: 'number',
          placeholder: 'e.g. 500',
          min: 50,
          max: 10000,
        },
      ],
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Proceed to Pay',
          handler: (data) => {
            const amount = parseFloat(data.amount);
            if (isNaN(amount) || amount <= 0) {
              this.showToast('Please enter a valid amount.');
              return false;
            }
            if (amount < 50) {
              this.showToast('Minimum recharge is ₹50.');
              return false;
            }
            this.startTopup(amount);
            return true;
          },
        },
      ],
    });
    await alert.present();
  }

  private startTopup(amount: number): void {
    this.toppingUp = true;
    this.api.post<any>('/drivers/me/wallet/topup/razorpay', { amount }).subscribe({
      next: (res) => {
        this.openRazorpay(res.razorpay);
      },
      error: (err) => {
        this.toppingUp = false;
        this.showToast(err?.error?.message || 'Failed to start wallet recharge.');
      },
    });
  }

  private openRazorpay(options: any): void {
    if (typeof Razorpay === 'undefined') {
      this.toppingUp = false;
      this.showToast('Payment system not loaded. Please try again.');
      return;
    }

    const user = this.auth.getUser();

    const rzp = new Razorpay({
      key: options.key_id,
      amount: options.amount_paise,
      currency: options.currency || 'INR',
      name: 'Cabbies',
      description: 'Wallet Recharge',
      order_id: options.order_id,
      prefill: {
        name: user?.name || 'Driver',
        email: user?.email || '',
        contact: user?.phone || '',
      },
      handler: (response: any) => {
        this.verifyTopup(response);
      },
      modal: {
        ondismiss: () => {
          this.toppingUp = false;
        },
      },
      theme: { color: '#00C06A' },
    });

    rzp.open();
  }

  private verifyTopup(response: any): void {
    this.api.post('/drivers/me/wallet/topup/razorpay/verify', {
      razorpay_order_id: response.razorpay_order_id,
      razorpay_payment_id: response.razorpay_payment_id,
      razorpay_signature: response.razorpay_signature,
    }).subscribe({
      next: () => {
        this.toppingUp = false;
        this.showToast('Wallet recharge successful!');
        this.load();
      },
      error: (err) => {
        this.toppingUp = false;
        this.showToast(err?.error?.message || 'Verification failed.');
      },
    });
  }

  async explainLimits(): Promise<void> {
    const alert = await this.alertCtrl.create({
      header: 'Ride Acceptance Rules',
      message: `You need a minimum balance of ₹${this.minLimit} in your wallet to receive and accept ride bookings.\n\nWhen you complete rides, platform commissions are automatically deducted from this wallet. Keep your balance topped up to continue accepting rides without interruption.`,
      buttons: ['Got it'],
    });
    await alert.present();
  }

  fmtDate(dt: string | null): string {
    if (!dt) return '—';
    try {
      const d = new Date(dt);
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch {
      return dt;
    }
  }

  private async showToast(msg: string): Promise<void> {
    const t = await this.toastCtrl.create({ message: msg, duration: 3000, position: 'bottom' });
    await t.present();
  }
}
