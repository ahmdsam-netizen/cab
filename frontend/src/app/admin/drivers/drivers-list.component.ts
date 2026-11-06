import {
  AfterViewInit,
  Component,
  ElementRef,
  HostListener,
  NgZone,
  OnDestroy,
  OnInit,
  ViewChild,
} from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import $ from 'jquery';
import moment from 'moment';
import 'daterangepicker';
import { ApiService } from '../../core/api.service';
import { catchError, EMPTY, expand, map, Observable, reduce, Subscription, throwError } from 'rxjs';
import { CityContextService, CityOption } from '../../core/city-context.service';
import { DriverRouteGroupsPanelComponent } from './driver-route-groups-panel.component';
import { ToastService } from '../../core/toast.service';
import {
  ButtonComponent,
  ChartComponent,
  ColumnComponent,
  DataTableComponent,
  FilterSelectComponent,
  IconComponent,
  InputComponent,
  ModalComponent,
} from '../../ui';
import { DriversInsightsComponent, InsightMode } from './drivers-insights.component';
import { acquireDocumentScrollLock } from '../../ui/document-scroll-lock';

type DriversView = 'table' | 'graph';

type StateFilter = 'all' | 'active' | 'deactivated';
type OnlineFilter = 'all' | 'online' | 'offline';
type ApprovalFilter = 'all' | 'approved' | 'not_approved' | 'pending' | 'rejected';

interface DriverRow {
  id: number;
  cities?: { id: number; name: string }[];
  route_groups?: { id: number; name: string; city_name: string | null; is_active: boolean }[];
  allocated_route_count?: number;
  approval_status: 'pending' | 'approved' | 'rejected';
  vehicle_type: string | null;
  vehicle_reg_no: string | null;
  is_online: boolean;
  registered_on: string | null;
  last_login: string | null;
  last_ride_on: string | null;
  rides_7d: number;
  rides_30d: number;
  total_rides: number;
  deactivated_at: string | null;
  deactivated_reason: string | null;
  user: {
    id: number;
    name: string;
    phone: string | null;
    email: string | null;
    avatar_path?: string | null;
    avatar_url?: string | null;
  } | null;
}

interface DriverLocationCount {
  id: number;
  name: string;
  driver_count: number;
}

interface DriverStandCount extends DriverLocationCount {
  is_active: boolean;
  driver_user_ids?: number[];
}

interface DriverListResponse {
  data: { data: DriverRow[]; total: number; last_page?: number };
  allocation_filters_supported?: boolean;
}

interface AllocationVehicle {
  id: number;
  display_name: string;
}

@Component({
  selector: 'app-drivers-list',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    DatePipe,
    ButtonComponent,
    ChartComponent,
    ColumnComponent,
    DataTableComponent,
    FilterSelectComponent,
    IconComponent,
    InputComponent,
    ModalComponent,
    DriversInsightsComponent,
    DriverRouteGroupsPanelComponent,
  ],
  template: `
    <div class="page">
      <!-- =================== Hero =================== -->
      <header class="page__hero">
        <div class="page__hero-left">
          <span class="page__eyebrow">
            <span class="page__eyebrow-dot" aria-hidden="true"></span> Drivers
          </span>
          <p class="page__subtitle">
            Manage your fleet — search, filter and review active and deactivated drivers in one place.
          </p>
        </div>
        <div class="page__hero-right">
          <!-- Table / Graph view toggle -->
          <div class="view-toggle" role="group" aria-label="View mode">
            <button
              type="button"
              class="view-toggle__btn"
              [class.is-active]="view === 'table'"
              [attr.aria-pressed]="view === 'table'"
              (click)="setView('table')"
              title="Table view"
            >
              <tm-icon name="menu" [size]="14" />
              <span>Table</span>
            </button>
            <button
              type="button"
              class="view-toggle__btn"
              [class.is-active]="view === 'graph'"
              [attr.aria-pressed]="view === 'graph'"
              (click)="setView('graph')"
              title="Graph view"
            >
              <tm-icon name="chart-bar" [size]="14" />
              <span>Graph</span>
            </button>
          </div>

          <tm-button
            *ngIf="view === 'table'"
            variant="outline"
            icon="chart-bar"
            (clicked)="openInsights('leaderboard')"
          >
            Insights
          </tm-button>
          <tm-button variant="green" icon="download"
                     [loading]="exporting" [disabled]="!!legacyStand"
                     [title]="legacyStand ? 'Stand-filtered CSV requires the updated backend' : ''"
                     (clicked)="exportCsv()">
            Export CSV
          </tm-button>
        </div>
      </header>

      <div class="approval-views" role="group" aria-label="Driver approval views">
        <button *ngFor="let option of approvalViews" type="button"
                [class.is-active]="approval === option.value || (option.value === 'not_approved' && (approval === 'pending' || approval === 'rejected'))"
                [attr.aria-pressed]="approval === option.value || (option.value === 'not_approved' && (approval === 'pending' || approval === 'rejected'))"
                (click)="selectApproval(option.value)">{{ option.label }}</button>
      </div>
      <p class="approval-hint" *ngIf="approval === 'not_approved'">Pending and rejected drivers. Open a driver to review their approval.</p>

      <!-- =================== Graph view =================== -->
      <section class="graphs" *ngIf="view === 'graph'">
        <p class="graphs__hint">
          Visualizing the current page of <strong>{{ rows.length }}</strong> of <strong>{{ total | number }}</strong> drivers.
          Bump <em>Rows per page</em> in Table view for a wider sample.
        </p>

        <!-- ===== KPI strip — fastest read of the fleet's state ===== -->
        <div class="kpi-strip">
          <div class="kpi">
            <div class="kpi__icon kpi__icon--ink"><tm-icon name="users" [size]="18" /></div>
            <div class="kpi__body">
              <span class="kpi__value">{{ rows.length | number }}</span>
              <span class="kpi__label">Drivers in view</span>
              <span class="kpi__sub">of {{ total | number }} total</span>
            </div>
          </div>
          <div class="kpi">
            <div class="kpi__icon kpi__icon--green"><tm-icon name="bolt" [size]="18" /></div>
            <div class="kpi__body">
              <span class="kpi__value">{{ stats.online | number }}</span>
              <span class="kpi__label">Online now</span>
              <span class="kpi__sub">{{ stats.onlinePct }}% of page</span>
            </div>
          </div>
          <div class="kpi">
            <div class="kpi__icon kpi__icon--green"><tm-icon name="shield" [size]="18" /></div>
            <div class="kpi__body">
              <span class="kpi__value">{{ stats.approvalRate }}%</span>
              <span class="kpi__label">Approval rate</span>
              <span class="kpi__sub">{{ stats.approved }} approved · {{ stats.pending }} pending</span>
            </div>
          </div>
          <div class="kpi">
            <div class="kpi__icon kpi__icon--amber"><tm-icon name="star" [size]="18" /></div>
            <div class="kpi__body">
              <span class="kpi__value">{{ stats.medianRides | number }}</span>
              <span class="kpi__label">Median total rides</span>
              <span class="kpi__sub">Avg {{ stats.avgRides | number:'1.0-1' }} per driver</span>
            </div>
          </div>
        </div>

        <!-- ===== Section 1: Composition (who they are) ===== -->
        <h4 class="graphs__section">Composition <span class="graphs__section-sub">— who's in the fleet right now</span></h4>
        <div class="graphs__grid">
          <article class="graphs__card">
            <header class="graphs__card-head">
              <h3 class="graphs__title">
                <tm-icon name="shield" [size]="14" /> Approval status
              </h3>
              <span class="graphs__hint-mini">Higher approved % → less admin queue</span>
            </header>
            <tm-chart type="doughnut" [config]="approvalChart" [height]="220" />
          </article>

          <article class="graphs__card">
            <header class="graphs__card-head">
              <h3 class="graphs__title">
                <tm-icon name="bolt" [size]="14" /> Live activity
              </h3>
              <span class="graphs__hint-mini">Drivers reachable for dispatch right now</span>
            </header>
            <tm-chart type="doughnut" [config]="activityChart" [height]="220" />
          </article>

          <article class="graphs__card">
            <header class="graphs__card-head">
              <h3 class="graphs__title">
                <tm-icon name="user" [size]="14" /> Account state
              </h3>
              <span class="graphs__hint-mini">Active vs. deactivated drivers</span>
            </header>
            <tm-chart type="polarArea" [config]="stateChart" [height]="220" />
          </article>

          <article class="graphs__card">
            <header class="graphs__card-head">
              <h3 class="graphs__title">
                <tm-icon name="car" [size]="14" /> Vehicle mix
              </h3>
              <span class="graphs__hint-mini">Driver count per vehicle type</span>
            </header>
            <tm-chart type="bar" [config]="vehicleTypeChart" [height]="220" />
          </article>
        </div>

        <!-- ===== Section 2: Distribution (how much they drive) ===== -->
        <h4 class="graphs__section">Distribution <span class="graphs__section-sub">— spread of ride volume</span></h4>
        <div class="graphs__grid">
          <article class="graphs__card graphs__card--wide">
            <header class="graphs__card-head">
              <h3 class="graphs__title">
                <tm-icon name="chart-bar" [size]="14" /> Ride volume buckets
              </h3>
              <span class="graphs__hint-mini">How many drivers fall into each lifetime-rides bucket</span>
            </header>
            <tm-chart type="bar" [config]="ridesHistogramChart" [height]="240" />
          </article>

          <article class="graphs__card">
            <header class="graphs__card-head">
              <h3 class="graphs__title">
                <tm-icon name="chart-line" [size]="14" /> Recent vs. lifetime
              </h3>
              <span class="graphs__hint-mini">Each dot is a driver — 7-day rides vs. total</span>
            </header>
            <tm-chart type="scatter" [config]="recentVsLifetimeChart" [height]="260" />
          </article>

          <article class="graphs__card">
            <header class="graphs__card-head">
              <h3 class="graphs__title">
                <tm-icon name="refresh" [size]="14" /> Registrations
              </h3>
              <span class="graphs__hint-mini">Sign-ups per day, last 30 days</span>
            </header>
            <tm-chart type="line" [config]="registrationsChart" [height]="260" />
          </article>
        </div>

        <!-- ===== Section 3: Top performers ===== -->
        <h4 class="graphs__section">Top performers <span class="graphs__section-sub">— who's earning the most rides</span></h4>
        <div class="graphs__grid">
          <article class="graphs__card graphs__card--wide">
            <header class="graphs__card-head">
              <h3 class="graphs__title">
                <tm-icon name="star" [size]="14" /> Top 10 by total rides
              </h3>
              <span class="graphs__hint-mini">Lifetime completed-trip count, from current page</span>
            </header>
            <tm-chart type="bar" [config]="topRidesChart" [height]="280" />
          </article>

          <article class="graphs__card graphs__card--wide">
            <header class="graphs__card-head">
              <h3 class="graphs__title">
                <tm-icon name="bolt" [size]="14" /> Most active in last 7 days
              </h3>
              <span class="graphs__hint-mini">Recent activity — find your current grinders</span>
            </header>
            <tm-chart type="bar" [config]="top7dChart" [height]="240" />
          </article>
        </div>

        <!-- Leaderboard inline — feeds from /admin/drivers/leaderboard -->
        <article class="graphs__card graphs__card--wide graphs__embed">
          <header class="graphs__card-head">
            <h3 class="graphs__title">Driver leaderboard</h3>
            <span class="graphs__hint-mini">Ranked by completed rides</span>
          </header>
          <app-drivers-insights mode="leaderboard" view="graph" [active]="true" />
        </article>

        <!-- Performance inline — feeds from /admin/drivers/performance -->
        <article class="graphs__card graphs__card--wide graphs__embed">
          <header class="graphs__card-head">
            <h3 class="graphs__title">Driver performance</h3>
            <span class="graphs__hint-mini">Successful / Cancelled / Missed breakdown</span>
          </header>
          <app-drivers-insights mode="performance" view="graph" [active]="true" />
        </article>
      </section>

      <tm-modal [open]="!!allocationDriver" [title]="(allocationDriver?.user?.name || 'Driver') + ' — Stand &amp; Route Assignments'"
                (closed)="allocationDriver = null">
        <div slot="body">
          <app-driver-route-groups-panel *ngIf="allocationDriver as driver" [driverId]="driver.id" [readOnly]="true" />
        </div>
      </tm-modal>
      <!-- =================== Reusable table =================== -->
      <tm-data-table
        class="drivers-table"
        *ngIf="view === 'table'"
        [rows]="rows"
        [total]="total"
        [page]="page"
        [pageSize]="pageSize"
        [pageSizes]="[10, 25, 50, 100]"
        [loading]="loading"
        emptyTitle="No drivers"
        emptyHint="Try a different search, or adjust the filters above."
        (pageChange)="onPageChange($event)"
        (pageSizeChange)="onPageSizeChange($event)"
      >
        <!-- Toolbar: search on the LEFT -->
        <tm-input
          slot="search"
          icon="search"
          placeholder="Search drivers"
          [(ngModel)]="search"
          (ngModelChange)="onSearchChange()"
        />

        <!-- Toolbar: filters on the RIGHT -->
        <ng-container slot="filters">
          <tm-filter-select *ngIf="allocationFiltersSupported || cityCounts" icon="map-marker"
            ariaLabel="Driver city" allLabel="All cities" searchPlaceholder="Search cities"
            [options]="cityOptions" [value]="cityFilterValue"
            (valueChange)="selectDriverCity($event === 'all' ? null : +$event)" (focusin)="onDocumentClick()" />
          <tm-filter-select *ngIf="allocationFiltersSupported || cityCounts" icon="pin" ariaLabel="Driver stand"
            searchPlaceholder="Search stands"
            [allLabel]="standFilterLabel"
            [options]="standOptions" [value]="selectedStandId?.toString() ?? 'all'"
            [disabled]="cityScope === 'all' || standCountsLoading || standCountsFailed || !standCounts.length"
            (valueChange)="selectDriverStand($event === 'all' ? null : +$event)" (focusin)="onDocumentClick()" />
          <button type="button" class="allocation-filter" *ngIf="standCountsFailed" (click)="loadStandCounts()">Retry stands</button>
          <tm-filter-select *ngIf="allocationFiltersSupported" icon="car" ariaLabel="Driver vehicle" allLabel="All vehicles"
            searchPlaceholder="Search vehicles"
            [options]="vehicleOptions" [value]="allocationVehicleId?.toString() ?? 'all'"
            [disabled]="!allocationCityId || (!!cityCounts && cityScope === 'all')"
            (valueChange)="selectDriverVehicle($event)" (focusin)="onDocumentClick()" />
          <!-- State select (Active / Deactivated / All) — custom dropdown for full CSS control -->
          <div class="state-select" [class.has-value]="state !== 'all'" [class.is-open]="stateOpen">
            <button
              type="button"
              class="state-select__trigger"
              (click)="toggleStateMenu($event)"
              [attr.aria-expanded]="stateOpen"
              aria-haspopup="listbox"
              aria-label="Activation status filter"
            >
              <span class="state-select__icon" aria-hidden="true">
                <tm-icon name="user" [size]="14" />
              </span>
              <span class="state-select__value">{{ stateLabel() }}</span>
              <tm-icon name="chevron-down" [size]="12" class="state-select__caret" />
            </button>
            <ul
              class="state-select__menu"
              *ngIf="stateOpen"
              role="listbox"
              (click)="$event.stopPropagation()"
            >
              <li
                *ngFor="let opt of stateOptions"
                class="state-select__option"
                [class.is-selected]="state === opt.value"
                role="option"
                [attr.aria-selected]="state === opt.value"
                (click)="selectState(opt.value)"
              >
                <tm-icon
                  *ngIf="state === opt.value"
                  name="check"
                  [size]="12"
                  class="state-select__option-check"
                />
                <span class="state-select__option-label">{{ opt.label }}</span>
              </li>
            </ul>
          </div>

          <!-- Activity (Online / Offline) filter -->
          <div class="state-select" [class.has-value]="online !== 'all'" [class.is-open]="onlineOpen">
            <button
              type="button"
              class="state-select__trigger"
              (click)="toggleOnlineMenu($event)"
              [attr.aria-expanded]="onlineOpen"
              aria-haspopup="listbox"
              aria-label="Online status filter"
            >
              <span class="state-select__icon" aria-hidden="true">
                <tm-icon name="bolt" [size]="14" />
              </span>
              <span class="state-select__value">{{ onlineLabel() }}</span>
              <tm-icon name="chevron-down" [size]="12" class="state-select__caret" />
            </button>
            <ul class="state-select__menu" *ngIf="onlineOpen" role="listbox" (click)="$event.stopPropagation()">
              <li
                *ngFor="let opt of onlineOptions"
                class="state-select__option"
                [class.is-selected]="online === opt.value"
                role="option"
                [attr.aria-selected]="online === opt.value"
                (click)="selectOnline(opt.value)"
              >
                <tm-icon *ngIf="online === opt.value" name="check" [size]="12" class="state-select__option-check" />
                <span class="state-select__option-label">{{ opt.label }}</span>
              </li>
            </ul>
          </div>

          <!-- Approval (Approved / Pending / Disapproved) filter -->
          <div class="state-select" [class.has-value]="approval !== 'all'" [class.is-open]="approvalOpen">
            <button
              type="button"
              class="state-select__trigger"
              (click)="toggleApprovalMenu($event)"
              [attr.aria-expanded]="approvalOpen"
              aria-haspopup="listbox"
              aria-label="Approval status filter"
            >
              <span class="state-select__icon" aria-hidden="true">
                <tm-icon name="shield" [size]="14" />
              </span>
              <span class="state-select__value">{{ approvalLabel() }}</span>
              <tm-icon name="chevron-down" [size]="12" class="state-select__caret" />
            </button>
            <ul class="state-select__menu" *ngIf="approvalOpen" role="listbox" (click)="$event.stopPropagation()">
              <li
                *ngFor="let opt of approvalOptions"
                class="state-select__option"
                [class.is-selected]="approval === opt.value"
                role="option"
                [attr.aria-selected]="approval === opt.value"
                (click)="selectApproval(opt.value)"
              >
                <tm-icon *ngIf="approval === opt.value" name="check" [size]="12" class="state-select__option-check" />
                <span class="state-select__option-label">{{ opt.label }}</span>
              </li>
            </ul>
          </div>

          <!-- Date range picker — filters by drivers.created_at -->
          <div class="date-range" [class.has-value]="dateFrom || dateTo">
            <span class="date-range__icon" aria-hidden="true">
              <tm-icon name="calendar" [size]="14" />
            </span>
            <input
              #rangeInput
              type="text"
              readonly
              class="date-range__input"
              [placeholder]="'Registered · any date'"
              [value]="rangeLabel"
              aria-label="Filter by registered date range"
            />
            <button
              *ngIf="dateFrom || dateTo"
              type="button"
              class="date-range__clear"
              (click)="clearDateRange(); $event.stopPropagation()"
              aria-label="Clear date range"
            >
              <tm-icon name="x" [size]="12" />
            </button>
          </div>
        </ng-container>

        <!-- Active filter pills below the toolbar -->
        <ng-container slot="banner">
          <span class="filter-pill" *ngIf="state !== 'all'">
            <span class="filter-pill__icon">
              <tm-icon name="user" [size]="11" />
            </span>
            <span class="filter-pill__label">Status</span>
            <span class="filter-pill__value">
              {{ state === 'active' ? 'Active' : 'Deactivated' }}
            </span>
            <button
              type="button"
              class="filter-pill__close"
              (click)="clearState()"
              aria-label="Clear status filter"
            >
              <tm-icon name="x" [size]="12" />
            </button>
          </span>
          <span class="filter-pill" *ngIf="dateFrom || dateTo">
            <span class="filter-pill__icon">
              <tm-icon name="calendar" [size]="11" />
            </span>
            <span class="filter-pill__label">Registered</span>
            <span class="filter-pill__value">
              {{ formatDate(dateFrom) }} → {{ formatDate(dateTo) }}
            </span>
            <button
              type="button"
              class="filter-pill__close"
              (click)="clearDateRange()"
              aria-label="Clear date range"
            >
              <tm-icon name="x" [size]="12" />
            </button>
          </span>
          <span class="filter-pill" *ngIf="online !== 'all'">
            <span class="filter-pill__icon">
              <tm-icon name="bolt" [size]="11" />
            </span>
            <span class="filter-pill__label">Activity</span>
            <span class="filter-pill__value">{{ online === 'online' ? 'Online' : 'Offline' }}</span>
            <button type="button" class="filter-pill__close" (click)="clearOnline()" aria-label="Clear activity filter">
              <tm-icon name="x" [size]="12" />
            </button>
          </span>
          <span class="filter-pill" *ngIf="approval !== 'all'">
            <span class="filter-pill__icon">
              <tm-icon name="shield" [size]="11" />
            </span>
            <span class="filter-pill__label">Approval</span>
            <span class="filter-pill__value">{{ approvalLabel() }}</span>
            <button type="button" class="filter-pill__close" (click)="clearApproval()" aria-label="Clear approval filter">
              <tm-icon name="x" [size]="12" />
            </button>
          </span>
        </ng-container>

        <!-- ============ Columns ============ -->
        <tm-column key="id" label="Driver ID" width="110">
          <ng-template let-row>
            <span class="cell-id cell-id--static">#{{ row.id }}</span>
          </ng-template>
        </tm-column>

        <tm-column key="name" label="Driver">
          <ng-template let-row>
            <div class="cell-user">
              <span
                class="cell-avatar"
                [class.cell-avatar--photo]="row.user?.avatar_url || row.user?.avatar_path"
                [style.backgroundImage]="(row.user?.avatar_url || row.user?.avatar_path) ? 'url(' + (row.user?.avatar_url || row.user?.avatar_path) + ')' : null"
              >
                <ng-container *ngIf="!(row.user?.avatar_url || row.user?.avatar_path)">{{ initials(row.user?.name) }}</ng-container>
              </span>
              <div class="cell-user__meta">
                <span class="cell-user__name">{{ row.user?.name || 'Unnamed' }}</span>
                <span class="cell-user__sub" *ngIf="row.vehicle_type">{{ row.vehicle_type }}</span>
                <span class="cell-user__sub mono" *ngIf="row.vehicle_reg_no">{{ row.vehicle_reg_no }}</span>
              </div>
            </div>
          </ng-template>
        </tm-column>

        <tm-column key="contact" label="Contact" width="240">
          <ng-template let-row>
            <div class="cell-contact">
              <span class="cell-contact__email" [class.muted]="!row.user?.email">
                {{ row.user?.email || '—' }}
              </span>
              <span class="cell-contact__phone mono">{{ row.user?.phone || '—' }}</span>
            </div>
          </ng-template>
        </tm-column>

        <tm-column *ngIf="cityCounts" key="cities" label="Cities" [wrap]="true">
          <ng-template let-row>
            <ng-container *ngFor="let city of row.cities; let last = last">{{ city.name }}{{ last ? '' : ', ' }}</ng-container>
            <span class="muted" *ngIf="!row.cities?.length">—</span>
          </ng-template>
        </tm-column>
        <tm-column key="assignments" label="Stand &amp; Route Assignments" width="220">
          <ng-template let-row>
            <button type="button" class="allocation-view" title="View stand and route assignments"
                    (click)="allocationDriver = row">
              <span>
                @if (row.route_groups) {
                  {{ row.route_groups.length | i18nPlural: standCountLabels }}
                }
                @if (row.allocated_route_count != null) {
                  <ng-container *ngIf="row.route_groups"> · </ng-container>
                  {{ row.allocated_route_count | i18nPlural: routeCountLabels }}
                } @else if (!row.route_groups) {
                  View assignments
                }
              </span>
            </button>
          </ng-template>
        </tm-column>
        <tm-column key="registered_on" label="Registered" width="140">
          <ng-template let-row>
            <span class="mono">
              {{ row.registered_on ? (row.registered_on | date:'MMM d, y') : '—' }}
            </span>
          </ng-template>
        </tm-column>

        <tm-column key="rides_7d_total" label="Rides (7d / total)" width="145">
          <ng-template let-row>
            <span class="rides-chip" [class.is-zero]="!row.rides_7d && !row.total_rides"
                  title="Completed rides in the last 7 days / all completed rides">
              {{ row.rides_7d ?? 0 }} / {{ row.total_rides ?? 0 }}
            </span>
          </ng-template>
        </tm-column>

        <tm-column key="status" label="Status" width="135">
          <ng-template let-row>
            @if (row.deactivated_at) {
              <span
                class="status-pill is-deactivated"
                title="Driver is deactivated — dispatch is stopped"
              >
                <span class="status-dot"></span>
                Deactivated
              </span>
            } @else if (row.approval_status === 'pending' || row.approval_status === 'rejected') {
              <span class="status-pill"
                    [class.is-rejected]="row.approval_status === 'rejected'"
                    [class.is-pending]="row.approval_status === 'pending'"
                    [title]="'Approval: ' + row.approval_status">
                <span class="status-dot"></span>
                {{ row.approval_status }}
              </span>
            } @else {
              <span
                class="status-pill"
                [class.is-online]="row.is_online"
                [class.is-offline]="!row.is_online"
                [title]="row.is_online ? 'Driver is online and receiving rides' : 'Driver is offline'"
              >
                <span class="status-dot"></span>
                {{ row.is_online ? 'Online' : 'Offline' }}
              </span>
            }
          </ng-template>
        </tm-column>

        <tm-column key="view" label="" width="64" align="right">
          <ng-template let-row>
            <div class="id-pop" [class.is-open]="openPopoverId === row.id">
              <button
                type="button"
                class="row-icon-btn"
                [class.is-open]="openPopoverId === row.id"
                (click)="togglePopover(row, $event)"
                [attr.aria-expanded]="openPopoverId === row.id"
                aria-label="View driver details"
                title="View driver details"
              >
                <tm-icon name="eye" [size]="16" aria-hidden="true" />
              </button>
              <div
                class="id-pop__panel"
                *ngIf="openPopoverId === row.id"
                role="dialog"
                (click)="$event.stopPropagation()"
                [style.top.px]="popoverTop"
                [style.left.px]="popoverLeft"
              >
                <header class="id-pop__head">
                  <span
                    class="cell-avatar"
                    [class.cell-avatar--photo]="row.user?.avatar_url || row.user?.avatar_path"
                    [style.backgroundImage]="(row.user?.avatar_url || row.user?.avatar_path) ? 'url(' + (row.user?.avatar_url || row.user?.avatar_path) + ')' : null"
                  >
                    <ng-container *ngIf="!(row.user?.avatar_url || row.user?.avatar_path)">{{ initials(row.user?.name) }}</ng-container>
                  </span>
                  <div class="id-pop__title">
                    <div class="id-pop__name">{{ row.user?.name || 'Unnamed' }}</div>
                    <div class="id-pop__id mono">#{{ row.id }}</div>
                  </div>
                  <button
                    type="button"
                    class="id-pop__close"
                    (click)="closePopover()"
                    aria-label="Close"
                  >
                    <tm-icon name="x" [size]="12" />
                  </button>
                </header>
                <div class="id-pop__rows">
                  <div class="id-pop__row">
                    <span class="lbl">Phone</span>
                    <span class="mono">{{ row.user?.phone || '—' }}</span>
                  </div>
                  <div class="id-pop__row">
                    <span class="lbl">Email</span>
                    <span [class.muted]="!row.user?.email">{{ row.user?.email || '—' }}</span>
                  </div>
                  <div class="id-pop__row">
                    <span class="lbl">Vehicle</span>
                    <span class="mono">{{ row.vehicle_reg_no || '—' }}</span>
                  </div>
                  <div class="id-pop__row">
                    <span class="lbl">Vehicle type</span>
                    <span>{{ row.vehicle_type || '—' }}</span>
                  </div>
                  <div class="id-pop__row">
                    <span class="lbl">Registered</span>
                    <span class="mono">
                      {{ row.registered_on ? (row.registered_on | date:'MMM d, y') : '—' }}
                    </span>
                  </div>
                  <div class="id-pop__row">
                    <span class="lbl">Last login</span>
                    <span class="mono">
                      {{ row.last_login ? (row.last_login | date:'MMM d, HH:mm') : '—' }}
                    </span>
                  </div>
                  <div class="id-pop__row">
                    <span class="lbl">Total rides</span>
                    <span class="rides-chip" [class.is-zero]="!row.total_rides">
                      {{ row.total_rides ?? 0 }}
                    </span>
                  </div>
                  <div class="id-pop__row" *ngIf="row.deactivated_at">
                    <span class="lbl">Deactivated</span>
                    <span class="mono">{{ row.deactivated_at | date:'MMM d, y' }}</span>
                  </div>
                </div>
                <footer class="id-pop__foot">
                  <button
                    type="button"
                    class="id-pop__link"
                    (click)="openProfile(row.id, $event)"
                  >
                    View details <tm-icon name="arrow-right" [size]="12" />
                  </button>
                </footer>
              </div>
            </div>
          </ng-template>
        </tm-column>
        <tm-column key="action" label="" width="64" align="right">
          <ng-template let-row>
            <button
              type="button"
              class="row-icon-btn"
              [class.is-reactivate]="row.deactivated_at"
              [class.is-deactivate]="!row.deactivated_at"
              [attr.aria-label]="row.deactivated_at ? 'Reactivate driver' : 'Deactivate driver'"
              [title]="row.deactivated_at ? 'Reactivate driver' : 'Deactivate driver'"
              [attr.aria-busy]="busyId === row.id ? 'true' : null"
              [disabled]="busyId === row.id"
              (click)="row.deactivated_at ? reactivate(row) : deactivate(row)"
            >
              <tm-icon [name]="busyId === row.id ? 'clock' : row.deactivated_at ? 'refresh' : 'ban'"
                       [size]="16" aria-hidden="true" />
            </button>
          </ng-template>
        </tm-column>
      </tm-data-table>

      <!-- Deactivation confirmation modal -->
      <tm-modal
        [open]="deactivateOpen"
        title="Deactivate driver"
        [dismissible]="busyId === null"
        (closed)="closeDeactivateModal()"
      >
        <ng-container slot="body">
          <div class="deact" *ngIf="deactivateTarget as t">
            <div class="deact__alert">
              <span class="deact__alert-icon" aria-hidden="true">
                <tm-icon name="x" [size]="14" />
              </span>
              <div class="deact__alert-body">
                <strong>This will stop dispatch for this driver.</strong>
                <span class="deact__alert-sub">
                  They won't receive new ride requests until you reactivate them.
                </span>
              </div>
            </div>

            <div class="deact__who">
              <span
                class="cell-avatar"
                [class.cell-avatar--photo]="t.user?.avatar_url || t.user?.avatar_path"
                [style.backgroundImage]="(t.user?.avatar_url || t.user?.avatar_path) ? 'url(' + (t.user?.avatar_url || t.user?.avatar_path) + ')' : null"
              >
                <ng-container *ngIf="!(t.user?.avatar_url || t.user?.avatar_path)">{{ initials(t.user?.name) }}</ng-container>
              </span>
              <div class="deact__who-meta">
                <span class="deact__who-name">{{ t.user?.name || 'Unnamed' }}</span>
                <span class="deact__who-sub mono">#{{ t.id }} · {{ t.user?.phone || '—' }}</span>
              </div>
            </div>

            <label class="deact__lbl" for="deact-reason">
              Reason <span class="deact__lbl-opt">(optional, shown to the driver)</span>
            </label>
            <textarea
              id="deact-reason"
              class="deact__reason"
              rows="3"
              [(ngModel)]="deactivateReason"
              [disabled]="busyId !== null"
              placeholder="e.g. Document re-verification required."
            ></textarea>
          </div>
        </ng-container>

        <ng-container slot="footer">
          <tm-button
            variant="ghost"
            (clicked)="closeDeactivateModal()"
            [disabled]="busyId !== null"
          >
            Cancel
          </tm-button>
          <tm-button
            variant="danger"
            [loading]="busyId !== null && busyId === deactivateTarget?.id"
            (clicked)="confirmDeactivate()"
          >
            Deactivate driver
          </tm-button>
        </ng-container>
      </tm-modal>

      <!-- ============ Insights drawer (Leaderboard / Performance) ============ -->
      <div
        *ngIf="insightsMounted"
        class="drawer"
        [class.is-closing]="insightsClosing"
        role="dialog"
        aria-modal="true"
        aria-labelledby="insights-drawer-title"
        (click)="closeInsights()"
      >
        <aside
          class="drawer__panel"
          [class.is-closing]="insightsClosing"
          (click)="$event.stopPropagation()"
        >
          <header class="drawer__head">
            <div class="drawer__head-left">
              <h2 id="insights-drawer-title" class="drawer__title">
                <tm-icon name="chart-bar" [size]="18" />
                Driver Insights
              </h2>
              <p class="drawer__sub">
                {{ insightsMode === 'leaderboard'
                  ? 'Rank drivers by completed-ride count over a fixed period.'
                  : 'Break ride outcomes into Successful / Cancelled / Missed over a date range.' }}
              </p>
            </div>
            <button
              type="button"
              class="drawer__close"
              (click)="closeInsights()"
              aria-label="Close insights"
            >
              <tm-icon name="x" [size]="16" />
            </button>
          </header>

          <!-- Segmented tabs + view toggle -->
          <div class="drawer__tabs-row">
            <nav class="drawer__tabs" role="tablist" aria-label="Insight view">
              <button
                type="button"
                role="tab"
                class="drawer__tab"
                [class.is-active]="insightsMode === 'leaderboard'"
                [attr.aria-selected]="insightsMode === 'leaderboard'"
                (click)="switchInsightsTab('leaderboard')"
              >
                <tm-icon name="bolt" [size]="14" />
                <span>Leaderboard</span>
              </button>
              <button
                type="button"
                role="tab"
                class="drawer__tab"
                [class.is-active]="insightsMode === 'performance'"
                [attr.aria-selected]="insightsMode === 'performance'"
                (click)="switchInsightsTab('performance')"
              >
                <tm-icon name="chart-bar" [size]="14" />
                <span>Performance</span>
              </button>
            </nav>

            <div class="view-toggle" role="group" aria-label="View mode">
              <button
                type="button"
                class="view-toggle__btn"
                [class.is-active]="view === 'table'"
                [attr.aria-pressed]="view === 'table'"
                (click)="setView('table')"
                title="Table view"
              >
                <tm-icon name="menu" [size]="14" />
                <span>Table</span>
              </button>
              <button
                type="button"
                class="view-toggle__btn"
                [class.is-active]="view === 'graph'"
                [attr.aria-pressed]="view === 'graph'"
                (click)="setView('graph')"
                title="Graph view"
              >
                <tm-icon name="chart-bar" [size]="14" />
                <span>Graph</span>
              </button>
            </div>
          </div>

          <div class="drawer__body">
            <app-drivers-insights
              [mode]="insightsMode"
              [view]="view"
              [active]="insightsOpen"
              (driverClick)="onInsightsDriverClick($event)"
            />
          </div>
        </aside>
      </div>
    </div>
  `,
  styles: [`
    .approval-views { display: flex; flex-wrap: wrap; gap: 8px; }
    .approval-views button { border: 1px solid var(--tm-line); border-radius: 8px; padding: 10px 18px; background: var(--tm-surface); color: var(--tm-text-muted); font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; }
    .approval-views button.is-active { background: var(--tm-success-bg, #ecfdf5); border-color: var(--tm-success, #16a34a); color: var(--tm-text); }
    .approval-hint { margin: 0; color: var(--tm-text-muted); font-size: 12px; }
    .allocation-filter { padding: 8px 10px; border: 1px solid var(--tm-line); border-radius: var(--tm-radius-sm); background: var(--tm-surface); color: var(--tm-text); font: inherit; font-size: 12px; max-width: 170px; }
    .drivers-table {
      --tm-dt-cell-padding: 8px 10px;
      --driver-filter-height: 36px;
      container: driver-table / inline-size;
    }
    .allocation-view { padding: 0; border: 0; background: transparent; color: var(--tm-green-deep); font: inherit; font-size: 12px; font-weight: 700; cursor: pointer; }
    :host { display: block; }

    .page {
      display: flex;
      flex-direction: column;
      gap: var(--tm-space-5);
    }

    /* ---------- Hero ---------- */
    .page__hero {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--tm-space-4);
      flex-wrap: wrap;
    }
    .page__hero-left { min-width: 0; }
    .page__eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      margin-bottom: var(--tm-space-2);
      font-size: 24px;
      font-weight: 800;
      letter-spacing: -0.02em;
      color: var(--tm-text);
      line-height: 1.2;
    }
    .page__eyebrow-dot {
      width: 9px; height: 9px;
      border-radius: 50%;
      background: var(--tm-green);
      box-shadow: 0 0 0 4px var(--tm-green-soft);
    }
    .page__subtitle {
      font-size: 14px;
      color: var(--tm-text-muted);
      font-weight: 500;
      margin: 0;
      max-width: 60ch;
    }
    .page__hero-right {
      display: flex;
      gap: var(--tm-space-2);
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    /* ---------- Table / Graph view toggle ---------- */
    .view-toggle {
      display: inline-flex;
      padding: 3px;
      background: var(--tm-canvas-2);
      border-radius: var(--tm-radius-md);
      gap: 2px;
    }
    .view-toggle__btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 12px;
      border: 0;
      background: transparent;
      color: var(--tm-text-muted);
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      border-radius: calc(var(--tm-radius-md) - 3px);
      transition: background var(--tm-duration-fast) var(--tm-ease),
                  color var(--tm-duration-fast) var(--tm-ease),
                  box-shadow var(--tm-duration-fast) var(--tm-ease);
    }
    .view-toggle__btn:hover:not(.is-active) { color: var(--tm-text); }
    .view-toggle__btn.is-active {
      background: var(--tm-surface);
      color: var(--tm-text);
      box-shadow: 0 1px 3px rgba(15,20,25,0.08);
    }

    /* ---------- Graph view ---------- */
    .graphs { display: flex; flex-direction: column; gap: var(--tm-space-4); }
    .graphs__hint {
      margin: 0;
      padding: 10px 14px;
      background: var(--tm-canvas);
      border: 1px solid var(--tm-line);
      border-radius: var(--tm-radius-sm);
      font-size: 12px;
      color: var(--tm-text-muted);
    }
    .graphs__hint strong { color: var(--tm-text); font-weight: 700; }

    .graphs__section {
      margin: var(--tm-space-2) 0 calc(-1 * var(--tm-space-2));
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--tm-text);
    }
    .graphs__section-sub {
      font-weight: 500;
      letter-spacing: 0;
      text-transform: none;
      color: var(--tm-text-muted);
      margin-left: 6px;
    }

    .graphs__grid {
      display: grid;
      gap: var(--tm-space-3);
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    }
    .graphs__card {
      background: var(--tm-surface);
      border: 1px solid var(--tm-line);
      border-radius: var(--tm-radius-md);
      padding: var(--tm-space-4);
      display: flex;
      flex-direction: column;
      gap: var(--tm-space-3);
    }
    .graphs__card--wide { grid-column: 1 / -1; }
    .graphs__card-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }
    .graphs__title {
      margin: 0;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      font-weight: 800;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--tm-text);
    }
    .graphs__title tm-icon { color: var(--tm-green-deep); }
    .graphs__hint-mini {
      font-size: 11px;
      font-weight: 600;
      color: var(--tm-text-muted);
      max-width: 60%;
      text-align: right;
    }

    /* ---------- KPI strip ---------- */
    .kpi-strip {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: var(--tm-space-3);
    }
    .kpi {
      display: flex;
      align-items: center;
      gap: 14px;
      background: var(--tm-surface);
      border: 1px solid var(--tm-line);
      border-radius: var(--tm-radius-md);
      padding: var(--tm-space-3) var(--tm-space-4);
    }
    .kpi__icon {
      width: 40px;
      height: 40px;
      border-radius: 12px;
      display: grid;
      place-items: center;
      flex-shrink: 0;
    }
    .kpi__icon--ink   { background: var(--tm-ink); color: #fff; }
    .kpi__icon--green { background: var(--tm-green-tint); color: var(--tm-green-deep); }
    .kpi__icon--amber { background: #fffbeb; color: #b45309; }
    .kpi__body { display: flex; flex-direction: column; min-width: 0; }
    .kpi__value {
      font-family: var(--tm-font-mono);
      font-size: 22px;
      font-weight: 800;
      line-height: 1.1;
      color: var(--tm-text);
    }
    .kpi__label {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--tm-text-muted);
      margin-top: 2px;
    }
    .kpi__sub {
      font-size: 11px;
      color: var(--tm-text-soft);
      margin-top: 2px;
    }
    /* Embedded <app-drivers-insights> already has its own inner padding,
       so drop the outer card padding for that variant. */
    .graphs__embed { padding: var(--tm-space-3); }
    .graphs__embed :host ::ng-deep .graph-card,
    .graphs__embed ::ng-deep .graph-card {
      border: 0;
      padding: 0;
    }
    @media (max-width: 540px) {
      .view-toggle__btn span { display: none; }
      .view-toggle__btn { padding: 7px 10px; }
    }

    /* ---------- Custom state-select dropdown (button + popover) ---------- */
    .state-select {
      position: relative;
      display: inline-block;
    }
    .state-select__trigger {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 9px 14px;
      border: 1px solid var(--tm-line-2);
      border-radius: var(--tm-radius-md);
      background: transparent;
      font-family: var(--tm-font-body);
      font-size: 13px;
      font-weight: 700;
      color: var(--tm-text);
      cursor: pointer;
      line-height: 1.2;
      transition: border-color var(--tm-duration-fast) var(--tm-ease),
                  background var(--tm-duration-fast) var(--tm-ease);
    }
    .state-select__trigger { width: 100%; height: var(--driver-filter-height); }
    .state-select__trigger:hover { border-color: var(--tm-ink); }
    .state-select.is-open .state-select__trigger { border-color: var(--tm-ink); }
    .state-select.has-value .state-select__trigger {
      background: var(--tm-green-tint);
      border-color: var(--tm-green-deep);
    }
    .state-select__icon { color: var(--tm-text-muted); display: inline-flex; }
    .state-select.has-value .state-select__icon { color: var(--tm-green-deep); }
    .state-select__value { flex: 1; min-width: 0; text-align: left; }
    .state-select__caret {
      color: var(--tm-text-soft);
      transition: transform var(--tm-duration-fast) var(--tm-ease);
    }
    .state-select.is-open .state-select__caret { transform: rotate(180deg); }
    .state-select.has-value .state-select__caret { color: var(--tm-green-deep); }

    /* Dropdown menu */
    .state-select__menu {
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      right: 0;
      min-width: 180px;
      margin: 0;
      padding: 6px;
      list-style: none;
      background: var(--tm-surface);
      border: 1px solid var(--tm-line-2);
      border-radius: var(--tm-radius-md);
      box-shadow: var(--tm-shadow-pop);
      z-index: 1100;
      animation: state-select-in 140ms var(--tm-ease) both;
    }
    @keyframes state-select-in {
      from { opacity: 0; transform: translateY(-4px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .state-select__option {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-radius: var(--tm-radius-sm);
      font-size: 12px;
      font-weight: 600;
      color: var(--tm-text);
      cursor: pointer;
      transition: background var(--tm-duration-fast) var(--tm-ease),
                  color var(--tm-duration-fast) var(--tm-ease);
    }
    .state-select__option:hover {
      background: var(--tm-canvas-2);
    }
    .state-select__option.is-selected {
      background: var(--tm-green-tint);
      color: var(--tm-green-deep);
      font-weight: 700;
    }
    .state-select__option-check {
      color: var(--tm-green-deep);
      flex-shrink: 0;
    }
    .state-select__option-label { flex: 1; }

    /* ---------- Date range picker ---------- */
    .date-range {
      display: inline-flex;
      height: var(--driver-filter-height);
      align-items: center;
      gap: 8px;
      padding: 8px 8px 8px 14px;
      border: 1px solid var(--tm-line-2);
      border-radius: var(--tm-radius-md);
      background: transparent;
      line-height: 1;
      transition: border-color var(--tm-duration-fast) var(--tm-ease),
                  background var(--tm-duration-fast) var(--tm-ease);
      cursor: pointer;
    }
    .date-range:focus-within { border-color: var(--tm-ink); }
    .date-range.has-value {
      background: var(--tm-green-tint);
      border-color: var(--tm-green-deep);
    }
    .date-range__icon { color: var(--tm-text-muted); display: inline-flex; }
    .date-range.has-value .date-range__icon { color: var(--tm-green-deep); }
    .date-range__input {
      appearance: none;
      -webkit-appearance: none;
      background: transparent;
      border: 0;
      outline: 0;
      font-family: var(--tm-font-mono);
      font-size: 12px;
      font-weight: 600;
      color: var(--tm-text);
      padding: 0;
      flex: 1;
      min-width: 0;
      cursor: pointer;
      line-height: 1.2;
    }
    .date-range__input::placeholder { color: var(--tm-text-soft); }
    .date-range__clear {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: var(--tm-canvas-2);
      color: var(--tm-text-muted);
      transition: background var(--tm-duration-fast) var(--tm-ease),
                  color var(--tm-duration-fast) var(--tm-ease);
    }
    .date-range__clear:hover {
      background: var(--tm-ink);
      color: #fff;
    }

    /* Brand-tone the daterangepicker dropdown — mounts on body */
    :host ::ng-deep .daterangepicker {
      font-family: var(--tm-font-body) !important;
      border-radius: var(--tm-radius-md);
      border: 1px solid var(--tm-line-2);
      box-shadow: var(--tm-shadow-pop);
    }
    :host ::ng-deep .daterangepicker .btn-primary,
    :host ::ng-deep .daterangepicker .btn-success {
      background: var(--tm-ink);
      border-color: var(--tm-ink);
      border-radius: var(--tm-radius-sm);
      font-weight: 700;
    }
    :host ::ng-deep .daterangepicker .ranges li.active,
    :host ::ng-deep .daterangepicker td.active,
    :host ::ng-deep .daterangepicker td.active:hover {
      background: var(--tm-ink);
      color: #fff;
    }
    :host ::ng-deep .daterangepicker td.in-range {
      background: var(--tm-green-tint);
      color: var(--tm-green-deep);
    }

    /* ---------- Active filter pills (below toolbar) ---------- */
    .filter-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-right: 8px;
      padding: 6px 6px 6px 12px;
      border-radius: var(--tm-radius-pill);
      background: var(--tm-surface);
      border: 1px solid var(--tm-line-2);
      font-size: 12px;
      font-weight: 700;
      color: var(--tm-text);
    }
    .filter-pill__icon { display: inline-flex; color: var(--tm-text-muted); }
    .filter-pill__label {
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--tm-text-muted);
    }
    .filter-pill__value {
      font-family: var(--tm-font-mono);
      font-weight: 700;
      color: var(--tm-text);
    }
    .filter-pill__close {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: var(--tm-canvas-2);
      color: var(--tm-text-muted);
      transition: background var(--tm-duration-fast) var(--tm-ease),
                  color var(--tm-duration-fast) var(--tm-ease);
    }
    .filter-pill__close:hover {
      background: var(--tm-ink);
      color: #fff;
    }

    /* ---------- Cell renderers ---------- */
    .cell-id {
      display: inline-flex;
      align-items: center;
      padding: 3px 10px;
      border-radius: var(--tm-radius-pill);
      background: var(--tm-green-tint);
      color: var(--tm-green-deep);
      border: 1px solid transparent;
      font-family: var(--tm-font-mono);
      font-size: 11px;
      font-weight: 800;
    }
    .cell-id--static { cursor: default; }

    .cell-user {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }
    .cell-avatar {
      width: 32px; height: 32px;
      border-radius: 50%;
      display: grid; place-items: center;
      background: linear-gradient(135deg, var(--tm-ink), var(--tm-ink-3));
      color: #fff;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.02em;
      flex-shrink: 0;
    }
    /* Photo variant — let the inline background-image render and cover the
       circle. background-color is reset so the dark gradient doesn't bleed
       through on transparent PNGs. */
    .cell-avatar--photo {
      background-color: var(--tm-canvas-2);
      background-size: cover;
      background-position: center;
      background-repeat: no-repeat;
    }
    .cell-user__meta { display: flex; flex-direction: column; min-width: 0; }
    .cell-user__name {
      font-weight: 700;
      font-size: 13px;
      color: var(--tm-text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .cell-user__sub {
      font-size: 11px;
      font-weight: 600;
      color: var(--tm-text-muted);
    }

    .cell-contact {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .cell-contact__email {
      font-size: 13px;
      font-weight: 600;
      color: var(--tm-text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .cell-contact__email.muted { color: var(--tm-text-soft); }
    .cell-contact__phone {
      font-size: 12px;
      color: var(--tm-text-muted);
    }

    /* ----- Status column ----- */
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 9px;
      border-radius: var(--tm-radius-pill);
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      line-height: 1.4;
      white-space: nowrap;
      border: 1px solid transparent;
      transition: transform var(--tm-duration-fast) var(--tm-ease);
    }
    .status-pill .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: currentColor;
      box-shadow: 0 0 0 2px color-mix(in srgb, currentColor 18%, transparent);
      flex-shrink: 0;
    }
    .status-pill.is-online {
      background: var(--tm-green-tint);
      color: var(--tm-green-deep);
      border-color: var(--tm-green-soft);
    }
    .status-pill.is-online .status-dot {
      animation: status-pulse 1.6s var(--tm-ease) infinite;
    }
    @keyframes status-pulse {
      0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, currentColor 35%, transparent); }
      50%      { box-shadow: 0 0 0 4px color-mix(in srgb, currentColor 0%, transparent); }
    }
    .status-pill.is-offline     { background: var(--tm-surface);     color: var(--tm-text-muted); border-color: var(--tm-line-2); }
    .status-pill.is-offline .status-dot { background: var(--tm-text-soft); box-shadow: none; }
    .status-pill.is-deactivated { background: #fee2e2;               color: #b91c1c;              border-color: #fecaca; }
    .status-pill.is-rejected {
      background: #fef2f2;
      border-color: #fecaca;
      color: #dc2626;
    }
    .status-pill.is-pending {
      background: #fffbeb;
      border-color: #fde68a;
      color: #b45309;
    }

    .rides-chip {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 32px;
      padding: 3px 8px;
      border-radius: var(--tm-radius-pill);
      background: var(--tm-green-tint);
      color: var(--tm-green-deep);
      font-family: var(--tm-font-mono);
      font-size: 12px;
      font-weight: 800;
    }
    .rides-chip.is-zero {
      background: var(--tm-canvas-2);
      color: var(--tm-text-soft);
    }

    .mono { font-family: var(--tm-font-mono); font-weight: 600; font-size: 12px; }
    .muted { color: var(--tm-text-soft); }

    /* ---------- Row actions ---------- */
    .row-icon-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      padding: 0;
      border: 1px solid var(--tm-line-2);
      border-radius: var(--tm-radius-sm);
      background: var(--tm-surface);
      color: var(--tm-text);
      cursor: pointer;
      transition: background var(--tm-duration-fast) var(--tm-ease),
                  color var(--tm-duration-fast) var(--tm-ease);
    }
    .row-icon-btn:hover:not(:disabled) { background: var(--tm-ink); color: #fff; border-color: var(--tm-ink); }
    .row-icon-btn.is-open { background: var(--tm-green); color: #fff; border-color: var(--tm-green); }
    .row-icon-btn.is-deactivate { color: var(--tm-danger); }
    .row-icon-btn.is-deactivate:hover:not(:disabled) { background: var(--tm-danger); color: #fff; border-color: var(--tm-danger); }
    .row-icon-btn.is-reactivate { color: var(--tm-green-deep); }
    .row-icon-btn.is-reactivate:hover:not(:disabled) { background: var(--tm-green-deep); color: #fff; border-color: var(--tm-green-deep); }
    .row-icon-btn:disabled { opacity: .55; cursor: not-allowed; }

    /* ---------- Detail popover ---------- */
    .id-pop { position: relative; display: inline-block; }
    .id-pop__panel {
      position: fixed;
      z-index: 1200;
      width: 280px;
      background: var(--tm-surface);
      border: 1px solid var(--tm-line-2);
      border-radius: var(--tm-radius-md);
      box-shadow: var(--tm-shadow-pop);
      padding: var(--tm-space-3);
      animation: id-pop-in 160ms var(--tm-ease) both;
    }
    @keyframes id-pop-in {
      from { opacity: 0; transform: translateY(-6px) scale(0.97); }
      to   { opacity: 1; transform: translateY(0)    scale(1); }
    }
    .id-pop__head {
      display: flex;
      align-items: center;
      gap: 10px;
      padding-bottom: var(--tm-space-3);
      border-bottom: 1px solid var(--tm-line);
      margin-bottom: var(--tm-space-3);
    }
    .id-pop__title { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .id-pop__name {
      font-size: 14px;
      font-weight: 800;
      color: var(--tm-text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .id-pop__id { font-size: 11px; font-weight: 700; color: var(--tm-text-muted); }
    .id-pop__close {
      width: 24px; height: 24px;
      border-radius: 50%;
      background: var(--tm-canvas-2);
      color: var(--tm-text-muted);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: background var(--tm-duration-fast) var(--tm-ease),
                  color var(--tm-duration-fast) var(--tm-ease);
    }
    .id-pop__close:hover { background: var(--tm-ink); color: #fff; }
    .id-pop__rows { display: flex; flex-direction: column; gap: 8px; }
    .id-pop__row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      font-size: 12px;
      color: var(--tm-text);
    }
    .id-pop__row .lbl {
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--tm-text-muted);
      margin: 0;
    }
    .id-pop__foot {
      margin-top: var(--tm-space-3);
      padding-top: var(--tm-space-3);
      border-top: 1px solid var(--tm-line);
    }
    .id-pop__link {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--tm-green-deep);
    }
    .id-pop__link:hover { color: var(--tm-green); }

    /* ---------- Driver filter grid ---------- */
    :host ::ng-deep .drivers-table .tm-dt__toolbar {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
      align-items: stretch;
    }
    :host ::ng-deep .drivers-table .tm-dt__toolbar-left,
    :host ::ng-deep .drivers-table .tm-dt__toolbar-right {
      display: contents;
    }
    :host ::ng-deep .drivers-table .tm-dt__toolbar tm-input,
    :host ::ng-deep .drivers-table .tm-dt__toolbar tm-filter-select {
      min-width: 0;
    }
    :host ::ng-deep .drivers-table .tm-dt__toolbar .fs,
    :host ::ng-deep .drivers-table .tm-dt__toolbar .fs__trigger {
      width: 100%;
    }
    :host ::ng-deep .drivers-table .tm-dt__toolbar .fs__trigger {
      height: var(--driver-filter-height);
    }
    :host ::ng-deep .drivers-table .tm-dt__toolbar .fs__value {
      flex: 1;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    :host ::ng-deep .drivers-table .tm-dt__toolbar tm-input .field {
      height: var(--driver-filter-height);
      background: transparent;
      border-color: var(--tm-line-2);
      padding: 9px 14px;
      gap: 8px;
    }
    :host ::ng-deep tm-data-table .tm-dt__toolbar tm-input .field:focus-within {
      border-color: var(--tm-ink);
      background: var(--tm-surface);
    }
    :host ::ng-deep tm-data-table .tm-dt__toolbar tm-input input {
      font-size: 13px;
      line-height: 1.2;
    }
    @container driver-table (max-width: 700px) {
      :host ::ng-deep .drivers-table .tm-dt__toolbar { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @container driver-table (max-width: 360px) {
      :host ::ng-deep .drivers-table .tm-dt__toolbar { grid-template-columns: minmax(0, 1fr); }
    }

    /* ---------- Deactivation modal ---------- */
    .deact {
      display: flex;
      flex-direction: column;
      gap: var(--tm-space-3);
    }
    .deact__alert {
      display: flex;
      gap: 10px;
      padding: 12px;
      background: #fef2f2;
      border: 1px solid #fecaca;
      border-radius: var(--tm-radius-sm);
      color: #991b1b;
    }
    .deact__alert-icon {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: #fecaca;
      color: #991b1b;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .deact__alert-body {
      display: flex;
      flex-direction: column;
      gap: 2px;
      font-size: 13px;
      line-height: 1.4;
    }
    .deact__alert-sub {
      color: #b91c1c;
      font-weight: 500;
    }
    .deact__who {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      background: var(--tm-canvas);
      border: 1px solid var(--tm-line);
      border-radius: var(--tm-radius-sm);
    }
    .deact__who-meta { display: flex; flex-direction: column; min-width: 0; }
    .deact__who-name {
      font-size: 14px;
      font-weight: 700;
      color: var(--tm-text);
    }
    .deact__who-sub {
      font-size: 11px;
      color: var(--tm-text-muted);
    }
    .deact__lbl {
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--tm-text-muted);
    }
    .deact__lbl-opt {
      letter-spacing: 0.02em;
      text-transform: none;
      font-weight: 500;
      color: var(--tm-text-soft);
    }
    .deact__reason {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid var(--tm-line-2);
      border-radius: var(--tm-radius-sm);
      background: var(--tm-surface);
      font-family: var(--tm-font-body);
      font-size: 13px;
      color: var(--tm-text);
      resize: vertical;
      min-height: 80px;
      transition: border-color var(--tm-duration-fast) var(--tm-ease);
    }
    .deact__reason:focus {
      outline: none;
      border-color: var(--tm-ink);
    }
    .deact__reason:disabled {
      background: var(--tm-canvas-2);
      color: var(--tm-text-soft);
      cursor: not-allowed;
    }

    /* ---------- Insights drawer ---------- */
    .drawer {
      position: fixed;
      inset: 0;
      z-index: 1100;
      background: rgba(15, 20, 25, 0.42);
      backdrop-filter: blur(2px);
      display: flex;
      justify-content: flex-end;
      animation: drawer-fade-in 180ms var(--tm-ease) both;
    }
    .drawer.is-closing { animation: drawer-fade-out 180ms var(--tm-ease) both; }
    @keyframes drawer-fade-in {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
    @keyframes drawer-fade-out {
      from { opacity: 1; }
      to   { opacity: 0; }
    }

    .drawer__panel {
      width: min(880px, 96vw);
      max-width: 96vw;
      height: 100%;
      background: var(--tm-canvas);
      border-left: 1px solid var(--tm-line);
      box-shadow: -20px 0 50px rgba(15,20,25,0.18);
      display: flex;
      flex-direction: column;
      animation: drawer-slide-in 220ms var(--tm-ease) both;
    }
    .drawer__panel.is-closing { animation: drawer-slide-out 200ms var(--tm-ease) both; }
    @keyframes drawer-slide-in {
      from { transform: translateX(40px); opacity: 0; }
      to   { transform: translateX(0);    opacity: 1; }
    }
    @keyframes drawer-slide-out {
      from { transform: translateX(0);    opacity: 1; }
      to   { transform: translateX(40px); opacity: 0; }
    }

    .drawer__head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--tm-space-3);
      padding: var(--tm-space-4) var(--tm-space-5);
      background: var(--tm-surface);
      border-bottom: 1px solid var(--tm-line);
    }
    .drawer__head-left { min-width: 0; flex: 1; }
    .drawer__title {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin: 0 0 4px;
      font-size: 18px;
      font-weight: 800;
      letter-spacing: -0.01em;
      color: var(--tm-text);
    }
    .drawer__title tm-icon { color: var(--tm-green-deep); }
    .drawer__sub {
      margin: 0;
      font-size: 13px;
      font-weight: 500;
      color: var(--tm-text-muted);
      line-height: 1.4;
    }
    .drawer__close {
      width: 32px; height: 32px;
      border-radius: 50%;
      background: var(--tm-canvas-2);
      color: var(--tm-text-muted);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: background var(--tm-duration-fast) var(--tm-ease),
                  color var(--tm-duration-fast) var(--tm-ease);
    }
    .drawer__close:hover { background: var(--tm-ink); color: #fff; }

    .drawer__tabs-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--tm-space-3);
      padding: var(--tm-space-3) var(--tm-space-5) 0;
      background: var(--tm-surface);
      border-bottom: 1px solid var(--tm-line);
      flex-wrap: wrap;
    }
    .drawer__tabs {
      display: flex;
      gap: 4px;
    }
    .drawer__tab {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 10px 14px;
      border: 0;
      background: transparent;
      color: var(--tm-text-muted);
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
      transition: color var(--tm-duration-fast) var(--tm-ease),
                  border-color var(--tm-duration-fast) var(--tm-ease);
    }
    .drawer__tab:hover:not(.is-active) { color: var(--tm-text); }
    .drawer__tab.is-active {
      color: var(--tm-green-deep);
      border-bottom-color: var(--tm-green-deep);
    }

    .drawer__body {
      flex: 1;
      overflow: auto;
      padding: var(--tm-space-5);
    }

    /* Mobile: drawer becomes a full-height sheet */
    @media (max-width: 640px) {
      .drawer { background: rgba(15,20,25,0.55); }
      .drawer__panel { width: 100vw; }
      .drawer__head,
      .drawer__tabs-row { padding-left: var(--tm-space-4); padding-right: var(--tm-space-4); }
      .drawer__body { padding: var(--tm-space-4); }
      .drawer__title { font-size: 16px; }
      .drawer__sub { display: none; }
      .drawer__tab span { font-size: 12px; }
    }

    /* ---------- Responsive ---------- */
    @media (max-width: 880px) {
      .page__hero { flex-direction: column; align-items: stretch; }
      .page__hero-right { justify-content: flex-start; }
      .state-select__field { min-width: 110px; }
    }
  `],
})
export class DriversListComponent implements OnInit, AfterViewInit, OnDestroy {
  readonly routeCountLabels = { '=1': '1 route', other: '# routes' };
  readonly standCountLabels = { '=1': '1 stand', other: '# stands' };
  @ViewChild('rangeInput', { static: false }) rangeInput!: ElementRef<HTMLInputElement>;

  rows: DriverRow[] = [];
  total = 0;
  loading = false;
  exporting = false;

  search = '';
  state: StateFilter = 'all';
  stateOpen = false;
  readonly stateOptions: { value: StateFilter; label: string }[] = [
    { value: 'all', label: 'All drivers' },
    { value: 'active', label: 'Active' },
    { value: 'deactivated', label: 'Deactivated' },
  ];

  online: OnlineFilter = 'all';
  onlineOpen = false;
  readonly onlineOptions: { value: OnlineFilter; label: string }[] = [
    { value: 'all', label: 'Any activity' },
    { value: 'online', label: 'Online' },
    { value: 'offline', label: 'Offline' },
  ];

  approval: ApprovalFilter = 'all';
  approvalOpen = false;
  readonly approvalViews: { value: ApprovalFilter; label: string }[] = [
    { value: 'all', label: 'All drivers' },
    { value: 'approved', label: 'Approved' },
    { value: 'not_approved', label: 'Not approved' },
  ];
  readonly approvalOptions: { value: ApprovalFilter; label: string }[] = [
    { value: 'all', label: 'Any approval' },
    { value: 'approved', label: 'Approved' },
    { value: 'not_approved', label: 'Not approved' },
    { value: 'pending', label: 'Pending' },
    { value: 'rejected', label: 'Disapproved' },
  ];

  page = 1;
  pageSize = 25;

  /** Date range filters — applied to drivers.created_at server-side. */
  dateFrom = '';
  dateTo = '';

  openPopoverId: number | null = null;
  popoverTop = 0;
  popoverLeft = 0;

  busyId: number | null = null;

  /** Deactivation confirmation modal. */
  deactivateOpen = false;
  deactivateTarget: DriverRow | null = null;
  deactivateReason = '';

  /** Insights drawer (Leaderboard / Performance). */
  insightsOpen = false;
  insightsMounted = false;
  insightsClosing = false;
  insightsMode: InsightMode = 'leaderboard';

  /** Table vs graph view for the drivers page. */
  view: DriversView = 'table';

  private searchDebounce: any = null;
  private insightsCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private releaseInsightsScrollLock?: () => void;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshInFlight = false;
  allocationCityId: number | null = null;
  catalogCities: CityOption[] = [];
  cityCounts: DriverLocationCount[] | null = null;
  standCounts: DriverStandCount[] = [];
  standCountsLoading = false;
  standCountsFailed = false;
  selectedStandId: number | null = null;
  allocationFiltersSupported = false;
  private allocationReads = new Subscription();
  private allocationGroupLoading = new Set<number>();
  private allocationGroupCache = new Map<number, NonNullable<DriverRow['route_groups']>>();
  cityScope: 'all' | 'selected' = 'all';
  allocationVehicleId: number | null = null;
  allocationVehicles: AllocationVehicle[] = [];
  allocationDriver: DriverRow | null = null;
  private allocationCitySub?: Subscription;
  private vehicleOptionsRequest?: Subscription;
  private standCountsRequest?: Subscription;
  private listRequest?: Subscription;

  get cityFilterValue(): string {
    return this.cityScope === 'selected' && this.allocationCityId ? String(this.allocationCityId) : 'all';
  }

  get cityOptions() {
    return this.cityCounts
      ? this.cityCounts.map(city => ({ value: String(city.id), label: `${city.name} (${city.driver_count.toLocaleString()})` }))
      : this.catalogCities.map(city => ({ value: String(city.id), label: city.name }));
  }

  get standOptions() {
    return this.standCounts.map(stand => ({
      value: String(stand.id),
      label: stand.name
        + (stand.driver_user_ids === undefined ? ` (${stand.driver_count.toLocaleString()})` : '')
        + (stand.is_active ? '' : ' · Disabled'),
    }));
  }

  get standFilterLabel(): string {
    if (this.cityScope === 'all') return 'Stands · choose a city';
    if (this.standCountsLoading) return 'Loading stands…';
    if (this.standCountsFailed) return 'Stands unavailable';
    return this.standCounts.length ? 'All stands' : 'No stands in this city';
  }

  get legacyStand(): DriverStandCount | undefined {
    return this.standCounts.find(stand => stand.id === this.selectedStandId && stand.driver_user_ids !== undefined);
  }

  get vehicleOptions() {
    return this.allocationVehicles.map(vehicle => ({ value: String(vehicle.id), label: vehicle.display_name }));
  }
  private loadLegacyGroupSummary(row: DriverRow): void {
    const cached = this.allocationGroupCache.get(row.id);
    if (cached) { row.route_groups = cached; return; }
    if (this.allocationGroupLoading.has(row.id)) return;
    this.allocationGroupLoading.add(row.id);
    this.allocationReads.add(this.api.get<{ assigned_group_ids: number[]; groups: NonNullable<DriverRow['route_groups']> }>(`/admin/drivers/${row.id}/route-groups`).subscribe({
      next: res => { const ids = new Set(res.assigned_group_ids || []); const groups = (res.groups || []).filter(group => ids.has(group.id)); this.allocationGroupCache.set(row.id, groups); this.allocationGroupLoading.delete(row.id); this.rows.filter(current => current.id === row.id).forEach(current => current.route_groups = groups); },
      error: () => { this.allocationGroupLoading.delete(row.id); },
    }));
  }
  selectDriverCity(cityId: number | null): void {
    this.cityScope = cityId === null ? 'all' : 'selected';
    this.setAllocationCity(cityId ?? this.cityCtx.currentCityId);
    this.page = 1;
    this.reload();
  }

  selectDriverStand(standId: number | null): void {
    this.selectedStandId = standId;
    this.page = 1;
    this.reload();
  }

  loadStandCounts(): void {
    this.standCountsRequest?.unsubscribe();
    this.standCountsLoading = false;
    this.standCountsFailed = false;
    if (this.cityScope === 'all' || !this.allocationCityId) return;

    const cityPath = `/admin/cities/${this.allocationCityId}`;
    this.standCountsLoading = true;
    this.standCountsRequest = this.api.get<{ data: DriverStandCount[] }>(
      `${cityPath}/driver-stand-counts`,
    ).pipe(
      catchError(error => {
        if (error.status !== 404 && error.status !== 405) return throwError(() => error);
        return this.api.get<{ data: DriverStandCount[] }>(`${cityPath}/route-groups`);
      }),
    ).subscribe({
      next: ({ data }) => {
        this.standCounts = data;
        this.standCountsLoading = false;
      },
      error: () => {
        this.standCountsLoading = false;
        this.standCountsFailed = true;
      },
    });
  }

  private setAllocationCity(cityId: number | null): void {
    this.allocationCityId = cityId;
    this.allocationVehicleId = null;
    this.allocationVehicles = [];
    this.selectedStandId = null;
    this.standCounts = [];
    this.allocationDriver = null;
    this.loadStandCounts();

    this.vehicleOptionsRequest?.unsubscribe();
    if (!cityId) return;
    this.vehicleOptionsRequest = this.api.get<{ data: AllocationVehicle[] }>(
      `/admin/cities/${cityId}/vehicle-types`,
    ).subscribe({
      next: ({ data }) => {
        const names = new Set<string>();
        this.allocationVehicles = (data || []).filter((vehicle) => {
          if (names.has(vehicle.display_name)) return false;
          names.add(vehicle.display_name);
          return true;
        });
      },
      error: () => { this.allocationVehicles = []; },
    });
  }

  selectDriverVehicle(value: string): void {
    this.allocationVehicleId = value === 'all' ? null : Number(value);
    if (this.allocationVehicleId && this.cityScope === 'all') {
      this.cityScope = 'selected';
      this.loadStandCounts();
    }
    this.page = 1;
    this.reload();
  }
  private allocationParams(params: URLSearchParams): void {
    if (this.cityScope === 'selected' && this.allocationCityId) {
      params.set('city_id', String(this.allocationCityId));
      if (this.selectedStandId && !this.legacyStand) params.set('stand_id', String(this.selectedStandId));
    }
    if (this.allocationVehicleId) params.set('city_vehicle_type_id', String(this.allocationVehicleId));
  }

  constructor(
    private api: ApiService,
    private toast: ToastService,
    private zone: NgZone,
    private router: Router,
    private route: ActivatedRoute,
    private cityCtx: CityContextService,
  ) {}

  ngOnInit(): void {
    this.reload();
    this.startLiveRefresh();
    this.allocationReads.add(this.api.get<{ data: DriverLocationCount[] }>('/admin/drivers/city-counts').subscribe({
      next: ({ data }) => {
        this.cityCounts = data;
        this.loadStandCounts();
      },
      error: () => { this.cityCounts = null; },
    }));
    this.allocationReads.add(this.cityCtx.cities$.subscribe(cities => { this.catalogCities = cities; }));
    this.allocationReads.add(this.cityCtx.ensureCitiesLoaded().subscribe());
    this.allocationCitySub = this.cityCtx.cityId$.subscribe(cityId => {
      if (this.cityScope === 'all') this.setAllocationCity(cityId);
    });
    // Deep-link support: /drivers?insights=leaderboard|performance opens the
    // drawer pre-selected (used by the sidebar nav and redirected legacy URLs).
    this.route.queryParamMap.subscribe((q) => {
      const v = q.get('insights');
      if (v === 'leaderboard' || v === 'performance') {
        this.openInsights(v);
      }
    });
  }

  ngAfterViewInit(): void {
    this.initDateRangePicker();
  }

  ngOnDestroy(): void {
    this.allocationReads.unsubscribe();
    this.allocationCitySub?.unsubscribe();
    this.vehicleOptionsRequest?.unsubscribe();
    this.standCountsRequest?.unsubscribe();
    this.listRequest?.unsubscribe();
    this.destroyDateRangePicker();
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.insightsCloseTimer) clearTimeout(this.insightsCloseTimer);
    this.releaseInsightsScrollLock?.();
    this.releaseInsightsScrollLock = undefined;
  }

  get rangeLabel(): string {
    if (!this.dateFrom && !this.dateTo) return '';
    return `${this.formatDate(this.dateFrom)} → ${this.formatDate(this.dateTo)}`;
  }

  private initDateRangePicker(): void {
    if (!this.rangeInput?.nativeElement) return;
    const $el = $(this.rangeInput.nativeElement);
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
          this.dateFrom = start.format('YYYY-MM-DD');
          this.dateTo = end.format('YYYY-MM-DD');
          this.onDateRangeChange();
        });
      },
    );
    $el.on('cancel.daterangepicker', () => {
      this.zone.run(() => this.clearDateRange());
    });
  }

  private destroyDateRangePicker(): void {
    if (!this.rangeInput?.nativeElement) return;
    const picker = ($(this.rangeInput.nativeElement) as any).data('daterangepicker');
    if (picker) picker.remove();
  }

  private startLiveRefresh(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => {
      if (this.refreshInFlight || this.busyId !== null || this.deactivateOpen) return;
      this.reload(true);
    }, 5000);
  }

  reload(silent = false): void {
    const params = new URLSearchParams({
      page: String(this.page),
      per_page: String(this.pageSize),
      state: this.state,
    });
    if (this.search.trim()) params.set('q', this.search.trim());
    if (this.dateFrom) params.set('date_from', this.dateFrom);
    if (this.dateTo) params.set('date_to', this.dateTo);
    if (this.online !== 'all') params.set('is_online', this.online === 'online' ? '1' : '0');
    if (this.approval !== 'all') params.set('approval_status', this.approval);

    if (silent && this.refreshInFlight) return;
    this.listRequest?.unsubscribe();
    this.allocationParams(params);
    this.refreshInFlight = true;
    if (!silent) this.loading = true;
    const stand = this.legacyStand;
    const result = stand
      ? this.loadLegacyStandDrivers(params, stand.driver_user_ids ?? [])
      : this.api.get<DriverListResponse>(`/admin/drivers?${params}`);
    this.listRequest = result.subscribe({
      next: (res) => {
        this.rows = res?.data?.data ?? [];
        this.allocationFiltersSupported = !!res.allocation_filters_supported;
        if (!this.allocationFiltersSupported) this.rows.filter(row => !row.route_groups).forEach(row => this.loadLegacyGroupSummary(row));
        this.total = res?.data?.total ?? 0;
        this.loading = false;
        this.refreshInFlight = false;
      },
      error: (err) => {
        if (!silent) {
          this.toast.error(
            err?.error?.message || 'Could not load drivers',
            { title: 'Load failed' },
          );
        }
        this.loading = false;
        this.refreshInFlight = false;
      },
    });
  }

  private loadLegacyStandDrivers(params: URLSearchParams, userIds: number[]): Observable<DriverListResponse> {
    const members = new Set(userIds);
    const offset = (this.page - 1) * this.pageSize;
    const pageSize = this.pageSize;
    const batchSize = 100;
    const loadPage = (page: number) => {
      params.set('page', String(page));
      params.set('per_page', String(batchSize));
      return this.api.get<DriverListResponse>(`/admin/drivers?${params}`).pipe(
        map(response => ({ response, page })),
      );
    };

    return loadPage(1).pipe(
      expand(({ response, page }) => page < (response.data.last_page ?? Math.ceil(response.data.total / batchSize))
        ? loadPage(page + 1) : EMPTY),
      reduce((rows, { response }) => rows.concat(response.data.data.filter(row => row.user && members.has(row.user.id))), [] as DriverRow[]),
      map(rows => ({ data: { data: rows.slice(offset, offset + pageSize), total: rows.length }, allocation_filters_supported: true })),
    );
  }

  onSearchChange(): void {
    if (this.searchDebounce) clearTimeout(this.searchDebounce);
    this.searchDebounce = setTimeout(() => {
      this.page = 1;
      this.reload();
    }, 300);
  }

  onStateChange(): void {
    this.page = 1;
    this.reload();
  }

  clearState(): void {
    this.state = 'all';
    this.onStateChange();
  }

  stateLabel(): string {
    return this.stateOptions.find((o) => o.value === this.state)?.label ?? 'All drivers';
  }

  toggleStateMenu(event: MouseEvent): void {
    event.stopPropagation();
    this.onlineOpen = false;
    this.approvalOpen = false;
    this.stateOpen = !this.stateOpen;
  }

  selectState(value: StateFilter): void {
    this.stateOpen = false;
    if (this.state === value) return;
    this.state = value;
    this.onStateChange();
  }

  // ---- Activity (online/offline) filter ----
  onlineLabel(): string {
    return this.onlineOptions.find((o) => o.value === this.online)?.label ?? 'Any activity';
  }
  toggleOnlineMenu(event: MouseEvent): void {
    event.stopPropagation();
    this.stateOpen = false;
    this.approvalOpen = false;
    this.onlineOpen = !this.onlineOpen;
  }
  selectOnline(value: OnlineFilter): void {
    this.onlineOpen = false;
    if (this.online === value) return;
    this.online = value;
    this.page = 1;
    this.reload();
  }
  clearOnline(): void {
    if (this.online === 'all') return;
    this.online = 'all';
    this.page = 1;
    this.reload();
  }

  // ---- Approval filter ----
  approvalLabel(): string {
    return this.approvalOptions.find((o) => o.value === this.approval)?.label ?? 'Any approval';
  }
  toggleApprovalMenu(event: MouseEvent): void {
    event.stopPropagation();
    this.stateOpen = false;
    this.onlineOpen = false;
    this.approvalOpen = !this.approvalOpen;
  }
  selectApproval(value: ApprovalFilter): void {
    this.approvalOpen = false;
    if (this.approval === value) return;
    this.approval = value;
    this.page = 1;
    this.reload();
  }
  clearApproval(): void {
    if (this.approval === 'all') return;
    this.approval = 'all';
    this.page = 1;
    this.reload();
  }

  onPageChange(page: number): void {
    this.page = page;
    this.reload();
  }

  onPageSizeChange(size: number): void {
    this.pageSize = size;
    this.page = 1;
    this.reload();
  }

  onDateRangeChange(): void {
    this.page = 1;
    this.reload();
  }

  clearDateRange(): void {
    this.dateFrom = '';
    this.dateTo = '';
    this.onDateRangeChange();
  }

  formatDate(iso: string): string {
    if (!iso) return 'any';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return 'any';
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = String(d.getFullYear()).slice(-2);
    return `${dd}-${mm}-${yy}`;
  }

  togglePopover(row: DriverRow, event: MouseEvent): void {
    event.stopPropagation();
    if (this.openPopoverId === row.id) {
      this.openPopoverId = null;
      return;
    }
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const panelW = 280;
    const panelH = 320;
    let left = rect.left;
    if (left + panelW > window.innerWidth - 12) left = window.innerWidth - panelW - 12;
    let top = rect.bottom + 8;
    if (top + panelH > window.innerHeight - 12) top = rect.top - panelH - 8;
    this.popoverLeft = Math.max(12, left);
    this.popoverTop = Math.max(12, top);
    this.openPopoverId = row.id;
  }

  closePopover(): void {
    this.openPopoverId = null;
  }

  openProfile(id: number, event: MouseEvent): void {
    event.stopPropagation();
    this.openPopoverId = null;
    // All Drivers opens the full detail page. The Approvals tab still uses the
    // slide-in drawer (?driverId=) for document review and approval.
    this.router.navigate(['/drivers', id]);
  }

  @HostListener('document:click')
  onDocumentClick(): void {
    if (this.openPopoverId !== null) this.openPopoverId = null;
    if (this.stateOpen) this.stateOpen = false;
    if (this.onlineOpen) this.onlineOpen = false;
    if (this.approvalOpen) this.approvalOpen = false;
  }

  @HostListener('document:keydown.escape')
  onDocumentEscape(): void {
    if (this.insightsOpen) { this.closeInsights(); return; }
    if (this.openPopoverId !== null) this.openPopoverId = null;
    if (this.stateOpen) this.stateOpen = false;
    if (this.onlineOpen) this.onlineOpen = false;
    if (this.approvalOpen) this.approvalOpen = false;
  }

  initials(name: string | null | undefined): string {
    if (!name) return '—';
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '—';
    const a = parts[0][0] || '';
    const b = parts.length > 1 ? parts[parts.length - 1][0] : '';
    return (a + b).toUpperCase();
  }

  deactivate(row: DriverRow): void {
    this.deactivateTarget = row;
    this.deactivateReason = '';
    this.deactivateOpen = true;
  }

  closeDeactivateModal(): void {
    if (this.busyId !== null) return;
    this.deactivateOpen = false;
    this.deactivateTarget = null;
    this.deactivateReason = '';
  }

  confirmDeactivate(): void {
    if (!this.deactivateTarget) return;
    const reason = this.deactivateReason.trim();
    const row = this.deactivateTarget;
    this.toggleActivation(row, false, reason || null);
  }

  reactivate(row: DriverRow): void {
    this.toggleActivation(row, true, null);
  }

  private toggleActivation(row: DriverRow, active: boolean, reason: string | null): void {
    this.busyId = row.id;
    this.api
      .patch<{ driver: { id: number } }>(`/admin/drivers/${row.id}/activation`, {
        active,
        reason,
      })
      .subscribe({
        next: () => {
          this.toast.success(
            active ? `Driver #${row.id} reactivated` : `Driver #${row.id} deactivated`,
          );
          this.busyId = null;
          if (!active) {
            this.deactivateOpen = false;
            this.deactivateTarget = null;
            this.deactivateReason = '';
          }
          this.reload();
        },
        error: (err) => {
          this.toast.error(err?.error?.message || 'Action failed', { title: 'Driver update' });
          this.busyId = null;
        },
      });
  }

  // -------------------- Table / Graph view toggle --------------------
  setView(next: DriversView): void {
    if (this.view === next) return;
    this.view = next;
    // Graph view embeds the leaderboard + performance charts inline, so the
    // drawer is redundant — close it to avoid a stacked UI.
    if (next === 'graph' && this.insightsOpen) this.closeInsights();
  }

  /** Approval status doughnut: approved / pending / rejected. */
  get approvalChart() {
    const counts = { approved: 0, pending: 0, rejected: 0 };
    for (const r of this.rows) counts[r.approval_status as keyof typeof counts]++;
    return {
      data: {
        labels: ['Approved', 'Pending', 'Rejected'],
        datasets: [{
          data: [counts.approved, counts.pending, counts.rejected],
          backgroundColor: ['#16A34A', '#F59E0B', '#DC2626'],
          borderWidth: 0,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: { position: 'bottom' as const, labels: { font: { size: 11 }, boxWidth: 10 } },
        },
      },
    };
  }

  /** Online vs offline doughnut. */
  get activityChart() {
    const online = this.rows.filter((r) => r.is_online).length;
    const offline = this.rows.length - online;
    return {
      data: {
        labels: ['Online', 'Offline'],
        datasets: [{
          data: [online, offline],
          backgroundColor: ['#22C55E', '#94A0AD'],
          borderWidth: 0,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: { position: 'bottom' as const, labels: { font: { size: 11 }, boxWidth: 10 } },
        },
      },
    };
  }

  /** Active vs deactivated doughnut. */
  get stateChart() {
    const deact = this.rows.filter((r) => !!r.deactivated_at).length;
    const active = this.rows.length - deact;
    return {
      data: {
        labels: ['Active', 'Deactivated'],
        datasets: [{
          data: [active, deact],
          backgroundColor: ['#0F1419', '#DC2626'],
          borderWidth: 0,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: { position: 'bottom' as const, labels: { font: { size: 11 }, boxWidth: 10 } },
        },
      },
    };
  }

  /** Horizontal bar chart of the top 10 drivers in the current page by total rides. */
  get topRidesChart() {
    const top = [...this.rows]
      .filter((r) => (r.total_rides ?? 0) > 0)
      .sort((a, b) => (b.total_rides ?? 0) - (a.total_rides ?? 0))
      .slice(0, 10);
    return {
      data: {
        labels: top.map((r) => r.user?.name?.slice(0, 24) || `#${r.id}`),
        datasets: [{
          label: 'Total rides',
          data: top.map((r) => r.total_rides ?? 0),
          backgroundColor: '#16A34A',
          borderRadius: 6,
          borderSkipped: false,
        }],
      },
      options: {
        indexAxis: 'y' as const,
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: '#ECEFF3' } },
          y: { grid: { display: false } },
        },
      },
    };
  }

  /** Horizontal bar of the top 5 drivers by rides_7d (recent activity). */
  get top7dChart() {
    const top = [...this.rows]
      .filter((r) => (r.rides_7d ?? 0) > 0)
      .sort((a, b) => (b.rides_7d ?? 0) - (a.rides_7d ?? 0))
      .slice(0, 5);
    return {
      data: {
        labels: top.map((r) => r.user?.name?.slice(0, 24) || `#${r.id}`),
        datasets: [{
          label: 'Rides (last 7d)',
          data: top.map((r) => r.rides_7d ?? 0),
          backgroundColor: '#22C55E',
          borderRadius: 6,
          borderSkipped: false,
        }],
      },
      options: {
        indexAxis: 'y' as const,
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: '#ECEFF3' } },
          y: { grid: { display: false } },
        },
      },
    };
  }

  /** Vertical bar of driver count per vehicle_type. Unknown types lumped as "—". */
  get vehicleTypeChart() {
    const buckets = new Map<string, number>();
    for (const r of this.rows) {
      const k = (r.vehicle_type || '—').trim() || '—';
      buckets.set(k, (buckets.get(k) || 0) + 1);
    }
    const entries = Array.from(buckets.entries()).sort((a, b) => b[1] - a[1]);
    return {
      data: {
        labels: entries.map(([k]) => k),
        datasets: [{
          label: 'Drivers',
          data: entries.map(([, v]) => v),
          backgroundColor: '#16A34A',
          borderRadius: 6,
          borderSkipped: false,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false } },
          y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: '#ECEFF3' } },
        },
      },
    };
  }

  /** Histogram of lifetime-rides buckets so you can see the long tail at a glance. */
  get ridesHistogramChart() {
    const ranges = [
      { label: '0', min: 0, max: 0 },
      { label: '1–5', min: 1, max: 5 },
      { label: '6–20', min: 6, max: 20 },
      { label: '21–50', min: 21, max: 50 },
      { label: '51–100', min: 51, max: 100 },
      { label: '100+', min: 101, max: Infinity },
    ];
    const counts = ranges.map((b) => this.rows.filter((r) => {
      const n = r.total_rides ?? 0;
      return n >= b.min && n <= b.max;
    }).length);
    return {
      data: {
        labels: ranges.map((b) => b.label),
        datasets: [{
          label: 'Drivers',
          data: counts,
          backgroundColor: ['#94A0AD', '#9CA3AF', '#22C55E', '#16A34A', '#15803D', '#166534'],
          borderRadius: 6,
          borderSkipped: false,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: {
            title: { display: true, text: 'Lifetime completed rides', font: { size: 11 }, color: '#6B7785' },
            grid: { display: false },
          },
          y: {
            beginAtZero: true,
            ticks: { precision: 0 },
            title: { display: true, text: 'Driver count', font: { size: 11 }, color: '#6B7785' },
            grid: { color: '#ECEFF3' },
          },
        },
      },
    };
  }

  /** Scatter of rides_7d (x) vs total_rides (y). Reveals new-but-active vs long-tenured-quiet. */
  get recentVsLifetimeChart() {
    const pts = this.rows
      .filter((r) => (r.total_rides ?? 0) || (r.rides_7d ?? 0))
      .map((r) => ({ x: r.rides_7d ?? 0, y: r.total_rides ?? 0 }));
    return {
      data: {
        datasets: [{
          label: 'Drivers',
          data: pts,
          backgroundColor: 'rgba(22, 163, 74, 0.55)',
          borderColor: '#16A34A',
          pointRadius: 4,
          pointHoverRadius: 6,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: {
            title: { display: true, text: 'Rides (last 7d)', font: { size: 11 }, color: '#6B7785' },
            beginAtZero: true,
            ticks: { precision: 0 },
            grid: { color: '#ECEFF3' },
          },
          y: {
            title: { display: true, text: 'Total rides', font: { size: 11 }, color: '#6B7785' },
            beginAtZero: true,
            ticks: { precision: 0 },
            grid: { color: '#ECEFF3' },
          },
        },
      },
    };
  }

  /** Line chart of new driver registrations per day over the last 30 days. */
  get registrationsChart() {
    const days = 30;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const buckets = new Map<string, number>();
    const labels: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      buckets.set(key, 0);
      labels.push(`${d.getMonth() + 1}/${d.getDate()}`);
    }
    for (const r of this.rows) {
      if (!r.registered_on) continue;
      const key = r.registered_on.slice(0, 10);
      if (buckets.has(key)) buckets.set(key, (buckets.get(key) || 0) + 1);
    }
    return {
      data: {
        labels,
        datasets: [{
          label: 'New drivers',
          data: Array.from(buckets.values()),
          borderColor: '#16A34A',
          backgroundColor: 'rgba(34, 197, 94, 0.18)',
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          pointHoverRadius: 5,
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 14 } },
          y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: '#ECEFF3' } },
        },
      },
    };
  }

  /** Plain-number KPIs computed from the current page. */
  get stats() {
    const n = this.rows.length;
    const online = this.rows.filter((r) => r.is_online).length;
    const approved = this.rows.filter((r) => r.approval_status === 'approved').length;
    const pending = this.rows.filter((r) => r.approval_status === 'pending').length;
    const totals = this.rows.map((r) => r.total_rides ?? 0);
    const avg = totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : 0;
    // Median: pick the middle of a sorted copy (no point dragging in a math lib for this).
    const sorted = [...totals].sort((a, b) => a - b);
    const median = sorted.length
      ? (sorted.length % 2
          ? sorted[(sorted.length - 1) / 2]
          : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)
      : 0;
    return {
      online,
      onlinePct: n ? Math.round((online / n) * 100) : 0,
      approved,
      pending,
      approvalRate: n ? Math.round((approved / n) * 100) : 0,
      avgRides: avg,
      medianRides: median,
    };
  }

  // -------------------- Insights drawer --------------------
  openInsights(mode: InsightMode = 'leaderboard'): void {
    if (this.insightsCloseTimer) {
      clearTimeout(this.insightsCloseTimer);
      this.insightsCloseTimer = null;
    }
    this.insightsMode = mode;
    this.insightsMounted = true;
    this.insightsClosing = false;
    this.insightsOpen = true;
    if (!this.releaseInsightsScrollLock) this.releaseInsightsScrollLock = acquireDocumentScrollLock();
  }

  closeInsights(): void {
    if (!this.insightsMounted) return;
    this.insightsClosing = true;
    this.insightsOpen = false;
    // Allow the slide-out animation to finish before unmounting.
    this.insightsCloseTimer = setTimeout(() => {
      this.insightsMounted = false;
      this.insightsClosing = false;
      this.insightsCloseTimer = null;
      this.releaseInsightsScrollLock?.();
      this.releaseInsightsScrollLock = undefined;
    }, 200);
    // Strip the query param so reopening from a button doesn't re-trigger
    // openInsights via the queryParamMap subscription.
    if (this.route.snapshot.queryParamMap.get('insights')) {
      this.router.navigate([], {
        relativeTo: this.route,
        queryParams: { insights: null },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      });
    }
  }

  /**
   * Handler for the (driverClick) output on app-drivers-insights. The user
   * clicked an eye / row inside the leaderboard or performance table — close
   * the insights drawer and route to ?driverId=… so the page shell opens the
   * driver detail drawer on top.
   */
  onInsightsDriverClick(driverId: number): void {
    this.closeInsights();
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { driverId, insights: null },
      queryParamsHandling: 'merge',
    });
  }

  switchInsightsTab(mode: InsightMode): void {
    if (this.insightsMode === mode) return;
    this.insightsMode = mode;
  }

  exportCsv(): void {
    if (this.legacyStand) return;
    this.exporting = true;
    const params = new URLSearchParams({ state: this.state });
    if (this.search.trim()) params.set('q', this.search.trim());
    if (this.dateFrom) params.set('date_from', this.dateFrom);
    if (this.dateTo) params.set('date_to', this.dateTo);
    if (this.online !== 'all') params.set('is_online', this.online === 'online' ? '1' : '0');
    if (this.approval !== 'all') params.set('approval_status', this.approval);

    this.allocationParams(params);
    this.api.getBlob(`/admin/drivers/export?${params.toString()}`).subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `drivers-${this.state}-${Date.now()}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        this.exporting = false;
      },
      error: () => {
        this.toast.error('Export failed');
        this.exporting = false;
      },
    });
  }
}
