import { AfterViewInit, Component, ElementRef, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import $ from 'jquery';
import moment from 'moment';
import 'daterangepicker';
import { forkJoin } from 'rxjs';
import { MultiSelectModule } from 'primeng/multiselect';
import { ApiService } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { DriverRouteGroupsPanelComponent } from './driver-route-groups-panel.component';
import {
  ButtonComponent,
  DrawerComponent,
  FilterPillComponent,
  FilterSelectComponent,
  IconComponent,
  InputComponent,
  ModalComponent,
  StatusPillComponent,
} from '../../ui';

const DRIVER_SERVICE_MODE_OPTIONS = [
  { value: 'private', label: 'Private Rides' },
  { value: 'fixed', label: 'Fixed Routes' },
  { value: 'shuttle', label: 'Shuttle' },
] as const;

type DriverServiceMode = typeof DRIVER_SERVICE_MODE_OPTIONS[number]['value'];

interface DriverRideCatalogMode {
  mode: DriverServiceMode;
  name: string;
  display_name?: string | null;
}

interface DriverProfile {
  id: number;
  user_id: number;
  name: string | null;
  phone: string | null;
  email: string | null;
  avatar_path?: string | null;
  avatar_url?: string | null;
  dob: string | null;
  address: string | null;
  date_registered: string;
  last_login_at: string | null;
  app_version: string | null;
  os_version: string | null;
  device_type: string | null;
  ride_type_name: string | null;
  vehicle_type_id: number | null;
  vehicle_type_name: string | null;
  city_vehicle_type_id: number | null;
  city_vehicle_type_name: string | null;
  vehicle_type: string | null;
  vehicle_model: string | null;
  vehicle_color: string | null;
  vehicle_reg_no: string | null;
  city_id: number | null;
  city_ids?: number[];
  cities?: { id: number; name: string }[];
  city_name: string | null;
  city_names?: string | null;
  service_scope?: 'local' | 'outstation' | 'both' | string | null;
  service_mode?: 'private' | 'fixed' | 'shuttle' | string | null;
  approval_status: 'approved' | 'rejected' | 'pending' | string;
  is_online: boolean;
  is_suspended: boolean;
  suspended_reason: string | null;
  is_active: boolean;
  deactivated_at: string | null;
  deactivated_reason: string | null;
  rating_avg: number | null;
  rating_count: number | null;
  wallet_balance: number;
  pending_payout?: number;
  total_rides: number;
  current_lat?: number | null;
  current_lng?: number | null;
  current_location_updated_at?: string | null;
  push_unsubscribed: boolean;
  payout_account_status?: string | null;
  payout_method?: string | null;
  payout_beneficiary_name?: string | null;
  payout_bank_last4?: string | null;
  payout_ifsc?: string | null;
  payout_upi?: string | null;
  active_subscription?: {
    id: number;
    plan_title: string;
    amount_paid: number;
    commission_percent: number;
    pricing_model: string;
    payment_method: string;
    starts_at: string;
    expires_at: string;
    auto_renew: boolean;
  } | null;
}

type TabKey = 'rides' | 'wallet' | 'cancelled' | 'routes' | 'specs';

const BLOCK_REASONS = [
  'Spam / fraud',
  'Abusive behaviour',
  'Payment dispute',
  'Safety violation',
  'Document issue',
  'Other',
];

@Component({
  selector: 'app-driver-detail',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MultiSelectModule,
    DatePipe,
    RouterLink,
    ButtonComponent,
    DrawerComponent,
    FilterPillComponent,
    FilterSelectComponent,
    IconComponent,
    InputComponent,
    ModalComponent,
    StatusPillComponent,
    DriverRouteGroupsPanelComponent,
  ],
  template: `
    <div class="stripe-console" *ngIf="profile; else loadingTpl">
      
      <!-- Top Action Bar -->
      <div class="top-action-bar">
        <div class="top-action-bar__left">
          <a routerLink="/drivers" class="crumb-back">
            <tm-icon name="chevron-left" [size]="14" />
            <span>Drivers</span>
          </a>
          <span class="crumb-divider">/</span>
          <span class="crumb-id mono">#{{ profile.id }}</span>
          <span class="crumb-title">{{ profile.name || 'Driver' }}</span>
        </div>

        <div class="top-action-bar__right">
          <button class="btn-action btn-action--primary" (click)="openPayout()">
            <tm-icon name="rupee" [size]="13" />
            <span>Record Payout</span>
          </button>
          <button class="btn-action" (click)="openEditProfile()">
            <tm-icon name="edit" [size]="13" />
            <span>Edit Profile</span>
          </button>
          <button class="btn-action" (click)="sendOtp()" [disabled]="otpSending || !profile.phone">
            <tm-icon name="key" [size]="13" />
            <span>{{ otpSending ? 'Sending…' : 'Send OTP' }}</span>
          </button>
          <button class="btn-action" [class.btn-action--danger]="!profile.is_suspended" (click)="openBlockDelete()">
            <tm-icon [name]="profile.is_suspended ? 'check' : 'shield'" [size]="13" />
            <span>{{ profile.is_suspended ? 'Unblock' : 'Block / Delete' }}</span>
          </button>
        </div>
      </div>

      <!-- Hero Header & Overview Strip -->
      <section class="console-hero">
        <div class="hero-identity">
          <div class="hero-avatar" [class.is-online]="profile.is_online">
            <img *ngIf="profile.avatar_url || profile.avatar_path" [src]="profile.avatar_url || profile.avatar_path" alt="" />
            <span *ngIf="!(profile.avatar_url || profile.avatar_path)">{{ initials(profile.name) }}</span>
          </div>

          <div class="hero-headings">
            <div class="hero-row-1">
              <h1 class="hero-name">{{ profile.name || 'Unnamed Driver' }}</h1>
              <span class="hero-badge mono">ID: #{{ profile.id }}</span>
              <tm-status-pill [tone]="approvalTone">{{ profile.approval_status | titlecase }}</tm-status-pill>
              <tm-status-pill *ngIf="profile.is_online" tone="success">Online</tm-status-pill>
              <tm-status-pill *ngIf="!profile.is_online" tone="neutral">Offline</tm-status-pill>
              <span *ngIf="profile.active_subscription" class="plan-tag">
                <tm-icon name="shield" [size]="11" />
                {{ profile.active_subscription.plan_title }} ({{ profile.active_subscription.commission_percent }}% Comm)
              </span>
              <tm-status-pill *ngIf="profile.is_suspended" tone="danger">Blocked</tm-status-pill>
            </div>

            <div class="hero-row-2">
              <span class="meta-item mono">
                <tm-icon name="phone" [size]="12" /> {{ profile.phone || 'No phone' }}
                <button type="button" class="btn-text-action" (click)="openAdminPhoneModal()">Change</button>
              </span>
              <span class="meta-dot">·</span>
              <span class="meta-item" *ngIf="profile.email"><tm-icon name="envelope" [size]="12" /> {{ profile.email }}</span>
              <span class="meta-dot" *ngIf="profile.email">·</span>
              <span class="meta-item mono"><tm-icon name="car" [size]="12" /> {{ profile.vehicle_reg_no || 'No reg' }} {{ profile.vehicle_model ? '(' + profile.vehicle_model + ')' : '' }}</span>
              <span class="meta-dot">·</span>
              <span class="meta-item"><tm-icon name="star" [size]="12" /> {{ profile.rating_count ? (profile.rating_avg | number:'1.1-1') + ' ★ (' + profile.rating_count + ')' : '5.0 ★' }}</span>
              <span class="meta-dot">·</span>
              <span class="meta-item">Joined {{ profile.date_registered | date:'mediumDate' }}</span>
            </div>
          </div>
        </div>

        <!-- 5 Unified Metric Columns -->
        <div class="hero-metrics-strip">
          <div class="metric-cell" [class.metric-cell--neg]="(profile.wallet_balance || 0) < 0">
            <span class="m-label">Wallet Balance</span>
            <div class="m-value-wrap">
              <strong class="m-value">₹ {{ (profile.wallet_balance || 0) | number:'1.2-2' }}</strong>
              <span class="m-sub" [class.text-danger]="(profile.wallet_balance || 0) < 0" [class.text-emerald]="(profile.wallet_balance || 0) >= 0">
                {{ (profile.wallet_balance || 0) < 0 ? 'Negative' : 'Available' }}
              </span>
            </div>
          </div>

          <div class="metric-cell metric-cell--payout">
            <span class="m-label">Pending Payout</span>
            <div class="m-value-wrap">
              <strong class="m-value text-emerald">₹ {{ (profile.pending_payout || 0) | number:'1.2-2' }}</strong>
              <button class="m-link text-emerald font-bold" (click)="openPayout()">Pay Now →</button>
            </div>
          </div>

          <div class="metric-cell">
            <span class="m-label">Subscription Plan</span>
            <div class="m-value-wrap">
              <strong class="m-value m-value--sm">
                {{ profile.active_subscription ? profile.active_subscription.plan_title : 'Standard 10%' }}
              </strong>
              <span class="m-tag" *ngIf="profile.active_subscription">0% Comm</span>
            </div>
          </div>

          <div class="metric-cell">
            <span class="m-label">Completed Rides</span>
            <div class="m-value-wrap">
              <strong class="m-value">{{ profile.total_rides || 0 }}</strong>
              <span class="m-sub">All-time</span>
            </div>
          </div>

          <div class="metric-cell">
            <span class="m-label">GPS Telemetry</span>
            <div class="m-value-wrap">
              <strong class="m-value m-value--sm" [class.text-danger]="isLocationStale" [class.text-emerald]="!isLocationStale && profile.is_online">
                {{ profile.current_location_updated_at ? timeAgo(profile.current_location_updated_at) : 'Offline' }}
              </strong>
              <a *ngIf="profile.current_lat != null && profile.current_lng != null" [href]="'https://www.google.com/maps?q=' + profile.current_lat + ',' + profile.current_lng" target="_blank" class="m-link">
                Maps ↗
              </a>
            </div>
          </div>
        </div>
      </section>

      <!-- Compact 4-Column Specification Strip (Always on page) -->
      <section class="overview-specs-bar">
        <div class="spec-col">
          <span class="sc-head"><tm-icon name="user" [size]="12" /> Driver Identity</span>
          <div class="sc-row"><span class="sc-lbl">Address:</span><span class="sc-val">{{ profile.address || '—' }}</span></div>
          <div class="sc-row"><span class="sc-lbl">DOB:</span><span class="sc-val">{{ profile.dob || '—' }}</span></div>
          <div class="sc-row"><span class="sc-lbl">App Login:</span><span class="sc-val">{{ profile.last_login_at ? timeAgo(profile.last_login_at) : '—' }}</span></div>
        </div>

        <div class="spec-col">
          <span class="sc-head"><tm-icon name="car" [size]="12" /> Vehicle Specifications</span>
          <div class="sc-row"><span class="sc-lbl">Reg Plate:</span><span class="sc-val mono">{{ profile.vehicle_reg_no || '—' }}</span></div>
          <div class="sc-row"><span class="sc-lbl">Model & Color:</span><span class="sc-val">{{ profile.vehicle_model || '—' }} ({{ profile.vehicle_color || '—' }})</span></div>
          <div class="sc-row"><span class="sc-lbl">Category & City:</span><span class="sc-val">{{ profile.vehicle_type_name || profile.vehicle_type || '—' }} · {{ profile.city_name || 'All' }}</span></div>
        </div>

        <div class="spec-col">
          <span class="sc-head"><tm-icon name="shield" [size]="12" /> Subscription Details</span>
          <ng-container *ngIf="profile.active_subscription; else noSubCol">
            <div class="sc-row"><span class="sc-lbl">Fee Paid:</span><span class="sc-val mono">₹ {{ profile.active_subscription.amount_paid | number:'1.2-2' }} ({{ profile.active_subscription.payment_method | uppercase }})</span></div>
            <div class="sc-row"><span class="sc-lbl">Commission:</span><span class="sc-val text-emerald font-bold">{{ profile.active_subscription.commission_percent }}% (Keep {{ 100 - profile.active_subscription.commission_percent }}%)</span></div>
            <div class="sc-row"><span class="sc-lbl">Expires:</span><span class="sc-val">{{ profile.active_subscription.expires_at | date:'mediumDate' }}</span></div>
          </ng-container>
          <ng-template #noSubCol>
            <div class="sc-row"><span class="sc-lbl">Status:</span><span class="sc-val text-muted">No active plan · 10% Platform fee</span></div>
          </ng-template>
        </div>

        <div class="spec-col">
          <span class="sc-head"><tm-icon name="shield" [size]="12" /> Governance & App</span>
          <div class="sc-row"><span class="sc-lbl">App Version:</span><span class="sc-val mono">v{{ profile.app_version || '1.0' }} ({{ profile.os_version || 'Android' }})</span></div>
          <div class="sc-row"><span class="sc-lbl">Notifications:</span><span class="sc-val">{{ profile.push_unsubscribed ? 'Opted Out' : 'Subscribed' }}</span></div>
          <div class="sc-row">
            <span class="sc-lbl">Settings:</span>
            <button class="sc-btn" (click)="openUnsub()">Manage Push Alerts</button>
          </div>
        </div>
      </section>

      <!-- Centerpiece Workspace Container -->
      <main class="console-workspace">
        
        <!-- Tab Navigation Bar -->
        <header class="workspace-tabs-header">
          <nav class="console-tabs-nav" role="tablist">
            <button
              *ngFor="let t of historyTabs"
              type="button"
              class="c-tab-btn"
              [class.is-active]="activeTab === t.key"
              (click)="setTab(t.key)"
            >
              <tm-icon [name]="t.icon" [size]="13" />
              <span>{{ t.label }}</span>
              <span class="c-tab-badge" *ngIf="t.key !== 'routes' && t.key !== 'specs'">{{ tabCount(t.key) }}</span>
            </button>
          </nav>

          <!-- Search & Filter Controls -->
          <div class="workspace-toolbar" *ngIf="activeTab === 'rides' || activeTab === 'wallet' || activeTab === 'cancelled'">
            <div class="search-wrap">
              <tm-input icon="search" [placeholder]="searchPlaceholder" [(ngModel)]="tabSearch" />
            </div>

            <div *ngIf="activeTab === 'rides'" class="rides-toolbar-group">
              <tm-filter-select
                icon="car"
                ariaLabel="Ride mode"
                allLabel="All Modes"
                [includeAll]="true"
                [options]="rideModeOptions"
                [value]="rideMode"
                (valueChange)="rideMode = $event"
              />
              
              <div class="date-range-box" [class.has-value]="rideDateFrom || rideDateTo" (click)="triggerDatePicker()">
                <tm-icon name="calendar" [size]="12" />
                <input
                  #rideRange
                  type="text"
                  readonly
                  class="date-input"
                  placeholder="Date range"
                  [value]="rangeLabel"
                />
                <button *ngIf="rideDateFrom || rideDateTo" type="button" class="btn-x" (click)="clearRideDates(); $event.stopPropagation()">
                  <tm-icon name="x" [size]="11" />
                </button>
              </div>

              <button *ngIf="tabSearch.trim() || rideMode !== 'all' || rideDateFrom || rideDateTo" type="button" class="btn-reset" (click)="clearRideFilters()">
                Reset
              </button>
            </div>
          </div>
        </header>

        <!-- Rides Live Financial Ribbon -->
        <div *ngIf="activeTab === 'rides' && rideSummary" class="rides-financial-ribbon">
          <div class="rf-pill"><span class="rf-lbl">Showing:</span><strong>{{ filteredRides.length }} Trips</strong></div>
          <div class="rf-pill"><span class="rf-lbl">Fares Collected:</span><strong class="text-emerald">₹ {{ rideSummary.fares_collected | number:'1.2-2' }}</strong></div>
          <div class="rf-pill" *ngIf="rideSummary.refunded > 0"><span class="rf-lbl">Refunds:</span><strong class="text-danger">₹ {{ rideSummary.refunded | number:'1.2-2' }}</strong></div>
        </div>

        <!-- Loading State -->
        <div *ngIf="loadingTab" class="view-loading">
          <div class="spinner"></div>
          <span>Loading records…</span>
        </div>

        <!-- =================== TAB 1: RIDES TABLE =================== -->
        <div *ngIf="!loadingTab && activeTab === 'rides'" class="console-table-wrap">
          <table class="console-table">
            <thead>
              <tr>
                <th style="width: 85px;">Trip ID</th>
                <th style="width: 155px;">Date & Time</th>
                <th>Rider Details</th>
                <th>Route (Pickup → Destination)</th>
                <th style="width: 110px;">Mode</th>
                <th style="width: 110px; text-align: right;">Fare (₹)</th>
                <th style="width: 130px;">Payment</th>
                <th style="width: 105px; text-align: center;">Status</th>
              </tr>
            </thead>
            <tbody>
              <tr *ngFor="let r of filteredRides" class="c-row">
                <td class="cell-id mono"><strong>#{{ r.id }}</strong></td>
                <td class="cell-time">
                  <div class="time-main">{{ r.created_at | date:'MMM d, y' }}</div>
                  <div class="time-sub text-muted">{{ r.created_at | date:'HH:mm' }}<span *ngIf="r.completed_at"> → {{ r.completed_at | date:'HH:mm' }}</span></div>
                </td>
                <td class="cell-rider">
                  <div class="rider-row">
                    <strong>{{ r.rider_name || r.customer?.name || 'Passenger' }}</strong>
                    <span *ngIf="r.rider_extra_count" class="extra-pill">+{{ r.rider_extra_count }}</span>
                  </div>
                  <div class="rider-phone mono text-muted">{{ r.customer?.phone || r.rider_phone || '—' }}</div>
                </td>
                <td class="cell-route">
                  <div class="point-row">
                    <span class="dot dot-from"></span>
                    <span class="addr-text" [title]="r.pickup_address || pretty(r.pickup_lat, r.pickup_lng)">
                      {{ r.pickup_address || pretty(r.pickup_lat, r.pickup_lng) }}
                    </span>
                  </div>
                  <div class="point-row">
                    <span class="dot dot-to"></span>
                    <span class="addr-text" [title]="r.drop_address || pretty(r.drop_lat, r.drop_lng)">
                      {{ r.drop_address || pretty(r.drop_lat, r.drop_lng) }}
                    </span>
                  </div>
                  <div class="route-sub" *ngIf="r.distance_km">
                    <span>{{ r.distance_km }} km</span>
                    <span *ngIf="r.duration_min"> · {{ r.duration_min }} mins</span>
                  </div>
                </td>
                <td class="cell-mode">
                  <span class="mode-badge" [attr.data-mode]="rideModeOf(r)">
                    {{ rideModeLabel(r) }}
                  </span>
                  <div *ngIf="r.route?.name" class="route-title text-muted">{{ r.route.name }}</div>
                </td>
                <td class="cell-fare" style="text-align: right;">
                  <strong class="fare-num">₹ {{ (r.final_fare ?? r.estimated_fare ?? 0) | number:'1.2-2' }}</strong>
                  <div *ngIf="r.final_fare != null && r.estimated_fare != null && r.final_fare !== r.estimated_fare" class="fare-est text-muted">
                    Est. ₹{{ r.estimated_fare | number:'1.2-2' }}
                  </div>
                </td>
                <td class="cell-pay">
                  <span class="pay-chip" [class.is-paid]="r.payment_status === 'PAID'">
                    {{ r.payment_method ? (r.payment_method | uppercase) : 'UNPAID' }}
                    <span *ngIf="r.payment_status">· {{ paymentStatusText(r.payment_status) }}</span>
                  </span>
                  <div *ngIf="r.refund_status === 'REFUNDED'" class="refund-chip text-danger">
                    Refunded ₹{{ r.refund_amount | number:'1.2-2' }}
                  </div>
                </td>
                <td class="cell-status" style="text-align: center;">
                  <span class="status-pill" [attr.data-status]="statusBucket(r.status)">
                    {{ statusDisplay(r.status) }}
                  </span>
                </td>
              </tr>
              <tr *ngIf="filteredRides.length === 0">
                <td colspan="8" class="empty-cell">
                  <div class="empty-box">
                    <tm-icon name="car" [size]="24" />
                    <h4>No rides match your filter</h4>
                    <p>Change keyword search, ride mode or clear the date range.</p>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- =================== TAB 2: WALLET LEDGER TABLE =================== -->
        <div *ngIf="!loadingTab && activeTab === 'wallet'" class="console-table-wrap">
          <table class="console-table">
            <thead>
              <tr>
                <th style="width: 55px; text-align: center;">Type</th>
                <th style="width: 155px;">Date & Time</th>
                <th>Transaction Details & Description</th>
                <th style="width: 150px;">Reference ID</th>
                <th style="width: 130px; text-align: right;">Amount (₹)</th>
              </tr>
            </thead>
            <tbody>
              <tr *ngFor="let t of filteredWallet" class="c-row">
                <td style="text-align: center;">
                  <span class="txn-bubble" [class.is-debit]="t.type === 'debit'" [class.is-credit]="t.type !== 'debit'">
                    <tm-icon [name]="t.type === 'debit' ? 'trash' : 'plus'" [size]="11" />
                  </span>
                </td>
                <td class="cell-time">
                  <div class="time-main">{{ t.created_at | date:'MMM d, y' }}</div>
                  <div class="time-sub text-muted">{{ t.created_at | date:'HH:mm:ss' }}</div>
                </td>
                <td class="cell-desc">
                  <strong class="txn-title">{{ t.type | titlecase }}</strong>
                  <p class="txn-reason">{{ t.reason || 'No description recorded.' }}</p>
                </td>
                <td class="cell-ref mono text-muted">
                  <span *ngIf="t.engagement_id">#ENG-{{ t.engagement_id }}</span>
                  <span *ngIf="!t.engagement_id">—</span>
                </td>
                <td class="cell-amount" style="text-align: right;">
                  <strong class="amount-val" [class.is-debit]="t.type === 'debit'" [class.is-credit]="t.type !== 'debit'">
                    {{ t.type === 'debit' ? '−' : '+' }} ₹ {{ t.amount | number:'1.2-2' }}
                  </strong>
                </td>
              </tr>
              <tr *ngIf="filteredWallet.length === 0">
                <td colspan="5" class="empty-cell">
                  <div class="empty-box">
                    <tm-icon name="tag" [size]="24" />
                    <h4>No wallet ledger transactions</h4>
                    <p>All driver debits, subscriptions, topups, and adjustments will appear here.</p>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- =================== TAB 3: CANCELLATIONS TABLE =================== -->
        <div *ngIf="!loadingTab && activeTab === 'cancelled'" class="console-table-wrap">
          <table class="console-table">
            <thead>
              <tr>
                <th style="width: 90px;">Trip ID</th>
                <th style="width: 155px;">Cancelled At</th>
                <th>Rider Details</th>
                <th>Cancellation Reason</th>
                <th style="width: 110px; text-align: center;">Status</th>
              </tr>
            </thead>
            <tbody>
              <tr *ngFor="let c of filteredCancelled" class="c-row">
                <td class="cell-id mono"><strong>#{{ c.id }}</strong></td>
                <td class="cell-time">
                  <div class="time-main">{{ c.created_at | date:'MMM d, y' }}</div>
                  <div class="time-sub text-muted">{{ c.created_at | date:'HH:mm' }}</div>
                </td>
                <td class="cell-rider">
                  <strong>{{ c.rider_name || c.customer?.name || 'Passenger' }}</strong>
                  <div class="mono text-muted">{{ c.customer?.phone || '—' }}</div>
                </td>
                <td class="cell-desc">
                  <span class="cancel-msg">{{ c.cancelled_reason || 'No cancellation reason provided.' }}</span>
                </td>
                <td class="cell-status" style="text-align: center;">
                  <span class="status-pill is-cancelled">Cancelled</span>
                </td>
              </tr>
              <tr *ngIf="filteredCancelled.length === 0">
                <td colspan="5" class="empty-cell">
                  <div class="empty-box">
                    <tm-icon name="x" [size]="24" />
                    <h4>0 cancellations on record</h4>
                    <p>This driver has fulfilled all accepted booking requests.</p>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- =================== TAB 4: ROUTE ALLOCATION =================== -->
        <div *ngIf="!loadingTab && activeTab === 'routes'" class="routes-container">
          <app-driver-route-groups-panel [driverId]="driverId"></app-driver-route-groups-panel>
        </div>

        <!-- =================== TAB 5: FULL SPECIFICATIONS =================== -->
        <div *ngIf="!loadingTab && activeTab === 'specs'" class="full-specs-container">
          <div class="specs-grid">
            <div class="spec-panel">
              <div class="spec-panel-head">
                <tm-icon name="user" [size]="13" />
                <h3>Personal Identity</h3>
                <button class="sp-edit-btn" (click)="openEditProfile()">Edit</button>
              </div>
              <div class="sp-list">
                <div class="sp-row"><span>Full Name</span><strong>{{ profile.name || 'Unnamed Driver' }}</strong></div>
                <div class="sp-row">
                  <span>Phone Number</span>
                  <div style="display: inline-flex; align-items: center; gap: 8px;">
                    <strong class="mono">{{ profile.phone || '—' }}</strong>
                    <button type="button" class="btn-text-action" (click)="openAdminPhoneModal()">Change</button>
                  </div>
                </div>
                <div class="sp-row"><span>Email Address</span><strong>{{ profile.email || '—' }}</strong></div>
                <div class="sp-row"><span>Date of Birth</span><strong>{{ profile.dob || '—' }}</strong></div>
                <div class="sp-row"><span>Residential Address</span><strong>{{ profile.address || '—' }}</strong></div>
              </div>
            </div>

            <div class="spec-panel">
              <div class="spec-panel-head">
                <tm-icon name="car" [size]="13" />
                <h3>Vehicle & Fleet Specs</h3>
                <button class="sp-edit-btn" (click)="openEditProfile()">Edit</button>
              </div>
              <div class="sp-list">
                <div class="sp-row"><span>Assigned Cities</span><strong>{{ profile.city_names || profile.city_name || 'All Cities' }}</strong></div>
                <div class="sp-row">
                  <span>Service Scope</span>
                  <strong>
                    <span *ngIf="profile.service_scope === 'both'" class="badge" style="background: rgba(124, 58, 237, 0.12); color: #7c3aed; padding: 2px 8px; border-radius: 4px; font-weight: 700; font-size: 11.5px;">Both (Local &amp; Outstation)</span>
                    <span *ngIf="profile.service_scope === 'local'" class="badge" style="background: rgba(37, 99, 235, 0.12); color: #2563eb; padding: 2px 8px; border-radius: 4px; font-weight: 700; font-size: 11.5px;">Local Only</span>
                    <span *ngIf="profile.service_scope === 'outstation'" class="badge" style="background: rgba(234, 88, 12, 0.12); color: #ea580c; padding: 2px 8px; border-radius: 4px; font-weight: 700; font-size: 11.5px;">Outstation Only</span>
                    <span *ngIf="!profile.service_scope">—</span>
                  </strong>
                </div>
                <div class="sp-row"><span>Service Mode</span><strong>{{ profile.service_mode ? (profile.service_mode | titlecase) : '—' }}</strong></div>
                <div class="sp-row"><span>Registration No</span><strong class="mono">{{ profile.vehicle_reg_no || '—' }}</strong></div>
                <div class="sp-row"><span>Vehicle Model</span><strong>{{ profile.vehicle_model || '—' }}</strong></div>
                <div class="sp-row"><span>Vehicle Colour</span><strong>{{ profile.vehicle_color || '—' }}</strong></div>
                <div class="sp-row"><span>Vehicle Category</span><strong>{{ profile.vehicle_type_name || profile.vehicle_type || '—' }}</strong></div>
                <div class="sp-row"><span>City Vehicle Type</span><strong>{{ profile.city_vehicle_type_name || '—' }}</strong></div>
              </div>
            </div>

            <div class="spec-panel">
              <div class="spec-panel-head">
                <tm-icon name="shield" [size]="13" />
                <h3>Subscription Plan</h3>
              </div>
              <div class="sp-list" *ngIf="profile.active_subscription; else noSubTab">
                <div class="sp-row"><span>Plan Title</span><strong class="text-purple">{{ profile.active_subscription.plan_title }}</strong></div>
                <div class="sp-row"><span>Fee Paid</span><strong class="mono">₹ {{ profile.active_subscription.amount_paid | number:'1.2-2' }}</strong></div>
                <div class="sp-row"><span>Commission</span><strong class="text-emerald">{{ profile.active_subscription.commission_percent }}% (Keep {{ 100 - profile.active_subscription.commission_percent }}%)</strong></div>
                <div class="sp-row"><span>Payment Channel</span><strong>{{ profile.active_subscription.payment_method | uppercase }}</strong></div>
                <div class="sp-row"><span>Expiration Date</span><strong>{{ profile.active_subscription.expires_at | date:'mediumDate' }}</strong></div>
                <div class="sp-row"><span>Auto-Renew</span><strong>{{ profile.active_subscription.auto_renew ? 'Active' : 'Disabled' }}</strong></div>
              </div>
              <ng-template #noSubTab>
                <p class="text-muted" style="font-size: 12px; margin: 4px 0;">No active subscription plan. Standard 10% platform fee applies.</p>
              </ng-template>
            </div>

            <div class="spec-panel">
              <div class="spec-panel-head">
                <tm-icon name="pin" [size]="13" />
                <h3>System Telemetry & Status</h3>
              </div>
              <div class="sp-list">
                <div class="sp-row"><span>App Version</span><strong class="mono">v{{ profile.app_version || '1.0' }} ({{ profile.os_version || 'Android' }})</strong></div>
                <div class="sp-row"><span>Last Login</span><strong>{{ profile.last_login_at ? timeAgo(profile.last_login_at) : '—' }}</strong></div>
                <div class="sp-row">
                  <span>GPS Coords</span>
                  <strong class="mono" *ngIf="profile.current_lat != null">{{ profile.current_lat | number:'1.4-4' }}, {{ profile.current_lng | number:'1.4-4' }}</strong>
                  <strong *ngIf="profile.current_lat == null">—</strong>
                </div>
                <div class="sp-row" *ngIf="profile.current_lat != null">
                  <span>Google Maps</span>
                  <a [href]="'https://www.google.com/maps?q=' + profile.current_lat + ',' + profile.current_lng" target="_blank" class="sp-link">Open in Maps ↗</a>
                </div>
                <div class="sp-row"><span>Push Alerts</span><strong>{{ profile.push_unsubscribed ? 'Opted Out' : 'Subscribed' }}</strong></div>
              </div>
              <div class="sp-footer">
                <tm-button variant="outline" size="sm" icon="bell" (clicked)="openUnsub()">
                  Manage Notifications
                </tm-button>
              </div>
            </div>
          </div>
        </div>

      </main>

    </div>

    <!-- Loading State -->
    <ng-template #loadingTpl>
      <div class="page-loading-wrap">
        <div class="spinner"></div>
        <span>Loading driver workspace…</span>
      </div>
    </ng-template>

    <!-- =================== Record Payout Modal =================== -->
    <tm-modal
      [open]="payoutOpen"
      title="Record Driver Payout Transfer"
      (closed)="payoutOpen = false"
    >
      <div slot="body" class="modal-form-body">
        <p class="form-hint">
          Bank and UPI transfers occur outside DreamCabs. Recording this entry credits the driver settlement ledger.
        </p>

        <!-- Driver Payout Destination Box -->
        <div *ngIf="payoutSummary && (payoutSummary.payout_upi || payoutSummary.payout_bank_last4)" class="destination-card">
          <div class="dest-head">Driver Receiving Account:</div>
          <div *ngIf="payoutSummary.payout_upi" class="dest-row">
            <span class="dest-lbl">UPI VPA / GPay ID:</span>
            <strong class="dest-val mono">{{ payoutSummary.payout_upi }}</strong>
          </div>
          <div *ngIf="payoutSummary.payout_bank_last4" class="dest-row">
            <span class="dest-lbl">Bank Account:</span>
            <strong class="dest-val mono">•••• {{ payoutSummary.payout_bank_last4 }} (IFSC: {{ payoutSummary.payout_ifsc }})</strong>
          </div>
          <div *ngIf="payoutSummary.payout_beneficiary_name" class="dest-row">
            <span class="dest-lbl">Beneficiary Name:</span>
            <strong class="dest-val">{{ payoutSummary.payout_beneficiary_name }}</strong>
          </div>
        </div>

        <div class="payout-summary-box" *ngIf="payoutSummary; else payoutLoadingTpl">
          <div class="payout-sum-row payout-sum-row--highlight">
            <span>Pending Payout Due</span>
            <strong class="text-emerald">₹ {{ (payoutSummary.pending_payout ?? payoutSummary.earned_remaining ?? 0) | number:'1.2-2' }}</strong>
          </div>
          <div class="payout-sum-row">
            <span>Total Online Rides Collected</span>
            <strong>₹ {{ (payoutSummary.money_collected || 0) | number:'1.2-2' }}</strong>
          </div>
          <div class="payout-sum-row">
            <span>Already Transferred</span>
            <strong>₹ {{ (payoutSummary.money_transferred ?? payoutSummary.total_paid_out ?? 0) | number:'1.2-2' }}</strong>
          </div>
          <div class="payout-sum-row">
            <span>Current Driver Wallet Balance</span>
            <strong>₹ {{ payoutSummary.balance | number:'1.2-2' }}</strong>
          </div>
        </div>

        <ng-template #payoutLoadingTpl>
          <div class="modal-loading-hint">Loading payout calculations…</div>
        </ng-template>

        <div class="form-group">
          <div class="form-label-row">
            <label class="form-label"><span class="req">*</span> Transfer Amount (₹)</label>
            <button
              *ngIf="payoutSummary && ((payoutSummary.pending_payout || payoutSummary.earned_remaining || 0) > 0)"
              type="button"
              class="btn-fill-amount"
              (click)="payoutAmount = (payoutSummary.pending_payout || payoutSummary.earned_remaining || 0)"
            >Fill ₹{{ (payoutSummary.pending_payout || payoutSummary.earned_remaining || 0) | number:'1.2-2' }}</button>
          </div>
          <input
            class="form-control"
            type="number"
            min="0.01"
            step="0.01"
            [(ngModel)]="payoutAmount"
            placeholder="0.00"
          />
        </div>

        <div class="form-group">
          <label class="form-label"><span class="req">*</span> Transfer Method</label>
          <select class="form-control" [(ngModel)]="payoutMethod">
            <option value="gpay">GPay / UPI Transfer</option>
            <option value="bank">Bank Transfer (NEFT / IMPS / RTGS)</option>
            <option value="cash">Cash Settlement</option>
            <option value="other">Other Payment Channel</option>
          </select>
        </div>

        <div class="form-group">
          <label class="form-label">Transaction / UTR Reference Number</label>
          <input
            class="form-control"
            type="text"
            maxlength="120"
            [(ngModel)]="payoutReference"
            placeholder="e.g. UTR1234567890 or UPI Ref"
          />
        </div>

        <div class="form-group">
          <label class="form-label">Notes & Remarks</label>
          <input
            class="form-control"
            type="text"
            maxlength="300"
            [(ngModel)]="payoutNote"
            placeholder="e.g. Weekly driver earnings settlement"
          />
        </div>

        <div class="form-error-notice" *ngIf="payoutError">
          <tm-icon name="shield" [size]="14" />
          <span>{{ payoutError }}</span>
        </div>
      </div>

      <ng-container slot="footer">
        <tm-button variant="ghost" (clicked)="payoutOpen = false">Cancel</tm-button>
        <tm-button
          variant="green"
          icon="check"
          [loading]="payoutSaving"
          [disabled]="!payoutAmount || payoutAmount <= 0"
          (clicked)="submitPayout()"
        >
          Confirm Transfer
        </tm-button>
      </ng-container>
    </tm-modal>

    <!-- =================== Block / Delete Modal =================== -->
    <tm-modal
      [open]="blockDeleteOpen"
      [title]="profile?.is_suspended ? 'Manage Driver Access' : 'Restrict Driver Account'"
      (closed)="blockDeleteOpen = false"
    >
      <div slot="body" class="modal-form-body">
        <div class="action-toggle-row">
          <button
            type="button"
            class="toggle-card-btn"
            [class.is-active]="blockMode === 'block'"
            (click)="blockMode = 'block'"
          >
            <tm-icon [name]="profile?.is_suspended ? 'check' : 'shield'" [size]="16" />
            <strong>{{ profile?.is_suspended ? 'Unblock Driver' : 'Temporary Block' }}</strong>
            <small>Reversible account restriction</small>
          </button>
          
          <button
            type="button"
            class="toggle-card-btn toggle-card-btn--danger"
            [class.is-active]="blockMode === 'delete'"
            (click)="blockMode = 'delete'"
          >
            <tm-icon name="trash" [size]="16" />
            <strong>Delete Permanently</strong>
            <small>Irreversible deletion</small>
          </button>
        </div>

        <div *ngIf="blockMode === 'block' && !profile?.is_suspended" class="form-group mt-3">
          <label class="form-label"><span class="req">*</span> Reason for Suspension</label>
          <select class="form-control" [(ngModel)]="blockReason">
            <option value="">Select a reason…</option>
            <option *ngFor="let r of blockReasons" [value]="r">{{ r }}</option>
          </select>
        </div>

        <div *ngIf="blockMode === 'block' && profile?.is_suspended" class="info-alert mt-3">
          <tm-icon name="check" [size]="16" />
          <span>Unblocking will restore driver access immediately, allowing them to accept ride requests again.</span>
        </div>

        <div *ngIf="blockMode === 'delete'" class="form-group mt-3">
          <div class="danger-alert">
            <tm-icon name="trash" [size]="16" />
            <span>This action cannot be undone. Driver record and history will be permanently deleted.</span>
          </div>
          <label class="form-label mt-2"><span class="req">*</span> Deletion Rationale</label>
          <textarea
            class="form-control"
            rows="3"
            maxlength="100"
            [(ngModel)]="deleteReason"
            placeholder="Why is this driver being deleted?"
          ></textarea>
        </div>
      </div>

      <ng-container slot="footer">
        <tm-button variant="ghost" (clicked)="blockDeleteOpen = false">Cancel</tm-button>
        <tm-button
          *ngIf="blockMode === 'block'"
          [variant]="profile?.is_suspended ? 'green' : 'ink'"
          [icon]="profile?.is_suspended ? 'check' : 'shield'"
          [loading]="blockSaving"
          [disabled]="!profile?.is_suspended && !blockReason"
          (clicked)="submitBlock()"
        >
          {{ profile?.is_suspended ? 'Unblock Driver' : 'Confirm Block' }}
        </tm-button>
        <tm-button
          *ngIf="blockMode === 'delete'"
          variant="danger"
          icon="trash"
          [loading]="deleteSaving"
          [disabled]="!deleteReason.trim()"
          (clicked)="submitDelete()"
        >
          Delete Driver Permanently
        </tm-button>
      </ng-container>
    </tm-modal>

    <!-- =================== Edit Profile Drawer =================== -->
    <tm-drawer [open]="editOpen" title="Edit Driver & Service Details" (closed)="editOpen = false">
      <div slot="body" class="drawer-form-wrap" *ngIf="editForm">
        
        <div class="drawer-section-heading">Personal Details</div>
        <div class="form-group">
          <label class="form-label">Full Name</label>
          <input class="form-control" type="text" [(ngModel)]="editForm.name" maxlength="120" />
        </div>

        <div class="form-group-grid">
          <div class="form-group">
            <label class="form-label">Phone (Verified via OTP)</label>
            <div style="display: flex; gap: 8px; align-items: center;">
              <input class="form-control mono" type="tel" [value]="profile?.phone || '—'" disabled style="background: var(--tm-canvas-2); cursor: not-allowed;" />
              <tm-button variant="outline" size="sm" (clicked)="openAdminPhoneModal()">Change</tm-button>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Email Address</label>
            <input class="form-control" type="email" [(ngModel)]="editForm.email" maxlength="180" />
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Date of Birth</label>
          <input class="form-control" type="date" [(ngModel)]="editForm.dob" />
        </div>

        <div class="form-group">
          <label class="form-label">Residential Address</label>
          <textarea class="form-control" rows="2" [(ngModel)]="editForm.address" maxlength="500"></textarea>
        </div>

        <div class="drawer-section-heading mt-4">Operating Cities</div>
        <div class="form-group">
          <label id="driver-operating-cities-label" class="form-label" for="driver-operating-cities">Select the cities where the driver operates</label>
          <p-multiSelect
            inputId="driver-operating-cities"
            ariaLabelledBy="driver-operating-cities-label"
            [options]="allCities"
            optionLabel="name"
            optionValue="id"
            [ngModel]="editForm.city_ids"
            (ngModelChange)="updateEditCities($event)"
            [style]="{ width: '100%' }"
            [filter]="true"
            filterPlaceHolder="Search cities"
            ariaFilterLabel="Search cities"
            [resetFilterOnHide]="true"
            [showToggleAll]="false"
            [maxSelectedLabels]="2"
            selectedItemsLabel="{0} cities selected"
            emptyMessage="No cities available"
            placeholder="Select cities"
          />
        </div>

        <div class="drawer-section-heading mt-4">Service &amp; Mode Settings</div>
        <div class="form-group-grid">
          <div class="form-group">
            <label class="form-label" for="driver-service-scope">Service Scope</label>
            <select id="driver-service-scope" class="form-control" [(ngModel)]="editForm.service_scope">
              <option value="">Not Assigned</option>
              <option value="local">Local</option>
              <option value="outstation">Outstation</option>
              <option value="both">Both (Local &amp; Outstation)</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="driver-service-mode">Service Mode</label>
            <select id="driver-service-mode" class="form-control" [(ngModel)]="editForm.service_mode" (ngModelChange)="syncEditVehicle()">
              <option value="">Not Assigned</option>
              <option *ngFor="let option of serviceModeOptions" [value]="option.value">{{ option.label }}</option>
            </select>
          </div>
        </div>

        <div class="drawer-section-heading mt-4">Vehicle Information</div>

        <div class="form-group">
          <label class="form-label" for="driver-vehicle">Vehicle</label>
          <select id="driver-vehicle" class="form-control"
                  (change)="onEditVehicleChange($event)" [disabled]="editVehiclesLoading || editSaving">
            <option value="" [selected]="!editVehicleKey" disabled>Select vehicle</option>
            <option *ngIf="editVehicleKey && !hasEditVehicleChoice" [value]="editVehicleKey" [selected]="true" disabled>{{ profile?.city_vehicle_type_name || profile?.vehicle_type_name || 'Current vehicle' }}</option>
            <option *ngFor="let vehicle of editVehicleChoices" [value]="vehicle.key" [selected]="vehicle.key === editVehicleKey">{{ vehicle.name }}</option>
          </select>
          <small class="form-text-muted">{{ editVehiclesLoading ? 'Loading vehicles…' : 'Choose a vehicle for the selected service mode.' }}</small>
          <div *ngIf="editVehiclesError" role="alert">Could not load vehicles. <button type="button" (click)="loadCityVehiclesForEdit()">Retry</button></div>
        </div>

        <div class="form-group">
          <label class="form-label">Registration Number</label>
          <input class="form-control mono" type="text" [(ngModel)]="editForm.vehicle_reg_no" maxlength="50" placeholder="e.g. JK01AB1234" />
        </div>

        <div class="form-group-grid">
          <div class="form-group">
            <label class="form-label">Vehicle Model Year / Details</label>
            <input class="form-control" type="text" [(ngModel)]="editForm.vehicle_model" maxlength="100" placeholder="e.g. 2022" />
          </div>
          <div class="form-group">
            <label class="form-label">Vehicle Colour</label>
            <input class="form-control" type="text" [(ngModel)]="editForm.vehicle_color" maxlength="100" placeholder="e.g. White" />
          </div>
        </div>

      </div>

      <ng-container slot="footer">
        <div class="edit-profile-footer">
        <p *ngIf="editSaveError" role="alert" class="edit-save-error">{{ editSaveError }}</p>
        <div class="edit-profile-footer__actions">
        <tm-button variant="ghost" (clicked)="editOpen = false">Cancel</tm-button>
        <tm-button variant="green" icon="check" [loading]="editSaving" (clicked)="submitEditProfile()">
          Save Changes
        </tm-button>
        </div>
        </div>
      </ng-container>
    </tm-drawer>

    <!-- =================== Unsubscribe Modal =================== -->
    <tm-modal
      [open]="unsubOpen"
      title="Driver Push Notification Preferences"
      (closed)="unsubOpen = false"
    >
      <div slot="body" class="modal-form-body">
        <p class="form-hint">Controls device push notifications sent directly to the driver's phone app.</p>
        <label class="custom-checkbox-row">
          <input type="checkbox" [(ngModel)]="unsubPush" />
          <div class="checkbox-text">
            <strong>Mute / Unsubscribe Push Notifications</strong>
            <small>Prevents Firebase app push alerts from waking the device</small>
          </div>
        </label>
      </div>
      <ng-container slot="footer">
        <tm-button variant="ghost" (clicked)="unsubOpen = false">Cancel</tm-button>
        <tm-button variant="green" icon="check" [loading]="unsubSaving" (clicked)="submitUnsub()">
          Save Settings
        </tm-button>
      </ng-container>
    </tm-modal>


    <!-- ============= Admin Phone Change Modal ============= -->
    <tm-modal
      [open]="adminPhoneModalOpen"
      title="Change Driver Phone"
      (closed)="closeAdminPhoneModal()"
    >
      <div slot="body" class="modal-form-body admin-phone-modal">
        <div *ngIf="adminPhoneStep === 'input'">
          <p class="form-hint">
            To change this driver's phone number, an SMS OTP will be sent to the new number for verification.
          </p>
          <div class="form-group">
            <label class="form-label"><span class="req">*</span> New Phone Number</label>
            <input
              class="form-control mono"
              type="tel"
              [(ngModel)]="adminNewPhone"
              [disabled]="adminPhoneBusy"
              placeholder="e.g. +919876543210"
            />
          </div>
        </div>

        <div *ngIf="adminPhoneStep === 'otp'">
          <p class="form-hint">
            Enter the 6-digit verification code sent to <strong>{{ adminNewPhone }}</strong>.
          </p>
          <div class="form-group">
            <label class="form-label"><span class="req">*</span> Verification Code (OTP)</label>
            <input
              class="form-control mono"
              type="text"
              inputmode="numeric"
              maxlength="6"
              [(ngModel)]="adminOtpCode"
              [disabled]="adminPhoneBusy"
              placeholder="6-digit OTP"
            />
          </div>
          <div class="modal-resend-row">
            <button
              type="button"
              class="btn-link"
              (click)="sendAdminPhoneOtp()"
              [disabled]="adminPhoneBusy || adminResendCountdown > 0"
            >
              {{ adminResendCountdown > 0 ? 'Resend in ' + adminResendCountdown + 's' : 'Resend Code' }}
            </button>
            <button
              type="button"
              class="btn-link text-muted"
              (click)="adminPhoneStep = 'input'"
              [disabled]="adminPhoneBusy"
            >
              Edit number
            </button>
          </div>
        </div>

        <div class="form-error-notice mt-3" *ngIf="adminPhoneError">
          <tm-icon name="alert-triangle" [size]="14" />
          <span>{{ adminPhoneError }}</span>
        </div>
      </div>

      <ng-container slot="footer">
        <tm-button variant="ghost" (clicked)="closeAdminPhoneModal()" [disabled]="adminPhoneBusy">
          Cancel
        </tm-button>
        <tm-button
          *ngIf="adminPhoneStep === 'input'"
          variant="green"
          icon="send"
          [loading]="adminPhoneBusy"
          [disabled]="!adminNewPhone.trim()"
          (clicked)="sendAdminPhoneOtp()"
        >
          Send OTP
        </tm-button>
        <tm-button
          *ngIf="adminPhoneStep === 'otp'"
          variant="green"
          icon="check"
          [loading]="adminPhoneBusy"
          [disabled]="!adminOtpCode.trim()"
          (clicked)="verifyAdminPhoneOtp()"
        >
          Verify &amp; Update
        </tm-button>
      </ng-container>
    </tm-modal>

  `,
  styles: [`
    .edit-profile-footer { width: 100%; }
    .edit-profile-footer__actions { display: flex; justify-content: flex-end; gap: 8px; }
    .edit-save-error { margin: 0 0 8px; padding: 10px 12px; border-radius: 8px; background: #fef2f2; color: #991b1b; font-size: 13px; }
    :host {
      display: block;
      width: 100%;
      color: var(--tm-text);
      font-family: var(--tm-font-body);
    }

    .stripe-console {
      padding: var(--tm-space-3) var(--tm-space-5) var(--tm-space-8);
      width: 100%;
      box-sizing: border-box;
    }

    /* Top Action Bar */
    .top-action-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: var(--tm-space-3);
      flex-wrap: wrap;
      gap: 10px;
    }
    .top-action-bar__left {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
    }
    .crumb-back {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      color: var(--tm-text-muted);
      text-decoration: none;
      font-weight: 700;
      padding: 4px 8px;
      border-radius: var(--tm-radius-xs);
      background: var(--tm-canvas-2);
      transition: background var(--tm-duration-fast) var(--tm-ease);
    }
    .crumb-back:hover { background: var(--tm-line-2); color: var(--tm-text); }
    .crumb-divider { color: var(--tm-text-soft); }
    .crumb-id { font-size: 11.5px; font-weight: 700; color: var(--tm-text-muted); background: var(--tm-canvas-2); padding: 2px 6px; border-radius: 4px; font-family: var(--tm-font-mono); }
    .crumb-title { font-weight: 700; color: var(--tm-text); font-size: 14px; }

    .top-action-bar__right {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .btn-action {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 6px 12px;
      border-radius: var(--tm-radius-xs);
      font-size: 12.5px;
      font-weight: 700;
      font-family: var(--tm-font-body);
      background: var(--tm-surface);
      border: 1px solid var(--tm-line-2);
      color: var(--tm-text);
      cursor: pointer;
      transition: all var(--tm-duration-fast) var(--tm-ease);
    }
    .btn-action:hover { background: var(--tm-canvas); border-color: var(--tm-text-soft); color: var(--tm-text); }
    .btn-action--primary { background: var(--tm-green); border-color: var(--tm-green-deep); color: #ffffff; }
    .btn-action--primary:hover { background: var(--tm-green-deep); border-color: var(--tm-green-deep); color: #ffffff; }
    .btn-action--danger:hover { background: var(--tm-danger-bg); border-color: var(--tm-danger); color: var(--tm-danger-fg); }

    /* Hero Console Header */
    .console-hero {
      background: var(--tm-surface);
      border: 1px solid var(--tm-line-2);
      border-radius: var(--tm-radius-md);
      overflow: hidden;
      margin-bottom: var(--tm-space-3);
      box-shadow: var(--tm-shadow-sm);
      width: 100%;
    }
    .hero-identity {
      padding: var(--tm-space-4) var(--tm-space-5);
      display: flex;
      align-items: center;
      gap: 14px;
      border-bottom: 1px solid var(--tm-line);
    }
    .hero-avatar {
      position: relative;
      width: 46px;
      height: 46px;
      border-radius: 50%;
      background: var(--tm-info-fg);
      color: #ffffff;
      font-weight: 800;
      font-size: 16px;
      font-family: var(--tm-font-body);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      overflow: hidden;
    }
    .hero-avatar img { width: 100%; height: 100%; object-fit: cover; }
    .hero-avatar.is-online::after {
      content: '';
      position: absolute;
      bottom: 0;
      right: 0;
      width: 11px;
      height: 11px;
      border-radius: 50%;
      background: var(--tm-green);
      border: 2px solid var(--tm-surface);
    }

    .hero-headings { display: flex; flex-direction: column; gap: 3px; }
    .hero-row-1 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .hero-name { margin: 0; font-size: 19px; font-weight: 800; color: var(--tm-text); letter-spacing: -0.01em; }
    .hero-badge { font-size: 11px; font-weight: 700; color: var(--tm-text-muted); background: var(--tm-canvas-2); padding: 1px 6px; border-radius: 4px; font-family: var(--tm-font-mono); }
    .plan-tag {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      font-weight: 700;
      color: #4338ca;
      background: #eef2ff;
      border: 1px solid #c7d2fe;
      padding: 1px 7px;
      border-radius: var(--tm-radius-pill);
    }
    .hero-row-2 { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--tm-text-muted); flex-wrap: wrap; }
    .meta-item { display: inline-flex; align-items: center; gap: 4px; }
    .meta-dot { color: var(--tm-line-2); }

    /* 5 Unified Metric Columns */
    .hero-metrics-strip {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      background: var(--tm-canvas);
      border-top: 1px solid var(--tm-line);
      width: 100%;
    }
    @media (max-width: 960px) {
      .hero-metrics-strip { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
    }
    .metric-cell {
      padding: 10px 16px;
      border-right: 1px solid var(--tm-line);
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .metric-cell:last-child { border-right: none; }
    .metric-cell--neg { background: var(--tm-danger-bg); }
    .metric-cell--payout { background: var(--tm-green-tint); }
    .m-label { font-size: 10px; font-weight: 800; color: var(--tm-text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
    .m-value-wrap { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; }
    .m-value { font-size: 16px; font-weight: 800; color: var(--tm-text); font-variant-numeric: tabular-nums; }
    .m-value--sm { font-size: 13px; }
    .m-link {
      background: none;
      border: none;
      font-size: 11.5px;
      font-weight: 700;
      color: var(--tm-green-deep);
      cursor: pointer;
      padding: 0;
      text-decoration: none;
      font-family: var(--tm-font-body);
    }
    .m-link:hover { text-decoration: underline; }
    .m-tag { font-size: 10px; font-weight: 800; color: var(--tm-green-deep); background: var(--tm-green-soft); padding: 1px 5px; border-radius: 4px; }
    .m-sub { font-size: 10.5px; color: var(--tm-text-muted); font-weight: 700; }

    /* Overview Specs Bar */
    .overview-specs-bar {
      background: var(--tm-surface);
      border: 1px solid var(--tm-line-2);
      border-radius: var(--tm-radius-md);
      padding: 12px 18px;
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 16px;
      margin-bottom: var(--tm-space-3);
      box-shadow: var(--tm-shadow-sm);
      width: 100%;
      box-sizing: border-box;
    }
    @media (max-width: 960px) {
      .overview-specs-bar { grid-template-columns: 1fr 1fr; }
    }
    @media (max-width: 600px) {
      .overview-specs-bar { grid-template-columns: 1fr; }
    }
    .spec-col {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 12px;
      border-right: 1px solid var(--tm-line);
      padding-right: 14px;
    }
    .spec-col:last-child { border-right: none; padding-right: 0; }
    .sc-head { font-size: 10.5px; font-weight: 800; color: var(--tm-text-muted); text-transform: uppercase; margin-bottom: 3px; display: inline-flex; align-items: center; gap: 4px; letter-spacing: 0.04em; }
    .sc-row { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
    .sc-lbl { color: var(--tm-text-muted); white-space: nowrap; }
    .sc-val { color: var(--tm-text); font-weight: 600; text-align: right; word-break: break-word; }
    .sc-btn {
      background: none;
      border: none;
      color: var(--tm-green-deep);
      font-size: 11.5px;
      font-weight: 700;
      cursor: pointer;
      padding: 0;
      text-decoration: underline;
      font-family: var(--tm-font-body);
    }

    /* Main Console Workspace */
    .console-workspace {
      background: var(--tm-surface);
      border: 1px solid var(--tm-line-2);
      border-radius: var(--tm-radius-md);
      box-shadow: var(--tm-shadow-sm);
      overflow: hidden;
      width: 100%;
    }

    .workspace-tabs-header {
      padding: 10px 18px;
      background: var(--tm-canvas);
      border-bottom: 1px solid var(--tm-line-2);
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
    }
    .console-tabs-nav { display: flex; gap: 4px; }
    .c-tab-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border-radius: var(--tm-radius-xs);
      background: transparent;
      border: none;
      font-size: 13px;
      font-weight: 700;
      font-family: var(--tm-font-body);
      color: var(--tm-text-muted);
      cursor: pointer;
      transition: all var(--tm-duration-fast) var(--tm-ease);
    }
    .c-tab-btn:hover { background: var(--tm-line); color: var(--tm-text); }
    .c-tab-btn.is-active {
      background: var(--tm-surface);
      color: var(--tm-text);
      box-shadow: var(--tm-shadow-sm);
    }
    .c-tab-badge {
      font-size: 10.5px;
      font-weight: 800;
      padding: 1px 6px;
      border-radius: var(--tm-radius-pill);
      background: var(--tm-canvas-2);
      color: var(--tm-text-muted);
    }
    .c-tab-btn.is-active .c-tab-badge { background: var(--tm-ink); color: #ffffff; }

    .workspace-toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .search-wrap { width: 220px; }
    .search-wrap ::ng-deep .field {
      height: 36px !important;
      padding: 0 12px !important;
      box-sizing: border-box !important;
      border-radius: var(--tm-radius-xs) !important;
      font-size: 12.5px !important;
      border: 1px solid var(--tm-line-2) !important;
      background: var(--tm-surface) !important;
      font-family: var(--tm-font-body) !important;
    }
    .search-wrap ::ng-deep .field input {
      font-size: 12.5px !important;
      font-family: var(--tm-font-body) !important;
    }

    .rides-toolbar-group {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .rides-toolbar-group ::ng-deep .fs__trigger {
      height: 36px !important;
      box-sizing: border-box !important;
      padding: 0 12px !important;
      border-radius: var(--tm-radius-xs) !important;
      font-size: 12.5px !important;
      border: 1px solid var(--tm-line-2) !important;
      display: inline-flex !important;
      align-items: center !important;
      font-family: var(--tm-font-body) !important;
      background: var(--tm-surface) !important;
    }

    .date-range-box {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 36px;
      box-sizing: border-box;
      background: var(--tm-surface);
      border: 1px solid var(--tm-line-2);
      padding: 0 12px;
      border-radius: var(--tm-radius-xs);
      font-size: 12.5px;
      font-family: var(--tm-font-body);
      color: var(--tm-text);
      cursor: pointer;
      transition: border-color var(--tm-duration-fast) var(--tm-ease);
    }
    .date-range-box:hover { border-color: var(--tm-text-soft); }
    .date-range-box.has-value {
      background: var(--tm-green-tint);
      border-color: var(--tm-green-deep);
      color: var(--tm-green-deep);
    }
    .date-input {
      border: none;
      background: transparent;
      outline: none;
      font-size: 12px;
      font-family: var(--tm-font-mono);
      font-weight: 600;
      color: var(--tm-text);
      width: 130px;
      cursor: pointer;
      height: 100%;
    }
    :host ::ng-deep .daterangepicker {
      font-family: var(--tm-font-body) !important;
      border-radius: var(--tm-radius-md);
      border: 1px solid var(--tm-line-2);
      box-shadow: var(--tm-shadow-pop);
      z-index: 99999 !important;
    }
    :host ::ng-deep .daterangepicker .btn-primary,
    :host ::ng-deep .daterangepicker .btn-success {
      background: var(--tm-ink); border-color: var(--tm-ink);
      border-radius: var(--tm-radius-xs); font-weight: 700;
    }
    :host ::ng-deep .daterangepicker .ranges li.active,
    :host ::ng-deep .daterangepicker td.active,
    :host ::ng-deep .daterangepicker td.active:hover { background: var(--tm-ink); color: #fff; }
    :host ::ng-deep .daterangepicker td.in-range { background: var(--tm-green-tint); color: var(--tm-green-deep); }
    .btn-x { background: none; border: none; color: var(--tm-text-muted); cursor: pointer; display: flex; align-items: center; padding: 0; }
    .btn-reset {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 36px;
      box-sizing: border-box;
      background: var(--tm-surface);
      border: 1px solid var(--tm-line-2);
      border-radius: var(--tm-radius-xs);
      padding: 0 12px;
      font-size: 12px;
      font-weight: 700;
      font-family: var(--tm-font-body);
      color: var(--tm-text-muted);
      cursor: pointer;
      transition: all var(--tm-duration-fast) var(--tm-ease);
    }
    .btn-reset:hover { background: var(--tm-danger-bg); color: var(--tm-danger-fg); border-color: var(--tm-danger); }

    /* Rides Financial Ribbon */
    .rides-financial-ribbon {
      background: var(--tm-canvas);
      border-bottom: 1px solid var(--tm-line);
      padding: 7px 18px;
      display: flex;
      gap: 20px;
      font-size: 12px;
    }
    .rf-pill { display: flex; align-items: center; gap: 5px; }
    .rf-lbl { color: var(--tm-text-muted); font-weight: 600; }

    /* Console Data Table (Responsive full width) */
    .console-table-wrap {
      width: 100%;
      overflow-x: auto;
    }
    .console-table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 13px;
    }
    .console-table th {
      background: var(--tm-canvas);
      color: var(--tm-text-muted);
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 11px 16px;
      border-bottom: 1px solid var(--tm-line-2);
      white-space: nowrap;
    }
    .console-table td {
      padding: 12px 16px;
      border-bottom: 1px solid var(--tm-line);
      vertical-align: middle;
      color: var(--tm-text);
    }
    .c-row:hover td { background: var(--tm-canvas); }

    .cell-id strong { color: var(--tm-text); }
    .cell-time .time-main { font-weight: 700; color: var(--tm-text); }
    .cell-time .time-sub { font-size: 11px; color: var(--tm-text-muted); }

    .cell-rider .rider-row { display: flex; align-items: center; gap: 4px; }
    .extra-pill { font-size: 9.5px; font-weight: 800; background: var(--tm-canvas-2); color: var(--tm-text-muted); padding: 1px 4px; border-radius: 3px; }
    .rider-phone { font-size: 11px; color: var(--tm-text-muted); }

    .cell-route { min-width: 200px; max-width: 320px; }
    .point-row { display: flex; align-items: center; gap: 6px; margin-bottom: 2px; }
    .dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
    .dot-from { background: var(--tm-info); }
    .dot-to   { background: var(--tm-green); }
    .addr-text { font-size: 12px; color: var(--tm-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
    .route-sub { font-size: 11px; color: var(--tm-text-muted); margin-top: 1px; }

    .cell-mode .mode-badge {
      display: inline-block;
      font-size: 10px;
      font-weight: 800;
      padding: 2px 6px;
      border-radius: 4px;
      background: var(--tm-canvas-2);
      color: var(--tm-text-muted);
    }
    .mode-badge[data-mode="private"] { background: var(--tm-info-bg); color: var(--tm-info-fg); }
    .mode-badge[data-mode="fixed"]   { background: #fdf4ff; color: #86198f; }
    .mode-badge[data-mode="shuttle"] { background: var(--tm-green-tint); color: var(--tm-green-deep); }
    .route-title { font-size: 10.5px; margin-top: 1px; }

    .cell-fare .fare-num { font-size: 14px; color: var(--tm-text); font-weight: 800; }
    .cell-fare .fare-est { font-size: 10px; color: var(--tm-text-muted); }

    .cell-pay .pay-chip {
      display: inline-block;
      font-size: 10px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 4px;
      background: var(--tm-canvas-2);
      color: var(--tm-text-muted);
    }
    .pay-chip.is-paid { background: var(--tm-green-tint); color: var(--tm-green-deep); }
    .refund-chip { font-size: 10.5px; font-weight: 700; margin-top: 2px; }

    .status-pill {
      display: inline-block;
      font-size: 10px;
      font-weight: 800;
      text-transform: uppercase;
      padding: 2px 7px;
      border-radius: var(--tm-radius-pill);
    }
    .status-pill[data-status="completed"] { background: var(--tm-green-tint); color: var(--tm-green-deep); }
    .status-pill[data-status="cancelled"], .status-pill.is-cancelled { background: var(--tm-danger-bg); color: var(--tm-danger-fg); }
    .status-pill[data-status="pending"]   { background: var(--tm-warning-bg); color: var(--tm-warning-fg); }

    .txn-bubble {
      width: 22px;
      height: 22px;
      border-radius: 6px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .txn-bubble.is-credit { background: var(--tm-green-tint); color: var(--tm-green-deep); }
    .txn-bubble.is-debit  { background: var(--tm-danger-bg); color: var(--tm-danger-fg); }
    .txn-title { font-size: 13px; color: var(--tm-text); font-weight: 700; }
    .txn-reason { margin: 2px 0 0; font-size: 11.5px; color: var(--tm-text-muted); }
    .amount-val { font-size: 14px; font-weight: 800; }
    .amount-val.is-credit { color: var(--tm-green-deep); }
    .amount-val.is-debit  { color: var(--tm-danger-fg); }

    .empty-cell { padding: 48px 20px; text-align: center; color: var(--tm-text-muted); }
    .empty-box { display: flex; flex-direction: column; align-items: center; color: var(--tm-text-soft); }
    .empty-box h4 { margin: 8px 0 3px; font-size: 14px; color: var(--tm-text); font-weight: 700; }
    .empty-box p  { margin: 0; font-size: 12px; }

    .view-loading, .page-loading-wrap {
      padding: 60px 20px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      color: var(--tm-text-muted);
      font-size: 13px;
    }
    .spinner {
      width: 24px;
      height: 24px;
      border: 2.5px solid var(--tm-line-2);
      border-top-color: var(--tm-green);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Routes Tab */
    .routes-container { padding: var(--tm-space-4); }

    /* Specs Tab */
    .full-specs-container { padding: var(--tm-space-4); }
    .specs-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 14px;
    }
    .spec-panel {
      background: var(--tm-canvas);
      border: 1px solid var(--tm-line-2);
      border-radius: var(--tm-radius-md);
      padding: 14px;
    }
    .spec-panel-head {
      display: flex;
      align-items: center;
      gap: 6px;
      border-bottom: 1px solid var(--tm-line);
      padding-bottom: 8px;
      margin-bottom: 10px;
    }
    .spec-panel-head h3 { margin: 0; font-size: 13px; font-weight: 800; color: var(--tm-text); flex: 1; }
    .sp-edit-btn { background: none; border: none; color: var(--tm-green-deep); font-size: 11.5px; font-weight: 700; cursor: pointer; font-family: var(--tm-font-body); }
    .sp-list { display: flex; flex-direction: column; gap: 8px; font-size: 12px; }
    .sp-row { display: flex; justify-content: space-between; align-items: center; }
    .sp-row span { color: var(--tm-text-muted); }
    .sp-row strong { color: var(--tm-text); text-align: right; font-weight: 600; }
    .sp-link { color: var(--tm-green-deep); text-decoration: none; font-weight: 700; }
    .sp-footer { margin-top: 12px; }

    /* Modal Form Styles */
    .modal-form-body { display: flex; flex-direction: column; gap: 12px; }
    .form-hint { font-size: 12px; color: var(--tm-text-muted); margin: 0; }
    .destination-card {
      background: var(--tm-canvas);
      border: 1px solid var(--tm-line-2);
      border-radius: var(--tm-radius-xs);
      padding: 10px 12px;
      font-size: 12px;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .dest-head { font-size: 10.5px; font-weight: 800; text-transform: uppercase; color: var(--tm-text-muted); }
    .dest-row { display: flex; justify-content: space-between; }
    .dest-lbl { color: var(--tm-text-muted); }
    .dest-val { color: var(--tm-text); font-weight: 600; }

    .payout-summary-box {
      background: var(--tm-surface);
      border: 1px solid var(--tm-line-2);
      border-radius: var(--tm-radius-xs);
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    .payout-sum-row { display: flex; justify-content: space-between; font-size: 12px; color: var(--tm-text-muted); }
    .payout-sum-row--highlight { font-weight: 800; font-size: 13px; color: var(--tm-text); }

    .form-group { display: flex; flex-direction: column; gap: 4px; }
    .form-label-row { display: flex; justify-content: space-between; align-items: center; }
    .form-label { font-size: 12px; font-weight: 700; color: var(--tm-text); }
    .req { color: var(--tm-danger); }
    .btn-fill-amount {
      background: none;
      border: none;
      color: var(--tm-green-deep);
      font-size: 11px;
      font-weight: 800;
      cursor: pointer;
      text-decoration: underline;
      font-family: var(--tm-font-body);
    }
    .form-control {
      width: 100%;
      box-sizing: border-box;
      padding: 8px 10px;
      border: 1px solid var(--tm-line-2);
      border-radius: var(--tm-radius-xs);
      font-size: 13px;
      font-family: var(--tm-font-body);
      color: var(--tm-text);
      background: var(--tm-surface);
      outline: none;
    }
    .form-control:focus { border-color: var(--tm-green); }

    .action-toggle-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .toggle-card-btn {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
      padding: 10px;
      border: 1px solid var(--tm-line-2);
      border-radius: var(--tm-radius-xs);
      background: var(--tm-surface);
      cursor: pointer;
      color: var(--tm-text);
      font-family: var(--tm-font-body);
    }
    .toggle-card-btn.is-active { border-color: var(--tm-info); background: var(--tm-info-bg); color: var(--tm-info-fg); }
    .toggle-card-btn--danger.is-active { border-color: var(--tm-danger); background: var(--tm-danger-bg); color: var(--tm-danger-fg); }

    .form-error-notice {
      display: flex;
      align-items: center;
      gap: 6px;
      background: var(--tm-danger-bg);
      border: 1px solid var(--tm-danger);
      border-radius: var(--tm-radius-xs);
      padding: 8px 10px;
      font-size: 12px;
      color: var(--tm-danger-fg);
    }
    .danger-alert {
      display: flex;
      gap: 6px;
      background: var(--tm-danger-bg);
      border: 1px solid var(--tm-danger);
      padding: 8px 10px;
      border-radius: var(--tm-radius-xs);
      color: var(--tm-danger-fg);
      font-size: 12px;
    }

    .drawer-form-wrap { display: flex; flex-direction: column; gap: 12px; }
    .drawer-section-heading {
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      color: var(--tm-text-muted);
      padding-bottom: 3px;
      border-bottom: 1px solid var(--tm-line-2);
      letter-spacing: 0.05em;
    }
    .form-group-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .form-text-muted { font-size: 11px; color: var(--tm-text-muted); margin-top: 4px; display: block; }

    .mono { font-family: var(--tm-font-mono) !important; font-variant-numeric: tabular-nums; }
    .text-emerald { color: var(--tm-green-deep) !important; }
    .text-danger  { color: var(--tm-danger-fg) !important; }
    .text-amber   { color: var(--tm-warning-fg) !important; }
    .text-purple  { color: #7e22ce !important; }
    .text-muted   { color: var(--tm-text-muted) !important; }
    .mt-3 { margin-top: 10px; }
    .mt-4 { margin-top: 12px; }

    .btn-text-action { background: none; border: none; color: var(--tm-green-deep); font-size: 11px; font-weight: 700; cursor: pointer; padding: 2px 6px; border-radius: 4px; }
    .btn-text-action:hover { background: rgba(18, 179, 91, 0.08); text-decoration: underline; }
    .admin-phone-modal { display: flex; flex-direction: column; gap: 12px; min-width: 320px; }
    .admin-phone-modal .modal-resend-row { display: flex; align-items: center; justify-content: space-between; margin-top: 6px; }
    .admin-phone-modal .btn-link { background: none; border: none; color: var(--tm-green-deep); font-size: 12px; font-weight: 600; cursor: pointer; padding: 2px 0; }
    .admin-phone-modal .btn-link.text-muted { color: var(--tm-text-muted); text-decoration: underline; }
    .admin-phone-modal .btn-link:disabled { opacity: 0.5; cursor: not-allowed; }

  `],
})
export class DriverDetailComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('rideRange') set rideRange(el: ElementRef<HTMLInputElement> | undefined) {
    if (el && el.nativeElement) {
      this.rideRangeEl = el;
      setTimeout(() => this.initRideRangePicker(), 50);
    }
  }
  private rideRangeEl?: ElementRef<HTMLInputElement>;

  driverId!: number;
  profile: DriverProfile | null = null;

  // Workspace Tabs
  activeTab: TabKey = 'rides';
  loadingTab = false;
  rides: any[] = [];
  walletTxns: any[] = [];
  cancelledRides: any[] = [];
  rideSummary: { rides_count: number; fares_collected: number; refunded: number } | null = null;
  tabSearch = '';
  rideMode = 'all';
  rideDateFrom = '';
  rideDateTo = '';

  readonly rideModeOptions = [
    { label: 'Private Rides', value: 'private' },
    { label: 'Fixed Routes', value: 'fixed' },
    { label: 'Shuttle Service', value: 'shuttle' },
  ];

  // Send OTP
  otpSending = false;

  // Admin Phone Change
  adminPhoneModalOpen = false;
  adminPhoneStep: 'input' | 'otp' = 'input';
  adminNewPhone = '';
  adminOtpCode = '';
  adminPhoneBusy = false;
  adminPhoneError: string | null = null;
  adminResendCountdown = 0;
  private adminResendTimer: any = null;


  // Options for Edit Form
  allCities: { id: number; name: string }[] = [];
  globalVehicleTypes: { id: number; name: string }[] = [];
  cityVehicleOptions: { id: number; display_name: string; vehicle_type_id?: number; city_name?: string; ride_type_name?: string; ride_type_mode?: string; ride_type_id?: number }[] = [];
  editVehicleKey = '';
  private editVehicleManuallyChosen = false;
  editSaveError: string | null = null;
  private vehicleKey(name: string): string { return name.trim().toLowerCase(); }
  get editVehicleChoices() {
    const choices = new Map<string, string>();
    for (const vehicle of this.cityVehicleOptions) choices.set(this.vehicleKey(vehicle.display_name), vehicle.display_name.trim());
    return [...choices].map(([key, name]) => ({ key, name }));
  }
  get hasEditVehicleChoice(): boolean { return this.editVehicleChoices.some(vehicle => vehicle.key === this.editVehicleKey); }
  chooseEditVehicle(key: string): void {
    this.editVehicleManuallyChosen = true;
    this.editVehicleKey = key;
    this.syncEditVehicle();
  }
  onEditVehicleChange(event: Event): void {
    this.chooseEditVehicle((event.target as HTMLSelectElement).value);
  }
  syncEditVehicle(): void {
    if (!this.editForm || !this.editVehicleKey) return;
    const matches = this.cityVehicleOptions.filter(vehicle => this.vehicleKey(vehicle.display_name) === this.editVehicleKey);
    const matchingMode = matches.filter(vehicle => vehicle.ride_type_mode === this.editForm!.service_mode);
    const available = matchingMode.length ? matchingMode : matches.filter(vehicle => vehicle.ride_type_id == null);
    const match = available.find(vehicle => vehicle.id === this.editForm!.city_vehicle_type_id) || available[0];
    this.editForm.city_vehicle_type_id = match?.id ?? null;
    if (match?.vehicle_type_id != null) this.editForm.vehicle_type_id = match.vehicle_type_id;
  }
  editVehiclesLoading = false;
  editVehiclesError = false;
  private editVehicleRequest = 0;

  get selectedEditVehicle() {
    return this.cityVehicleOptions.find(vehicle => vehicle.id === this.editForm?.city_vehicle_type_id);
  }

  // Edit profile drawer
  editOpen = false;
  editSaving = false;
  serviceModeOptions: ReadonlyArray<{ value: DriverServiceMode; label: string }> = DRIVER_SERVICE_MODE_OPTIONS;
  editForm: {
    name: string;
    phone: string;
    email: string;
    dob: string;
    address: string;
    city_ids: number[];
    service_scope: 'local' | 'outstation' | 'both' | '';
    service_mode: DriverServiceMode | '';
    vehicle_type_id: number | null;
    city_vehicle_type_id: number | null;
    vehicle_reg_no: string;
    vehicle_model: string;
    vehicle_color: string;
  } | null = null;

  // Block / Delete modal
  blockDeleteOpen = false;
  blockMode: 'block' | 'delete' = 'block';
  blockReason = '';
  deleteReason = '';
  blockSaving = false;
  deleteSaving = false;
  readonly blockReasons = BLOCK_REASONS;

  // Unsubscribe modal
  unsubOpen = false;
  unsubPush = false;
  unsubSaving = false;

  // Record payout modal
  payoutOpen = false;
  payoutSummary: {
    balance: number;
    money_collected?: number;
    money_transferred?: number;
    pending_payout?: number;
    completed_payout?: number;
    earned_remaining?: number;
    deposits_remaining?: number;
    total_paid_out?: number;
    payout_method?: string | null;
    payout_beneficiary_name?: string | null;
    payout_bank_last4?: string | null;
    payout_ifsc?: string | null;
    payout_upi?: string | null;
    phone?: string;
    name?: string;
  } | null = null;
  payoutAmount: number | null = null;
  payoutMethod: 'gpay' | 'bank' | 'cash' | 'other' = 'gpay';
  payoutReference = '';
  payoutNote = '';
  payoutSaving = false;
  payoutError: string | null = null;

  readonly historyTabs: { key: TabKey; label: string; icon: 'car' | 'tag' | 'x' | 'road' | 'user' }[] = [
    { key: 'rides',     label: 'Rides History',         icon: 'car' },
    { key: 'wallet',    label: 'Wallet & Ledger',       icon: 'tag' },
    { key: 'cancelled', label: 'Cancellations',         icon: 'x' },
    { key: 'routes',    label: 'Route Allocations',     icon: 'road' },
    { key: 'specs',     label: 'Full Specifications',   icon: 'user' },
  ];

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private api: ApiService,
    private toast: ToastService,
    private zone: NgZone,
  ) {}

  ngOnInit(): void {
    this.ensureOptionsLoaded();
    this.route.paramMap.subscribe((p) => {
      this.driverId = parseInt(p.get('id') || '0', 10);
      this.loadProfile();
      this.loadTab('rides');
    });
  }

  ngAfterViewInit(): void {
    if (this.rideRangeEl?.nativeElement) {
      setTimeout(() => this.initRideRangePicker());
    }
  }

  ngOnDestroy(): void {
    this.destroyRideRangePicker();
    if (this.adminResendTimer) { clearInterval(this.adminResendTimer); this.adminResendTimer = null; }
  }

  // -------------------- Date range picker --------------------
  get rangeLabel(): string {
    if (!this.rideDateFrom && !this.rideDateTo) return '';
    return `${this.rideDateFrom || '…'} → ${this.rideDateTo || '…'}`;
  }

  private initRideRangePicker(): void {
    const el = this.rideRangeEl?.nativeElement;
    if (!el) return;
    const $el = $(el);
    if ($el.data('daterangepicker')) return;
    $el.daterangepicker(
      {
        autoApply: true,
        autoUpdateInput: false,
        opens: 'left',
        maxDate: moment(),
        alwaysShowCalendars: true,
        locale: { format: 'YYYY-MM-DD', cancelLabel: 'Clear', applyLabel: 'Apply' },
        ranges: {
          Today: [moment(), moment()],
          Yesterday: [moment().subtract(1, 'days'), moment().subtract(1, 'days')],
          'Last 7 days': [moment().subtract(6, 'days'), moment()],
          'Last 30 days': [moment().subtract(29, 'days'), moment()],
          'This month': [moment().startOf('month'), moment().endOf('month')],
          'Last month': [
            moment().subtract(1, 'month').startOf('month'),
            moment().subtract(1, 'month').endOf('month'),
          ],
        },
      } as any,
      (start: moment.Moment, end: moment.Moment) => {
        this.zone.run(() => {
          this.rideDateFrom = start.format('YYYY-MM-DD');
          this.rideDateTo = end.format('YYYY-MM-DD');
        });
      },
    );
    $el.on('cancel.daterangepicker', () => {
      this.zone.run(() => this.clearRideDates());
    });
  }

  private destroyRideRangePicker(): void {
    if (!this.rideRangeEl?.nativeElement) return;
    const picker = ($(this.rideRangeEl.nativeElement) as any).data('daterangepicker');
    if (picker) picker.remove();
  }

  clearRideDates(): void {
    this.rideDateFrom = '';
    this.rideDateTo = '';
  }

  triggerDatePicker(): void {
    const el = this.rideRangeEl?.nativeElement;
    if (!el) return;
    const picker = ($(el) as any).data('daterangepicker');
    if (picker) {
      picker.show();
    } else {
      this.initRideRangePicker();
      setTimeout(() => {
        ($(el) as any).data('daterangepicker')?.show();
      }, 50);
    }
  }

  paymentStatusText(s: string | null | undefined): string {
    switch (s) {
      case 'PAID':    return 'Paid';
      case 'PENDING': return 'Pending';
      case 'PARTIAL': return 'Part-paid';
      default:        return s ? s.toLowerCase() : '';
    }
  }

  // -------------------- Derived view state --------------------
  get approvalTone(): 'success' | 'danger' | 'warning' | 'neutral' {
    switch (this.profile?.approval_status) {
      case 'approved': return 'success';
      case 'rejected': return 'danger';
      case 'pending':  return 'warning';
      default:         return 'neutral';
    }
  }

  tabCount(key: TabKey): number {
    switch (key) {
      case 'rides':     return this.rides.length;
      case 'wallet':    return this.walletTxns.length;
      case 'cancelled': return this.cancelledRides.length;
      default:          return 0;
    }
  }

  get searchPlaceholder(): string {
    switch (this.activeTab) {
      case 'rides':     return 'Search rider, route or trip ID…';
      case 'wallet':    return 'Search reason, amount or ref…';
      case 'cancelled': return 'Search cancelled trips…';
      default:          return 'Search…';
    }
  }

  timeAgo(iso: string | null): string {
    if (!iso) return '—';
    const then = new Date(iso).getTime();
    if (isNaN(then)) return '—';
    const sec = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (sec < 60) return 'just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const days = Math.floor(hr / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    return `${months}mo ago`;
  }

  pretty(lat: number | null | undefined, lng: number | null | undefined): string {
    if (lat == null || lng == null) return 'Location coords';
    return `${(+lat).toFixed(4)}, ${(+lng).toFixed(4)}`;
  }

  statusBucket(s: string | null | undefined): string {
    switch (s) {
      case 'COMPLETED': return 'completed';
      case 'CANCELLED': return 'cancelled';
      case 'NEGOTIATION':
      case 'REQUESTED':
      case 'CONFIRMED':  return 'pending';
      default:           return 'ongoing';
    }
  }

  statusDisplay(s: string | null | undefined): string {
    return (s || '').replace(/_/g, ' ').toLowerCase() || '—';
  }

  private inDateRange(iso: string | null | undefined, from: string, to: string): boolean {
    if (!iso) return false;
    const day = iso.slice(0, 10);
    if (from && day < from) return false;
    if (to && day > to) return false;
    return true;
  }

  rideModeOf(row: any): 'private' | 'fixed' | 'shuttle' {
    if (!row?.route_departure_id) return 'private';
    const mode = row?.route_departure?.route?.mode || row?.route?.mode;
    return mode === 'fixed' ? 'fixed' : 'shuttle';
  }

  rideModeLabel(row: any): string {
    const mode = this.rideModeOf(row);
    switch (mode) {
      case 'private': return 'Private';
      case 'fixed': return 'Fixed';
      case 'shuttle': return 'Shuttle';
      default: return 'Ride';
    }
  }

  clearRideFilters(): void {
    this.tabSearch = '';
    this.rideMode = 'all';
    this.rideDateFrom = '';
    this.rideDateTo = '';
  }

  get isLocationStale(): boolean {
    const iso = this.profile?.current_location_updated_at;
    if (!iso) return false;
    const then = new Date(iso).getTime();
    if (isNaN(then)) return false;
    return Date.now() - then > 30 * 60 * 1000;
  }

  sendOtp(): void {
    if (!this.driverId) return;
    this.otpSending = true;
    this.api.post(`/admin/drivers/${this.driverId}/send-otp`, {}).subscribe({
      next: () => {
        this.toast.success('OTP sent successfully to driver phone');
        this.otpSending = false;
      },
      error: (err) => {
        this.toast.error(err?.error?.message || 'Could not send OTP', { title: 'OTP failed' });
        this.otpSending = false;
      },
    });
  }

  openEditProfile(): void {
    if (!this.profile) return;
    this.editSaveError = null;
    this.ensureOptionsLoaded();

    let cityIds: number[] = [];
    if (this.profile.city_ids && Array.isArray(this.profile.city_ids) && this.profile.city_ids.length > 0) {
      cityIds = this.profile.city_ids.map((id) => Number(id));
    } else if (this.profile.cities && Array.isArray(this.profile.cities) && this.profile.cities.length > 0) {
      cityIds = this.profile.cities.map((c) => Number(c.id));
    } else if (this.profile.city_id != null) {
      cityIds = [Number(this.profile.city_id)];
    } else if (this.profile.city_name && this.allCities.length > 0) {
      const match = this.allCities.find((c) => c.name.toLowerCase() === this.profile!.city_name!.toLowerCase());
      if (match) cityIds = [Number(match.id)];
    }

    let vehicleTypeId = this.profile.vehicle_type_id != null ? Number(this.profile.vehicle_type_id) : null;
    if (vehicleTypeId == null && (this.profile.vehicle_type_name || this.profile.vehicle_type) && this.globalVehicleTypes.length > 0) {
      const name = (this.profile.vehicle_type_name || this.profile.vehicle_type || '').toLowerCase();
      const match = this.globalVehicleTypes.find((vt) => vt.name.toLowerCase() === name);
      if (match) vehicleTypeId = Number(match.id);
    }

    let formattedDob = '';
    if (this.profile.dob) {
      const m = String(this.profile.dob).match(/^\d{4}-\d{2}-\d{2}/);
      formattedDob = m ? m[0] : '';
    }

    this.editForm = {
      name: this.profile.name ?? '',
      phone: this.profile.phone ?? '',
      email: this.profile.email ?? '',
      dob: formattedDob,
      address: this.profile.address ?? '',
      city_ids: cityIds,
      service_scope: (this.profile.service_scope as any) || 'local',
      service_mode: (this.profile.service_mode as any) || 'fixed',
      vehicle_type_id: vehicleTypeId,
      city_vehicle_type_id: this.profile.city_vehicle_type_id != null ? Number(this.profile.city_vehicle_type_id) : null,
      vehicle_reg_no: this.profile.vehicle_reg_no ?? '',
      vehicle_model: this.profile.vehicle_model ?? '',
      vehicle_color: this.profile.vehicle_color ?? '',
    };
    // Establish the registered vehicle before asynchronous city vehicle options
    // arrive. Otherwise the saved city vehicle ID can temporarily resolve to a
    // different category (for example SUMO) and win the selector's first value.
    this.editVehicleKey = this.vehicleKey(
      this.profile.city_vehicle_type_name || this.profile.vehicle_type_name || this.profile.vehicle_type || '',
    );
    this.editVehicleManuallyChosen = false;
    this.loadCityVehiclesForEdit();
    this.loadServiceModeLabels(cityIds[0] ?? this.allCities[0]?.id);
    this.editOpen = true;
  }

  private loadServiceModeLabels(cityId?: number): void {
    if (!cityId) return;
    // This endpoint still takes a city ID, but the service catalog is global.
    this.api.get<{ scopes: { modes: DriverRideCatalogMode[] }[] }>(
      `/catalog/cities/${cityId}/driver-ride-products`,
    ).subscribe({
      next: ({ scopes }) => {
        const catalogModes = scopes.flatMap(scope => scope.modes);
        this.serviceModeOptions = DRIVER_SERVICE_MODE_OPTIONS.map(option => {
          const catalogMode = catalogModes.find(mode => mode.mode === option.value);
          return { ...option, label: catalogMode?.display_name || catalogMode?.name || option.label };
        });
      },
      error: () => {
        this.serviceModeOptions = DRIVER_SERVICE_MODE_OPTIONS;
      },
    });
  }

  updateEditCities(cityIds: number[]): void {
    if (!this.editForm) return;
    if (!cityIds.length) {
      this.editForm.city_ids = [...this.editForm.city_ids];
      this.toast.error('Driver must have at least one operating city.');
      return;
    }
    this.editForm.city_ids = cityIds;
    this.loadCityVehiclesForEdit();
  }

  ensureOptionsLoaded(): void {
    if (!this.allCities.length) {
      this.api.get<{ data: { id: number; name: string }[] }>('/admin/cities').subscribe({
        next: (res) => {
          this.allCities = res.data ?? [];
          if (this.editOpen && !this.editForm?.city_ids.length) {
            this.loadServiceModeLabels(this.allCities[0]?.id);
          }
          if (this.editForm && (!this.editForm.city_ids || !this.editForm.city_ids.length) && this.profile?.city_name) {
            const match = this.allCities.find((c) => c.name.toLowerCase() === this.profile!.city_name!.toLowerCase());
            if (match) {
              this.editForm.city_ids = [Number(match.id)];
              this.loadCityVehiclesForEdit();
            }
          }
        },
      });
    }
    if (!this.globalVehicleTypes.length) {
      this.api.get<{ data: { id: number; name: string }[] }>('/admin/vehicle-types-global').subscribe({
        next: (res) => {
          this.globalVehicleTypes = res.data ?? [];
          if (this.editForm && this.editForm.vehicle_type_id == null && (this.profile?.vehicle_type_name || this.profile?.vehicle_type)) {
            const name = (this.profile.vehicle_type_name || this.profile.vehicle_type || '').toLowerCase();
            const match = this.globalVehicleTypes.find((vt) => vt.name.toLowerCase() === name);
            if (match) {
              this.editForm.vehicle_type_id = Number(match.id);
              this.loadCityVehiclesForEdit();
            }
          }
        },
      });
    }
  }

  loadCityVehiclesForEdit(): void {
    const request = ++this.editVehicleRequest;
    this.editVehiclesError = false;
    if (!this.editForm || !this.editForm.city_ids.length) {
      this.cityVehicleOptions = [];
      this.editVehiclesLoading = false;
      return;
    }
    const cityIds = [...this.editForm.city_ids];
    this.editVehiclesLoading = true;
    forkJoin(cityIds.map(cityId => this.api.get<{ data?: any[]; vehicle_types?: any[] }>(`/admin/cities/${cityId}/vehicle-types`))).subscribe({
      next: (responses) => {
        if (request !== this.editVehicleRequest) return;
        this.editVehiclesLoading = false;
        const list = responses.flatMap((res, index) => (res.data ?? res.vehicle_types ?? []).filter((cv: any) => cv.is_active !== false && cv.is_active !== 0).map((cv: any) => ({
          id: Number(cv.id),
          display_name: cv.display_name,
          ride_type_name: cv.ride_type_name,
          ride_type_mode: cv.ride_type_mode || (cv.ride_type_name ? (/shuttle/i.test(cv.ride_type_name) ? 'shuttle' : /fixed/i.test(cv.ride_type_name) ? 'fixed' : 'private') : undefined),
          ride_type_id: cv.ride_type_id != null ? Number(cv.ride_type_id) : undefined,
          vehicle_type_id: cv.vehicle_type_id != null ? Number(cv.vehicle_type_id) : undefined,
          city_name: this.allCities.find(city => Number(city.id) === cityIds[index])?.name || `City #${cityIds[index]}`,
        })));
        this.cityVehicleOptions = list;
        const current = this.selectedEditVehicle;
        if (!this.editVehicleManuallyChosen) {
          const savedVehicleNames = [
            this.profile?.city_vehicle_type_name,
            this.profile?.vehicle_type_name,
            this.profile?.vehicle_type,
          ].map(name => this.vehicleKey(name || '')).filter(Boolean);
          const savedChoice = this.editVehicleChoices.find(vehicle => savedVehicleNames.includes(vehicle.key));
          this.editVehicleKey = savedChoice?.key || this.editVehicleKey || (current ? this.vehicleKey(current.display_name) : '');
        }
        if (this.editVehicleKey) this.syncEditVehicle();
        if (this.editForm?.city_vehicle_type_id) {
          const match = list.find((o) => Number(o.id) === Number(this.editForm!.city_vehicle_type_id));
          if (match && match.vehicle_type_id != null) {
            this.editForm.vehicle_type_id = Number(match.vehicle_type_id);
          }
        }
      },
      error: () => {
        if (request !== this.editVehicleRequest) return;
        this.editVehiclesLoading = false;
        this.editVehiclesError = true;
        this.cityVehicleOptions = [];
      },
    });
  }

  submitEditProfile(): void {
    if (!this.driverId || !this.editForm || this.editSaving) return;
    this.editSaveError = null;
    if (this.editVehiclesLoading) { this.toast.error('Please wait for vehicles to load.'); return; }
    if (this.editVehicleKey && !this.selectedEditVehicle) {
      this.toast.error('This vehicle is not available for the selected service mode in the driver’s operating cities.'); return;
    }
    const changedVehicle = this.editForm.city_vehicle_type_id !== (this.profile?.city_vehicle_type_id ?? null);
    const originalCities = this.profile?.city_ids?.length ? this.profile.city_ids : this.profile?.cities?.map(city => city.id) || (this.profile?.city_id ? [this.profile.city_id] : []);
    const changedCities = [...originalCities].map(Number).sort().join(',') !== [...this.editForm.city_ids].map(Number).sort().join(',');
    if ((changedVehicle || changedCities) && this.editForm.city_vehicle_type_id && (!this.selectedEditVehicle || this.editVehiclesError)) {
      this.toast.error('Please select an available vehicle from the driver’s operating cities.'); return;
    }
    if (!this.editForm.city_ids.length) {
      this.toast.error('Please select at least one city.');
      return;
    }
    this.editSaving = true;
    const f = this.editForm;
    const payload = {
      name: f.name.trim() || null,
      phone: f.phone.trim() || null,
      email: f.email.trim() || null,
      dob: f.dob || null,
      address: f.address.trim() || null,
      city_ids: f.city_ids,
      service_scope: f.service_scope || null,
      service_mode: f.service_mode || null,
      vehicle_type_id: f.vehicle_type_id || null,
      city_vehicle_type_id: f.city_vehicle_type_id || null,
      vehicle_reg_no: f.vehicle_reg_no.trim() || null,
      vehicle_model: f.vehicle_model.trim() || null,
      vehicle_color: f.vehicle_color.trim() || null,
      ...((changedVehicle || f.service_mode !== this.profile?.service_mode) && this.selectedEditVehicle?.ride_type_id != null ? { ride_type_id: this.selectedEditVehicle.ride_type_id } : {}),
    };
    this.api.patch<{ driver: any; message?: string }>(`/admin/drivers/${this.driverId}`, payload).subscribe({
      next: () => {
        this.editSaving = false;
        this.editOpen = false;
        this.toast.success('Driver profile & service updated successfully');
        this.loadProfile();
      },
      error: (err) => {
        this.editSaving = false;
        this.editSaveError = err?.error?.message || 'Could not update profile';
        this.toast.error(this.editSaveError!, { title: 'Update failed' });
      },
    });
  }

  openBlockDelete(): void {
    this.blockMode = 'block';
    this.blockReason = '';
    this.deleteReason = '';
    this.blockDeleteOpen = true;
  }

  submitBlock(): void {
    if (!this.profile) return;
    this.blockSaving = true;
    const action = this.profile.is_suspended ? 'unblock' : 'block';
    const body = this.profile.is_suspended ? {} : { reason: this.blockReason };
    this.api.post(`/admin/drivers/${this.driverId}/${action}`, body).subscribe({
      next: () => {
        this.toast.success(this.profile?.is_suspended ? 'Driver unblocked successfully' : 'Driver account blocked');
        this.blockSaving = false;
        this.blockDeleteOpen = false;
        this.loadProfile();
      },
      error: (err) => {
        this.toast.error(err?.error?.message || 'Action failed');
        this.blockSaving = false;
      },
    });
  }

  submitDelete(): void {
    this.deleteSaving = true;
    this.api
      .delete(`/admin/drivers/${this.driverId}?reason=${encodeURIComponent(this.deleteReason)}`)
      .subscribe({
        next: () => {
          this.toast.success('Driver deleted permanently');
          this.deleteSaving = false;
          this.blockDeleteOpen = false;
          this.router.navigate(['/drivers']);
        },
        error: (err) => {
          this.toast.error(err?.error?.message || 'Delete failed');
          this.deleteSaving = false;
        },
      });
  }

  openUnsub(): void {
    this.unsubPush = this.profile?.push_unsubscribed ?? false;
    this.unsubOpen = true;
  }

  submitUnsub(): void {
    if (!this.profile || this.unsubSaving) return;
    this.unsubSaving = true;
    this.api.post<any>(`/admin/drivers/${this.driverId}/unsubscribe`, {
      push: this.unsubPush,
    }).subscribe({
      next: () => {
        if (this.profile) {
          this.profile = {
            ...this.profile,
            push_unsubscribed: this.unsubPush,
          };
        }
        this.unsubOpen = false;
        this.unsubSaving = false;
        this.toast.success('Push notification preference saved');
      },
      error: (err) => {
        this.unsubSaving = false;
        this.toast.error(err?.error?.message || 'Could not update push preference');
      },
    });
  }

  // -------------------- Tab filtered getters --------------------
  get filteredRides() {
    const q = this.tabSearch.trim().toLowerCase();
    return this.rides.filter((r) => {
      const mode = this.rideModeOf(r);
      const matchesMode = this.rideMode === 'all' || mode === this.rideMode;
      const matchesDate = this.inDateRange(r.created_at, this.rideDateFrom, this.rideDateTo);
      const matchesSearch = !q || [r.rider_name, r.customer?.name, r.id, r.payment_method, r.final_fare, r.estimated_fare, mode, r.ride_type?.name, r.route?.name, r.route_departure?.route?.name, r.pickup_address, r.drop_address]
        .map((x) => String(x ?? '').toLowerCase())
        .some((s) => s.includes(q));
      return matchesMode && matchesDate && matchesSearch;
    });
  }

  get filteredWallet() {
    const q = this.tabSearch.trim().toLowerCase();
    if (!q) return this.walletTxns;
    return this.walletTxns.filter((r) =>
      [r.type, r.reason, r.amount, r.engagement_id]
        .map((x) => String(x ?? '').toLowerCase())
        .some((s) => s.includes(q)),
    );
  }

  get filteredCancelled() {
    const q = this.tabSearch.trim().toLowerCase();
    if (!q) return this.cancelledRides;
    return this.cancelledRides.filter((r) =>
      [r.id, r.cancelled_reason, r.rider_name, r.customer?.name]
        .map((x) => String(x ?? '').toLowerCase())
        .some((s) => s.includes(q)),
    );
  }

  // -------------------- Helpers --------------------
  initials(name: string | null | undefined): string {
    if (!name) return '—';
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '—';
    const a = parts[0][0] || '';
    const b = parts.length > 1 ? parts[parts.length - 1][0] : '';
    return (a + b).toUpperCase();
  }

  // -------------------- Record Payout --------------------
  openPayout(): void {
    this.payoutOpen = true;
    this.payoutSummary = null;
    this.payoutAmount = null;
    this.payoutMethod = 'gpay';
    this.payoutReference = '';
    this.payoutNote = '';
    this.payoutError = null;
    this.api.get<any>(`/admin/drivers/${this.driverId}/wallet/payout-summary`).subscribe({
      next: (res) => {
        this.payoutSummary = res;
        const due = res?.pending_payout ?? res?.earned_remaining ?? 0;
        this.payoutAmount = due > 0 ? due : null;
        if (res?.payout_method) {
          this.payoutMethod = res.payout_method === 'bank' ? 'bank' : 'gpay';
        }
      },
      error: (err) => {
        this.payoutError = err?.error?.message || 'Could not load the payout summary.';
      },
    });
  }

  submitPayout(): void {
    if (!this.payoutAmount || this.payoutAmount <= 0 || this.payoutSaving) return;
    this.payoutSaving = true;
    this.payoutError = null;
    this.api.post<any>(`/admin/drivers/${this.driverId}/wallet/payout`, {
      amount: this.payoutAmount,
      method: this.payoutMethod,
      reference: this.payoutReference.trim() || null,
      note: this.payoutNote.trim() || null,
    }).subscribe({
      next: () => {
        this.payoutSaving = false;
        this.payoutOpen = false;
        this.toast.success(`Payout of ₹${Number(this.payoutAmount).toFixed(2)} recorded successfully`);
        this.loadProfile();
        this.loadTab('wallet');
        this.activeTab = 'wallet';
      },
      error: (err) => {
        this.payoutSaving = false;
        this.payoutError = err?.error?.message || 'Could not record the payout.';
      },
    });
  }

  loadProfile(): void {
    this.api.get<any>(`/admin/drivers/${this.driverId}/profile`).subscribe({
      next: (res) => {
        this.profile = res.driver;
        this.unsubPush = this.profile?.push_unsubscribed ?? false;
      },
      error: (err) =>
        this.toast.error(
          err?.error?.message || 'Could not load driver',
          { title: 'Load failed' },
        ),
    });
  }

  setTab(tab: TabKey): void {
    if (this.activeTab === tab) return;
    this.activeTab = tab;
    this.tabSearch = '';
    this.loadTab(tab);
  }

  loadTab(tab: TabKey): void {
    if (!this.driverId) return;
    if (tab === 'routes' || tab === 'specs') return;
    this.loadingTab = true;
    const pathMap: Record<string, string> = {
      rides:     `/admin/drivers/${this.driverId}/rides`,
      wallet:    `/admin/drivers/${this.driverId}/wallet/transactions`,
      cancelled: `/admin/drivers/${this.driverId}/cancelled-rides`,
    };
    this.api.get<any>(pathMap[tab]).subscribe({
      next: (res) => {
        const data = res?.data?.data ?? [];
        if (tab === 'rides')          { this.rides = data; this.rideSummary = res?.summary ?? null; }
        else if (tab === 'wallet')    this.walletTxns = data;
        else if (tab === 'cancelled') this.cancelledRides = data;
        this.loadingTab = false;
      },
      error: () => {
        this.loadingTab = false;
      },
    });
  }

  openAdminPhoneModal(): void {
    this.adminPhoneModalOpen = true;
    this.adminPhoneStep = 'input';
    this.adminNewPhone = '';
    this.adminOtpCode = '';
    this.adminPhoneBusy = false;
    this.adminPhoneError = null;
    this.adminResendCountdown = 0;
    if (this.adminResendTimer) {
      clearInterval(this.adminResendTimer);
      this.adminResendTimer = null;
    }
  }

  closeAdminPhoneModal(): void {
    if (this.adminPhoneBusy) return;
    this.adminPhoneModalOpen = false;
    if (this.adminResendTimer) {
      clearInterval(this.adminResendTimer);
      this.adminResendTimer = null;
    }
  }

  sendAdminPhoneOtp(): void {
    if (!this.driverId || !this.adminNewPhone.trim() || this.adminPhoneBusy) return;
    this.adminPhoneBusy = true;
    this.adminPhoneError = null;
    this.api
      .post<{ message?: string; debug_code?: string }>(
        `/admin/drivers/${this.driverId}/phone/start`,
        { phone: this.adminNewPhone.trim() }
      )
      .subscribe({
        next: (res) => {
          this.adminPhoneBusy = false;
          this.adminPhoneStep = 'otp';
          this.startAdminResendTimer();
          this.toast.success(res.message || 'OTP sent successfully');
        },
        error: (err) => {
          this.adminPhoneBusy = false;
          this.adminPhoneError =
            err?.error?.message ||
            err?.error?.errors?.phone?.[0] ||
            'Could not send OTP. Please check the phone number.';
        },
      });
  }

  verifyAdminPhoneOtp(): void {
    if (!this.driverId || !this.adminOtpCode.trim() || this.adminPhoneBusy) return;
    this.adminPhoneBusy = true;
    this.adminPhoneError = null;
    this.api
      .post<{ message?: string; phone: string }>(
        `/admin/drivers/${this.driverId}/phone/verify`,
        {
          phone: this.adminNewPhone.trim(),
          code: this.adminOtpCode.trim(),
        }
      )
      .subscribe({
        next: (res) => {
          this.adminPhoneBusy = false;
          this.adminPhoneModalOpen = false;
          this.toast.success(res.message || 'Phone number updated successfully');
          if (this.profile) {
            this.profile = {
              ...this.profile,
              phone: res.phone || this.adminNewPhone.trim(),
            };
          }
          if (this.editForm) {
            this.editForm.phone = res.phone || this.adminNewPhone.trim();
          }
        },
        error: (err) => {
          this.adminPhoneBusy = false;
          this.adminPhoneError =
            err?.error?.message ||
            err?.error?.errors?.code?.[0] ||
            'Verification failed. Please check the code and try again.';
        },
      });
  }

  private startAdminResendTimer(): void {
    this.adminResendCountdown = 60;
    if (this.adminResendTimer) {
      clearInterval(this.adminResendTimer);
    }
    this.adminResendTimer = setInterval(() => {
      this.adminResendCountdown--;
      if (this.adminResendCountdown <= 0) {
        clearInterval(this.adminResendTimer);
        this.adminResendTimer = null;
      }
    }, 1000);
  }

}
