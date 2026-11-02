import { Component, DestroyRef, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { of, switchMap, map, catchError, forkJoin, Observable } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { ButtonComponent, IconComponent, ModalComponent } from '../../ui';
import { MasterDriver, MasterGroup, MasterRoute, MasterRouteStop, MasterVehicle } from './master-explorer.component';

@Component({
  selector: 'app-route-copy', standalone: true,
  imports: [CommonModule, FormsModule, ButtonComponent, ModalComponent, IconComponent],
  template: `
    <tm-modal [open]="true" [title]="reverse ? 'Copy as reverse' : 'Copy route'" [dismissible]="!saving" [showClose]="!saving" (closed)="close()">
      <form slot="body" class="copy-form" (ngSubmit)="save()">
        <div class="direction-banner" [class.is-reverse]="reverse">
          <span class="direction-badge">
            <tm-icon [name]="reverse ? 'refresh' : 'copy'" [size]="13" />
            {{ reverse ? 'Reverse corridor' : 'Direct copy' }}
          </span>
          <div class="direction-endpoints">
            <strong>{{ originName }}</strong>
            <tm-icon name="arrow-right" [size]="15" />
            <strong>{{ destName }}</strong>
          </div>
        </div>

        <div class="form-field">
          <label for="copied-route-name">New route name</label>
          <input id="copied-route-name" name="routeName" [(ngModel)]="name" required maxlength="120" [disabled]="saving" placeholder="Enter route name…" />
        </div>

        <section class="copy-review" aria-label="Details being copied">
          <header class="review-header">
            <span class="review-icon"><tm-icon name="copy" [size]="14" /></span>
            <div>
              <h3>Review details to be copied</h3>
              <p>Copied from {{ route.name }}</p>
            </div>
          </header>

          <div class="review-grid">
            <div class="review-cell">
              <span class="cell-label"><tm-icon name="rupee" [size]="13" /> Fare / seat</span>
              <strong class="cell-val">{{ route.flat_fare ? '₹' + route.flat_fare : 'Not configured' }}</strong>
            </div>
            <div class="review-cell">
              <span class="cell-label"><tm-icon name="car" [size]="13" /> Vehicle option</span>
              <strong class="cell-val">{{ vehicleName }}</strong>
            </div>
            <div class="review-cell">
              <span class="cell-label"><tm-icon name="map-marker" [size]="13" /> Service area</span>
              <strong class="cell-val">{{ route.scope === 'local' ? 'Local' : 'Outstation' }}</strong>
            </div>
            <div class="review-cell">
              <span class="cell-label"><tm-icon name="road" [size]="13" /> Stops</span>
              <strong class="cell-val">{{ displayStops.length }} stops {{ reverse ? '(reversed)' : '' }}</strong>
            </div>
          </div>

          <div class="stops-preview" *ngIf="displayStops.length">
            <span class="stops-preview-title">Stop sequence ({{ reverse ? 'reversed order' : 'route order' }}):</span>
            <ol class="stops-chips">
              <li *ngFor="let stop of displayStops; let index = index" [class.is-endpoint]="index === 0 || index === displayStops.length - 1">
                <span class="chip-num">{{ index + 1 }}</span>
                <span class="chip-name">{{ stop.name || 'Stop ' + (index + 1) }}</span>
                <em class="chip-tag" *ngIf="index === 0">Start</em>
                <em class="chip-tag" *ngIf="index === displayStops.length - 1 && index !== 0">End</em>
              </li>
            </ol>
          </div>
        </section>

        <!-- STAND ALLOCATION SECTION (CARD MULTISELECT) -->
        <section class="allocation-section" aria-label="Stand and driver allocation">
          <header class="allocation-header">
            <span class="allocation-icon"><tm-icon name="folder" [size]="14" /></span>
            <div class="allocation-title-wrap">
              <h3>Stand &amp; driver allocation</h3>
              <p>Select stands to add this route to multiple stands. Starts unassigned by default.</p>
            </div>
            <span class="count-pill" *ngIf="selectedGroupIds.size > 0">
              {{ selectedGroupIds.size }} stand{{ selectedGroupIds.size > 1 ? 's' : '' }} selected
            </span>
          </header>

          <div class="stands-box">
            <div class="stands-toolbar" *ngIf="groups.length > 2">
              <div class="stand-filter-input" *ngIf="groups.length > 4">
                <tm-icon name="search" [size]="13" />
                <input type="text" [(ngModel)]="standSearch" name="standSearch" placeholder="Search stands…" [disabled]="saving" />
                <button type="button" class="clear-btn" *ngIf="standSearch" (click)="standSearch = ''">✕</button>
              </div>
              <div class="stands-quick-actions">
                <button type="button" class="action-btn" (click)="selectAllGroups()" [disabled]="saving">Select all</button>
                <span class="action-divider">·</span>
                <button type="button" class="action-btn" (click)="clearAllGroups()" [disabled]="saving">Clear</button>
              </div>
            </div>

            <!-- Stand Cards Grid (Card-like multi-select) -->
            <div class="stands-cards-grid">
              <button
                type="button"
                *ngFor="let g of filteredGroups"
                class="stand-card"
                [class.is-selected]="isGroupSelected(g.id)"
                [disabled]="saving"
                (click)="toggleGroup(g)"
                [attr.aria-pressed]="isGroupSelected(g.id)">
                <span class="stand-card-icon"><tm-icon name="folder" [size]="15" /></span>
                <div class="stand-card-info">
                  <strong class="stand-card-name">{{ g.name }}</strong>
                  <small class="stand-card-sub">{{ g.route_ids.length }} routes · {{ g.driver_user_ids.length }} drivers</small>
                </div>
                <span class="stand-card-check" *ngIf="isGroupSelected(g.id)">
                  <tm-icon name="check" [size]="14" />
                </span>
              </button>

              <!-- "+ New Stand" Card -->
              <button
                type="button"
                class="stand-card stand-card-new"
                [class.is-selected]="createNewStand"
                [disabled]="saving"
                (click)="toggleNewStand()"
                [attr.aria-pressed]="createNewStand">
                <span class="stand-card-icon"><tm-icon name="plus" [size]="15" /></span>
                <div class="stand-card-info">
                  <strong class="stand-card-name">+ New stand</strong>
                  <small class="stand-card-sub">Create &amp; bundle</small>
                </div>
                <span class="stand-card-check" *ngIf="createNewStand">
                  <tm-icon name="check" [size]="14" />
                </span>
              </button>
            </div>

            <p class="no-stands-hint" *ngIf="!filteredGroups.length && groups.length">
              No stands matching "{{ standSearch }}"
            </p>
          </div>

          <!-- New stand name input field when "+ New stand" card is selected -->
          <div class="form-field new-stand-field" *ngIf="createNewStand">
            <label for="new-stand-name">New stand name</label>
            <input id="new-stand-name" name="newStandName" [(ngModel)]="newGroupName" required maxlength="120" [disabled]="saving" placeholder="Enter new stand name…" />
          </div>

          <!-- Drivers assignment: shown when 1 or more stands are selected -->
          <div class="drivers-box" *ngIf="hasStandsSelected">
            <div class="drivers-head">
              <div class="drivers-title-wrap">
                <span class="drivers-title">Assign drivers across selected stands</span>
                <span class="count-pill" *ngIf="drivers.length">{{ assignedDriverUserIds.length }} / {{ drivers.length }} selected</span>
              </div>
              <div class="drivers-actions" *ngIf="drivers.length">
                <button type="button" class="action-btn" (click)="selectAllDrivers()" [disabled]="saving">Select all</button>
                <span class="action-divider">·</span>
                <button type="button" class="action-btn" (click)="deselectAllDrivers()" [disabled]="saving">Deselect all</button>
              </div>
            </div>

            <div class="driver-filter-input" *ngIf="drivers.length > 3">
              <tm-icon name="search" [size]="13" />
              <input type="text" [(ngModel)]="driverSearch" name="driverSearch" placeholder="Filter drivers by name, phone or vehicle…" [disabled]="saving" />
              <button type="button" class="clear-btn" *ngIf="driverSearch" (click)="driverSearch = ''">✕</button>
            </div>

            <div class="drivers-list" *ngIf="filteredDrivers.length; else noDriversCue">
              <label *ngFor="let d of filteredDrivers" class="driver-item" [class.is-checked]="isDriverSelected(d.user_id)">
                <input type="checkbox" [checked]="isDriverSelected(d.user_id)" (change)="toggleDriver(d.user_id)" [disabled]="saving" />
                <span class="driver-avatar">
                  <img *ngIf="d.avatar_url" [src]="d.avatar_url" [alt]="d.name" (error)="d.avatar_url = null" />
                  <span *ngIf="!d.avatar_url">{{ initials(d.name) }}</span>
                </span>
                <span class="driver-info">
                  <strong class="driver-name">{{ d.name }}</strong>
                  <small class="driver-meta">{{ d.vehicle_reg_no || d.vehicle_model || (d.phone ? d.phone : 'Driver #' + d.id) }}</small>
                </span>
              </label>
            </div>
            <ng-template #noDriversCue>
              <p class="no-drivers-hint">{{ driverSearch ? 'No drivers matching "' + driverSearch + '"' : 'No registered drivers found in this city.' }}</p>
            </ng-template>
          </div>

          <div class="stand-hint-note" *ngIf="!hasStandsSelected">
            <tm-icon name="shield" [size]="13" />
            <span>Copied route starts unassigned. Click one or more stand cards above to allocate stands and drivers, or allocate them later from Stand management.</span>
          </div>
        </section>

        <div class="active-toggle-card">
          <label class="active-checkbox-label">
            <input type="checkbox" [(ngModel)]="isActive" name="isActive" [disabled]="saving" />
            <span class="checkbox-text">
              <strong>Make route active immediately</strong>
              <small>When enabled, the new route will be set to Active right away instead of Inactive.</small>
            </span>
          </label>
        </div>

        <p class="error" role="alert" *ngIf="error">{{ error }}</p>
      </form>

      <div slot="footer" class="actions">
        <tm-button variant="ghost" [disabled]="saving" (clicked)="close()">Cancel</tm-button>
        <tm-button variant="green" [disabled]="saving" (clicked)="save()">{{ saving ? 'Saving copy…' : 'Save copied route' }}</tm-button>
      </div>
    </tm-modal>
  `,
  styles: [`
    :host ::ng-deep .tm-modal__panel { width: min(540px, 100%); }
    .copy-form { display: grid; gap: 14px; }
    .direction-banner {
      display: flex; flex-direction: column; gap: 8px;
      padding: 12px 14px; border: 1px solid var(--tm-line);
      border-radius: 9px; background: var(--tm-canvas);
    }
    .direction-banner.is-reverse { border-color: #0ea5e955; background: #f0f9ff; }
    .direction-badge {
      display: inline-flex; align-items: center; gap: 5px;
      font-size: 10px; font-weight: 700; text-transform: uppercase;
      letter-spacing: .05em; color: var(--tm-green-deep);
    }
    .direction-banner.is-reverse .direction-badge { color: #0284c7; }
    .direction-endpoints {
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
      font-size: 13px; color: var(--tm-text);
    }
    .direction-endpoints strong { font-weight: 700; overflow-wrap: anywhere; }
    .direction-endpoints tm-icon { color: var(--tm-text-muted); flex-shrink: 0; }

    .form-field { display: grid; gap: 6px; }
    label { display: block; font-weight: 700; font-size: 12px; color: var(--tm-text); }
    input[type=text], input:not([type]), select {
      box-sizing: border-box; width: 100%; padding: 10px 12px;
      border: 1px solid var(--tm-line); border-radius: 8px;
      background: var(--tm-surface); color: var(--tm-text); font: inherit; font-size: 13px;
    }
    input:focus, select:focus { outline: none; border-color: var(--tm-green); box-shadow: 0 0 0 2px var(--tm-green-tint); }

    .copy-review, .allocation-section {
      border: 1px solid var(--tm-line); border-radius: 9px;
      padding: 13px; background: var(--tm-surface); display: grid; gap: 11px;
    }
    .review-header, .allocation-header { display: flex; align-items: center; gap: 9px; }
    .review-icon, .allocation-icon {
      display: inline-grid; place-items: center; width: 28px; height: 28px;
      border-radius: 7px; background: var(--tm-green-tint); color: var(--tm-green-deep); flex-shrink: 0;
    }
    .review-header h3, .allocation-header h3 { margin: 0; font-size: 12px; font-weight: 700; color: var(--tm-text); }
    .review-header p, .allocation-header p { margin: 2px 0 0; font-size: 10px; color: var(--tm-text-muted); }
    .allocation-title-wrap { flex: 1; min-width: 0; }

    .review-grid {
      display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px;
    }
    .review-cell {
      padding: 8px 10px; border-radius: 7px;
      background: var(--tm-canvas); border: 1px solid var(--tm-line);
      display: grid; gap: 4px;
    }
    .cell-label {
      display: flex; align-items: center; gap: 5px;
      font-size: 10px; color: var(--tm-text-muted);
    }
    .cell-val { font-size: 12px; font-weight: 700; color: var(--tm-text); overflow-wrap: anywhere; }

    .stops-preview { display: grid; gap: 6px; }
    .stops-preview-title { font-size: 10px; font-weight: 650; color: var(--tm-text-muted); }
    .stops-chips {
      list-style: none; margin: 0; padding: 0;
      display: flex; flex-wrap: wrap; gap: 5px; max-height: 90px; overflow-y: auto;
    }
    .stops-chips li {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 3px 8px; border-radius: 6px; border: 1px solid var(--tm-line);
      background: var(--tm-canvas); font-size: 11px; color: var(--tm-text);
    }
    .stops-chips li.is-endpoint { border-color: var(--tm-green); background: var(--tm-green-tint); font-weight: 600; }
    .chip-num { font-size: 9px; font-weight: 700; color: var(--tm-green-deep); }
    .chip-name { overflow-wrap: anywhere; }
    .chip-tag {
      font-style: normal; font-size: 8px; text-transform: uppercase;
      padding: 1px 4px; border-radius: 4px; background: var(--tm-green-soft); color: var(--tm-green-deep);
    }

    /* Stand cards multi-select */
    .stands-box { display: grid; gap: 8px; }
    .stands-toolbar {
      display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;
    }
    .stand-filter-input {
      display: flex; align-items: center; gap: 6px;
      padding: 5px 8px; border: 1px solid var(--tm-line); border-radius: 6px;
      background: var(--tm-canvas); flex: 1; max-width: 200px;
    }
    .stand-filter-input input {
      border: 0; outline: none; background: transparent; font: inherit; font-size: 11px;
      color: var(--tm-text); width: 100%; padding: 0;
    }
    .stand-filter-input tm-icon { color: var(--tm-text-muted); flex-shrink: 0; }
    .stands-quick-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; font-size: 11px; }

    .stands-cards-grid {
      display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px;
      max-height: 180px; overflow-y: auto; padding-right: 2px;
    }
    .stand-card {
      display: flex; align-items: center; gap: 9px;
      padding: 9px 11px; border: 1.5px solid var(--tm-line); border-radius: 8px;
      background: var(--tm-canvas); color: var(--tm-text); cursor: pointer;
      text-align: left; font: inherit; position: relative;
      transition: all 0.15s ease; user-select: none;
    }
    .stand-card:hover { border-color: var(--tm-green-soft); background: var(--tm-surface); }
    .stand-card.is-selected {
      border-color: var(--tm-green-deep); background: var(--tm-green-tint);
    }
    .stand-card-icon {
      display: inline-grid; place-items: center; width: 28px; height: 28px;
      border-radius: 6px; background: var(--tm-surface); color: var(--tm-green-deep);
      flex-shrink: 0;
    }
    .stand-card.is-selected .stand-card-icon {
      background: var(--tm-green-soft); color: var(--tm-green-deep);
    }
    .stand-card-info { display: grid; gap: 2px; min-width: 0; flex: 1; }
    .stand-card-name {
      font-size: 12px; font-weight: 700; color: var(--tm-text);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .stand-card-sub {
      font-size: 10px; color: var(--tm-text-muted);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .stand-card-check {
      color: var(--tm-green-deep); flex-shrink: 0; font-weight: bold;
    }
    .stand-card-new { border-style: dashed; }
    .stand-card-new.is-selected { border-style: solid; }
    .no-stands-hint { font-size: 11px; color: var(--tm-text-muted); margin: 6px 0; text-align: center; }
    .new-stand-field { margin-top: -2px; }

    /* Drivers allocation */
    .drivers-box {
      border: 1px solid var(--tm-line); border-radius: 8px;
      background: var(--tm-canvas); padding: 10px; display: grid; gap: 8px;
    }
    .drivers-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    .drivers-title-wrap { display: flex; align-items: center; gap: 6px; }
    .drivers-title { font-size: 11px; font-weight: 700; color: var(--tm-text); }
    .count-pill { font-size: 10px; color: var(--tm-green-deep); background: var(--tm-green-tint); padding: 2px 6px; border-radius: 10px; font-weight: 600; }
    .drivers-actions { display: flex; align-items: center; gap: 6px; font-size: 11px; }
    .action-btn { background: none; border: 0; padding: 0; color: var(--tm-green-deep); font: inherit; font-size: 11px; font-weight: 600; cursor: pointer; }
    .action-btn:hover { text-decoration: underline; }
    .action-divider { color: var(--tm-text-muted); }

    .driver-filter-input {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 9px; border: 1px solid var(--tm-line); border-radius: 6px;
      background: var(--tm-surface);
    }
    .driver-filter-input tm-icon { color: var(--tm-text-muted); flex-shrink: 0; }
    .driver-filter-input input {
      border: 0; outline: none; background: transparent; font: inherit; font-size: 11px;
      color: var(--tm-text); width: 100%; padding: 0;
    }
    .clear-btn { background: none; border: 0; color: var(--tm-text-muted); cursor: pointer; padding: 0 2px; font-size: 11px; }

    .drivers-list {
      display: grid; gap: 5px; max-height: 140px; overflow-y: auto; padding-right: 2px;
    }
    .driver-item {
      display: flex; align-items: center; gap: 8px; padding: 6px 8px;
      border: 1px solid var(--tm-line); border-radius: 6px;
      background: var(--tm-surface); cursor: pointer; user-select: none;
      transition: background 0.15s ease, border-color 0.15s ease;
    }
    .driver-item:hover { border-color: var(--tm-green-soft); }
    .driver-item.is-checked { border-color: var(--tm-green); background: var(--tm-green-tint); }
    .driver-item input[type=checkbox] {
      margin: 0; width: 15px; height: 15px; accent-color: var(--tm-green); flex-shrink: 0;
    }
    .driver-avatar {
      width: 26px; height: 26px; border-radius: 50%;
      background: var(--tm-canvas); color: var(--tm-text-muted);
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 10px; font-weight: 700; flex-shrink: 0; overflow: hidden;
    }
    .driver-avatar img { width: 100%; height: 100%; object-fit: cover; }
    .driver-info { display: grid; gap: 1px; min-width: 0; flex: 1; }
    .driver-name { font-size: 11px; font-weight: 650; color: var(--tm-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .driver-meta { font-size: 10px; color: var(--tm-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .no-drivers-hint { font-size: 11px; color: var(--tm-text-muted); margin: 6px 0; text-align: center; }

    .stand-hint-note {
      display: flex; align-items: flex-start; gap: 7px;
      font-size: 11px; line-height: 1.4; color: var(--tm-text-muted);
    }
    .stand-hint-note tm-icon { color: var(--tm-text-muted); flex-shrink: 0; margin-top: 2px; }

    .active-toggle-card {
      padding: 10px 12px; border-radius: 8px;
      border: 1px solid var(--tm-line); background: var(--tm-green-tint);
    }
    .active-checkbox-label {
      display: flex; align-items: flex-start; gap: 10px; cursor: pointer; user-select: none;
    }
    .active-checkbox-label input[type=checkbox] {
      margin-top: 3px; accent-color: var(--tm-green); width: 16px; height: 16px; flex-shrink: 0;
    }
    .checkbox-text { display: grid; gap: 2px; }
    .checkbox-text strong { font-size: 12px; font-weight: 700; color: var(--tm-text); }
    .checkbox-text small { font-size: 11px; color: var(--tm-text-muted); line-height: 1.4; }

    .error { color: var(--tm-danger-fg); font-size: 12px; margin: 0; }
    .actions { display: flex; justify-content: flex-end; gap: 8px; width: 100%; }

    @media (max-width: 520px) {
      .stands-cards-grid { grid-template-columns: 1fr; }
    }
  `],
})
export class RouteCopyComponent implements OnInit {
  @Input() cityId!: number;
  @Input() route!: MasterRoute;
  @Input() reverse = false;
  @Input() vehicles: MasterVehicle[] = [];
  @Input() groups: MasterGroup[] = [];
  @Input() drivers: MasterDriver[] = [];
  @Output() closed = new EventEmitter<void>();
  @Output() saved = new EventEmitter<{ id: number; name: string }>();

  name = '';
  isActive = true;
  saving = false;
  error = '';

  // Stand and Driver allocations start unassigned by default
  selectedGroupIds = new Set<number>();
  createNewStand = false;
  newGroupName = '';
  standSearch = '';
  assignedDriverUserIds: number[] = [];
  driverSearch = '';

  constructor(private api: ApiService, private toast: ToastService, private destroyRef: DestroyRef) {}

  ngOnInit(): void {
    this.name = this.reverse
      ? `${this.route.dest_name.slice(0, 58)} → ${this.route.origin_name.slice(0, 58)}`
      : `${this.route.name.slice(0, 113)} (copy)`;
  }

  get originName(): string {
    return this.reverse ? this.route.dest_name : this.route.origin_name;
  }

  get destName(): string {
    return this.reverse ? this.route.origin_name : this.route.dest_name;
  }

  get vehicleName(): string {
    if (!this.vehicles?.length || !this.route.city_vehicle_type_id) return 'Not bound to a vehicle';
    const vehicle = this.vehicles.find(v => (v.mode_row_ids ?? [v.id]).includes(this.route.city_vehicle_type_id ?? -1));
    return vehicle?.display_name || vehicle?.vehicle_type_name || 'Configured vehicle';
  }

  get displayStops(): MasterRouteStop[] {
    const stops = [...(this.route.stops || [])].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    return this.reverse ? [...stops].reverse() : stops;
  }

  get filteredGroups(): MasterGroup[] {
    const q = this.standSearch.toLowerCase().trim();
    if (!q) return this.groups;
    return this.groups.filter(g => g.name.toLowerCase().includes(q));
  }

  isGroupSelected(id: number): boolean {
    return this.selectedGroupIds.has(id);
  }

  toggleGroup(group: MasterGroup): void {
    if (this.saving) return;
    if (this.selectedGroupIds.has(group.id)) {
      this.selectedGroupIds.delete(group.id);
      if (this.selectedGroupIds.size === 0 && !this.createNewStand) {
        this.assignedDriverUserIds = [];
      }
    } else {
      this.selectedGroupIds.add(group.id);
      // Auto-include drivers belonging to this stand
      (group.driver_user_ids || []).forEach(uid => {
        if (!this.assignedDriverUserIds.includes(uid)) {
          this.assignedDriverUserIds.push(uid);
        }
      });
    }
  }

  toggleNewStand(): void {
    if (this.saving) return;
    this.createNewStand = !this.createNewStand;
    if (this.createNewStand && !this.newGroupName.trim()) {
      this.newGroupName = `${this.name} Stand`.slice(0, 120);
    }
    if (!this.createNewStand && this.selectedGroupIds.size === 0) {
      this.assignedDriverUserIds = [];
    }
  }

  selectAllGroups(): void {
    if (this.saving) return;
    this.filteredGroups.forEach(g => {
      this.selectedGroupIds.add(g.id);
      (g.driver_user_ids || []).forEach(uid => {
        if (!this.assignedDriverUserIds.includes(uid)) {
          this.assignedDriverUserIds.push(uid);
        }
      });
    });
  }

  clearAllGroups(): void {
    if (this.saving) return;
    this.selectedGroupIds.clear();
    this.createNewStand = false;
    this.assignedDriverUserIds = [];
  }

  get hasStandsSelected(): boolean {
    return this.selectedGroupIds.size > 0 || this.createNewStand;
  }

  isDriverSelected(userId: number): boolean {
    return this.assignedDriverUserIds.includes(userId);
  }

  toggleDriver(userId: number): void {
    if (this.saving) return;
    const index = this.assignedDriverUserIds.indexOf(userId);
    if (index >= 0) {
      this.assignedDriverUserIds.splice(index, 1);
    } else {
      this.assignedDriverUserIds.push(userId);
    }
  }

  selectAllDrivers(): void {
    if (this.saving) return;
    const ids = this.filteredDrivers.map(d => d.user_id);
    this.assignedDriverUserIds = Array.from(new Set([...this.assignedDriverUserIds, ...ids]));
  }

  deselectAllDrivers(): void {
    if (this.saving) return;
    const ids = new Set(this.filteredDrivers.map(d => d.user_id));
    this.assignedDriverUserIds = this.assignedDriverUserIds.filter(id => !ids.has(id));
  }

  get filteredDrivers(): MasterDriver[] {
    const q = this.driverSearch.toLowerCase().trim();
    if (!q) return this.drivers;
    return this.drivers.filter(d =>
      (d.name || '').toLowerCase().includes(q) ||
      (d.phone || '').toLowerCase().includes(q) ||
      (d.vehicle_reg_no || '').toLowerCase().includes(q) ||
      (d.vehicle_model || '').toLowerCase().includes(q)
    );
  }

  initials(name?: string | null): string {
    if (!name) return '—';
    const parts = name.trim().split(/\s+/);
    return (parts[0]?.[0] || '') + (parts[1]?.[0] || '');
  }

  close(): void {
    if (!this.saving) this.closed.emit();
  }

  save(): void {
    if (this.saving) return;
    const name = this.name.trim();
    if (!name || name.length > 120) {
      this.error = 'Enter a route name, up to 120 characters.';
      return;
    }
    if (this.createNewStand && !this.newGroupName.trim()) {
      this.error = 'Enter a name for the new stand, up to 120 characters.';
      return;
    }
    this.saving = true;
    this.error = '';

    const groupIds = Array.from(this.selectedGroupIds);
    const payload = {
      name,
      reverse: this.reverse,
      is_active: this.isActive,
      assigned_group_ids: groupIds.length ? groupIds : null,
      assigned_group_id: groupIds.length === 1 ? groupIds[0] : (this.createNewStand ? 'new' : null),
      new_group_name: this.createNewStand && this.newGroupName.trim() ? this.newGroupName.trim() : null,
      driver_user_ids: this.hasStandsSelected && this.assignedDriverUserIds.length ? this.assignedDriverUserIds : null,
    };

    this.api.post<{ route: { id: number; name: string; is_active?: boolean } }>(
      `/admin/cities/${this.cityId}/fixed-routes/${this.route.id}/copy`,
      payload
    ).pipe(
      switchMap(result => {
        // Fallback: If isActive requested but not set on the route, PATCH route
        if (this.isActive && !result.route.is_active && typeof this.api.patch === 'function') {
          return this.api.patch<{ route: { id: number; name: string; is_active: boolean } }>(
            `/admin/cities/${this.cityId}/fixed-routes/${result.route.id}`,
            { is_active: true }
          ).pipe(
            map(() => ({ route: { ...result.route, is_active: true } })),
            catchError(() => of(result))
          );
        }
        return of(result);
      }),
      switchMap(result => {
        const routeId = result.route.id;
        const operations: Observable<any>[] = [];

        // Fallback for older backend: create new stand if requested
        if (this.createNewStand && this.newGroupName.trim()) {
          operations.push(
            this.api.post<{ route_group?: MasterGroup; data?: MasterGroup }>(
              `/admin/cities/${this.cityId}/route-groups`,
              {
                name: this.newGroupName.trim(),
                city_vehicle_type_id: this.route.city_vehicle_type_id,
                route_ids: [routeId],
              }
            ).pipe(
              switchMap(groupRes => {
                const newGroupId = groupRes?.route_group?.id ?? groupRes?.data?.id;
                if (newGroupId && this.assignedDriverUserIds.length > 0) {
                  return this.api.put(
                    `/admin/cities/${this.cityId}/route-groups/${newGroupId}/drivers`,
                    { driver_user_ids: this.assignedDriverUserIds }
                  ).pipe(catchError(() => of(null)));
                }
                return of(null);
              }),
              catchError(err => {
                console.warn('Fallback stand creation failed:', err);
                return of(null);
              })
            )
          );
        }

        // Fallback for older backend: link all selected existing stands
        for (const gid of groupIds) {
          const existingGroup = this.groups.find(g => g.id === gid);
          if (existingGroup) {
            const updatedRouteIds = Array.from(new Set([...(existingGroup.route_ids || []), routeId]));
            operations.push(
              this.api.patch(
                `/admin/cities/${this.cityId}/route-groups/${existingGroup.id}`,
                {
                  name: existingGroup.name,
                  city_vehicle_type_id: existingGroup.city_vehicle_type_id ?? this.route.city_vehicle_type_id,
                  route_ids: updatedRouteIds,
                }
              ).pipe(
                switchMap(() => {
                  if (this.assignedDriverUserIds.length > 0) {
                    return this.api.put(
                      `/admin/cities/${this.cityId}/route-groups/${existingGroup.id}/drivers`,
                      { driver_user_ids: this.assignedDriverUserIds }
                    ).pipe(catchError(() => of(null)));
                  }
                  return of(null);
                }),
                catchError(err => {
                  console.warn(`Fallback stand ${gid} route link failed:`, err);
                  return of(null);
                })
              )
            );
          }
        }

        if (operations.length > 0) {
          return forkJoin(operations).pipe(
            map(() => result),
            catchError(() => of(result))
          );
        }
        return of(result);
      }),
      takeUntilDestroyed(this.destroyRef)
    ).subscribe({
      next: result => {
        this.saving = false;
        let message = this.isActive ? 'Route copied and activated.' : 'Route copied. Review and activate it when ready.';
        const totalStands = groupIds.length + (this.createNewStand ? 1 : 0);
        if (totalStands > 0) {
          message += ` Added to ${totalStands} stand${totalStands > 1 ? 's' : ''} with drivers.`;
        }
        this.toast.success(message);
        this.saved.emit(result.route);
        this.closed.emit();
      },
      error: err => {
        this.saving = false;
        this.error = err?.status === 422 && err?.error?.errors?.name
          ? 'Choose a unique route name, up to 120 characters, for this city.'
          : err?.error?.message || 'Could not copy route. Try again.';
      },
    });
  }
}
