import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { CityContextService } from '../../core/city-context.service';
import { ToastService } from '../../core/toast.service';
import {
  ButtonComponent,
  IconComponent,
  IconName,
  InputComponent,
  SelectComponent,
} from '../../ui';

interface OperatorSettings {
  private_service_name: string | null;
  fixed_service_name: string | null;
  shuttle_service_name: string | null;
  tips_enabled: boolean;
  customer_tip_value_1: number;
  customer_tip_value_2: number;
  customer_tip_value_3: number;
  tip_in_percentage: boolean;

  check_destination_outside_geofence: boolean;
  check_driver_debt: boolean;
  update_driver_payment_modes_enabled: boolean;

  payment_online_enabled: boolean;
  payment_gpay_enabled: boolean;
  payment_cash_enabled: boolean;
  cash_deposit_percent: number;

  wallet_cash_min_capping: number;
  wallet_cash_max_capping: number;

  subscription_popup_enabled: boolean;
  subscription_popup_title: string | null;
  subscription_popup_desc: string | null;
  subscription_popup_button1: string | null;
  subscription_popup_button2: string | null;

  notifications_sms_enabled: boolean;
  notifications_email_enabled: boolean;
  fixed_customer_sms_enabled: boolean;
  fixed_customer_email_enabled: boolean;
  fixed_driver_sms_enabled: boolean;
  fixed_driver_email_enabled: boolean;
  fixed_admin_sms_enabled: boolean;
  fixed_admin_email_enabled: boolean;

  customer_ride_accept_msg: string | null;
  ride_cancellation_msg: string | null;
}

type SectionKey =
  | 'tipping'
  | 'geofence'
  | 'payments'
  | 'wallet'
  | 'subscription'
  | 'services'
  | 'serviceNames'
  | 'notifications'
  | 'templates';

/** Service catalogue rows (scope → modes) from /admin/cities/{id}/ride-products. */
interface RideMode {
  id: number;
  mode: 'private' | 'fixed' | 'shuttle' | string;
  name: string;
  display_name?: string | null;
  is_active: boolean;
}

interface RideScope {
  id: number;
  scope: 'local' | 'outstation' | string;
  name: string;
  is_active: boolean;
  modes: RideMode[];
}

interface SectionMeta {
  key: SectionKey;
  label: string;
  icon: IconName;
  desc: string;
}

@Component({
  selector: 'app-operator-settings',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonComponent,
    IconComponent,
    InputComponent,
    SelectComponent,
  ],
  template: `
    <div class="page">
      <header class="page-head">
        <h1 class="page-head__title">Operator Settings</h1>
        <p class="page-head__sub">
          Global, non-city-scoped configuration that applies platform-wide. Each section saves independently.
        </p>
      </header>

      <div *ngIf="loading" class="loading">
        <span class="spinner" aria-hidden="true"></span>
        <span>Loading settings…</span>
      </div>

      <div *ngIf="!loading && settings" class="layout">
        <!-- ===================== Left nav ===================== -->
        <nav class="nav" aria-label="Settings sections">
          <button
            *ngFor="let s of sections"
            type="button"
            class="nav__item"
            [class.is-active]="activeSection === s.key"
            (click)="setSection(s.key)"
          >
            <span class="nav__icon"><tm-icon [name]="s.icon" [size]="16" /></span>
            <span class="nav__label">{{ s.label }}</span>
            <tm-icon class="nav__chev" name="chevron-right" [size]="14" />
          </button>
        </nav>

        <!-- ===================== Content panel ===================== -->
        <section class="panel">
          <header class="panel__head">
            <div>
              <h2 class="panel__title">{{ currentSection.label }}</h2>
              <p class="panel__desc">{{ currentSection.desc }}</p>
            </div>
            <span class="panel__icon"><tm-icon [name]="currentSection.icon" [size]="20" /></span>
          </header>

          <div class="panel__body">
            <!-- ============= TIPPING ============= -->
            <ng-container *ngIf="activeSection === 'tipping'">
              <label class="switch-row">
                <span class="switch-row__text">
                  <span class="switch-row__title">Enable tipping</span>
                  <span class="switch-row__sub">Master switch. When off, riders never see the tip prompt on any ride type.</span>
                </span>
                <span class="switch">
                  <input type="checkbox" [(ngModel)]="settings.tips_enabled" />
                  <span class="switch__track"><span class="switch__thumb"></span></span>
                </span>
              </label>
              <div class="fields">
                <div class="field">
                  <span class="field__label">Customer tip presets</span>
                  <div class="triple">
                    <tm-input type="number" [(ngModel)]="settings.customer_tip_value_1" />
                    <tm-input type="number" [(ngModel)]="settings.customer_tip_value_2" />
                    <tm-input type="number" [(ngModel)]="settings.customer_tip_value_3" />
                  </div>
                </div>
              </div>
              <label class="switch-row">
                <span class="switch-row__text">
                  <span class="switch-row__title">Tip in percentage</span>
                  <span class="switch-row__sub">Treat the preset values as a percentage of the ride fare instead of flat rupees.</span>
                </span>
                <span class="switch">
                  <input type="checkbox" [(ngModel)]="settings.tip_in_percentage" />
                  <span class="switch__track"><span class="switch__thumb"></span></span>
                </span>
              </label>
            </ng-container>

            <!-- ============= GEOFENCE / DRIVER ============= -->
            <ng-container *ngIf="activeSection === 'geofence'">
              <label class="switch-row">
                <span class="switch-row__text">
                  <span class="switch-row__title">Check destination outside geofence</span>
                  <span class="switch-row__sub">Flag trips whose drop-off falls outside the operating area.</span>
                </span>
                <span class="switch">
                  <input type="checkbox" [(ngModel)]="settings.check_destination_outside_geofence" />
                  <span class="switch__track"><span class="switch__thumb"></span></span>
                </span>
              </label>
              <label class="switch-row">
                <span class="switch-row__text">
                  <span class="switch-row__title">Check driver debt</span>
                  <span class="switch-row__sub">Block dispatch for drivers carrying an outstanding balance.</span>
                </span>
                <span class="switch">
                  <input type="checkbox" [(ngModel)]="settings.check_driver_debt" />
                  <span class="switch__track"><span class="switch__thumb"></span></span>
                </span>
              </label>
              <label class="switch-row">
                <span class="switch-row__text">
                  <span class="switch-row__title">Update driver payment modes</span>
                  <span class="switch-row__sub">Allow drivers to change their accepted payment methods.</span>
                </span>
                <span class="switch">
                  <input type="checkbox" [(ngModel)]="settings.update_driver_payment_modes_enabled" />
                  <span class="switch__track"><span class="switch__thumb"></span></span>
                </span>
              </label>
            </ng-container>

            <!-- ============= PAYMENTS ============= -->
            <ng-container *ngIf="activeSection === 'payments'">
              <div class="chan-note">
                <span class="chan-note__title">These switches decide what customers can pay with — everywhere</span>
                <span class="chan-note__sub">Turning a method on or off here changes the payment popup in every app (Private, Fixed and Shuttle) and in every city. At least one method must stay on.</span>
              </div>
              <p class="chan-note chan-note--error" *ngIf="!paymentsHasOne">At least one payment method must stay enabled.</p>

              <label class="switch-row">
                <span class="switch-row__text">
                  <span class="switch-row__title">Online payment</span>
                  <span class="switch-row__sub">Customer pays the full fare online (card / netbanking). Driver is paid automatically; commission is kept automatically.</span>
                </span>
                <span class="switch">
                  <input type="checkbox" [(ngModel)]="settings.payment_online_enabled" />
                  <span class="switch__track"><span class="switch__thumb"></span></span>
                </span>
              </label>
              <label class="switch-row">
                <span class="switch-row__text">
                  <span class="switch-row__title">GPay / UPI</span>
                  <span class="switch-row__sub">Customer pays the full fare via a UPI app (Razorpay UPI intent). Same automatic driver payout and commission split as Online.</span>
                </span>
                <span class="switch">
                  <input type="checkbox" [(ngModel)]="settings.payment_gpay_enabled" />
                  <span class="switch__track"><span class="switch__thumb"></span></span>
                </span>
              </label>
              <label class="switch-row">
                <span class="switch-row__text">
                  <span class="switch-row__title">Cash</span>
                  <span class="switch-row__sub">Customer pays an upfront deposit online (below), then hands the remaining balance to the driver in cash at trip end.</span>
                </span>
                <span class="switch">
                  <input type="checkbox" [(ngModel)]="settings.payment_cash_enabled" />
                  <span class="switch__track"><span class="switch__thumb"></span></span>
                </span>
              </label>

              <div class="fields" *ngIf="settings.payment_cash_enabled">
                <div class="field">
                  <span class="field__label">Cash upfront deposit (%)</span>
                  <tm-input type="number" [(ngModel)]="settings.cash_deposit_percent" />
                  <span class="field__hint">Percentage of the fare collected online before a cash ride starts (e.g. 20 = ₹20 of a ₹100 fare paid now, ₹80 in cash to the driver at the end). 0–100.</span>
                </div>
              </div>
            </ng-container>

            <!-- ============= WALLET ============= -->
            <ng-container *ngIf="activeSection === 'wallet'">
              <div class="wallet-policy-note">
                <div class="wpn-header">
                  <tm-icon name="shield" class="wpn-icon"></tm-icon>
                  <strong>Wallet Policy &amp; Duty Rules</strong>
                </div>
                <ul class="wpn-list">
                  <li><strong>0 = Unlimited / Unrestricted:</strong> Setting Min Capping or Max Capping to <code>0</code> removes that restriction completely (unlimited balance range).</li>
                  <li><strong>Min Cap (Duty Floor):</strong> When set to a specific number (e.g. <code>₹50</code> or <code>-₹500</code>), drivers whose wallet falls below this limit are <strong>blocked from going online</strong> and will see a warning on their home screen to recharge.</li>
                  <li><strong>Max Cap (Balance Ceiling):</strong> When set to a specific number (e.g. <code>₹5,000</code>), top-ups that exceed this ceiling are prevented.</li>
                </ul>
              </div>

              <div class="fields">
                <div class="field">
                  <span class="field__label">Wallet min capping (₹)</span>
                  <tm-input type="number" [(ngModel)]="settings.wallet_cash_min_capping" />
                  <span class="field__hint">Minimum allowed balance. <strong>0 = Unlimited</strong> (no restriction). If set to a number (e.g. 50 or -500), drivers falling below this limit cannot go online until they recharge.</span>
                </div>
                <div class="field">
                  <span class="field__label">Wallet max capping (₹)</span>
                  <tm-input type="number" [(ngModel)]="settings.wallet_cash_max_capping" />
                  <span class="field__hint">Maximum allowed balance. <strong>0 = Unlimited</strong> (no upper limit). If set to a number (e.g. 5000), recharges beyond this ceiling are blocked.</span>
                </div>
              </div>
            </ng-container>

            <!-- ============= SUBSCRIPTION ============= -->
            <ng-container *ngIf="activeSection === 'subscription'">
              <label class="switch-row">
                <span class="switch-row__text">
                  <span class="switch-row__title">Prompt drivers to subscribe</span>
                  <span class="switch-row__sub">When on, drivers see this popup as soon as they open the Subscriptions screen. When off, it stays hidden.</span>
                </span>
                <span class="switch">
                  <input type="checkbox" [(ngModel)]="settings.subscription_popup_enabled" />
                  <span class="switch__track"><span class="switch__thumb"></span></span>
                </span>
              </label>
              <div class="fields">
                <div class="field">
                  <span class="field__label">Popup title</span>
                  <tm-input [(ngModel)]="settings.subscription_popup_title" />
                </div>
                <div class="field">
                  <span class="field__label">Popup description</span>
                  <tm-input [(ngModel)]="settings.subscription_popup_desc" />
                </div>
                <div class="field">
                  <span class="field__label">Button 1 label</span>
                  <tm-input [(ngModel)]="settings.subscription_popup_button1" />
                </div>
                <div class="field">
                  <span class="field__label">Button 2 label</span>
                  <tm-input [(ngModel)]="settings.subscription_popup_button2" />
                </div>
              </div>
            </ng-container>

            <!-- ============= SERVICES (ride catalogue) ============= -->
            <ng-container *ngIf="activeSection === 'services'">
              <section class="svc-scope svc-names" aria-labelledby="service-names-title">
                <h3 id="service-names-title">Service names</h3>
                <p class="chan-note__sub">These names apply to Local and Outstation in every city. Leave a field blank to use its default name. Use up to 40 characters per name.</p>
                <div class="svc-names__fields">
                  <tm-input label="Private display name" placeholder="Private" [(ngModel)]="settings.private_service_name" />
                  <tm-input label="Fixed display name" placeholder="Fixed" [(ngModel)]="settings.fixed_service_name" />
                  <tm-input label="Shuttle display name" placeholder="Shuttle" [(ngModel)]="settings.shuttle_service_name" />
                </div>
                <tm-button variant="ink" icon="check" [loading]="saving.serviceNames" (clicked)="save('serviceNames')">Save names</tm-button>
              </section>

              <div class="chan-note">
                <span class="chan-note__title">Switches apply to every city, in both apps, instantly</span>
                <span class="chan-note__sub">These settings are global — turning a service off here hides it from the customer booking screen and from driver signup/profile in every city, not just the one selected above. Switching off Local or Outstation takes its three services with it. Every switch saves on its own — no Save button needed. At least one service must always stay on.</span>
              </div>

              <div class="loading" *ngIf="servicesLoading"><span class="spinner" aria-hidden="true"></span><span>Loading services…</span></div>
              <p class="chan-note chan-note--error" *ngIf="!servicesLoading && servicesError">{{ servicesError }}</p>

              <div class="svc-scope" *ngFor="let scope of servicesScopes">
                <label class="switch-row svc-scope__head">
                  <span class="switch-row__text">
                    <span class="switch-row__title">{{ scope.name }}</span>
                    <span class="switch-row__sub">{{ scope.scope === 'local' ? 'Rides inside the city.' : 'Rides between cities.' }} Master switch — off hides everything below it.</span>
                  </span>
                  <span class="switch">
                    <input type="checkbox" [checked]="scope.is_active" [disabled]="servicesBusy !== null" (change)="toggleScope(scope)" />
                    <span class="switch__track"><span class="switch__thumb"></span></span>
                  </span>
                </label>

                <label class="switch-row svc-scope__mode" [class.svc-scope__mode--off]="!scope.is_active" *ngFor="let mode of scope.modes">
                  <span class="switch-row__text">
                    <span class="switch-row__title">{{ mode.display_name || mode.name }}</span>
                    <span class="switch-row__sub">{{ modeSub(mode) }}</span>
                  </span>
                  <span class="switch">
                    <input type="checkbox" [checked]="mode.is_active" [disabled]="servicesBusy !== null" (change)="toggleMode(scope, mode)" />
                    <span class="switch__track"><span class="switch__thumb"></span></span>
                  </span>
                </label>
              </div>
            </ng-container>

            <!-- ============= NOTIFICATIONS ============= -->
            <ng-container *ngIf="activeSection === 'notifications'">
              <div class="chan-note">
                <span class="chan-note__title">SMS — OTP only, always on</span>
                <span class="chan-note__sub">SMS is sent only for the login code and the boarding code. Both always send (like login) and are not switchable — no other event sends SMS.</span>
              </div>
              <div class="chan-note">
                <span class="chan-note__title">Push — managed per user</span>
                <span class="chan-note__sub">Push notifications follow the app events automatically. To silence a specific customer or driver, open their profile page → Notification preferences → Manage preferences.</span>
              </div>

              <label class="switch-row">
                <span class="switch-row__text">
                  <span class="switch-row__title">Enable email notifications</span>
                  <span class="switch-row__sub">Master switch for operator-controlled email receipts, summaries, and fixed updates. If off, no event email is sent.</span>
                </span>
                <span class="switch">
                  <input type="checkbox" [(ngModel)]="settings.notifications_email_enabled" />
                  <span class="switch__track"><span class="switch__thumb"></span></span>
                </span>
              </label>

              <div class="fields fields--spaced">
                <div class="field field--full">
                  <span class="field__label">Fixed customer emails</span>
                  <label class="mini-check"><input type="checkbox" [(ngModel)]="settings.fixed_customer_email_enabled" /> <span class="mini-check__body"><span class="mini-check__title">Email receipts and fixed booking records</span><span class="mini-check__sub">Booking receipt, cancellation/refund details, boarding code, and completed trip summary.</span></span></label>
                </div>
                <div class="field field--full">
                  <span class="field__label">Fixed driver emails</span>
                  <label class="mini-check"><input type="checkbox" [(ngModel)]="settings.fixed_driver_email_enabled" /> <span class="mini-check__body"><span class="mini-check__title">Email for driver fixed summaries</span><span class="mini-check__sub">End-of-ride or shift summaries only, not live driving alerts.</span></span></label>
                </div>
                <div class="field field--full">
                  <span class="field__label">Fixed admin emails</span>
                  <label class="mini-check"><input type="checkbox" [(ngModel)]="settings.fixed_admin_email_enabled" /> <span class="mini-check__body"><span class="mini-check__title">Email for fixed reports and summaries</span><span class="mini-check__sub">Daily or shift summaries, cancellation/refund reports, and operational exception summaries.</span></span></label>
                </div>
              </div>
            </ng-container>

            <!-- ============= TEMPLATES ============= -->
            <ng-container *ngIf="activeSection === 'templates'">
              <div class="field field--full">
                <span class="field__label">Customer ride-accept message</span>
                <textarea class="ta" rows="4" [(ngModel)]="settings.customer_ride_accept_msg"></textarea>
                <div class="placeholders">
                  <span class="chip" *ngFor="let p of acceptPlaceholders">{{ p }}</span>
                </div>
              </div>
              <div class="field field--full">
                <span class="field__label">Ride cancellation message</span>
                <textarea class="ta" rows="3" [(ngModel)]="settings.ride_cancellation_msg"></textarea>
                <div class="placeholders">
                  <span class="chip" *ngFor="let p of cancelPlaceholders">{{ p }}</span>
                </div>
              </div>
            </ng-container>
          </div>

          <footer class="panel__foot" *ngIf="activeSection !== 'services'">
            <tm-button
              variant="ink"
              icon="check"
              [loading]="saving[activeSection]"
              (clicked)="save(activeSection)"
            >Save changes</tm-button>
          </footer>
        </section>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .page { display: flex; flex-direction: column; gap: var(--tm-space-5); }

    .page-head__title {
      margin: 0 0 4px;
      font-size: 24px;
      font-weight: 800;
      letter-spacing: -0.02em;
      color: var(--tm-text);
    }
    .page-head__sub { margin: 0; font-size: 13px; color: var(--tm-text-muted); font-weight: 500; }

    /* -------- Loading -------- */
    .loading {
      display: flex; align-items: center; justify-content: center; gap: 10px;
      padding: var(--tm-space-10);
      color: var(--tm-text-muted); font-weight: 600;
    }
    .spinner {
      width: 18px; height: 18px; border-radius: 50%;
      border: 2px solid var(--tm-line-2); border-top-color: var(--tm-green);
      animation: os-spin 0.7s linear infinite;
    }
    @keyframes os-spin { to { transform: rotate(360deg); } }

    /* -------- Layout -------- */
    .layout {
      display: grid;
      grid-template-columns: 248px 1fr;
      gap: var(--tm-space-4);
      align-items: start;
    }

    /* -------- Left nav -------- */
    .nav {
      display: flex; flex-direction: column; gap: 2px;
      background: var(--tm-surface);
      border: 1px solid var(--tm-line);
      border-radius: var(--tm-radius-lg);
      padding: 8px;
      position: sticky;
      top: var(--tm-space-4);
    }
    .nav__item {
      display: flex; align-items: center; gap: 10px;
      width: 100%;
      padding: 10px 12px;
      border: 0;
      background: transparent;
      border-radius: var(--tm-radius-md);
      color: var(--tm-text-muted);
      font-family: var(--tm-font-body);
      font-size: 13px; font-weight: 700;
      text-align: left;
      cursor: pointer;
      transition: background var(--tm-duration-fast) var(--tm-ease),
                  color var(--tm-duration-fast) var(--tm-ease);
    }
    .nav__item:hover:not(.is-active) { background: var(--tm-canvas-2); color: var(--tm-text); }
    .nav__item.is-active { background: var(--tm-ink); color: #fff; }
    .nav__icon { display: inline-flex; }
    .nav__label { flex: 1; }
    .nav__chev { opacity: 0.4; }
    .nav__item.is-active .nav__chev { opacity: 0.85; }

    /* -------- Panel -------- */
    .panel {
      background: var(--tm-surface);
      border: 1px solid var(--tm-line);
      border-radius: var(--tm-radius-lg);
      overflow: hidden;
      min-width: 0;
    }
    .panel__head {
      display: flex; align-items: flex-start; justify-content: space-between; gap: 16px;
      padding: var(--tm-space-5);
      border-bottom: 1px solid var(--tm-line);
    }
    .panel__title { margin: 0; font-size: 18px; font-weight: 800; letter-spacing: -0.01em; color: var(--tm-text); }
    .panel__desc { margin: 4px 0 0; font-size: 13px; color: var(--tm-text-muted); font-weight: 500; max-width: 60ch; }
    .panel__icon {
      display: inline-flex; align-items: center; justify-content: center;
      width: 40px; height: 40px; flex-shrink: 0;
      border-radius: var(--tm-radius-md);
      background: var(--tm-canvas-2);
      color: var(--tm-text-muted);
    }
    .panel__body {
      padding: var(--tm-space-5);
      display: flex; flex-direction: column; gap: var(--tm-space-4);
    }
    .panel__foot {
      display: flex; justify-content: flex-end;
      padding: var(--tm-space-4) var(--tm-space-5);
      border-top: 1px solid var(--tm-line);
      background: var(--tm-canvas);
    }

    /* -------- Fields -------- */
    .fields { display: grid; grid-template-columns: 1fr 1fr; gap: var(--tm-space-4); }
    .field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .field--full { grid-column: 1 / -1; }
    .field__label {
      font-size: 11px; font-weight: 800; letter-spacing: 0.06em;
      text-transform: uppercase; color: var(--tm-text-muted);
    }
    .field__hint { font-size: 11px; color: var(--tm-text-soft); font-weight: 500; }
    .wallet-policy-note {
      padding: 14px 16px;
      border-radius: 12px;
      background: rgba(18, 179, 91, 0.06);
      border: 1px solid rgba(18, 179, 91, 0.22);
      margin-bottom: 16px;
    }
    .wpn-header {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 13px;
      font-weight: 800;
      color: var(--tm-text, #0D1B2A);
      margin-bottom: 8px;
    }
    .wpn-icon {
      color: var(--tm-green, #12B35B);
      font-size: 18px;
    }
    .wpn-list {
      margin: 0;
      padding-left: 18px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-size: 12px;
      color: var(--tm-text-soft, #4B5563);
      line-height: 1.45;
      li code {
        background: rgba(0, 0, 0, 0.06);
        padding: 1px 5px;
        border-radius: 4px;
        font-weight: 700;
        color: var(--tm-text, #0D1B2A);
      }
    }
    .chan-note { display: flex; flex-direction: column; gap: 3px; padding: 12px 14px; border-radius: 10px; background: var(--tm-surface-2, #F6F8FA); border: 1px solid var(--tm-border, #E5E9EF); margin-bottom: 10px; }
    .chan-note__title { font-size: 12.5px; font-weight: 700; color: var(--tm-text); }
    .chan-note__sub { font-size: 11.5px; color: var(--tm-text-soft); line-height: 1.45; }
    .chan-note--error { color: var(--tm-red, #B42318); border-color: var(--tm-red, #B42318); }
    .svc-scope { border: 1px solid var(--tm-border, #E5E9EF); border-radius: 12px; padding: 4px 14px; margin-bottom: 12px; }
    .svc-names { display: grid; gap: 10px; padding: 14px; }
    .svc-names h3, .svc-names p { margin: 0; }
    .svc-names h3 { font-size: 14px; }
    .svc-names__fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 160px), 1fr)); gap: 10px; }
    .svc-names > tm-button { justify-self: start; }
    .svc-scope__head { border-bottom: 1px solid var(--tm-border, #E5E9EF); }
    .svc-scope__mode { padding-left: 18px; }
    .svc-scope__mode--off { opacity: 0.45; }
    .fields--spaced { margin-top: 4px; }
    .mini-check {
      display: flex; align-items: flex-start; gap: 9px;
      padding: 9px 10px; border: 1px solid var(--tm-line);
      border-radius: var(--tm-radius-sm); background: var(--tm-canvas);
      font-size: 13px; font-weight: 650; color: var(--tm-text); cursor: pointer;
    }
    .mini-check input { width: 15px; height: 15px; accent-color: var(--tm-green); margin-top: 2px; flex: none; }
    .mini-check__body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .mini-check__title { font-size: 13px; font-weight: 750; color: var(--tm-text); }
    .mini-check__sub { font-size: 12px; font-weight: 500; color: var(--tm-text-muted); line-height: 1.35; }
    .triple { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }

    /* -------- Textarea -------- */
    .ta {
      width: 100%;
      padding: 10px 14px;
      border: 1px solid var(--tm-line-2);
      border-radius: var(--tm-radius-md);
      font-family: inherit; font-size: 14px;
      color: var(--tm-text); background: var(--tm-surface);
      outline: none; resize: vertical; min-height: 92px;
      transition: border-color var(--tm-duration-fast) var(--tm-ease);
    }
    .ta:focus { border-color: var(--tm-ink); }

    /* -------- Switch row -------- */
    .switch-row {
      display: flex; align-items: center; justify-content: space-between; gap: 16px;
      padding: 14px 16px;
      border: 1px solid var(--tm-line);
      border-radius: var(--tm-radius-md);
      background: var(--tm-canvas);
      cursor: pointer;
    }
    .switch-row__title { display: block; font-size: 14px; font-weight: 700; color: var(--tm-text); }
    .switch-row__sub { display: block; font-size: 12px; color: var(--tm-text-muted); margin-top: 1px; }
    .switch { display: inline-flex; flex-shrink: 0; }
    .switch input { position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none; }
    .switch__track {
      position: relative; width: 40px; height: 22px; border-radius: 999px;
      background: var(--tm-line-2);
      transition: background var(--tm-duration-fast) var(--tm-ease);
    }
    .switch__thumb {
      position: absolute; top: 3px; left: 3px;
      width: 16px; height: 16px; border-radius: 50%;
      background: #fff; box-shadow: 0 1px 2px rgba(15, 20, 25, 0.25);
      transition: transform var(--tm-duration-fast) var(--tm-ease);
    }
    .switch input:checked + .switch__track { background: var(--tm-green); }
    .switch input:checked + .switch__track .switch__thumb { transform: translateX(18px); }

    /* -------- Placeholders / chips -------- */
    .placeholders { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
    .chip {
      font-family: var(--tm-font-mono); font-size: 11px; font-weight: 700;
      padding: 3px 8px; border-radius: var(--tm-radius-pill);
      background: var(--tm-canvas-2); color: var(--tm-text-muted);
    }

    /* -------- Responsive -------- */
    @media (max-width: 900px) {
      .layout { grid-template-columns: 1fr; }
      .nav {
        flex-direction: row; overflow-x: auto; position: static;
        scrollbar-width: none;
      }
      .nav::-webkit-scrollbar { display: none; }
      .nav__item { white-space: nowrap; }
      .nav__chev { display: none; }
      .fields, .triple { grid-template-columns: 1fr; }
    }
  `],
})
export class OperatorSettingsComponent implements OnInit {
  settings: OperatorSettings | null = null;
  loading = false;

  activeSection: SectionKey = 'tipping';

  readonly sections: SectionMeta[] = [
    { key: 'tipping',      label: 'Tipping',           icon: 'gift',          desc: 'Preset tip amounts shown to riders, and whether they are flat ₹ or a percentage of fare.' },
    { key: 'geofence',     label: 'Driver & Geofence', icon: 'driver-helmet', desc: 'Operational safety checks applied to drivers and trips.' },
    { key: 'payments',     label: 'Payments',          icon: 'handshake',     desc: 'Which payment methods the apps offer everywhere: Online, GPay and Cash. Cash takes an upfront online deposit; the rest is paid to the driver in cash at trip end.' },
    { key: 'wallet',       label: 'Wallet',            icon: 'rupee',         desc: 'Cash-wallet limits and the terms shown to users.' },
    { key: 'subscription', label: 'Subscription',      icon: 'star',          desc: 'Copy for the driver subscription promo popup.' },
    { key: 'services',     label: 'Services',          icon: 'car',           desc: 'Which ride services the apps offer: Local & Outstation, each with Private, Fixed and Shuttle. Off = hidden in both the customer and driver apps.' },
    { key: 'notifications', label: 'Notifications',     icon: 'bell',          desc: 'Email switches for fixed module messages. SMS is OTP-only; push is managed per user from their profile page.' },
    { key: 'templates',    label: 'Templates',         icon: 'envelope',      desc: 'Notification copy with dynamic placeholders.' },
  ];

  saving: Record<SectionKey, boolean> = {
    tipping: false,
    geofence: false,
    payments: false,
    wallet: false,
    subscription: false,
    services: false,
    serviceNames: false,
    notifications: false,
    templates: false,
  };

  // ----- Services section (per-city catalogue; each switch saves instantly) -----
  servicesScopes: RideScope[] = [];
  servicesLoading = false;
  servicesError: string | null = null;
  /** 'scope-3' | 'mode-7' while its PATCH is in flight. */
  servicesBusy: string | null = null;
  private servicesCityId: number | null = null;

  // Only tokens the backend can actually fill are advertised, so a typed
  // placeholder never renders blank for the customer.
  readonly acceptPlaceholders = [
    '{{customer_name}}',
    '{{operator_name}}',
    '{{driver_name}}',
  ];

  readonly cancelPlaceholders = ['{{engagement_id}}', '{{customer_name}}'];

  /** Which form fields each section is responsible for. */
  private readonly sectionFields: Record<SectionKey, string[]> = {
    tipping: [
      'tips_enabled',
      'customer_tip_value_1',
      'customer_tip_value_2',
      'customer_tip_value_3',
      'tip_in_percentage',
    ],
    geofence: [
      'check_destination_outside_geofence',
      'check_driver_debt',
      'update_driver_payment_modes_enabled',
    ],
    payments: [
      'payment_online_enabled',
      'payment_gpay_enabled',
      'payment_cash_enabled',
      'cash_deposit_percent',
    ],
    wallet: ['wallet_cash_min_capping', 'wallet_cash_max_capping'],
    subscription: [
      'subscription_popup_enabled',
      'subscription_popup_title',
      'subscription_popup_desc',
      'subscription_popup_button1',
      'subscription_popup_button2',
    ],
    services: [], // per-toggle instant PATCH, not part of the settings form
    serviceNames: ['private_service_name', 'fixed_service_name', 'shuttle_service_name'],
    // SMS keys dropped from the UI on purpose: SMS is OTP-only (login +
    // boarding, always on) so the old SMS toggles are dead switches.
    notifications: [
      'notifications_email_enabled',
      'fixed_customer_email_enabled',
      'fixed_driver_email_enabled',
      'fixed_admin_email_enabled',
    ],
    templates: ['customer_ride_accept_msg', 'ride_cancellation_msg'],
  };

  constructor(private api: ApiService, private toast: ToastService, private cityCtx: CityContextService) {}

  ngOnInit(): void {
    this.fetch();
    // City known up-front (or switched later) → (re)load the services tree.
    this.cityCtx.ensureCitiesLoaded().subscribe();
    this.cityCtx.cityId$.subscribe((id) => {
      if (id != null && id !== this.servicesCityId) {
        this.servicesCityId = id;
        this.loadServices();
      }
    });
  }

  get currentSection(): SectionMeta {
    return this.sections.find((s) => s.key === this.activeSection) ?? this.sections[0];
  }

  /** At least one payment method must stay on (mirrors the backend guard). */
  get paymentsHasOne(): boolean {
    const s = this.settings;
    return (
      !!s &&
      !!(s.payment_online_enabled || s.payment_gpay_enabled || s.payment_cash_enabled)
    );
  }

  setSection(key: SectionKey): void {
    this.activeSection = key;
  }

  fetch(): void {
    this.loading = true;
    this.api.get<{ settings: OperatorSettings }>('/admin/operator-settings').subscribe({
      next: (res) => {
        this.settings = res.settings;
        this.loading = false;
      },
      error: () => {
        this.loading = false;
        this.toast.error('Failed to load operator settings', { title: 'Load failed' });
      },
    });
  }

  save(section: SectionKey): void {
    if (!this.settings) return;

    // Block the save before it leaves the browser if it would disable every
    // payment method — the backend rejects it too, this just spares the round trip.
    if (section === 'payments' && !this.paymentsHasOne) {
      this.toast.error('At least one payment method must stay enabled.', { title: 'Save failed' });
      return;
    }

    this.saving[section] = true;

    const fd = new FormData();
    fd.append('_method', 'PATCH');

    const fields = this.sectionFields[section];
    for (const field of fields) {
      const raw = (this.settings as unknown as Record<string, unknown>)[field];
      if (raw === undefined) continue;

      if (typeof raw === 'boolean') {
        fd.append(field, raw ? '1' : '0');
      } else if (raw === null) {
        fd.append(field, '');
      } else {
        fd.append(field, String(raw));
      }
    }

    this.api
      .postMultipart<{ settings: OperatorSettings; message: string }>(
        '/admin/operator-settings',
        fd,
      )
      .subscribe({
        next: (res) => {
          this.saving[section] = false;
          this.settings = res.settings;
          if (section === 'serviceNames') this.loadServices();
          this.toast.success(`${this.titleFor(section)} saved`);
        },
        error: (err) => {
          this.saving[section] = false;
          const detail = err?.error?.errors
            ? Object.values(err.error.errors).flat().join(', ')
            : err?.error?.message || 'Save failed';
          this.toast.error(detail, { title: 'Save failed' });
        },
      });
  }

  private titleFor(section: SectionKey): string {
    if (section === 'serviceNames') return 'Service names';
    return this.sections.find((s) => s.key === section)?.label ?? 'Settings';
  }

  // ===================== Services (ride catalogue) =====================

  loadServices(): void {
    const cityId = this.servicesCityId ?? this.cityCtx.currentCityId;
    if (cityId == null) return;
    this.servicesCityId = cityId;
    this.servicesLoading = true;
    this.servicesError = null;
    this.api.get<{ scopes: RideScope[] }>(`/admin/cities/${cityId}/ride-products`).subscribe({
      next: (res) => {
        this.servicesScopes = res?.scopes ?? [];
        this.servicesLoading = false;
      },
      error: (err) => {
        this.servicesError = err?.error?.message || 'Could not load the service catalogue.';
        this.servicesLoading = false;
      },
    });
  }

  // Both toggles address the catalogue by scope/mode key rather than row id —
  // the settings are global now, so there are no per-city rows to point at. Each
  // response returns the whole tree, which keeps the master switch and its three
  // children in sync without a second request.
  toggleScope(scope: RideScope): void {
    if (this.servicesBusy) return;
    this.servicesBusy = `scope-${scope.scope}`;
    this.api
      .patch<{ scopes: RideScope[]; message: string }>(
        `/admin/cities/${this.servicesCityId}/ride-products/scopes/${scope.scope}`,
        { is_active: !scope.is_active },
      )
      .subscribe({
        next: (res) => {
          this.servicesBusy = null;
          const wasActive = scope.is_active;
          if (res?.scopes) this.servicesScopes = res.scopes;
          this.toast.success(`${scope.name} ${wasActive ? 'hidden' : 'enabled'} in every city`);
        },
        error: (err) => {
          this.servicesBusy = null;
          this.toast.error(err?.error?.message || 'Could not update the service.', { title: 'Update failed' });
        },
      });
  }

  toggleMode(scope: RideScope, mode: RideMode): void {
    if (this.servicesBusy) return;
    this.servicesBusy = `mode-${scope.scope}-${mode.mode}`;
    this.api
      .patch<{ mode: RideMode; scopes: RideScope[]; message: string }>(
        `/admin/cities/${this.servicesCityId}/ride-products/scopes/${scope.scope}/modes/${mode.mode}`,
        { is_active: !mode.is_active },
      )
      .subscribe({
        next: (res) => {
          this.servicesBusy = null;
          if (res?.scopes) this.servicesScopes = res.scopes;
          this.toast.success(`${scope.name} ${mode.name} ${res?.mode?.is_active ? 'enabled' : 'hidden'} in every city`);
        },
        error: (err) => {
          this.servicesBusy = null;
          this.toast.error(err?.error?.message || 'Could not update the service.', { title: 'Update failed' });
        },
      });
  }

  modeSub(mode: RideMode): string {
    switch (mode.mode) {
      case 'private': return 'Normal solo rides booked with a driver.';
      case 'fixed': return 'Fixed-route seat bookings with boarding codes.';
      case 'shuttle': return 'Shared shuttle journeys on set routes.';
      default: return '';
    }
  }
}
