import {
  ChangeDetectionStrategy, ChangeDetectorRef,
  Component, EventEmitter, Input, OnChanges, Output, SimpleChanges,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { OperatorPaymentMethods, PaymentOptionsService } from '../core/payment-options.service';

/** The customer's choice from the shared payment modal. */
export type PaymentChoice = 'online' | 'gpay' | 'cash';

/**
 * Shared payment-method sheet, reused by every booking flow (Private, Fixed,
 * Shuttle). Opens with a fare, fetches the operator's enabled methods, and
 * renders only those. Cash shows the "deposit now / balance in cash" split.
 *
 * Selection only — the parent flow runs the actual payment for the chosen
 * method (Razorpay order for online/GPay, cash-deposit order for cash).
 */
@Component({
  selector: 'app-payment-method-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, IonicModule],
  template: `
    <div class="pmm" *ngIf="open" (click)="onBackdrop($event)">
      <div class="pmm__sheet" (click)="$event.stopPropagation()">
        <div class="pmm__grip"></div>
        <h2 class="pmm__title">{{ title }}</h2>
        <p class="pmm__amt" *ngIf="amount != null">Total <b>₹{{ amount | number:'1.0-2' }}</b></p>

        <div class="pmm__cue" *ngIf="loading">Loading payment options…</div>

        <ng-container *ngIf="!loading && methods as m">
          <button type="button" class="pmm__opt" *ngIf="m.online" [disabled]="busy" (click)="choose('online')">
            <ion-icon class="pmm__ic" name="card-outline" aria-hidden="true"></ion-icon>
            <span class="pmm__txt"><b>Pay online</b><small>Card, net-banking or wallet</small></span>
            <ion-icon class="pmm__chev" name="chevron-forward-outline" aria-hidden="true"></ion-icon>
          </button>

          <button type="button" class="pmm__opt" *ngIf="m.gpay" [disabled]="busy" (click)="choose('gpay')">
            <ion-icon class="pmm__ic" name="phone-portrait-outline" aria-hidden="true"></ion-icon>
            <span class="pmm__txt"><b>UPI / GPay</b><small>Pay by UPI app</small></span>
            <ion-icon class="pmm__chev" name="chevron-forward-outline" aria-hidden="true"></ion-icon>
          </button>

          <button type="button" class="pmm__opt pmm__opt--cash" *ngIf="m.cash" [disabled]="busy" (click)="choose('cash')">
            <ion-icon class="pmm__ic" name="cash-outline" aria-hidden="true"></ion-icon>
            <span class="pmm__txt">
              <b>Cash</b>
              <small *ngIf="depositAmount > 0">Pay ₹{{ depositAmount | number:'1.0-2' }} now, ₹{{ balanceAmount | number:'1.0-2' }} cash to the driver</small>
              <small *ngIf="depositAmount <= 0">Pay the driver in cash at drop-off</small>
            </span>
            <ion-icon class="pmm__chev" name="chevron-forward-outline" aria-hidden="true"></ion-icon>
          </button>

          <p class="pmm__none" *ngIf="!m.online && !m.gpay && !m.cash">No payment methods are available right now.</p>
        </ng-container>

        <button type="button" class="pmm__cancel" [disabled]="busy" (click)="dismiss.emit()">Cancel</button>
      </div>
    </div>
  `,
  styles: [`
    :host { display: contents; }
    .pmm { position: fixed; inset: 0; z-index: 10000; display: flex; align-items: flex-end; background: rgba(15, 20, 25, .45); }
    .pmm__sheet { width: 100%; background: var(--ion-background-color, #fff); border-radius: 18px 18px 0 0; padding: 8px 18px calc(18px + env(safe-area-inset-bottom)); box-shadow: 0 -8px 30px rgba(0,0,0,.18); animation: pmm-up .18s ease-out; }
    @keyframes pmm-up { from { transform: translateY(24px); opacity: .6; } to { transform: translateY(0); opacity: 1; } }
    .pmm__grip { width: 40px; height: 4px; border-radius: 999px; background: #d5dae0; margin: 6px auto 12px; }
    .pmm__title { margin: 0; font-size: 17px; font-weight: 800; color: var(--ion-text-color, #16202a); }
    .pmm__amt { margin: 2px 0 14px; font-size: 13px; color: #6b7683; }
    .pmm__amt b { color: var(--ion-text-color, #16202a); font-weight: 800; }
    .pmm__cue, .pmm__none { padding: 18px 4px; font-size: 13px; color: #6b7683; text-align: center; }
    .pmm__opt { display: flex; align-items: center; gap: 12px; width: 100%; padding: 14px; margin-bottom: 10px; border: 1px solid var(--ion-border-color, #e6e9ee); border-radius: 12px; background: var(--ion-item-background, #fff); text-align: left; cursor: pointer; }
    .pmm__opt:active { background: #f4f6f9; }
    .pmm__opt[disabled] { opacity: .55; }
    .pmm__ic { flex: 0 0 24px; width: 24px; height: 24px; color: var(--dc-green, #087f50); }
    .pmm__txt { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
    .pmm__txt b { font-size: 15px; font-weight: 700; color: var(--ion-text-color, #16202a); }
    .pmm__txt small { font-size: 12px; color: #6b7683; }
    .pmm__chev { flex: 0 0 18px; width: 18px; height: 18px; color: #b7c0ca; }
    .pmm__cancel { width: 100%; padding: 13px; margin-top: 2px; border: 0; border-radius: 12px; background: transparent; color: #6b7683; font-size: 15px; font-weight: 700; cursor: pointer; }
    .pmm__cancel[disabled] { opacity: .55; }
  `],
})
export class PaymentMethodModalComponent implements OnChanges {
  /** Controls visibility; the parent flow owns it. */
  @Input() open = false;
  /** The fare being paid — drives the cash deposit/balance split. */
  @Input() amount: number | null = null;
  @Input() title = 'Choose how to pay';
  /** Set while the parent runs the payment, to lock the buttons. */
  @Input() busy = false;

  @Output() select = new EventEmitter<PaymentChoice>();
  @Output() dismiss = new EventEmitter<void>();

  methods: OperatorPaymentMethods | null = null;
  loading = false;

  constructor(private options: PaymentOptionsService, private cdr: ChangeDetectorRef) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['open'] && this.open && !this.methods) {
      void this.loadMethods();
    }
  }

  get depositAmount(): number {
    const pct = this.methods?.cash_deposit_percent ?? 0;
    if (this.amount == null || pct <= 0) return 0;
    return Math.round(this.amount * pct / 100);
  }

  get balanceAmount(): number {
    if (this.amount == null) return 0;
    return Math.max(0, this.amount - this.depositAmount);
  }

  choose(method: PaymentChoice): void {
    if (this.busy) return;
    this.select.emit(method);
  }

  onBackdrop(_: Event): void {
    if (!this.busy) this.dismiss.emit();
  }

  private async loadMethods(): Promise<void> {
    this.loading = true;
    this.cdr.markForCheck();
    this.methods = await this.options.load();
    this.loading = false;
    this.cdr.markForCheck();
  }
}
