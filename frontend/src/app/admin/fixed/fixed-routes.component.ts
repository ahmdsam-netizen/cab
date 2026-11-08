import { ChangeDetectorRef, Component, EventEmitter, HostListener, Input, NgZone, OnDestroy, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription, firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { CityContextService } from '../../core/city-context.service';
import { ToastService } from '../../core/toast.service';
import { GoogleMapsLoaderService } from '../../core/google-maps-loader.service';
import { AdminRealtimeService } from '../../core/admin-realtime.service';
import {
  ButtonComponent,
  ColumnComponent,
  DataTableComponent,
  DrawerComponent,
  FilterPillComponent,
  FilterSelectComponent,
  IconComponent,
  ModalComponent,
} from '../../ui';

type RouteScope = 'local' | 'outstation';
type MapTool = 'origin' | 'dest' | 'path' | 'stop';

interface RouteStopRow {
  id?: number;
  seq?: number;
  name: string;
  lat: number | null;
  lng: number | null;
  is_pickup: boolean;
  is_drop: boolean;
  is_active: boolean;
  is_temporarily_unavailable: boolean;
  unavailable_reason: string | null;
}

export interface SuggestedStop {
  name: string;
  lat: number;
  lng: number;
  distanceFromStartKm: number;
  type?: 'transit' | 'junction' | 'locality' | 'landmark';
  added?: boolean;
}

interface FareConfig {
  seat_fare: number | null;
  commission_type?: 'percent' | 'fixed' | null;
  commission_percent: number | null;
  fixed_commission?: number | null;
}

interface LatLng { lat: number; lng: number; }

/** One real-road route Google returned between the start and the destination. */
interface RouteAlt {
  path: LatLng[];
  summary: string;
  distanceText: string;
  durationText: string;
  meters?: number;
  seconds?: number;
}

interface FixedNoShowSettings {
  stop_arrival_radius_m: number;
  driver_missed_stop_grace_minutes: number;
  customer_pickup_radius_m: number;
  vehicle_approaching_alert_radius_m: number;
  customer_grace_minutes: number;
  boarding_confirmation_mode: 'driver_only' | 'customer_otp' | 'driver_customer';
}

interface FixedRouteRow {
  id: number;
  city_id: number;
  scope: RouteScope;
  mode: 'fixed';
  origin_city_id: number | null;
  dest_city_id: number | null;
  name: string;
  origin_name: string;
  dest_name: string;
  origin_lat: number;
  origin_lng: number;
  dest_lat: number;
  dest_lng: number;
  path_polyline: number[][] | null;
  city_vehicle_type_id: number | null;
  fare_config?: FareConfig;
  flat_fare: number;
  booking_window_hours: number;
  waiting_time_per_stop_minutes: number;
  luggage_surcharge_amount: number;
  max_luggage_per_vehicle: number;
  fixed_settings_json?: Partial<FixedNoShowSettings> | null;
  is_active: boolean;
  sort_order: number;
  stops: RouteStopRow[];
}

interface VehicleTypeOption { id: number; display_name: string; max_people: number; luggage_capacity: number; }
interface CityOption { id: number; name: string; }

/** A route parsed from a Google My Maps KML/KMZ export, awaiting review + save. */
export interface ImportedRouteDraft {
  name: string;
  origin_name: string;
  origin_lat: number;
  origin_lng: number;
  dest_name: string;
  dest_lat: number;
  dest_lng: number;
  path: number[][];
  stops: { name: string; lat: number; lng: number }[];
  // Set when a same-name fixed route already exists in the city: the client can
  // update it (replace line + stops, keep fare/vehicle/settings) instead of
  // creating a duplicate. `existing` carries that route's current config to
  // pre-fill the preserved fields.
  existing_route_id?: number | null;
  existing?: FixedRouteRow | null;
}

const SCOPE_OPTIONS: { label: string; value: RouteScope }[] = [
  { label: 'Local (in-city)', value: 'local' },
  { label: 'Outstation (intercity)', value: 'outstation' },
];

@Component({
  selector: 'app-fixed-routes',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonComponent,
    ColumnComponent,
    DataTableComponent,
    DrawerComponent,
    FilterPillComponent,
    FilterSelectComponent,
    IconComponent,
    ModalComponent,
  ],
  template: `
    <div class="page">
      <header class="page__hero" *ngIf="!embedded">
        <div>
          <h1 class="page__title">Fixed Routes</h1>
          <p class="page__sub">Prepaid fixed routes with mapped stops, route path and booking controls.</p>
        </div>
        <tm-button *ngIf="cityId != null" variant="green" icon="plus" (clicked)="openCreate()">Add fixed route</tm-button>
      </header>

      <div class="cue" *ngIf="cityId == null && !embedded">
        <tm-icon name="map-marker" [size]="24" />
        <p class="cue__title">No city selected</p>
        <p class="cue__text">Pick a city from the switcher in the top bar to manage fixed routes.</p>
      </div>

      <ng-container *ngIf="cityId != null && !hideTable">
        <tm-data-table
          [rows]="filteredRoutes" [total]="filteredRoutes.length" [loading]="loading"
          emptyTitle="No fixed routes yet"
          emptyHint="Tap “Add fixed route” to draw a fixed route on the map."
        >
          <div slot="search" class="search-wrap">
            <tm-icon name="search" [size]="14" />
            <input [(ngModel)]="search" type="text" placeholder="Search by route or stops" />
          </div>

          <ng-container slot="filters">
            <tm-filter-select icon="map" ariaLabel="Scope filter" allLabel="All scopes"
              [options]="scopeFilterOptions" [value]="scope" (valueChange)="scope = $any($event)" />
            <tm-filter-select icon="shield" ariaLabel="Status filter" allLabel="All statuses"
              [options]="statusFilterOptions" [value]="status" (valueChange)="status = $any($event)" />
          </ng-container>

          <ng-container slot="banner">
            <tm-filter-pill *ngIf="search.trim()" icon="search" label="Search" [value]="search" (clear)="search = ''" />
            <tm-filter-pill *ngIf="scope !== 'all'" icon="map" label="Scope" [value]="scopeLabel(scope)" (clear)="scope = 'all'" />
            <tm-filter-pill *ngIf="status !== 'all'" icon="shield" label="Status" [value]="status" (clear)="status = 'all'" />
          </ng-container>

          <tm-column key="name" label="Route">
            <ng-template let-row>
              <div class="route-cell">
                <span class="route-cell__line"></span>
                <div class="route-cell__txt">
                  <span class="route-cell__name">{{ row.name }}</span>
                  <span class="route-cell__od">{{ row.origin_name }} <i>→</i> {{ row.dest_name }}</span>
                </div>
              </div>
            </ng-template>
          </tm-column>

          <tm-column key="kind" label="Scope" width="140">
            <ng-template let-row>
              <span class="tag" [attr.data-s]="row.scope">{{ scopeLabel(row.scope) }}</span>
            </ng-template>
          </tm-column>

          <tm-column key="fare" label="Fare" width="100">
            <ng-template let-row>
              <span class="cell-amt">₹{{ row.flat_fare | number: '1.0-2' }}</span>
            </ng-template>
          </tm-column>

          <tm-column key="luggage" label="Luggage" width="132" align="right">
            <ng-template let-row>
              <div class="stack-cell stack-cell--right">
                <span class="cell-amt">₹{{ (row.luggage_surcharge_amount || 0) | number: '1.0-2' }}</span>
                <small>Max {{ row.max_luggage_per_vehicle || 0 }}</small>
              </div>
            </ng-template>
          </tm-column>

          <tm-column key="commission" label="Commission" width="124" align="right">
            <ng-template let-row>
              <span class="cell-amt">{{ commissionLabel(row) }}</span>
            </ng-template>
          </tm-column>

          <tm-column key="stops" label="Stops" width="86" align="right">
            <ng-template let-row>
              <button
                type="button"
                class="stops-trigger"
                (click)="toggleStopsPopover(row, $event)"
                [attr.aria-expanded]="stopsPopoverRouteId === row.id"
              >{{ row.stops?.length || 0 }}</button>
            </ng-template>
          </tm-column>

          <tm-column key="status" label="Status" width="96">
            <ng-template let-row>
              <span class="status-pill" [attr.data-s]="row.is_active ? 'active' : 'inactive'">{{ row.is_active ? 'active' : 'inactive' }}</span>
            </ng-template>
          </tm-column>

          <tm-column key="actions" label="" width="90" align="right">
            <ng-template let-row>
              <div class="cell-actions">
                <button class="icon-btn" (click)="openEdit(row)" aria-label="Edit route"><tm-icon name="edit" [size]="14" /></button>
              </div>
            </ng-template>
          </tm-column>
        </tm-data-table>
      </ng-container>
    </div>

    <div class="rt-scrim" *ngIf="open && drawerMode" (click)="promptCloseEditor()"></div>
    <div class="rt-editor" [class.rt-editor--drawer]="drawerMode" *ngIf="open">
      <div class="rt-map-wrap">
        <div id="fixed-rt-edit-map" class="rt-map"></div>

        <div class="rt-hint">
          <tm-icon name="pin" [size]="14" />
          <span>{{ wizardStepHint }}</span>
        </div>

        <div class="wizard-stepper">
          <button type="button" class="wstep" [class.is-active]="wizardStep === 1" [class.is-done]="form.origin_lat != null" (click)="goToStep(1)">
            <span class="wstep__num">1</span>
            <span class="wstep__lbl">Start</span>
          </button>
          <span class="wstep__sep">→</span>
          <button type="button" class="wstep" [class.is-active]="wizardStep === 2" [class.is-done]="form.dest_lat != null" (click)="goToStep(2)">
            <span class="wstep__num">2</span>
            <span class="wstep__lbl">Destination</span>
          </button>
          <span class="wstep__sep">→</span>
          <button type="button" class="wstep" [class.is-active]="wizardStep === 3" [class.is-done]="form.stops.length > 0" (click)="goToStep(3)">
            <span class="wstep__num">3</span>
            <span class="wstep__lbl">Stops ({{ form.stops.length }})</span>
          </button>
          <span class="wstep__sep">→</span>
          <button type="button" class="wstep" [class.is-active]="wizardStep === 4" [class.is-done]="form.seat_fare != null" (click)="goToStep(4)">
            <span class="wstep__num">4</span>
            <span class="wstep__lbl">Fare & Policy</span>
          </button>
          <span class="wstep__sep">→</span>
          <button type="button" class="wstep" [class.is-active]="wizardStep === 5" [class.is-done]="form.city_vehicle_type_id != null" (click)="goToStep(5)">
            <span class="wstep__num">5</span>
            <span class="wstep__lbl">Stand & Drivers</span>
          </button>
          <span class="wstep__sep">→</span>
          <button type="button" class="wstep" [class.is-active]="wizardStep === 6" (click)="goToStep(6)">
            <span class="wstep__num">6</span>
            <span class="wstep__lbl">Review & Save</span>
          </button>
        </div>
      </div>

      <aside class="rt-panel">
        <header class="rt-panel__head">
          <div>
            <h2>{{ editingId ? 'Edit Route' : 'Add Fixed Route' }}</h2>
            <p>Step {{ wizardStep }} of 6: {{ wizardStepTitle }}</p>
          </div>
          <div class="rt-panel__head-actions">
            <button class="icon-btn rt-x" (click)="promptCloseEditor()" aria-label="Close">×</button>
          </div>
        </header>

        <div class="rt-panel__body">
          <!-- STEP 1: ROUTE TYPE & ORIGIN -->
          <div class="wstep-content" *ngIf="wizardStep === 1">
            <div class="wstep-lead">
              <h3>Route Scope & Starting Point</h3>
              <p>Choose whether this route operates within {{ cityName }} or connects between cities.</p>
            </div>

            <!-- Scope Selection Cards -->
            <div class="scope-choice-row">
              <button type="button" class="scope-choice-card" [class.is-active]="form.scope === 'local'" (click)="setScope('local')">
                <span class="scope-choice-icon">🏠</span>
                <div class="scope-choice-body">
                  <b>Local Route</b>
                  <small>Inside {{ cityName || 'city' }}</small>
                </div>
                <tm-icon *ngIf="form.scope === 'local'" name="check" [size]="16" class="text-green" />
              </button>

              <button type="button" class="scope-choice-card" [class.is-active]="form.scope === 'outstation'" (click)="setScope('outstation')">
                <span class="scope-choice-icon">🚗</span>
                <div class="scope-choice-body">
                  <b>Outstation Route</b>
                  <small>Between two cities</small>
                </div>
                <tm-icon *ngIf="form.scope === 'outstation'" name="check" [size]="16" class="text-green" />
              </button>
            </div>

            <!-- Outstation City Selectors -->
            <div class="outstation-cities-box" *ngIf="form.scope === 'outstation'">
              <div class="grid2">
                <label class="field">
                  <span class="field__lbl">Origin City <i>*</i></span>
                  <select [(ngModel)]="form.origin_city_id" (ngModelChange)="onOriginCityChange()">
                    <option *ngFor="let c of cities" [ngValue]="c.id">{{ c.name }}</option>
                  </select>
                </label>
                <label class="field">
                  <span class="field__lbl">Destination City <i>*</i></span>
                  <select [(ngModel)]="form.dest_city_id" (ngModelChange)="onDestCityChange()">
                    <option [ngValue]="null">Select destination city…</option>
                    <option *ngFor="let c of availableDestCities" [ngValue]="c.id">{{ c.name }}</option>
                  </select>
                </label>
              </div>
            </div>

            <label class="field" style="margin-top: 4px;">
              <span class="field__lbl">
                Start Location (Origin in {{ getCityName(form.origin_city_id) || cityName }}) <i>*</i>
              </span>
              <input
                id="wizard-origin-search"
                type="text"
                [(ngModel)]="form.origin_name"
                (keydown.enter)="onOriginSearchEnter($event)"
                (blur)="onOriginSearchBlur()"
                [placeholder]="'Search start in ' + (getCityName(form.origin_city_id) || cityName) + '...'" />
            </label>

            <!-- Origin Loading Indicator -->
            <p class="muted small">To rename this point, edit the text and continue. Press Enter to search for a different location.</p>
            <div class="location-setting-loader" *ngIf="isSettingOrigin">
              <div class="spinner-sm"></div>
              <span>Adding the origin, please wait...</span>
            </div>

            <div class="selected-point-box" *ngIf="form.origin_lat != null && !isSettingOrigin">
              <span class="point-dot a">A</span>
              <div class="point-details">
                <b>{{ form.origin_name }}</b>
                <small>{{ form.origin_lat | number:'1.4-4' }}, {{ form.origin_lng | number:'1.4-4' }}</small>
              </div>
              <tm-icon name="check" [size]="16" class="text-green" />
            </div>

            <div class="wstep-tip">
              💡 <b>Tip:</b> You can also click directly anywhere on the map to set or move the green Start marker.
            </div>
          </div>

          <!-- STEP 2: SET DESTINATION -->
          <div class="wstep-content" *ngIf="wizardStep === 2">
            <div class="wstep-lead">
              <h3>Where does this route end?</h3>
              <p *ngIf="form.scope === 'local'">Type the destination terminal / landmark in {{ cityName }}, or tap on the map.</p>
              <p *ngIf="form.scope === 'outstation'">Type the destination terminal / landmark in {{ getCityName(form.dest_city_id) || 'the destination city' }}, or tap on the map.</p>
            </div>

            <label class="field">
              <span class="field__lbl">
                Destination Location (in {{ (form.scope === 'outstation' ? getCityName(form.dest_city_id) : null) || cityName }}) <i>*</i>
              </span>
              <input
                id="wizard-dest-search"
                type="text"
                [(ngModel)]="form.dest_name"
                (keydown.enter)="onDestSearchEnter($event)"
                (blur)="onDestSearchBlur()"
                [placeholder]="'Search destination in ' + ((form.scope === 'outstation' ? getCityName(form.dest_city_id) : null) || cityName) + '...'" />
            </label>

            <!-- Destination Loading Indicator -->
            <p class="muted small">To rename this point, edit the text and continue. Press Enter to search for a different location.</p>
            <div class="location-setting-loader" *ngIf="isSettingDest">
              <div class="spinner-sm"></div>
              <span>Adding the destination, please wait...</span>
            </div>

            <div class="selected-point-box" *ngIf="form.dest_lat != null && !isSettingDest">
              <span class="point-dot b">B</span>
              <div class="point-details">
                <b>{{ form.dest_name }}</b>
                <small>{{ form.dest_lat | number:'1.4-4' }}, {{ form.dest_lng | number:'1.4-4' }}</small>
              </div>
              <tm-icon name="check" [size]="16" class="text-green" />
            </div>

            <div class="route-metrics" *ngIf="estimatedDistanceText">
              <div class="route-metric">
                <tm-icon name="road" [size]="14" />
                <span><b>{{ estimatedDistanceText }}</b></span>
              </div>
              <div class="route-metric" *ngIf="estimatedDurationText">
                <tm-icon name="bolt" [size]="14" />
                <span>{{ estimatedDurationText }}</span>
              </div>
              <span class="ws__grow"></span>
              <button type="button" class="micro-action-btn" (click)="reverseRoute()" title="Swap Start and Destination">
                <tm-icon name="refresh" [size]="12" /> Swap / Reverse
              </button>
            </div>
          </div>

            <!-- Route Alternatives Selection Cards -->
            <div class="route-alts-card" *ngIf="routeAlts.length > 1">
              <div class="route-alts-header">
                <span class="route-alts-title">Available Corridors ({{ routeAlts.length }})</span>
                <span class="route-alts-subtitle">Click a card below or tap any grey line on the map to switch route</span>
              </div>
              <div class="route-alts-list">
                <div
                  *ngFor="let alt of routeAlts; let i = index"
                  class="route-alt-item"
                  [class.is-selected]="selectedAltIdx === i"
                  [class.is-hovered]="hoveredAltIdx === i"
                  (click)="selectAlternative(i)"
                  (mouseenter)="hoverAlternative(i)"
                  (mouseleave)="hoverAlternative(null)"
                >
                  <div class="route-alt-radio">
                    <span class="custom-radio-dot" [class.is-checked]="selectedAltIdx === i"></span>
                  </div>
                  <div class="route-alt-details">
                    <div class="route-alt-name-row">
                      <strong class="route-alt-name">{{ alt.summary ? ('Via ' + alt.summary) : ('Corridor Option ' + (i + 1)) }}</strong>
                      <span class="route-alt-tag" *ngIf="selectedAltIdx === i">Active Path</span>
                    </div>
                    <div class="route-alt-metrics-row">
                      <span>{{ alt.distanceText }}</span>
                      <span class="meta-dot">·</span>
                      <span>{{ alt.durationText }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Via Corridor Waypoint Section -->
            <div class="via-corridor-box" *ngIf="form.origin_lat != null && form.dest_lat != null">
              <div class="via-corridor-head">
                <span class="via-corridor-title">Force Specific Corridor / Via Town</span>
                <span class="via-corridor-hint">E.g. force route via Magam or Narbal</span>
              </div>
              <div class="via-input-group">
                <input
                  type="text"
                  [(ngModel)]="viaSearchQuery"
                  (keydown.enter)="addViaCorridorPoint(viaSearchQuery)"
                  placeholder="Type town / landmark to route via (e.g. Magam)..."
                />
                <button
                  type="button"
                  class="btn-via-apply"
                  (click)="addViaCorridorPoint(viaSearchQuery)"
                  [disabled]="!viaSearchQuery.trim()"
                >
                  + Route Via
                </button>
              </div>
              <div class="via-chips-row" *ngIf="form.path.length">
                <span *ngFor="let p of form.path; let pi = index" class="via-chip">
                  <span>Via Waypoint #{{ pi + 1 }}</span>
                  <button type="button" class="via-chip-del" (click)="removeViaCorridorPoint(pi)" title="Remove waypoint">×</button>
                </span>
                <button type="button" class="btn-via-reset" (click)="clearViaCorridorPoints()">Reset to Direct</button>
              </div>
            </div>


          <!-- STEP 3: INTERMEDIATE STOPS -->
          <div class="wstep-content" *ngIf="wizardStep === 3">
            <div class="wstep-lead">
              <h3>Intermediate Stops Along Corridor</h3>
              <p>Add transit stops, bus stands, and key intersections along your route corridor.</p>
            </div>

            <!-- Stop Search Form with Transit Autocomplete & Live Dropdown -->
            <div class="stop-search-box">
              <label class="field">
                <span class="field__lbl">Search Transit Stop / Intersection / Chowk</span>
                <div class="search-input-wrap">
                  <tm-icon name="search" [size]="14" class="search-input-icon" />
                  <input
                    id="wizard-stop-search"
                    type="text"
                    [(ngModel)]="stopSearchQuery"
                    (input)="onStopSearchInput(stopSearchQuery)"
                    (keydown.enter)="onStopSearchEnter()"
                    (focus)="onStopSearchFocus()"
                    (blur)="onStopSearchBlur()"
                    autocomplete="off"
                    spellcheck="false"
                    placeholder="Type Chowk, Bus Stand, Bypass, Junction..." />
                  <button *ngIf="stopSearchQuery" type="button" class="search-clear-btn" (click)="clearStopSearch()" aria-label="Clear search">✕</button>
                </div>
              </label>

              <!-- Live Transit Autocomplete Predictions Dropdown -->
              <div class="stop-search-dropdown" *ngIf="stopSearchResults.length > 0 && isStopSearchDropdownOpen">
                <div class="search-dropdown-header">
                  <span>Transit Places along Corridor</span>
                  <button type="button" class="close-drop-btn" (click)="isStopSearchDropdownOpen = false">✕</button>
                </div>
                <div class="search-dropdown-list">
                  <button
                    type="button"
                    class="search-dropdown-item"
                    *ngFor="let item of stopSearchResults"
                    (click)="selectStopSearchResult(item)">
                    <span class="item-icon">🚏</span>
                    <div class="item-text">
                      <span class="item-main">{{ item.main_text }}</span>
                      <span class="item-sub" *ngIf="item.secondary_text">{{ item.secondary_text }}</span>
                    </div>
                    <span class="item-add-tag">+ Add</span>
                  </button>
                </div>
              </div>

              <!-- Loading Indicator -->
              <div class="search-loading-hint" *ngIf="isSearchingStops">
                <span>Searching transit locations...</span>
              </div>
            </div>

            <!-- Suggested Stops Along Corridor -->
            <div class="suggested-stops-section">
              <div class="suggested-stops-head">
                <div style="display: flex; align-items: center; gap: 6px;">
                  <span>✨</span>
                  <b>Suggested Stops Along Corridor</b>
                  <span class="count-badge" *ngIf="suggestedStops.length">({{ suggestedStops.length }} found)</span>
                </div>
                <button type="button" class="btn-link" (click)="detectSuggestedStops()" [disabled]="loadingSuggestedStops || !roadPath.length">
                  {{ loadingSuggestedStops ? 'Scanning…' : '🔄 Refresh' }}
                </button>
              </div>

              <div class="suggested-chips-wrap" *ngIf="suggestedStops.length; else noSuggestionsCue">
                <button type="button" class="suggested-stop-chip" *ngFor="let s of suggestedStops"
                  [class.is-added]="s.added || isStopAlreadyAdded(s.name)"
                  [disabled]="s.added || isStopAlreadyAdded(s.name)"
                  (click)="addSuggestedStop(s)">
                  <span class="chip-add-icon">{{ (s.added || isStopAlreadyAdded(s.name)) ? '✓' : '+' }}</span>
                  <span class="chip-stop-name">{{ s.name }}</span>
                  <span class="chip-dist-badge" *ngIf="s.distanceFromStartKm">{{ s.distanceFromStartKm }} km</span>
                </button>
              </div>

              <ng-template #noSuggestionsCue>
                <div class="suggestions-loading" *ngIf="loadingSuggestedStops">
                  Scanning corridor for bus stands, chowks, and transit points…
                </div>
                <div class="suggestions-empty" *ngIf="!loadingSuggestedStops">
                  <p class="muted small">Click "Refresh" or search above to find stops along this corridor.</p>
                </div>
              </ng-template>
            </div>

            <!-- Map Placement Helper -->
            <div class="stops-actions-row">
              <button type="button" class="btn-action-secondary" [class.on]="tool === 'stop'" (click)="setTool('stop')">
                <tm-icon name="map-marker" [size]="13" /> {{ tool === 'stop' ? 'Map pin mode active (Click green road line)' : 'Click map to place custom stop' }}
              </button>
            </div>

            <!-- Added Stops Sequence List -->
            <div class="stops-list-container">
              <div class="stops-list-head">
                <b>{{ form.stops.length }} Added Stop{{ form.stops.length === 1 ? '' : 's' }} in Route Sequence</b>
              </div>

              <p class="muted small" *ngIf="!form.stops.length">No intermediate stops added yet. Passengers will only ride directly from Start to Destination.</p>

              <div class="stop-card" *ngFor="let s of form.stops; let i = index">
                <div class="stop-card__head">
                  <div style="display: flex; align-items: center; gap: 6px;">
                    <span class="stop-seq">Stop {{ i + 1 }}</span>
                    <span class="stop-loc-tag" *ngIf="s.lat != null && s.lng != null">{{ calculateDistanceFromOriginKm({ lat: s.lat, lng: s.lng }) }} km from start</span>
                  </div>
                  <span class="ws__grow"></span>
                  <button type="button" class="stop-remove" (click)="removeStop(i)" aria-label="Remove stop">✕ Remove</button>
                </div>
                <input type="text" class="stop-name" [(ngModel)]="s.name" placeholder="Stop name" />
                <div class="stop-flags">
                  <label class="stop-chip"><input type="checkbox" [(ngModel)]="s.is_pickup" /> <span>Boarding allowed</span></label>
                  <label class="stop-chip"><input type="checkbox" [(ngModel)]="s.is_drop" /> <span>Drop allowed</span></label>
                </div>
              </div>
            </div>
          </div>

          <!-- STEP 4: FARE, SEATS & LUGGAGE -->
          <div class="wstep-content" *ngIf="wizardStep === 4">
            <div class="wstep-lead">
              <h3>Pricing & Booking Policies</h3>
              <p>Configure passenger fare, platform commission, and luggage capacity.</p>
            </div>

            <label class="field">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px;">
                <span class="field__lbl">Route Name <i>*</i></span>
                <span class="muted small" *ngIf="form.scope === 'local'">Local ({{ cityName }})</span>
                <span class="muted small" *ngIf="form.scope === 'outstation'">Outstation ({{ getCityName(form.origin_city_id) }} → {{ getCityName(form.dest_city_id) }})</span>
              </div>
              <input type="text" [(ngModel)]="form.name" placeholder="e.g. Srinagar → Sopore" />
            </label>

            <div class="grid2">
              <label class="field">
                <span class="field__lbl">Flat Fare per Seat (₹) <i>*</i></span>
                <input type="number" min="0" step="1" [(ngModel)]="form.seat_fare" placeholder="150" />
              </label>
              <label class="field">
                <span class="field__lbl">Commission Type</span>
                <div class="seg">
                  <button type="button" class="seg__btn" [class.is-on]="form.commission_type === 'percent'" (click)="form.commission_type = 'percent'">Percent (%)</button>
                  <button type="button" class="seg__btn" [class.is-on]="form.commission_type === 'fixed'" (click)="form.commission_type = 'fixed'">Fixed (₹)</button>
                </div>
              </label>
            </div>

            <div class="grid2">
              <label class="field" *ngIf="form.commission_type === 'percent'">
                <span class="field__lbl">Commission (%)</span>
                <input type="number" min="0" max="100" step="1" [(ngModel)]="form.commission_percent" placeholder="20" />
              </label>
              <label class="field" *ngIf="form.commission_type === 'fixed'">
                <span class="field__lbl">Fixed Commission (₹)</span>
                <input type="number" min="0" step="1" [(ngModel)]="form.fixed_commission" placeholder="20" />
              </label>
              <label class="field">
                <span class="field__lbl">Booking Window (Hours)</span>
                <input type="number" min="0" max="24" step="1" [(ngModel)]="form.booking_window_hours" placeholder="6" />
              </label>
            </div>

            <div class="grid2">
              <label class="field">
                <span class="field__lbl">Max Luggage per Vehicle</span>
                <input type="number" min="0" step="1" [(ngModel)]="form.max_luggage_per_vehicle" placeholder="2" />
              </label>
              <label class="field">
                <span class="field__lbl">Luggage Surcharge (₹)</span>
                <input type="number" min="0" step="1" [(ngModel)]="form.luggage_surcharge_amount" placeholder="0" />
              </label>
            </div>
          </div>

          <!-- STEP 5: ASSIGN VEHICLE, GROUP & DRIVERS -->
          <div class="wstep-content" *ngIf="wizardStep === 5">
            <div class="wstep-lead">
              <h3>Assign Vehicle, Stand & Drivers</h3>
              <p>Attach this route to a vehicle model, stand, and assign local drivers.</p>
              <p *ngIf="editingId">Existing stand assignments are kept when you save. Remove assignments from Stands when needed.</p>
              <p *ngIf="additionalStandNames">Also assigned to: {{ additionalStandNames }}</p>
            </div>

            <!-- 1. Vehicle Type Chips -->
            <div class="field">
              <span class="field__lbl">1. Select Vehicle Type <i>*</i></span>
              <div class="chips-grid" *ngIf="vehicleTypes.length; else noVehiclesCue">
                <button type="button" class="chip-card" *ngFor="let v of vehicleTypes"
                  [class.is-selected]="form.city_vehicle_type_id === v.id"
                  (click)="onVehiclePicked(v.id)">
                  <span class="chip-icon">🚐</span>
                  <div class="chip-info">
                    <b class="chip-title">{{ v.display_name }}</b>
                    <span class="chip-sub">{{ v.max_people }} seats • {{ v.luggage_capacity || 0 }} luggage</span>
                  </div>
                  <tm-icon *ngIf="form.city_vehicle_type_id === v.id" name="check" [size]="16" class="chip-check text-green" />
                </button>
              </div>
              <ng-template #noVehiclesCue>
                <p class="muted small">No active vehicle models in this city.</p>
              </ng-template>
            </div>

            <!-- Vehicle Groups Loader -->
            <div class="vehicle-groups-loader" *ngIf="loadingVehicleGroups">
              <div class="spinner-sm"></div>
              <span>Loading stands and drivers for vehicle...</span>
            </div>

            <!-- Hidden until a vehicle is picked and loaded -->
            <ng-container *ngIf="form.city_vehicle_type_id && !loadingVehicleGroups">
              <!-- 2. Route Group Assignment Chips -->
              <div class="field" style="margin-top: 14px;">
                <span class="field__lbl">2. Stand Assignment <i>*</i></span>
                <div class="chips-grid">
                  <button type="button" class="chip-card" *ngFor="let g of vehicleFilteredGroups"
                    [class.is-selected]="form.assigned_group_id === g.id"
                    (click)="form.assigned_group_id = g.id; onGroupSelected(g.id)">
                    <span class="chip-icon">📁</span>
                    <div class="chip-info">
                      <b class="chip-title">{{ g.name }}</b>
                      <span class="chip-sub">{{ g.route_ids.length }} route(s)</span>
                    </div>
                    <tm-icon *ngIf="form.assigned_group_id === g.id" name="check" [size]="16" class="chip-check text-green" />
                  </button>

                  <button type="button" class="chip-card"
                    [class.is-selected]="form.assigned_group_id === 'new'"
                    (click)="form.assigned_group_id = 'new'">
                    <span class="chip-icon">➕</span>
                    <div class="chip-info">
                      <b class="chip-title">New Stand</b>
                      <span class="chip-sub">Create bundle</span>
                    </div>
                    <tm-icon *ngIf="form.assigned_group_id === 'new'" name="check" [size]="16" class="chip-check text-green" />
                  </button>
                </div>
              </div>

              <label class="field" *ngIf="form.assigned_group_id === 'new'" style="margin-top: 8px;">
                <span class="field__lbl">New Stand Name <i>*</i></span>
                <input type="text" [(ngModel)]="form.new_group_name" placeholder="e.g. Sopore Express Corridor" />
              </label>

              <!-- 3. Drivers Assignment -->
              <div class="field" style="margin-top: 14px;">
                <div class="drivers-head-bar">
                  <span class="field__lbl">3. Assign Drivers in Area ({{ form.assigned_driver_ids.length }} selected)</span>
                  <button type="button" class="btn-link" (click)="toggleSelectAllDrivers()" *ngIf="vehicleFilteredDrivers.length">
                    {{ form.assigned_driver_ids.length === vehicleFilteredDrivers.length ? 'Deselect All' : 'Select All' }}
                  </button>
                </div>

                <div class="drivers-card-list" *ngIf="vehicleFilteredDrivers.length; else noDriversCue">
                  <div class="driver-card-row" *ngFor="let d of vehicleFilteredDrivers"
                    [class.is-selected]="form.assigned_driver_ids.includes(d.user_id || d.id)"
                    (click)="toggleDriverAssignment(d.user_id || d.id)">
                    <input type="checkbox"
                      [checked]="form.assigned_driver_ids.includes(d.user_id || d.id)"
                      (click)="$event.stopPropagation()"
                      (change)="toggleDriverAssignment(d.user_id || d.id)" />
                    
                    <div class="driver-avatar">👤</div>

                    <div class="driver-main-info">
                      <div class="driver-name-row">
                        <b class="driver-name">{{ d.name }}</b>
                        <span class="driver-vehicle-badge" *ngIf="d.vehicle_model">{{ d.vehicle_model }}</span>
                      </div>
                    </div>

                    <span class="driver-phone" *ngIf="d.phone">{{ d.phone }}</span>
                  </div>
                </div>

                <ng-template #noDriversCue>
                  <p class="muted small" style="margin-top: 4px;">No approved drivers giving service in this city area yet. You can assign drivers anytime later.</p>
                </ng-template>
              </div>
            </ng-container>
          </div>

          <!-- STEP 6: OVERVIEW & PUBLISH -->
          <div class="wstep-content" *ngIf="wizardStep === 6">
            <div class="wstep-lead">
              <h3>Route Review & Map Overview</h3>
              <p>Review the finalized route details and road path before publishing.</p>
            </div>

            <div class="review-summary-card">
              <div class="review-head">
                <div>
                  <h4 class="review-name">{{ form.name }}</h4>
                  <span class="scope-tag" *ngIf="form.scope === 'local'">LOCAL ROUTE ({{ cityName }})</span>
                  <span class="scope-tag" *ngIf="form.scope === 'outstation'" style="background: #ffedd5; color: #c2410c;">OUTSTATION ({{ getCityName(form.origin_city_id) }} → {{ getCityName(form.dest_city_id) }})</span>
                </div>
                <div class="review-fare">
                  <b>₹{{ form.seat_fare }}</b>
                  <small>/ seat</small>
                </div>
              </div>

              <div class="review-stats">
                <div class="review-stat" *ngIf="estimatedDistanceText">
                  <tm-icon name="road" [size]="14" />
                  <span>{{ estimatedDistanceText }}</span>
                </div>
                <div class="review-stat" *ngIf="estimatedDurationText">
                  <tm-icon name="bolt" [size]="14" />
                  <span>{{ estimatedDurationText }}</span>
                </div>
                <div class="review-stat">
                  <tm-icon name="map-marker" [size]="14" />
                  <span>{{ form.stops.length + 2 }} total stops</span>
                </div>
              </div>

              <div class="review-itinerary">
                <div class="itinerary-stop is-start">
                  <span class="dot a">A</span>
                  <span class="txt"><b>Start:</b> {{ form.origin_name }}</span>
                </div>
                <div class="itinerary-stop is-intermediate" *ngFor="let s of form.stops; let i = index">
                  <span class="dot mid">{{ i + 1 }}</span>
                  <span class="txt">{{ s.name }}</span>
                </div>
                <div class="itinerary-stop is-end">
                  <span class="dot b">B</span>
                  <span class="txt"><b>Destination:</b> {{ form.dest_name }}</span>
                </div>
              </div>

              <div class="review-meta-grid">
                <div class="meta-item">
                  <span class="meta-label">Vehicle:</span>
                  <span class="meta-val">{{ getVehicleDisplayName(form.city_vehicle_type_id) }}</span>
                </div>
                <div class="meta-item">
                  <span class="meta-label">Stand:</span>
                  <span class="meta-val">{{ getGroupDisplayName() }}</span>
                </div>
                <div class="meta-item">
                  <span class="meta-label">Assigned Drivers:</span>
                  <span class="meta-val">{{ form.assigned_driver_ids.length }} driver(s)</span>
                </div>
                <div class="meta-item">
                  <span class="meta-label">Commission:</span>
                  <span class="meta-val">{{ form.commission_type === 'percent' ? ((form.commission_percent || 0) + '%') : ('₹' + (form.fixed_commission || 0)) }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <footer class="rt-panel__foot">
          <tm-button variant="ghost" *ngIf="wizardStep === 1" (clicked)="promptCloseEditor()">Cancel</tm-button>
          <tm-button variant="outline" *ngIf="wizardStep > 1" (clicked)="prevStep()">← Back</tm-button>

          <span class="ws__grow"></span>

          <tm-button variant="green" *ngIf="wizardStep === 1" [disabled]="form.origin_lat == null" (clicked)="goToStep(2)">
            Next: Set Destination →
          </tm-button>
          <tm-button variant="green" *ngIf="wizardStep === 2" [disabled]="form.dest_lat == null" (clicked)="goToStep(3)">
            Next: Add Stops →
          </tm-button>
          <tm-button variant="green" *ngIf="wizardStep === 3" (clicked)="goToStep(4)">
            Next: Fare & Policy →
          </tm-button>
          <tm-button variant="green" *ngIf="wizardStep === 4" [disabled]="!form.name.trim() || form.seat_fare == null" (clicked)="goToStep(5)">
            Next: Stand & Drivers →
          </tm-button>
          <tm-button variant="green" *ngIf="wizardStep === 5" (clicked)="goToStep(6)">
            Next: Review & Overview →
          </tm-button>
          <tm-button variant="green" icon="check" *ngIf="wizardStep === 6" [disabled]="saving" (clicked)="promptSave()">
            {{ saving ? 'Saving…' : (editingId ? '💾 Save Changes' : '💾 Save & Publish Route') }}
          </tm-button>
        </footer>
      </aside>
    </div>

    <!-- Discard Warning Modal -->
    <tm-modal [open]="discardConfirmOpen" title="Discard Route?" (closed)="discardConfirmOpen = false">
      <div slot="body">
        <p>You have unsaved route progress. Are you sure you want to discard this route? All entered steps and settings will be lost.</p>
      </div>
      <div slot="footer">
        <tm-button variant="ghost" (clicked)="discardConfirmOpen = false">Continue Editing</tm-button>
        <tm-button variant="danger" (clicked)="forceCloseEditor()">Discard & Exit</tm-button>
      </div>
    </tm-modal>

    <!-- Save Confirmation Modal -->
    <tm-modal [open]="saveConfirmOpen" title="Confirm & Publish Route" (closed)="saveConfirmOpen = false">
      <div slot="body">
        <p>Are you sure you want to save and publish route <b>"{{ form.name }}"</b> with <b>{{ form.stops.length + 2 }} total stops</b> at <b>₹{{ form.seat_fare }} per seat</b>?</p>
        <p *ngIf="form.assigned_group_id === 'new'" style="margin-top: 6px; color: var(--tm-green); font-weight: 700;">
          A new stand "{{ form.new_group_name }}" will also be created.
        </p>
      </div>
      <div slot="footer">
        <tm-button variant="ghost" (clicked)="saveConfirmOpen = false">Cancel</tm-button>
        <tm-button variant="green" (clicked)="confirmSave()">Confirm & Publish</tm-button>
      </div>
    </tm-modal>

    <div
      class="stops-popover"
      *ngIf="stopsPopoverLines.length"
      [style.left.px]="stopsPopoverX"
      [style.top.px]="stopsPopoverY"
      (click)="$event.stopPropagation()"
    >
      <div class="stops-popover__title">Stops</div>
      <div class="stops-popover__line" *ngFor="let stop of stopsPopoverLines">{{ stop }}</div>
    </div>
  `,
  styles: [`
    .page { display: flex; flex-direction: column; gap: 16px; }
    .page__hero { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
    .page__title { margin: 0; font-size: 22px; font-weight: 800; color: var(--tm-text); }
    .page__sub { margin: 4px 0 0; font-size: 13px; color: var(--tm-text-muted); }
    .cue { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 48px 24px; text-align: center; background: var(--tm-surface); border: 1px dashed var(--tm-line); border-radius: var(--tm-radius-lg); color: var(--tm-text-muted); }
    .cue__title { margin: 6px 0 0; font-size: 15px; font-weight: 800; color: var(--tm-text); }
    .cue__text { margin: 0; font-size: 13px; }
    .search-wrap { display: flex; align-items: center; gap: 8px; padding: 0 12px; height: 38px; border: 1px solid var(--tm-line); border-radius: 10px; background: var(--tm-surface); color: var(--tm-text-muted); }
    .search-wrap input { flex: 1; border: 0; outline: none; background: transparent; color: var(--tm-text); font: inherit; }
    .route-cell { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .route-cell__line { width: 4px; align-self: stretch; min-height: 30px; border-radius: 3px; background: var(--tm-success-fg, #16a34a); }
    .route-cell__txt { display: flex; flex-direction: column; min-width: 0; }
    .route-cell__name { font-size: 13px; font-weight: 800; color: var(--tm-text); }
    .route-cell__od { font-size: 11px; color: var(--tm-text-muted); }
    .route-cell__od i { font-style: normal; color: var(--tm-green); font-weight: 800; }
    .cell-amt { font-family: var(--tm-font-mono); font-weight: 700; color: var(--tm-text); }
    .stack-cell { display: flex; flex-direction: column; gap: 2px; line-height: 1.2; }
    .stack-cell--right { align-items: flex-end; }
    .stack-cell small { color: var(--tm-text-muted); font-size: 10.5px; font-weight: 700; }
    .muted { color: var(--tm-text-muted); font-size: 12px; }
    .muted.small { font-size: 12px; }
    .tag { display: inline-flex; align-items: center; text-transform: capitalize; font-size: 10px; font-weight: 800; letter-spacing: 0.3px; padding: 3px 8px; border-radius: var(--tm-radius-pill); background: var(--tm-canvas-2); color: var(--tm-text-muted); }
    .tag[data-s="outstation"] { background: #fff7ed; color: #c2410c; }
    .status-pill { display: inline-flex; align-items: center; text-transform: capitalize; font-size: 10px; font-weight: 800; letter-spacing: 0.3px; padding: 3px 10px; border-radius: var(--tm-radius-pill); background: var(--tm-canvas-2); color: var(--tm-text-muted); }
    .status-pill[data-s="active"] { background: var(--tm-success-bg); color: var(--tm-success-fg); }
    .cell-actions { display: inline-flex; gap: 6px; }
    .icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 7px; background: var(--tm-canvas-2); color: var(--tm-text-muted); cursor: pointer; border: 0; }
    .icon-btn:hover { background: var(--tm-ink); color: #fff; }
    .icon-btn--danger:hover { background: var(--tm-danger, #ef4444); }
    .rt-x { font-size: 20px; line-height: 1; font-weight: 700; }
    .rt-editor { position: fixed; inset: 0; height: 100dvh; overflow: hidden; z-index: 1000; display: grid; grid-template-columns: minmax(0, 1fr) 440px; background: var(--tm-canvas); animation: rtFade 0.18s ease; }
    @keyframes rtFade { from { opacity: 0; } to { opacity: 1; } }
    /* Drawer mode — a 90%-wide panel sliding in from the right over a scrim,
       instead of the full-screen takeover. Used inside the vehicle workspace. */
    .rt-scrim { position: fixed; inset: 0; z-index: 999; background: rgba(8,12,16,.5); animation: rtFade .18s ease; }
    .rt-editor--drawer { left: auto; right: 0; width: 94vw; max-width: 1600px; box-shadow: -10px 0 40px rgba(8,12,16,.28); animation: rtSlide .2s ease; }
    @keyframes rtSlide { from { transform: translateX(100%); } to { transform: none; } }
    @media (prefers-reduced-motion: reduce) { .rt-editor, .rt-editor--drawer, .rt-scrim { animation: none; } }
    .rt-map-wrap { position: relative; overflow: hidden; }
    .rt-map { position: absolute; inset: 0; width: 100%; height: 100%; }
    .rt-search { position: absolute; top: 14px; left: 14px; right: 14px; max-width: 460px; display: flex; align-items: center; gap: 8px; padding: 0 12px; height: 44px; background: #fff; border-radius: 12px; box-shadow: 0 8px 24px rgba(13,27,42,0.16); color: var(--tm-text-muted); }
    .rt-search input { flex: 1; border: 0; outline: none; background: transparent; font-size: 14px; color: var(--tm-text); font-family: inherit; }
    .rt-tools { position: absolute; left: 14px; bottom: 14px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 8px; background: #fff; border-radius: 14px; box-shadow: 0 8px 24px rgba(13,27,42,0.16); max-width: calc(100% - 28px); }
    .rt-tool { display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px; border-radius: 9px; border: 1.5px solid var(--tm-line); background: var(--tm-canvas); color: var(--tm-text); font-size: 12.5px; font-weight: 700; cursor: pointer; font-family: inherit; }
    .rt-tool.on { border-color: var(--tm-green); background: var(--tm-success-bg); color: var(--tm-success-fg); }
    .rt-tool.ghost { color: var(--tm-text-muted); }
    .rt-tool:disabled { opacity: 0.5; cursor: default; }
    .rt-tool__dot { width: 10px; height: 10px; border-radius: 50%; }
    .rt-tool__dot.a { background: #16a34a; } .rt-tool__dot.b { background: #ef4444; }
    .rt-tools__sep { width: 1px; height: 22px; background: var(--tm-line); margin: 0 2px; }
    .rt-hint { position: absolute; top: 14px; right: 14px; display: flex; align-items: center; gap: 7px; padding: 8px 12px; background: rgba(13,27,42,0.82); color: #fff; border-radius: 10px; font-size: 12.5px; font-weight: 600; max-width: 320px; }
    .rt-steps { position: absolute; top: 66px; right: 14px; display: grid; gap: 6px; width: 178px; padding: 8px; border-radius: 12px; background: #fff; box-shadow: 0 8px 24px rgba(13,27,42,0.16); }
    .rt-steps span { min-height: 30px; display: flex; align-items: center; padding: 0 10px; border-radius: 8px; background: var(--tm-canvas); color: var(--tm-text-muted); font-size: 12px; font-weight: 850; }
    .rt-steps span.on { background: #ecfdf5; color: #15803d; outline: 1px solid #86efac; }
    .rt-steps span.done { background: var(--tm-success-bg); color: var(--tm-success-fg); }
    .rt-alts { position: absolute; top: 236px; right: 14px; width: 268px; max-height: calc(100dvh - 260px); overflow-y: auto; display: grid; gap: 6px; padding: 10px; border-radius: 12px; background: #fff; box-shadow: 0 8px 24px rgba(13,27,42,0.16); }
    .rt-alts__head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-size: 11px; font-weight: 900; text-transform: uppercase; letter-spacing: 0.4px; color: var(--tm-text); }
    .rt-alts__head small { font-size: 10px; font-weight: 800; color: var(--tm-text-muted); letter-spacing: 0; text-transform: none; }
    .rt-alts__loading { margin: 0; font-size: 12px; font-weight: 700; color: var(--tm-text-muted); }
    .rt-alt { display: flex; align-items: center; gap: 9px; width: 100%; padding: 9px 10px; border: 1.5px solid var(--tm-line); border-radius: 10px; background: var(--tm-canvas); cursor: pointer; text-align: left; font-family: inherit; }
    .rt-alt:hover { border-color: #86efac; background: #f0fdf4; }
    .rt-alt.on { border-color: var(--tm-green); background: var(--tm-success-bg); }
    .rt-alt__bar { width: 4px; align-self: stretch; min-height: 26px; border-radius: 3px; background: #9aa5b1; flex: none; }
    .rt-alt.on .rt-alt__bar { background: #12B35B; }
    .rt-alt__txt { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
    .rt-alt__txt b { font-size: 12.5px; font-weight: 800; color: var(--tm-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rt-alt__txt small { font-size: 11px; font-weight: 700; color: var(--tm-text-muted); }
    .rt-alts__hint { margin: 2px 0 0; font-size: 10.5px; font-weight: 600; line-height: 1.35; color: var(--tm-text-muted); }
    .rt-panel { display: flex; flex-direction: column; background: var(--tm-surface); border-left: 1px solid var(--tm-line); height: 100%; min-height: 0; overflow: hidden; }
    .rt-panel__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 16px 18px; border-bottom: 1px solid var(--tm-line); }
    .rt-panel__head h2 { margin: 0; font-size: 17px; font-weight: 800; color: var(--tm-text); }
    .rt-panel__head-actions { display: inline-flex; align-items: center; gap: 8px; }
    .removed-badge { display: inline-flex; align-items: center; min-height: 28px; padding: 0 9px; border: 1px solid #fed7aa; border-radius: 999px; background: #fff7ed; color: #c2410c; font-size: 11px; font-weight: 900; white-space: nowrap; cursor: pointer; font-family: inherit; }
    .removed-badge:hover { background: #ffedd5; border-color: #fdba74; }
    .rt-panel__head p { margin: 2px 0 0; font-size: 12px; color: var(--tm-text-muted); }
    .rt-panel__body { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 18px; display: flex; flex-direction: column; gap: 13px; }
    .edit-warning { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; border: 1px solid #fde68a; border-radius: 8px; background: #fffbeb; color: #92400e; font-size: 12px; line-height: 1.4; }
    .rt-panel__foot { display: flex; justify-content: flex-end; gap: 10px; padding: 12px 18px; border-top: 1px solid var(--tm-line); }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }
    .field { display: flex; flex-direction: column; gap: 5px; }
    .field__lbl { font-size: 12px; font-weight: 700; color: var(--tm-text); }
    .field__lbl i { color: var(--tm-danger, #ef4444); font-style: normal; }
    .help { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; margin-left: 3px; border-radius: 50%; background: var(--tm-canvas-2); color: var(--tm-text-muted); font-size: 10px; font-weight: 900; cursor: help; }
    .help:hover::after { content: attr(data-tip); position: absolute; z-index: 20; left: 0; bottom: calc(100% + 8px); width: max-content; max-width: 260px; padding: 8px 10px; border-radius: 8px; background: var(--tm-ink, #111827); color: #fff; font-size: 11px; font-weight: 700; line-height: 1.35; text-align: left; white-space: normal; box-shadow: 0 10px 24px rgba(13,27,42,0.18); }
    .stops-trigger { border: 0; background: transparent; color: var(--tm-text-muted); font: inherit; font-size: 12px; padding: 2px 4px; border-radius: 5px; cursor: pointer; }
    .stops-trigger:hover, .stops-trigger[aria-expanded="true"] { background: var(--tm-canvas-2); color: var(--tm-text); }
    .stops-popover { position: fixed; z-index: 5000; width: 260px; max-width: calc(100vw - 24px); padding: 10px 12px; border-radius: 9px; background: var(--tm-ink, #111827); color: #fff; text-align: left; box-shadow: 0 14px 30px rgba(13,27,42,0.22); }
    .stops-popover__title { margin-bottom: 7px; padding-bottom: 7px; border-bottom: 1px solid rgba(255,255,255,0.16); font-size: 11px; font-weight: 900; text-transform: uppercase; letter-spacing: 0.4px; color: rgba(255,255,255,0.72); }
    .stops-popover__line { display: block; padding: 4px 0; font-size: 12px; font-weight: 700; line-height: 1.35; color: #fff; word-break: break-word; }
    .stops-popover__line + .stops-popover__line { border-top: 1px solid rgba(255,255,255,0.1); }
    .field input, .field select { width: 100%; padding: 9px 11px; border: 1px solid var(--tm-line); border-radius: 9px; background: var(--tm-canvas); color: var(--tm-text); font-size: 13px; outline: none; font-family: inherit; }
    .field input:focus, .field select:focus { border-color: var(--tm-green); }
    .seg { display: inline-flex; padding: 3px; gap: 3px; background: var(--tm-canvas-2, #eef1f5); border-radius: 9px; }
    .seg__btn { border: 0; padding: 8px 14px; border-radius: 7px; cursor: pointer; font-family: inherit; font-size: 12px; font-weight: 700; background: transparent; color: var(--tm-text-muted); }
    .seg__btn.is-on { background: var(--tm-surface, #fff); color: var(--tm-text); box-shadow: 0 1px 2px rgba(15,20,25,.12); }
    .field input.field--locked { background: var(--tm-canvas-2, #f3f4f6); color: var(--tm-text-muted); cursor: not-allowed; }
    .field input.field--locked:focus { border-color: var(--tm-line); }
    .endpoints { display: flex; flex-direction: column; gap: 8px; }
    .endpoint { display: flex; gap: 10px; padding: 10px 12px; border-radius: 12px; border: 1.5px solid var(--tm-line); background: var(--tm-canvas); }
    .endpoint.set { border-color: var(--tm-green); }
    .endpoint__dot { width: 12px; height: 12px; border-radius: 50%; margin-top: 4px; flex: none; }
    .endpoint__dot.a { background: #16a34a; } .endpoint__dot.b { background: #ef4444; }
    .endpoint__main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .endpoint__main input { width: 100%; border: 0; outline: none; background: transparent; font-size: 13.5px; font-weight: 700; color: var(--tm-text); font-family: inherit; }
    .endpoint__coord { font-size: 11px; color: var(--tm-text-muted); font-family: var(--tm-font-mono); }
    .endpoint__set { align-self: flex-start; font-size: 11px; font-weight: 700; color: var(--tm-green-deep, #15803d); background: transparent; border: 0; padding: 0; cursor: pointer; }
    .section-lbl { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; font-weight: 800; color: var(--tm-text); text-transform: uppercase; letter-spacing: 0.4px; padding-top: 6px; border-top: 1px solid var(--tm-line); margin-top: 2px; }
    .hint-inline { font-size: 10px; font-weight: 700; color: var(--tm-text-muted); text-transform: none; letter-spacing: 0; }
    .stop-guide { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; border: 1px solid var(--tm-line); border-radius: 10px; background: var(--tm-canvas); color: var(--tm-text-muted); font-size: 12px; font-weight: 750; }
    .stop-guide__btn { min-height: 36px; padding: 0 12px; border: 1px solid var(--tm-line); border-radius: 9px; background: #fff; color: var(--tm-text); font-size: 12px; font-weight: 900; cursor: pointer; font-family: inherit; }
    .stop-guide__btn.on { border-color: var(--tm-green); background: var(--tm-success-bg); color: var(--tm-success-fg); }
    .stop-guide__btn:disabled { opacity: .5; cursor: default; }
    .removed-modal { display: grid; gap: 9px; }
    .removed-modal__hint { margin: 0 0 4px; color: var(--tm-text-muted); font-size: 12px; line-height: 1.45; }
    .removed-modal__row { display: grid; grid-template-columns: 18px 1fr auto; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--tm-line); border-radius: 9px; background: var(--tm-canvas); cursor: pointer; }
    .removed-modal__row.is-selected { border-color: #38bdf8; background: #f0f9ff; }
    .removed-modal__row input { width: 16px; height: 16px; }
    .removed-modal__name { min-width: 0; color: var(--tm-text); font-size: 13px; font-weight: 850; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .removed-modal__row small { color: var(--tm-text-muted); font-family: var(--tm-font-mono); font-size: 10.5px; }
    .toggles { display: flex; flex-wrap: wrap; gap: 14px; padding-top: 6px; border-top: 1px solid var(--tm-line); }
    .toggle { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: var(--tm-text); }
    .toggle input { width: 16px; height: 16px; }
    .stop-card { display: flex; flex-direction: column; gap: 10px; padding: 12px; border: 1px solid var(--tm-line); border-radius: 10px; background: var(--tm-canvas); }
    .stop-card.is-restored { border-color: #7dd3fc; background: #f0f9ff; box-shadow: inset 3px 0 0 #0284c7; }
    .stop-card.is-paused { border-color: #fecaca; background: #fff7f7; }
    .stop-card__head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .stop-seq { font-size: 12px; font-weight: 800; color: var(--tm-text); }
    .stop-availability { display: inline-flex; align-items: center; gap: 7px; min-width: 0; }
    .stop-state { display: inline-flex; align-items: center; min-height: 24px; padding: 3px 8px; border-radius: 999px; background: var(--tm-success-bg); color: var(--tm-success-fg); font-size: 10.5px; font-weight: 900; }
    .stop-state.is-paused { background: #fee2e2; color: #b91c1c; }
    .stop-toggle { display: inline-flex; align-items: center; gap: 5px; min-height: 28px; padding: 5px 9px; border: 1px solid #fecaca; border-radius: 8px; background: #fff; color: #b91c1c; font-size: 11px; font-weight: 900; cursor: pointer; font-family: inherit; }
    .stop-toggle.is-resume { border-color: #bbf7d0; color: #15803d; }
    .stop-toggle:hover { background: var(--tm-ink); border-color: var(--tm-ink); color: #fff; }
    .stop-remove { min-height: 28px; padding: 5px 9px; border: 1px solid var(--tm-line); border-radius: 8px; background: #fff; color: #b91c1c; font-size: 11px; font-weight: 900; cursor: pointer; font-family: inherit; }
    .stop-remove:hover { background: #b91c1c; border-color: #b91c1c; color: #fff; }
    .stop-name, .stop-reason { width: 100%; padding: 9px 11px; border: 1px solid var(--tm-line); border-radius: 8px; background: var(--tm-canvas); color: var(--tm-text); font-size: 12px; outline: none; }
    .stop-flags { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .stop-chip { display: flex; align-items: center; gap: 8px; min-height: 38px; padding: 8px 10px; border: 1px solid var(--tm-line); border-radius: 8px; background: var(--tm-surface); font-size: 12px; font-weight: 600; color: var(--tm-text); }
    .stop-chip input { width: 15px; height: 15px; flex: none; }
    .route-metrics { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 9px; font-size: 12px; color: #065f46; }
    .route-metric { display: inline-flex; align-items: center; gap: 5px; }
    .micro-action-btn { display: inline-flex; align-items: center; gap: 4px; border: 1px solid #10b981; background: #fff; color: #047857; padding: 3px 8px; border-radius: 6px; font-size: 11px; font-weight: 700; cursor: pointer; }
    .micro-action-btn:hover { background: #047857; color: #fff; }
    .sec-acts { display: inline-flex; align-items: center; gap: 6px; }
    .micro-btn { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 6px; font-size: 11px; font-weight: 800; cursor: pointer; border: 1px solid var(--tm-line); background: #fff; color: var(--tm-text); }
    .micro-btn--green { border-color: #86efac; background: #f0fdf4; color: #166534; }
    .micro-btn--green:hover { background: #16a34a; color: #fff; border-color: #16a34a; }
    .micro-btn:disabled { opacity: 0.5; cursor: default; }
    .rt-tool--sparkle { border-color: #86efac; background: #f0fdf4; color: #15803d; }
    .rt-tool--sparkle:hover { background: #dcfce7; }
    .stop-add-search { display: flex; align-items: center; gap: 7px; padding: 0 10px; height: 34px; border: 1px solid var(--tm-line); border-radius: 8px; background: var(--tm-canvas); color: var(--tm-text-muted); }
    .stop-add-search input { flex: 1; border: 0; outline: none; background: transparent; font-size: 12px; color: var(--tm-text); font-family: inherit; }
    
    /* Wizard Stepper on top of map */
    .wizard-stepper { position: absolute; top: 14px; left: 14px; right: 14px; display: flex; align-items: center; justify-content: space-between; gap: 4px; padding: 6px 12px; border-radius: 12px; background: #fff; box-shadow: 0 8px 24px rgba(13,27,42,0.16); max-width: 640px; z-index: 10; }
    .wstep { display: inline-flex; align-items: center; gap: 6px; border: 0; background: transparent; cursor: pointer; padding: 4px 6px; border-radius: 8px; font-family: inherit; font-size: 11.5px; font-weight: 700; color: var(--tm-text-muted); }
    .wstep:hover { background: var(--tm-canvas-2, #eef1f5); color: var(--tm-text); }
    .wstep.is-active { background: #ecfdf5; color: #15803d; font-weight: 850; }
    .wstep.is-done .wstep__num { background: #16a34a; color: #fff; }
    .wstep__num { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 50%; background: var(--tm-canvas-2, #e2e8f0); color: var(--tm-text-muted); font-size: 10px; font-weight: 800; }
    .wstep.is-active .wstep__num { background: #15803d; color: #fff; }
    .wstep__lbl { white-space: nowrap; }
    .wstep__sep { color: var(--tm-line, #cbd5e1); font-size: 11px; font-weight: 800; }

    /* Wizard step content panels */
    .wstep-content { display: flex; flex-direction: column; gap: 14px; }
    .wstep-lead { margin-bottom: 2px; }
    .wstep-lead h3 { margin: 0 0 4px; font-size: 15px; font-weight: 800; color: var(--tm-text); }
    .wstep-lead p { margin: 0; font-size: 12px; color: var(--tm-text-muted); line-height: 1.4; }
    
    .scope-choice-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .scope-choice-card { display: flex; align-items: center; gap: 10px; padding: 12px; border: 1.5px solid var(--tm-line); border-radius: 10px; background: var(--tm-canvas); cursor: pointer; text-align: left; transition: all .15s; font-family: inherit; }
    .scope-choice-card:hover { border-color: #86efac; background: #f0fdf4; }
    .scope-choice-card.is-active { border-color: var(--tm-green, #16a34a); background: #f0fdf4; box-shadow: 0 2px 8px rgba(22,163,74,0.12); }
    .scope-choice-icon { font-size: 20px; flex: none; }
    .scope-choice-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .scope-choice-body b { font-size: 13px; font-weight: 850; color: var(--tm-text); }
    .scope-choice-body small { font-size: 11px; color: var(--tm-text-muted); }
    .outstation-cities-box { padding: 12px; border-radius: 10px; background: #fff7ed; border: 1px solid #fed7aa; }

    .wstep-tip { padding: 10px 12px; border-radius: 9px; background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534; font-size: 11.5px; line-height: 1.4; }
    
    .selected-point-box { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 10px; border: 1.5px solid #86efac; background: #f0fdf4; }
    .point-dot { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 50%; font-size: 11px; font-weight: 900; color: #fff; flex: none; }
    .point-dot.a { background: #16a34a; }
    .point-dot.b { background: #ef4444; }
    .point-details { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .point-details b { font-size: 12.5px; font-weight: 800; color: var(--tm-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .point-details small { font-size: 10.5px; font-family: var(--tm-font-mono); color: var(--tm-text-muted); }
    .text-green { color: #16a34a; }
    .location-setting-loader { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 8px; background: #f0fdf4; border: 1.5px solid #86efac; color: #166534; font-size: 12px; font-weight: 750; margin-top: 6px; animation: fadeIn .2s ease; }
    .vehicle-groups-loader { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-radius: 9px; background: #f8fafc; border: 1px solid var(--tm-line); color: var(--tm-text); font-size: 12px; font-weight: 750; margin-top: 10px; animation: fadeIn .2s ease; }
    .spinner-sm { width: 14px; height: 14px; border: 2px solid #86efac; border-top-color: #16a34a; border-radius: 50%; animation: spin 0.7s linear infinite; flex: none; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: translateY(0); } }

    /* Step 3 Stops actions & suggestions */
    .stop-search-box { position: relative; margin-bottom: 2px; }
    .search-input-wrap { position: relative; display: flex; align-items: center; width: 100%; }
    .search-input-icon { position: absolute; left: 10px; color: var(--tm-text-muted); pointer-events: none; }
    .search-input-wrap input { width: 100%; padding: 8px 30px 8px 32px; border: 1.5px solid var(--tm-line); border-radius: 8px; background: var(--tm-canvas); color: var(--tm-text); font-size: 12.5px; font-weight: 600; outline: none; transition: border-color .15s; }
    .search-input-wrap input:focus { border-color: var(--tm-green, #16a34a); background: #fff; }
    .search-clear-btn { position: absolute; right: 8px; border: none; background: #e2e8f0; color: #475569; width: 18px; height: 18px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; cursor: pointer; }
    .search-clear-btn:hover { background: #cbd5e1; color: #0f172a; }

    .stop-search-dropdown { position: absolute; top: calc(100% + 4px); left: 0; right: 0; background: #fff; border: 1.5px solid var(--tm-green, #16a34a); border-radius: 10px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.18), 0 8px 10px -6px rgba(0,0,0,0.1); z-index: 99; overflow: hidden; max-height: 280px; display: flex; flex-direction: column; }
    .search-dropdown-header { display: flex; justify-content: space-between; align-items: center; padding: 6px 12px; background: #f8fafc; border-bottom: 1px solid var(--tm-line); font-size: 11px; font-weight: 800; color: var(--tm-text-muted); text-transform: uppercase; letter-spacing: 0.03em; }
    .close-drop-btn { border: none; background: none; font-size: 12px; color: var(--tm-text-muted); cursor: pointer; padding: 0 4px; }
    .close-drop-btn:hover { color: #000; }
    .search-dropdown-list { overflow-y: auto; display: flex; flex-direction: column; }
    .search-dropdown-item { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border: none; background: transparent; text-align: left; cursor: pointer; border-bottom: 1px solid #f1f5f9; transition: background .12s; font-family: inherit; width: 100%; }
    .search-dropdown-item:last-child { border-bottom: none; }
    .search-dropdown-item:hover { background: #f0fdf4; }
    .item-icon { font-size: 14px; flex: none; }
    .item-text { display: flex; flex-direction: column; flex: 1; min-width: 0; gap: 1px; }
    .item-main { font-size: 12px; font-weight: 750; color: var(--tm-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .item-sub { font-size: 10.5px; color: var(--tm-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .item-add-tag { font-size: 10px; font-weight: 800; color: var(--tm-green, #16a34a); background: #dcfce7; padding: 2px 7px; border-radius: 6px; flex: none; }
    .search-dropdown-item:hover .item-add-tag { background: #16a34a; color: #fff; }
    .search-loading-hint { font-size: 11px; color: var(--tm-text-muted); padding: 4px 8px; font-style: italic; }

    .suggested-stops-section { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 10px; background: #f8fafc; border: 1px solid var(--tm-line); }
    .suggested-stops-head { display: flex; justify-content: space-between; align-items: center; font-size: 12px; font-weight: 800; color: var(--tm-text); }
    .count-badge { font-size: 11px; font-weight: 700; color: var(--tm-text-muted); }
    .suggested-chips-wrap { display: flex; flex-wrap: wrap; gap: 6px; max-height: 160px; overflow-y: auto; padding: 2px; }
    .suggested-stop-chip { display: inline-flex; align-items: center; gap: 6px; padding: 5px 9px; border-radius: 20px; border: 1px solid #cbd5e1; background: #fff; color: var(--tm-text); font-size: 11.5px; font-weight: 700; cursor: pointer; transition: all .15s; font-family: inherit; }
    .suggested-stop-chip:hover:not(:disabled) { border-color: var(--tm-green, #16a34a); background: #f0fdf4; color: #166534; transform: translateY(-1px); }
    .suggested-stop-chip.is-added { border-color: #86efac; background: #ecfdf5; color: #15803d; opacity: 0.75; cursor: default; }
    .chip-add-icon { display: inline-flex; align-items: center; justify-content: center; width: 15px; height: 15px; border-radius: 50%; background: #e2e8f0; font-size: 10px; font-weight: 900; color: var(--tm-text-muted); flex: none; }
    .suggested-stop-chip:hover:not(:disabled) .chip-add-icon { background: #16a34a; color: #fff; }
    .suggested-stop-chip.is-added .chip-add-icon { background: #16a34a; color: #fff; }
    .chip-stop-name { font-size: 11.5px; font-weight: 750; }
    .chip-dist-badge { font-size: 9.5px; font-weight: 700; color: var(--tm-text-muted); background: rgba(0,0,0,0.06); padding: 1px 5px; border-radius: 4px; }
    
    .stop-loc-tag { font-size: 10px; font-weight: 700; color: var(--tm-text-muted); background: #e2e8f0; padding: 1px 5px; border-radius: 4px; }
    .suggestions-loading, .suggestions-empty { font-size: 11.5px; color: var(--tm-text-muted); padding: 4px 0; }

    .stops-actions-row { display: flex; flex-wrap: wrap; gap: 8px; }
    .btn-action-primary { display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px; border-radius: 8px; border: 1px solid #86efac; background: #f0fdf4; color: #166534; font-size: 12px; font-weight: 800; cursor: pointer; font-family: inherit; }
    .btn-action-primary:hover:not(:disabled) { background: #16a34a; color: #fff; border-color: #16a34a; }
    .btn-action-primary:disabled { opacity: .5; cursor: default; }
    .btn-action-secondary { display: inline-flex; align-items: center; gap: 6px; padding: 7px 11px; border-radius: 8px; border: 1px solid var(--tm-line); background: var(--tm-canvas); color: var(--tm-text); font-size: 11.5px; font-weight: 700; cursor: pointer; font-family: inherit; }
    .btn-action-secondary.on { border-color: var(--tm-green); background: var(--tm-success-bg); color: var(--tm-success-fg); }
    .stops-list-container { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
    .stops-list-head { font-size: 12px; font-weight: 800; color: var(--tm-text); }

    /* Step 5 Chips & Drivers */
    .chips-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 8px; margin-top: 4px; }
    .chip-card { display: flex; align-items: center; gap: 8px; padding: 9px 11px; border: 1.5px solid var(--tm-line); border-radius: 9px; background: var(--tm-canvas); cursor: pointer; text-align: left; transition: all .15s; font-family: inherit; position: relative; }
    .chip-card:hover { border-color: #86efac; background: #f0fdf4; }
    .chip-card.is-selected { border-color: var(--tm-green, #16a34a); background: #f0fdf4; box-shadow: 0 1px 6px rgba(22,163,74,0.12); }
    .chip-icon { font-size: 16px; flex: none; }
    .chip-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .chip-title { font-size: 11.5px; font-weight: 800; color: var(--tm-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .chip-sub { font-size: 10px; color: var(--tm-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .chip-check { flex: none; margin-left: auto; }

    .btn-link { border: 0; background: transparent; color: var(--tm-green, #16a34a); font-size: 11.5px; font-weight: 800; cursor: pointer; padding: 0; }
    .btn-link:hover { text-decoration: underline; }
    .drivers-head-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
    .drivers-card-list { display: flex; flex-direction: column; gap: 6px; max-height: 220px; overflow-y: auto; padding: 4px; border: 1px solid var(--tm-line); border-radius: 10px; background: var(--tm-canvas); }
    .driver-card-row { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: 8px; background: var(--tm-surface); border: 1px solid transparent; cursor: pointer; transition: all .15s; }
    .driver-card-row:hover { background: var(--tm-canvas-2, #f1f5f9); }
    .driver-card-row.is-selected { border-color: #86efac; background: #f0fdf4; }
    .driver-card-row input[type="checkbox"] { width: 16px; height: 16px; flex: none; cursor: pointer; }
    .driver-avatar { width: 26px; height: 26px; border-radius: 50%; background: #e2e8f0; display: flex; align-items: center; justify-content: center; font-size: 13px; flex: none; }
    .driver-main-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .driver-name-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .driver-name { font-size: 12px; font-weight: 750; color: var(--tm-text); }
    .driver-vehicle-badge { display: inline-block; font-size: 9.5px; font-weight: 700; padding: 1px 5px; border-radius: 4px; background: #e0e7ff; color: #3730a3; }
    .driver-phone { font-size: 11px; font-family: var(--tm-font-mono); color: var(--tm-text-muted); flex: none; }

    /* Step 6 Review Card */
    .review-summary-card { display: flex; flex-direction: column; gap: 12px; padding: 14px; border-radius: 12px; border: 1.5px solid var(--tm-line); background: var(--tm-canvas); }
    .review-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; padding-bottom: 10px; border-bottom: 1px solid var(--tm-line); }
    .review-name { margin: 0 0 4px; font-size: 14px; font-weight: 850; color: var(--tm-text); }
    .scope-tag { display: inline-block; font-size: 9.5px; font-weight: 900; padding: 2px 6px; border-radius: 4px; background: #e0f2fe; color: #0369a1; letter-spacing: .3px; }
    .review-fare { text-align: right; }
    .review-fare b { font-size: 18px; font-weight: 900; color: var(--tm-green, #16a34a); font-family: var(--tm-font-mono); }
    .review-fare small { font-size: 11px; color: var(--tm-text-muted); margin-left: 2px; }
    .review-stats { display: flex; flex-wrap: wrap; gap: 10px; padding: 8px 10px; border-radius: 8px; background: #ecfdf5; border: 1px solid #a7f3d0; color: #065f46; font-size: 11.5px; font-weight: 750; }
    .review-stat { display: inline-flex; align-items: center; gap: 4px; }
    .review-itinerary { display: flex; flex-direction: column; gap: 6px; padding: 8px 0; border-bottom: 1px solid var(--tm-line); }
    .itinerary-stop { display: flex; align-items: center; gap: 8px; font-size: 12px; }
    .itinerary-stop .dot { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 50%; font-size: 9.5px; font-weight: 900; color: #fff; flex: none; }
    .itinerary-stop .dot.a { background: #16a34a; }
    .itinerary-stop .dot.b { background: #ef4444; }
    .itinerary-stop .dot.mid { background: #64748b; font-size: 8.5px; }
    .itinerary-stop .txt { color: var(--tm-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .review-meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 11.5px; }
    .meta-item { display: flex; flex-direction: column; gap: 1px; }
    .meta-label { color: var(--tm-text-muted); font-size: 10.5px; font-weight: 700; }
    .meta-val { color: var(--tm-text); font-weight: 750; }

    
    /* Step 2 Route Corridors & Waypoints */
    .route-alts-card {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 12px;
      border-radius: 12px;
      background: var(--tm-canvas, #f8fafc);
      border: 1.5px solid var(--tm-line, #e2e8f0);
      margin-top: 10px;
    }
    .route-alts-header {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .route-alts-title {
      font-size: 13px;
      font-weight: 850;
      color: var(--tm-text, #0f172a);
    }
    .route-alts-subtitle {
      font-size: 11px;
      color: var(--tm-text-muted, #64748b);
    }
    .route-alts-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .route-alt-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 12px;
      border-radius: 10px;
      background: #ffffff;
      border: 1.5px solid var(--tm-line, #e2e8f0);
      cursor: pointer;
      transition: all 0.18s ease-in-out;
    }
    .route-alt-item:hover {
      border-color: #38bdf8;
      background: #f0f9ff;
      transform: translateY(-1px);
    }
    .route-alt-item.is-selected {
      border-color: var(--tm-green, #16a34a);
      background: #f0fdf4;
      box-shadow: 0 2px 8px rgba(22, 163, 74, 0.12);
    }
    .route-alt-radio {
      display: flex;
      align-items: center;
      justify-content: center;
      flex: none;
    }
    .custom-radio-dot {
      width: 18px;
      height: 18px;
      border-radius: 50%;
      border: 2px solid #cbd5e1;
      background: #ffffff;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s;
    }
    .custom-radio-dot.is-checked {
      border-color: var(--tm-green, #16a34a);
    }
    .custom-radio-dot.is-checked::after {
      content: '';
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--tm-green, #16a34a);
    }
    .route-alt-details {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .route-alt-name-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    }
    .route-alt-name {
      font-size: 12.5px;
      font-weight: 800;
      color: var(--tm-text, #1e293b);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .route-alt-tag {
      font-size: 10px;
      font-weight: 800;
      padding: 1px 6px;
      border-radius: 20px;
      background: #dcfce7;
      color: #15803d;
      flex: none;
    }
    .route-alt-metrics-row {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 600;
      color: var(--tm-text-muted, #64748b);
    }
    .via-corridor-box {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 12px;
      border-radius: 12px;
      background: #f8fafc;
      border: 1.5px dashed #cbd5e1;
      margin-top: 10px;
    }
    .via-corridor-head {
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
    .via-corridor-title {
      font-size: 12px;
      font-weight: 800;
      color: var(--tm-text, #0f172a);
    }
    .via-corridor-hint {
      font-size: 10.5px;
      color: var(--tm-text-muted, #64748b);
    }
    .via-input-group {
      display: flex;
      gap: 6px;
    }
    .via-input-group input {
      flex: 1;
      padding: 7px 10px;
      border-radius: 8px;
      border: 1px solid var(--tm-line, #cbd5e1);
      background: #ffffff;
      font-size: 12px;
      font-family: inherit;
      color: var(--tm-text, #0f172a);
      outline: none;
    }
    .via-input-group input:focus {
      border-color: var(--tm-green, #16a34a);
      box-shadow: 0 0 0 2px rgba(22, 163, 74, 0.15);
    }
    .btn-via-apply {
      padding: 7px 12px;
      border-radius: 8px;
      border: 1px solid #86efac;
      background: #f0fdf4;
      color: #166534;
      font-size: 11.5px;
      font-weight: 800;
      cursor: pointer;
      font-family: inherit;
      white-space: nowrap;
      transition: all 0.15s;
    }
    .btn-via-apply:hover:not(:disabled) {
      background: #16a34a;
      color: #ffffff;
      border-color: #16a34a;
    }
    .btn-via-apply:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .via-chips-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      margin-top: 2px;
    }
    .via-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 8px;
      border-radius: 20px;
      background: #e0f2fe;
      color: #0369a1;
      font-size: 11px;
      font-weight: 750;
    }
    .via-chip-del {
      border: none;
      background: transparent;
      color: #0284c7;
      font-size: 14px;
      line-height: 1;
      cursor: pointer;
      padding: 0;
      display: flex;
      align-items: center;
      font-weight: 900;
    }
    .via-chip-del:hover {
      color: #b91c1c;
    }
    
    .via-suggested-towns {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-top: 4px;
      padding: 8px 10px;
      border-radius: 8px;
      background: #f1f5f9;
      border: 1px solid #e2e8f0;
    }
    .via-suggested-title {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      font-weight: 750;
      color: var(--tm-text-muted, #475569);
    }
    .via-town-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .btn-town-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 9px;
      border-radius: 16px;
      border: 1px solid #93c5fd;
      background: #eff6ff;
      color: #1d4ed8;
      font-size: 11px;
      font-weight: 750;
      cursor: pointer;
      font-family: inherit;
      transition: all 0.15s;
    }
    .btn-town-chip:hover {
      background: #1d4ed8;
      color: #ffffff;
      border-color: #1d4ed8;
      transform: translateY(-1px);
    }
    .via-search-wrap {
      position: relative;
      display: flex;
      flex-direction: column;
    }
    .via-autocomplete-dropdown {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      right: 0;
      background: #ffffff;
      border: 1.5px solid var(--tm-line, #cbd5e1);
      border-radius: 8px;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12);
      z-index: 50;
      max-height: 180px;
      overflow-y: auto;
    }
    .via-dropdown-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      cursor: pointer;
      border-bottom: 1px solid #f1f5f9;
      transition: background 0.12s;
    }
    .via-dropdown-item:last-child {
      border-bottom: none;
    }
    .via-dropdown-item:hover {
      background: #f0fdf4;
    }
    .via-item-icon {
      color: var(--tm-green, #16a34a);
      flex: none;
    }
    .via-item-info {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
    .via-item-name {
      font-size: 12px;
      font-weight: 750;
      color: var(--tm-text, #0f172a);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .via-item-sub {
      font-size: 10px;
      color: var(--tm-text-muted, #64748b);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .btn-via-reset {
      border: none;
      background: transparent;
      color: #dc2626;
      font-size: 11px;
      font-weight: 750;
      cursor: pointer;
      text-decoration: underline;
      padding: 2px 4px;
    }

    @media (max-width: 920px) { .rt-editor { grid-template-columns: 1fr; grid-template-rows: 45vh 1fr; } .rt-panel { border-left: 0; border-top: 1px solid var(--tm-line); } }
  `],
})
export class FixedRoutesComponent implements OnInit, OnDestroy {
  @Input() cityVehicleTypeId: number | null = null;
  /** Hides the page hero so the table can sit inside a host page's own section. */
  @Input() embedded = false;
  /** Hides the route table entirely, keeping only the create/edit map editor.
   *  The host renders its own route list and drives editing via openEditById(). */
  @Input() hideTable = false;
  /** Renders the map editor as a 90%-wide right-side drawer over a scrim,
   *  instead of the default full-screen takeover. */
  @Input() drawerMode = false;
  /** Fires whenever the route list is (re)loaded, so hosts can refresh counts. */
  @Output() routesChanged = new EventEmitter<void>();
  /** Fires when the map editor closes (saved or cancelled), so hosts can advance
   *  a queued flow such as reviewing several imported routes one after another. */
  @Output() editorClosed = new EventEmitter<void>();
  routes: FixedRouteRow[] = [];
  vehicleTypes: VehicleTypeOption[] = [];
  cities: CityOption[] = [];
  loading = false;
  cityId: number | null = null;
  cityName = '';
  private cityCenter: LatLng | null = null;
  private cityBoundary: LatLng[] = [];

  search = '';
  scope: RouteScope | 'all' = 'all';
  status: 'all' | 'active' | 'inactive' = 'all';

  scopeOptions = SCOPE_OPTIONS;
  scopeFilterOptions = SCOPE_OPTIONS.map((s) => ({ label: s.label, value: s.value }));
  statusFilterOptions = [{ label: 'Active', value: 'active' }, { label: 'Inactive', value: 'inactive' }];

  open = false;
  editingId: number | null = null;
  saving = false;
  tool: MapTool = 'origin';
  wizardStep: 1 | 2 | 3 | 4 | 5 | 6 = 1;
  discardConfirmOpen = false;
  saveConfirmOpen = false;
  groups: Array<{ id: number; name: string; vehicle_type_id?: number | null; route_ids: number[]; driver_user_ids: number[] }> = [];
  cityDrivers: Array<{ id: number; user_id?: number; name: string; phone?: string; city_vehicle_type_id?: number | null; vehicle_model?: string }> = [];
  clearPathConfirmOpen = false;
  stopAvailabilityConfirmOpen = false;
  stopAvailabilityConfirmMessage = '';
  removedStopsModalOpen = false;
  private pendingStopAvailabilityBody: Record<string, unknown> | null = null;
  private originalStopBookable = new Map<number, boolean>();
  private originalAssignments: string | null = null;
  private assignmentLoadVersion = 0;
  private assignmentSignature(): string {
    return JSON.stringify([this.form.assigned_group_id, this.form.new_group_name.trim(), [...this.form.assigned_driver_ids].sort((a, b) => a - b)]);
  }
  get additionalStandNames(): string {
    return this.editingId ? this.groups.filter(group => group.route_ids.includes(this.editingId!) && group.id !== this.form.assigned_group_id).map(group => group.name).join(', ') : '';
  }
  stopsPopoverRouteId: number | null = null;
  stopsPopoverLines: string[] = [];
  stopsPopoverX = 0;
  stopsPopoverY = 0;

  estimatedDistanceText = '';
  estimatedDurationText = '';
  estimatedDistanceKm = 0;
  generatingStops = false;
  suggestedStops: SuggestedStop[] = [];
  loadingSuggestedStops = false;
  stopSearchQuery = '';
  stopSearchResults: { place_id: string; main_text: string; secondary_text: string; description: string }[] = [];
  isStopSearchDropdownOpen = false;
  isSearchingStops = false;
  private stopSearchDebounceTimer: any = null;
  private autocompleteSvc: google.maps.places.AutocompleteService | null = null;
  private boundOriginEl: HTMLInputElement | null = null;
  private boundDestEl: HTMLInputElement | null = null;
  isSettingOrigin = false;
  isSettingDest = false;
  loadingVehicleGroups = false;

  get wizardStepTitle(): string {
    switch (this.wizardStep) {
      case 1: return 'Set Origin';
      case 2: return 'Set Destination';
      case 3: return 'Intermediate Stops';
      case 4: return 'Fare & Policy';
      case 5: return 'Stand & Drivers';
      case 6: return 'Review & Publish';
    }
  }

  get wizardStepHint(): string {
    switch (this.wizardStep) {
      case 1: return 'Click on the map or type in search to place the green Start marker (A).';
      case 2: return 'Click on the map or type in search to place the red Destination marker (B).';
      case 3: return 'Type landmark names to add stops, tap Auto-detect, or click along the road line.';
      case 4: return 'Configure passenger seat fare, platform commission, and luggage.';
      case 5: return 'Select vehicle type, stand, and assigned drivers.';
      case 6: return 'Review high-level map overview and finalize.';
    }
  }

  form = this.blankForm();
  removedStops: RouteStopRow[] = [];
  private selectedRemovedStopIndexes = new Set<number>();
  private restoredStopIds = new Set<number>();

  private map: google.maps.Map | null = null;
  private originMarker: google.maps.Marker | null = null;
  private destMarker: google.maps.Marker | null = null;
  private pathLine: google.maps.Polyline | null = null;
  private pathDots: google.maps.Marker[] = [];
  private stopMarkers: google.maps.Marker[] = [];
  private boundaryPoly: google.maps.Polygon | null = null;
  private mapListeners: google.maps.MapsEventListener[] = [];
  private geocoder: google.maps.Geocoder | null = null;
  private directionsSvc: google.maps.DirectionsService | null = null;
  private placesSvc: google.maps.places.PlacesService | null = null;
  private directionsDisabled = false;
  private routeSeq = 0;
  private snapSeqOrigin = 0;
  private snapSeqDest = 0;
  private geocodeSeq = 0;
  private autocomplete: google.maps.places.Autocomplete | null = null;
  private originAutocomplete: google.maps.places.Autocomplete | null = null;
  private destAutocomplete: google.maps.places.Autocomplete | null = null;
  private searchMarker: google.maps.Marker | null = null;
  private searchInfoWindow: google.maps.InfoWindow | null = null;
  private mapInitTries = 0;
  private pathLocked = false;
  roadPath: LatLng[] = [];
  /** 'road' = pick one of the real-road routes Google returns between A and B.
   *  'free' = operator draws any path; straight segments between clicked points. */
  pathMode: 'road' | 'free' = 'road';
  /** Every road route Google found between the start and the destination. */
  routeAlts: RouteAlt[] = [];
  selectedAltIdx: number | null = null;
  hoveredAltIdx: number | null = null;
  altsLoading = false;
  private altPolylines: google.maps.Polyline[] = [];
  private altSeq = 0;

  private subs: Subscription[] = [];

  constructor(
    private api: ApiService,
    private cityCtx: CityContextService,
    private toast: ToastService,
    private mapsLoader: GoogleMapsLoaderService,
    private realtime: AdminRealtimeService,
    private zone: NgZone,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.cityCtx.ensureCitiesLoaded().subscribe();
    this.subs.push(
      this.cityCtx.cityId$.subscribe((id) => {
        if (this.cityId !== id) this.pendingEditRouteId = null;
        this.cityId = id;
        this.loadVehicleTypes();
        this.loadCityMeta();
        this.fetchRoutes();
      }),
      this.cityCtx.cities$.subscribe((list) => {
        this.cities = (list || []).map((c) => ({ id: c.id, name: c.name }));
        this.cityName = list.find((c) => c.id === this.cityId)?.name ?? '';
      }),
    );
    const unsubscribeFixedCatalog = this.realtime.subscribeFixedCatalog((payload) => {
      if (this.cityId != null && payload.city_id === this.cityId) this.fetchRoutes();
    });
    this.subs.push({ unsubscribe: unsubscribeFixedCatalog } as Subscription);
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
    this.teardownMap();
  }

  get filteredRoutes(): FixedRouteRow[] {
    const q = this.search.trim().toLowerCase();
    return this.routes.filter((r) => {
      if (this.cityVehicleTypeId != null && r.city_vehicle_type_id !== this.cityVehicleTypeId) return false;
      if (this.scope !== 'all' && r.scope !== this.scope) return false;
      if (this.status !== 'all' && r.is_active !== (this.status === 'active')) return false;
      if (q) {
        const hay = `${r.name} ${r.origin_name} ${r.dest_name} ${(r.stops || []).map((s) => s.name).join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  get toolHint(): string {
    switch (this.tool) {
      case 'origin': return 'Click to set the START — it snaps to the nearest road and auto-names from the landmark.';
      case 'dest': return 'Click to set the DESTINATION — it snaps to the nearest road and auto-names from the landmark.';
      case 'path': return this.pathMode === 'free'
        ? 'Free draw: click along the map to drop points — straight lines connect them, ignoring roads. Drag any point on the line to fine-tune; right-click a point to delete it.'
        : 'Pick a route: these are the real road routes Google has between A and B. Click one on the map or in the list to use it.';
      case 'stop': return 'Click to drop a STOP — it snaps to the nearest road and auto-names from the landmark.';
      default: return 'Pick a tool, then click the map.';
    }
  }

  get endpointsSet(): boolean { return this.form.origin_lat != null && this.form.dest_lat != null; }

  commissionLabel(row: FixedRouteRow): string {
    const fc: Partial<FareConfig> = row.fare_config || {};
    const type = fc.commission_type ?? 'percent';
    if (type === 'fixed') return '₹' + Number(fc.fixed_commission ?? 0).toFixed(2);
    return Number(fc.commission_percent ?? 0).toFixed(2) + '%';
  }

  stopsTooltip(row: FixedRouteRow): string[] {
    const stops = row.stops || [];
    if (!stops.length) return ['No stops configured'];
    return stops.map((s, i) => `${i + 1}. ${s.name || 'Unnamed stop'}`);
  }

  toggleStopsPopover(row: FixedRouteRow, event: MouseEvent): void {
    event.stopPropagation();
    if (this.stopsPopoverRouteId === row.id) {
      this.hideStopsPopover();
      return;
    }

    this.stopsPopoverRouteId = row.id;
    this.stopsPopoverLines = this.stopsTooltip(row);
    this.positionStopsPopover(event);
  }

  positionStopsPopover(event: MouseEvent): void {
    this.stopsPopoverX = Math.max(12, Math.min(event.clientX - 250, window.innerWidth - 272));
    this.stopsPopoverY = Math.min(event.clientY + 12, window.innerHeight - 120);
  }

  hideStopsPopover(): void {
    this.stopsPopoverRouteId = null;
    this.stopsPopoverLines = [];
  }

  @HostListener('document:click')
  onDocumentClick(): void {
    this.hideStopsPopover();
  }

  get hasRouteDraftData(): boolean {
    const f = this.form;
    return !!(
      f.name.trim() ||
      f.origin_name.trim() ||
      f.origin_lat != null ||
      f.dest_name.trim() ||
      f.dest_lat != null ||
      f.path.length ||
      f.stops.length ||
      this.roadPath.length
    );
  }

  get formValid(): boolean {
    const f = this.form;
    if (!f.name.trim() || !f.origin_name.trim() || !f.dest_name.trim()) return false;
    if (f.origin_lat == null || f.origin_lng == null || f.dest_lat == null || f.dest_lng == null) return false;
    if (f.seat_fare == null || f.seat_fare <= 0) return false;
    if (f.scope === 'outstation' && (f.origin_city_id == null || f.dest_city_id == null)) return false;
    if (f.city_vehicle_type_id == null) return false;
    if ((!this.editingId && f.assigned_group_id == null) || (f.assigned_group_id === 'new' && !f.new_group_name.trim())) return false;
    return true;
  }

  scopeLabel(s: RouteScope | 'all'): string { return s === 'outstation' ? 'Outstation' : s === 'local' ? 'Local' : 'All scopes'; }

  blankForm() {
    return {
      scope: 'local' as RouteScope,
      origin_city_id: this.cityId,
      dest_city_id: this.cityId,
      origin_stop_id: null as number | null,
      dest_stop_id: null as number | null,
      name: '',
      origin_name: '',
      origin_lat: null as number | null,
      origin_lng: null as number | null,
      dest_name: '',
      dest_lat: null as number | null,
      dest_lng: null as number | null,
      seat_fare: null as number | null,
      commission_type: 'percent' as 'percent' | 'fixed',
      commission_percent: 20 as number | null,
      fixed_commission: null as number | null,
      city_vehicle_type_id: this.cityVehicleTypeId ?? null,
      booking_window_hours: 6,
      waiting_time_per_stop_minutes: 5,
      luggage_surcharge_amount: 0,
      max_luggage_per_vehicle: 2,
      stop_arrival_radius_m: 150,
      driver_missed_stop_grace_minutes: 3,
      customer_pickup_radius_m: 150,
      vehicle_approaching_alert_radius_m: 500,
      customer_grace_minutes: 2,
      boarding_confirmation_mode: 'driver_only' as FixedNoShowSettings['boarding_confirmation_mode'],
      is_active: true,
      sort_order: 0,
      path: [] as LatLng[],
      stops: [] as RouteStopRow[],
      assigned_group_id: null as number | 'new' | null,
      new_group_name: '',
      assigned_driver_ids: [] as number[],
    };
  }

  loadVehicleTypes(): void {
    if (this.cityId == null) { this.vehicleTypes = []; return; }
    this.api.get<{ data: any[] }>(`/admin/cities/${this.cityId}/vehicle-types`).subscribe({
      next: (res) => {
        const rawList = (res?.data || []).filter((v: any) => v.is_active !== false);

        // Exclude private on-demand vehicles; only show Fixed / Shuttle / Shared vehicles
        let list = rawList.filter((v: any) => {
          if (v.is_fixed === true) return true;
          const mode = (v.ride_type_mode || '').toLowerCase();
          if (mode === 'fixed' || mode === 'shuttle') return true;
          const rideName = (v.ride_type_name || '').toLowerCase();
          if (rideName.includes('fixed') || rideName.includes('shuttle') || rideName.includes('maxi') || rideName.includes('share')) return true;
          if (mode === 'private' || rideName.includes('private')) return false;
          return true;
        });

        if (!list.length) {
          list = rawList;
        }

        this.vehicleTypes = list.map((v: any) => ({
          id: v.id,
          display_name: v.display_name ?? v.name ?? ('#' + v.id),
          max_people: Number(v.max_people ?? 0),
          luggage_capacity: Number(v.luggage_capacity ?? 0),
        }));

        if (this.vehicleTypes.length && (!this.form.city_vehicle_type_id || !this.vehicleTypes.some((vt) => vt.id === this.form.city_vehicle_type_id))) {
          this.form.city_vehicle_type_id = this.vehicleTypes[0].id;
        }
      },
      error: () => (this.vehicleTypes = []),
    });
  }

  get availableDestCities(): CityOption[] {
    return this.cities.filter((c) => c.id !== this.form.origin_city_id);
  }

  getCityName(cityId: number | null): string {
    if (cityId == null) return '';
    return this.cities.find((c) => c.id === cityId)?.name || '';
  }

  setScope(scope: RouteScope): void {
    this.form.scope = scope;
    if (scope === 'local') {
      this.form.origin_city_id = this.cityId;
      this.form.dest_city_id = this.cityId;
    } else {
      if (this.form.origin_city_id == null) {
        this.form.origin_city_id = this.cityId;
      }
      if (this.form.dest_city_id == null || this.form.dest_city_id === this.form.origin_city_id) {
        const other = this.cities.find((c) => c.id !== this.form.origin_city_id);
        this.form.dest_city_id = other ? other.id : null;
      }
    }
    if (this.form.origin_city_id != null) {
      this.centerMapOnCity(this.form.origin_city_id);
    }
  }

  onOriginCityChange(): void {
    if (this.form.origin_city_id != null) {
      this.centerMapOnCity(this.form.origin_city_id);
    }
  }

  onDestCityChange(): void {
    if (this.form.dest_city_id != null && this.form.origin_city_id != null) {
      this.centerMapBetweenCities(this.form.origin_city_id, this.form.dest_city_id);
    }
  }

  centerMapOnCity(cityId: number): void {
    if (!this.map || this.geocoder == null) return;
    const name = this.getCityName(cityId);
    if (!name) return;
    this.geocoder.geocode({ address: name + ', India' }, (results, status) => {
      if (status === 'OK' && results?.[0]?.geometry?.location && this.map) {
        this.map.panTo(results[0].geometry.location);
        this.map.setZoom(13);
      }
    });
  }

  centerMapBetweenCities(originCityId: number, destCityId: number): void {
    if (!this.map || this.geocoder == null) return;
    const origName = this.getCityName(originCityId);
    const destName = this.getCityName(destCityId);
    if (!origName || !destName) return;

    this.geocoder.geocode({ address: origName + ', India' }, (res1, status1) => {
      if (status1 === 'OK' && res1?.[0]?.geometry?.location) {
        this.geocoder?.geocode({ address: destName + ', India' }, (res2, status2) => {
          if (status2 === 'OK' && res2?.[0]?.geometry?.location && this.map) {
            const bounds = new google.maps.LatLngBounds();
            bounds.extend(res1[0].geometry.location);
            bounds.extend(res2[0].geometry.location);
            this.map.fitBounds(bounds, { top: 60, right: 60, bottom: 60, left: 60 });
          }
        });
      }
    });
  }

  loadGroupsAndDrivers(): void {
    if (this.cityId == null) { this.groups = []; this.cityDrivers = []; return; }
    const cityId = this.cityId, editingId = this.editingId, version = ++this.assignmentLoadVersion;
    
    // 1. Fetch Route Groups for this city
    this.api.get<{ data: any[] }>(`/admin/cities/${this.cityId}/route-groups`).subscribe({
      next: (res) => {
        if (this.cityId !== cityId || this.editingId !== editingId || version !== this.assignmentLoadVersion) return;
        this.groups = (res?.data || []).map((g: any) => ({
          id: g.id,
          name: g.name,
          vehicle_type_id: g.city_vehicle_type_id ?? g.vehicle_type_id,
          route_ids: g.route_ids || [],
          driver_user_ids: g.driver_user_ids || [],
        }));
        if (editingId && this.assignmentSignature() === this.originalAssignments) {
          const assigned = this.groups.find(group => group.route_ids.includes(editingId));
          this.form.assigned_group_id = assigned?.id ?? null;
          this.form.assigned_driver_ids = [...(assigned?.driver_user_ids ?? [])];
          this.originalAssignments = this.assignmentSignature();
        }
      },
      error: () => { if (this.cityId === cityId && version === this.assignmentLoadVersion) this.groups = []; },
    });

    // 2. Fetch Drivers giving service in this city
    this.api.get<{ data: any[] }>(`/admin/cities/${this.cityId}/route-group-drivers`).subscribe({
      next: (res) => {
        if (this.cityId !== cityId || this.editingId !== editingId || version !== this.assignmentLoadVersion) return;
        const list = res?.data || [];
        if (list.length > 0) {
          this.cityDrivers = list.map((d: any) => ({
            id: d.id,
            user_id: d.user_id ?? d.id,
            name: d.name || `Driver #${d.user_id || d.id}`,
            phone: d.phone || '',
            city_vehicle_type_id: d.city_vehicle_type_id,
            vehicle_model: d.vehicle_model || d.vehicle_reg_no || '',
          }));
        } else {
          this.fetchDriversFallback();
        }
      },
      error: () => {
        if (this.cityId !== cityId || version !== this.assignmentLoadVersion) return;
        this.fetchDriversFallback();
      },
    });
  }

  private fetchDriversFallback(): void {
    if (this.cityId == null) return;
    this.api.get<{ data: any[] }>(`/admin/drivers?city_id=${this.cityId}`).subscribe({
      next: (res) => {
        this.cityDrivers = (res?.data || []).map((d: any) => ({
          id: d.id,
          user_id: d.user_id ?? d.id,
          name: d.name || d.user?.name || `Driver #${d.id}`,
          phone: d.phone || d.user?.phone || '',
          city_vehicle_type_id: d.city_vehicle_type_id,
          vehicle_model: d.vehicle_model || d.vehicle_reg_no || '',
        }));
      },
      error: () => { this.cityDrivers = []; },
    });
  }

  onGroupSelected(groupId: number | 'new' | null): void {
    if (typeof groupId === 'number') {
      const g = this.groups.find((x) => x.id === groupId);
      if (g) {
        if (g.vehicle_type_id && !this.form.city_vehicle_type_id) {
          this.form.city_vehicle_type_id = g.vehicle_type_id;
        }
        if (g.driver_user_ids?.length) {
          this.form.assigned_driver_ids = Array.from(new Set([...this.form.assigned_driver_ids, ...g.driver_user_ids]));
        }
      }
    }
  }

  get vehicleFilteredGroups(): Array<{ id: number; name: string; vehicle_type_id?: number | null; route_ids: number[]; driver_user_ids: number[] }> {
    if (!this.form.city_vehicle_type_id) return [];
    return this.groups.filter((g) => !g.vehicle_type_id || g.vehicle_type_id === this.form.city_vehicle_type_id || (!!this.editingId && g.route_ids.includes(this.editingId)));
  }

  get vehicleFilteredDrivers(): Array<{ id: number; user_id?: number; name: string; phone?: string; city_vehicle_type_id?: number | null; vehicle_model?: string }> {
    if (!this.form.city_vehicle_type_id) return [];
    const vId = this.form.city_vehicle_type_id;
    const matching = this.cityDrivers.filter((d) => d.city_vehicle_type_id === vId);
    return matching.length > 0 ? matching : this.cityDrivers;
  }

  onVehiclePicked(vehicleTypeId: number | null): void {
    if (vehicleTypeId == null) return;
    this.form.city_vehicle_type_id = vehicleTypeId;
    this.loadingVehicleGroups = true;

    const v = this.vehicleTypes.find((x) => x.id === vehicleTypeId);
    if (v && v.luggage_capacity != null) {
      this.form.max_luggage_per_vehicle = v.luggage_capacity;
    }

    if (typeof this.form.assigned_group_id === 'number') {
      const g = this.groups.find((x) => x.id === this.form.assigned_group_id);
      if (g && g.vehicle_type_id && g.vehicle_type_id !== vehicleTypeId) {
        this.form.assigned_group_id = null;
      }
    }

    setTimeout(() => {
      this.loadingVehicleGroups = false;
      const valid = this.vehicleFilteredGroups;
      if (valid.length > 0 && !this.form.assigned_group_id) {
        this.form.assigned_group_id = valid[0].id;
        this.onGroupSelected(valid[0].id);
      }
    }, 350);
  }

  async geocodeAndSetLocation(query: string, which: 'origin' | 'dest'): Promise<void> {
    const trimmed = query?.trim();
    if (!trimmed || !this.geocoder) return;
    if (which === 'origin') this.isSettingOrigin = true;
    if (which === 'dest') this.isSettingDest = true;

    return new Promise((resolve) => {
      const cityScope = which === 'origin'
        ? (this.getCityName(this.form.origin_city_id) || this.cityName)
        : ((this.form.scope === 'outstation' ? this.getCityName(this.form.dest_city_id) : null) || this.cityName);
      const searchAddress = `${trimmed}, ${cityScope}, India`;

      this.geocoder?.geocode({ address: searchAddress }, async (results, status) => {
        try {
          if (status === 'OK' && results?.[0]?.geometry?.location && this.map) {
            const loc = results[0].geometry.location;
            const lat = loc.lat();
            const lng = loc.lng();
            const landmarkName = this.bestGeocodeStopName(results) || results[0].formatted_address.split(',')[0].trim() || trimmed;

            if (which === 'origin') {
              this.form.origin_name = landmarkName;
              this.map.panTo(loc);
              this.map.setZoom(16);
              await this.setOrigin(lat, lng, false);
              this.toast.success(`Start point placed at "${landmarkName}"`);
            } else {
              this.form.dest_name = landmarkName;
              this.map.panTo(loc);
              await this.setDest(lat, lng, false);
              this.toast.success(`Destination placed at "${landmarkName}"`);
            }
          } else {
            this.toast.error(`Could not locate "${trimmed}". Please tap on the map.`);
          }
        } finally {
          if (which === 'origin') this.isSettingOrigin = false;
          if (which === 'dest') this.isSettingDest = false;
          resolve();
        }
      });
    });
  }

  async onOriginSearchEnter(event?: Event): Promise<void> {
    if (event) event.preventDefault();
    const query = this.form.origin_name.trim();
    if (!query) return;
    await this.geocodeAndSetLocation(query, 'origin');
  }

  onOriginSearchBlur(): void {
    const query = this.form.origin_name.trim();
    if (!query || this.form.origin_lat != null || this.isSettingOrigin) return;
    void this.geocodeAndSetLocation(query, 'origin');
  }

  async onDestSearchEnter(event?: Event): Promise<void> {
    if (event) event.preventDefault();
    const query = this.form.dest_name.trim();
    if (!query) return;
    await this.geocodeAndSetLocation(query, 'dest');
  }

  onDestSearchBlur(): void {
    const query = this.form.dest_name.trim();
    if (!query || this.form.dest_lat != null || this.isSettingDest) return;
    void this.geocodeAndSetLocation(query, 'dest');
  }

  maybeAutoName(): void {
    const orig = this.cleanStopName(this.form.origin_name) || this.form.origin_name.trim();
    const dest = this.cleanStopName(this.form.dest_name) || this.form.dest_name.trim();
    if (orig && dest) {
      this.form.name = `${orig} → ${dest}`;
    } else if (orig && !this.form.name.trim()) {
      this.form.name = `${orig} Route`;
    }
  }

  getVehicleDisplayName(id: number | null): string {
    if (id == null) return 'Not assigned';
    const v = this.vehicleTypes.find((x) => x.id === id);
    return v ? `${v.display_name} (${v.max_people} seats)` : `#${id}`;
  }

  getGroupDisplayName(): string {
    if (this.editingId && this.assignmentSignature() === this.originalAssignments) {
      return this.groups.filter(group => group.route_ids.includes(this.editingId!)).map(group => group.name).join(', ') || 'No stand (Independent Route)';
    }
    if (this.form.assigned_group_id === 'new') {
      return `New Stand: "${this.form.new_group_name.trim() || 'Untitled'}"`;
    }
    if (typeof this.form.assigned_group_id === 'number') {
      const g = this.groups.find((x) => x.id === this.form.assigned_group_id);
      return g ? g.name : `#${this.form.assigned_group_id}`;
    }
    return 'No stand (Independent Route)';
  }

  toggleDriverAssignment(driverId: number): void {
    const idx = this.form.assigned_driver_ids.indexOf(driverId);
    if (idx >= 0) {
      this.form.assigned_driver_ids.splice(idx, 1);
    } else {
      this.form.assigned_driver_ids.push(driverId);
    }
  }

  toggleSelectAllDrivers(): void {
    if (this.form.assigned_driver_ids.length === this.cityDrivers.length) {
      this.form.assigned_driver_ids = [];
    } else {
      this.form.assigned_driver_ids = this.cityDrivers.map((d) => d.user_id || d.id);
    }
  }

  isStopAlreadyAdded(name: string): boolean {
    const norm = this.cleanStopName(name).toLowerCase();
    return this.form.stops.some((s) => this.cleanStopName(s.name).toLowerCase() === norm);
  }

  addSuggestedStop(suggested: SuggestedStop): void {
    if (this.isStopAlreadyAdded(suggested.name)) {
      this.toast.error(`Stop "${suggested.name}" is already in your stops list.`);
      return;
    }
    const stop: RouteStopRow = {
      name: suggested.name,
      lat: suggested.lat,
      lng: suggested.lng,
      is_pickup: true,
      is_drop: true,
      is_active: true,
      is_temporarily_unavailable: false,
      unavailable_reason: null,
    };
    this.insertStopInRouteOrder(stop);
    suggested.added = true;
    this.toast.success(`Added stop "${suggested.name}" (${suggested.distanceFromStartKm} km from start)`);
  }

  insertStopInRouteOrder(stop: RouteStopRow): void {
    if (stop.lat == null || stop.lng == null) {
      this.form.stops.push(stop);
      this.redrawStops();
      return;
    }
    const distKm = this.calculateDistanceFromOriginKm({ lat: stop.lat, lng: stop.lng });
    let inserted = false;
    for (let i = 0; i < this.form.stops.length; i++) {
      const s = this.form.stops[i];
      if (s.lat != null && s.lng != null) {
        const sDist = this.calculateDistanceFromOriginKm({ lat: s.lat, lng: s.lng });
        if (distKm < sDist) {
          this.form.stops.splice(i, 0, stop);
          inserted = true;
          break;
        }
      }
    }
    if (!inserted) {
      this.form.stops.push(stop);
    }
    this.redrawStops();
  }

  onStopSearchFocus(): void {
    if (this.stopSearchResults.length > 0) {
      this.isStopSearchDropdownOpen = true;
    }
  }

  onStopSearchBlur(): void {
    setTimeout(() => {
      this.isStopSearchDropdownOpen = false;
    }, 250);
  }

  clearStopSearch(): void {
    this.stopSearchQuery = '';
    this.stopSearchResults = [];
    this.isStopSearchDropdownOpen = false;
    this.isSearchingStops = false;
  }

  onStopSearchInput(query: string): void {
    if (this.stopSearchDebounceTimer) {
      clearTimeout(this.stopSearchDebounceTimer);
    }

    const trimmed = (query || '').trim();
    if (!trimmed || trimmed.length < 2) {
      this.stopSearchResults = [];
      this.isStopSearchDropdownOpen = false;
      this.isSearchingStops = false;
      return;
    }

    this.stopSearchDebounceTimer = setTimeout(() => {
      this.fetchStopPredictions(trimmed);
    }, 200);
  }

  private fetchStopPredictions(query: string): void {
    if (!this.autocompleteSvc && typeof google !== 'undefined' && google.maps?.places) {
      this.autocompleteSvc = new google.maps.places.AutocompleteService();
    }
    if (!this.autocompleteSvc) return;

    this.isSearchingStops = true;
    const bounds = this.map ? this.map.getBounds() : undefined;

    this.autocompleteSvc.getPlacePredictions(
      {
        input: query,
        bounds: bounds || undefined,
        componentRestrictions: { country: 'in' },
      },
      (predictions, status) => {
        this.isSearchingStops = false;
        if (status === google.maps.places.PlacesServiceStatus.OK && predictions?.length) {
          this.stopSearchResults = predictions
            .map((p) => ({
              place_id: p.place_id,
              main_text: p.structured_formatting?.main_text || p.description.split(',')[0],
              secondary_text: p.structured_formatting?.secondary_text || p.description.split(',').slice(1).join(','),
              description: p.description,
            }))
            .filter((p) => !this.isBadStopName(p.main_text));

          this.isStopSearchDropdownOpen = this.stopSearchResults.length > 0;
        } else {
          this.fallbackPlacesSearch(query);
        }
      }
    );
  }

  private fallbackPlacesSearch(query: string): void {
    if (!this.placesSvc || !this.map) {
      this.stopSearchResults = [];
      this.isStopSearchDropdownOpen = false;
      return;
    }

    this.placesSvc.textSearch(
      {
        query,
        bounds: this.map.getBounds() || undefined,
      },
      (results, status) => {
        if (status === google.maps.places.PlacesServiceStatus.OK && results?.length) {
          this.stopSearchResults = results
            .filter((r) => !this.isCommercialRetailPlace(r))
            .slice(0, 6)
            .map((r) => ({
              place_id: r.place_id || '',
              main_text: this.extractLegitimateLocationName(r),
              secondary_text: (r.formatted_address || '').split(',').slice(1, 3).join(','),
              description: r.formatted_address || r.name || '',
            }))
            .filter((p) => p.main_text && !this.isBadStopName(p.main_text));

          this.isStopSearchDropdownOpen = this.stopSearchResults.length > 0;
        } else {
          this.stopSearchResults = [];
          this.isStopSearchDropdownOpen = false;
        }
      }
    );
  }

  selectStopSearchResult(item: { place_id: string; main_text: string; secondary_text: string; description: string }): void {
    if (!item.place_id && item.main_text) {
      this.addStopByNameAndQuery(item.main_text);
      this.clearStopSearch();
      return;
    }

    if (!this.placesSvc) return;

    this.placesSvc.getDetails(
      {
        placeId: item.place_id,
        fields: ['geometry', 'name', 'formatted_address', 'address_components', 'types'],
      },
      (place, status) => {
        if (status === google.maps.places.PlacesServiceStatus.OK && place?.geometry?.location) {
          const lat = place.geometry.location.lat();
          const lng = place.geometry.location.lng();
          const locationName = this.extractLegitimateLocationName(place);
          const roadPoint = this.snapToRoutePath({ lat, lng });

          const stop: RouteStopRow = {
            name: locationName,
            lat: roadPoint.lat,
            lng: roadPoint.lng,
            is_pickup: true,
            is_drop: true,
            is_active: true,
            is_temporarily_unavailable: false,
            unavailable_reason: null,
          };

          this.insertStopInRouteOrder(stop);
          this.clearStopSearch();
          this.toast.success(`Added stop "${locationName}"`);
        } else {
          this.addStopByNameAndQuery(item.main_text);
          this.clearStopSearch();
        }
      }
    );
  }

  onStopSearchEnter(): void {
    if (this.stopSearchResults.length > 0) {
      this.selectStopSearchResult(this.stopSearchResults[0]);
    } else if (this.stopSearchQuery.trim()) {
      this.addStopByNameAndQuery(this.stopSearchQuery.trim());
      this.clearStopSearch();
    }
  }

  private addStopByNameAndQuery(query: string): void {
    if (!this.geocoder) return;
    this.geocoder.geocode(
      { address: query, bounds: this.map?.getBounds() || undefined, componentRestrictions: { country: 'in' } },
      (results, status) => {
        if (status === 'OK' && results && results[0]?.geometry?.location) {
          const loc = results[0].geometry.location;
          const name = this.bestGeocodeStopName(results) || this.cleanStopName(query);
          const roadPt = this.snapToRoutePath({ lat: loc.lat(), lng: loc.lng() });
          const stop: RouteStopRow = {
            name,
            lat: roadPt.lat,
            lng: roadPt.lng,
            is_pickup: true,
            is_drop: true,
            is_active: true,
            is_temporarily_unavailable: false,
            unavailable_reason: null,
          };
          this.insertStopInRouteOrder(stop);
          this.toast.success(`Added stop "${name}"`);
        } else {
          this.toast.error(`Could not locate "${query}". Try picking a suggested stop or clicking the map.`);
        }
      }
    );
  }

  calculateDistanceFromOriginKm(point: LatLng): number {
    if (this.form.origin_lat == null || this.form.origin_lng == null) return 0;
    if (!this.roadPath || !this.roadPath.length) {
      return Number((this.distanceMeters(this.form.origin_lat, this.form.origin_lng, point.lat, point.lng) / 1000).toFixed(1));
    }
    let bestIdx = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.roadPath.length; i++) {
      const d = this.distanceMeters(point.lat, point.lng, this.roadPath[i].lat, this.roadPath[i].lng);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    let sumM = 0;
    for (let i = 1; i <= bestIdx; i++) {
      sumM += this.distanceMeters(this.roadPath[i - 1].lat, this.roadPath[i - 1].lng, this.roadPath[i].lat, this.roadPath[i].lng);
    }
    return Number((sumM / 1000).toFixed(1));
  }

  detectSuggestedStops(): void {
    if (!this.roadPath || this.roadPath.length < 2 || !this.map) return;
    this.loadingSuggestedStops = true;
    this.suggestedStops = [];

    const totalLength = this.roadPath.length;
    const sampleCount = Math.min(12, Math.max(3, Math.floor(totalLength / 25)));
    const step = Math.max(1, Math.floor(totalLength / (sampleCount + 1)));

    const samplePoints: LatLng[] = [];
    for (let i = step; i < totalLength - 1; i += step) {
      samplePoints.push(this.roadPath[i]);
    }

    const collected: SuggestedStop[] = [];
    const seenNames = new Set<string>();

    if (this.form.origin_name) seenNames.add(this.cleanStopName(this.form.origin_name).toLowerCase());
    if (this.form.dest_name) seenNames.add(this.cleanStopName(this.form.dest_name).toLowerCase());
    this.form.stops.forEach((s) => {
      if (s.name) seenNames.add(this.cleanStopName(s.name).toLowerCase());
    });

    let pending = samplePoints.length;
    if (pending === 0) {
      this.loadingSuggestedStops = false;
      return;
    }

    const finish = () => {
      pending--;
      if (pending <= 0) {
        this.loadingSuggestedStops = false;
        this.suggestedStops = collected.sort((a, b) => a.distanceFromStartKm - b.distanceFromStartKm);
      }
    };

    samplePoints.forEach((pt) => {
      if (this.placesSvc && typeof google !== 'undefined' && google.maps?.places) {
        this.placesSvc.nearbySearch(
          {
            location: new google.maps.LatLng(pt.lat, pt.lng),
            radius: 350,
            type: 'transit_station' as any,
          },
          (places, status) => {
            let foundTransit = false;
            if (status === google.maps.places.PlacesServiceStatus.OK && places?.length) {
              for (const p of places) {
                const name = this.cleanStopName(p.name || '');
                const norm = name.toLowerCase();
                if (name && !this.isBadStopName(name) && !seenNames.has(norm) && p.geometry?.location) {
                  seenNames.add(norm);
                  const loc = p.geometry.location;
                  const roadPt = this.snapToRoutePath({ lat: loc.lat(), lng: loc.lng() });
                  const distKm = this.calculateDistanceFromOriginKm(roadPt);
                  collected.push({
                    name,
                    lat: roadPt.lat,
                    lng: roadPt.lng,
                    distanceFromStartKm: distKm,
                    type: 'transit',
                    added: this.form.stops.some((s) => this.cleanStopName(s.name).toLowerCase() === norm),
                  });
                  foundTransit = true;
                  break;
                }
              }
            }

            if (!foundTransit) {
              this.geocoder?.geocode({ location: { lat: pt.lat, lng: pt.lng } }, (results, gStatus) => {
                if (gStatus === 'OK' && results?.length) {
                  const stopName = this.bestGeocodeStopName(results);
                  const norm = stopName.toLowerCase();
                  if (stopName && !this.isBadStopName(stopName) && !seenNames.has(norm)) {
                    seenNames.add(norm);
                    const roadPt = this.snapToRoutePath(pt);
                    const distKm = this.calculateDistanceFromOriginKm(roadPt);
                    collected.push({
                      name: stopName,
                      lat: roadPt.lat,
                      lng: roadPt.lng,
                      distanceFromStartKm: distKm,
                      type: 'junction',
                      added: this.form.stops.some((s) => this.cleanStopName(s.name).toLowerCase() === norm),
                    });
                  }
                }
                finish();
              });
            } else {
              finish();
            }
          }
        );
      } else {
        finish();
      }
    });
  }

  private isCommercialRetailPlace(place: google.maps.places.PlaceResult | any): boolean {
    if (!place) return false;
    const types: string[] = place.types || [];

    // Transit, Civic & Landmark types that are genuine stop points:
    const allowedCivicTypes = [
      'transit_station', 'bus_station', 'train_station', 'subway_station', 'light_rail_station', 'airport',
      'intersection', 'neighborhood', 'sublocality', 'sublocality_level_1', 'sublocality_level_2',
      'locality', 'administrative_area_level_2', 'administrative_area_level_1', 'route',
      'colloquial_area', 'natural_feature', 'park', 'hospital', 'university', 'school',
      'local_government_office', 'city_hall', 'courthouse', 'police'
    ];
    if (types.some((t) => allowedCivicTypes.includes(t))) return false;

    // Commercial Retail & Business types that must be stripped:
    const retailTypes = [
      'store', 'clothing_store', 'convenience_store', 'department_store', 'electronics_store',
      'furniture_store', 'hardware_store', 'home_goods_store', 'jewelry_store', 'liquor_store',
      'pet_store', 'shoe_store', 'shopping_mall', 'supermarket', 'bakery', 'cafe', 'restaurant',
      'food', 'meal_takeaway', 'meal_delivery', 'bar', 'night_club', 'beauty_salon', 'hair_care',
      'spa', 'car_dealer', 'car_repair', 'car_wash', 'gas_station', 'bank', 'atm', 'finance',
      'insurance_agency', 'real_estate_agency', 'travel_agency', 'accounting', 'dentist', 'doctor',
      'pharmacy', 'health', 'physiotherapist', 'gym', 'lodging', 'laundry', 'veterinary_care',
      'establishment', 'point_of_interest'
    ];

    if (types.some((t) => retailTypes.includes(t))) {
      return true;
    }

    if (place.name && this.isBadStopName(place.name)) {
      return true;
    }

    return false;
  }

  extractLegitimateLocationName(place: google.maps.places.PlaceResult | any): string {
    if (!place) return 'Route Stop';
    const isCommercial = this.isCommercialRetailPlace(place);
    const rawName = place.name ? this.cleanStopName(place.name) : '';

    // If it is NOT a commercial retail store and passes the stop name quality filter:
    if (!isCommercial && rawName && !this.isBadStopName(rawName)) {
      return rawName;
    }

    // Otherwise (if it IS a commercial shop/retail), ALWAYS extract the true sublocality, chowk, junction, or town:
    if (place.address_components && Array.isArray(place.address_components)) {
      // 1. Sublocality / Neighborhood (e.g., "Batamaloo", "Nowgam", "Sangrama", "Narbal", "Mirgund")
      const subloc = place.address_components.find((c: any) =>
        c.types.includes('sublocality_level_1') || c.types.includes('sublocality') || c.types.includes('neighborhood')
      );
      if (subloc?.long_name && !this.isBadStopName(subloc.long_name)) {
        return this.cleanStopName(subloc.long_name);
      }

      // 2. Intersection or Route / Chowk
      const routeComp = place.address_components.find((c: any) => c.types.includes('intersection') || c.types.includes('route'));
      if (routeComp?.long_name && !this.isBadStopName(routeComp.long_name)) {
        return this.cleanStopName(routeComp.long_name);
      }

      // 3. Locality / Town (e.g., "Sopore", "Pattan", "Baramulla", "Srinagar")
      const loc = place.address_components.find((c: any) => c.types.includes('locality'));
      if (loc?.long_name && !this.isBadStopName(loc.long_name)) {
        return this.cleanStopName(loc.long_name);
      }
    }

    // Fallback: Parse formatted_address parts to find the first non-commercial civic location
    if (place.formatted_address) {
      const parts = place.formatted_address
        .split(',')
        .map((p: string) => this.cleanStopName(p))
        .filter((p: string) => p && !this.isBadStopName(p) && !/^\d{5,6}$/.test(p) && !/^india$/i.test(p));
      if (parts.length > 0) {
        return parts[0];
      }
    }

    return rawName && !this.isBadStopName(rawName) ? rawName : 'Corridor Stop';
  }

  goToStep(step: 1 | 2 | 3 | 4 | 5 | 6): void {
    if (step === 2) {
      if (this.form.scope === 'outstation' && !this.form.dest_city_id) {
        this.toast.error('Please select a destination city for this outstation route.');
        return;
      }
      if (!this.form.origin_lat) {
        this.toast.error('Please set an origin location first.');
        return;
      }
    }
    if (step === 3 && !this.form.dest_lat) {
      this.toast.error('Please set a destination location first.');
      return;
    }
    if (step === 5 && (!this.form.name.trim() || this.form.seat_fare == null)) {
      this.toast.error('Please fill in route name and fare.');
      return;
    }
    if (step === 6) {
      if (!this.form.city_vehicle_type_id) {
        this.toast.error('Please select a vehicle model.');
        return;
      }
      if ((!this.editingId && this.form.assigned_group_id == null) || (this.form.assigned_group_id === 'new' && !this.form.new_group_name.trim())) {
        this.toast.error('Please select a stand or create a new stand.');
        return;
      }
    }
    this.wizardStep = step;
    if (step === 1) {
      this.setTool('origin');
      setTimeout(() => this.fitOriginView(), 60);
    } else if (step === 2) {
      this.setTool('dest');
      if (this.form.origin_lat != null && this.form.dest_lat != null) {
        setTimeout(() => this.fitRouteViewport(), 80);
      } else {
        setTimeout(() => this.fitOriginView(), 60);
      }
    } else if (step === 3) {
      this.setTool('stop');
      this.clearStopSearch();
      if (!this.suggestedStops.length) {
        this.detectSuggestedStops();
      }
      setTimeout(() => this.fitRouteViewport(), 80);
    } else if (step === 4 || step === 5 || step === 6) {
      if (step === 6) this.tool = 'path';
      setTimeout(() => this.fitRouteViewport(), 80);
    }
    setTimeout(() => this.setupWizardAutocompletes(), 120);
  }

  nextStep(): void {
    if (this.wizardStep < 6) {
      this.goToStep((this.wizardStep + 1) as any);
    }
  }

  prevStep(): void {
    if (this.wizardStep > 1) {
      this.goToStep((this.wizardStep - 1) as any);
    }
  }

  promptCloseEditor(): void {
    if (this.hasRouteDraftData) {
      this.discardConfirmOpen = true;
    } else {
      this.forceCloseEditor();
    }
  }

  forceCloseEditor(): void {
    this.discardConfirmOpen = false;
    this.saveConfirmOpen = false;
    this.closeEditor();
  }

  promptSave(): void {
    if (!this.formValid) {
      this.toast.error('Please complete all required fields before saving.');
      return;
    }
    this.saveConfirmOpen = true;
  }

  confirmSave(): void {
    this.saveConfirmOpen = false;
    this.submit();
  }

  fitOverviewMap(): void {
    if (!this.map || typeof google === 'undefined' || !google.maps) return;
    const bounds = new google.maps.LatLngBounds();
    let count = 0;
    if (this.form.origin_lat != null && this.form.origin_lng != null) {
      bounds.extend({ lat: this.form.origin_lat, lng: this.form.origin_lng });
      count++;
    }
    if (this.form.dest_lat != null && this.form.dest_lng != null) {
      bounds.extend({ lat: this.form.dest_lat, lng: this.form.dest_lng });
      count++;
    }
    for (const s of this.form.stops) {
      if (s.lat != null && s.lng != null) {
        bounds.extend({ lat: s.lat, lng: s.lng });
        count++;
      }
    }
    if (count > 0) {
      this.map.fitBounds(bounds, { top: 60, right: 60, bottom: 60, left: 60 });
    }
  }

  loadCityMeta(): void {
    this.cityCenter = null;
    this.cityBoundary = [];
    if (this.cityId == null) return;
    this.api.get<any>(`/admin/cities/${this.cityId}`).subscribe({
      next: (res) => {
        const c = res?.city ?? res ?? {};
        if (c.center_lat != null && c.center_lng != null) this.cityCenter = { lat: +c.center_lat, lng: +c.center_lng };
        const poly = c.boundary_polygon;
        this.cityBoundary = Array.isArray(poly) ? poly.map((p: any) => ({ lat: +(p.lat ?? p[0]), lng: +(p.lng ?? p[1]) })).filter((p: LatLng) => !isNaN(p.lat) && !isNaN(p.lng)) : [];
      },
      error: () => {},
    });
  }

  fetchRoutes(): void {
    const cityId = this.cityId;
    if (cityId == null) { this.routes = []; this.pendingEditRouteId = null; return; }
    this.loading = true;
    this.api.get<{ data: FixedRouteRow[] }>(`/admin/cities/${cityId}/fixed-routes`).subscribe({
      next: (res) => {
        if (this.cityId !== cityId) return;
        this.routes = res?.data || []; this.loading = false; this.routesChanged.emit();
        const pendingId = this.pendingEditRouteId;
        this.pendingEditRouteId = null;
        if (pendingId !== null) this.openEditById(pendingId);
      },
      error: (err) => { if (this.cityId !== cityId) return; this.pendingEditRouteId = null; this.loading = false; this.toast.error(err?.error?.message || 'Failed to load fixed routes'); },
    });
  }

  openCreate(): void {
    this.originalAssignments = null;
    this.pendingEditRouteId = null;
    this.editingId = null;
    this.originalStopBookable.clear();
    this.removedStops = [];
    this.selectedRemovedStopIndexes.clear();
    this.restoredStopIds.clear();
    this.removedStopsModalOpen = false;
    this.discardConfirmOpen = false;
    this.saveConfirmOpen = false;
    this.form = this.blankForm();
    this.roadPath = [];
    this.pathLocked = false;
    this.pathMode = 'road';
    this.clearAlternatives();
    this.directionsDisabled = false;
    this.estimatedDistanceText = '';
    this.estimatedDurationText = '';
    this.estimatedDistanceKm = 0;
    this.generatingStops = false;
    this.wizardStep = 1;
    this.tool = 'origin';
    this.open = true;
    this.loadGroupsAndDrivers();
    this.scheduleMapInit();
  }

  /** Open the map editor for a route by id — the host list only has a lite row. */
  private pendingEditRouteId: number | null = null;
  openEditById(id: number): void {
    const row = this.routes.find((r) => r.id === id);
    if (row) { this.pendingEditRouteId = null; this.openEdit(row); }
    else if (this.loading) this.pendingEditRouteId = id;
  }

  openEdit(r: FixedRouteRow): void {
    this.editingId = r.id;
    this.selectedRemovedStopIndexes.clear();
    this.restoredStopIds.clear();
    this.removedStopsModalOpen = false;
    this.discardConfirmOpen = false;
    this.saveConfirmOpen = false;
    this.originalStopBookable = new Map((r.stops || []).map((stop) => [Number(stop.id), this.isStopBookable(stop)]));
    const fc = r.fare_config || ({ seat_fare: null, commission_percent: null, fixed_commission: null } as FareConfig);
    const ns = r.fixed_settings_json || {};
    this.form = {
      scope: r.scope,
      origin_city_id: r.origin_city_id,
      dest_city_id: r.dest_city_id,
      origin_stop_id: r.stops?.[0]?.id ?? null,
      dest_stop_id: r.stops?.[r.stops.length - 1]?.id ?? null,
      name: r.name,
      origin_name: r.origin_name,
      origin_lat: r.origin_lat,
      origin_lng: r.origin_lng,
      dest_name: r.dest_name,
      dest_lat: r.dest_lat,
      dest_lng: r.dest_lng,
      seat_fare: fc.seat_fare ?? r.flat_fare,
      commission_type: (fc.commission_type ?? 'percent') as 'percent' | 'fixed',
      commission_percent: fc.commission_percent ?? null,
      fixed_commission: fc.fixed_commission ?? null,
      city_vehicle_type_id: r.city_vehicle_type_id,
      booking_window_hours: r.booking_window_hours,
      waiting_time_per_stop_minutes: r.waiting_time_per_stop_minutes,
      luggage_surcharge_amount: r.luggage_surcharge_amount,
      max_luggage_per_vehicle: r.max_luggage_per_vehicle ?? 0,
      stop_arrival_radius_m: Number(ns.stop_arrival_radius_m ?? 150),
      driver_missed_stop_grace_minutes: Number(ns.driver_missed_stop_grace_minutes ?? 3),
      customer_pickup_radius_m: Number(ns.customer_pickup_radius_m ?? 150),
      vehicle_approaching_alert_radius_m: Number(ns.vehicle_approaching_alert_radius_m ?? 500),
      customer_grace_minutes: Number(ns.customer_grace_minutes ?? 2),
      boarding_confirmation_mode: (ns.boarding_confirmation_mode ?? 'driver_only') as FixedNoShowSettings['boarding_confirmation_mode'],
      is_active: r.is_active,
      sort_order: r.sort_order,
      path: [],
      stops: (r.stops || []).slice(1, -1).filter((s) => !this.isRemovedStop(s)).map((s) => ({ ...s })),
      assigned_group_id: null,
      new_group_name: '',
      assigned_driver_ids: [],
    };
    this.removedStops = (r.stops || []).slice(1, -1).filter((s) => this.isRemovedStop(s)).map((s) => ({ ...s }));
    this.originalAssignments = this.assignmentSignature();
    this.roadPath = (r.path_polyline || []).map((p) => ({ lat: p[0], lng: p[1] }));
    this.computePathDistance();
    this.pathLocked = this.roadPath.length > 0;
    this.pathMode = 'road';
    this.clearAlternatives();
    this.directionsDisabled = false;
    this.wizardStep = 1;
    this.tool = 'origin';
    this.open = true;
    this.loadGroupsAndDrivers();
    this.scheduleMapInit();
  }

  closeEditor(): void {
    this.assignmentLoadVersion++;
    this.open = false;
    this.discardConfirmOpen = false;
    this.saveConfirmOpen = false;
    this.removedStopsModalOpen = false;
    this.selectedRemovedStopIndexes.clear();
    this.teardownMap();
    this.editorClosed.emit();
  }

  /** Open the editor pre-filled from a Google My Maps import for review.
   *
   *  - Create (asUpdate = false): a brand-new route (editingId = null); fare,
   *    vehicle and stops are left for the admin to complete.
   *  - Update (asUpdate = true) when the draft matched a same-name route: the
   *    existing route's fare / vehicle / settings are pre-filled and preserved,
   *    while the LINE and STOPS are replaced from My Maps. Saving PATCHes the
   *    existing route (stops without ids are re-created; old ones are retired).
   *  Nothing is saved until the admin hits Save/Create. */
  openImported(draft: ImportedRouteDraft, asUpdate = false): void {
    const existing = asUpdate && draft.existing_route_id ? draft.existing ?? null : null;
    this.editingId = existing ? draft.existing_route_id ?? null : null;
    this.originalStopBookable.clear();
    this.removedStops = [];
    this.selectedRemovedStopIndexes.clear();
    this.restoredStopIds.clear();
    this.removedStopsModalOpen = false;

    if (existing) {
      // Preserve the existing route's fare / vehicle / settings; the geometry
      // (name, from/to, line, stops) is overwritten from the draft below.
      const fc = existing.fare_config || ({ seat_fare: null, commission_percent: null, fixed_commission: null } as FareConfig);
      const ns = existing.fixed_settings_json || {};
      this.form = {
        ...this.blankForm(),
        scope: existing.scope,
        origin_city_id: existing.origin_city_id,
        dest_city_id: existing.dest_city_id,
        seat_fare: fc.seat_fare ?? existing.flat_fare,
        commission_type: (fc.commission_type ?? 'percent') as 'percent' | 'fixed',
        commission_percent: fc.commission_percent ?? null,
        fixed_commission: fc.fixed_commission ?? null,
        city_vehicle_type_id: existing.city_vehicle_type_id,
        booking_window_hours: existing.booking_window_hours,
        waiting_time_per_stop_minutes: existing.waiting_time_per_stop_minutes,
        luggage_surcharge_amount: existing.luggage_surcharge_amount,
        max_luggage_per_vehicle: existing.max_luggage_per_vehicle ?? 0,
        stop_arrival_radius_m: Number(ns.stop_arrival_radius_m ?? 150),
        driver_missed_stop_grace_minutes: Number(ns.driver_missed_stop_grace_minutes ?? 3),
        customer_pickup_radius_m: Number(ns.customer_pickup_radius_m ?? 150),
        vehicle_approaching_alert_radius_m: Number(ns.vehicle_approaching_alert_radius_m ?? 500),
        customer_grace_minutes: Number(ns.customer_grace_minutes ?? 2),
        boarding_confirmation_mode: (ns.boarding_confirmation_mode ?? 'driver_only') as FixedNoShowSettings['boarding_confirmation_mode'],
        is_active: existing.is_active,
        sort_order: existing.sort_order,
      };
    } else {
      this.form = this.blankForm();
    }

    // Geometry always comes from the My Maps draft. Null the origin/dest stop ids
    // so the stops are re-created fresh (old ones are retired by the backend).
    this.form.origin_stop_id = null;
    this.form.dest_stop_id = null;
    this.form.name = draft.name || (existing?.name ?? '');
    this.form.origin_name = draft.origin_name || '';
    this.form.origin_lat = draft.origin_lat;
    this.form.origin_lng = draft.origin_lng;
    this.form.dest_name = draft.dest_name || '';
    this.form.dest_lat = draft.dest_lat;
    this.form.dest_lng = draft.dest_lng;
    this.form.stops = (draft.stops || []).map((s) => ({
      name: s.name || '', lat: s.lat, lng: s.lng,
      is_pickup: true, is_drop: true, is_active: true,
      is_temporarily_unavailable: false, unavailable_reason: null,
    }));
    this.originalAssignments = this.editingId ? this.assignmentSignature() : null;
    this.loadGroupsAndDrivers();
    this.roadPath = (draft.path || []).map((p) => ({ lat: p[0], lng: p[1] }));
    this.computePathDistance();
    this.pathLocked = this.roadPath.length > 0;
    this.pathMode = 'road';
    this.clearAlternatives();
    this.directionsDisabled = false;
    this.tool = 'path';
    this.open = true;
    this.scheduleMapInit();
  }

  /** Update an EXISTING route from a Google My Maps import (the "edit → from My
   *  Maps" path): the target route is known, so its name, fare, vehicle and
   *  settings are kept while the line + stops are replaced from the draft. */
  openEditFromImport(routeId: number, draft: ImportedRouteDraft): void {
    const row = this.routes.find((r) => r.id === routeId) ?? null;
    this.openImported(
      {
        ...draft,
        name: row?.name ?? draft.name, // keep the route's own name/identity
        existing_route_id: routeId,
        existing: row,
      },
      !!row,
    );
  }

  onScopeChange(): void {
    if (this.form.scope !== 'outstation') { this.form.origin_city_id = null; this.form.dest_city_id = null; }
    else if (this.form.origin_city_id == null) this.form.origin_city_id = this.cityId;
  }

  isStopBookable(stop: RouteStopRow): boolean {
    return stop.is_active !== false && stop.is_temporarily_unavailable !== true;
  }

  isRemovedStop(stop: RouteStopRow): boolean {
    return /removed from active route/i.test(stop.unavailable_reason || "");
  }

  get selectedRemovedStopCount(): number { return this.selectedRemovedStopIndexes.size; }

  isRestoredStop(stop: RouteStopRow): boolean {
    return !!stop.id && this.restoredStopIds.has(Number(stop.id));
  }

  isRemovedStopSelected(index: number): boolean {
    return this.selectedRemovedStopIndexes.has(index);
  }

  openRemovedStopsModal(): void {
    this.selectedRemovedStopIndexes.clear();
    this.removedStopsModalOpen = true;
  }

  closeRemovedStopsModal(): void {
    this.removedStopsModalOpen = false;
    this.selectedRemovedStopIndexes.clear();
  }

  toggleRemovedStopSelection(index: number): void {
    if (this.selectedRemovedStopIndexes.has(index)) this.selectedRemovedStopIndexes.delete(index);
    else this.selectedRemovedStopIndexes.add(index);
  }

  addSelectedRemovedStops(): void {
    if (!this.selectedRemovedStopIndexes.size) return;
    const restored: RouteStopRow[] = [];
    const indexes = Array.from(this.selectedRemovedStopIndexes).sort((a, b) => b - a);
    indexes.forEach((index) => {
      if (index < 0 || index >= this.removedStops.length) return;
      const [stop] = this.removedStops.splice(index, 1);
      if (!stop) return;
      stop.is_active = true;
      stop.is_temporarily_unavailable = false;
      stop.unavailable_reason = null;
      if (stop.id) this.restoredStopIds.add(Number(stop.id));
      restored.unshift(stop);
    });
    if (restored.length) this.form.stops = [...this.form.stops, ...restored];
    this.closeRemovedStopsModal();
    this.redrawStops();
  }

  stopStateLabel(stop: RouteStopRow): string {
    return this.isStopBookable(stop) ? 'Bookable' : 'Paused';
  }

  stopToggleLabel(stop: RouteStopRow): string {
    return this.isStopBookable(stop) ? 'Pause' : 'Resume';
  }

  stopToggleIcon(stop: RouteStopRow): 'x' | 'check' {
    return this.isStopBookable(stop) ? 'x' : 'check';
  }

  stopToggleHelp(stop: RouteStopRow): string {
    return this.isStopBookable(stop)
      ? 'Pause this stop for new customer bookings without deleting route history.'
      : 'Make this saved stop available again for new customer bookings.';
  }

  toggleStopAvailability(stop: RouteStopRow): void {
    if (!this.editingId || !stop.id) return;
    if (this.isStopBookable(stop)) {
      stop.is_active = false;
      stop.is_temporarily_unavailable = true;
      stop.unavailable_reason = stop.unavailable_reason?.trim() || 'Paused by admin.';
    } else {
      stop.is_active = true;
      stop.is_temporarily_unavailable = false;
      stop.unavailable_reason = null;
    }
    this.redrawStops();
  }

  setTool(t: MapTool): void {
    if ((t === 'path' || t === 'stop') && (this.form.origin_lat == null || this.form.dest_lat == null)) {
      this.toast.error('Set the start and destination first.');
      return;
    }
    this.tool = t;
    this.redrawPath();
    this.renderAlternatives();
    if (t === 'path' && this.pathMode === 'road' && !this.routeAlts.length) this.fetchRouteAlternatives();
  }

  /** Toggle between picking a Google road route and free-hand drawing. */
  setPathMode(mode: 'road' | 'free'): void {
    if (!this.endpointsSet) { this.toast.error('Set the start and destination first.'); return; }
    if (this.tool !== 'path') this.tool = 'path';
    if (this.pathMode === mode) { this.redrawPath(); return; }
    this.pathMode = mode;
    if (mode === 'free') {
      this.clearAlternatives();
      this.pathLocked = true;
      this.rebuildFreePath();
      this.toast.success('Free draw on — click along the map to draw any path. Drag points on the line to adjust.');
    } else {
      this.showRouteOptions();
    }
    this.redrawPath();
  }

  /** Ask Google for every road route between A and B and show them as pickable options. */
  showRouteOptions(): void {
    if (!this.endpointsSet) { this.toast.error('Set the start and destination first.'); return; }
    this.tool = 'path';
    this.pathMode = 'road';
    this.form.path = []; // options are computed from the endpoints only
    this.fetchRouteAlternatives();
  }

      private async fetchRouteAlternatives(): Promise<void> {
    const svc = this.directionsSvc;
    if (!this.endpointsSet || !svc || this.directionsDisabled) return;
    const seq = ++this.altSeq;
    this.altsLoading = true;
    const oLat = this.form.origin_lat as number;
    const oLng = this.form.origin_lng as number;
    const dLat = this.form.dest_lat as number;
    const dLng = this.form.dest_lng as number;
    const origin = { lat: oLat, lng: oLng };
    const destination = { lat: dLat, lng: dLng };

    // 1. Direct query with route alternatives (natural Google primary routes)
    const directPromise = new Promise<any[]>((resolve) => {
      this.directionsSvc!.route(
        { origin, destination, travelMode: google.maps.TravelMode.DRIVING, provideRouteAlternatives: true },
        (res: any, status: any) => {
          if (status === 'OK' && res?.routes?.length) resolve(res.routes);
          else resolve([]);
        }
      );
    });

    // 2. Discover intermediate transit towns/junctions within the bounding corridor envelope
    const townPromises: Promise<any[]>[] = [directPromise];

    const minLat = Math.min(oLat, dLat);
    const maxLat = Math.max(oLat, dLat);
    const minLng = Math.min(oLng, dLng);
    const maxLng = Math.max(oLng, dLng);
    const midLat = (oLat + dLat) / 2;
    const midLng = (oLng + dLng) / 2;
    const directDist = this.distanceMeters(oLat, oLng, dLat, dLng);

    if (directDist > 3000 && this.placesSvc) {
      const radiusM = Math.min(45000, Math.max(5000, directDist * 0.65));
      const discoveredTowns: { name: string; lat: number; lng: number }[] = [];
      const intermediatePoints = await new Promise<LatLng[]>((resolve) => {
        const pts: LatLng[] = [];
        this.placesSvc!.nearbySearch(
          {
            location: new google.maps.LatLng(midLat, midLng),
            radius: radiusM,
            type: 'locality',
          },
          (results, status) => {
            if (status === google.maps.places.PlacesServiceStatus.OK && results?.length) {
              results.forEach((place) => {
                if (place.geometry?.location && place.name) {
                  const pLat = place.geometry.location.lat();
                  const pLng = place.geometry.location.lng();
                  if (
                    pLat >= minLat - 0.08 &&
                    pLat <= maxLat + 0.08 &&
                    pLng >= minLng - 0.08 &&
                    pLng <= maxLng + 0.08
                  ) {
                    pts.push({ lat: pLat, lng: pLng });
                    const cleanName = place.name.split(',')[0].trim();
                    if (!discoveredTowns.some(t => t.name.toLowerCase() === cleanName.toLowerCase())) {
                      discoveredTowns.push({ name: cleanName, lat: pLat, lng: pLng });
                    }
                  }
                }
              });
            }
            resolve(pts);
          }
        );
      });
      this.suggestedCorridorTowns = discoveredTowns.slice(0, 8);

      intermediatePoints.slice(0, 8).forEach((pt) => {
        const p = new Promise<any[]>((resolve) => {
          this.directionsSvc!.route(
            {
              origin,
              destination,
              waypoints: [{ location: new google.maps.LatLng(pt.lat, pt.lng), stopover: false }],
              travelMode: google.maps.TravelMode.DRIVING,
            },
            (res: any, status: any) => {
              if (status === 'OK' && res?.routes?.length) resolve(res.routes);
              else resolve([]);
            }
          );
        });
        townPromises.push(p);
      });
    }

    try {
      const results = await Promise.all(townPromises);
      if (seq !== this.altSeq || !this.open) return;
      this.altsLoading = false;

      const rawRoutes: any[] = [];
      results.forEach((routes) => {
        if (Array.isArray(routes)) rawRoutes.push(...routes);
      });

      if (!rawRoutes.length) {
        this.clearAlternatives();
        return;
      }

      let minDistance = Infinity;
      for (const r of rawRoutes) {
        const dist = r.legs?.reduce((acc: number, l: any) => acc + (l.distance?.value || 0), 0) || 0;
        if (dist > 0 && dist < minDistance) minDistance = dist;
      }

      const candidates: RouteAlt[] = [];

      for (const r of rawRoutes) {
        const pts: LatLng[] = (r.overview_path || []).map((ll: any) => ({ lat: ll.lat(), lng: ll.lng() }));
        if (pts.length < 2) continue;

        // 1. Strict loop/backtrack check: Never allow dead-end spur detours or U-turns
        if (this.hasBacktrackOrLoop(pts)) continue;

        const distanceM = r.legs?.reduce((acc: number, l: any) => acc + (l.distance?.value || 0), 0) || 0;
        const durationS = r.legs?.reduce((acc: number, l: any) => acc + (l.duration?.value || 0), 0) || 0;

        // 2. Reject extreme detours (> 35% longer than the shortest viable route)
        if (distanceM > minDistance * 1.35) continue;

        const distanceText = r.legs?.[0]?.distance?.text || `${Math.round(distanceM / 100) / 10} km`;
        const durationText = r.legs?.[0]?.duration?.text || `${Math.round(durationS / 60)} mins`;
        let summary = (r.summary || '').trim();

        // 3. Deduplicate overlapping routes
        let isDuplicate = false;
        for (const existing of candidates) {
          const distDiff = Math.abs(distanceM - (existing.meters || 0));
          if (distDiff < 400 && (existing.summary === summary || this.pathsAreNearlyIdentical(pts, existing.path, 0.82))) {
            isDuplicate = true;
            break;
          }
          if (this.pathsAreNearlyIdentical(pts, existing.path, 0.88)) {
            isDuplicate = true;
            break;
          }
        }

        if (!isDuplicate) {
          if (!summary) summary = `Corridor Option ${candidates.length + 1}`;
          candidates.push({
            path: pts,
            summary,
            distanceText,
            durationText,
            meters: distanceM,
            seconds: durationS,
          });
        }
      }

      if (!candidates.length) {
        this.clearAlternatives();
        return;
      }

      // Sort candidates: fastest / shortest first
      candidates.sort((a, b) => (a.seconds || 0) - (b.seconds || 0));

      this.routeAlts = candidates;
      this.selectedAltIdx = 0;
      this.applyAlternative(0);
      this.renderAlternatives();
      this.cdr.markForCheck();

      this.toast.success(
        this.routeAlts.length === 1
          ? 'Route loaded.'
          : `Discovered ${this.routeAlts.length} available corridors — select below or tap any grey line on the map.`
      );
    } catch {
      if (seq !== this.altSeq) return;
      this.altsLoading = false;
      this.clearAlternatives();
    }
  }

  /** Detects if a route contains dead-end U-turns or loop detours back onto the same road. */
  private hasBacktrackOrLoop(pts: LatLng[]): boolean {
    if (!pts || pts.length < 15) return false;
    const len = pts.length;
    const step = Math.max(1, Math.floor(len / 40));
    for (let i = 0; i < len - step * 4; i += step) {
      const p1 = pts[i];
      for (let j = i + step * 4; j < len; j += step) {
        const p2 = pts[j];
        const directDist = this.distanceMeters(p1.lat, p1.lng, p2.lat, p2.lng);
        if (directDist < 160) {
          let pathDist = 0;
          for (let k = i; k < j; k++) {
            pathDist += this.distanceMeters(pts[k].lat, pts[k].lng, pts[k + 1].lat, pts[k + 1].lng);
          }
          if (pathDist > 1600) {
            return true; // Drove > 1.6km only to return to same point (loop / U-turn)
          }
        }
      }
    }
    return false;
  }

  private pathsAreNearlyIdentical(pathA: LatLng[], pathB: LatLng[], threshold = 0.88): boolean {
    if (!pathA.length || !pathB.length) return false;
    const samples = Math.min(15, pathA.length);
    const step = Math.max(1, Math.floor(pathA.length / samples));
    let matching = 0;
    let checked = 0;

    for (let i = 0; i < pathA.length; i += step) {
      const ptA = pathA[i];
      checked++;
      let minMeters = Infinity;
      for (let j = 0; j < pathB.length; j += Math.max(1, Math.floor(pathB.length / 30))) {
        const ptB = pathB[j];
        const dist = this.distanceMeters(ptA.lat, ptA.lng, ptB.lat, ptB.lng);
        if (dist < minMeters) minMeters = dist;
        if (minMeters < 80) break;
      }
      if (minMeters < 250) {
        matching++;
      }
    }
    return checked > 0 && (matching / checked) >= threshold;
  }

  /** Make option `i` the saved route. */
  private applyAlternative(i: number): void {
    const alt = this.routeAlts[i];
    if (!alt) return;
    this.selectedAltIdx = i;
    this.roadPath = alt.path.slice();
    this.pathLocked = true;
    this.estimatedDistanceText = alt.distanceText || '';
    this.estimatedDurationText = alt.durationText || '';
    const distMatch = (alt.distanceText || '').match(/([\d,.]+)\s*(km|m)/i);
    if (distMatch) {
      const val = parseFloat(distMatch[1].replace(/,/g, ''));
      this.estimatedDistanceKm = distMatch[2].toLowerCase() === 'm' ? val / 1000 : val;
    } else {
      this.computePathDistance();
    }
    if (!this.form.seat_fare && this.estimatedDistanceKm > 0) {
      this.form.seat_fare = Math.max(30, Math.round(this.estimatedDistanceKm * 10 / 10) * 10);
    }
    this.redrawPath();
    this.detectSuggestedStops();
    this.fitRouteViewport();
  }

  applyKmRate(rate: number): void {
    if (this.estimatedDistanceKm > 0) {
      this.form.seat_fare = Math.max(30, Math.round((this.estimatedDistanceKm * rate) / 10) * 10);
    }
  }

  roundFare(amount: number): number {
    return Math.max(30, Math.round(amount / 10) * 10);
  }

  computePathDistance(): void {
    if (!this.roadPath.length || this.roadPath.length < 2) {
      this.estimatedDistanceText = '';
      this.estimatedDurationText = '';
      this.estimatedDistanceKm = 0;
      return;
    }
    let meters = 0;
    for (let i = 0; i < this.roadPath.length - 1; i++) {
      meters += this.distanceMeters(this.roadPath[i].lat, this.roadPath[i].lng, this.roadPath[i + 1].lat, this.roadPath[i + 1].lng);
    }
    const km = meters / 1000;
    this.estimatedDistanceKm = Math.round(km * 10) / 10;
    this.estimatedDistanceText = `${this.estimatedDistanceKm} km`;
    const minutes = Math.round((km / 35) * 60);
    this.estimatedDurationText = minutes >= 60 ? `~${Math.floor(minutes / 60)}h ${minutes % 60}m` : `~${minutes} mins`;
  }

  async autoGenerateStops(): Promise<void> {
    if (!this.roadPath.length || this.roadPath.length < 5) {
      this.toast.error('Draw or select a valid road route first.');
      return;
    }
    if (this.generatingStops) return;
    this.generatingStops = true;

    try {
      const numStops = Math.min(8, Math.max(3, Math.floor(this.roadPath.length / 25)));
      const step = Math.floor(this.roadPath.length / (numStops + 1));
      const sampledPoints: LatLng[] = [];
      for (let i = 1; i <= numStops; i++) {
        const pt = this.roadPath[i * step];
        if (pt) sampledPoints.push(pt);
      }

      const newStops: RouteStopRow[] = [];
      for (let i = 0; i < sampledPoints.length; i++) {
        const pt = sampledPoints[i];
        const name = await this.fetchPointStopName(pt.lat, pt.lng);
        newStops.push({
          name: name || `Stop ${this.form.stops.length + i + 1}`,
          lat: pt.lat,
          lng: pt.lng,
          is_pickup: true,
          is_drop: true,
          is_active: true,
          is_temporarily_unavailable: false,
          unavailable_reason: null,
        });
      }

      this.form.stops = [...this.form.stops, ...newStops];
      this.redrawStops();
      this.toast.success(`Generated ${newStops.length} stops from landmarks along the route.`);
    } catch {
      this.toast.error('Could not auto-generate stops.');
    } finally {
      this.generatingStops = false;
    }
  }

  private fetchPointStopName(lat: number, lng: number): Promise<string> {
    return new Promise((resolve) => {
      if (!this.placesSvc || typeof google === 'undefined' || !google.maps?.places) {
        this.geocoder?.geocode({ location: { lat, lng } }, (results, status) => {
          if (status === 'OK' && results && results[0]) {
            resolve(this.bestGeocodeStopName(results));
          } else {
            resolve('');
          }
        });
        return;
      }

      this.placesSvc.nearbySearch({ location: new google.maps.LatLng(lat, lng), radius: 250 }, (places, status) => {
        if (status === google.maps.places.PlacesServiceStatus.OK && places?.length) {
          const name = this.bestNearbyStopName(places, lat, lng);
          if (name) { resolve(name); return; }
        }
        this.geocoder?.geocode({ location: { lat, lng } }, (results, gStatus) => {
          if (gStatus === 'OK' && results && results[0]) {
            resolve(this.bestGeocodeStopName(results));
          } else {
            resolve('');
          }
        });
      });
    });
  }

  reverseRoute(): void {
    if (!this.endpointsSet) return;
    const oldOriginName = this.form.origin_name;
    const oldOriginLat = this.form.origin_lat;
    const oldOriginLng = this.form.origin_lng;
    const oldOriginStopId = this.form.origin_stop_id;

    this.form.origin_name = this.form.dest_name;
    this.form.origin_lat = this.form.dest_lat;
    this.form.origin_lng = this.form.dest_lng;
    this.form.origin_stop_id = this.form.dest_stop_id;

    this.form.dest_name = oldOriginName;
    this.form.dest_lat = oldOriginLat;
    this.form.dest_lng = oldOriginLng;
    this.form.dest_stop_id = oldOriginStopId;

    if (this.roadPath.length) {
      this.roadPath = [...this.roadPath].reverse();
    }
    if (this.form.path.length) {
      this.form.path = [...this.form.path].reverse();
    }
    if (this.form.stops.length) {
      this.form.stops = [...this.form.stops].reverse();
    }

    if (this.form.scope === 'outstation') {
      const origCity = this.form.origin_city_id;
      this.form.origin_city_id = this.form.dest_city_id;
      this.form.dest_city_id = origCity;
    }

    this.form.name = `${this.form.origin_name} → ${this.form.dest_name}`;

    this.redrawOrigin();
    this.redrawDest();
    this.redrawPath();
    this.redrawStops();
    this.toast.success('Route reversed (Start & Destination swapped).');
  }

  selectAlternative(i: number): void {
    if (i === this.selectedAltIdx) return;
    this.applyAlternative(i);
    this.renderAlternatives();
    this.cdr.markForCheck();
    const name = this.routeAlts[i]?.summary ? 'Via ' + this.routeAlts[i].summary : ('Corridor Option ' + (i + 1));
    this.toast.success('Active route switched to: ' + name);
  }

  hoverAlternative(i: number | null): void {
    if (this.hoveredAltIdx === i) return;
    this.hoveredAltIdx = i;
    this.renderAlternatives();
  }

  /** Draw the non-selected options as grey clickable lines behind the chosen green one. */
  private renderAlternatives(): void {
    this.altPolylines.forEach((p) => p.setMap(null));
    this.altPolylines = [];
    if (!this.map || this.pathMode !== 'road') return;
    this.routeAlts.forEach((alt, i) => {
      if (i === this.selectedAltIdx) return;
      const hot = this.hoveredAltIdx === i;
      const line = new google.maps.Polyline({
        path: alt.path, map: this.map!, geodesic: true, clickable: true,
        strokeColor: hot ? '#0ea5e9' : '#64748b',
        strokeOpacity: hot ? 0.95 : 0.65,
        strokeWeight: hot ? 7 : 5,
        zIndex: hot ? 4 : 2,
      });
      line.addListener('click', () => {
        this.zone.run(() => {
          this.selectAlternative(i);
        });
      });
      line.addListener('mouseover', () => {
        this.zone.run(() => {
          this.hoverAlternative(i);
        });
      });
      line.addListener('mouseout', () => {
        this.zone.run(() => {
          this.hoverAlternative(null);
        });
      });
      this.altPolylines.push(line);
    });
  }

  private clearAlternatives(): void {
    this.altSeq++;
    this.altsLoading = false;
    this.routeAlts = [];
    this.selectedAltIdx = null;
    this.hoveredAltIdx = null;
    this.altPolylines.forEach((p) => p.setMap(null));
    this.altPolylines = [];
  }

    suggestedCorridorTowns: { name: string; lat: number; lng: number }[] = [];
  viaSearchQuery = '';
  viaSearchDebounceTimer: any = null;
  viaSearchResults: { place_id: string; main_text: string; secondary_text: string; description: string }[] = [];
  isViaDropdownOpen = false;
  isSearchingVia = false;

  onViaSearchInput(query: string): void {
    if (this.viaSearchDebounceTimer) {
      clearTimeout(this.viaSearchDebounceTimer);
    }
    const trimmed = (query || '').trim();
    if (!trimmed || trimmed.length < 2) {
      this.viaSearchResults = [];
      this.isViaDropdownOpen = false;
      this.isSearchingVia = false;
      return;
    }

    this.viaSearchDebounceTimer = setTimeout(() => {
      this.fetchViaPredictions(trimmed);
    }, 180);
  }

  onViaSearchFocus(): void {
    if (this.viaSearchResults.length > 0) {
      this.isViaDropdownOpen = true;
    }
  }

  onViaSearchBlur(): void {
    setTimeout(() => {
      this.isViaDropdownOpen = false;
    }, 200);
  }

  onViaSearchEnter(): void {
    if (this.viaSearchResults.length > 0) {
      this.selectViaSearchResult(this.viaSearchResults[0]);
    } else {
      this.addViaCorridorPoint(this.viaSearchQuery);
    }
  }

  private fetchViaPredictions(query: string): void {
    if (!this.autocompleteSvc && typeof google !== 'undefined' && google.maps?.places) {
      this.autocompleteSvc = new google.maps.places.AutocompleteService();
    }
    if (!this.autocompleteSvc) return;

    this.isSearchingVia = true;
    const bounds = this.getCorridorBounds();

    this.autocompleteSvc.getPlacePredictions(
      {
        input: query,
        bounds: bounds || undefined,
        componentRestrictions: { country: 'in' },
      },
      (predictions, status) => {
        this.isSearchingVia = false;
        if (status === google.maps.places.PlacesServiceStatus.OK && predictions?.length) {
          this.viaSearchResults = predictions
            .map((p) => ({
              place_id: p.place_id,
              main_text: p.structured_formatting?.main_text || p.description.split(',')[0],
              secondary_text: p.structured_formatting?.secondary_text || p.description.split(',').slice(1).join(','),
              description: p.description,
            }))
            .filter((p) => !this.isBadStopName(p.main_text));
          this.isViaDropdownOpen = this.viaSearchResults.length > 0;
        } else {
          this.viaSearchResults = [];
          this.isViaDropdownOpen = false;
        }
        this.cdr.markForCheck();
      }
    );
  }

  selectViaSearchResult(res: { place_id: string; main_text: string }): void {
    this.isViaDropdownOpen = false;
    this.viaSearchQuery = '';
    if (this.placesSvc && res.place_id) {
      this.placesSvc.getDetails({ placeId: res.place_id, fields: ['geometry', 'name', 'formatted_address'] }, (place, status) => {
        if (status === google.maps.places.PlacesServiceStatus.OK && place?.geometry?.location) {
          const loc = place.geometry.location;
          const pt = { lat: loc.lat(), lng: loc.lng() };
          this.pathLocked = false;
          this.form.path.push(pt);
          this.recomputeRoadPath();
          this.toast.success(`Route forced via "${place.name || res.main_text}"`);
          this.cdr.markForCheck();
        } else {
          this.addViaCorridorPoint(res.main_text);
        }
      });
    } else {
      this.addViaCorridorPoint(res.main_text);
    }
  }

  addViaTown(town: { name: string; lat: number; lng: number }): void {
    this.pathLocked = false;
    this.form.path.push({ lat: town.lat, lng: town.lng });
    this.recomputeRoadPath();
    this.toast.success(`Route forced via "${town.name}"`);
    this.cdr.markForCheck();
  }

  getCorridorBounds(): google.maps.LatLngBounds | undefined {
    if (this.form.origin_lat == null || this.form.dest_lat == null) return undefined;
    const oLat = this.form.origin_lat, oLng = this.form.origin_lng!;
    const dLat = this.form.dest_lat, dLng = this.form.dest_lng!;
    const minLat = Math.min(oLat, dLat) - 0.08;
    const maxLat = Math.max(oLat, dLat) + 0.08;
    const minLng = Math.min(oLng, dLng) - 0.08;
    const maxLng = Math.max(oLng, dLng) + 0.08;
    return new google.maps.LatLngBounds(
      new google.maps.LatLng(minLat, minLng),
      new google.maps.LatLng(maxLat, maxLng)
    );
  }

  addViaCorridorPoint(query: string): void {
    if (!query.trim() || !this.geocoder) return;
    const bounds = this.getCorridorBounds();
    this.geocoder.geocode(
      { address: query.trim(), bounds: bounds || this.map?.getBounds() || undefined, componentRestrictions: { country: 'in' } },
      (results, status) => {
        if (status === 'OK' && results && results[0]?.geometry?.location) {
          const loc = results[0].geometry.location;
          const pt = { lat: loc.lat(), lng: loc.lng() };
          this.pathLocked = false;
          this.form.path.push(pt);
          this.viaSearchQuery = '';
          this.recomputeRoadPath();
          const name = results[0].formatted_address.split(',')[0].trim();
          this.toast.success('Route forced via "' + name + '"');
          this.cdr.markForCheck();
        } else {
          this.toast.error('Could not locate "' + query + '".');
        }
      }
    );
  }

  removeViaCorridorPoint(index: number): void {
    this.pathLocked = false;
    this.form.path.splice(index, 1);
    this.recomputeRoadPath();
    this.cdr.markForCheck();
  }

  clearViaCorridorPoints(): void {
    this.pathLocked = false;
    this.form.path = [];
    this.fetchRouteAlternatives();
    this.cdr.markForCheck();
  }


  /** Free mode: the saved line is exactly origin → clicked points → destination, straight. */
  private rebuildFreePath(): void {
    const pts: LatLng[] = [];
    if (this.form.origin_lat != null) pts.push({ lat: this.form.origin_lat, lng: this.form.origin_lng as number });
    pts.push(...this.form.path);
    if (this.form.dest_lat != null) pts.push({ lat: this.form.dest_lat, lng: this.form.dest_lng as number });
    this.roadPath = pts;
    this.redrawPath();
  }

  /** Free mode: keep form.path/endpoints in sync when the editable line is dragged. */
  private syncFreeFromPolyline(polyPath: google.maps.MVCArray<google.maps.LatLng>): void {
    const arr = polyPath.getArray();
    this.roadPath = arr.map((ll) => ({ lat: ll.lat(), lng: ll.lng() }));
    if (arr.length < 2) return;
    const first = arr[0], last = arr[arr.length - 1];
    this.form.origin_lat = first.lat(); this.form.origin_lng = first.lng();
    this.form.dest_lat = last.lat(); this.form.dest_lng = last.lng();
    this.form.path = arr.slice(1, -1).map((ll) => ({ lat: ll.lat(), lng: ll.lng() }));
    this.pathLocked = true;
    this.redrawOrigin();
    this.redrawDest();
  }

  private scheduleMapInit(): void {
    this.mapInitTries = 0;
    setTimeout(() => this.initMap(), 70);
  }

  private async initMap(): Promise<void> {
    if (!this.open) return;
    const el = document.getElementById('fixed-rt-edit-map');
    if (!el) {
      if (this.open && this.mapInitTries++ < 12) setTimeout(() => this.initMap(), 80);
      return;
    }
    try { await this.mapsLoader.load(); } catch { this.toast.error('Could not load the map.'); return; }
    if (!this.open) return;

    const center = this.form.origin_lat != null
      ? { lat: this.form.origin_lat, lng: this.form.origin_lng as number }
      : this.cityCenter ?? { lat: 20.5937, lng: 78.9629 };

    this.map = new google.maps.Map(el, {
      center, zoom: this.form.origin_lat != null ? 16 : (this.cityCenter ? 15 : 12),
      disableDefaultUI: false, streetViewControl: false, mapTypeControl: false, fullscreenControl: false,
      clickableIcons: false, zoomControl: true, gestureHandling: 'greedy',
    });
    this.geocoder = new google.maps.Geocoder();
    this.directionsSvc = new google.maps.DirectionsService();
    this.placesSvc = new google.maps.places.PlacesService(this.map);
    this.autocompleteSvc = new google.maps.places.AutocompleteService();

    this.mapListeners.push(this.map.addListener('click', (e: google.maps.MapMouseEvent) => {
      if (e.latLng) void this.onMapClick(e.latLng.lat(), e.latLng.lng());
    }));

    this.setupSearch();
    this.drawBoundary();
    this.redrawOrigin();
    this.redrawDest();
    this.redrawPath();
    this.redrawStops();
    if (this.wizardStep === 1) {
      this.fitOriginView();
    } else {
      this.fitRouteViewport();
    }
  }

  private setupSearch(): void {
    if (!this.map || typeof google === 'undefined' || !google.maps?.places) return;

    // 1. Top Map Search Box
    const mapSearchInput = document.querySelector('.rt-search input') as HTMLInputElement | null;
    if (mapSearchInput) {
      const ac = new google.maps.places.Autocomplete(mapSearchInput, {
        fields: ['geometry', 'name', 'formatted_address', 'address_components', 'types'],
      });
      this.autocomplete = ac;
      ac.bindTo('bounds', this.map);
      this.mapListeners.push(ac.addListener('place_changed', () => {
        const place = ac.getPlace();
        if (!place.geometry?.location || !this.map) return;

        const lat = place.geometry.location.lat();
        const lng = place.geometry.location.lng();
        const placeName = this.extractLegitimateLocationName(place);

        this.map.panTo(place.geometry.location);
        this.map.setZoom(16);

        if (this.tool === 'origin') {
          this.form.origin_name = placeName;
          void this.setOrigin(lat, lng, false);
          this.toast.success(`Start point set to "${placeName}"`);
          this.clearSearchMarker();
          return;
        }

        if (this.tool === 'dest') {
          this.form.dest_name = placeName;
          void this.setDest(lat, lng, false);
          this.toast.success(`Destination set to "${placeName}"`);
          this.clearSearchMarker();
          return;
        }

        this.dropSearchMarker(lat, lng, placeName);
      }));
    }

    this.setupWizardAutocompletes();
  }

  setupWizardAutocompletes(): void {
    if (!this.map || typeof google === 'undefined' || !google.maps?.places) return;

    // 2. Wizard Origin Search Input
    const originEl = document.getElementById('wizard-origin-search') as HTMLInputElement | null;
    if (originEl) {
      if (this.boundOriginEl !== originEl) {
        this.boundOriginEl = originEl;
        this.originAutocomplete = new google.maps.places.Autocomplete(originEl, {
          fields: ['geometry', 'name', 'formatted_address', 'address_components', 'types'],
        });
        this.originAutocomplete.bindTo('bounds', this.map);
        this.mapListeners.push(this.originAutocomplete.addListener('place_changed', () => {
          const place = this.originAutocomplete?.getPlace();
          if (place?.geometry?.location && this.map) {
            const lat = place.geometry.location.lat();
            const lng = place.geometry.location.lng();
            const name = this.extractLegitimateLocationName(place);
            this.form.origin_name = name;
            this.map.panTo(place.geometry.location);
            this.map.setZoom(16);
            void this.setOrigin(lat, lng, false);
            this.clearSearchMarker();
            this.toast.success(`Start point placed at "${name}"`);
          }
        }));
      }
    } else {
      this.boundOriginEl = null;
    }

    // 3. Wizard Destination Search Input
    const destEl = document.getElementById('wizard-dest-search') as HTMLInputElement | null;
    if (destEl) {
      if (this.boundDestEl !== destEl) {
        this.boundDestEl = destEl;
        this.destAutocomplete = new google.maps.places.Autocomplete(destEl, {
          fields: ['geometry', 'name', 'formatted_address', 'address_components', 'types'],
        });
        this.destAutocomplete.bindTo('bounds', this.map);
        this.mapListeners.push(this.destAutocomplete.addListener('place_changed', () => {
          const place = this.destAutocomplete?.getPlace();
          if (place?.geometry?.location && this.map) {
            const lat = place.geometry.location.lat();
            const lng = place.geometry.location.lng();
            const name = this.extractLegitimateLocationName(place);
            this.form.dest_name = name;
            this.map.panTo(place.geometry.location);
            this.map.setZoom(16);
            void this.setDest(lat, lng, false);
            this.clearSearchMarker();
            this.toast.success(`Destination placed at "${name}"`);
          }
        }));
      }
    } else {
      this.boundDestEl = null;
    }
  }

  private dropSearchMarker(lat: number, lng: number, title: string): void {
    this.clearSearchMarker();
    if (!this.map) return;

    this.searchMarker = new google.maps.Marker({
      position: { lat, lng },
      map: this.map,
      title,
      animation: google.maps.Animation.DROP,
      icon: {
        path: google.maps.SymbolPath.BACKWARD_CLOSED_ARROW,
        scale: 6,
        fillColor: '#2563eb',
        fillOpacity: 1,
        strokeColor: '#ffffff',
        strokeWeight: 2,
      },
    });

    const infoContent = document.createElement('div');
    infoContent.style.padding = '6px 4px';
    infoContent.style.fontFamily = 'inherit';
    infoContent.innerHTML = `
      <div style="font-weight:700;font-size:13px;color:#0f172a;margin-bottom:6px;max-width:200px;">${title}</div>
      <div style="display:flex;gap:6px;">
        <button id="search-set-origin-btn" style="background:#16a34a;color:#fff;border:none;border-radius:6px;padding:4px 8px;font-size:11px;font-weight:700;cursor:pointer;">Set as Start (A)</button>
        <button id="search-set-dest-btn" style="background:#dc2626;color:#fff;border:none;border-radius:6px;padding:4px 8px;font-size:11px;font-weight:700;cursor:pointer;">Set as Dest (B)</button>
      </div>
    `;

    infoContent.querySelector('#search-set-origin-btn')?.addEventListener('click', () => {
      this.form.origin_name = title;
      void this.setOrigin(lat, lng, false);
      this.clearSearchMarker();
      this.toast.success(`Start point set to "${title}"`);
    });

    infoContent.querySelector('#search-set-dest-btn')?.addEventListener('click', () => {
      this.form.dest_name = title;
      void this.setDest(lat, lng, false);
      this.clearSearchMarker();
      this.toast.success(`Destination set to "${title}"`);
    });

    this.searchInfoWindow = new google.maps.InfoWindow({ content: infoContent });
    this.searchInfoWindow.open(this.map, this.searchMarker);

    this.searchMarker.addListener('click', () => {
      this.searchInfoWindow?.open(this.map, this.searchMarker);
    });
  }

  private clearSearchMarker(): void {
    if (this.searchMarker) {
      this.searchMarker.setMap(null);
      this.searchMarker = null;
    }
    if (this.searchInfoWindow) {
      this.searchInfoWindow.close();
      this.searchInfoWindow = null;
    }
  }

  private drawBoundary(): void {
    if (!this.map || !this.cityBoundary.length) return;
    this.boundaryPoly = new google.maps.Polygon({
      paths: this.cityBoundary, map: this.map, clickable: false,
      strokeColor: '#2563eb', strokeOpacity: 0.5, strokeWeight: 1.5, fillColor: '#2563eb', fillOpacity: 0.04,
    });
  }

  private async onMapClick(lat: number, lng: number): Promise<void> {
    if (this.tool === 'origin') { await this.setOrigin(lat, lng, true); return; }
    if (this.tool === 'dest') { await this.setDest(lat, lng, true); return; }

    if (this.form.origin_lat == null || this.form.dest_lat == null) {
      this.toast.error('Set the start and destination first.');
      return;
    }

    if (this.wizardStep === 2 && this.form.dest_lat != null) {
      const p = await this.snapPoint({ lat, lng });
      this.pathLocked = false;
      this.form.path.push(p);
      this.recomputeRoadPath();
      this.toast.success('Route adjusted to pass through clicked point.');
      this.cdr.markForCheck();
      return;
    }

    if (this.tool === 'path') {
      if (this.pathMode === 'free') {
        if (this.form.path.length >= 300) { this.toast.error('This path already has the maximum number of points.'); return; }
        const v = this.validatePlacement(lat, lng, 'path');
        if (!v.ok) { this.toast.error(v.msg!); return; }
        this.form.path.push({ lat, lng }); // exact click — no road snapping
        this.pathLocked = true;
        this.rebuildFreePath();
        return;
      }
      const p = await this.snapPoint({ lat, lng });
      this.pathLocked = false;
      this.form.path.push(p);
      this.recomputeRoadPath();
      this.toast.success('Route adjusted to pass through clicked point.');
      this.cdr.markForCheck();
      return;
    }
    if (this.tool === 'stop') {
      const roadPoint = this.snapToRoutePath({ lat, lng });
      if (!roadPoint) { this.toast.error('Click on or very near the green route line to add a stop.'); return; }
      const p = await this.snapPoint(roadPoint);
      if (!this.open) return;
      const v = this.validatePlacement(p.lat, p.lng, 'stop');
      if (!v.ok) { this.toast.error(v.msg!); return; }
      const stop: RouteStopRow = { name: '', lat: p.lat, lng: p.lng, is_pickup: true, is_drop: true, is_active: true, is_temporarily_unavailable: false, unavailable_reason: null };
      this.form.stops.push(stop);
      this.redrawStops();
      this.reverseGeocodeStop(stop);
    }
  }

  private async setOrigin(lat: number, lng: number, fromClick = false): Promise<void> {
    this.isSettingOrigin = true;
    try {
      const seq = ++this.snapSeqOrigin;
      const p = fromClick ? await this.snapPoint({ lat, lng }) : { lat, lng };
      if (seq !== this.snapSeqOrigin || !this.open) return;
      const v = this.validatePlacement(p.lat, p.lng, 'origin');
      if (!v.ok) { this.toast.error(v.msg!); return; }
      this.form.origin_lat = p.lat; this.form.origin_lng = p.lng;
      this.redrawOrigin();
      if (!this.form.origin_name.trim()) this.reverseGeocode(p.lat, p.lng, 'origin');
      else this.maybeAutoName();
      this.recomputeRoadPath();

      if (this.wizardStep === 1) {
        this.fitOriginView();
      } else {
        this.fitRouteViewport();
      }

      if (this.form.dest_lat == null) {
        this.tool = 'dest';
      } else {
        this.tool = 'stop';
      }
    } finally {
      setTimeout(() => { this.isSettingOrigin = false; }, 300);
    }
  }

  private async setDest(lat: number, lng: number, fromClick = false): Promise<void> {
    this.isSettingDest = true;
    try {
      const seq = ++this.snapSeqDest;
      const p = fromClick ? await this.snapPoint({ lat, lng }) : { lat, lng };
      if (seq !== this.snapSeqDest || !this.open) return;
      const v = this.validatePlacement(p.lat, p.lng, 'dest');
      if (!v.ok) { this.toast.error(v.msg!); return; }
      this.form.dest_lat = p.lat; this.form.dest_lng = p.lng;
      this.redrawDest();
      if (!this.form.dest_name.trim()) this.reverseGeocode(p.lat, p.lng, 'dest');
      else this.maybeAutoName();
      this.recomputeRoadPath();
      this.tool = 'stop';
      setTimeout(() => this.fitRouteViewport(), 100);
    } finally {
      setTimeout(() => { this.isSettingDest = false; }, 300);
    }
  }

  private snapPoint(p: LatLng): Promise<LatLng> {
    return new Promise((resolve) => {
      if (!this.directionsSvc || this.directionsDisabled) { resolve(p); return; }
      const destination = { lat: p.lat + 0.0006, lng: p.lng + 0.0006 };
      this.directionsSvc!.route(
        { origin: p, destination, travelMode: google.maps.TravelMode.DRIVING },
        (res: any, status: any) => {
          if (status === 'OK' && res?.routes?.[0]?.legs?.[0]?.start_location) {
            const s = res.routes[0].legs[0].start_location;
            resolve({ lat: s.lat(), lng: s.lng() });
          } else {
            if (status === 'REQUEST_DENIED') this.directionsDisabled = true;
            resolve(p);
          }
        },
      );
    });
  }

  private recomputeRoadPath(): void {
    if (this.pathMode === 'free') { this.rebuildFreePath(); return; }
    // Road mode is "pick one of Google's routes" — as soon as both ends exist,
    // (re)fetch the options rather than snapping a hand-built waypoint list.
    if (this.endpointsSet && !this.form.path.length) { this.fetchRouteAlternatives(); return; }
    if (this.pathLocked) { this.redrawPath(); return; }
    const seq = ++this.routeSeq;
    const pts: LatLng[] = [];
    if (this.form.origin_lat != null) pts.push({ lat: this.form.origin_lat, lng: this.form.origin_lng as number });
    pts.push(...this.form.path);
    if (this.form.dest_lat != null) pts.push({ lat: this.form.dest_lat, lng: this.form.dest_lng as number });

    if (pts.length < 2 || !this.directionsSvc || this.directionsDisabled) {
      this.roadPath = pts.slice();
      this.redrawPath();
      if (this.wizardStep >= 2) this.fitRouteViewport();
      return;
    }
    const origin = pts[0];
    const destination = pts[pts.length - 1];
    const waypoints = pts.slice(1, -1).map((p) => ({ location: new google.maps.LatLng(p.lat, p.lng), stopover: false }));
    this.directionsSvc!.route(
      { origin, destination, waypoints, travelMode: google.maps.TravelMode.DRIVING },
      (res: any, status: any) => {
        if (seq !== this.routeSeq) return;
        if (status === 'OK' && res?.routes?.[0]?.overview_path) {
          this.roadPath = res.routes[0].overview_path.map((ll: any) => ({ lat: ll.lat(), lng: ll.lng() }));
        } else {
          if (status === 'REQUEST_DENIED') {
            this.directionsDisabled = true;
            this.toast.error('Road routing unavailable (enable Directions API) — using a straight path.');
          }
          this.roadPath = pts.slice();
        }
        this.redrawPath();
        if (this.wizardStep >= 2) {
          this.fitRouteViewport();
        }
      },
    );
  }

  private pointInPolygon(lat: number, lng: number, poly: LatLng[]): boolean {
    if (poly.length < 3) return true;
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].lng, yi = poly[i].lat, xj = poly[j].lng, yj = poly[j].lat;
      const intersect = ((yi > lat) !== (yj > lat)) && (lng < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  private validatePlacement(lat: number, lng: number, kind: MapTool): { ok: boolean; msg?: string } {
    if (this.cityBoundary.length < 3) return { ok: true };
    const inside = this.pointInPolygon(lat, lng, this.cityBoundary);
    if (this.form.scope === 'local') {
      return inside ? { ok: true } : { ok: false, msg: 'Local fixed routes must stay inside the city service area.' };
    }
    if (kind === 'origin') return inside ? { ok: true } : { ok: false, msg: 'Outstation start must be inside the city.' };
    if (kind === 'dest') return !inside ? { ok: true } : { ok: false, msg: 'Outstation destination must be outside the city.' };
    return { ok: true };
  }

  private reverseGeocode(lat: number, lng: number, which: 'origin' | 'dest'): void {
    const seq = this.geocodeSeq;
    this.geocoder?.geocode({ location: { lat, lng } }, (results, statusStr) => {
      if (seq !== this.geocodeSeq || !this.map || !this.open) return;
      if (statusStr === 'OK' && results && results.length) {
        const name = this.bestGeocodeStopName(results) || results[0].formatted_address.split(',')[0].trim();
        if (which === 'origin' && !this.form.origin_name.trim()) this.form.origin_name = name;
        if (which === 'dest' && !this.form.dest_name.trim()) this.form.dest_name = name;
        this.maybeAutoName();
      }
    });
  }

  private reverseGeocodeStop(stop: RouteStopRow): void {
    if (stop.lat == null || stop.lng == null) return;
    if (stop.name.trim() && !this.isBadStopName(stop.name)) return;
    this.resolveNearbyStopName(stop, (name) => {
      if (!this.map || !this.open) return;
      if (!stop.name.trim() || this.isBadStopName(stop.name)) stop.name = name;
    });

  }

  private resolveNearbyStopName(stop: RouteStopRow, done: (name: string) => void): void {
    if (stop.lat == null || stop.lng == null) return;
    const lat = stop.lat;
    const lng = stop.lng;
    const fallback = () => this.resolveGeocodeStopName(stop, done);
    if (!this.placesSvc || typeof google === "undefined" || !google.maps?.places) { fallback(); return; }

    this.placesSvc.nearbySearch({ location: new google.maps.LatLng(lat, lng), radius: 100 }, (places, status) => {
      if (!this.map || !this.open) return;
      const ok = status === google.maps.places.PlacesServiceStatus.OK;
      const name = ok ? this.bestNearbyStopName(places || [], lat, lng) : "";
      if (name) done(name);
      else fallback();
    });
  }

  private resolveGeocodeStopName(stop: RouteStopRow, done: (name: string) => void): void {
    if (stop.lat == null || stop.lng == null) return;
    this.geocoder?.geocode({ location: { lat: stop.lat, lng: stop.lng } }, (results, statusStr) => {
      if (!this.map || !this.open) return;
      const name = statusStr === "OK" ? this.bestGeocodeStopName(results || []) : "";
      done(name || this.fallbackStopName(stop));
    });
  }

  private bestNearbyStopName(places: google.maps.places.PlaceResult[], lat: number, lng: number): string {
    const valid = places
      .map((place) => {
        const name = this.extractLegitimateLocationName(place);
        const loc = place.geometry?.location;
        const distance = loc ? this.distanceMeters(lat, lng, loc.lat(), loc.lng()) : Number.POSITIVE_INFINITY;
        return { name, distance, isCommercial: this.isCommercialRetailPlace(place) };
      })
      .filter((item) => item.name && !this.isBadStopName(item.name) && item.distance <= 150)
      .sort((a, b) => {
        if (a.isCommercial !== b.isCommercial) return a.isCommercial ? 1 : -1;
        return a.distance - b.distance;
      });
    return valid[0]?.name || '';
  }

  private bestGeocodeStopName(results: google.maps.GeocoderResult[]): string {
    for (const result of results) {
      if (result.address_components) {
        // Priority 1: sublocality / neighborhood
        const subloc = result.address_components.find((c) =>
          c.types.includes('sublocality_level_1') || c.types.includes('sublocality') || c.types.includes('neighborhood')
        );
        if (subloc?.long_name && !this.isBadStopName(subloc.long_name)) {
          return this.cleanStopName(subloc.long_name);
        }

        // Priority 2: intersection / route
        const routeComp = result.address_components.find((c) => c.types.includes('intersection') || c.types.includes('route'));
        if (routeComp?.long_name && !this.isBadStopName(routeComp.long_name)) {
          return this.cleanStopName(routeComp.long_name);
        }

        // Priority 3: locality
        const loc = result.address_components.find((c) => c.types.includes('locality'));
        if (loc?.long_name && !this.isBadStopName(loc.long_name)) {
          return this.cleanStopName(loc.long_name);
        }
      }

      const parts = (result.formatted_address || '')
        .split(',')
        .map((part) => this.cleanStopName(part))
        .filter((part) => part && !this.isBadStopName(part) && !/^\d{5,6}$/.test(part) && !/^india$/i.test(part));
      if (parts.length) return parts[0];
    }
    return '';
  }

  private cleanStopName(name: string): string {
    return (name || "")
      .replace(/\b[A-Z0-9]{4,}\+[A-Z0-9]{2,}\b,?\s*/gi, "")
      .replace(/\s+/g, " ")
      .replace(/^[,.\-\s]+|[,.\-\s]+$/g, "")
      .trim();
  }

  private isBadStopName(name: string): boolean {
    const value = this.cleanStopName(name);
    if (!value || value.length < 2) return true;
    if (/^stop\s*\d*$/i.test(value)) return true;
    if (/^unnamed/i.test(value)) return true;
    if (/^-?\d{1,2}\.\d+,\s*-?\d{1,3}\.\d+$/.test(value)) return true;
    if (/\b[A-Z0-9]{4,}\+[A-Z0-9]{2,}\b/i.test(name)) return true;

    // Filter out petty commercial shops, retail outlets, and market stalls:
    const commercialShopPattern = /\b(shop|store|mart|supermarket|kirana|general store|cloth house|clothing|garments|tailor|tailoring|boutique|bakery|bakers|sweets|confectionery|restaurant|dhaba|cafe|tea stall|saloon|salon|beauty parlour|barber|auto works|service station|tyre|puncture|hardware|sanitary|jeweller|jewellers|jewellery|footwear|shoes|shoe house|mobile care|mobile shop|telecom|electronics|electricals|optical|opticals|medical hall|medicos|pharmacy|chemist|clinic|dental|snack bar|point|centre|center|enterprise|enterprises|traders|agency|agencies|dealers|distributors|wholesaler|dry cleaners|laundry)\b/i;

    // Transit, civic, and community landmark exceptions:
    const transitCivicExceptions = /\b(bus stand|bus stop|railway station|train station|airport|terminal|chowk|crossing|junction|bypass|flyover|bridge|pul|morh|gate|stand|hospital|medical college|college|university|school|institute|court|secretariat|police station|cantonment|sector|phase|colony|nagar|puram|town|village|mohalla|bazar chowk|market gate)\b/i;

    if (commercialShopPattern.test(value) && !transitCivicExceptions.test(value)) {
      return true;
    }

    return false;
  }

  private normalizedRouteName(name: string, origin: string, dest: string): string {
    const cleaned = this.cleanStopName(name).replace(/\s+/g, ' ').trim();
    if (cleaned && !this.isBadRouteName(cleaned)) return cleaned;
    const start = this.cleanStopName(origin) || 'Start';
    const end = this.cleanStopName(dest) || 'Destination';
    return start + ' → ' + end;
  }

  private isBadRouteName(name: string): boolean {
    const value = this.cleanStopName(name);
    if (!value || value.length < 3) return true;
    if (this.isBadStopName(value)) return true;
    if (/^[\d\s,.\-→>]+$/.test(value)) return true;
    if (/\b[A-Z0-9]{4,}\+[A-Z0-9]{2,}\b/i.test(name)) return true;
    return false;
  }
  private normalizedStopName(stop: RouteStopRow, index: number): string {
    const cleaned = this.cleanStopName(stop.name || "");
    return cleaned && !this.isBadStopName(cleaned) ? cleaned : "Stop " + (index + 1);
  }

  private fallbackStopName(stop: RouteStopRow): string {
    const index = this.form.stops.indexOf(stop);
    return "Stop " + (index >= 0 ? index + 1 : this.form.stops.length + 1);
  }

  private distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const earthM = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return earthM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  private endpointMarker(pos: LatLng, color: string, label: string): google.maps.Marker {
    return new google.maps.Marker({
      position: pos, map: this.map!, draggable: true,
      label: { text: label, color: '#fff', fontSize: '11px', fontWeight: '700' },
      icon: { path: google.maps.SymbolPath.CIRCLE, scale: 11, fillColor: color, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 },
    });
  }

  private redrawOrigin(): void {
    if (!this.map) return;
    if (this.form.origin_lat == null) { this.originMarker?.setMap(null); this.originMarker = null; return; }
    const pos = { lat: this.form.origin_lat, lng: this.form.origin_lng as number };
    if (!this.originMarker) {
      this.originMarker = this.endpointMarker(pos, '#16a34a', 'A');
      this.originMarker.addListener('dragend', (e: google.maps.MapMouseEvent) => {
        if (!e.latLng) return;
        const lat = e.latLng.lat(), lng = e.latLng.lng();
        const v = this.validatePlacement(lat, lng, 'origin');
        if (!v.ok) { this.toast.error(v.msg!); this.redrawOrigin(); return; }
        this.form.origin_lat = lat; this.form.origin_lng = lng; this.recomputeRoadPath();
      });
    } else { this.originMarker.setPosition(pos); }
  }

  private redrawDest(): void {
    if (!this.map) return;
    if (this.form.dest_lat == null) { this.destMarker?.setMap(null); this.destMarker = null; return; }
    const pos = { lat: this.form.dest_lat, lng: this.form.dest_lng as number };
    if (!this.destMarker) {
      this.destMarker = this.endpointMarker(pos, '#ef4444', 'B');
      this.destMarker.addListener('dragend', (e: google.maps.MapMouseEvent) => {
        if (!e.latLng) return;
        const lat = e.latLng.lat(), lng = e.latLng.lng();
        const v = this.validatePlacement(lat, lng, 'dest');
        if (!v.ok) { this.toast.error(v.msg!); this.redrawDest(); return; }
        this.form.dest_lat = lat; this.form.dest_lng = lng; this.recomputeRoadPath();
      });
    } else { this.destMarker.setPosition(pos); }
  }

  private redrawPath(): void {
    if (!this.map) return;
    this.pathLine?.setMap(null); this.pathLine = null;
    this.pathDots.forEach((m) => m.setMap(null)); this.pathDots = [];

    const line = this.roadPath.length ? this.roadPath : this.form.path;
    if (line.length) {
      // Only the hand-drawn path gets vertex handles; a picked Google route is
      // shown as-is so the operator swaps options instead of nudging 300 points.
      const isEditable = this.tool === 'path' && this.pathMode === 'free';
      this.pathLine = new google.maps.Polyline({
        path: line, map: this.map, geodesic: true,
        strokeColor: '#12B35B', strokeOpacity: 0.95, strokeWeight: 6,
        editable: isEditable, zIndex: 5,
      });

      if (isEditable && this.pathLine) {
        const polyPath = this.pathLine.getPath();
        const updateFromPolyline = this.pathMode === 'free'
          ? () => this.syncFreeFromPolyline(polyPath)
          : () => {
              const arr = polyPath.getArray();
              this.roadPath = arr.map((ll) => ({ lat: ll.lat(), lng: ll.lng() }));
              this.pathLocked = true;
            };
        google.maps.event.addListener(polyPath, 'set_at', updateFromPolyline);
        google.maps.event.addListener(polyPath, 'insert_at', updateFromPolyline);
        google.maps.event.addListener(polyPath, 'remove_at', updateFromPolyline);
      }
    }
    // Road mode shows draggable dots for each clicked waypoint. Free mode relies on
    // the editable line's own vertex handles (drag to move, drag midpoint to insert,
    // right-click to delete) so we don't render duplicate handles on top of them.
    if (this.pathMode === 'free') return;
    this.form.path.forEach((p, i) => {
      const dot = new google.maps.Marker({
        position: p, map: this.map!, draggable: true,
        icon: { path: google.maps.SymbolPath.CIRCLE, scale: 5.5, fillColor: '#0f5132', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 },
        title: `Path point ${i + 1} (drag to move)`,
      });
      dot.addListener('dragend', (e: google.maps.MapMouseEvent) => {
        if (e.latLng) {
          this.form.path[i] = { lat: e.latLng.lat(), lng: e.latLng.lng() };
          this.pathLocked = false;
          this.recomputeRoadPath();
        }
      });
      this.pathDots.push(dot);
    });
  }

  resnapPath(): void {
    this.pathLocked = false;
    this.recomputeRoadPath();
  }

  private redrawStops(): void {
    if (!this.map) return;
    this.stopMarkers.forEach((m) => m.setMap(null)); this.stopMarkers = [];
    this.form.stops.forEach((s, i) => {
      if (s.lat == null || s.lng == null) return;
      const color = s.is_temporarily_unavailable ? '#b91c1c' : '#4338ca';
      const m = new google.maps.Marker({
        position: { lat: s.lat, lng: s.lng }, map: this.map!, draggable: true,
        label: { text: String(i + 1), color: '#fff', fontSize: '11px', fontWeight: '700' },
        icon: { path: google.maps.SymbolPath.CIRCLE, scale: 14, fillColor: color, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3 },
      });
      m.addListener('dragend', (e: google.maps.MapMouseEvent) => {
        if (!e.latLng) return;
        const lat = e.latLng.lat(), lng = e.latLng.lng();
        const roadPoint = this.snapToRoutePath({ lat, lng });
        if (!roadPoint) { this.toast.error('Move the stop on or very near the green route line.'); this.redrawStops(); return; }
        const v = this.validatePlacement(roadPoint.lat, roadPoint.lng, 'stop');
        if (!v.ok) { this.toast.error(v.msg!); this.redrawStops(); return; }
        s.lat = roadPoint.lat; s.lng = roadPoint.lng;
        if (!s.name.trim() || this.isBadStopName(s.name)) this.reverseGeocodeStop(s);
      });
      this.stopMarkers.push(m);
    });
  }

  private snapToRoutePath(point: LatLng): LatLng {
    const path = this.currentRoutePath();
    if (path.length < 2) return point;
    let best: { point: LatLng; distance: number } | null = null;
    for (let i = 0; i < path.length - 1; i++) {
      const candidate = this.projectPointToSegment(point, path[i], path[i + 1]);
      if (!best || candidate.distance < best.distance) best = candidate;
    }
    return best ? best.point : point;
  }

  private currentRoutePath(): LatLng[] {
    const path = this.roadPath.length ? this.roadPath : [
      this.form.origin_lat != null ? { lat: this.form.origin_lat, lng: this.form.origin_lng as number } : null,
      ...this.form.path,
      this.form.dest_lat != null ? { lat: this.form.dest_lat, lng: this.form.dest_lng as number } : null,
    ].filter((p): p is LatLng => !!p);
    return path.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  }

  private projectPointToSegment(point: LatLng, a: LatLng, b: LatLng): { point: LatLng; distance: number } {
    const metersPerLat = 111320;
    const metersPerLng = Math.max(1, 111320 * Math.cos(point.lat * Math.PI / 180));
    const ax = (a.lng - point.lng) * metersPerLng;
    const ay = (a.lat - point.lat) * metersPerLat;
    const bx = (b.lng - point.lng) * metersPerLng;
    const by = (b.lat - point.lat) * metersPerLat;
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lenSq)) : 0;
    const x = ax + dx * t;
    const y = ay + dy * t;
    return {
      point: { lat: point.lat + y / metersPerLat, lng: point.lng + x / metersPerLng },
      distance: Math.sqrt(x * x + y * y),
    };
  }

  removeStop(index: number): void {
    if (index < 0 || index >= this.form.stops.length) return;
    const [stop] = this.form.stops.splice(index, 1);
    if (stop?.id) {
      this.restoredStopIds.delete(Number(stop.id));
      stop.is_active = false;
      stop.is_temporarily_unavailable = true;
      stop.unavailable_reason = 'Removed from active route by admin.';
      this.removedStops = [...this.removedStops, stop];
    }
    if (stop?.name) {
      const norm = this.cleanStopName(stop.name).toLowerCase();
      const found = this.suggestedStops.find((s) => this.cleanStopName(s.name).toLowerCase() === norm);
      if (found) found.added = false;
    }
    this.redrawStops();
  }

  restoreStop(index: number): void {
    this.selectedRemovedStopIndexes.clear();
    this.selectedRemovedStopIndexes.add(index);
    this.addSelectedRemovedStops();
  }

  undoPath(): void { this.pathLocked = false; this.form.path.pop(); this.recomputeRoadPath(); }
  clearPath(): void { if (this.hasRouteDraftData) this.clearPathConfirmOpen = true; }

  confirmClearPath(): void {
    this.clearPathConfirmOpen = false;
    this.routeSeq++;
    this.snapSeqOrigin++;
    this.snapSeqDest++;
    this.geocodeSeq++;
    this.form = this.blankForm();
    this.roadPath = [];
    this.pathLocked = false;
    this.pathMode = 'road';
    this.clearAlternatives();
    this.directionsDisabled = false;
    this.tool = 'origin';
    this.redrawOrigin();
    this.redrawDest();
    this.redrawPath();
    this.redrawStops();
  }

  fitOriginView(): void {
    if (!this.map) return;
    if (this.form.origin_lat != null && this.form.origin_lng != null) {
      this.map.panTo({ lat: this.form.origin_lat, lng: this.form.origin_lng });
      this.map.setZoom(16);
    } else if (this.cityCenter) {
      this.map.panTo(this.cityCenter);
      this.map.setZoom(14);
    }
  }

  fitRouteViewport(padding = 70): void {
    if (!this.map) return;
    const pts: LatLng[] = [];
    if (this.form.origin_lat != null && this.form.origin_lng != null) {
      pts.push({ lat: this.form.origin_lat, lng: this.form.origin_lng });
    }
    if (this.form.dest_lat != null && this.form.dest_lng != null) {
      pts.push({ lat: this.form.dest_lat, lng: this.form.dest_lng });
    }
    if (this.roadPath.length) {
      pts.push(...this.roadPath);
    } else if (this.form.path.length) {
      pts.push(...this.form.path);
    }
    this.form.stops.forEach((s) => {
      if (s.lat != null && s.lng != null) pts.push({ lat: s.lat, lng: s.lng });
    });

    if (pts.length < 2) {
      this.fitOriginView();
      return;
    }

    const b = new google.maps.LatLngBounds();
    pts.forEach((p) => b.extend(p));
    this.map.fitBounds(b, padding);
  }

  private fitToContent(padding = 70): void {
    this.fitRouteViewport(padding);
  }

  private teardownMap(): void {
    this.mapListeners.forEach((l) => l.remove()); this.mapListeners = [];
    (this.autocomplete as any)?.unbindAll?.(); this.autocomplete = null;
    (this.originAutocomplete as any)?.unbindAll?.(); this.originAutocomplete = null;
    (this.destAutocomplete as any)?.unbindAll?.(); this.destAutocomplete = null;
    this.clearSearchMarker();
    this.originMarker?.setMap(null); this.originMarker = null;
    this.destMarker?.setMap(null); this.destMarker = null;
    this.pathLine?.setMap(null); this.pathLine = null;
    this.pathDots.forEach((m) => m.setMap(null)); this.pathDots = [];
    this.stopMarkers.forEach((m) => m.setMap(null)); this.stopMarkers = [];
    this.boundaryPoly?.setMap(null); this.boundaryPoly = null;
    this.clearAlternatives();
    this.map = null; this.geocoder = null; this.directionsSvc = null; this.placesSvc = null;
    this.roadPath = [];
  }

  submit(): void {
    if (!this.formValid || this.saving || this.cityId == null) return;
    const f = this.form;

    if (this.cityBoundary.length >= 3) {
      const vo = this.validatePlacement(f.origin_lat as number, f.origin_lng as number, 'origin');
      if (!vo.ok) { this.toast.error(vo.msg!); return; }
      const vd = this.validatePlacement(f.dest_lat as number, f.dest_lng as number, 'dest');
      if (!vd.ok) { this.toast.error(vd.msg!); return; }
    }

    const stops = [
      {
        id: f.origin_stop_id ?? undefined,
        seq: 1,
        name: this.cleanStopName(f.origin_name) || f.origin_name.trim(),
        lat: f.origin_lat,
        lng: f.origin_lng,
        is_pickup: true,
        is_drop: false,
        is_active: true,
        is_temporarily_unavailable: false,
        unavailable_reason: null,
      },
      ...f.stops.filter((s) => s.lat != null && s.lng != null).map((s, i) => ({
        id: s.id,
        seq: i + 2,
        name: this.normalizedStopName(s, i),
        lat: s.lat,
        lng: s.lng,
        is_pickup: s.is_pickup || (!s.is_pickup && !s.is_drop),
        is_drop: s.is_drop || (!s.is_pickup && !s.is_drop),
        is_active: this.editingId ? s.is_active : true,
        is_temporarily_unavailable: this.editingId ? s.is_temporarily_unavailable : false,
        unavailable_reason: this.editingId && s.is_temporarily_unavailable ? (s.unavailable_reason?.trim() || 'Paused by admin.') : null,
      })),
      {
        id: f.dest_stop_id ?? undefined,
        seq: f.stops.length + 2,
        name: this.cleanStopName(f.dest_name) || f.dest_name.trim(),
        lat: f.dest_lat,
        lng: f.dest_lng,
        is_pickup: false,
        is_drop: true,
        is_active: true,
        is_temporarily_unavailable: false,
        unavailable_reason: null,
      },
    ];

    const path_polyline = this.roadPath.length ? this.roadPath.map((p) => [p.lat, p.lng]) : (f.path.length ? f.path.map((p) => [p.lat, p.lng]) : null);

    const body: Record<string, unknown> = {
      scope: f.scope,
      origin_city_id: f.scope === 'outstation' ? f.origin_city_id : null,
      dest_city_id: f.scope === 'outstation' ? f.dest_city_id : null,
      name: this.normalizedRouteName(f.name, f.origin_name, f.dest_name),
      origin_name: this.cleanStopName(f.origin_name) || f.origin_name.trim(),
      dest_name: this.cleanStopName(f.dest_name) || f.dest_name.trim(),
      origin_lat: f.origin_lat,
      origin_lng: f.origin_lng,
      dest_lat: f.dest_lat,
      dest_lng: f.dest_lng,
      path_polyline,
      city_vehicle_type_id: this.cityVehicleTypeId ?? f.city_vehicle_type_id,
      max_luggage_per_vehicle: f.max_luggage_per_vehicle,
      booking_window_hours: f.booking_window_hours,
      waiting_time_per_stop_minutes: f.waiting_time_per_stop_minutes,
      luggage_surcharge_amount: f.luggage_surcharge_amount,
      fixed_settings_json: {
        auto_no_show_enabled: true,
        stop_arrival_radius_m: Number(f.stop_arrival_radius_m ?? 150),
        driver_missed_stop_grace_minutes: Number(f.driver_missed_stop_grace_minutes ?? 3),
        customer_pickup_radius_m: Number(f.customer_pickup_radius_m ?? 150),
        vehicle_approaching_alert_radius_m: Number(f.vehicle_approaching_alert_radius_m ?? 500),
        customer_grace_minutes: Number(f.customer_grace_minutes ?? 2),
        boarding_confirmation_mode: f.boarding_confirmation_mode ?? 'driver_only',
      },
      is_active: this.editingId ? f.is_active : true,
      sort_order: f.sort_order ?? 0,
      fare_config: {
        seat_fare: f.seat_fare,
        commission_type: f.commission_type,
        commission_percent: f.commission_type === 'percent' ? (f.commission_percent ?? 0) : 0,
        fixed_commission: f.commission_type === 'fixed' ? (f.fixed_commission ?? 0) : 0,
      },
      stops,
    };

    const availabilityMessage = this.stopAvailabilityChangeMessage();
    if (availabilityMessage) {
      this.pendingStopAvailabilityBody = body;
      this.stopAvailabilityConfirmMessage = availabilityMessage;
      this.stopAvailabilityConfirmOpen = true;
      return;
    }

    this.persistRoute(body);
  }

  cancelStopAvailabilityConfirm(): void {
    this.stopAvailabilityConfirmOpen = false;
    this.stopAvailabilityConfirmMessage = '';
    this.pendingStopAvailabilityBody = null;
  }

  confirmStopAvailabilitySave(): void {
    const body = this.pendingStopAvailabilityBody;
    this.stopAvailabilityConfirmOpen = false;
    this.stopAvailabilityConfirmMessage = '';
    this.pendingStopAvailabilityBody = null;
    if (body) this.persistRoute(body);
  }

  private stopAvailabilityChangeMessage(): string | null {
    if (!this.editingId) return null;
    const paused: string[] = [];
    const resumed: string[] = [];

    this.form.stops.forEach((stop, index) => {
      if (!stop.id) return;
      const before = this.originalStopBookable.get(Number(stop.id));
      if (before === undefined) return;
      const after = this.isStopBookable(stop);
      if (before === after) return;
      const name = (stop.name || `Stop ${index + 1}`).trim();
      if (after) resumed.push(name);
      else paused.push(name);
    });

    const lines: string[] = [];
    if (resumed.length) lines.push(`${this.stopListLabel(resumed)} will be available for customer boarding and drop selection.`);
    if (paused.length) lines.push(`${this.stopListLabel(paused)} will be unavailable for customer boarding and drop selection.`);
    return lines.length ? lines.join(' ') : null;
  }

  private stopListLabel(stops: string[]): string {
    if (stops.length === 1) return `Stop ${stops[0]}`;
    if (stops.length <= 3) return `Stops ${stops.join(', ')}`;
    return `${stops.length} selected stops`;
  }

  private persistRoute(body: Record<string, unknown>): void {
    if (this.cityId == null) return;
    this.saving = true;
    const base = `/admin/cities/${this.cityId}/fixed-routes`;
    const req = this.editingId
      ? this.api.patch<{ route: FixedRouteRow }>(`${base}/${this.editingId}`, body)
      : this.api.post<{ route: FixedRouteRow }>(base, body);

    req.subscribe({
      next: async (res) => {
        const createdRoute = res?.route ?? (res as any)?.data;
        const routeId = this.editingId || createdRoute?.id;

        if (routeId && this.cityId != null && (!this.editingId || this.assignmentSignature() !== this.originalAssignments)) {
          if (this.form.assigned_group_id === 'new' && this.form.new_group_name.trim()) {
            try {
              const groupRes = await firstValueFrom(
                this.api.post<{ route_group?: any; data?: any }>(`/admin/cities/${this.cityId}/route-groups`, {
                  name: this.form.new_group_name.trim(),
                  city_vehicle_type_id: this.form.city_vehicle_type_id,
                  route_ids: [routeId],
                })
              );
              const newGroupId = groupRes?.route_group?.id ?? groupRes?.data?.id;
              if (newGroupId && this.form.assigned_driver_ids.length > 0) {
                await firstValueFrom(
                  this.api.put(`/admin/cities/${this.cityId}/route-groups/${newGroupId}/drivers`, {
                    driver_user_ids: this.form.assigned_driver_ids,
                  })
                );
              }
            } catch {}
          } else if (typeof this.form.assigned_group_id === 'number') {
            const existingGroup = this.groups.find((g) => g.id === this.form.assigned_group_id);
            if (existingGroup) {
              const updatedRouteIds = Array.from(new Set([...existingGroup.route_ids, routeId]));
              try {
                await firstValueFrom(
                  this.api.patch(`/admin/cities/${this.cityId}/route-groups/${existingGroup.id}`, {
                    name: existingGroup.name,
                    city_vehicle_type_id: existingGroup.vehicle_type_id ?? this.form.city_vehicle_type_id,
                    route_ids: updatedRouteIds,
                  })
                );
                if (this.form.assigned_driver_ids.length > 0) {
                  const updatedDriverIds = Array.from(new Set([...(existingGroup.driver_user_ids || []), ...this.form.assigned_driver_ids]));
                  await firstValueFrom(
                    this.api.put(`/admin/cities/${this.cityId}/route-groups/${existingGroup.id}/drivers`, {
                      driver_user_ids: updatedDriverIds,
                    })
                  );
                }
              } catch {}
            }
          }

          // Routes can belong to multiple stands. Removing memberships belongs
          // to stand management, never an unrelated route/name edit.
        }

        this.saving = false;
        this.closeEditor();
        this.toast.success(this.editingId ? 'Fixed route updated successfully' : 'Fixed route created and published');
        this.loadGroupsAndDrivers();
        this.fetchRoutes();
        this.routesChanged.emit();
      },
      error: (err) => {
        this.saving = false;
        this.toast.error(err?.error?.message || 'Save failed');
      },
    });
  }
}
