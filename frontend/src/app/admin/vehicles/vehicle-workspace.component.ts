import { Component, ElementRef, HostListener, Input, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription, forkJoin, firstValueFrom, Observable } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { CityContextService, CityOption } from '../../core/city-context.service';
import { ToastService } from '../../core/toast.service';
import { ButtonComponent, DrawerComponent, IconComponent, StatusPillComponent } from '../../ui';
import { ModalComponent } from '../../ui/modal/modal.component';
import { ReturnToSetupComponent } from '../setup/return-to-setup.component';
import { FixedRoutesComponent, ImportedRouteDraft } from '../fixed/fixed-routes.component';
import { VehicleBasePricingComponent } from '../settings/vehicle-base-pricing.component';
import { OutstationPackagesComponent } from '../settings/outstation-packages.component';
import { SeatGridComponent } from '../vehicle-seat-layouts/seat-grid.component';
import { SeatLayoutDesignerComponent } from '../vehicle-seat-layouts/seat-layout-designer.component';
import { VehicleSeatLayout, VehicleSeatLayoutsService } from '../vehicle-seat-layouts/vehicle-seat-layouts.service';
import { MasterAction, MasterExplorerComponent, MasterSection } from './master-explorer.component';
import { MasterGroupEditorComponent } from './master-group-editor.component';
import { VehicleSetsEditorComponent } from './vehicle-sets-editor.component';
import { RouteOperationsComponent } from './route-operations.component';
import type { OperationsAction } from './route-operations.component';
import type { SetupVehicleSet } from './route-group-setup.component';

/** How a ride type behaves, derived from its name. Only the behaviour is
 *  inferred — every label shown to the operator comes from the database. */
type ModeKind = 'private' | 'fixed' | 'shuttle';
type CityVehicleStatus = 'all' | 'enabled' | 'disabled';

interface VehicleTypeRow { id: number; name: string; is_active: boolean; }
interface RideTypeRef { id: number; name: string; }
interface VehicleTypeRef { id: number; name: string; }

interface CityVehicleRow {
  vehicle_set_id?: number | null;
  vehicle_set_ids?: number[];
  mode_row_ids?: number[];
  image_url?: string | null;
  map_marker_url?: string | null;
  id: number;
  city_id: number;
  ride_type_id: number | null;
  vehicle_type_id: number | null;
  vehicle_type_name?: string | null;
  ride_type_name: string | null;
  display_name: string;
  display_order: number;
  max_people: number;
  luggage_capacity: number;
  reverse_bidding_enabled: boolean;
  is_active: boolean;
  is_outstation?: boolean;
  /** Ride type ids this vehicle already has a row for — filled in locally. */
  mode_ids?: number[];
}

interface RouteLite {
  id: number;
  name: string;
  scope: string;
  origin_name: string;
  dest_name: string;
  flat_fare: number | null;
  booking_window_hours: number | null;
  stops?: { id: number }[];
  is_active: boolean;
  city_vehicle_type_id: number | null;
}

interface GroupRow {
  vehicle_set_ids?: number[];
  id: number;
  name: string;
  is_active: boolean;
  /** The city vehicle this group belongs to. null = legacy/unbound group. */
  city_vehicle_type_id: number | null;
  route_ids: number[];
  driver_user_ids: number[];
}

interface DriverOpt {
  avatar_url?: string | null;
  id: number;
  user_id: number;
  name: string;
  phone: string | null;
  city_vehicle_type_id: number | null;
  vehicle_type_id: number | null;
  vehicle_reg_no: string | null;
  vehicle_model: string | null;
  vehicle_color: string | null;
}

interface TabDef { key: string; label: string; count?: number; }

/**
 * Vehicle Workspace — every screen for one city vehicle on a single page.
 *
 *   [ city vehicle list ]   [ Common · <ride types…> · Drivers · Seat layouts ]
 *
 * Replaces the old Fleet Setup page and the separate fare-setup page: picking a
 * vehicle on the left swaps the tabbed editor on the right, so fares, fixed
 * routes, route groups, drivers and seat layouts are reachable without
 * navigating away.
 *
 * The fare tabs are built from the `ride_types` table — one tab per row, using
 * that row's own name. Nothing is hardcoded, so renaming or adding a ride type
 * changes the tabs with no frontend edit, and a tab can never ask for a ride
 * type that doesn't exist.
 *
 * Loading is deliberately staged: the vehicle list renders as soon as its own
 * request lands, and everything else (types, layouts, routes, groups, drivers)
 * streams in behind it rather than holding the page on one combined wait.
 */
@Component({
  selector: 'app-vehicle-workspace',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonComponent,
    DrawerComponent,
    IconComponent,
    ModalComponent,
    StatusPillComponent,
    ReturnToSetupComponent,
    FixedRoutesComponent,
    VehicleBasePricingComponent,
    OutstationPackagesComponent,
    SeatGridComponent,
    SeatLayoutDesignerComponent,
    MasterExplorerComponent,
    MasterGroupEditorComponent,
    VehicleSetsEditorComponent,
    RouteOperationsComponent,
  ],
  template: `
    <div class="ws">
      <app-return-to-setup></app-return-to-setup>

      <header class="ws__head" *ngIf="masterSection !== 'routes'">
        <div class="vehicle-page-heading"><h1>{{ masterHeading }}</h1><p>{{ masterSection && masterSection !== 'vehicle-configuration' ? 'Manage ' + cityName + ' routes, stands and driver allocations.' : 'Choose a vehicle to manage its routes, stands, drivers and fares.' }}</p></div>
        <div class="vehicle-page-actions">
        <tm-button variant="outline" icon="cog" (clicked)="openTypes()">Vehicle types</tm-button>
        <tm-button variant="outline" [disabled]="cityId == null || loading" (clicked)="vehicleSetsOpen = true">Vehicle sets</tm-button>
        <tm-button *ngIf="!masterSection || masterSection === 'vehicle-configuration'" variant="outline" icon="copy" [disabled]="cityId == null || !vehicles.length" (clicked)="openCopyModal()">Copy to location</tm-button>
        <tm-button variant="green" icon="plus" [disabled]="cityId == null || !vehicleTypeOptions.length" (clicked)="openCreate()">Add vehicle</tm-button>
        <tm-button *ngIf="masterSection" variant="outline" icon="refresh" [disabled]="loading" (clicked)="refresh()">Refresh</tm-button>
        </div>
      </header>
      <app-vehicle-sets-editor *ngIf="vehicleSetsOpen && cityId" [cityId]="cityId" [vehicles]="rows" [groups]="groups" (closed)="vehicleSetsOpen = false" (saved)="refresh()" />

      <div class="cue" *ngIf="cityId == null">
        <tm-icon name="map-marker" [size]="22" />
        <strong>No city selected</strong>
        <span>Pick a city from the top bar to manage its vehicles.</span>
      </div>

      <div class="grid" *ngIf="cityId != null">
        @defer (when masterSection === 'routes') {
          <app-route-operations *ngIf="masterSection === 'routes'" [cityId]="cityId!" [cityName]="cityName" [countryCode]="operationsCountryCode" [loading]="operationsLoading" [loadError]="operationsLoadError" [vehicles]="vehicles" [vehicleRows]="rows" [sets]="vehicleSets" [routes]="routes" [groups]="groups" [drivers]="cityDrivers" [fareModes]="fareRideTypes" [vehicleTypeOptions]="vehicleTypeOptions" [editId]="editId" [editField]="editField" [editValue]="editValue" (cellEdit)="handleOperationsCellEdit($event)" (action)="handleOperationsAction($event)" (refresh)="refresh()" />
        } @placeholder { <p *ngIf="masterSection === 'routes'">Opening Routes workspace…</p> }
        <app-master-explorer *ngIf="masterSection && masterSection !== 'vehicle-configuration' && masterSection !== 'routes'" [section]="masterSection" [cityId]="cityId" [cityName]="cityName" [loading]="loading" [vehicles]="vehicles" [routes]="routes" [groups]="groups" [drivers]="cityDrivers" [groupCreating]="groupSaving" [groupCreatedVersion]="masterGroupCreatedVersion" (groupCreate)="createMasterInlineGroup($event)" (action)="handleMasterAction($event)" />
        <ng-container *ngIf="!masterSection || masterSection === 'vehicle-configuration'">
        <!-- ─────────────── spreadsheet ─────────────── -->
        <!-- controls -->
        <div class="controls">
          <span class="search">
            <tm-icon name="search" [size]="14" />
            <input type="text" [(ngModel)]="search" (ngModelChange)="applyView()" placeholder="Search vehicles..." aria-label="Search vehicles" />
          </span>
          <div class="seg" role="tablist" aria-label="Status filter">
            <button type="button" class="seg__btn" *ngFor="let s of statusChips" [class.on]="status === s.value" [attr.aria-pressed]="status === s.value" (click)="setStatus(s.value)">{{ s.label }}</button>
          </div>
          <div class="vehicle-filter">
            <select aria-label="Vehicle type" [ngModel]="typeFilter" (ngModelChange)="setTypeFilter($event)">
              <option value="all">All types</option>
              <option *ngFor="let t of types" [value]="t.id + ''">{{ t.name }}</option>
            </select>
          </div>
          <div class="vehicle-filter">
            <select aria-label="Vehicle name" [ngModel]="vehicleFilter" (ngModelChange)="setVehicleFilter($event)">
              <option value="all">All vehicles</option>
              <option *ngFor="let name of vehicleNames" [value]="name">{{ name }}</option>
            </select>
          </div>
          <button type="button" class="clearall" *ngIf="hasActiveFilters" (click)="clearAllFilters()">
            <tm-icon name="x" [size]="13" /> Clear all
          </button>
          <div class="vehicle-view-controls">
          <span class="count-note"><b>{{ visible.length }}</b> of <b>{{ vehicles.length }}</b> vehicles</span>
          <div class="route-view-tabs" aria-label="Vehicle view">
            <button type="button" [class.selected]="vehicleView === 'overview'" [attr.aria-pressed]="vehicleView === 'overview'" (click)="vehicleView = 'overview'">Overview</button>
            <button type="button" [class.selected]="vehicleView === 'table'" [attr.aria-pressed]="vehicleView === 'table'" (click)="vehicleView = 'table'">Edit details</button>
          </div>
          </div>
        </div>

        <!-- bulk bar -->
        <div class="bulk" *ngIf="selectedIds.size">
          <b>{{ selectedIds.size }} selected</b>
          <span class="bulk__sep"></span>
          <button type="button" class="bbtn" (click)="openCopyModalForSelected()"><tm-icon name="copy" [size]="13" /> Copy to location</button>
          <button type="button" class="bbtn" (click)="bulkSetActive(true)">Enable</button>
          <button type="button" class="bbtn" (click)="bulkSetActive(false)">Disable</button>
          <button type="button" class="bbtn" (click)="bulkExport()">Export CSV</button>
          <button type="button" class="bulk__x" (click)="clearSel()" aria-label="Clear selection"><tm-icon name="x" [size]="16" /></button>
        </div>

        <div class="vehicle-overview" *ngIf="vehicleView === 'overview'">
          <article class="vehicle-summary" *ngFor="let v of visible; trackBy: trackVehicle" [class.vehicle-summary--selected]="isSel(v)">
            <header>
              <label class="vehicle-select"><input type="checkbox" [checked]="isSel(v)" (click)="toggleSel(v, $event)" [attr.aria-label]="'Select ' + v.display_name" /></label>
              <span class="vehicle-photo vehicle-photo--overview">
                <img *ngIf="v.image_url" [src]="v.image_url" [alt]="v.display_name" loading="lazy" (error)="v.image_url = null" />
                <tm-icon *ngIf="!v.image_url" name="car" [size]="24" />
              </span>
              <div class="vehicle-summary-title"><h2>{{ v.display_name }}</h2><span>{{ v.vehicle_type_name || 'Type not set' }} &middot; {{ v.max_people }} seats &middot; {{ v.luggage_capacity }} bags</span></div>
              <span class="pill" [class.success]="v.is_active" [class.neutral]="!v.is_active">{{ v.is_active ? 'Enabled' : 'Disabled' }}</span>
            </header>
            <div class="vehicle-summary-stats">
              <button type="button" (click)="openOperationsDrawer(v, 'all-routes', $event)"><b>{{ routesForVehicle(v).length }}</b><span>Routes</span></button>
              <button type="button" (click)="openOperationsDrawer(v, 'groups', $event)"><b>{{ groupsForVehicle(v).length }}</b><span>Stands</span></button>
              <button type="button" (click)="openOperationsDrawer(v, 'drivers', $event)"><b>{{ driversForVehicle(v).length }}</b><span>Drivers</span></button>
            </div>
            <div class="vehicle-summary-actions">
              <button type="button" class="btn-kb-primary" (click)="openOperationsDrawer(v, 'all-routes', $event)">Manage routes</button>
              <button type="button" class="btn-kb-outline" (click)="openOperationsDrawer(v, 'groups', $event)">Stands &amp; drivers</button>
              <button type="button" class="btn-kb-outline" (click)="newRouteFor(v)">Add route</button>
            </div>
            <details class="vehicle-settings">
              <summary>Fares, seat layout &amp; vehicle settings</summary>
              <div class="vehicle-settings-actions">
                <button type="button" class="btn-kb-outline" *ngFor="let rt of fareRideTypes" (click)="openFareDrawer(v, rt, $event)">{{ rt.name }} fare: {{ fareConfigured(v, rt) ? 'Edit' : 'Set up' }}</button>
                <button type="button" class="btn-kb-outline" (click)="openLayoutsList(v, $event)">Seat layouts ({{ layoutCountFor(v) }})</button>
                <button type="button" class="btn-kb-outline" (click)="openAppAssets(v)">App Assets</button>
                <button type="button" class="btn-kb-outline" (click)="triggerKmlImportFor(v)" [disabled]="importingKml">Import routes</button>
                <button type="button" class="btn-kb-outline" (click)="openCommonDrawer(v)">Edit name &amp; capacity</button>
                <button type="button" class="btn-kb-outline" (click)="toggleActiveFor(v, $event)">{{ v.is_active ? 'Disable vehicle' : 'Enable vehicle' }}</button>
              </div>
            </details>
          </article>
          <div class="empty" *ngIf="!visible.length && !loading"><strong>{{ hasActiveFilters ? 'No matching vehicles' : 'No vehicles yet' }}</strong><span>{{ hasActiveFilters ? 'Try another search or clear the filters.' : 'Use Add vehicle to get started.' }}</span><button type="button" class="btn-kb-outline" *ngIf="hasActiveFilters" (click)="clearAllFilters()">Clear filters</button></div>
          <div class="skeleton" *ngIf="loading"><span class="sk" *ngFor="let i of [1,2,3,4]"></span></div>
        </div>
        <p class="vehicle-edit-hint" *ngIf="vehicleView === 'table'">Click a vehicle name, seat count or bag count to edit it. Press Enter to save or Escape to cancel.</p>
        <!-- spreadsheet -->
        <div class="sheetwrap" *ngIf="vehicleView === 'table'">
          <table class="sheet">
            <thead>
              <tr>
                <th class="col-gut"><span class="chk" [class.on]="allSelected" (click)="toggleSelectAll()"><tm-icon *ngIf="allSelected" name="check" [size]="11" /></span></th>
                <th class="col-veh">Vehicle</th>
                <th>Type</th>
                <th class="center">Seats</th>
                <th class="center">Bags</th>
                <th class="center" *ngFor="let rt of fareRideTypes">{{ rt.name }}</th>
                <th>Fixed stands</th>
                <th>Seat layout</th>
                <th>Drivers</th>
                <th class="center">Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <ng-container *ngFor="let v of visible; let i = index; trackBy: trackVehicle">
                <tr
                  class="srow"
                  [class.sel]="isSel(v)"
                  [class.is-active-row]="singleSelectedVehicle?.id === v.id"
                  [class.off]="!v.is_active"
                  [attr.aria-current]="v.id === selectedId"
                  (click)="onRowClick(v, $event)"
                >
                  <td class="col-gut">
                    <span class="chk" [class.on]="isSel(v)" (click)="toggleSel(v, $event)">
                      <tm-icon *ngIf="isSel(v)" name="check" [size]="11" />
                      <span class="rownum" *ngIf="!isSel(v)">{{ i + 1 }}</span>
                    </span>
                  </td>
                  <td class="col-veh">
                    <div class="veh">
                      <span class="veh-ic vehicle-photo" [class.vehicle-photo--configured]="!!v.image_url" (click)="openOperationsDrawer(v, 'groups', $event)" style="cursor: pointer;">
                        <img *ngIf="v.image_url" [src]="v.image_url" [alt]="v.display_name" loading="lazy" (error)="v.image_url = null" />
                        <tm-icon *ngIf="!v.image_url" name="car" [size]="15" />
                      </span>
                      <span *ngIf="!isEditing(v, 'name')" class="veh-name ecell" (click)="startCellEdit(v, 'name', $event)">{{ v.display_name }}</span>
                      <input *ngIf="isEditing(v, 'name')" class="cin" [(ngModel)]="editValue" (keydown.enter)="commitCellEdit(v)" (keydown.escape)="cancelCellEdit()" (blur)="commitCellEdit(v)" />
                    </div>
                  </td>
                  <td><span class="tbadge">{{ v.vehicle_type_name || 'Not set' }}</span></td>
                  <td class="center ecell" (click)="startCellEdit(v, 'seats', $event)">
                    <b *ngIf="!isEditing(v, 'seats')">{{ v.max_people }}</b>
                    <input *ngIf="isEditing(v, 'seats')" class="cin" type="number" [(ngModel)]="editValue" (keydown.enter)="commitCellEdit(v)" (keydown.escape)="cancelCellEdit()" (blur)="commitCellEdit(v)" />
                  </td>
                  <td class="center ecell" (click)="startCellEdit(v, 'bags', $event)">
                    <b *ngIf="!isEditing(v, 'bags')">{{ v.luggage_capacity }}</b>
                    <input *ngIf="isEditing(v, 'bags')" class="cin" type="number" [(ngModel)]="editValue" (keydown.enter)="commitCellEdit(v)" (keydown.escape)="cancelCellEdit()" (blur)="commitCellEdit(v)" />
                  </td>
                  <td class="center" *ngFor="let rt of fareRideTypes"><button type="button" class="farelink" [class.set]="fareConfigured(v, rt)" (click)="openFareDrawer(v, rt, $event)">{{ fareConfigured(v, rt) ? 'Edit' : 'Set up' }}</button></td>
                  <td>
                    <span class="gchips" *ngIf="groupsForVehicle(v).length; else noGrp">
                      <button type="button" class="gchip" *ngFor="let g of groupsForVehicle(v).slice(0, 2)" (click)="openOperationsDrawer(v, 'groups', $event)">{{ g.name }}</button>
                      <button type="button" class="gchip more" *ngIf="groupsForVehicle(v).length > 2" (click)="openOperationsDrawer(v, 'groups', $event)">+{{ groupsForVehicle(v).length - 2 }}</button>
                    </span>
                    <ng-template #noGrp><button type="button" class="addlink" (click)="openOperationsDrawer(v, 'groups', $event)">+ Stand</button></ng-template>
                  </td>
                  <td>
                    <button type="button" class="linkcell" (click)="openLayoutsList(v, $event)">
                      <span *ngIf="layoutCountFor(v)">{{ layoutCountFor(v) }} {{ layoutCountFor(v) === 1 ? 'layout' : 'layouts' }}</span>
                      <span *ngIf="!layoutCountFor(v)" class="muted-link">Design</span>
                    </button>
                  </td>
                  <td>
                    <button type="button" class="drv-cell-btn" (click)="openOperationsDrawer(v, 'drivers', $event)">
                      <div class="avstack" *ngIf="driversForVehicle(v).length; else noDrv">
                        <span class="av2" *ngFor="let d of driversForVehicle(v).slice(0, 3)">{{ initials(d.name) }}</span>
                        <span class="av2 more" *ngIf="driversForVehicle(v).length > 3">+{{ driversForVehicle(v).length - 3 }}</span>
                        <span class="drv-count-badge" [class.badge-has-active]="assignedDriverCountFor(v) > 0">
                          {{ assignedDriverCountFor(v) }}/{{ driversForVehicle(v).length }} assigned
                        </span>
                      </div>
                      <ng-template #noDrv>
                        <span class="addlink">+ Assign Drivers</span>
                      </ng-template>
                    </button>
                  </td>
                  <td class="center"><button type="button" class="pill" [class.success]="v.is_active" [class.neutral]="!v.is_active" (click)="toggleActiveFor(v, $event)"><span class="led"></span>{{ v.is_active ? 'Enabled' : 'Disabled' }}</button></td>
                  <td class="center"><button type="button" class="kebab" (click)="openRowMenu(v, $event)"><tm-icon name="more-horizontal" [size]="16" /></button></td>
                </tr>
              </ng-container>
            </tbody>
            <tfoot>
              <tr class="addrow"><td [attr.colspan]="detailColspan + 1"><button type="button" class="addbtn" [disabled]="!vehicleTypeOptions.length" (click)="openCreate()"><tm-icon name="plus" [size]="16" /> Add vehicle</button></td></tr>
            </tfoot>
          </table>

          <div class="empty" *ngIf="!visible.length && !loading"><strong>{{ hasActiveFilters ? 'No matching vehicles' : 'No city vehicles' }}</strong><span>{{ hasActiveFilters ? 'Try another search or clear the filters.' : 'Add a city vehicle after creating vehicle types.' }}</span></div>
          <div class="skeleton" *ngIf="loading"><span class="sk" *ngFor="let i of [1,2,3,4]"></span></div>
        </div>

        </ng-container>
        <!-- Map route editor: hidden table, opens as a drawer via Add route / edit route. -->
        <app-fixed-routes *ngIf="selected" [cityVehicleTypeId]="selected.id" [embedded]="true" [hideTable]="true" [drawerMode]="true" (routesChanged)="onRouteMutation()" (editorClosed)="onRouteEditorClosed()"></app-fixed-routes>

        <!-- Hidden picker for "Import from My Maps" (KML/KMZ upload) — creates. -->
        <input #kmlInput type="file" accept=".kml,.kmz" hidden (change)="onKmlFileSelected($event)" />
        <!-- Hidden picker for "Edit → Update from My Maps" — updates one route. -->
        <input #editKmlInput type="file" accept=".kml,.kmz" hidden (change)="onEditKmlFileSelected($event)" />

        <!-- (The old tabbed editor is gone — its fares, routes, groups, layouts
             and drivers are reached from the spreadsheet cells + drawers above.) -->
      </div>
    </div>

    <app-master-group-editor *ngIf="masterEditGroup as group" [group]="group" [cityId]="cityId!" [vehicleName]="selected?.display_name || ''" [routes]="masterEditRoutes" [drivers]="cityDrivers" (closed)="masterEditGroupId = null" (saved)="loadGroups()" (editRoute)="editMasterGroupRoute($event)" />
    <tm-drawer *ngIf="masterSection" [open]="masterGroupCreateOpen" title="Create stand" [width]="520" (closed)="masterGroupCreateOpen = false">
      <div slot="body" class="form"><label class="f"><span>Stand name</span><input aria-label="Stand name" [(ngModel)]="groupName" placeholder="For example Airport Routes" /></label><p class="meta">Vehicle: {{ selected?.display_name }} · {{ cityName }}</p></div>
      <div slot="footer"><tm-button variant="ghost" (clicked)="masterGroupCreateOpen = false">Cancel</tm-button><tm-button variant="green" [disabled]="groupSaving || !groupName.trim()" (clicked)="createGroup()">{{ groupSaving ? 'Creating…' : 'Create stand' }}</tm-button></div>
    </tm-drawer>
    <tm-drawer *ngIf="masterSection" [open]="driverDrawerId !== null" [title]="(driverDrawerGroup?.name || 'Stand') + ' — Assign drivers'" [width]="560" (closed)="driverDrawerId = null">
      <div slot="body" class="form"><p class="meta">Select the city drivers who should receive this stand's routes.</p><label class="check" *ngFor="let driver of cityDrivers"><input type="checkbox" [checked]="pendingDriverIds.includes(driver.user_id)" (change)="togglePendingDriver(driver.user_id)" [disabled]="savingGroupDrivers" /><span>{{ driver.name }} · {{ driver.vehicle_reg_no || driver.vehicle_model || 'No registered car' }}</span></label><p class="meta" *ngIf="!cityDrivers.length">No drivers are available in this city.</p></div>
      <div slot="footer"><tm-button variant="ghost" [disabled]="savingGroupDrivers" (clicked)="driverDrawerId = null">Cancel</tm-button><tm-button variant="green" [disabled]="savingGroupDrivers" (clicked)="commitDrawerDrivers()">{{ savingGroupDrivers ? 'Saving…' : 'Save assignments' }}</tm-button></div>
    </tm-drawer>
    <!-- ─────────────── drawers ─────────────── -->
    <tm-drawer [open]="createOpen" title="Add vehicle" [width]="560" (closed)="createOpen = false">
      <div slot="body" class="form">
        <p class="note">Choose an existing vehicle type or create a new one below. The type and city vehicle save together.</p>
        <label class="f"><span>Vehicle name <i>*</i></span>
          <select [(ngModel)]="create.vehicle_type_id">
            <option [ngValue]="null" disabled>Select vehicle name</option>
            <option *ngFor="let vt of vehicleTypeOptions" [ngValue]="vt.id">{{ vt.name }}</option>
            <option [ngValue]="-1">+ Create a new vehicle type</option>
          </select>
        </label>
        <label class="f" *ngIf="create.vehicle_type_id === -1"><span>New vehicle type <i>*</i></span><input [(ngModel)]="create.vehicle_type_name" maxlength="120" placeholder="e.g. Tavera, Bus, Bicycle" /></label>
        <label class="f"><span>Display name (optional)</span><input type="text" [(ngModel)]="create.display_name" placeholder="Leave blank to use the vehicle type name" /></label>
        <label class="f"><span>Vehicle set (optional)</span><select [(ngModel)]="create.vehicle_set_id"><option [ngValue]="null">No set</option><option *ngFor="let set of vehicleSets" [ngValue]="set.id">{{ set.name }}</option></select></label>
        <p class="note">Joining a set makes its shared stands available. Use Vehicle sets to create a set or change its stands.</p>
        <div class="fields">
          <label class="f"><span>Max people</span><input type="number" min="1" [(ngModel)]="create.max_people" /></label>
          <label class="f"><span>Luggage capacity</span><input type="number" min="0" [(ngModel)]="create.luggage_capacity" /></label>
        </div>
      </div>
      <div slot="footer">
        <tm-button variant="ghost" (clicked)="createOpen = false">Cancel</tm-button>
        <tm-button variant="green" [disabled]="creating || !createValid" (clicked)="submitCreate()">{{ creating ? 'Creating...' : 'Create vehicle' }}</tm-button>
      </div>
    </tm-drawer>

    <tm-drawer
      [open]="commonDrawerOpen"
      [title]="(commonDrawerVehicle?.display_name || 'Vehicle') + ' — edit vehicle'"
      subtitle="Shared by every fare mode of this vehicle"
      [width]="440"
      (closed)="closeCommonDrawer()"
    >
      <div slot="body" class="form">
        <div class="fields">
          <label class="f f--wide"><span>Vehicle name <i>*</i></span><input type="text" [(ngModel)]="common.display_name" /></label>
          <label class="f"><span>Max people</span><input type="number" min="1" [(ngModel)]="common.max_people" /></label>
          <label class="f"><span>Luggage capacity</span><input type="number" min="0" [(ngModel)]="common.luggage_capacity" /></label>
        </div>
        <p class="meta" *ngIf="commonDrawerVehicle" style="margin-top: 12px;">
          Depends on type: <b>{{ commonDrawerVehicle.vehicle_type_name || 'not set' }}</b> · Fare setup: <b>{{ fareModesLabel(commonDrawerVehicle) }}</b>.
          Saving patches every mode row that shares this name and type.
        </p>
      </div>
      <div slot="footer">
        <tm-button variant="ghost" (clicked)="closeCommonDrawer()">Cancel</tm-button>
        <tm-button variant="green" icon="check" [disabled]="savingCommon || !common.display_name.trim()" (clicked)="saveCommon()">
          {{ savingCommon ? 'Saving...' : 'Save' }}
        </tm-button>
      </div>
    </tm-drawer>

    <tm-drawer [open]="typesOpen" title="Vehicle types" subtitle="Global — shared across every city" [width]="480" (closed)="typesOpen = false">
      <div slot="body" class="form">
        <div class="typerow" *ngFor="let t of types">
          <span class="typerow__name">{{ t.name }}</span>
          <tm-status-pill [tone]="t.is_active ? 'success' : 'neutral'">{{ t.is_active ? 'Active' : 'Off' }}</tm-status-pill>
          <button type="button" class="mini-btn" (click)="startEditType(t)">Edit</button>
        </div>
        <p class="meta" *ngIf="!types.length">No vehicle types yet.</p>

        <div class="typeform">
          <label class="f"><span>{{ editingTypeId ? 'Edit vehicle type' : 'New vehicle type' }} <i>*</i></span>
            <input type="text" [(ngModel)]="typeForm.name" placeholder="Auto / Bike / Sedan / SUV" />
          </label>
          <label class="check" *ngIf="editingTypeId"><input type="checkbox" [(ngModel)]="typeForm.is_active" /> <span>Active</span></label>
          <div class="typeform__actions">
            <tm-button *ngIf="editingTypeId" variant="ghost" size="sm" (clicked)="resetTypeForm()">Cancel</tm-button>
            <tm-button variant="green" size="sm" [disabled]="!typeForm.name.trim() || typeSaving" (clicked)="saveType()">
              {{ typeSaving ? 'Saving...' : editingTypeId ? 'Save type' : '+ Add type' }}
            </tm-button>
          </div>
        </div>
      </div>
      <div slot="footer"><tm-button variant="ghost" (clicked)="typesOpen = false">Done</tm-button></div>
    </tm-drawer>



    <!-- ─────────────── Dedicated Vehicle Operations & Route Hub Drawer ─────────────── -->
    <tm-drawer
      [open]="operationsDrawerOpen"
      [widthPercent]="90"
      [title]="(operationsDrawerVehicle?.display_name || 'Vehicle') + ' — Fleet & Route Operations'"
      [subtitle]="(operationsDrawerVehicle?.vehicle_type_name || 'Fleet') + ' • ' + (operationsDrawerVehicle?.max_people || 1) + ' passenger seats • ' + (operationsDrawerVehicle?.luggage_capacity || 0) + ' luggage capacity'"
      (closed)="closeOperationsDrawer()"
    >
      <div
        slot="body"
        class="kb-wrapper"
        [class.is-dragging-active]="draggingRouteId != null"
        *ngIf="operationsDrawerVehicle as v"
        (click)="openDriverDropdownGroupId = null"
      >

        <!-- Top Controls & Actions Bar -->
        <div class="kb-top-bar">
          <div class="kb-top-left">
            <div class="kb-veh-tag">
              <span class="kb-veh-icon-box vehicle-photo" [class.vehicle-photo--configured]="!!v.image_url">
                <img *ngIf="v.image_url" [src]="v.image_url" [alt]="v.display_name" (error)="v.image_url = null" />
                <tm-icon *ngIf="!v.image_url" name="car" [size]="16" />
              </span>
              <span class="vehicle-marker-preview" *ngIf="v.map_marker_url" title="Shared live-map icon">
                <img [src]="v.map_marker_url" alt="Map marker icon" (error)="v.map_marker_url = null" />
              </span>
              <div class="kb-veh-info">
                <span class="kb-veh-name">{{ v.display_name }}</span>
                <span class="kb-veh-spec">{{ v.vehicle_type_name || 'Fleet' }} • {{ v.max_people }} seats • {{ v.luggage_capacity }} bags</span>
              </div>
            </div>

            <div class="kb-search">
              <tm-icon name="search" [size]="13" />
              <input
                type="text"
                [(ngModel)]="kanbanSearch"
                placeholder="Search route name, origin or destination" aria-label="Search routes"
              />
            </div>
          </div>

          <div class="kb-top-actions">
            <button type="button" class="btn-kb-outline" (click)="routeView = 'groups'; showGroupCreator = !showGroupCreator">Create stand</button>

            <button type="button" class="btn-kb-primary" (click)="newRouteFor(v)">
              <tm-icon name="plus" [size]="13" />
              <span>Add Route on Map</span>
            </button>
            <button type="button" class="btn-kb-outline" (click)="triggerKmlImportFor(v)">
              <tm-icon name="upload" [size]="13" />
              <span>Import KML</span>
            </button>
          </div>
        </div>

        <div class="route-view-tabs" aria-label="Route views">
          <button type="button" [class.selected]="routeView === 'all'" [attr.aria-pressed]="routeView === 'all'" (click)="routeView = 'all'">All routes ({{ routesForVehicle(v).length }})</button>
          <button type="button" [class.selected]="routeView === 'groups'" [attr.aria-pressed]="routeView === 'groups'" (click)="routeView = 'groups'">Stands</button>
        </div>

        <section class="route-directory" *ngIf="routeView === 'all'">
          <div class="route-directory-header">
            <div><h3>All routes</h3><p>View, edit and enable routes for this vehicle, including disabled routes.</p></div>
            <label>Status
              <select [(ngModel)]="routeStatusFilter">
                <option value="all">All statuses</option>
                <option value="enabled">Enabled</option>
                <option value="disabled">Disabled</option>
              </select>
            </label>
            <label>Scope
              <select [(ngModel)]="routeScopeFilter">
                <option value="all">All scopes</option>
                <option value="local">Local</option>
                <option value="outstation">Outstation</option>
              </select>
            </label>
          </div>
          <div class="route-directory-list">
            <article class="route-directory-row" *ngFor="let r of directoryRoutes(v)">
              <div class="route-directory-info">
                <strong>{{ r.name }}</strong>
                <span>{{ r.origin_name }} &rarr; {{ r.dest_name }}</span>
                <small>{{ routeGroupNames(r) }}</small>
              </div>
              <span class="pill pill--sm" [class.purple]="r.scope === 'outstation'" [class.blue]="r.scope === 'local'">{{ (r.scope || 'local') | uppercase }}</span>
              <span class="pill pill--sm" [class.success]="isRouteEnabled(r)" [class.neutral]="!isRouteEnabled(r)">{{ isRouteEnabled(r) ? 'Enabled' : 'Disabled' }}</span>
              <button type="button" class="btn-kb-outline" (click)="editRouteFor(v, r.id)">Edit route</button>
              <button type="button" class="btn-kb-outline" [disabled]="savingRouteIds.has(r.id)" [attr.aria-label]="(isRouteEnabled(r) ? 'Disable ' : 'Enable ') + r.name" (click)="toggleRouteActive(r, $event)">{{ savingRouteIds.has(r.id) ? 'Saving...' : (isRouteEnabled(r) ? 'Disable' : 'Enable') }}</button>
            </article>
            <div class="kb-empty-col" *ngIf="!directoryRoutes(v).length">
              <span>{{ routesForVehicle(v).length ? 'No routes match your search and status filter.' : 'No routes yet. Use Add Route on Map or Import KML to create one.' }}</span>
            </div>
          </div>
        </section>

        <div class="group-workspace" *ngIf="routeView === 'groups'">
          <aside class="group-navigation" aria-label="Stands">
            <h3>Stands</h3>
            <p>Select a stand to manage its routes and drivers.</p>
            <button type="button" class="btn-kb-primary" (click)="showGroupCreator = !showGroupCreator" [attr.aria-expanded]="showGroupCreator">Create stand</button>
            <form class="group-create-form" *ngIf="showGroupCreator" (ngSubmit)="quickCreateInlineGroup(v)">
              <label for="new-route-group">Stand name</label>
              <input id="new-route-group" name="groupName" [(ngModel)]="inlineNewGroupName[v.id]" placeholder="e.g. Dargah Sumo" required />
              <button type="submit" class="btn-kb-primary" [disabled]="!canCreateInlineGroup(v.id) || isCreatingInlineGroup">{{ isCreatingInlineGroup ? 'Creating...' : 'Create stand' }}</button>
            </form>
            <input class="group-search" [(ngModel)]="groupSearch" placeholder="Find a stand" aria-label="Find a stand" />
            <button type="button" class="group-nav-item" [class.selected]="selectedGroupSection === 'ungrouped'" (click)="selectGroupSection('ungrouped')"><span>Routes without a stand</span><b>{{ ungroupedForVehicle(v).length }}</b></button>
            <button type="button" class="group-nav-item" [class.selected]="selectedGroupSection === 'inactive'" (click)="selectGroupSection('inactive')"><span>Inactive routes</span><b>{{ inactiveRoutesForVehicle(v).length }}</b></button>
            <button type="button" class="group-nav-item" *ngFor="let group of navigationGroups(v)" [class.selected]="selectedGroupSection === group.id" (click)="selectGroupSection(group.id)">
              <span>{{ group.name }}<small>{{ driversIn(group).length }} drivers</small></span><b>{{ routesIn(group).length }}</b>
            </button>
            <p *ngIf="!navigationGroups(v).length">{{ groupsForVehicle(v).length ? 'No stands match your search.' : 'Create your first stand, then add routes and drivers.' }}</p>
          </aside>
        <!-- Kanban Board Columns Area -->
        <div class="kb-columns-container" *ngIf="routeView === 'groups'">

          <!-- COLUMN 0: UNGROUPED / UNASSIGNED ROUTES -->
          <div
            class="kb-column kb-column--unassigned"
            *ngIf="selectedGroupSection === 'ungrouped'"
            [class.is-drop-target]="dragOverColumnId === 'ungrouped'"
            (dragover)="onColDragOver($event, 'ungrouped')"
            (dragleave)="onColDragLeave('ungrouped')"
            (drop)="onColDrop($event, null)"
          >
            <div class="kb-col-header">
              <div class="kb-col-title-line">
                <div class="kb-col-title">
                  <span class="kb-col-dot kb-col-dot--sky"></span>
                  <span class="kb-col-heading">Routes without a stand</span>
                </div>
                <span class="kb-count-pill kb-count-pill--sky">
                  {{ filterKanbanRoutes(ungroupedForVehicle(v)).length }}
                </span>
              </div>
              <p class="kb-col-desc">Unassigned routes ready for map edits or stand assignment</p>
            </div>

            <div class="kb-cards-scroll">
              <div
                class="kb-card kb-card--unassigned"
                [class.is-dragging]="draggingRouteId === r.id"
                draggable="true"
                (dragstart)="onCardDragStart($event, r, null)"
                (dragend)="onCardDragEnd()"
                *ngFor="let r of filterKanbanRoutes(ungroupedForVehicle(v))"
              >
                <div class="kb-card-head">
                  <div class="kb-card-title-group">
                    <span class="kb-drag-handle" title="Drag route into a stand column">
                      <tm-icon name="menu" [size]="12" />
                    </span>
                    <span class="kb-card-name" [title]="r.name">{{ r.name }}</span>
                  </div>
                  <button
                    type="button"
                    class="pill pill--sm"
                    [class.success]="r.is_active"
                    [class.neutral]="!r.is_active"
                    [title]="r.is_active ? 'Route Active — click to disable' : 'Route Inactive — click to enable'"
                    (click)="toggleRouteActive(r, $event)"
                  >
                    <span class="led"></span>{{ r.is_active ? 'Active' : 'Off' }}
                  </button>
                </div>

                <div class="kb-card-path">
                  <span [title]="r.origin_name + ' → ' + r.dest_name">{{ r.origin_name }} → {{ r.dest_name }}</span>
                </div>

                <div class="kb-card-meta-row">
                  <span class="kb-fare-pill" *ngIf="r.flat_fare != null">₹{{ r.flat_fare }}</span>
                  <span class="kb-fare-pill kb-fare-pill--warn" *ngIf="r.flat_fare == null">
                    <tm-icon name="alert-triangle" [size]="10" /> No fare
                  </span>
                  <span class="kb-stops-pill" *ngIf="r.stops?.length">
                    <tm-icon name="map-marker" [size]="10" /> {{ r.stops?.length }} stops
                  </span>
                </div>

                <div class="kb-card-footer">
                  <button
                    type="button"
                    class="kb-action-btn kb-action-btn--edit"
                    (click)="editRouteFor(v, r.id)"
                    title="Edit route path and stops on map"
                  >
                    <tm-icon name="edit" [size]="11" />
                    <span>Edit Map</span>
                  </button>

                  <div class="kb-move-dropdown" *ngIf="groupsForVehicle(v).length">
                    <select class="kb-select-input" (change)="onMoveSelectChange(null, $event, r.id)">
                      <option value="" disabled selected>Move to stand ▾</option>
                      <option *ngFor="let targetG of groupsForVehicle(v)" [value]="targetG.id">{{ targetG.name }}</option>
                    </select>
                  </div>
                </div>
              </div>

              <!-- Drop Target Indicator Placeholder -->
              <div class="kb-drop-placeholder" *ngIf="dragOverColumnId === 'ungrouped' && draggingRouteId">
                <tm-icon name="arrow-right" [size]="14" />
                <span>Drop here to unassign route</span>
              </div>

              <div class="kb-empty-col" *ngIf="!filterKanbanRoutes(ungroupedForVehicle(v)).length && dragOverColumnId !== 'ungrouped'">
                <tm-icon name="check" [size]="20" />
                <span>All routes are assigned to stands</span>
              </div>
            </div>
          </div>

          <section class="kb-column" aria-label="Inactive routes" *ngIf="selectedGroupSection === 'inactive'">
            <div class="kb-col-header">
              <div class="kb-col-title-line">
                <div class="kb-col-title">
                  <span class="kb-col-heading">Inactive routes</span>
                </div>
                <span class="kb-count-pill">{{ filterKanbanRoutes(inactiveRoutesForVehicle(v)).length }}</span>
              </div>
              <p class="kb-col-desc">Enable a route to return it to its assigned stand or No stand.</p>
            </div>
            <div class="kb-cards-scroll">
              <article class="kb-card" *ngFor="let r of filterKanbanRoutes(inactiveRoutesForVehicle(v))">
                <div class="kb-card-head">
                  <span class="kb-card-name" [title]="r.name">{{ r.name }}</span>
                  <span class="pill pill--sm neutral">Inactive</span>
                </div>
                <div class="kb-card-path">{{ r.origin_name }} &rarr; {{ r.dest_name }}</div>
                <div class="kb-card-path">{{ routeGroupNames(r) }}</div>
                <div class="kb-card-footer">
                  <button type="button" class="kb-action-btn kb-action-btn--edit" (click)="editRouteFor(v, r.id)">Edit route</button>
                  <button type="button" class="btn-kb-primary" [disabled]="savingRouteIds.has(r.id)" [attr.aria-label]="'Enable ' + r.name" (click)="toggleRouteActive(r, $event)">{{ savingRouteIds.has(r.id) ? 'Saving...' : 'Enable route' }}</button>
                </div>
              </article>
              <div class="kb-empty-col" *ngIf="!filterKanbanRoutes(inactiveRoutesForVehicle(v)).length">
                <span>{{ inactiveRoutesForVehicle(v).length ? 'No inactive routes match your search.' : 'No inactive routes for this vehicle.' }}</span>
              </div>
            </div>
          </section>

          <!-- COLUMNS 1..N: GROUP COLUMNS -->
          <div
            class="kb-column kb-column--group"
            [class.is-drop-target]="dragOverColumnId === g.id"
            (dragover)="onColDragOver($event, g.id)"
            (dragleave)="onColDragLeave(g.id)"
            (drop)="onColDrop($event, g)"
            *ngFor="let g of selectedOperationGroups(v); trackBy: trackGroup"
          >
            <div class="kb-col-header">
              <div class="kb-col-title-line">
                <div class="kb-col-title" *ngIf="renamingGroupId !== g.id">
                  <span class="kb-col-dot kb-col-dot--green"></span>
                  <span class="kb-grp-name" [title]="g.name">{{ g.name }}</span>
                </div>
                <input
                  *ngIf="renamingGroupId === g.id"
                  class="kb-rename-input"
                  [(ngModel)]="renameValue"
                  (keydown.enter)="saveInlineRename(g)"
                  (keydown.escape)="renamingGroupId = null"
                  (blur)="saveInlineRename(g)"
                  autofocus
                />

                <div class="kb-grp-acts">
                  <span class="kb-count-pill">{{ filterKanbanRoutes(routesIn(g)).length }}</span>
                  <button type="button" class="btn-kb-outline" title="Rename stand" (click)="startInlineRename(g)">
                    Rename
                  </button>
                  <button type="button" class="btn-kb-outline" title="Delete stand" (click)="deleteGroup(g)">
                    Delete stand
                  </button>
                </div>
              </div>

              <!-- Driver Assignment Row in Header -->
              <div class="kb-driver-assign-section" (click)="$event.stopPropagation()">
                <div class="kb-drv-head-row">
                  <div class="kb-drv-chips-container" *ngIf="driversIn(g).length; else noDriversYet">
                    <span class="kb-drv-chip" *ngFor="let d of driversIn(g)" [title]="d.name + ' (' + (d.phone || 'No phone') + ')'">
                      <span class="kb-chip-avatar">{{ initials(d.name) }}</span>
                      <span class="kb-chip-name">{{ d.name }}</span>
                      <button type="button" class="kb-chip-remove" (click)="toggleDriverGroup(d, g, v)" title="Remove driver">×</button>
                    </span>
                  </div>
                  <ng-template #noDriversYet>
                    <span class="kb-no-drv-hint">No drivers assigned</span>
                  </ng-template>

                  <button
                    type="button"
                    class="kb-btn-manage-drv"
                    (click)="toggleGroupDriverDropdown(g.id, $event)"
                    title="Manage assigned drivers"
                  >
                    <span>Manage drivers</span>
                    <tm-icon name="chevron-down" [size]="10" />
                  </button>
                </div>

                <!-- Driver Popover Picker -->
                <div class="kb-drv-popover" *ngIf="openDriverDropdownGroupId === g.id">
                  <div class="kb-popover-head">
                    <b>Assign Drivers to {{ g.name }}</b>
                    <button type="button" class="kb-popover-x" (click)="openDriverDropdownGroupId = null">×</button>
                  </div>
                  <input class="group-search" [(ngModel)]="groupDriverSearch" placeholder="Search drivers" aria-label="Search drivers" />
                  <div class="kb-popover-list" *ngIf="filteredGroupDrivers(v).length; else noDriversRegistered">
                    <label class="kb-popover-item" *ngFor="let d of filteredGroupDrivers(v)">
                      <input
                        type="checkbox"
                        [checked]="isDriverInGroup(d.user_id, g.id)"
                        [disabled]="syncingDriverId === d.user_id"
                        (change)="toggleDriverGroup(d, g, v)"
                      />
                      <div class="kb-popover-item-info">
                        <span class="kb-pop-dname">{{ d.name }}</span>
                        <span class="kb-pop-dreg">{{ d.vehicle_reg_no || d.vehicle_model || v.display_name }}</span>
                      </div>
                    </label>
                  </div>
                  <ng-template #noDriversRegistered>
                    <div class="kb-pop-empty">No matching drivers for this vehicle.</div>
                  </ng-template>
                </div>
              </div>
            </div>

            <div class="group-route-actions">
              <button type="button" class="btn-kb-primary" (click)="showGroupRoutePicker = !showGroupRoutePicker" [attr.aria-expanded]="showGroupRoutePicker">Add routes</button>
              <span>{{ routesIn(g).length }} active routes in this stand</span>
            </div>
            <div class="group-route-picker" *ngIf="showGroupRoutePicker">
              <strong>Add routes without a stand</strong>
              <p>Select routes below, then add them together. Set a fare before adding a route.</p>
              <input class="group-search" [(ngModel)]="groupRouteSearch" placeholder="Find a route to add" aria-label="Find a route to add" />
              <div class="group-picker-list">
                <label *ngFor="let route of groupRouteCandidates(v)">
                  <input type="checkbox" [checked]="pendingGroupRouteIds.has(route.id)" [disabled]="route.flat_fare == null || savingGroupRoutes" (change)="togglePendingGroupRoute(route.id)" />
                  <span>{{ route.name }}<small>{{ route.flat_fare == null ? 'Set a fare in All routes first' : route.origin_name + ' to ' + route.dest_name }}</small></span>
                </label>
                <p *ngIf="!groupRouteCandidates(v).length">No matching routes without a stand. Create a route or move one from another stand.</p>
              </div>
              <button type="button" class="btn-kb-primary" [disabled]="!pendingGroupRouteIds.size || savingGroupRoutes" (click)="addSelectedRoutesToGroup(v, g)">{{ savingGroupRoutes ? 'Adding...' : 'Add selected routes (' + pendingGroupRouteIds.size + ')' }}</button>
            </div>
            <!-- Group Routes Cards -->
            <div class="kb-cards-scroll">
              <div
                class="kb-card kb-card--assigned"
                [class.is-dragging]="draggingRouteId === r.id"
                draggable="true"
                (dragstart)="onCardDragStart($event, r, g)"
                (dragend)="onCardDragEnd()"
                *ngFor="let r of filterKanbanRoutes(routesIn(g))"
              >
                <div class="kb-card-head">
                  <div class="kb-card-title-group">
                    <span class="kb-drag-handle" title="Drag route to another stand">
                      <tm-icon name="menu" [size]="12" />
                    </span>
                    <span class="kb-card-name" [title]="r.name">{{ r.name }}</span>
                  </div>
                  <button
                    type="button"
                    class="pill pill--sm"
                    [class.success]="r.is_active"
                    [class.neutral]="!r.is_active"
                    [title]="r.is_active ? 'Route Active — click to disable' : 'Route Inactive — click to enable'"
                    (click)="toggleRouteActive(r, $event)"
                  >
                    <span class="led"></span>{{ r.is_active ? 'Active' : 'Off' }}
                  </button>
                </div>

                <div class="kb-card-path">
                  <span [title]="r.origin_name + ' → ' + r.dest_name">{{ r.origin_name }} → {{ r.dest_name }}</span>
                </div>

                <div class="kb-card-meta-row">
                  <span class="kb-fare-pill" *ngIf="r.flat_fare != null">₹{{ r.flat_fare }}</span>
                  <span class="kb-fare-pill kb-fare-pill--warn" *ngIf="r.flat_fare == null">
                    <tm-icon name="alert-triangle" [size]="10" /> No fare
                  </span>
                  <span class="kb-stops-pill" *ngIf="r.stops?.length">
                    <tm-icon name="map-marker" [size]="10" /> {{ r.stops?.length }} stops
                  </span>
                </div>

                <div class="kb-card-footer">
                  <button type="button" class="kb-action-btn kb-action-btn--edit" (click)="editRouteFor(v, r.id)">Edit route</button>
                  <div class="kb-move-dropdown">
                    <select class="kb-select-input" (change)="onMoveSelectChange(g, $event, r.id)">
                      <option value="" disabled selected>Move to ▾</option>
                      <option value="ungrouped">Routes without a stand</option>
                      <option *ngFor="let otherG of getOtherGroups(v, g.id)" [value]="otherG.id">{{ otherG.name }}</option>
                    </select>
                  </div>

                  <button
                    type="button"
                    class="kb-action-btn kb-action-btn--remove"
                    (click)="ungroupRoute(g, r.id)"
                    title="Remove route from this stand"
                  >
                    <tm-icon name="x" [size]="11" />
                    <span>Remove from stand</span>
                  </button>
                </div>
              </div>

              <!-- Drop Target Indicator Placeholder -->
              <div class="kb-drop-placeholder" *ngIf="dragOverColumnId === g.id && draggingRouteId">
                <tm-icon name="plus" [size]="14" />
                <span>Drop to move into {{ g.name }}</span>
              </div>

              <div class="kb-empty-col" *ngIf="!filterKanbanRoutes(routesIn(g)).length && dragOverColumnId !== g.id">
                <tm-icon name="road" [size]="20" />
                <span>No matching active routes. Use Add routes to assign routes to this stand.</span>
              </div>
            </div>
          </div>

        </div>

        </div>
      </div>

      <div slot="footer">
        <tm-button variant="ghost" (clicked)="closeOperationsDrawer()">Close</tm-button>
      </div>
    </tm-drawer>

    <!-- Fare editor — opens the real fare form for one vehicle + ride type. -->
    <tm-drawer [open]="fareDrawerOpen" [title]="(selected?.display_name || 'Vehicle') + ' — ' + (activeRideType?.name || 'fare')" [subtitle]="fareSubtitle" [width]="620" (closed)="closeFareDrawer()">
      <div slot="body" class="form" *ngIf="activeRideType && !activeIsFixed">
        <ng-container *ngIf="activeRow; else preparingFare">
          <div class="sec" *ngIf="activeKind === 'private'">
            <div class="sec__head"><h3>{{ activeRideType.name }} unique fields</h3></div>
            <div class="inline">
              <label class="check"><input type="checkbox" [(ngModel)]="reverseBidding" /> <span>Reverse bidding</span></label>
              <tm-button variant="outline" size="sm" icon="check" [disabled]="savingUnique" (clicked)="saveUniqueFields()">{{ savingUnique ? 'Saving...' : 'Save unique fields' }}</tm-button>
            </div>
          </div>
          <div class="sec">
            <app-vehicle-base-pricing *ngIf="!activeRow.is_outstation" [cityId]="cityId" [cityVehicleTypeId]="activeRow.id" [title]="activeRideType.name + ' Fare Settings'" [subtitle]="fareSubtitle"></app-vehicle-base-pricing>
            <app-outstation-packages *ngIf="activeRow.is_outstation" [cityId]="cityId" [vehicleTypeId]="activeRow.id"></app-outstation-packages>
          </div>
        </ng-container>
        <ng-template #preparingFare>
          <div class="cue cue--flat"><tm-icon name="rupee" [size]="22" /><strong>Preparing {{ activeRideType.name }} fare form…</strong><span>Setting up {{ activeRideType.name }} fare for {{ selected?.display_name }}.</span></div>
        </ng-template>
      </div>
      <div slot="footer"><tm-button variant="ghost" (clicked)="closeFareDrawer()">Done</tm-button></div>
    </tm-drawer>

    <!-- Seat layouts list for the selected vehicle's type. -->
    <tm-drawer [open]="layoutsListOpen" [title]="(selected?.display_name || 'Vehicle') + ' — seat layouts'" [subtitle]="'Shared by every ' + (selected?.vehicle_type_name || 'vehicle') + ' in this city'" [width]="560" (closed)="closeLayoutsList()">
      <div slot="body" class="form" *ngIf="selected">
        <div class="layout" *ngFor="let l of selLayouts">
          <div class="layout__preview"><app-seat-grid [rows]="l.rows" [cols]="l.cols" [cells]="l.cells" [frame]="true" [showWheel]="false" [showLegend]="false"></app-seat-grid></div>
          <div class="layout__meta"><span class="layout__name">{{ l.name }}</span><span class="layout__sub">{{ l.rows }}×{{ l.cols }} · {{ l.seat_count }} seats<ng-container *ngIf="l.in_use"> · in use</ng-container></span></div>
          <div class="layout__actions"><button type="button" class="mini-btn" (click)="editLayout(l)">Edit</button><button type="button" class="x" *ngIf="!l.in_use" title="Delete layout" (click)="deleteLayout(l)">×</button></div>
        </div>
        <div class="cue cue--flat" *ngIf="!selLayouts.length"><strong>No {{ selected.vehicle_type_name || 'vehicle' }} layouts yet</strong><span>A seat layout is the seat map a passenger taps to pick a seat.</span></div>
      </div>
      <div slot="footer"><tm-button variant="ghost" (clicked)="closeLayoutsList()">Done</tm-button><tm-button variant="green" icon="plus" [disabled]="selected?.vehicle_type_id == null" (clicked)="openDesigner()">Design layout</tm-button></div>
    </tm-drawer>

    <!-- Row kebab menu. -->
    <div class="menu-scrim" *ngIf="menuId != null" (click)="closeRowMenu()"></div>
    <div class="rowmenu" *ngIf="menuVehicle as v" [style.left.px]="menuX" [style.top.px]="menuY">
      <button type="button" (click)="closeRowMenu(); openCommonDrawer(v)"><tm-icon name="edit" [size]="15" /> Edit vehicle</button>
      <button type="button" (click)="closeRowMenu(); openLayoutsList(v)"><tm-icon name="grid" [size]="15" /> Seat layouts</button>
      <button type="button" (click)="closeRowMenu(); openAppAssets(v)"><tm-icon name="upload" [size]="15" /> App Assets</button>
      <button type="button" (click)="closeRowMenu(); toggleExpand(v)"><tm-icon name="road" [size]="15" /> Stands</button>
      <button type="button" (click)="closeRowMenu(); openCopyModal(v)"><tm-icon name="copy" [size]="15" /> Copy to location</button>
      <div class="rowmenu__div"></div>
      <button type="button" (click)="closeRowMenu(); toggleActiveFor(v)"><tm-icon name="refresh" [size]="15" /> {{ v.is_active ? 'Disable' : 'Enable' }}</button>
    </div>

    <!-- Seat-layout designer — wide side drawer, opens over the workspace. -->
    <div class="ldr-scrim" *ngIf="layoutDrawerOpen" (click)="closeLayoutDrawer()"></div>
    <div class="ldr" *ngIf="layoutDrawerOpen && selected">
      <app-seat-layout-designer
        [embedded]="true"
        [embeddedCityId]="cityId"
        [embeddedVehicleTypeId]="selected.vehicle_type_id"
        [embeddedVehicleTypeName]="selected.vehicle_type_name || ''"
        [embeddedLayoutId]="editingLayoutId"
        [editLayoutData]="editingLayout"
        [existingLayouts]="selLayouts"
        (saved)="onLayoutSaved()"
        (cancelled)="closeLayoutDrawer()"
      ></app-seat-layout-designer>
    </div>

    <!-- Edit an ungrouped route: choose to edit by hand or replace from My Maps. -->
    <tm-modal [open]="editChoiceOpen" title="Edit route" (closed)="editChoiceOpen = false">
      <ng-container slot="body">
        <p class="echoice__lead">How do you want to edit <b>{{ editChoiceName }}</b>?</p>
        <div class="echoice">
          <button type="button" class="echoice__opt" (click)="chooseManualEdit()">
            <span class="echoice__ic"><tm-icon name="edit" [size]="18" /></span>
            <span class="echoice__txt">
              <span class="echoice__t">Edit manually</span>
              <span class="echoice__d">Open the map editor and adjust the line, stops, fare and settings by hand.</span>
            </span>
          </button>
          <button type="button" class="echoice__opt" [disabled]="importingKml" (click)="chooseMyMapsEdit()">
            <span class="echoice__ic"><tm-icon name="map" [size]="18" /></span>
            <span class="echoice__txt">
              <span class="echoice__t">{{ importingKml ? 'Reading…' : 'Update from Google My Maps' }}</span>
              <span class="echoice__d">Upload the edited KML/KMZ — the line &amp; stops are replaced, fare &amp; settings kept.</span>
            </span>
          </button>
        </div>
      </ng-container>
    </tm-modal>

    <!-- Import from My Maps: single (review each) or bulk (many, no price). -->
    <tm-modal [open]="importChoiceOpen" title="Import from Google My Maps" (closed)="importChoiceOpen = false">
      <ng-container slot="body">
        <p class="echoice__lead">Importing to <b>{{ importChoiceVehicle?.display_name || 'this vehicle' }}</b>.</p>
        <div class="echoice">
          <button type="button" class="echoice__opt" (click)="chooseSingleImport()">
            <span class="echoice__ic"><tm-icon name="edit" [size]="18" /></span>
            <span class="echoice__txt">
              <span class="echoice__t">Single — review each</span>
              <span class="echoice__d">Open each route on the map to set its stops, fare and settings before saving.</span>
            </span>
          </button>
          <button type="button" class="echoice__opt" [disabled]="importingKml" (click)="chooseBulkImport()">
            <span class="echoice__ic"><tm-icon name="upload" [size]="18" /></span>
            <span class="echoice__txt">
              <span class="echoice__t">{{ importingKml ? 'Importing…' : 'Bulk — import all now' }}</span>
              <span class="echoice__d">Pick one or more My Maps files; every route in them is added at once (name &amp; line only). They land as “Needs pricing” to finish later.</span>
            </span>
          </button>
        </div>
      </ng-container>
    </tm-modal>

    <!-- Copy vehicle settings to another location (City) -->
    <tm-drawer
      [open]="copyModalOpen"
      [title]="copyModalTitle"
      subtitle="Duplicate vehicle name, vehicle type, seat designs & fare rate cards to other cities"
      [width]="560"
      (closed)="copyModalOpen = false"
    >
      <div slot="body" class="form">
        <!-- Source city info -->
        <div class="note" style="display: flex; align-items: center; justify-content: space-between;">
          <span>Source Location: <b>{{ cityName || 'Current city' }}</b></span>
          <span class="badge badge--mute">{{ copyForm.vehicle_ids.length }} {{ copyForm.vehicle_ids.length === 1 ? 'vehicle' : 'vehicles' }} selected</span>
        </div>

        <!-- 1. Vehicles being copied -->
        <div class="f" style="margin-top: 10px;">
          <div class="f__head-row">
            <span>Vehicles to Copy</span>
            <div style="display: flex; gap: 6px;">
              <button type="button" class="mini-btn" (click)="selectAllVehiclesForCopy()">Select all</button>
              <button type="button" class="mini-btn" (click)="copyForm.vehicle_ids = []">Clear</button>
            </div>
          </div>
          <div class="chip-grid" *ngIf="vehicles.length; else noVehiclesToCopy">
            <button
              *ngFor="let v of vehicles"
              type="button"
              class="multi-chip"
              [class.is-selected]="copyForm.vehicle_ids.includes(v.id)"
              (click)="toggleCopyVehicle(v.id)"
            >
              <tm-icon [name]="copyForm.vehicle_ids.includes(v.id) ? 'check' : 'plus'" [size]="12" />
              <span><b>{{ v.display_name }}</b> ({{ v.vehicle_type_name || 'Vehicle' }})</span>
              <span class="muted" style="margin-left: 4px;">· {{ v.max_people }} seats</span>
            </button>
          </div>
          <ng-template #noVehiclesToCopy>
            <p class="meta">No vehicles available in current location.</p>
          </ng-template>
        </div>

        <!-- 2. Target Cities Selection -->
        <div class="f" style="margin-top: 12px;">
          <div class="f__head-row">
            <span>Target Location(s) / Destination Cities <i>*</i></span>
            <div style="display: flex; gap: 6px;">
              <button type="button" class="mini-btn mini-btn--go" (click)="selectAllTargetCities()">Select all</button>
              <button type="button" class="mini-btn" (click)="clearTargetCities()">Clear</button>
            </div>
          </div>
          <p class="meta" *ngIf="!availableTargetCities.length">No other cities configured yet. Create more cities under Settings &gt; Cities first.</p>
          <div class="chip-grid" *ngIf="availableTargetCities.length">
            <button
              *ngFor="let c of availableTargetCities"
              type="button"
              class="multi-chip"
              [class.is-selected]="copyForm.target_city_ids.includes(c.id)"
              (click)="toggleTargetCity(c.id)"
            >
              <tm-icon [name]="copyForm.target_city_ids.includes(c.id) ? 'check' : 'plus'" [size]="12" />
              <span>{{ c.name }}</span>
            </button>
          </div>
        </div>

        <!-- 3. Copy Modules & Options -->
        <div class="f" style="margin-top: 14px;">
          <span>Copy Modules &amp; Settings</span>
          <div style="display: flex; flex-direction: column; gap: 10px; margin-top: 4px; padding: 12px; border: 1px solid var(--tm-line); border-radius: 10px; background: var(--tm-canvas);">
            <label class="check" style="align-items: flex-start;">
              <input type="checkbox" [checked]="true" disabled style="margin-top: 3px;" />
              <span style="display: flex; flex-direction: column; gap: 2px;">
                <b>Vehicle Name, Vehicle Type &amp; Capacities</b>
                <span class="muted">Name, Type, Seats count, Bags, Dispatch hops</span>
              </span>
            </label>
            <label class="check" style="align-items: flex-start;">
              <input type="checkbox" [(ngModel)]="copyForm.copy_seat_layouts" style="margin-top: 3px;" />
              <span style="display: flex; flex-direction: column; gap: 2px;">
                <b>Design Seats &amp; Seat Layouts</b>
                <span class="muted">Copies reusable seat map designs for this vehicle type</span>
              </span>
            </label>
            <label class="check" style="align-items: flex-start;">
              <input type="checkbox" [(ngModel)]="copyForm.copy_pricing" style="margin-top: 3px;" />
              <span style="display: flex; flex-direction: column; gap: 2px;">
                <b>Fares &amp; Pricing Rate Cards</b>
                <span class="muted">Base price, km rates, commissions, and outstation packages</span>
              </span>
            </label>
            <label class="check" style="align-items: flex-start; border-top: 1px solid var(--tm-line); padding-top: 10px; margin-top: 2px;">
              <input type="checkbox" [(ngModel)]="copyForm.overwrite_existing" style="margin-top: 3px;" />
              <span style="display: flex; flex-direction: column; gap: 2px;">
                <b>Overwrite existing</b>
                <span class="muted">Update vehicle and layout if already present in target city</span>
              </span>
            </label>
          </div>
        </div>
      </div>

      <div slot="footer">
        <span class="drawer-count" *ngIf="copyForm.target_city_ids.length">
          {{ copyForm.target_city_ids.length }} {{ copyForm.target_city_ids.length === 1 ? 'city' : 'cities' }} selected
        </span>
        <span class="ws__grow"></span>
        <tm-button variant="ghost" (clicked)="copyModalOpen = false">Cancel</tm-button>
        <tm-button
          variant="green"
          icon="copy"
          [disabled]="!copyForm.target_city_ids.length || !copyForm.vehicle_ids.length || copyingToLocation"
          (clicked)="submitCopyToLocation()"
        >
          {{ copyingToLocation ? 'Copying...' : 'Copy Vehicle Settings' }}
        </tm-button>
      </div>
    </tm-drawer>

    <!-- Hidden picker for "Bulk" import — creates Needs-pricing routes. Multiple files allowed. -->
    <input #bulkKmlInput type="file" accept=".kml,.kmz" multiple hidden (change)="onBulkKmlFileSelected($event)" />
  `,
  styles: [`
    .ws { display: flex; flex-direction: column; gap: 14px; }
    .echoice__lead { margin: 0 0 14px; color: var(--tm-text-muted); }
    .rchip2--nopr { border-color: #ffe2a8; background: #fff7e6; }
    .npbadge { margin-left: 6px; font-size: 10px; font-weight: 800; color: #9a6700; white-space: nowrap; }
    .npbadge--xs { margin-left: 4px; font-size: 9px; }
    .multi-chip--nopr { border-color: #ffe2a8 !important; background: #fff7e6; color: #9a6700; }
    .pick--nopr { border-color: #ffe2a8 !important; background: #fff7e6; }
    .rx.add[disabled] { opacity: .4; cursor: not-allowed; }
    .echoice { display: flex; flex-direction: column; gap: 10px; }
    .echoice__opt { display: flex; align-items: flex-start; gap: 12px; width: 100%; text-align: left; padding: 14px; border: 1px solid var(--tm-line); border-radius: var(--tm-radius-lg, 12px); background: var(--tm-surface); cursor: pointer; transition: border-color .15s, background .15s, transform .05s; }
    .echoice__opt:hover:not([disabled]) { border-color: var(--tm-green, #0f7a3f); background: var(--tm-canvas-2, #eef1f5); }
    .echoice__opt:active:not([disabled]) { transform: translateY(1px); }
    .echoice__opt[disabled] { opacity: .6; cursor: default; }
    .echoice__ic { display: inline-flex; align-items: center; justify-content: center; width: 38px; height: 38px; flex: none; border-radius: 10px; background: var(--tm-canvas-2, #eef1f5); color: var(--tm-green, #0f7a3f); }
    .echoice__txt { display: flex; flex-direction: column; gap: 3px; }
    .echoice__t { font-weight: 800; color: var(--tm-text); }
    .echoice__d { font-size: 12.5px; color: var(--tm-text-muted); line-height: 1.4; }
    .vehicle-page-heading p { margin: 6px 0 0; color: var(--tm-text-muted); font-size: 14px; }
    .vehicle-page-heading { flex: 1 1 360px; min-width: 0; }
    .vehicle-page-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
    .vehicle-filter { display: flex; flex: 0 1 170px; min-width: 140px; }
    .vehicle-filter select { width: 100%; height: 40px; box-sizing: border-box; padding: 0 12px; border: 1px solid var(--tm-line); border-radius: 10px; background: var(--tm-surface); color: var(--tm-text); font: inherit; font-size: 13px; }
    .vehicle-view-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-left: auto; }
    .vehicle-view-controls .count-note { margin-left: 0; white-space: nowrap; }
    .vehicle-view-controls .route-view-tabs button { height: 40px; box-sizing: border-box; padding: 0 16px; font-size: 13px; }
    .vehicle-overview { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); gap: 20px; }
    .vehicle-summary { border: 1px solid var(--tm-line); border-radius: 16px; padding: 20px; background: var(--tm-surface); align-self: start; }
    .vehicle-summary--selected { border-color: var(--tm-green, #16a34a); }
    .vehicle-summary header { display: flex; align-items: center; gap: 12px; }
    .vehicle-select input { width: 18px; height: 18px; }
    .vehicle-summary-title { flex: 1; min-width: 0; }
    .vehicle-photo { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .vehicle-photo img { width: 100%; height: 100%; object-fit: contain; }
    .vehicle-photo--overview { width: 72px; height: 52px; color: var(--tm-text-muted); }
    .veh-ic.vehicle-photo--configured, .kb-veh-icon-box.vehicle-photo--configured { width: 56px; height: 40px; background: transparent; }
    .vehicle-marker-preview { display: inline-flex; width: 24px; height: 36px; flex-shrink: 0; }
    .vehicle-marker-preview img { width: 100%; height: 100%; object-fit: contain; }
    .vehicle-summary-title h2 { margin: 0 0 6px; font-size: 18px; overflow-wrap: anywhere; }
    .vehicle-summary-title span { color: var(--tm-text-muted); font-size: 13px; }
    .vehicle-summary-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 20px 0; }
    .vehicle-summary-stats button { display: flex; flex-direction: column; gap: 5px; border: 1px solid var(--tm-line); border-radius: 10px; background: var(--tm-canvas); padding: 12px; color: var(--tm-text); cursor: pointer; font: inherit; }
    .vehicle-summary-stats b { font-size: 20px; }
    .vehicle-summary-stats span { font-size: 12px; color: var(--tm-text-muted); }
    .vehicle-summary-actions, .vehicle-settings-actions { display: flex; gap: 10px; flex-wrap: wrap; }
    .vehicle-settings { margin-top: 20px; border-top: 1px solid var(--tm-line); padding-top: 16px; }
    .vehicle-settings summary { cursor: pointer; font-size: 13px; }
    .vehicle-settings-actions { margin-top: 14px; }
    .vehicle-edit-hint { margin: 0; font-size: 13px; color: var(--tm-text-muted); }
    .ws__head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .ws__head h1 { margin: 0; font-size: 22px; font-weight: 800; color: var(--tm-text); }
    .ws__city { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border: 1px solid var(--tm-line); border-radius: 999px; background: var(--tm-surface); font-size: 12px; font-weight: 700; color: var(--tm-text-muted); }
    .ws__grow { flex: 1; }

    .cue { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 34px 20px; text-align: center; background: var(--tm-surface); border: 1px dashed var(--tm-line); border-radius: 12px; color: var(--tm-text-muted); font-size: 13px; }
    .cue strong { color: var(--tm-text); font-size: 14px; }
    .cue--flat { background: transparent; }

    .split { display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: 14px; align-items: start; }
    .panel { background: var(--tm-surface); border: 1px solid var(--tm-line); border-radius: 12px; overflow: hidden; }

    .list__top { display: flex; flex-direction: column; gap: 8px; padding: 11px; border-bottom: 1px solid var(--tm-line); }
    .list__bar { display: flex; gap: 8px; }
    .search { display: flex; align-items: center; gap: 7px; flex: 1; min-width: 0; padding: 0 10px; height: 34px; border: 1px solid var(--tm-line); border-radius: 9px; background: var(--tm-canvas); color: var(--tm-text-muted); }
    .search input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; color: var(--tm-text); font: inherit; font-size: 13px; }
    .mini { max-width: 118px; height: 34px; padding: 0 8px; border: 1px solid var(--tm-line); border-radius: 9px; background: var(--tm-canvas); color: var(--tm-text); font: inherit; font-size: 12.5px; outline: none; }
    .chips { display: flex; gap: 6px; flex-wrap: wrap; }
    .chip { padding: 3px 11px; border: 1px solid var(--tm-line); border-radius: 999px; background: var(--tm-surface); color: var(--tm-text-muted); font: inherit; font-size: 12px; cursor: pointer; }
    .chip[aria-pressed="true"] { border-color: transparent; background: var(--tm-green-tint, #ecfdf5); color: var(--tm-green, #16a34a); font-weight: 800; }

    .rows { display: flex; flex-direction: column; gap: 4px; padding: 7px; max-height: 560px; overflow-y: auto; }
    .row { display: flex; align-items: center; gap: 4px; width: 100%; padding: 0 6px 0 0; border: 1px solid transparent; border-radius: 10px; background: transparent; }
    .row:hover { background: var(--tm-canvas); }
    .row[aria-current="true"] { background: var(--tm-green-tint, #ecfdf5); border-color: var(--tm-green, #16a34a); }
    /* Disabled vehicles read dimmer instead of carrying a status pill. */
    .row.is-off .row__name { color: var(--tm-text-muted); }
    .row.is-off .row__name::after { content: ' · disabled'; font-weight: 600; font-size: 11px; color: var(--tm-text-muted); }
    .row__hit { flex: 1; min-width: 0; display: flex; padding: 9px 4px 9px 10px; border: 0; background: transparent; text-align: left; font: inherit; cursor: pointer; }
    /* Pen sits on the same line as the name; visible on hover / when selected. */
    .row__edit { flex: none; width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 8px; background: transparent; color: var(--tm-text-muted); cursor: pointer; opacity: 0; transition: opacity .12s, background .12s, color .12s; }
    .row:hover .row__edit, .row[aria-current="true"] .row__edit { opacity: 1; }
    .row__edit:hover { background: var(--tm-surface); color: var(--tm-green, #16a34a); }
    .row__main { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
    .row__name { font-size: 13px; font-weight: 800; color: var(--tm-text); }
    .row__sub { font-size: 11.5px; color: var(--tm-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .newrow { display: block; width: calc(100% - 14px); margin: 0 7px 8px; padding: 9px; border: 1px dashed var(--tm-line); border-radius: 10px; background: transparent; color: var(--tm-text-muted); font: inherit; font-size: 12.5px; text-align: left; cursor: pointer; }
    .newrow:hover:not(:disabled) { border-color: var(--tm-green, #16a34a); color: var(--tm-green, #16a34a); }
    .newrow:disabled { opacity: .5; cursor: default; }
    .empty { display: flex; flex-direction: column; gap: 4px; padding: 26px 14px; text-align: center; color: var(--tm-text-muted); font-size: 12.5px; }
    .empty strong { color: var(--tm-text); font-size: 13.5px; }

    /* Skeleton rows so the panel has shape while the list request is in flight. */
    .skeleton { display: flex; flex-direction: column; gap: 6px; padding: 4px; }
    .sk { height: 52px; border-radius: 10px; background: linear-gradient(90deg, var(--tm-canvas) 25%, var(--tm-canvas-2, #f3f4f6) 37%, var(--tm-canvas) 63%); background-size: 400% 100%; animation: skShine 1.2s ease-in-out infinite; }
    @keyframes skShine { 0% { background-position: 100% 50%; } 100% { background-position: 0 50%; } }
    @media (prefers-reduced-motion: reduce) { .sk { animation: none; } }

    .ed__head { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; padding: 12px 14px; border-bottom: 1px solid var(--tm-line); }
    .ed__title { font-size: 16px; font-weight: 800; color: var(--tm-text); }
    .ed__type { font-size: 12px; color: var(--tm-text-muted); }
    .backlink { display: none; align-items: center; gap: 4px; padding: 4px 8px; border: 1px solid var(--tm-line); border-radius: 8px; background: var(--tm-surface); color: var(--tm-text-muted); font: inherit; font-size: 12px; cursor: pointer; }

    .tabs { display: flex; gap: 2px; padding: 0 10px; border-bottom: 1px solid var(--tm-line); overflow-x: auto; }
    .tab { padding: 10px 11px; border: 0; border-bottom: 2px solid transparent; margin-bottom: -1px; background: transparent; color: var(--tm-text-muted); font: inherit; font-size: 13px; font-weight: 700; white-space: nowrap; cursor: pointer; }
    .tab:hover { color: var(--tm-text); }
    .tab[aria-selected="true"] { color: var(--tm-green, #16a34a); border-bottom-color: var(--tm-green, #16a34a); }
    .tab__cnt { margin-left: 5px; font-size: 11px; opacity: .75; }

    /* One spacing scale for the whole editor: 16 outside, 20 between sections,
       12 inside a section, 14 inside a card. Nothing is bespoke. */
    .pane { display: flex; flex-direction: column; gap: 20px; padding: 16px; }
    .sec { display: flex; flex-direction: column; gap: 12px; }

    /* Title and any actions share the first line; the hint always drops to its
       own full-width line, so a long one can never crowd the heading. */
    .sec__head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; row-gap: 4px; }
    .sec__head h3 { margin: 0; font-size: 14px; font-weight: 800; color: var(--tm-text); }
    .sec__head .hint { flex: 1 0 100%; order: 99; margin: 0; font-size: 12px; line-height: 1.45; color: var(--tm-text-muted); }
    .sec__actions { display: flex; justify-content: flex-start; }
    .inline { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }

    /* Driver cards — each one a discrete block with identical padding, two per row. */
    .cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; align-items: start; }
    .card { display: flex; flex-direction: column; gap: 12px; padding: 14px; border: 1px solid var(--tm-line); border-radius: 12px; background: var(--tm-surface); min-width: 0; }
    .card__head { display: flex; align-items: center; gap: 11px; }
    .card__id { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 0; }
    .card__name { font-size: 13.5px; font-weight: 800; color: var(--tm-text); }
    .card__meta { font-size: 11.5px; color: var(--tm-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .card__panel { display: flex; flex-direction: column; gap: 8px; padding: 11px 12px; border-radius: 10px; background: var(--tm-canvas); }
    /* Heading and the driver's group chips share one line. */
    .card__panel-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; row-gap: 6px; }
    .card__panel-head h4 { margin: 0; font-size: 12px; font-weight: 800; color: var(--tm-text); }
    .chips-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .routelist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
    .routelist li { padding-left: 13px; position: relative; min-width: 0; font-size: 12px; color: var(--tm-text-muted); }
    .routelist li::before { content: ''; position: absolute; left: 0; top: 7px; width: 5px; height: 5px; border-radius: 50%; background: var(--tm-green, #16a34a); }

    .fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 11px; }
    .f { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
    .f--wide { grid-column: 1 / -1; }
    .f > span { font-size: 11.5px; font-weight: 800; color: var(--tm-text); }
    .f i { color: var(--tm-danger, #ef4444); font-style: normal; }
    .f input, .f select { width: 100%; height: 36px; padding: 0 11px; border: 1px solid var(--tm-line); border-radius: 9px; background: var(--tm-canvas); color: var(--tm-text); font: inherit; font-size: 13px; outline: none; }
    .f input:focus, .f select:focus { border-color: var(--tm-green, #16a34a); }
    .check { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 700; color: var(--tm-text); }
    .check input { width: 16px; height: 16px; accent-color: var(--tm-green, #16a34a); }

    /* Clickable enabled/disabled pill — same look as the ENABLED status pill in
       the header, so this vehicle's on/off state reads identically wherever shown. */
    .statustoggle { display: inline-flex; align-items: center; gap: 7px; height: 26px; padding: 0 12px; border: 0; border-radius: 999px; background: var(--tm-green-tint, #ecfdf5); color: var(--tm-green, #16a34a); font: inherit; font-size: 11px; font-weight: 800; letter-spacing: .05em; text-transform: uppercase; cursor: pointer; transition: background .12s, color .12s; }
    .statustoggle__dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
    .statustoggle:hover:not(:disabled) { filter: brightness(.97); }
    .statustoggle:disabled { opacity: .6; cursor: default; }
    .statustoggle.is-off { background: var(--tm-canvas-2, #f3f4f6); color: var(--tm-text-muted); }
    .meta { margin: 0; font-size: 12px; color: var(--tm-text-muted); }
    .meta b { color: var(--tm-text); font-weight: 800; }
    .meta.warn { color: #9a6a11; }
    .muted { color: var(--tm-text-muted); font-size: 11.5px; }
    .note { margin: 0; padding: 10px 12px; border: 1px solid var(--tm-line); border-radius: 9px; background: var(--tm-canvas); color: var(--tm-text-muted); font-size: 12px; }
    .note b { color: var(--tm-text); }

    /* ── Route Groups & Fleet Control Center Drawer ── */
    .ctrl-body { display: flex; flex-direction: column; gap: 16px; padding: 2px 0; }
    
    .ctrl-veh-card {
      display: flex; align-items: center; justify-content: space-between; gap: 14px;
      padding: 14px 18px; border-radius: 14px;
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
      color: #fff; box-shadow: 0 4px 16px rgba(15,23,42,0.12);
    }
    .ctrl-veh-left { display: flex; align-items: center; gap: 14px; }
    .ctrl-veh-icon { font-size: 28px; background: rgba(255,255,255,0.1); width: 48px; height: 48px; border-radius: 12px; display: grid; place-items: center; }
    .ctrl-veh-text { display: flex; flex-direction: column; gap: 2px; }
    .ctrl-veh-badge { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; color: #38bdf8; }
    .ctrl-veh-title { margin: 0; font-size: 16px; font-weight: 800; color: #fff; }
    .ctrl-veh-specs { font-size: 12px; color: #94a3b8; }
    .ctrl-veh-stats { display: flex; align-items: center; gap: 10px; }
    .ctrl-stat-pill {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      padding: 6px 14px; border-radius: 10px; background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.12); min-width: 60px;
    }
    .ctrl-stat-pill b { font-size: 16px; font-weight: 800; color: #38df88; }
    .ctrl-stat-pill span { font-size: 10px; font-weight: 600; color: #cbd5e1; text-transform: uppercase; }

    .ctrl-section {
      display: flex; flex-direction: column; gap: 10px;
      padding: 14px; border: 1px solid var(--tm-line); border-radius: 12px;
      background: var(--tm-surface);
    }
    .ctrl-section-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
    .ctrl-section-title { display: flex; flex-direction: column; gap: 2px; }
    .ctrl-section-title b { font-size: 13.5px; font-weight: 800; color: var(--tm-text); }
    
    .ctrl-new-group-box {
      display: flex; flex-direction: column; gap: 8px;
      padding: 12px; border-radius: 10px; background: var(--tm-canvas);
      border: 1.5px dashed var(--tm-green, #16a34a); animation: fadeIn 0.15s ease-out;
    }
    .new-group-head { display: flex; align-items: center; justify-content: space-between; font-size: 12.5px; }
    .btn-text-sm { border: 0; background: transparent; color: var(--tm-text-muted); font-size: 12px; font-weight: 700; cursor: pointer; }
    .btn-text-sm:hover { color: #dc2626; }
    .new-group-row { display: flex; gap: 8px; }
    .new-grp-input {
      flex: 1; height: 36px; padding: 0 12px; border: 1px solid var(--tm-line);
      border-radius: 8px; background: var(--tm-surface); font-size: 13px; font-weight: 600; color: var(--tm-text); outline: none;
    }
    .new-grp-input:focus { border-color: var(--tm-green, #16a34a); }
    .btn-create-grp {
      padding: 0 16px; height: 36px; border: 0; border-radius: 8px;
      background: var(--tm-green, #16a34a); color: #fff; font-size: 12.5px; font-weight: 700; cursor: pointer; white-space: nowrap;
    }
    .btn-create-grp:disabled { opacity: 0.5; cursor: not-allowed; }

    .ctrl-groups-grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px;
    }
    .ctrl-grp-card {
      display: flex; flex-direction: column; justify-content: space-between; gap: 8px;
      padding: 10px 12px; border-radius: 10px; border: 1.5px solid var(--tm-line);
      background: var(--tm-canvas); cursor: pointer; transition: all .15s ease;
    }
    .ctrl-grp-card:hover { border-color: var(--tm-text-muted); transform: translateY(-1px); }
    .ctrl-grp-card.is-selected {
      border-color: var(--tm-green, #16a34a); background: var(--tm-green-tint, #ecfdf5);
      box-shadow: 0 2px 8px rgba(22,163,74,0.12);
    }
    .grp-card-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .grp-card-icon { font-size: 16px; flex: none; }
    .grp-card-name { font-size: 13px; font-weight: 800; color: var(--tm-text); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .grp-card-check { color: var(--tm-green, #16a34a); flex: none; display: flex; }
    .grp-card-bottom { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--tm-text-muted); font-weight: 600; }
    .grp-meta-item { display: inline-flex; align-items: center; gap: 3px; }

    .ctrl-active-grp-bar {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      padding: 10px 14px; border-radius: 10px; background: var(--tm-canvas-2, #f1f5f9);
      border: 1px solid var(--tm-line);
    }
    .active-grp-info { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; }
    .active-grp-name { margin: 0; font-size: 15px; font-weight: 800; color: var(--tm-text); }
    .active-grp-rename-input {
      flex: 1; max-width: 320px; height: 32px; padding: 0 10px;
      border: 1.5px solid var(--tm-green, #16a34a); border-radius: 6px;
      background: #fff; font-size: 13px; font-weight: 700; color: var(--tm-text); outline: none;
    }
    .active-grp-actions { display: flex; align-items: center; gap: 6px; }
    .btn-tool {
      padding: 5px 10px; border: 1px solid var(--tm-line); border-radius: 7px;
      background: #fff; font-size: 11.5px; font-weight: 700; color: var(--tm-text); cursor: pointer;
    }
    .btn-tool:hover { background: var(--tm-canvas); border-color: var(--tm-text-muted); }
    .btn-tool--danger { color: #dc2626; }
    .btn-tool--danger:hover { background: #fef2f2; border-color: #fca5a5; }

    .ctrl-routes-list { display: flex; flex-direction: column; gap: 6px; }
    .ctrl-route-row {
      display: flex; align-items: center; gap: 10px; padding: 9px 12px;
      border-radius: 9px; border: 1px solid var(--tm-line); background: var(--tm-canvas);
      transition: all .12s ease;
    }
    .ctrl-route-row.is-assigned { background: #fff; border-color: #bbf7d0; box-shadow: 0 1px 3px rgba(0,0,0,0.03); }
    .route-icon { font-size: 16px; flex: none; }
    .route-icon.muted-ic { opacity: 0.6; }
    .route-info { display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 0; }
    .route-title { font-size: 13px; font-weight: 800; color: var(--tm-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .route-legs { font-size: 11px; color: var(--tm-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .route-fare-badge { font-size: 12px; font-weight: 800; color: var(--tm-green-deep, #15803d); padding: 2px 7px; background: #dcfce7; border-radius: 6px; }
    .route-stops-chip { font-size: 11px; color: var(--tm-text-muted); font-weight: 600; }
    .btn-route-action {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 5px 10px; border-radius: 7px; font-size: 11.5px; font-weight: 700;
      cursor: pointer; transition: all .12s ease; border: 1px solid transparent;
    }
    .btn-route-action.remove { background: #fee2e2; color: #b91c1c; }
    .btn-route-action.remove:hover { background: #fecaca; }
    .btn-route-action.add { background: var(--tm-green, #16a34a); color: #fff; }
    .btn-route-action.add:hover { filter: brightness(0.92); }
    .btn-route-action[disabled] { opacity: 0.5; cursor: not-allowed; }

    .ctrl-available-routes-box {
      margin-top: 8px; padding-top: 10px; border-top: 1px dashed var(--tm-line);
      display: flex; flex-direction: column; gap: 8px;
    }
    .avail-routes-head { font-size: 12px; font-weight: 700; color: var(--tm-text-muted); }

    .ctrl-drivers-grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px;
    }
    .ctrl-driver-card {
      display: flex; align-items: center; gap: 11px; padding: 11px 13px;
      border-radius: 12px; border: 1.5px solid var(--tm-line); background: var(--tm-canvas);
      cursor: pointer; transition: all .15s ease; user-select: none;
    }
    .ctrl-driver-card:hover { border-color: var(--tm-text-muted); transform: translateY(-1px); }
    .ctrl-driver-card.is-assigned {
      border-color: var(--tm-green, #16a34a); background: var(--tm-green-tint, #ecfdf5);
      box-shadow: 0 2px 6px rgba(22,163,74,0.08);
    }
    .driver-card-avatar { flex: none; }
    .av-circle {
      display: grid; place-items: center; width: 36px; height: 36px;
      border-radius: 50%; background: #e2e8f0; color: #334155; font-size: 13px; font-weight: 800;
    }
    .ctrl-driver-card.is-assigned .av-circle { background: var(--tm-green, #16a34a); color: #fff; }
    .driver-card-content { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
    .driver-name-line { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
    .driver-name { font-size: 13px; font-weight: 800; color: var(--tm-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .driver-badge { font-size: 9.5px; font-weight: 800; text-transform: uppercase; color: var(--tm-text-muted); padding: 1px 6px; border-radius: 4px; background: var(--tm-canvas-2, #e2e8f0); }
    .driver-badge.badge-active { background: #bbf7d0; color: #166534; }
    .driver-car-line { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; font-size: 11px; }
    .car-pill { font-weight: 700; color: var(--tm-text-muted); }
    .reg-pill { font-weight: 800; color: #475569; padding: 0 4px; background: rgba(0,0,0,0.05); border-radius: 4px; }
    .driver-contact-line { font-size: 11px; color: var(--tm-text-muted); font-weight: 600; }
    .driver-check-btn {
      width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center;
      background: #e2e8f0; color: #64748b; flex: none;
    }
    .ctrl-driver-card.is-assigned .driver-check-btn { background: var(--tm-green, #16a34a); color: #fff; }

    .ctrl-empty-notice { padding: 16px; text-align: center; font-size: 12.5px; color: var(--tm-text-muted); border: 1px dashed var(--tm-line); border-radius: 10px; }
    .ctrl-empty-box { padding: 12px; text-align: center; font-size: 12px; color: var(--tm-text-muted); background: var(--tm-canvas); border-radius: 8px; }
    .btn-link-sm { border: 0; background: transparent; color: var(--tm-green, #16a34a); font-size: 12px; font-weight: 700; cursor: pointer; }
    .btn-link-sm:hover { text-decoration: underline; }

    /* Driver Fleet Manager Drawer */
    .df-body { display: flex; flex-direction: column; gap: 14px; }
    .df-search-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .df-no-groups-banner {
      display: flex; align-items: center; gap: 10px; padding: 10px 14px;
      border-radius: 10px; background: #fffbeb; border: 1px solid #fef3c7; color: #92400e; font-size: 12.5px;
    }
    .btn-create-grp-inline {
      margin-left: auto; padding: 4px 10px; border: 1px solid #f59e0b; border-radius: 6px;
      background: #fff; color: #b45309; font-size: 11.5px; font-weight: 700; cursor: pointer;
    }
    .df-drivers-list { display: flex; flex-direction: column; gap: 10px; }
    .df-driver-item {
      display: flex; flex-direction: column; gap: 10px; padding: 12px 14px;
      border-radius: 12px; border: 1.5px solid var(--tm-line); background: var(--tm-canvas);
      transition: all .15s ease;
    }
    .df-driver-item:hover { border-color: var(--tm-text-muted); }
    .df-driver-item.is-assigned { border-color: #86efac; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,0.04); }
    .df-driver-top { display: flex; align-items: center; gap: 12px; }
    .df-driver-avatar { flex: none; }
    .df-driver-info { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 0; }
    .df-driver-name-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .df-name { font-size: 13.5px; font-weight: 800; color: var(--tm-text); }
    .df-driver-details { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 11px; }
    .phone-pill { color: var(--tm-text-muted); font-weight: 600; }
    .df-driver-assign-bar {
      display: flex; flex-direction: column; gap: 6px;
      padding-top: 9px; border-top: 1px dashed var(--tm-line); font-size: 12px;
    }
    .assign-label-row {
      display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%;
    }
    .assign-label { font-weight: 700; color: var(--tm-text-muted); }
    .assign-quick-btns { display: flex; align-items: center; gap: 6px; }
    .btn-text-xs {
      border: 0; background: transparent; color: var(--tm-green, #16a34a); font-size: 11px; font-weight: 700; cursor: pointer; padding: 2px 5px; border-radius: 4px;
    }
    .btn-text-xs:hover:not([disabled]) { background: var(--tm-green-tint, #ecfdf5); }
    .btn-text-xs--danger { color: #dc2626; }
    .btn-text-xs--danger:hover:not([disabled]) { background: #fef2f2; }
    .btn-text-xs[disabled] { opacity: 0.4; cursor: not-allowed; }

    .df-grp-chips-grid {
      display: flex; flex-wrap: wrap; gap: 6px; width: 100%; margin-top: 2px;
    }
    .df-grp-chip {
      display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px;
      border-radius: 20px; border: 1.5px solid var(--tm-line); background: var(--tm-canvas-2, #f1f5f9);
      color: var(--tm-text); font-size: 11.5px; font-weight: 600; cursor: pointer; transition: all .14s ease;
    }
    .df-grp-chip:hover:not([disabled]) { border-color: var(--tm-text-muted); transform: translateY(-0.5px); }
    .df-grp-chip.is-assigned {
      border-color: var(--tm-green, #16a34a); background: var(--tm-green-tint, #ecfdf5);
      color: var(--tm-green-deep, #15803d); font-weight: 700; box-shadow: 0 1px 4px rgba(22,163,74,0.1);
    }
    .df-grp-chip[disabled] { opacity: 0.6; cursor: wait; }
    .grp-chip-name { min-width: 0; }
    .grp-chip-count { font-size: 10px; opacity: 0.75; }

    .drv-cell-btn {
      display: inline-flex; align-items: center; background: transparent; border: 0; padding: 0; cursor: pointer; font: inherit; text-align: left;
    }
    .drv-count-badge {
      margin-left: 6px; font-size: 11px; font-weight: 700; color: var(--tm-text-muted); background: var(--tm-canvas-2, #eaeef4); padding: 2px 6px; border-radius: 6px;
    }
    .drv-count-badge.badge-has-active {
      background: var(--tm-green-tint, #ecfdf5); color: var(--tm-green-deep, #15803d);
    }

    .chip-grid { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
    .multi-chip {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 7px 12px; border-radius: 20px; border: 1.5px solid var(--tm-line);
      background: var(--tm-canvas); color: var(--tm-text); font-size: 12px; font-weight: 600;
      cursor: pointer; transition: all .15s ease;
    }
    .multi-chip:hover { border-color: var(--tm-text-muted); }
    .multi-chip.is-selected {
      background: var(--tm-success-bg, #ecfdf5); border-color: var(--tm-green, #16a34a);
      color: var(--tm-green-deep, #15803d); font-weight: 700;
    }
    .av-mini {
      display: inline-flex; align-items: center; justify-content: center;
      width: 18px; height: 18px; border-radius: 50%; background: var(--tm-canvas-2, #e5e7eb);
      font-size: 10px; font-weight: 700; color: var(--tm-text-muted);
    }

    .mini-select {
      padding: 2px 6px; border-radius: 6px; border: 1px solid var(--tm-line);
      background: var(--tm-canvas); color: var(--tm-text); font-size: 11px; font-weight: 700;
      cursor: pointer; outline: none;
    }
    .mini-select:focus { border-color: var(--tm-green); }
    .gcol__empty { font-size: 11.5px; color: var(--tm-text-muted); padding: 2px 0; }
    .f__head-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 2px; }

    /* Shared search + pagination chrome for the route-groups section. */
    .toolbar { display: flex; align-items: center; gap: 10px; }
    .toolbar__count { font-size: 12px; font-weight: 700; color: var(--tm-text-muted); white-space: nowrap; }
    .pager { display: flex; align-items: center; justify-content: center; gap: 12px; padding-top: 2px; }
    .pager__label { font-size: 12px; font-weight: 700; color: var(--tm-text-muted); }

    .grp { display: flex; flex-direction: column; gap: 12px; padding: 14px; border: 1px solid var(--tm-line); border-radius: 12px; }
    .grp--orphan { border-color: #fce4a6; background: var(--tm-canvas); }
    .grp__top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .grp__name { font-size: 13px; font-weight: 800; color: var(--tm-text); }
    .badge { padding: 1px 8px; border-radius: 999px; background: var(--tm-green-tint, #ecfdf5); color: var(--tm-green, #16a34a); font-size: 11px; font-weight: 800; font-variant-numeric: tabular-nums; }
    .badge--mute { background: var(--tm-canvas-2, #f3f4f6); color: var(--tm-text-muted); }
    .badge--warn { background: #fef3c7; color: #b45309; }
    .grp__empty { padding: 6px 2px; font-size: 12px; color: var(--tm-text-muted); }
    .grp__drivers { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding-top: 11px; border-top: 1px solid var(--tm-line); }
    .dlabel { font-size: 11px; font-weight: 800; letter-spacing: .03em; text-transform: uppercase; color: var(--tm-text-muted); }

    /* Route row — carries the columns the old routes table showed. */
    .routes { display: flex; flex-direction: column; gap: 6px; }
    .rt { display: grid; grid-template-columns: 1fr auto auto auto auto; align-items: center; gap: 12px; padding: 9px 11px; border-radius: 9px; background: var(--tm-canvas); }
    .rt__nm { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .rt__nm b { font-size: 12.5px; font-weight: 700; color: var(--tm-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rt__nm small { font-size: 11px; color: var(--tm-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rt__col { font-variant-numeric: tabular-nums; font-size: 12px; font-weight: 700; color: var(--tm-text); white-space: nowrap; text-align: right; }
    .rt__col small { display: block; font-size: 10px; font-weight: 600; color: var(--tm-text-muted); letter-spacing: .03em; text-transform: uppercase; }
    .rt__acts { display: flex; align-items: center; gap: 6px; }
    .icon { width: 28px; height: 28px; border-radius: 7px; border: 0; background: transparent; display: grid; place-items: center; color: var(--tm-text-muted); font-size: 13px; cursor: pointer; }
    .icon:hover { background: var(--tm-canvas-2, #f3f4f6); color: var(--tm-text); }
    .icon--del:hover { background: #fef2f2; color: #dc2626; }
    .drv { display: inline-flex; align-items: center; gap: 6px; padding: 2px 7px 2px 3px; border: 1px solid var(--tm-line); border-radius: 999px; font-size: 12px; color: var(--tm-text); }
    .drv--plain { padding: 3px 10px; }
    .av { display: inline-grid; place-items: center; width: 21px; height: 21px; flex: none; border-radius: 50%; background: var(--tm-green-tint, #ecfdf5); color: var(--tm-green, #16a34a); font-size: 10px; font-weight: 800; }
    .av--lg { width: 34px; height: 34px; font-size: 12px; }
    .tag { padding: 2px 8px; border-radius: 999px; background: var(--tm-canvas-2, #f3f4f6); color: var(--tm-text-muted); font-size: 10px; font-weight: 800; text-transform: capitalize; }
    .tag[data-s="outstation"] { background: #fff7ed; color: #c2410c; }

    .mini-btn { padding: 4px 9px; border: 1px solid var(--tm-line); border-radius: 8px; background: var(--tm-surface); color: var(--tm-text-muted); font: inherit; font-size: 11.5px; font-weight: 700; cursor: pointer; white-space: nowrap; }
    .mini-btn:hover:not(:disabled) { border-color: var(--tm-green, #16a34a); color: var(--tm-green, #16a34a); }
    .mini-btn:disabled { opacity: .5; cursor: default; }
    .mini-btn--danger:hover { border-color: #ef4444; color: #ef4444; }
    .mini-btn--go { border-color: var(--tm-green, #16a34a); color: var(--tm-green, #16a34a); }
    .x { padding: 0 6px; border: 0; border-radius: 6px; background: transparent; color: var(--tm-text-muted); font: inherit; font-size: 14px; line-height: 1.4; cursor: pointer; }
    .x:hover { background: #fef2f2; color: #dc2626; }
    .rename { height: 32px; max-width: 220px; padding: 0 9px; border: 1px solid var(--tm-line); border-radius: 8px; background: var(--tm-canvas); color: var(--tm-text); font: inherit; font-size: 13px; outline: none; }

    .picker { display: flex; flex-direction: column; gap: 3px; padding: 7px; border: 1px solid var(--tm-line); border-radius: 10px; max-height: 260px; overflow-y: auto; }
    .pick { display: flex; align-items: center; gap: 9px; width: 100%; padding: 6px 8px; border: 0; border-radius: 8px; background: transparent; text-align: left; font: inherit; cursor: pointer; }
    .pick:hover:not(:disabled) { background: var(--tm-canvas); }
    .pick:disabled { opacity: .5; cursor: default; }
    .pick__main { display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 0; }
    .pick__main b { font-size: 12.5px; font-weight: 800; color: var(--tm-text); }
    .pick__main small { font-size: 11px; color: var(--tm-text-muted); }
    .pick__row { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; margin-top: 5px; }
    .pick__lbl { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .03em; color: var(--tm-text-muted); margin-right: 2px; }
    .chip { padding: 2px 8px; border: 1px solid var(--tm-line); border-radius: 999px; background: var(--tm-canvas-2, #f3f4f6); font-size: 11px; color: var(--tm-text); }
    .drv--xs { padding: 1px 7px 1px 2px; gap: 5px; font-size: 11px; }
    .drv--xs .av { width: 17px; height: 17px; font-size: 8.5px; }
    /* Bordered pick rows for use inside a drawer (no wrapping .picker box). */
    .pick--bd { border: 1px solid var(--tm-line); border-radius: 10px; padding: 10px; }
    .pick--bd:hover { border-color: var(--tm-green, #16a34a); background: var(--tm-canvas); }
    /* Multi-select checklist row inside a drawer. */
    .pickrow { display: flex; align-items: center; gap: 10px; padding: 9px 11px; border: 1px solid var(--tm-line); border-radius: 10px; cursor: pointer; }
    .pickrow:hover { border-color: var(--tm-text-muted); }
    .pickrow.is-on { border-color: var(--tm-green, #16a34a); background: var(--tm-green-tint, #ecfdf5); }
    .pickrow input { width: 16px; height: 16px; accent-color: var(--tm-green, #16a34a); flex: none; }
    .drawer-count { font-size: 12px; font-weight: 700; color: var(--tm-text-muted); }

    .layout { display: grid; grid-template-columns: 92px 1fr auto; gap: 12px; align-items: center; padding: 14px; border: 1px solid var(--tm-line); border-radius: 12px; }
    .layout__preview { width: 88px; height: 96px; display: flex; align-items: flex-start; justify-content: center; overflow: hidden; }
    .layout__preview :is(app-seat-grid) { transform: scale(0.34); transform-origin: top center; }
    .layout__meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .layout__name { font-size: 13px; font-weight: 800; color: var(--tm-text); }
    .layout__sub { font-size: 11px; color: var(--tm-text-muted); }
    .layout__actions { display: inline-flex; align-items: center; gap: 6px; }

    /* Seat-layout designer drawer */
    .ldr-scrim { position: fixed; inset: 0; background: rgba(15, 23, 42, .38); z-index: 60; animation: ldr-fade 140ms ease-out; }
    .ldr { position: fixed; top: 0; right: 0; bottom: 0; width: 92vw; max-width: 1500px; z-index: 61; background: var(--tm-canvas, #fff); box-shadow: -16px 0 40px rgba(15,23,42,.18); overflow-y: auto; padding: 22px 26px; animation: ldr-slide 180ms cubic-bezier(.22,.61,.36,1); }
    @keyframes ldr-fade { from { opacity: 0; } to { opacity: 1; } }
    @keyframes ldr-slide { from { transform: translateX(24px); opacity: .6; } to { transform: translateX(0); opacity: 1; } }
    @media (max-width: 760px) { .ldr { width: 100vw; padding: 16px; } }

    .form { display: flex; flex-direction: column; gap: 12px; }
    .typerow { display: flex; align-items: center; gap: 9px; padding: 8px 10px; border: 1px solid var(--tm-line); border-radius: 9px; }
    .typerow__name { flex: 1; min-width: 0; font-size: 13px; font-weight: 700; color: var(--tm-text); }
    .typeform { display: flex; flex-direction: column; gap: 9px; padding-top: 11px; border-top: 1px solid var(--tm-line); }
    .typeform__actions { display: flex; justify-content: flex-end; gap: 8px; }

    /* ─────────────── full-width spreadsheet ─────────────── */
    .grid { display: flex; flex-direction: column; gap: 12px; }
    .controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .controls .search { flex: 1 1 220px; max-width: 300px; height: 40px; box-sizing: border-box; border-radius: 10px; }
    .controls .seg { height: 40px; box-sizing: border-box; flex-shrink: 0; }
    .controls .clearall { height: 40px; box-sizing: border-box; }
    .controls .mini { height: 38px; max-width: 160px; border-radius: 10px; padding: 0 12px; }
    .seg { display: inline-flex; padding: 3px; gap: 2px; background: var(--tm-canvas-2, #eaeef4); border-radius: 10px; }
    .seg__btn { padding: 7px 13px; border: 0; border-radius: 8px; background: transparent; color: var(--tm-text-muted); font: inherit; font-size: 12.5px; font-weight: 700; white-space: nowrap; cursor: pointer; transition: background .15s, color .15s; }
    .seg__btn:hover { color: var(--tm-text); }
    .seg__btn.on { background: var(--tm-surface); color: var(--tm-green, #16a34a); box-shadow: var(--tm-shadow-sm, 0 1px 2px rgba(15,20,25,.05)); }

    /* Custom filter dropdown — same look as the Drivers page state-select. */
    .fsel { position: relative; display: inline-block; }
    .fsel__trigger { display: inline-flex; align-items: center; gap: 8px; height: 38px; padding: 0 12px; border: 1px solid var(--tm-line-2, #e2e6ec); border-radius: 10px; background: var(--tm-surface); font: inherit; font-size: 13px; font-weight: 700; color: var(--tm-text); cursor: pointer; line-height: 1.2; transition: border-color .15s, background .15s; }
    .fsel__trigger:hover { border-color: var(--tm-ink, #0f1419); }
    .fsel.is-open .fsel__trigger { border-color: var(--tm-ink, #0f1419); }
    .fsel.has-value .fsel__trigger { background: var(--tm-green-tint, #ecfdf5); border-color: var(--tm-green-deep, #16a34a); }
    .fsel__icon { display: inline-flex; color: var(--tm-text-muted); }
    .fsel.has-value .fsel__icon { color: var(--tm-green-deep, #16a34a); }
    .fsel__value { min-width: 84px; max-width: 170px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
    .fsel__caret { color: var(--tm-text-soft, #94a0ad); transition: transform .15s; }
    .fsel.is-open .fsel__caret { transform: rotate(180deg); }
    .fsel.has-value .fsel__caret { color: var(--tm-green-deep, #16a34a); }
    .fsel__menu { position: absolute; top: calc(100% + 6px); left: 0; min-width: 100%; width: max-content; max-width: 260px; max-height: 320px; overflow-y: auto; margin: 0; padding: 6px; list-style: none; background: var(--tm-surface); border: 1px solid var(--tm-line-2, #e2e6ec); border-radius: 12px; box-shadow: var(--tm-shadow-pop, 0 12px 40px -16px rgba(15,20,25,.25)); z-index: 60; animation: fsel-in .14s var(--tm-ease, cubic-bezier(.4,0,.2,1)) both; }
    @keyframes fsel-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
    .fsel__option { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 8px; font-size: 12.5px; font-weight: 600; color: var(--tm-text); cursor: pointer; transition: background .15s, color .15s; }
    .fsel__option:hover { background: var(--tm-canvas-2, #eaeef4); }
    .fsel__option.is-selected { background: var(--tm-green-tint, #ecfdf5); color: var(--tm-green-deep, #16a34a); font-weight: 700; }
    .fsel__option:not(.is-selected) .fsel__olabel { margin-left: 20px; }
    .fsel__check { color: var(--tm-green-deep, #16a34a); flex: none; }
    .fsel__olabel { flex: 1; white-space: nowrap; }

    .clearall { display: inline-flex; align-items: center; gap: 5px; height: 38px; padding: 0 12px; border: 1px solid var(--tm-line-2, #e2e6ec); border-radius: 10px; background: var(--tm-surface); color: var(--tm-text-muted); font: inherit; font-size: 12.5px; font-weight: 700; cursor: pointer; transition: border-color .15s, color .15s, background .15s; }
    .clearall:hover { border-color: var(--tm-danger, #ef4444); color: var(--tm-danger, #ef4444); background: var(--tm-danger-bg, #fee2e2); }
    .count-note { margin-left: auto; font-size: 12.5px; color: var(--tm-text-muted); font-weight: 600; }
    .count-note b { color: var(--tm-text); }

    .bulk { display: flex; align-items: center; gap: 12px; padding: 9px 14px; background: var(--tm-ink, #0f1419); color: #fff; border-radius: 11px; }
    .bulk b { font-weight: 800; }
    .bulk__sep { width: 1px; height: 18px; background: rgba(255,255,255,.2); }
    .bbtn { padding: 6px 11px; border: 0; border-radius: 8px; background: rgba(255,255,255,.12); color: #fff; font: inherit; font-size: 12.5px; font-weight: 700; cursor: pointer; }
    .bbtn:hover { background: rgba(255,255,255,.22); }
    .bulk__x { margin-left: auto; display: inline-flex; padding: 4px; border: 0; background: transparent; color: rgba(255,255,255,.7); cursor: pointer; }
    .bulk__x:hover { color: #fff; }

    .sheetwrap { overflow: auto; background: var(--tm-surface); border: 1px solid var(--tm-line); border-radius: var(--tm-radius-lg, 16px); }
    table.sheet { border-collapse: separate; border-spacing: 0; width: 100%; min-width: 900px; --frz1: 44px; --frz2: 236px; font-variant-numeric: tabular-nums; }
    .sheet th, .sheet td { border-right: 1px solid var(--tm-line); border-bottom: 1px solid var(--tm-line); padding: 0 12px; height: 46px; text-align: left; white-space: nowrap; background: var(--tm-surface); }
    .sheet thead th { position: sticky; top: 0; z-index: 6; background: var(--tm-canvas); color: var(--tm-text-muted); font-size: 11px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
    .sheet th.center, .sheet td.center { text-align: center; }
    .col-gut { position: sticky; left: 0; z-index: 7; width: var(--frz1); min-width: var(--frz1); text-align: center; padding: 0; }
    .col-veh { position: sticky; left: var(--frz1); z-index: 7; width: calc(var(--frz2) - var(--frz1)); min-width: calc(var(--frz2) - var(--frz1)); box-shadow: 6px 0 12px -10px rgba(15,20,25,.18); }
    .sheet thead .col-gut, .sheet thead .col-veh { z-index: 9; }
    .sheet tbody tr.srow { cursor: pointer; }
    .sheet tbody tr.srow:hover td { background: var(--tm-canvas); }
    .sheet tbody tr.srow.is-active-row td { background: var(--tm-green-tint, #ecfdf5); }
    .sheet tbody tr.srow.is-active-row td.col-veh .veh-name { color: var(--tm-green-deep, #15803d); font-weight: 800; }
    .sheet tbody tr.srow.sel td { background: var(--tm-green-tint, #ecfdf5); }
    .sheet tbody tr.srow.off .veh-name { color: var(--tm-text-muted); }

    .chk { width: 18px; height: 18px; margin: 0 auto; border-radius: 5px; border: 1.6px solid var(--tm-line-2, #e2e6ec); display: inline-grid; place-items: center; background: var(--tm-surface); color: #fff; cursor: pointer; vertical-align: middle; }
    .chk.on { background: var(--tm-green, #16a34a); border-color: var(--tm-green, #16a34a); }
    .rownum { font-size: 11px; color: var(--tm-text-soft, #94a0ad); font-weight: 700; }

    .veh { display: flex; align-items: center; gap: 8px; }
    .expcaret { width: 22px; height: 22px; flex: none; border: 0; border-radius: 7px; display: grid; place-items: center; background: transparent; color: var(--tm-text-soft, #94a0ad); cursor: pointer; transition: transform .15s, background .15s, color .15s; }
    .expcaret:hover { background: var(--tm-canvas-2, #eaeef4); color: var(--tm-text); }
    .expcaret.open { transform: rotate(90deg); color: var(--tm-green, #16a34a); }
    .veh-ic { width: 28px; height: 28px; flex: none; border-radius: 8px; background: var(--tm-canvas-2, #eaeef4); color: var(--tm-text-muted); display: grid; place-items: center; }
    .veh-name { font-size: 13px; font-weight: 800; color: var(--tm-text); cursor: text; }
    .ecell { cursor: text; }
    .ecell:hover { background: var(--tm-green-tint, #ecfdf5) !important; box-shadow: inset 0 0 0 1.5px var(--tm-green-soft, #dcfce7); }
    .ecell b { font-weight: 700; }
    .cin { width: 100%; height: 30px; border: 1px solid var(--tm-green, #16a34a); border-radius: 6px; padding: 0 8px; background: var(--tm-surface); color: var(--tm-text); font: inherit; font-weight: 700; font-size: 13px; outline: none; }
    .tbadge { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .03em; color: var(--tm-text-muted); padding: 2px 7px; border-radius: 6px; background: var(--tm-canvas-2, #eaeef4); }

    .pill { display: inline-flex; align-items: center; gap: 5px; padding: 4px 9px; border: 0; border-radius: 999px; font-size: 10.5px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; cursor: pointer; }
    .pill .led { width: 6px; height: 6px; border-radius: 50%; }
    .pill.success { background: var(--tm-green-tint, #ecfdf5); color: var(--tm-green, #16a34a); } .pill.success .led { background: var(--tm-green, #16a34a); }
    .pill.neutral { background: var(--tm-canvas-2, #eaeef4); color: var(--tm-text-muted); } .pill.neutral .led { background: var(--tm-text-soft, #94a0ad); }

    .farelink { padding: 4px 10px; border: 1px dashed var(--tm-line-2, #e2e6ec); border-radius: 8px; background: var(--tm-surface); color: var(--tm-text-soft, #94a0ad); font: inherit; font-size: 11.5px; font-weight: 700; cursor: pointer; }
    .farelink:hover { border-color: var(--tm-green, #16a34a); color: var(--tm-green, #16a34a); border-style: solid; }
    .farelink.set { border-style: solid; border-color: var(--tm-line); color: var(--tm-text); }
    .farelink.set:hover { border-color: var(--tm-green, #16a34a); color: var(--tm-green, #16a34a); }

    .gchips { display: inline-flex; gap: 5px; flex-wrap: wrap; }
    .gchip { padding: 3px 9px; border: 0; border-radius: 999px; background: var(--tm-info-bg, #dbeafe); color: var(--tm-info-fg, #1e40af); font: inherit; font-size: 11px; font-weight: 800; cursor: pointer; }
    .gchip.more { background: var(--tm-canvas-2, #eaeef4); color: var(--tm-text-muted); }
    .addlink { padding: 3px 4px; border: 0; background: transparent; color: var(--tm-text-soft, #94a0ad); font: inherit; font-size: 12px; font-weight: 700; font-style: italic; cursor: pointer; }
    .addlink:hover { color: var(--tm-green, #16a34a); }
    .linkcell { border: 0; background: transparent; color: var(--tm-green, #16a34a); font: inherit; font-size: 12.5px; font-weight: 700; cursor: pointer; }
    .linkcell:hover { text-decoration: underline; }
    .muted-link { color: var(--tm-text-soft, #94a0ad); font-style: italic; }

    .avstack { display: inline-flex; align-items: center; }
    .av2 { width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; background: var(--tm-green-tint, #ecfdf5); color: var(--tm-green, #16a34a); font-size: 9px; font-weight: 800; border: 2px solid var(--tm-surface); margin-left: -7px; }
    .av2:first-child { margin-left: 0; }
    .av2.more { background: var(--tm-canvas-2, #eaeef4); color: var(--tm-text-muted); }

    .setup { display: flex; align-items: center; gap: 8px; justify-content: center; }
    .setup .bar { width: 56px; height: 6px; border-radius: 999px; background: var(--tm-canvas-2, #eaeef4); overflow: hidden; }
    .setup .bar i { display: block; height: 100%; border-radius: 999px; background: var(--tm-green, #16a34a); }
    .setup .pc { font-size: 12px; font-weight: 800; color: var(--tm-text); }
    .kebab { width: 30px; height: 30px; border: 0; border-radius: 8px; background: transparent; display: grid; place-items: center; color: var(--tm-text-soft, #94a0ad); cursor: pointer; }
    .kebab:hover { background: var(--tm-canvas-2, #eaeef4); color: var(--tm-text); }

    .addrow td { padding: 0; }
    .addbtn { display: flex; align-items: center; gap: 8px; width: 100%; padding: 12px 16px; border: 0; background: var(--tm-surface); color: var(--tm-text-muted); font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; }
    .addbtn:hover:not(:disabled) { background: var(--tm-green-tint, #ecfdf5); color: var(--tm-green, #16a34a); }
    .addbtn:disabled { opacity: .5; cursor: default; }

    /* ── Live Fleet Operations Deck (Under-table Command Center) ── */
    .detailrow td { background: var(--tm-canvas, #f8fafc) !important; padding: 0 !important; }
    .deck-wrap {
      position: sticky; left: var(--frz1, 44px);
      width: calc(100vw - var(--tm-sidebar-w, 264px) - 80px); max-width: 1240px;
      padding: 16px 20px 22px; display: flex; flex-direction: column; gap: 14px;
    }

    .deck-header {
      display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap;
      padding: 12px 18px; border-radius: 12px;
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
      color: #fff; box-shadow: 0 4px 16px rgba(15,23,42,0.14);
    }
    .deck-title-box { display: flex; align-items: center; gap: 12px; }
    .deck-veh-icon {
      width: 40px; height: 40px; border-radius: 10px; background: rgba(255,255,255,0.12);
      display: grid; place-items: center; color: #38bdf8;
    }
    .deck-veh-text { display: flex; flex-direction: column; gap: 2px; }
    .deck-veh-badge { font-size: 9.5px; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; color: #38bdf8; }
    .deck-veh-title { margin: 0; font-size: 15px; font-weight: 800; color: #fff; }

    .deck-head-stats { display: flex; align-items: center; gap: 8px; }
    .deck-stat-chip {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      padding: 4px 12px; border-radius: 8px; background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.12); min-width: 60px;
    }
    .deck-stat-chip .stat-num { font-size: 13.5px; font-weight: 800; color: #38df88; }
    .deck-stat-chip .stat-lbl { font-size: 9px; font-weight: 700; text-transform: uppercase; color: #94a3b8; }

    .deck-head-actions { display: flex; align-items: center; gap: 8px; }
    .deck-btn-action {
      display: inline-flex; align-items: center; gap: 5px; height: 32px; padding: 0 12px;
      border: 1px solid rgba(255,255,255,0.2); border-radius: 8px; background: rgba(255,255,255,0.1);
      color: #fff; font-size: 12px; font-weight: 700; cursor: pointer; transition: all .15s ease;
    }
    .deck-btn-action:hover { background: rgba(255,255,255,0.2); border-color: rgba(255,255,255,0.4); }
    .deck-btn-close {
      width: 32px; height: 32px; border: 1px solid rgba(255,255,255,0.2); border-radius: 8px;
      background: rgba(255,255,255,0.1); color: #fff; display: grid; place-items: center; cursor: pointer;
    }
    .deck-btn-close:hover { background: rgba(255,255,255,0.2); }

    /* 3-Panel Deck Grid */
    .deck-grid {
      display: grid; grid-template-columns: 290px 1.2fr 1fr; gap: 14px; align-items: stretch;
    }
    @media (max-width: 1100px) {
      .deck-grid { grid-template-columns: 1fr; }
    }

    .deck-panel {
      display: flex; flex-direction: column; gap: 12px;
      padding: 16px; border-radius: 14px; border: 1.5px solid var(--tm-line, #e2e8f0);
      background: var(--tm-surface, #fff); box-shadow: 0 1px 4px rgba(0,0,0,0.03);
    }
    .deck-panel-header {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding-bottom: 12px; margin-bottom: 12px; border-bottom: 1px solid var(--tm-line, #e2e8f0);
    }
    .deck-panel-title {
      display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 800; color: var(--tm-text);
    }
    .deck-active-tag {
      font-size: 11px; color: var(--tm-text-muted); font-weight: 600;
    }
    .deck-active-tag b { color: var(--tm-green, #16a34a); }

    /* Panel 1: Groups */
    .deck-add-group-box {
      display: flex; gap: 6px;
    }
    .deck-add-grp-input {
      flex: 1; height: 34px; padding: 0 10px; border-radius: 8px;
      border: 1.5px solid var(--tm-line); background: var(--tm-canvas);
      font-size: 12px; font-weight: 600; color: var(--tm-text); outline: none;
    }
    .deck-add-grp-input:focus { border-color: var(--tm-green, #16a34a); }
    .deck-add-grp-btn {
      padding: 0 12px; height: 34px; border: 0; border-radius: 8px;
      background: var(--tm-green, #16a34a); color: #fff; font-size: 11.5px; font-weight: 700; cursor: pointer;
    }
    .deck-add-grp-btn:disabled { opacity: 0.5; cursor: not-allowed; }

    .deck-list--groups { display: flex; flex-direction: column; gap: 8px; }
    .deck-grp-card {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 10px 12px; border-radius: 10px; border: 1.5px solid var(--tm-line);
      background: var(--tm-canvas); cursor: pointer; transition: all .14s ease;
    }
    .deck-grp-card:hover { border-color: var(--tm-text-muted); }
    .deck-grp-card.is-active {
      border-color: var(--tm-green, #16a34a); background: var(--tm-green-tint, #ecfdf5);
      box-shadow: 0 2px 6px rgba(22,163,74,0.12);
    }
    .deck-grp-card-body { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; }
    .deck-grp-radio-dot {
      width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--tm-line-2, #cbd5e1); flex: none;
    }
    .deck-grp-radio-dot.is-on {
      border-color: var(--tm-green, #16a34a); background: var(--tm-green, #16a34a);
    }
    .deck-grp-card-info { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
    .deck-grp-card-name { font-size: 13px; font-weight: 800; color: var(--tm-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .deck-grp-rename-box {
      height: 24px; padding: 0 6px; font-size: 12px; font-weight: 700; border: 1px solid var(--tm-green); border-radius: 4px; outline: none;
    }
    .deck-grp-card-meta { display: flex; gap: 6px; flex-wrap: wrap; }
    .deck-pill-meta { display: inline-flex; align-items: center; gap: 3px; font-size: 10.5px; font-weight: 700; color: var(--tm-text-muted); }
    .deck-grp-card-actions { display: flex; align-items: center; gap: 4px; }
    .deck-icon-act {
      width: 24px; height: 24px; border: 0; border-radius: 6px; background: transparent;
      color: var(--tm-text-muted); display: grid; place-items: center; cursor: pointer; transition: all .12s ease;
    }
    .deck-icon-act:hover { background: rgba(0,0,0,0.06); color: var(--tm-text); }
    .deck-icon-act--active { color: var(--tm-green, #16a34a) !important; background: var(--tm-green-tint, #ecfdf5) !important; }
    .deck-icon-act--active:hover { background: #bbf7d0 !important; color: #166534 !important; }
    .deck-icon-act--danger:hover { background: #fee2e2; color: #dc2626; }

    /* Panel 2: Routes */
    .deck-routes-container { display: flex; flex-direction: column; gap: 12px; }
    .deck-routes-subhead {
      display: flex; align-items: center; justify-content: space-between; gap: 6px;
      font-size: 12px; font-weight: 800; color: var(--tm-text);
    }
    .deck-routes-subhead.unassigned { color: #0284c7; margin-top: 8px; padding-top: 12px; border-top: 1px dashed var(--tm-line); }
    .deck-count-badge {
      font-size: 10.5px; font-weight: 800; padding: 1px 7px; border-radius: 999px;
      background: var(--tm-green-tint, #ecfdf5); color: var(--tm-green-deep, #15803d);
    }
    .deck-count-badge.unassigned { background: #e0f2fe; color: #0369a1; }
    .deck-routes-list { display: flex; flex-direction: column; gap: 6px; }
    .deck-route-row {
      display: flex; align-items: center; gap: 10px; padding: 8px 12px;
      border-radius: 8px; border: 1.5px solid var(--tm-line); background: var(--tm-canvas);
      transition: all .12s ease;
    }
    .deck-route-row.is-assigned { border-color: #86efac; background: #fff; }
    .deck-route-row.is-unassigned { border-color: #bae6fd; background: #f8fafc; }
    .deck-route-bullet { display: inline-flex; align-items: center; flex: none; color: var(--tm-text-muted); }
    .deck-route-details { display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 0; }
    .deck-route-title-line { display: flex; align-items: center; gap: 8px; }
    .deck-route-name { font-size: 12.5px; font-weight: 800; color: var(--tm-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .deck-fare-tag { display: inline-flex; align-items: center; gap: 2px; font-size: 11px; font-weight: 800; color: #0f766e; background: #ccfbf1; padding: 0 5px; border-radius: 4px; }
    .deck-warning-tag { display: inline-flex; align-items: center; gap: 2px; font-size: 10px; font-weight: 800; color: #b45309; background: #fef3c7; padding: 0 5px; border-radius: 4px; }
    .deck-route-path { font-size: 11px; color: var(--tm-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .deck-route-btn {
      display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 8px;
      border-radius: 6px; font-size: 11px; font-weight: 700; cursor: pointer; border: 0; white-space: nowrap;
    }
    .deck-route-btn.remove { background: #fee2e2; color: #b91c1c; }
    .deck-route-btn.remove:hover { background: #fca5a5; }
    .deck-route-btn.add { background: var(--tm-green, #16a34a); color: #fff; }
    .deck-stops-tag { display: inline-flex; align-items: center; gap: 2px; font-size: 10px; font-weight: 800; color: #4338ca; background: #e0e7ff; padding: 0 5px; border-radius: 4px; }
    .deck-route-actions { display: flex; align-items: center; gap: 5px; flex-shrink: 0; }
    .deck-route-btn.edit { background: var(--tm-canvas-2, #e2e8f0); color: var(--tm-text); }
    .deck-route-btn.edit:hover { background: #cbd5e1; color: #0f172a; }

    /* Panel 3: Drivers */
    .deck-drivers-container { display: flex; flex-direction: column; gap: 8px; }
    .deck-driver-card {
      display: flex; flex-direction: column; gap: 8px; padding: 10px 12px;
      border-radius: 10px; border: 1.5px solid var(--tm-line); background: var(--tm-canvas);
    }
    .deck-driver-top { display: flex; align-items: center; gap: 10px; }
    .deck-driver-avatar {
      width: 28px; height: 28px; border-radius: 50%; background: var(--tm-green, #16a34a);
      color: #fff; font-size: 11px; font-weight: 800; display: grid; place-items: center; flex: none;
    }
    .deck-driver-meta { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
    .deck-driver-name-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
    .deck-driver-name { font-size: 12.5px; font-weight: 800; color: var(--tm-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .deck-driver-status-pill {
      font-size: 9.5px; font-weight: 800; text-transform: uppercase; padding: 1px 6px;
      border-radius: 4px; background: var(--tm-canvas-2, #e2e8f0); color: var(--tm-text-muted);
    }
    .deck-driver-status-pill.is-active { background: #bbf7d0; color: #166534; }
    .deck-driver-sub-line { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 10.5px; }
    .deck-car-tag { display: inline-flex; align-items: center; gap: 3px; font-weight: 700; color: var(--tm-text-muted); }
    .deck-reg-tag { font-weight: 800; color: #475569; padding: 0 4px; background: rgba(0,0,0,0.05); border-radius: 3px; }
    .deck-phone-tag { display: inline-flex; align-items: center; gap: 3px; color: var(--tm-text-muted); font-weight: 600; }

    .deck-driver-chips-bar {
      display: flex; flex-direction: column; gap: 4px;
      padding-top: 6px; border-top: 1px dashed var(--tm-line);
    }
    .deck-chips-label-row {
      display: flex; align-items: center; justify-content: space-between; gap: 6px;
    }
    .deck-chips-lbl { font-size: 10.5px; font-weight: 700; color: var(--tm-text-muted); }
    .deck-chips-actions { display: flex; align-items: center; gap: 4px; }
    .deck-text-btn {
      border: 0; background: transparent; color: var(--tm-green, #16a34a); font-size: 10.5px; font-weight: 700; cursor: pointer; padding: 1px 4px; border-radius: 4px;
    }
    .deck-text-btn:hover:not([disabled]) { background: var(--tm-green-tint, #ecfdf5); }
    .deck-text-btn--danger { color: #dc2626; }
    .deck-text-btn--danger:hover:not([disabled]) { background: #fef2f2; }
    .deck-text-btn[disabled] { opacity: 0.35; cursor: not-allowed; }

    .deck-chips-grid { display: flex; flex-wrap: wrap; gap: 5px; }
    .deck-group-chip {
      display: inline-flex; align-items: center; gap: 4px; padding: 4px 9px;
      border-radius: 999px; border: 1.5px solid var(--tm-line); background: var(--tm-canvas-2, #f1f5f9);
      color: var(--tm-text); font-size: 11px; font-weight: 600; cursor: pointer; transition: all .12s ease;
    }
    .deck-group-chip:hover:not([disabled]) { border-color: var(--tm-text-muted); }
    .deck-group-chip.is-assigned {
      border-color: var(--tm-green, #16a34a); background: var(--tm-green-tint, #ecfdf5);
      color: var(--tm-green-deep, #15803d); font-weight: 700;
    }
    .deck-group-chip[disabled] { opacity: 0.6; cursor: wait; }

    .deck-empty-state {
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
      padding: 24px 16px; text-align: center; font-size: 12px; color: var(--tm-text-muted);
      border: 1px dashed var(--tm-line); border-radius: 10px;
    }
    .deck-empty-inline {
      padding: 10px; text-align: center; font-size: 11.5px; color: var(--tm-text-muted);
      background: var(--tm-canvas); border-radius: 8px;
    }
    .deck-muted-note { font-size: 11px; color: var(--tm-text-muted); font-style: italic; }

    /* View Switcher in Deck Header */
    .deck-view-switcher {
      display: inline-flex; align-items: center; gap: 4px; padding: 3px;
      background: rgba(0,0,0,0.25); border-radius: 9px; border: 1px solid rgba(255,255,255,0.12);
    }
    .deck-tab-btn {
      display: inline-flex; align-items: center; gap: 6px; padding: 5px 11px;
      border-radius: 7px; border: 0; background: transparent; color: #cbd5e1;
      font-size: 11.5px; font-weight: 700; cursor: pointer; transition: all .15s ease;
    }
    .deck-tab-btn:hover { color: #fff; background: rgba(255,255,255,0.08); }
    .deck-tab-btn.is-active { background: #fff; color: #0f172a; box-shadow: 0 1px 4px rgba(0,0,0,0.15); }

    /* All Routes Flat Table Mode */
    .deck-all-routes-wrap {
      display: flex; flex-direction: column; gap: 10px; padding: 16px;
      border-radius: 12px; border: 1.5px solid var(--tm-line, #e2e8f0);
      background: var(--tm-surface, #fff); box-shadow: 0 1px 4px rgba(0,0,0,0.03);
    }
    .deck-all-routes-head {
      display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;
    }
    .deck-all-routes-title { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 800; color: var(--tm-text); }
    .deck-all-table-box { overflow-x: auto; border: 1px solid var(--tm-line); border-radius: 8px; }
    .deck-flat-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .deck-flat-table th {
      background: var(--tm-canvas); color: var(--tm-text-muted); font-size: 10.5px; font-weight: 800;
      text-transform: uppercase; letter-spacing: .05em; padding: 8px 12px; text-align: left;
      border-bottom: 1px solid var(--tm-line);
    }
    .deck-flat-table td {
      padding: 10px 12px; border-bottom: 1px solid var(--tm-line); vertical-align: middle; background: var(--tm-surface);
    }
    .deck-flat-table tr:last-child td { border-bottom: 0; }
    .deck-flat-table tr:hover td { background: var(--tm-canvas); }
    .deck-tbl-route-main { display: flex; align-items: center; gap: 10px; }
    .deck-tbl-ic { font-size: 16px; }
    .deck-tbl-txt { display: flex; flex-direction: column; gap: 1px; }
    .deck-tbl-name { font-size: 12.5px; font-weight: 800; color: var(--tm-text); }
    .deck-tbl-path { font-size: 11px; color: var(--tm-text-muted); }
    .deck-tbl-grp-pill { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 6px; background: #e0e7ff; color: #3730a3; font-size: 11px; font-weight: 700; }
    .deck-tbl-ungrp-pill { display: inline-flex; align-items: center; padding: 3px 8px; border-radius: 6px; background: #f1f5f9; color: #64748b; font-size: 11px; font-weight: 600; }
    .deck-tbl-actions { display: flex; align-items: center; justify-content: flex-end; gap: 6px; }

    /* Dedicated Vehicle Operations Hub Drawer */
    .op-drawer-body { display: flex; flex-direction: column; gap: 20px; }
    .op-hero-card {
      display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap;
      padding: 16px 20px; border-radius: 14px; background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
      color: #fff; box-shadow: 0 4px 14px rgba(15,23,42,0.15);
    }
    .op-hero-left { display: flex; align-items: center; gap: 14px; }
    .op-hero-icon {
      width: 46px; height: 46px; border-radius: 12px; background: rgba(255,255,255,0.12);
      border: 1px solid rgba(255,255,255,0.18); display: grid; place-items: center; color: #fff; flex: none;
    }
    .op-hero-details { display: flex; flex-direction: column; gap: 2px; }
    .op-hero-badge {
      font-size: 10.5px; font-weight: 800; text-transform: uppercase; letter-spacing: .06em;
      color: #86efac;
    }
    .op-hero-title { margin: 0; font-size: 19px; font-weight: 800; color: #fff; letter-spacing: -0.01em; }
    .op-hero-sub { font-size: 12px; color: #94a3b8; font-weight: 500; }
    .op-hero-stats { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .op-stat-box {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      padding: 6px 14px; border-radius: 10px; background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.12); min-width: 76px;
    }
    .op-stat-num { font-size: 16px; font-weight: 800; color: #fff; line-height: 1.2; }
    .op-stat-lbl { font-size: 10px; font-weight: 700; text-transform: uppercase; color: #94a3b8; }

    .op-tabs-bar {
      display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
      padding-bottom: 12px; border-bottom: 1.5px solid var(--tm-line);
    }
    .op-tabs-nav { display: flex; align-items: center; gap: 6px; }
    .op-tab-btn {
      display: inline-flex; align-items: center; gap: 7px; padding: 8px 14px;
      border-radius: 9px; border: 1.5px solid var(--tm-line); background: var(--tm-canvas);
      color: var(--tm-text-muted); font-size: 12.5px; font-weight: 700; cursor: pointer; transition: all .15s ease;
    }
    .op-tab-btn:hover { border-color: var(--tm-text-muted); color: var(--tm-text); }
    .op-tab-btn.is-active {
      border-color: #0f172a; background: #0f172a; color: #fff; box-shadow: 0 2px 8px rgba(15,23,42,0.15);
    }
    .op-tabs-quick-acts { display: flex; align-items: center; gap: 8px; }
    .btn-op-primary {
      display: inline-flex; align-items: center; gap: 6px; padding: 7px 13px;
      border-radius: 8px; border: 0; background: var(--tm-green, #16a34a); color: #fff;
      font-size: 12px; font-weight: 700; cursor: pointer; transition: all .14s ease;
    }
    .btn-op-primary:hover { filter: brightness(.93); }
    .btn-op-outline {
      display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px;
      border-radius: 8px; border: 1.5px solid var(--tm-line); background: var(--tm-surface);
      color: var(--tm-text); font-size: 12px; font-weight: 700; cursor: pointer; transition: all .14s ease;
    }
    .btn-op-outline:hover { background: var(--tm-canvas); }
    /* ── Visual Kanban Board Styles (Pro Balanced Architecture) ── */
    .kb-wrapper {
      display: flex; flex-direction: column; gap: 14px;
      min-height: 0; flex: 1;
    }
    .route-view-tabs { display: flex; gap: 8px; flex-shrink: 0; }
    .route-view-tabs button { padding: 10px 16px; border: 1px solid var(--tm-line); border-radius: 10px; background: var(--tm-surface, #fff); color: var(--tm-text); font: inherit; cursor: pointer; }
    .route-view-tabs button.selected { background: var(--tm-green-tint, #ecfdf5); border-color: var(--tm-green, #16a34a); font-weight: 700; }
    .route-directory { border: 1px solid var(--tm-line); border-radius: 14px; background: var(--tm-surface, #fff); overflow: auto; min-height: 0; }
    .route-directory-header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px; padding: 20px; border-bottom: 1px solid var(--tm-line); }
    .route-directory-header h3 { margin: 0 0 6px; }
    .route-directory-header p { margin: 0; color: var(--tm-muted, #64748b); font-size: 13px; }
    .route-directory-header label { display: flex; align-items: center; gap: 10px; font-size: 13px; }
    .route-directory-header select { padding: 8px 12px; border: 1px solid var(--tm-line); border-radius: 8px; background: var(--tm-surface, #fff); color: var(--tm-text); }
    .route-directory-row { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; padding: 16px 20px; border-bottom: 1px solid var(--tm-line); }
    .route-directory-row:last-child { border-bottom: 0; }
    .route-directory-info { display: flex; flex-direction: column; gap: 5px; flex: 1; min-width: 200px; overflow-wrap: anywhere; }
    .route-directory-info span, .route-directory-info small { color: var(--tm-muted, #64748b); }
    .route-directory-row button:disabled { opacity: .6; cursor: wait; }
    .kb-top-bar {
      display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
      padding: 10px 16px; border-radius: 12px; background: var(--tm-canvas); border: 1.5px solid var(--tm-line);
      flex-shrink: 0;
    }
    .kb-top-left { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; flex: 1; }
    .kb-veh-tag { display: flex; align-items: center; gap: 10px; }
    .kb-veh-icon-box {
      width: 32px; height: 32px; border-radius: 8px; background: var(--tm-green-tint, #ecfdf5);
      border: 1px solid #86efac; display: grid; place-items: center; color: var(--tm-green, #16a34a);
    }
    .kb-veh-info { display: flex; flex-direction: column; gap: 1px; }
    .kb-veh-name { font-weight: 800; font-size: 14px; color: var(--tm-text); }
    .kb-veh-spec { font-size: 11px; color: var(--tm-text-muted); font-weight: 600; }
    .kb-search {
      display: flex; align-items: center; gap: 8px; padding: 0 10px; height: 34px;
      border-radius: 8px; border: 1px solid var(--tm-line); background: var(--tm-surface);
      width: 220px; color: var(--tm-text-muted);
    }
    .kb-search input { border: 0; background: transparent; font: inherit; font-size: 12px; color: var(--tm-text); outline: none; width: 100%; }
    
    .kb-top-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .kb-quick-add-group { display: flex; align-items: center; gap: 4px; }
    .kb-quick-grp-input {
      height: 34px; width: 160px; padding: 0 10px; border-radius: 8px; border: 1.5px solid var(--tm-line);
      background: var(--tm-surface); font-size: 12px; color: var(--tm-text); outline: none; font-weight: 600;
    }
    .kb-quick-grp-input:focus { border-color: var(--tm-green, #16a34a); }
    .btn-kb-quick-add {
      height: 34px; padding: 0 12px; border-radius: 8px; border: 0; background: #0f172a; color: #fff;
      font-size: 12px; font-weight: 700; cursor: pointer; white-space: nowrap; transition: opacity .12s;
    }
    .btn-kb-quick-add:disabled { opacity: 0.45; cursor: not-allowed; }
    .btn-kb-primary {
      display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 13px;
      border-radius: 8px; border: 0; background: var(--tm-green, #16a34a); color: #fff;
      font-size: 12px; font-weight: 700; cursor: pointer; transition: all .12s ease; white-space: nowrap;
    }
    .btn-kb-primary:hover { filter: brightness(.92); }
    .btn-kb-outline {
      display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 12px;
      border-radius: 8px; border: 1.5px solid var(--tm-line); background: var(--tm-surface);
      color: var(--tm-text); font-size: 12px; font-weight: 700; cursor: pointer; transition: all .12s ease; white-space: nowrap;
    }
    .btn-kb-outline:hover { background: var(--tm-canvas); }

    /* Columns container: Responsive auto-fit or flex scroll */
    .kb-columns-container {
      display: flex; gap: 14px; overflow-x: auto;
      padding-bottom: 10px; align-items: stretch; min-height: 480px; flex: 1;
      scrollbar-width: thin; scrollbar-color: var(--tm-line-2, #cbd5e1) transparent;
      scroll-behavior: smooth;
    }
    .kb-column {
      flex: 1 1 300px; min-width: 280px; max-width: 380px;
      display: flex; flex-direction: column; gap: 10px;
      padding: 14px 12px; border-radius: 14px; border: 1.5px solid var(--tm-line);
      background: var(--tm-canvas); max-height: calc(100vh - 220px);
      transition: border-color .15s ease, background-color .15s ease, box-shadow .15s ease, transform .15s ease;
    }
    .group-workspace { display: grid; grid-template-columns: 250px minmax(0, 1fr); gap: 20px; min-height: 0; }
    .group-navigation { display: flex; flex-direction: column; gap: 10px; padding: 16px; border: 1px solid var(--tm-line); border-radius: 14px; background: var(--tm-surface); align-self: start; }
    .group-navigation h3 { margin: 0; }
    .group-navigation p, .group-route-picker p { color: var(--tm-text-muted); font-size: 13px; line-height: 1.5; margin: 0 0 8px; }
    .group-search, .group-create-form input { width: 100%; box-sizing: border-box; border: 1px solid var(--tm-line); border-radius: 8px; padding: 10px; font: inherit; color: var(--tm-text); background: var(--tm-surface); }
    .group-nav-item { display: flex; align-items: center; justify-content: space-between; gap: 10px; text-align: left; border: 1px solid transparent; background: transparent; border-radius: 8px; padding: 12px; color: var(--tm-text); font: inherit; cursor: pointer; overflow-wrap: anywhere; }
    .group-nav-item.selected { background: var(--tm-green-tint, #ecfdf5); border-color: var(--tm-green, #16a34a); }
    .group-nav-item small, .group-picker-list small { display: block; margin-top: 4px; color: var(--tm-text-muted); font-size: 12px; }
    .group-create-form { display: flex; flex-direction: column; gap: 8px; padding: 12px; background: var(--tm-canvas); border-radius: 10px; }
    .group-workspace .kb-columns-container { min-width: 0; overflow-x: visible; display: block; }
    .group-workspace .kb-column { width: 100%; max-width: none; min-width: 0; box-sizing: border-box; max-height: none; padding: 20px; }
    .group-workspace .kb-cards-scroll { overflow: visible; max-height: none; }
    .group-workspace .kb-grp-name { max-width: none; white-space: normal; font-size: 18px; }
    .group-workspace .kb-drv-chips-container { max-height: none; }
    .group-workspace .kb-drv-popover { position: static; width: auto; margin-top: 12px; box-shadow: none; }
    .group-workspace .kb-card-name, .group-workspace .kb-card-path { white-space: normal; }
    .group-workspace .kb-card-name { font-size: 14px; }
    .group-workspace .kb-card-path { font-size: 13px; }
    .group-workspace .kb-card { cursor: default; user-select: text; padding: 16px; }
    .group-workspace .kb-action-btn { min-height: 34px; font-size: 12px; }
    .group-workspace .kb-col-title-line, .group-workspace .kb-card-footer { flex-wrap: wrap; }
    .group-workspace .kb-col-desc { font-size: 13px; line-height: 1.5; }
    .group-route-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin: 12px 0; font-size: 13px; }
    .group-route-picker { padding: 16px; border: 1px solid var(--tm-line); border-radius: 10px; background: var(--tm-surface); }
    .group-picker-list { max-height: 280px; overflow-y: auto; margin: 12px 0; }
    .group-picker-list label { display: flex; align-items: center; gap: 12px; padding: 12px 4px; border-bottom: 1px solid var(--tm-line); }
    @media (max-width: 800px) { .group-workspace { grid-template-columns: 1fr; } .group-navigation { max-height: 320px; overflow: auto; } }
    .kb-column--unassigned { border-color: #bae6fd; background: #f8fafc; }
    .kb-column--group { border-color: var(--tm-line); background: var(--tm-canvas); }

    .kb-col-header { display: flex; flex-direction: column; gap: 8px; flex-shrink: 0; }
    .kb-col-title-line { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
    .kb-col-title { display: flex; align-items: center; gap: 6px; font-size: 13.5px; font-weight: 800; color: var(--tm-text); }
    .kb-col-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
    .kb-col-dot--sky { background: #0284c7; }
    .kb-col-dot--green { background: #16a34a; }
    .kb-col-heading { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .kb-grp-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 155px; }
    .kb-rename-input { flex: 1; height: 26px; font-size: 12px; font-weight: 700; border: 1.5px solid var(--tm-green, #16a34a); border-radius: 6px; padding: 0 6px; outline: none; }
    .kb-col-desc { margin: 0; font-size: 11px; color: var(--tm-text-muted); line-height: 1.25; }

    .kb-count-pill {
      font-size: 10px; font-weight: 800; padding: 1px 7px; border-radius: 999px;
      background: var(--tm-green-tint, #ecfdf5); color: var(--tm-green-deep, #15803d);
    }
    .kb-count-pill--sky { background: #e0f2fe; color: #0369a1; }
    .kb-grp-acts { display: flex; align-items: center; gap: 3px; }
    .kb-icon-btn {
      width: 22px; height: 22px; border: 0; border-radius: 5px; background: transparent;
      color: var(--tm-text-muted); display: grid; place-items: center; cursor: pointer;
    }
    .kb-icon-btn:hover { background: rgba(0,0,0,0.06); color: var(--tm-text); }
    .kb-icon-btn--danger:hover { background: #fee2e2; color: #dc2626; }

    /* Driver Section in Group Column Header */
    .kb-driver-assign-section {
      position: relative; display: flex; flex-direction: column; gap: 6px;
      padding: 6px 8px; border-radius: 8px; background: var(--tm-surface);
      border: 1px solid var(--tm-line);
    }
    .kb-drv-head-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
    .kb-drv-chips-container { display: flex; flex-wrap: wrap; gap: 4px; max-height: 54px; overflow-y: auto; flex: 1; }
    .kb-drv-chip {
      display: inline-flex; align-items: center; gap: 3px; padding: 1px 6px;
      border-radius: 999px; background: var(--tm-green-tint, #ecfdf5);
      border: 1px solid #86efac; font-size: 9.5px; font-weight: 700; color: #166534;
    }
    .kb-chip-avatar {
      width: 14px; height: 14px; border-radius: 50%; background: var(--tm-green, #16a34a); color: #fff;
      font-size: 8px; display: grid; place-items: center;
    }
    .kb-chip-name { max-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .kb-chip-remove { border: 0; background: transparent; color: #166534; font-size: 12px; cursor: pointer; line-height: 1; padding: 0 1px; }
    .kb-chip-remove:hover { color: #dc2626; }
    .kb-no-drv-hint { font-size: 10px; color: var(--tm-text-muted); font-style: italic; }
    .kb-btn-manage-drv {
      display: inline-flex; align-items: center; gap: 2px; border: 0; background: transparent;
      color: var(--tm-green, #16a34a); font-size: 10px; font-weight: 700; cursor: pointer; padding: 2px 4px; border-radius: 4px; white-space: nowrap;
    }
    .kb-btn-manage-drv:hover { background: var(--tm-green-tint, #ecfdf5); }

    /* Driver Popover */
    .kb-drv-popover {
      position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 80;
      background: var(--tm-surface); border: 1px solid var(--tm-line); border-radius: 10px;
      box-shadow: 0 10px 25px -5px rgba(0,0,0,0.15); padding: 8px; display: flex; flex-direction: column; gap: 6px;
    }
    .kb-popover-head { display: flex; align-items: center; justify-content: space-between; font-size: 11px; border-bottom: 1px solid var(--tm-line); padding-bottom: 4px; }
    .kb-popover-x { border: 0; background: transparent; cursor: pointer; font-size: 13px; color: var(--tm-text-muted); }
    .kb-popover-list { max-height: 180px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
    .kb-popover-item { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 6px; font-size: 11px; cursor: pointer; }
    .kb-popover-item:hover { background: var(--tm-canvas); }
    .kb-popover-item-info { display: flex; flex-direction: column; gap: 1px; }
    .kb-pop-dname { font-weight: 700; color: var(--tm-text); }
    .kb-pop-dreg { font-size: 9.5px; color: var(--tm-text-muted); }
    .kb-pop-empty { font-size: 11px; color: var(--tm-text-muted); text-align: center; padding: 8px; }

    .kb-column.is-drop-target {
      border-color: var(--tm-green, #16a34a) !important;
      background: var(--tm-green-tint, #ecfdf5) !important;
      box-shadow: 0 0 0 2px var(--tm-green, #16a34a), 0 8px 24px rgba(22,163,74,0.15);
      transform: translateY(-2px);
    }

    /* Anti-flicker drag state */
    .kb-wrapper.is-dragging-active .kb-col-header,
    .kb-wrapper.is-dragging-active .kb-card * {
      pointer-events: none;
    }

    /* Cards Scroll Area */
    .kb-cards-scroll {
      display: flex; flex-direction: column; gap: 7px; overflow-y: auto;
      padding-right: 2px; flex: 1; min-height: 100px;
      scrollbar-width: thin; scrollbar-color: var(--tm-line, #e2e8f0) transparent;
      scroll-behavior: smooth;
    }

    /* Card Styling */
    .kb-card {
      display: flex; flex-direction: column; gap: 6px; padding: 10px 12px;
      border-radius: 10px; border: 1.5px solid var(--tm-line); background: var(--tm-surface);
      box-shadow: 0 1px 3px rgba(0,0,0,0.03);
      cursor: grab; user-select: none;
      transition: transform .14s ease, box-shadow .14s ease, border-color .14s ease;
      animation: kbCardPopIn .18s cubic-bezier(0.34, 1.56, 0.64, 1);
    }
    @keyframes kbCardPopIn {
      from { opacity: 0.3; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .kb-card:hover { border-color: var(--tm-text-muted); transform: translateY(-1px); box-shadow: 0 3px 8px rgba(0,0,0,0.06); }
    .kb-card:active { cursor: grabbing; }
    .kb-card.is-dragging {
      opacity: 0.4; transform: rotate(1.5deg) scale(0.97);
      border: 1.5px dashed var(--tm-green, #16a34a);
      box-shadow: 0 8px 22px rgba(0,0,0,0.15);
    }

    .kb-card-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
    .kb-card-title-group { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; }
    .kb-drag-handle {
      display: inline-flex; align-items: center; color: var(--tm-text-muted); opacity: 0.45;
      cursor: grab; flex-shrink: 0; padding: 1px 0;
    }
    .kb-card:hover .kb-drag-handle { opacity: 1; color: var(--tm-text); }
    .kb-card-name { font-size: 12.5px; font-weight: 800; color: var(--tm-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
    .pill--sm { padding: 2px 7px; font-size: 9.5px; }

    .kb-card-path { font-size: 11px; color: var(--tm-text-muted); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .kb-card-meta-row { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
    .kb-fare-pill { font-size: 10.5px; font-weight: 800; color: #0f766e; background: #ccfbf1; padding: 1px 6px; border-radius: 4px; }
    .kb-fare-pill--warn { color: #b45309; background: #fef3c7; display: inline-flex; align-items: center; gap: 2px; }
    .kb-stops-pill { display: inline-flex; align-items: center; gap: 2px; font-size: 10px; font-weight: 800; color: #4338ca; background: #e0e7ff; padding: 1px 6px; border-radius: 4px; }

    .kb-card-footer {
      display: flex; align-items: center; justify-content: space-between; gap: 6px;
      padding-top: 6px; border-top: 1px dashed var(--tm-line);
    }
    .kb-action-btn {
      display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 7px;
      border-radius: 6px; font-size: 10.5px; font-weight: 700; cursor: pointer; border: 0;
    }
    .kb-action-btn--edit { background: var(--tm-canvas-2, #e2e8f0); color: var(--tm-text); }
    .kb-action-btn--edit:hover { background: #cbd5e1; color: #0f172a; }
    .kb-action-btn--remove { background: #fee2e2; color: #b91c1c; }
    .kb-action-btn--remove:hover { background: #fca5a5; }

    .kb-move-dropdown { flex: 1; min-width: 0; }
    .kb-select-input {
      width: 100%; height: 24px; font-size: 10.5px; font-weight: 700; color: var(--tm-text-muted);
      border: 1px solid var(--tm-line); border-radius: 6px; background: var(--tm-canvas); outline: none; cursor: pointer;
    }
    .kb-select-input:hover { border-color: var(--tm-green, #16a34a); color: var(--tm-text); }

    /* Drop Target Indicator */
    .kb-drop-placeholder {
      display: flex; align-items: center; justify-content: center; gap: 8px;
      padding: 14px 10px; border-radius: 10px; border: 2px dashed var(--tm-green, #16a34a);
      background: var(--tm-green-tint, #ecfdf5); color: var(--tm-green-deep, #15803d);
      font-size: 11.5px; font-weight: 800; animation: kbPulse 1.2s infinite ease-in-out;
      margin-top: 2px;
    }
    @keyframes kbPulse {
      0%, 100% { opacity: 0.85; transform: scale(0.99); }
      50% { opacity: 1; transform: scale(1.01); background: #dcfce7; }
    }

    .kb-empty-col {
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
      padding: 26px 12px; text-align: center; font-size: 11px; color: var(--tm-text-muted);
      border: 1.5px dashed var(--tm-line); border-radius: 10px; margin: auto 0;
    }

    /* row kebab menu */
    .menu-scrim { position: fixed; inset: 0; z-index: 70; }
    .rowmenu { position: fixed; z-index: 71; min-width: 210px; padding: 6px; background: var(--tm-surface); border: 1px solid var(--tm-line); border-radius: 12px; box-shadow: var(--tm-shadow-pop, 0 12px 40px -16px rgba(15,20,25,.25)); display: flex; flex-direction: column; gap: 2px; }
    .rowmenu button { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 11px; border: 0; border-radius: 9px; background: transparent; color: var(--tm-text); font: inherit; font-size: 13px; font-weight: 600; text-align: left; cursor: pointer; }
    .rowmenu button:hover { background: var(--tm-canvas); }
    .rowmenu__div { height: 1px; margin: 5px 0; background: var(--tm-line); }

    @media (max-width: 940px) {
      .split { grid-template-columns: 1fr; }
      .is-hidden-sm { display: none; }
      .backlink { display: inline-flex; }
    }
    @media (max-width: 860px) {
      .cards { grid-template-columns: 1fr; }
    }
    @media (max-width: 620px) {
      .vehicle-page-heading { flex-basis: 100%; }
      .controls .search { flex-basis: 100%; max-width: none; }
      .vehicle-filter { flex: 1 1 140px; }
      .vehicle-view-controls { width: 100%; margin-left: 0; justify-content: space-between; }
      .rt { grid-template-columns: 1fr auto auto; }
      .rt__col--sm { display: none; }
    }
  `],
})
export class VehicleWorkspaceComponent implements OnInit, OnDestroy {
  @Input() masterSection: MasterSection | null = null;
  masterEditGroupId: number | null = null;
  get masterEditGroup(): GroupRow | null { return this.groups.find(group => group.id === this.masterEditGroupId) ?? null; }
  openMasterGroupEditor(vehicle: CityVehicleRow, group: GroupRow): void { this.select(vehicle); this.masterEditGroupId = group.id; }
  get masterEditRoutes(): RouteLite[] { return this.selected ? this.routes.filter(route => this.masterEditGroup?.route_ids.includes(route.id) || this.routesForVehicle(this.selected!).some(item => item.id === route.id)) : []; }
  editMasterGroupRoute(routeId: number): void {
    this.masterEditGroupId = null;
    this.handleMasterAction({ kind: 'edit-route', id: routeId, vehicleId: this.selected?.id });
  }
  masterGroupCreatedVersion = 0;
  createMasterInlineGroup(draft: { name: string; vehicleId: number }): void {
    if (this.groupSaving) return;
    const vehicle = this.vehicles.find(vehicle => vehicle.id === draft.vehicleId);
    if (!vehicle) return;
    this.select(vehicle); this.groupName = draft.name; this.createGroup();
  }
  masterGroupCreateOpen = false;
  get masterHeading(): string {
    return this.masterSection === 'routes' ? 'Routes' : this.masterSection === 'drivers' ? 'Drivers' : this.masterSection === 'route-groups' ? 'Stands' : this.masterSection === 'vehicle-configuration' ? 'Vehicle Configuration' : 'Vehicles';
  }
  handleMasterAction(action: MasterAction): void {
    const route = this.routes.find(row => row.id === action.id);
    const group = this.groups.find(row => row.id === action.id);
    if (action.kind === 'driver') {
      const driver = this.cityDrivers.find(row => row.id === action.id);
      if (driver) void this.router.navigate(['/drivers', driver.id]);
      return;
    }
    if (action.kind === 'group-drivers' && group) { this.openDriverDrawer(group); return; }
    if (action.kind === 'delete-group' && group) { this.deleteGroup(group); return; }
    if (action.kind === 'toggle-route' && route) { this.toggleRouteActive(route); return; }
    const owningId = action.kind === 'edit-route' ? route?.city_vehicle_type_id : action.kind === 'edit-group' ? group?.city_vehicle_type_id : action.vehicleId;
    const groupVehicleId = action.kind === 'edit-group' ? this.routes.find(row => group?.route_ids.includes(row.id) && row.city_vehicle_type_id !== null)?.city_vehicle_type_id : null;
    const vehicle = this.vehicles.find(row => (row.mode_row_ids ?? [row.id]).includes(owningId ?? -1)) ?? this.vehicles.find(row => (row.mode_row_ids ?? [row.id]).includes(groupVehicleId ?? -1)) ?? this.vehicles.find(row => (row.mode_row_ids ?? [row.id]).includes(action.vehicleId ?? -1)) ?? (action.kind.startsWith('edit-') ? this.vehicles[0] : undefined);
    if (!vehicle) { this.toast.warning('Choose a city vehicle first.'); return; }
    if (action.kind === 'add-route') this.newRouteFor(vehicle);
    if (action.kind === 'edit-route' && route) this.editRouteFor(vehicle, route.id);
    if (action.kind === 'import') this.openImportChoice(vehicle);
    if (action.kind === 'add-group') { this.select(vehicle); this.groupName = ''; this.masterGroupCreateOpen = true; }
    if (action.kind === 'edit-group' && group) this.openMasterGroupEditor(vehicle, group);
  }
  handleOperationsCellEdit(event: { phase: 'start' | 'change' | 'save' | 'cancel'; id: number; field: 'name' | 'seats' | 'bags'; value?: string }): void {
    const vehicle = this.vehicles.find(row => row.id === event.id);
    if (!vehicle) return;
    if (event.phase === 'start') this.startCellEdit(vehicle, event.field);
    if (event.phase === 'change') this.editValue = event.value ?? '';
    if (event.phase === 'save') this.commitCellEdit(vehicle);
    if (event.phase === 'cancel') this.cancelCellEdit();
  }
  handleOperationsAction(action: OperationsAction): void {
    if (action.kind === 'add-vehicle') { this.openCreate(); return; }
    if (action.kind === 'vehicle-types') { this.openTypes(); return; }
    if (action.kind === 'vehicle-sets') { this.vehicleSetsOpen = true; return; }
    if (action.kind === 'copy-vehicles' || action.kind === 'bulk-enable' || action.kind === 'bulk-disable' || action.kind === 'export-vehicles') {
      this.selectedIds = new Set(action.ids ?? []);
      if (action.kind === 'copy-vehicles') this.openCopyModal();
      if (action.kind === 'bulk-enable') this.bulkSetActive(true);
      if (action.kind === 'bulk-disable') this.bulkSetActive(false);
      if (action.kind === 'export-vehicles') this.bulkExport();
      return;
    }
    const vehicle = this.vehicles.find(row => row.id === action.id);
    if (action.kind === 'edit-vehicle' && vehicle) { this.openCommonDrawer(vehicle); return; }
    if (action.kind === 'toggle-vehicle' && vehicle) { this.toggleActiveFor(vehicle); return; }
    if (action.kind === 'vehicle-layouts' && vehicle) { this.openLayoutsList(vehicle); return; }
    if (action.kind === 'vehicle-assets' && vehicle) { this.openAppAssets(vehicle); return; }
    if (action.kind === 'vehicle-drivers' && vehicle) { this.openOperationsDrawer(vehicle, 'drivers'); return; }
    if (action.kind === 'vehicle-fare' && vehicle) { const mode = this.fareRideTypes.find(row => row.id === action.rideTypeId); if (mode) this.openFareDrawer(vehicle, mode); return; }
    this.handleMasterAction(action as MasterAction);
  }
  @ViewChild(FixedRoutesComponent) private fixedRoutes?: FixedRoutesComponent;

  cityId: number | null = null;
  cityName = '';
  /** True only while the vehicle list itself is in flight. Everything else
   *  streams in behind the rendered list without blocking it. */
  loading = false;

  /** Raw per-mode rows straight from the API. */
  rows: CityVehicleRow[] = [];
  /** One entry per physical vehicle (mode rows merged). */
  vehicles: CityVehicleRow[] = [];
  /** Filtered view of `vehicles` — a field, not a getter, so change detection
   *  doesn't re-filter the whole list on every tick. */
  visible: CityVehicleRow[] = [];

  types: VehicleTypeRow[] = [];
  vehicleTypeOptions: VehicleTypeRef[] = [];
  /** Source of truth for the fare tabs — one tab per row, using its own name. */
  rideTypes: RideTypeRef[] = [];
  layouts: VehicleSeatLayout[] = [];
  routes: RouteLite[] = [];
  groups: GroupRow[] = [];
  cityDrivers: DriverOpt[] = [];

  selectedId: number | null = null;
  selected: CityVehicleRow | null = null;
  /** 'common' | 'drivers' | 'layouts' | 'mode:<rideTypeId>' */
  tab = 'common';
  tabList: TabDef[] = [];
  private tabByVehicle = new Map<number, string>();
  mobileEditor = false;

  // Derived slices for the selected vehicle, recomputed on data/selection change.
  activeRideType: RideTypeRef | null = null;
  activeKind: ModeKind = 'private';
  activeIsFixed = false;
  activeRow: CityVehicleRow | null = null;
  fareSubtitle = '';
  selDrivers: DriverOpt[] = [];
  otherDrivers: DriverOpt[] = [];
  selLayouts: VehicleSeatLayout[] = [];
  // Seat-layout designer drawer (opens over the workspace, no page nav).
  layoutDrawerOpen = false;
  editingLayoutId: number | null = null;
  editingLayout: VehicleSeatLayout | null = null;
  selGroups: GroupRow[] = [];
  ungrouped: RouteLite[] = [];
  // Route-group search + pagination, derived from selGroups in recompute().
  filteredGroups: GroupRow[] = [];
  pagedGroups: GroupRow[] = [];
  groupSearch = '';
  groupPage = 1;
  readonly groupPageSize = 6;
  groupPages = 1;

  search = '';
  status: CityVehicleStatus = 'all';
  typeFilter = 'all';
  /** Filter to a single vehicle by display name ('all' = every vehicle). */
  vehicleFilter = 'all';
  /** Which custom filter dropdown is open (drivers-page style). */
  filterOpen: 'type' | 'vehicle' | null = null;
  readonly statusChips: { label: string; value: CityVehicleStatus }[] = [
    { label: 'All statuses', value: 'all' },
    { label: 'Enabled', value: 'enabled' },
    { label: 'Disabled', value: 'disabled' },
  ];

  common = { display_name: '', max_people: 1, luggage_capacity: 0, is_active: true };
  savingCommon = false;
  savingActive = false;
  reverseBidding = false;
  savingUnique = false;
  creatingRideTypeId: number | null = null;
  /** vehicle+ride-type keys we've already tried to auto-create, so a failed
   *  create can never loop into duplicate rows on the next recompute. */
  private autoFareAttempted = new Set<string>();

  createOpen = false;
  creating = false;
  create = this.blankCreate();

  typesOpen = false;
  typeSaving = false;
  editingTypeId: number | null = null;
  typeForm = { name: '', is_active: true };

  // Common setup now lives in a right-side drawer opened by the row pen icon.
  commonDrawerOpen = false;
  commonDrawerVehicle: CityVehicleRow | null = null;

  // ── spreadsheet UI state ───────────────────────────────────
  /** Vehicles whose route-group detail row is expanded. */
  expanded: Record<number, boolean> = {};
  /** Checked rows for the bulk action bar. */
  selectedIds = new Set<number>();
  /** In-place cell edit (name / seats / bags). */
  editId: number | null = null;
  editField: '' | 'name' | 'seats' | 'bags' = '';
  editValue = '';
  savingCell = false;
  /** Floating row kebab menu. */
  menuId: number | null = null;
  menuX = 0;
  menuY = 0;
  /** Fare editor drawer — hosts app-vehicle-base-pricing for one vehicle+ride type. */
  fareDrawerOpen = false;
  /** Seat-layouts list drawer. */
  layoutsListOpen = false;

  /** Ride types that own a fare column (everything except the fixed one). */
  get fareRideTypes(): RideTypeRef[] { return this.rideTypes.filter((rt) => this.kindOf(rt.name) !== 'fixed'); }
  /** Columns after the gutter — used for the detail row + footer colspans. */
  get detailColspan(): number { return 9 + this.fareRideTypes.length; }
  /** Distinct vehicle names for the vehicle filter dropdown. */
  get vehicleNames(): string[] {
    return Array.from(new Set(this.vehicles.map((v) => v.display_name))).sort((a, b) => a.localeCompare(b));
  }
  get menuVehicle(): CityVehicleRow | null { return this.vehicles.find((v) => v.id === this.menuId) ?? null; }

  // ── copy vehicles to another location ──────────────────────
  copyModalOpen = false;
  copyingToLocation = false;
  allCities: CityOption[] = [];
  get operationsCountryCode(): string { return this.allCities.find(city => city.id === this.cityId)?.country_code || ''; }
  copyForm = {
    target_city_ids: [] as number[],
    vehicle_ids: [] as number[],
    copy_pricing: true,
    copy_seat_layouts: true,
    overwrite_existing: true,
  };
  copyScope: 'single' | 'selected' | 'all' = 'all';
  copySingleVehicle: CityVehicleRow | null = null;

  get copyModalTitle(): string {
    if (this.copySingleVehicle) {
      return `Copy "${this.copySingleVehicle.display_name}" to another location`;
    }
    return 'Copy vehicle settings to another location';
  }

  get availableTargetCities(): CityOption[] {
    return this.allCities.filter((c) => c.id !== this.cityId);
  }

  groupOpen = false;
  groupSaving = false;
  groupName = '';
  renamingId: number | null = null;
  renameValue = '';

  // ── Executive Operations Deck (Under-table Commander) state & methods ──
  inlineNewGroupName: Record<number, string> = {};
  canCreateInlineGroup(vId: number): boolean {
    const val = this.inlineNewGroupName[vId];
    return typeof val === 'string' && val.trim().length > 0;
  }
  activeDeckGroupId: Record<number, number> = {};
  isCreatingInlineGroup = false;
  renamingGroupId: number | null = null;

  getActiveDeckGroupId(v: CityVehicleRow): number | null {
    if (this.activeDeckGroupId[v.id] != null) {
      const exists = this.groupsForVehicle(v).some((g) => g.id === this.activeDeckGroupId[v.id]);
      if (exists) return this.activeDeckGroupId[v.id];
    }
    const first = this.groupsForVehicle(v)[0];
    if (first) {
      this.activeDeckGroupId[v.id] = first.id;
      return first.id;
    }
    return null;
  }

  vehicleView: 'overview' | 'table' = 'overview';

  kanbanSearch = '';
  groupDriverSearch = '';
  groupRouteSearch = '';
  selectedGroupSection: number | 'ungrouped' | 'inactive' = 'ungrouped';
  showGroupCreator = false;
  showGroupRoutePicker = false;
  savingGroupRoutes = false;
  pendingGroupRouteIds = new Set<number>();

  selectGroupSection(section: number | 'ungrouped' | 'inactive'): void {
    this.selectedGroupSection = section;
    this.showGroupRoutePicker = false;
    this.pendingGroupRouteIds.clear();
    this.groupRouteSearch = '';
    this.kanbanSearch = '';
    this.openDriverDropdownGroupId = null;
  }

  navigationGroups(v: CityVehicleRow): GroupRow[] {
    const query = this.groupSearch.trim().toLowerCase();
    return this.groupsForVehicle(v).filter((g) => g.name.toLowerCase().includes(query));
  }

  selectedOperationGroups(v: CityVehicleRow): GroupRow[] {
    return this.groupsForVehicle(v).filter((g) => g.id === this.selectedGroupSection);
  }

  filteredGroupDrivers(v: CityVehicleRow): DriverOpt[] {
    const query = this.groupDriverSearch.trim().toLowerCase();
    return this.driversForVehicle(v).filter((d) => `${d.name} ${d.phone || ''} ${d.vehicle_reg_no || ''}`.toLowerCase().includes(query));
  }

  groupRouteCandidates(v: CityVehicleRow): RouteLite[] {
    const query = this.groupRouteSearch.trim().toLowerCase();
    return this.ungroupedForVehicle(v).filter((r) => `${r.name} ${r.origin_name} ${r.dest_name}`.toLowerCase().includes(query));
  }

  togglePendingGroupRoute(id: number): void {
    if (this.pendingGroupRouteIds.has(id)) this.pendingGroupRouteIds.delete(id);
    else this.pendingGroupRouteIds.add(id);
  }

  addSelectedRoutesToGroup(v: CityVehicleRow, g: GroupRow): void {
    if (this.cityId == null || this.savingGroupRoutes) return;
    const selected = this.ungroupedForVehicle(v).filter((r) => this.pendingGroupRouteIds.has(r.id) && r.flat_fare != null);
    if (!selected.length) return;
    const routeIds = [...new Set([...g.route_ids, ...selected.map((r) => r.id)])];
    this.savingGroupRoutes = true;
    this.api.patch(`/admin/cities/${this.cityId}/route-groups/${g.id}`, { name: g.name, route_ids: routeIds }).subscribe({
      next: () => {
        this.savingGroupRoutes = false;
        g.route_ids = routeIds;
        if (this.selectedGroupSection === g.id) {
          this.pendingGroupRouteIds.clear();
          this.showGroupRoutePicker = false;
        }
        this.toast.success(`${selected.length} routes added to ${g.name}`);
        this.loadGroups();
      },
      error: (err) => {
        this.savingGroupRoutes = false;
        this.toast.error(err?.error?.message || 'Could not add routes. Please try again.');
      },
    });
  }
  openDriverDropdownGroupId: number | null = null;

  toggleGroupDriverDropdown(gId: number, ev?: Event): void {
    ev?.stopPropagation();
    this.groupDriverSearch = '';
    this.openDriverDropdownGroupId = this.openDriverDropdownGroupId === gId ? null : gId;
  }

  filterKanbanRoutes(routes: RouteLite[]): RouteLite[] {
    const q = this.kanbanSearch.trim().toLowerCase();
    if (!q) return routes;
    return routes.filter((r) =>
      (r.name || '').toLowerCase().includes(q) ||
      (r.origin_name || '').toLowerCase().includes(q) ||
      (r.dest_name || '').toLowerCase().includes(q)
    );
  }

  getOtherGroups(v: CityVehicleRow, currentGroupId: number): GroupRow[] {
    return this.groupsForVehicle(v).filter((g) => g.id !== currentGroupId);
  }

  onMoveSelectChange(fromGroup: GroupRow | null, ev: Event, routeId: number): void {
    const select = ev.target as HTMLSelectElement;
    const targetVal = select.value;
    select.value = '';

    if (!targetVal || this.cityId == null) return;

    if (targetVal === 'ungrouped') {
      if (fromGroup) {
        this.ungroupRoute(fromGroup, routeId);
      }
      return;
    }

    const targetGroupId = Number(targetVal);
    const targetGroup = this.groups.find((g) => g.id === targetGroupId);
    if (!targetGroup) return;

    if (fromGroup) {
      const newOldIds = fromGroup.route_ids.filter((id) => id !== routeId);
      const newTargetIds = [...targetGroup.route_ids.filter((id) => id !== routeId), routeId];
      
      this.api.patch(`/admin/cities/${this.cityId}/route-groups/${fromGroup.id}`, { name: fromGroup.name, route_ids: newOldIds }).subscribe({
        next: () => {
          fromGroup.route_ids = newOldIds;
          this.api.patch(`/admin/cities/${this.cityId}/route-groups/${targetGroup.id}`, { name: targetGroup.name, route_ids: newTargetIds }).subscribe({
            next: () => {
              targetGroup.route_ids = newTargetIds;
              this.toast.success(`Moved route to "${targetGroup.name}"`);
              this.onRouteMutation();
            },
            error: (err) => this.toast.error(err?.error?.message || 'Could not move route'),
          });
        },
        error: (err) => this.toast.error(err?.error?.message || 'Could not move route'),
      });
    } else {
      this.addRouteToGroup(targetGroup, routeId);
    }
  }

  draggingRouteId: number | null = null;
  draggingFromGroupId: number | null = null;
  dragOverColumnId: number | 'ungrouped' | null = null;

  onCardDragStart(ev: DragEvent, r: RouteLite, fromGroup: GroupRow | null): void {
    this.draggingRouteId = r.id;
    this.draggingFromGroupId = fromGroup ? fromGroup.id : null;
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', String(r.id));
    }
  }

  onCardDragEnd(): void {
    this.draggingRouteId = null;
    this.draggingFromGroupId = null;
    this.dragOverColumnId = null;
  }

  onColDragOver(ev: DragEvent, colId: number | 'ungrouped'): void {
    ev.preventDefault();
    if (ev.dataTransfer) {
      ev.dataTransfer.dropEffect = 'move';
    }
    this.dragOverColumnId = colId;
  }

  onColDragLeave(colId: number | 'ungrouped'): void {
    if (this.dragOverColumnId === colId) {
      this.dragOverColumnId = null;
    }
  }

  onColDrop(ev: DragEvent, targetGroup: GroupRow | null): void {
    ev.preventDefault();
    this.dragOverColumnId = null;

    const routeId = this.draggingRouteId;
    const fromGroupId = this.draggingFromGroupId;
    this.draggingRouteId = null;
    this.draggingFromGroupId = null;

    if (routeId == null || this.cityId == null) return;

    const fromGroup = fromGroupId != null ? (this.groups.find((g) => g.id === fromGroupId) ?? null) : null;

    // Dropped into the same group — do nothing
    if ((fromGroup?.id ?? null) === (targetGroup?.id ?? null)) {
      return;
    }

    if (fromGroup && targetGroup) {
      // 1. Moving between two groups (Optimistic 0ms update)
      const originalFromIds = [...fromGroup.route_ids];
      const originalTargetIds = [...targetGroup.route_ids];
      const newOldIds = fromGroup.route_ids.filter((id) => id !== routeId);
      const newTargetIds = [...targetGroup.route_ids.filter((id) => id !== routeId), routeId];

      fromGroup.route_ids = newOldIds;
      targetGroup.route_ids = newTargetIds;

      this.api.patch(`/admin/cities/${this.cityId}/route-groups/${fromGroup.id}`, { name: fromGroup.name, route_ids: newOldIds }).subscribe({
        next: () => {
          this.api.patch(`/admin/cities/${this.cityId}/route-groups/${targetGroup.id}`, { name: targetGroup.name, route_ids: newTargetIds }).subscribe({
            next: () => {
              this.toast.success(`Moved route to "${targetGroup.name}"`);
              this.onRouteMutation();
            },
            error: (err) => {
              fromGroup.route_ids = originalFromIds;
              targetGroup.route_ids = originalTargetIds;
              this.toast.error(err?.error?.message || 'Could not move route');
            },
          });
        },
        error: (err) => {
          fromGroup.route_ids = originalFromIds;
          targetGroup.route_ids = originalTargetIds;
          this.toast.error(err?.error?.message || 'Could not move route');
        },
      });
    } else if (fromGroup && !targetGroup) {
      // 2. Ungrouping (Optimistic 0ms update)
      const originalFromIds = [...fromGroup.route_ids];
      const newOldIds = fromGroup.route_ids.filter((id) => id !== routeId);
      fromGroup.route_ids = newOldIds;

      this.api.patch(`/admin/cities/${this.cityId}/route-groups/${fromGroup.id}`, { name: fromGroup.name, route_ids: newOldIds }).subscribe({
        next: () => {
          this.toast.success('Route removed from stand');
          this.onRouteMutation();
        },
        error: (err) => {
          fromGroup.route_ids = originalFromIds;
          this.toast.error(err?.error?.message || 'Could not remove route');
        },
      });
    } else if (!fromGroup && targetGroup) {
      // 3. Adding from Ungrouped to Group (Optimistic 0ms update)
      const originalTargetIds = [...targetGroup.route_ids];
      const newTargetIds = [...targetGroup.route_ids.filter((id) => id !== routeId), routeId];
      targetGroup.route_ids = newTargetIds;

      this.api.patch(`/admin/cities/${this.cityId}/route-groups/${targetGroup.id}`, { name: targetGroup.name, route_ids: newTargetIds }).subscribe({
        next: () => {
          this.toast.success(`Route added to "${targetGroup.name}"`);
          this.onRouteMutation();
        },
        error: (err) => {
          targetGroup.route_ids = originalTargetIds;
          this.toast.error(err?.error?.message || 'Could not add route to stand');
        },
      });
    }
  }

  deckViewMode: Record<number, 'commander' | 'all-routes'> = {};

  getDeckViewMode(v: CityVehicleRow): 'commander' | 'all-routes' {
    return this.deckViewMode[v.id] || 'commander';
  }

  setDeckViewMode(v: CityVehicleRow, mode: 'commander' | 'all-routes'): void {
    this.deckViewMode[v.id] = mode;
  }

  groupForRoute(r: RouteLite): GroupRow | null {
    return this.groups.find((g) => (g.route_ids || []).includes(r.id)) ?? null;
  }

  getActiveDeckGroup(v: CityVehicleRow): GroupRow | null {
    const gId = this.getActiveDeckGroupId(v);
    if (gId == null) return null;
    return this.groups.find((g) => g.id === gId) ?? null;
  }

  setActiveDeckGroup(v: CityVehicleRow, gId: number): void {
    this.activeDeckGroupId[v.id] = gId;
  }

  startInlineRename(g: GroupRow): void {
    this.renamingGroupId = g.id;
    this.renameValue = g.name;
  }

  saveInlineRename(g: GroupRow): void {
    const name = this.renameValue.trim();
    if (!name || this.cityId == null) {
      this.renamingGroupId = null;
      return;
    }
    this.api.patch(`/admin/cities/${this.cityId}/route-groups/${g.id}`, { name, route_ids: g.route_ids }).subscribe({
      next: () => {
        g.name = name;
        this.renamingGroupId = null;
        this.toast.success(`Stand renamed to "${name}"`);
        this.onRouteMutation();
      },
      error: (err) => {
        this.renamingGroupId = null;
        this.toast.error(err?.error?.message || 'Could not rename stand');
      },
    });
  }

  quickCreateInlineGroup(v: CityVehicleRow): void {
    const name = (this.inlineNewGroupName[v.id] || '').trim();
    if (!name || this.cityId == null || this.isCreatingInlineGroup) return;

    this.isCreatingInlineGroup = true;
    this.api.post<{ group: GroupRow }>(`/admin/cities/${this.cityId}/route-groups`, {
      name,
      city_vehicle_type_id: v.id,
    }).subscribe({
      next: (res) => {
        this.isCreatingInlineGroup = false;
        this.inlineNewGroupName[v.id] = '';
        this.showGroupCreator = false;
        this.routeView = 'groups';
        this.groupSearch = '';
        this.kanbanSearch = '';
        this.toast.success(`Stand "${name}" created`);
        if (res?.group?.id) {
          this.activeDeckGroupId[v.id] = res.group.id;
          this.groups = [...this.groups.filter((g) => g.id !== res.group.id), { ...res.group, route_ids: res.group.route_ids ?? [], driver_user_ids: res.group.driver_user_ids ?? [] }];
          this.selectGroupSection(res.group.id);
          this.showGroupRoutePicker = true;
        }
        this.onRouteMutation();
      },
      error: (err) => {
        this.isCreatingInlineGroup = false;
        this.toast.error(err?.error?.message || 'Could not create stand');
      },
    });
  }

  triggerKmlImportFor(v: CityVehicleRow): void {
    this.select(v);
    this.triggerKmlImportFromTop();
  }







  syncingDriverId: number | null = null;
  driverFleetSearch = '';
  driverFleetFilter: 'all' | 'assigned' | 'unassigned' = 'all';

  operationsDrawerOpen = false;
  operationsDrawerVehicle: CityVehicleRow | null = null;
  activeDrawerTab: 'groups' | 'all-routes' | 'drivers' = 'groups';

  openOperationsDrawer(v: CityVehicleRow, tab: 'groups' | 'all-routes' | 'drivers' = 'groups', ev?: Event): void {
    ev?.stopPropagation();
    this.select(v);
    this.operationsDrawerVehicle = v;
    this.activeDrawerTab = tab;
    this.groupSearch = '';
    this.showGroupCreator = false;
    this.selectGroupSection(this.groupsForVehicle(v)[0]?.id ?? 'ungrouped');
    if (tab === 'drivers' && typeof this.selectedGroupSection === 'number') this.openDriverDropdownGroupId = this.selectedGroupSection;
    this.routeView = tab === 'all-routes' ? 'all' : 'groups';
    this.routeStatusFilter = 'all';
    this.kanbanSearch = '';
    this.operationsDrawerOpen = true;
  }

  closeOperationsDrawer(): void {
    this.operationsDrawerOpen = false;
  }

  onRowClick(v: CityVehicleRow, ev: MouseEvent): void {
    const target = ev.target as HTMLElement;
    if (target.closest('.chk') || target.closest('.kebab') || target.closest('.farelink') || target.closest('.linkcell') || target.closest('.cin') || target.closest('.pill') || target.closest('.gchip') || target.closest('.drv-cell-btn')) {
      return;
    }
    this.openOperationsDrawer(v, 'groups', ev);
  }

  openUnifiedGroupDrawer(v: CityVehicleRow, g?: GroupRow): void {
    this.select(v);
    this.operationsDrawerVehicle = v;
    this.activeDrawerTab = 'groups';
    this.groupSearch = '';
    this.selectGroupSection(g?.id ?? this.groupsForVehicle(v)[0]?.id ?? 'ungrouped');
    this.routeView = 'groups';
    this.kanbanSearch = '';
    if (g) {
      this.activeDeckGroupId[v.id] = g.id;
    }
    this.operationsDrawerOpen = true;
  }

  openDriverFleetDrawer(v: CityVehicleRow, ev?: Event): void {
    ev?.stopPropagation();
    this.select(v);
    this.operationsDrawerVehicle = v;
    this.activeDrawerTab = 'drivers';
    this.groupSearch = '';
    this.selectGroupSection(this.groupsForVehicle(v)[0]?.id ?? 'ungrouped');
    if (typeof this.selectedGroupSection === 'number') this.openDriverDropdownGroupId = this.selectedGroupSection;
    this.routeView = 'groups';
    this.kanbanSearch = '';
    this.operationsDrawerOpen = true;
  }

  driversForVehicle(v: CityVehicleRow): DriverOpt[] {
    const vId = Number(v.id);
    return this.cityDrivers.filter((d) =>
      d.city_vehicle_type_id === vId ||
      (d.vehicle_type_id != null && d.vehicle_type_id === v.vehicle_type_id)
    );
  }

  isDriverInGroup(userId: number, groupId: number): boolean {
    const g = this.groups.find((x) => x.id === groupId);
    return !!g?.driver_user_ids?.includes(userId);
  }

  getDriverAssignedGroups(userId: number, v: CityVehicleRow): GroupRow[] {
    const vGroups = this.groupsForVehicle(v);
    return vGroups.filter((g) => (g.driver_user_ids ?? []).includes(userId));
  }

  assignedDriversForVehicle(v: CityVehicleRow): DriverOpt[] {
    const vGroups = this.groupsForVehicle(v);
    const assignedUserIds = new Set(vGroups.flatMap((g) => g.driver_user_ids ?? []));
    return this.driversForVehicle(v).filter((d) => assignedUserIds.has(d.user_id));
  }

  assignedDriverCountFor(v: CityVehicleRow): number {
    return this.assignedDriversForVehicle(v).length;
  }

  filteredFleetDrivers(v: CityVehicleRow): DriverOpt[] {
    const q = this.driverFleetSearch.trim().toLowerCase();
    let list = this.driversForVehicle(v);
    if (this.driverFleetFilter === 'assigned') {
      list = list.filter((d) => this.getDriverAssignedGroups(d.user_id, v).length > 0);
    } else if (this.driverFleetFilter === 'unassigned') {
      list = list.filter((d) => this.getDriverAssignedGroups(d.user_id, v).length === 0);
    }
    if (!q) return list;
    return list.filter((d) =>
      (d.name || '').toLowerCase().includes(q) ||
      (d.phone || '').toLowerCase().includes(q) ||
      (d.vehicle_reg_no || '').toLowerCase().includes(q)
    );
  }

  toggleDriverGroup(d: DriverOpt, g: GroupRow, v: CityVehicleRow): void {
    if (this.cityId == null || this.syncingDriverId === d.user_id) return;
    this.syncingDriverId = d.user_id;

    const currentIds = g.driver_user_ids ?? [];
    const isCurrentlyIn = currentIds.includes(d.user_id);
    const updatedIds = isCurrentlyIn
      ? currentIds.filter((id) => id !== d.user_id)
      : [...currentIds, d.user_id];

    g.driver_user_ids = updatedIds;

    this.api.put(`/admin/cities/${this.cityId}/route-groups/${g.id}/drivers`, {
      driver_user_ids: updatedIds,
    }).subscribe({
      next: () => {
        this.syncingDriverId = null;
        if (isCurrentlyIn) {
          this.toast.success(`Removed "${d.name}" from "${g.name}"`);
        } else {
          this.toast.success(`Assigned "${d.name}" to "${g.name}"`);
        }
        this.onRouteMutation();
      },
      error: (err) => {
        this.syncingDriverId = null;
        this.toast.error(err?.error?.message || 'Failed to update stand drivers');
        this.onRouteMutation();
      },
    });
  }

  assignDriverToAllGroups(d: DriverOpt, v: CityVehicleRow): void {
    if (this.cityId == null || this.syncingDriverId === d.user_id) return;
    const vGroups = this.groupsForVehicle(v);
    const needed = vGroups.filter((g) => !(g.driver_user_ids ?? []).includes(d.user_id));
    if (!needed.length) return;

    this.syncingDriverId = d.user_id;
    const requests = needed.map((g) => {
      const updatedIds = Array.from(new Set([...(g.driver_user_ids ?? []), d.user_id]));
      g.driver_user_ids = updatedIds;
      return this.api.put(`/admin/cities/${this.cityId}/route-groups/${g.id}/drivers`, {
        driver_user_ids: updatedIds,
      });
    });

    forkJoin(requests).subscribe({
      next: () => {
        this.syncingDriverId = null;
        this.toast.success(`Assigned "${d.name}" to all stands`);
        this.onRouteMutation();
      },
      error: (err) => {
        this.syncingDriverId = null;
        this.toast.error(err?.error?.message || 'Failed to assign driver to all stands');
        this.onRouteMutation();
      },
    });
  }

  unassignDriverFromAllGroups(d: DriverOpt, v: CityVehicleRow): void {
    if (this.cityId == null || this.syncingDriverId === d.user_id) return;
    const vGroups = this.groupsForVehicle(v);
    const assigned = vGroups.filter((g) => (g.driver_user_ids ?? []).includes(d.user_id));
    if (!assigned.length) return;

    this.syncingDriverId = d.user_id;
    const requests = assigned.map((g) => {
      const updatedIds = (g.driver_user_ids ?? []).filter((id) => id !== d.user_id);
      g.driver_user_ids = updatedIds;
      return this.api.put(`/admin/cities/${this.cityId}/route-groups/${g.id}/drivers`, {
        driver_user_ids: updatedIds,
      });
    });

    forkJoin(requests).subscribe({
      next: () => {
        this.syncingDriverId = null;
        this.toast.success(`Removed "${d.name}" from all stands`);
        this.onRouteMutation();
      },
      error: (err) => {
        this.syncingDriverId = null;
        this.toast.error(err?.error?.message || 'Failed to unassign driver');
        this.onRouteMutation();
      },
    });
  }

  quickAssignRoute(routeId: number, event: Event): void {
    const select = event.target as HTMLSelectElement;
    const groupId = Number(select.value);
    if (!groupId) return;
    const g = this.groups.find((x) => x.id === groupId);
    if (!g) return;
    this.assignRouteToGroup(routeId, g);
    select.value = '';
  }

  // Route-group pickers now open as side drawers. Each holds the id of its
  // target so the drawer content stays live across a reload (the group/route
  // objects are replaced on every load; ids are stable).
  driverDrawerId: number | null = null;
  routeDrawerId: number | null = null;
  assignDrawerRouteId: number | null = null;
  movePickFor: number | null = null;
  savingDriverId: number | null = null;
  /** Staged driver selection for the group-drivers drawer (committed on Save). */
  pendingDriverIds: number[] = [];
  savingGroupDrivers = false;

  get driverDrawerGroup(): GroupRow | null { return this.groups.find((g) => g.id === this.driverDrawerId) ?? null; }
  get routeDrawerGroup(): GroupRow | null { return this.groups.find((g) => g.id === this.routeDrawerId) ?? null; }
  get assignDrawerRoute(): RouteLite | null { return this.routes.find((r) => r.id === this.assignDrawerRouteId) ?? null; }

  get routesForRouteDrawer(): RouteLite[] {
    const g = this.routeDrawerGroup;
    if (!g) return [];
    const sampleRoute = this.routes.find((r) => g.route_ids.includes(r.id));
    const vehicleId = sampleRoute?.city_vehicle_type_id ?? this.selectedId;
    const vRoutes = vehicleId
      ? this.routes.filter((r) => r.city_vehicle_type_id === vehicleId)
      : this.routes;
    const alreadyInThisGroup = new Set<number>(g.route_ids);
    return vRoutes.filter((r) => !alreadyInThisGroup.has(r.id));
  }

  private subs: Subscription[] = [];
  private deepLinkId: number | null = null;
  /** Guards against the city stream re-emitting the same id and refetching. */
  private loadedCityId: number | null = null;

  constructor(
    private api: ApiService,
    private cityCtx: CityContextService,
    private toast: ToastService,
    private router: Router,
    private route: ActivatedRoute,
    private layoutsSvc: VehicleSeatLayoutsService,
  ) {}

  ngOnInit(): void {
    this.cityCtx.ensureCitiesLoaded().subscribe();
    this.subs.push(
      this.route.paramMap.subscribe((p) => {
        const raw = p.get('vehicleRowId');
        this.deepLinkId = raw ? Number(raw) : null;
        if (this.deepLinkId != null && this.vehicles.length) { this.applyDeepLink(); this.applyView(); }
      }),
      this.cityCtx.cities$.subscribe((list) => {
        this.allCities = list ?? [];
        this.cityName = list.find((c) => c.id === this.cityId)?.name ?? '';
      }),
      this.cityCtx.cityId$.subscribe((id) => {
        this.cityId = id;
        this.cityName = this.allCities.find(city => city.id === id)?.name ?? '';
        if (id == null) { this.loadedCityId = null; this.resetData(); return; }
        if (id === this.loadedCityId) return;
        this.loadedCityId = id;
        this.selectedId = null;
        this.resetData();
        this.load();
      }),
    );
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
  }

  // ── loading ────────────────────────────────────────────────
  /**
   * Staged load. The vehicle list is the only thing the page waits on; the
   * five supporting requests fire alongside it and patch their own slice in
   * when they land, so the list is usable while they're still arriving.
   */
  private load(): void {
    const cityId = this.cityId;
    if (cityId == null) return;

    this.loading = true;
    this.supportErrors.delete('vehicles');
    this.api.get<{
      data: CityVehicleRow[];
      available_ride_types?: RideTypeRef[];
      available_vehicle_types?: VehicleTypeRef[];
    }>(`/admin/cities/${cityId}/vehicle-types`).subscribe({
      next: (res) => {
        if (this.cityId !== cityId) return;
        this.rows = res.data ?? [];
        this.rideTypes = res.available_ride_types ?? [];
        this.vehicleTypeOptions = res.available_vehicle_types ?? [];
        this.vehicles = this.groupRows(this.rows);
        this.loading = false;
        this.applyDeepLink();
        this.applyView();
      },
      error: () => { if (this.cityId !== cityId) return; this.loading = false; this.supportErrors.add('vehicles'); this.toast.error('Failed to load vehicles'); },
    });

    this.api.get<{ data: VehicleTypeRow[] }>('/admin/vehicle-types-global').subscribe({
      next: (res) => { this.types = res.data ?? []; },
      error: () => { this.types = []; },
    });
    this.layoutsSvc.list(cityId).subscribe({
      next: (res) => { if (this.cityId !== cityId) return; this.layouts = res.data ?? []; this.recompute(); },
      error: () => { if (this.cityId !== cityId) return; this.layouts = []; },
    });
    this.loadRoutes();
    this.loadGroups();
    this.loadDrivers();
    this.supportLoading.add('sets'); this.supportErrors.delete('sets');
    this.api.get<{ data: SetupVehicleSet[] }>(`/admin/cities/${cityId}/vehicle-sets`).subscribe({
      next: res => { if (this.cityId === cityId) { this.supportLoading.delete('sets'); this.vehicleSets = res.data ?? []; } },
      error: () => { if (this.cityId === cityId) { this.supportLoading.delete('sets'); this.supportErrors.add('sets'); this.vehicleSets = []; } },
    });
  }

  /** Full reload after a mutation. Same staging as the initial load. */
  refresh(): void { this.load(); }
  vehicleSetsOpen = false;
  vehicleSets: SetupVehicleSet[] = [];
  supportLoading = new Set<string>();
  supportErrors = new Set<string>();
  get operationsLoading(): boolean { return this.loading || this.supportLoading.size > 0; }
  get operationsLoadError(): string { return this.supportErrors.size ? 'Some workspace information could not be loaded. Refresh to try again before making changes.' : ''; }

  private resetData(): void {
    this.supportLoading.clear(); this.supportErrors.clear();
    this.vehicleSetsOpen = false;
    this.vehicleSets = [];
    this.masterEditGroupId = null;
    this.rows = []; this.vehicles = []; this.visible = [];
    this.routes = []; this.groups = []; this.cityDrivers = []; this.layouts = [];
    this.selectedId = null; this.recompute();
  }

  loadRoutes(): void {
    const cityId = this.cityId;
    if (cityId == null) { this.routes = []; return; }
    this.supportLoading.add('routes'); this.supportErrors.delete('routes');
    this.api.get<{ data: RouteLite[] }>(`/admin/cities/${cityId}/fixed-routes`).subscribe({
      next: (res) => { if (this.cityId !== cityId) return; this.supportLoading.delete('routes'); this.routes = res?.data ?? []; this.recompute(); },
      error: () => { if (this.cityId !== cityId) return; this.supportLoading.delete('routes'); this.supportErrors.add('routes'); this.routes = []; },
    });
  }

  loadGroups(): void {
    const cityId = this.cityId;
    if (cityId == null) { this.groups = []; return; }
    this.supportLoading.add('groups'); this.supportErrors.delete('groups');
    this.api.get<{ data: GroupRow[] }>(`/admin/cities/${cityId}/route-groups`).subscribe({
      next: (res) => {
        if (this.cityId !== cityId) return;
        this.supportLoading.delete('groups');
        this.groups = (res?.data ?? []).map((g) => ({ ...g, route_ids: [...(g.route_ids ?? [])], driver_user_ids: [...(g.driver_user_ids ?? [])] }));
        this.recompute();
      },
      error: () => { if (this.cityId !== cityId) return; this.supportLoading.delete('groups'); this.supportErrors.add('groups'); this.groups = []; },
    });
  }

  loadDrivers(): void {
    const cityId = this.cityId;
    if (cityId == null) { this.cityDrivers = []; return; }
    this.supportLoading.add('drivers'); this.supportErrors.delete('drivers');
    this.api.get<{ data: DriverOpt[] }>(`/admin/cities/${cityId}/route-group-drivers`).subscribe({
      next: (res) => { if (this.cityId !== cityId) return; this.supportLoading.delete('drivers'); this.cityDrivers = res?.data ?? []; this.recompute(); },
      error: () => { if (this.cityId !== cityId) return; this.supportLoading.delete('drivers'); this.supportErrors.add('drivers'); this.cityDrivers = []; },
    });
  }

  onRouteMutation(): void {
    this.loadRoutes();
    this.loadGroups();
    this.loadDrivers();
    const cityId = this.cityId;
    if (cityId != null) {
      this.api.get<{
        data: CityVehicleRow[];
        available_ride_types?: RideTypeRef[];
        available_vehicle_types?: VehicleTypeRef[];
      }>(`/admin/cities/${cityId}/vehicle-types`).subscribe({
        next: (res) => {
          if (this.cityId !== cityId) return;
          this.rows = res.data ?? [];
          this.vehicles = this.groupRows(this.rows);
          this.recompute();
        },
      });
    }
  }

  private applyDeepLink(): void {
    if (this.deepLinkId == null) return;
    const raw = this.rows.find((r) => r.id === this.deepLinkId);
    if (!raw) return;
    const key = this.groupKey(raw);
    const match = this.vehicles.find((v) => this.groupKey(v) === key);
    if (match) this.selectedId = match.id;
    this.deepLinkId = null;
  }

  // ── filtering & derived state ──────────────────────────────
  applyView(): void {
    const q = this.search.trim().toLowerCase();
    this.visible = this.vehicles.filter((v) => {
      if (this.status === 'enabled' && !v.is_active) return false;
      if (this.status === 'disabled' && v.is_active) return false;
      if (this.typeFilter !== 'all' && v.vehicle_type_id !== Number(this.typeFilter)) return false;
      if (this.vehicleFilter !== 'all' && v.display_name !== this.vehicleFilter) return false;
      if (!q) return true;
      return `${v.display_name} ${v.vehicle_type_name ?? ''} ${this.fareModesLabel(v)}`.toLowerCase().includes(q);
    });

    if (this.selectedId != null && !this.vehicles.some((v) => v.id === this.selectedId)) {
      this.selectedId = null;
    }
    this.recompute();
  }

  setStatus(value: CityVehicleStatus): void { this.status = value; this.applyView(); }

  // ── custom filter dropdowns (match the Drivers page's state-select) ─────────
  get typeFilterLabel(): string {
    if (this.typeFilter === 'all') return 'All types';
    return this.types.find((t) => String(t.id) === this.typeFilter)?.name ?? 'All types';
  }
  get vehicleFilterLabel(): string { return this.vehicleFilter === 'all' ? 'All vehicles' : this.vehicleFilter; }

  toggleFilter(which: 'type' | 'vehicle', ev: Event): void {
    ev.stopPropagation();
    this.menuId = null;
    this.filterOpen = this.filterOpen === which ? null : which;
  }
  setTypeFilter(value: string): void { this.typeFilter = value; this.filterOpen = null; this.applyView(); }
  setVehicleFilter(value: string): void { this.vehicleFilter = value; this.filterOpen = null; this.applyView(); }

  /** True when any of search / status / type / vehicle is narrowing the list. */
  get hasActiveFilters(): boolean {
    return this.search.trim() !== '' || this.status !== 'all' || this.typeFilter !== 'all' || this.vehicleFilter !== 'all';
  }
  /** Reset every filter to its default and re-render the full list. */
  clearAllFilters(): void {
    this.search = '';
    this.status = 'all';
    this.typeFilter = 'all';
    this.vehicleFilter = 'all';
    this.filterOpen = null;
    this.applyView();
  }

  /** Close the open filter dropdown on any outside click. */
  @HostListener('document:click')
  onDocumentClick(): void { this.filterOpen = null; }

  /** Rebuilds every per-selection slice in one pass. */
  private recompute(): void {
    const v = this.vehicles.find((x) => x.id === this.selectedId) ?? null;
    this.selected = v;

    const covered = new Set<number>(this.groups.flatMap((g) => g.route_ids));
    this.ungrouped = this.routes.filter((r) => !covered.has(r.id));

    if (!v) {
      this.tabList = []; this.activeRideType = null; this.activeRow = null;
      this.selDrivers = []; this.otherDrivers = []; this.selLayouts = []; this.selGroups = [];
      this.applyGroupView();
      return;
    }

    const myRoutes = this.routes.filter((r) => r.city_vehicle_type_id === v.id);
    const myRouteIds = new Set(myRoutes.map((r) => r.id));
    this.selGroups = this.groups.filter((g) => g.route_ids.some((id) => myRouteIds.has(id)));
    this.applyGroupView();
    this.selDrivers = this.cityDrivers.filter((d) => d.city_vehicle_type_id === v.id);
    this.otherDrivers = this.cityDrivers.filter((d) =>
      d.city_vehicle_type_id !== v.id && (d.vehicle_type_id == null || d.vehicle_type_id === v.vehicle_type_id));
    this.selLayouts = v.vehicle_type_id == null ? [] : this.layouts.filter((l) => l.vehicle_type_id === v.vehicle_type_id);

    // Tabs: one per ride type using its DB name, then Seat layouts. (Common
    // setup moved to a per-row drawer opened by the pen icon in the list.)
    this.tabList = [
      ...this.rideTypes.map((rt) => ({
        key: 'mode:' + rt.id,
        label: rt.name,
        count: this.kindOf(rt.name) === 'fixed' ? myRoutes.length : undefined,
      })),
      { key: 'layouts', label: 'Seat layouts', count: this.selLayouts.length },
    ];

    // A tab remembered for this vehicle may no longer exist (ride type removed).
    if (!this.tabList.some((t) => t.key === this.tab)) this.tab = this.tabList[0]?.key ?? '';

    this.syncActiveMode();
  }

  /** Filter + page the route groups for the current search and page. */
  private applyGroupView(): void {
    const q = this.groupSearch.trim().toLowerCase();
    this.filteredGroups = q
      ? this.selGroups.filter((g) => g.name.toLowerCase().includes(q))
      : this.selGroups;

    this.groupPages = Math.max(1, Math.ceil(this.filteredGroups.length / this.groupPageSize));
    if (this.groupPage > this.groupPages) this.groupPage = this.groupPages;
    const start = (this.groupPage - 1) * this.groupPageSize;
    this.pagedGroups = this.filteredGroups.slice(start, start + this.groupPageSize);
  }

  onGroupSearch(): void { this.groupPage = 1; this.applyGroupView(); }
  setGroupPage(p: number): void { this.groupPage = Math.min(Math.max(1, p), this.groupPages); this.applyGroupView(); }

  /** Resolves the currently open ride-type tab into the row that backs it. */
  private syncActiveMode(): void {
    if (!this.tab.startsWith('mode:') || !this.selected) {
      this.activeRideType = null; this.activeRow = null; this.activeIsFixed = false;
      return;
    }
    const id = Number(this.tab.slice(5));
    this.activeRideType = this.rideTypes.find((rt) => rt.id === id) ?? null;
    if (!this.activeRideType) { this.activeRow = null; this.activeIsFixed = false; return; }

    this.activeKind = this.kindOf(this.activeRideType.name);
    this.activeIsFixed = this.activeKind === 'fixed';
    const key = this.groupKey(this.selected);
    this.activeRow = this.rows.find((r) => this.groupKey(r) === key && r.ride_type_id === id) ?? null;
    this.reverseBidding = !!this.activeRow?.reverse_bidding_enabled;
    this.fareSubtitle = this.activeKind === 'shuttle'
      ? ''
      : 'Fare card used by the current customer and driver flow.';

    // A non-fixed ride type with no fare row yet: create it automatically so the
    // fare form is shown directly instead of a "create fare" button. Guarded so
    // it runs at most once per vehicle+ride-type and never while data is loading.
    if (!this.activeIsFixed && !this.activeRow && !this.loading && this.creatingRideTypeId == null) {
      const attemptKey = key + ':' + id;
      if (!this.autoFareAttempted.has(attemptKey)) {
        this.autoFareAttempted.add(attemptKey);
        this.createFareSetup(this.activeRideType, true);
      }
    }
  }

  select(v: CityVehicleRow): void {
    this.selectedId = v.id;
    this.mobileEditor = true;
    this.driverDrawerId = null;
    this.routeDrawerId = null;
    this.assignDrawerRouteId = null;
    this.movePickFor = null;
    this.renamingId = null;
    this.tab = this.tabByVehicle.get(v.id) ?? '';
    this.loadSelectedForms();
    this.recompute();
  }

  setTab(key: string): void {
    this.tab = key;
    if (this.selectedId != null) this.tabByVehicle.set(this.selectedId, key);
    this.syncActiveMode();
  }

  trackVehicle = (_: number, v: CityVehicleRow) => v.id;
  trackGroup = (_: number, g: GroupRow) => g.id;
  trackTab = (_: number, t: TabDef) => t.key;

  private loadSelectedForms(): void {
    const v = this.vehicles.find((x) => x.id === this.selectedId) ?? null;
    this.common = v
      ? { display_name: v.display_name, max_people: v.max_people, luggage_capacity: v.luggage_capacity, is_active: !!v.is_active }
      : { display_name: '', max_people: 1, luggage_capacity: 0, is_active: true };
  }

  // ── labels & lookups ───────────────────────────────────────
  /** Behaviour only. Every label the operator sees is the database's own name. */
  private kindOf(name: string | null): ModeKind {
    const lower = (name ?? '').toLowerCase();
    if (lower.includes('shuttle')) return 'shuttle';
    if (lower.includes('fixed')) return 'fixed';
    return 'private';
  }

  fareModesLabel(row: CityVehicleRow): string {
    const ids = row.mode_ids ?? [];
    const names = this.rideTypes.filter((rt) => ids.includes(rt.id)).map((rt) => rt.name);
    return names.length ? names.join(', ') : 'Not configured';
  }

  driverCountLabel(v: CityVehicleRow): string {
    const n = this.cityDrivers.filter((d) => d.city_vehicle_type_id === v.id).length;
    return n ? ` · ${n} ${n === 1 ? 'driver' : 'drivers'}` : '';
  }

  initials(name: string): string {
    return (name || '?').split(' ').filter(Boolean).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  }

  moveTargetsFor(d: DriverOpt): CityVehicleRow[] {
    return this.vehicles.filter((v) =>
      v.id !== d.city_vehicle_type_id && (d.vehicle_type_id == null || v.vehicle_type_id === d.vehicle_type_id));
  }

  carLabel(d: DriverOpt): string {
    if (d.city_vehicle_type_id == null) return 'No car set';
    const v = this.vehicles.find((x) => x.id === d.city_vehicle_type_id)
      ?? this.rows.find((x) => x.id === d.city_vehicle_type_id);
    return v ? `Car: ${v.display_name}` : 'Car set elsewhere';
  }

  // ── common setup ───────────────────────────────────────────
  /**
   * Opens the common-setup drawer for a vehicle straight from the list pen icon.
   * Selects the vehicle first so `common` and the sibling set `saveCommon` patches
   * are loaded, then shows the drawer. Stops the click from also toggling the row.
   */
  openCommonDrawer(v: CityVehicleRow, ev?: Event): void {
    ev?.stopPropagation();
    this.select(v);
    this.commonDrawerVehicle = v;
    this.commonDrawerOpen = true;
  }

  closeCommonDrawer(): void {
    this.commonDrawerOpen = false;
    this.commonDrawerVehicle = null;
  }

  saveCommon(): void {
    const v = this.selected;
    if (!v || this.cityId == null || this.savingCommon) return;
    const payload = {
      display_name: this.common.display_name.trim(),
      max_people: this.common.max_people,
      luggage_capacity: this.common.luggage_capacity,
      is_active: this.common.is_active,
    };
    const key = this.groupKey(v);
    const siblings = this.rows.filter((r) => this.groupKey(r) === key);
    this.savingCommon = true;
    forkJoin(siblings.map((r) => this.api.patch(`/admin/cities/${this.cityId}/vehicle-types/${r.id}`, payload))).subscribe({
      next: () => { this.savingCommon = false; this.commonDrawerOpen = false; this.commonDrawerVehicle = null; this.toast.success('City vehicle saved'); this.load(); },
      error: (err) => { this.savingCommon = false; this.toast.error(err?.error?.message || 'Failed to save city vehicle'); },
    });
  }

  /**
   * Enable / disable the vehicle straight from the header. Persists immediately
   * (no Save needed) by patching is_active on every mode row that shares this
   * name + type, the same set Save touches. Optimistic: the pill flips at once
   * and rolls back on error.
   */
  toggleActive(): void {
    const v = this.selected;
    if (!v || this.cityId == null || this.savingActive) return;
    const next = !v.is_active;
    const key = this.groupKey(v);
    const siblings = this.rows.filter((r) => this.groupKey(r) === key);

    this.savingActive = true;
    v.is_active = next;
    this.common.is_active = next;
    forkJoin(siblings.map((r) => this.api.patch(`/admin/cities/${this.cityId}/vehicle-types/${r.id}`, { is_active: next }))).subscribe({
      next: () => {
        this.savingActive = false;
        this.toast.success(next ? `${v.display_name} enabled` : `${v.display_name} disabled`);
        this.load();
      },
      error: (err) => {
        this.savingActive = false;
        v.is_active = !next;
        this.common.is_active = !next;
        this.toast.error(err?.error?.message || 'Could not update availability');
      },
    });
  }

  saveUniqueFields(): void {
    if (!this.activeRow || this.cityId == null || this.savingUnique) return;
    this.savingUnique = true;
    this.api.patch(`/admin/cities/${this.cityId}/vehicle-types/${this.activeRow.id}`, {
      reverse_bidding_enabled: this.reverseBidding,
    }).subscribe({
      next: () => { this.savingUnique = false; this.toast.success('Unique fields saved'); this.load(); },
      error: (err) => { this.savingUnique = false; this.toast.error(err?.error?.message || 'Failed to save unique fields'); },
    });
  }

  /**
   * Creates the fare row for the open ride-type tab. The id comes straight from
   * the tab, so this can never fail on a missing ride type — the tab only
   * exists because the row does.
   */
  createFareSetup(rt: RideTypeRef, silent = false): void {
    const v = this.selected;
    if (!v || this.cityId == null || this.creatingRideTypeId != null) return;
    this.creatingRideTypeId = rt.id;
    this.api.post<{ vehicle_type: CityVehicleRow; message?: string }>(`/admin/cities/${this.cityId}/vehicle-types`, {
      ride_type_id: rt.id,
      vehicle_type_id: v.vehicle_type_id,
      vehicle_set_id: v.vehicle_set_id ?? (v.vehicle_set_ids?.length === 1 ? v.vehicle_set_ids[0] : null),
      display_name: v.display_name,
      max_people: v.max_people,
      luggage_capacity: v.luggage_capacity,
      reverse_bidding_enabled: this.kindOf(rt.name) === 'private' ? !!v.reverse_bidding_enabled : false,
    }).subscribe({
      next: (res) => {
        this.creatingRideTypeId = null;
        if (!silent) this.toast.success(res.message || `${rt.name} fare setup created`);
        this.load();
      },
      error: (err) => {
        this.creatingRideTypeId = null;
        this.toast.error(err?.error?.message || `Failed to create ${rt.name} fare setup`);
      },
    });
  }

  // ── add vehicle ────────────────────────────────────────────
  openCreate(): void { this.create = this.blankCreate(); this.createOpen = true; }

  get createValid(): boolean {
    return (this.create.vehicle_type_id === -1 ? !!this.create.vehicle_type_name.trim() : this.create.vehicle_type_id != null) && !!this.createDisplayName;
  }
  get createDisplayName(): string { return this.create.display_name.trim() || (this.create.vehicle_type_id === -1 ? this.create.vehicle_type_name.trim() : this.vehicleTypeOptions.find(type => type.id === this.create.vehicle_type_id)?.name ?? ''); }

  submitCreate(): void {
    if (!this.createValid || this.creating || this.cityId == null) return;
    this.creating = true;
    this.api.post<{ vehicle_type: CityVehicleRow }>(`/admin/cities/${this.cityId}/vehicle-types`, {
      vehicle_type_id: this.create.vehicle_type_id === -1 ? null : this.create.vehicle_type_id,
      vehicle_type_name: this.create.vehicle_type_id === -1 ? this.create.vehicle_type_name.trim() : null,
      vehicle_set_id: this.create.vehicle_set_id,
      display_name: this.createDisplayName,
      max_people: this.create.max_people,
      luggage_capacity: this.create.luggage_capacity,
      is_active: true,
    }).subscribe({
      next: (res) => {
        this.creating = false;
        this.createOpen = false;
        this.selectedId = res?.vehicle_type?.id ?? this.selectedId;
        this.toast.success('City vehicle created');
        this.load();
      },
      error: (err) => { this.creating = false; this.toast.error(err?.error?.message || 'Failed to create city vehicle'); },
    });
  }

  // ── global vehicle types ───────────────────────────────────
  openTypes(): void { this.resetTypeForm(); this.typesOpen = true; }
  startEditType(t: VehicleTypeRow): void { this.editingTypeId = t.id; this.typeForm = { name: t.name, is_active: t.is_active }; }
  resetTypeForm(): void { this.editingTypeId = null; this.typeForm = { name: '', is_active: true }; }

  saveType(): void {
    if (!this.typeForm.name.trim() || this.typeSaving) return;
    this.typeSaving = true;
    const payload: { name: string; is_active?: boolean } = { name: this.typeForm.name.trim() };
    if (this.editingTypeId) payload.is_active = this.typeForm.is_active;
    const req = this.editingTypeId
      ? this.api.patch(`/admin/vehicle-types-global/${this.editingTypeId}`, payload)
      : this.api.post('/admin/vehicle-types-global', payload);
    req.subscribe({
      next: () => {
        this.typeSaving = false;
        this.toast.success(this.editingTypeId ? 'Vehicle type updated' : 'Vehicle type created');
        this.resetTypeForm();
        this.load();
      },
      error: (err) => { this.typeSaving = false; this.toast.error(err?.error?.message || 'Failed to save vehicle type'); },
    });
  }

  // ── fixed routes ───────────────────────────────────────────
  newRoute(): void { this.fixedRoutes?.openCreate(); }

  /** Opens the map editor for a route shown in a group card.
   *  Accepts either a `RouteLite` or a numeric id; optional MouseEvent stops propagation.
   */
  editRoute(arg: RouteLite | number, ev?: MouseEvent): void {
    ev?.stopPropagation();
    const id = typeof arg === 'number' ? arg : arg.id;
    this.fixedRoutes?.openEditById(id);
  }

  /** A route can only join a group once it has a price. Warns + blocks otherwise —
   *  an unpriced route ("Needs pricing") can't be run, so it isn't assignable yet. */
  private routeIsGroupable(routeId: number): boolean {
    const r = this.routes.find((x) => x.id === routeId);
    if (r && r.flat_fare == null) {
      this.toast.warning(`“${r.name}” isn’t assignable yet — add a price to the route first.`);
      return false;
    }
    return true;
  }

  /** Assign an ungrouped route into an existing group from the holding card.
   *  The route leaves the "Needs a group" list, so the drawer closes. */
  assignRouteToGroup(routeId: number, g: GroupRow): void {
    if (!this.routeIsGroupable(routeId)) return;
    this.assignDrawerRouteId = null;
    this.saveGroupRoutes(g, [...g.route_ids, routeId], 'Route added to ' + g.name);
  }

  openAssignDrawer(r: RouteLite): void {
    if (!this.routeIsGroupable(r.id)) return;
    this.assignDrawerRouteId = r.id;
  }
  openRouteDrawer(g: GroupRow): void { this.routeDrawerId = g.id; }

  /** Seed the checklist from the group's current drivers so it opens pre-ticked. */
  openDriverDrawer(g: GroupRow): void {
    this.driverDrawerId = g.id;
    this.pendingDriverIds = [...g.driver_user_ids];
  }

  togglePendingDriver(userId: number): void {
    this.pendingDriverIds = this.pendingDriverIds.includes(userId)
      ? this.pendingDriverIds.filter((id) => id !== userId)
      : [...this.pendingDriverIds, userId];
  }

  /** Commit the whole selection at once, replacing the group's driver set. */
  commitDrawerDrivers(): void {
    const g = this.driverDrawerGroup;
    if (!g || this.cityId == null || this.savingGroupDrivers) return;
    this.savingGroupDrivers = true;
    this.api.put(`/admin/cities/${this.cityId}/route-groups/${g.id}/drivers`, { driver_user_ids: this.pendingDriverIds }).subscribe({
      next: () => { this.savingGroupDrivers = false; this.driverDrawerId = null; this.toast.success('Stand drivers updated'); this.loadGroups(); },
      error: (err) => { this.savingGroupDrivers = false; this.toast.error(err?.error?.message || 'Could not update drivers'); },
    });
  }

  routesIn(g: GroupRow): RouteLite[] { return this.routes.filter((r) => g.route_ids.includes(r.id) && (r.is_active === true || (r.is_active as any) === 1 || (r.is_active as any) === '1')); }
  driversIn(g: GroupRow): DriverOpt[] { return this.cityDrivers.filter((d) => g.driver_user_ids.includes(d.user_id)); }
  driverOptions(g: GroupRow): DriverOpt[] { return this.cityDrivers.filter((d) => !g.driver_user_ids.includes(d.user_id)); }
  groupsForDriver(userId: number): GroupRow[] { return this.groups.filter((g) => g.driver_user_ids.includes(userId)); }

  effectiveRoutes(userId: number): RouteLite[] {
    const ids = new Set<number>(this.groupsForDriver(userId).flatMap((g) => g.route_ids));
    return this.routes.filter((r) => ids.has(r.id));
  }

  openGroupDrawer(): void { this.groupName = ''; this.groupOpen = true; }

  createGroup(): void {
    if (!this.groupName.trim() || this.cityId == null || this.groupSaving) return;
    this.groupSaving = true;
    this.api.post(`/admin/cities/${this.cityId}/route-groups`, {
      name: this.groupName.trim(),
      city_vehicle_type_id: this.rows.find(row => (this.selected?.mode_row_ids ?? []).includes(row.id) && row.vehicle_set_id)?.id ?? this.selected?.id ?? null,
    }).subscribe({
      next: () => { this.groupSaving = false; this.groupOpen = false; this.masterGroupCreateOpen = false; this.masterGroupCreatedVersion++; this.toast.success('Stand created'); this.loadGroups(); },
      error: (err) => { this.groupSaving = false; this.toast.error(err?.error?.message || 'Could not create stand'); },
    });
  }

  startRename(g: GroupRow): void { this.renamingId = g.id; this.renameValue = g.name; }

  saveRename(g: GroupRow): void {
    const name = this.renameValue.trim();
    if (!name || this.cityId == null) { this.toast.error('Stand name is required'); return; }
    this.api.patch(`/admin/cities/${this.cityId}/route-groups/${g.id}`, { name, route_ids: g.route_ids }).subscribe({
      next: () => { this.renamingId = null; this.toast.success('Stand renamed'); this.loadGroups(); },
      error: (err) => this.toast.error(err?.error?.message || 'Could not rename stand'),
    });
  }

  deleteGroup(g: GroupRow): void {
    if (this.cityId == null) return;
    if (!confirm(`Delete "${g.name}"? Its routes go back to needing a stand.`)) return;
    this.api.delete(`/admin/cities/${this.cityId}/route-groups/${g.id}`).subscribe({
      next: () => {
        if (this.selectedGroupSection === g.id) this.selectGroupSection('ungrouped');
        this.toast.success('Stand deleted');
        this.loadGroups();
      },
      error: (err) => this.toast.error(err?.error?.message || 'Could not delete stand'),
    });
  }

  addRouteToGroup(g: GroupRow, routeId: number): void {
    if (!this.routeIsGroupable(routeId)) return;
    this.saveGroupRoutes(g, [...g.route_ids, routeId], 'Route added to ' + g.name);
  }

  ungroupRoute(g: GroupRow, routeId: number): void {
    this.saveGroupRoutes(g, g.route_ids.filter((id) => id !== routeId), 'Route removed from ' + g.name);
  }

  /**
   * Optimistic write: apply the new route set to the local state first so the
   * card updates the instant the button is pressed, then persist. Reload on
   * either outcome to reconcile — on error that rolls the optimistic change back.
   */
  private saveGroupRoutes(g: GroupRow, routeIds: number[], message: string): void {
    if (this.cityId == null) return;
    g.route_ids = routeIds;
    this.recompute();
    this.api.patch(`/admin/cities/${this.cityId}/route-groups/${g.id}`, { name: g.name, route_ids: routeIds }).subscribe({
      next: () => { this.toast.success(message); this.loadGroups(); },
      error: (err) => { this.toast.error(err?.error?.message || 'Could not save stand'); this.loadGroups(); },
    });
  }

  addDriverToGroup(g: GroupRow, userId: number): void { this.saveGroupDrivers(g, [...g.driver_user_ids, userId]); }
  removeDriverFromGroup(g: GroupRow, userId: number): void { this.saveGroupDrivers(g, g.driver_user_ids.filter((id) => id !== userId)); }

  /** Optimistic, same as saveGroupRoutes — the chip disappears immediately. */
  private saveGroupDrivers(g: GroupRow, driverIds: number[]): void {
    if (this.cityId == null) return;
    g.driver_user_ids = driverIds;
    this.recompute();
    this.api.put(`/admin/cities/${this.cityId}/route-groups/${g.id}/drivers`, { driver_user_ids: driverIds }).subscribe({
      next: () => this.loadGroups(),
      error: (err) => { this.toast.error(err?.error?.message || 'Could not update drivers'); this.loadGroups(); },
    });
  }

  // ── drivers ────────────────────────────────────────────────
  /**
   * Moves a driver's car. The link lives on the driver record, so this patches
   * the driver. There is deliberately no "clear" — the field is mandatory at
   * signup and locked for the driver after approval, so emptying it would
   * strand them in a state neither they nor the app can repair.
   */
  setCar(d: DriverOpt, cityVehicleTypeId: number): void {
    if (this.savingDriverId != null) return;
    const target = this.vehicles.find((v) => v.id === cityVehicleTypeId);
    this.savingDriverId = d.id;
    this.api.patch(`/admin/drivers/${d.id}`, { city_vehicle_type_id: cityVehicleTypeId }).subscribe({
      next: () => {
        this.savingDriverId = null;
        this.movePickFor = null;
        this.toast.success(`${d.name} moved to ${target?.display_name ?? 'the selected vehicle'}`);
        this.loadDrivers();
      },
      error: (err) => { this.savingDriverId = null; this.toast.error(err?.error?.message || 'Could not update driver'); },
    });
  }

  // ── seat layouts ───────────────────────────────────────────
  openDesigner(): void {
    const v = this.selected;
    if (!v || v.vehicle_type_id == null) return;
    this.editingLayoutId = null;
    this.editingLayout = null;
    this.layoutDrawerOpen = true;
  }

  editLayout(l: VehicleSeatLayout): void {
    this.editingLayoutId = l.id;
    this.editingLayout = l;
    this.layoutDrawerOpen = true;
  }

  closeLayoutDrawer(): void {
    this.layoutDrawerOpen = false;
    this.editingLayoutId = null;
    this.editingLayout = null;
  }

  onLayoutSaved(): void {
    this.closeLayoutDrawer();
    this.load();
  }

  deleteLayout(l: VehicleSeatLayout): void {
    if (this.cityId == null || l.in_use) return;
    if (!confirm(`Delete layout "${l.name}"? This cannot be undone.`)) return;
    this.layoutsSvc.destroy(this.cityId, l.id).subscribe({
      next: () => { this.toast.success('Layout deleted'); this.load(); },
      error: (err) => this.toast.error(err?.error?.message || 'Failed to delete layout'),
    });
  }

  // ── spreadsheet interactions ───────────────────────────────
  isExpanded(v: CityVehicleRow): boolean { return !!this.expanded[v.id]; }

  /** Expand/collapse a vehicle's route-group detail row. Expanding selects the
   *  vehicle so `selected` (and the embedded map editor) bind to it. */
  toggleExpand(v: CityVehicleRow, ev?: Event): void {
    ev?.stopPropagation();
    const open = !this.expanded[v.id];
    // Accordion: only one vehicle's route-group detail is open at a time.
    this.expanded = open ? { [v.id]: true } : {};
    if (open) this.select(v);
  }

  // selection + bulk
  get singleSelectedVehicle(): CityVehicleRow | null {
    if (this.selectedIds.size > 1) return null;
    if (this.selectedIds.size === 1) {
      const id = Array.from(this.selectedIds)[0];
      return this.vehicles.find((v) => v.id === id) ?? null;
    }
    if (this.selectedId != null) {
      return this.vehicles.find((v) => v.id === this.selectedId) ?? null;
    }
    return null;
  }

  get canManageSingleVehicle(): boolean {
    return this.cityId != null && this.singleSelectedVehicle != null && this.selectedIds.size <= 1;
  }



  isSel(v: CityVehicleRow): boolean { return this.selectedIds.has(v.id); }
  toggleSel(v: CityVehicleRow, ev?: Event): void {
    ev?.stopPropagation();
    if (this.selectedIds.has(v.id)) {
      this.selectedIds.delete(v.id);
    } else {
      this.selectedIds.add(v.id);
      if (this.selectedIds.size === 1) {
        this.select(v);
      }
    }
  }
  get allSelected(): boolean { return this.visible.length > 0 && this.visible.every((v) => this.selectedIds.has(v.id)); }
  toggleSelectAll(): void {
    if (this.allSelected) this.selectedIds.clear();
    else this.visible.forEach((v) => this.selectedIds.add(v.id));
  }
  clearSel(): void { this.selectedIds.clear(); }

  /** Enable/disable every checked vehicle by patching each one's sibling rows. */
  bulkSetActive(active: boolean): void {
    if (this.cityId == null || !this.selectedIds.size) return;
    const keys = new Set(
      [...this.selectedIds].map((id) => this.vehicles.find((x) => x.id === id)).filter(Boolean).map((v) => this.groupKey(v as CityVehicleRow)),
    );
    const targets = this.rows.filter((r) => keys.has(this.groupKey(r)));
    const n = this.selectedIds.size;
    forkJoin(targets.map((r) => this.api.patch(`/admin/cities/${this.cityId}/vehicle-types/${r.id}`, { is_active: active }))).subscribe({
      next: () => { this.toast.success(`${n} ${n === 1 ? 'vehicle' : 'vehicles'} ${active ? 'enabled' : 'disabled'}`); this.clearSel(); this.load(); },
      error: (err) => this.toast.error(err?.error?.message || 'Bulk update failed'),
    });
  }

  /** Client-side CSV of the checked vehicles. */
  bulkExport(): void {
    const ids = new Set(this.selectedIds);
    const rows = this.vehicles.filter((v) => ids.has(v.id));
    const header = ['Vehicle', 'Type', 'Status', 'Seats', 'Bags', 'Fare modes'];
    const body = rows.map((v) => [v.display_name, v.vehicle_type_name || '', v.is_active ? 'Enabled' : 'Disabled', v.max_people, v.luggage_capacity, this.fareModesLabel(v)]);
    const csv = [header, ...body].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = 'vehicles.csv'; a.click();
    URL.revokeObjectURL(url);
    this.toast.success(`Exported ${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`);
  }

  // inline cell edit — name / seats / bags patch every sibling mode row
  isEditing(v: CityVehicleRow, field: string): boolean { return this.editId === v.id && this.editField === field; }
  startCellEdit(v: CityVehicleRow, field: 'name' | 'seats' | 'bags', ev?: Event): void {
    ev?.stopPropagation();
    this.editId = v.id; this.editField = field;
    this.editValue = field === 'name' ? v.display_name : String(field === 'seats' ? v.max_people : v.luggage_capacity);
  }
  cancelCellEdit(): void { this.editId = null; this.editField = ''; this.editValue = ''; }
  commitCellEdit(v: CityVehicleRow): void {
    const field = this.editField;
    if (!field || this.cityId == null) { this.cancelCellEdit(); return; }
    let payload: Record<string, unknown> | null = null;
    if (field === 'name') { const name = this.editValue.trim(); if (name && name !== v.display_name) payload = { display_name: name }; }
    else if (field === 'seats') { const num = Math.max(1, Math.round(+this.editValue) || v.max_people); if (num !== v.max_people) payload = { max_people: num }; }
    else { const num = Math.max(0, Math.round(+this.editValue) || 0); if (num !== v.luggage_capacity) payload = { luggage_capacity: num }; }
    this.cancelCellEdit();
    if (!payload) return;
    const key = this.groupKey(v);
    const siblings = this.rows.filter((r) => this.groupKey(r) === key);
    this.savingCell = true;
    forkJoin(siblings.map((r) => this.api.patch(`/admin/cities/${this.cityId}/vehicle-types/${r.id}`, payload))).subscribe({
      next: () => { this.savingCell = false; this.toast.success('Saved'); this.load(); },
      error: (err) => { this.savingCell = false; this.toast.error(err?.error?.message || 'Could not save'); },
    });
  }

  /** Per-row status toggle from the spreadsheet pill. */
  toggleActiveFor(v: CityVehicleRow, ev?: Event): void {
    ev?.stopPropagation();
    this.select(v);
    this.toggleActive();
  }

  // per-vehicle slices for the spreadsheet (independent of `selected`, so several
  // detail rows can be open at once and still read correctly)
  routesForVehicle(v: CityVehicleRow): RouteLite[] {
    const vId = Number(v.id);
    const groupRouteIds = new Set(this.groupsForVehicle(v).flatMap((g) => g.route_ids));
    return this.routes.filter((r) => {
      if (r.city_vehicle_type_id != null && Number(r.city_vehicle_type_id) === vId) return true;
      if (groupRouteIds.has(r.id)) return true;
      if (r.city_vehicle_type_id == null && this.vehicles.length === 1) return true;
      if (r.city_vehicle_type_id == null && this.vehicles[0]?.id === v.id) return true;
      return false;
    });
  }
  groupsForVehicle(v: CityVehicleRow): GroupRow[] {
    const vId = Number(v.id);
    const mine = new Set(this.routes.filter((r) => r.city_vehicle_type_id != null && Number(r.city_vehicle_type_id) === vId).map((r) => r.id));
    return this.groups.filter((g) => {
      if ((g.vehicle_set_ids ?? []).some(id => (v.vehicle_set_ids ?? (v.vehicle_set_id ? [v.vehicle_set_id] : [])).includes(id))) return true;
      // Bound groups belong to exactly one vehicle — shown there even when empty.
      if (g.city_vehicle_type_id != null) return (v.mode_row_ids ?? [vId]).includes(Number(g.city_vehicle_type_id));
      // Legacy unbound groups fall back to route ownership only; a route-less
      // unbound group belongs to no vehicle (it no longer leaks onto every row).
      return g.route_ids.some((id) => mine.has(id));
    });
  }
  ungroupedForVehicle(v: CityVehicleRow): RouteLite[] {
    const covered = new Set(this.groups.flatMap((g) => g.route_ids));
    const isAct = (r: RouteLite) => r.is_active === true || (r.is_active as any) === 1 || (r.is_active as any) === '1';
    return this.routesForVehicle(v).filter((r) => isAct(r) && !covered.has(r.id));
  }
  inactiveRoutesForVehicle(v: CityVehicleRow): RouteLite[] {
    return this.routesForVehicle(v).filter((r) => !r.is_active || (r.is_active as any) === 0 || (r.is_active as any) === '0' || (r.is_active as any) === false);
  }

  routeView: 'all' | 'groups' = 'all';
  routeStatusFilter: 'all' | 'enabled' | 'disabled' = 'all';
  routeScopeFilter: 'all' | 'local' | 'outstation' = 'all';
  savingRouteIds = new Set<number>();

  isRouteEnabled(r: RouteLite): boolean {
    return r.is_active === true || Number(r.is_active) === 1;
  }

  directoryRoutes(v: CityVehicleRow): RouteLite[] {
    return this.filterKanbanRoutes(this.routesForVehicle(v)).filter((r) => {
      const statusMatch = this.routeStatusFilter === 'all' || this.isRouteEnabled(r) === (this.routeStatusFilter === 'enabled');
      const scopeMatch = this.routeScopeFilter === 'all' || (r.scope || 'local').toLowerCase() === this.routeScopeFilter;
      return statusMatch && scopeMatch;
    });
  }

  routeGroupNames(r: RouteLite): string {
    return this.groups.filter((g) => g.route_ids.includes(r.id)).map((g) => g.name).join(', ') || 'No stand';
  }

  toggleRouteActive(r: RouteLite, ev?: Event): void {
    ev?.stopPropagation();
    if (this.cityId == null || this.savingRouteIds.has(r.id)) return;
    const next = !this.isRouteEnabled(r);
    this.savingRouteIds.add(r.id);
    this.api.patch(`/admin/cities/${this.cityId}/fixed-routes/${r.id}`, { is_active: next }).subscribe({
      next: () => {
        this.savingRouteIds.delete(r.id);
        r.is_active = next;
        this.toast.success(next ? `Route "${r.name}" enabled` : `Route "${r.name}" disabled`);
        this.onRouteMutation();
      },
      error: (err) => {
        this.savingRouteIds.delete(r.id);
        this.toast.error(err?.error?.message || 'Could not update route status');
      },
    });
  }
  driversFor(v: CityVehicleRow): DriverOpt[] { return this.driversForVehicle(v); }
  layoutCountFor(v: CityVehicleRow): number { return v.vehicle_type_id == null ? 0 : this.layouts.filter((l) => l.vehicle_type_id === v.vehicle_type_id).length; }

  /** Setup completeness: type, a fare mode, routes, a group, drivers, a layout. */
  setupPct(v: CityVehicleRow): number {
    const routes = this.routesForVehicle(v);
    const steps = [
      v.vehicle_type_id != null,
      (v.mode_ids ?? []).length > 0,
      routes.length > 0,
      this.groupsForVehicle(v).length > 0,
      this.driversFor(v).length > 0,
      this.layoutCountFor(v) > 0,
    ];
    return Math.round((steps.filter(Boolean).length / steps.length) * 100);
  }

  // fare column → real fare drawer (reuses the ride-type tab machinery)
  fareConfigured(v: CityVehicleRow, rt: RideTypeRef): boolean { return (v.mode_ids ?? []).includes(rt.id); }
  openFareDrawer(v: CityVehicleRow, rt: RideTypeRef, ev?: Event): void {
    ev?.stopPropagation();
    this.select(v);
    this.setTab('mode:' + rt.id); // drives activeRideType/activeRow (+ auto-creates the fare row)
    this.fareDrawerOpen = true;
  }
  closeFareDrawer(): void { this.fareDrawerOpen = false; }

  openAppAssets(v: CityVehicleRow): void {
    void this.router.navigate(['/settings/app-assets'], {
      queryParams: { family: v.display_name },
    });
  }

  // seat-layouts list drawer
  openLayoutsList(v: CityVehicleRow, ev?: Event): void { ev?.stopPropagation(); this.select(v); this.layoutsListOpen = true; }
  closeLayoutsList(): void { this.layoutsListOpen = false; }

  // route map editor + group create, rebinding `selected` to the acted-on vehicle
  newRouteFor(v: CityVehicleRow): void { this.select(v); setTimeout(() => this.newRoute()); }
  // ── Edit an ungrouped route: choose Manual vs update-from-My-Maps ──────────
  editChoiceOpen = false;
  editChoiceRouteId: number | null = null;
  editChoiceVehicle: CityVehicleRow | null = null;
  editChoiceName = '';
  @ViewChild('editKmlInput') private editKmlInput?: ElementRef<HTMLInputElement>;

  /** The edit pen on an ungrouped or inactive route opens a choice: edit by hand, or replace
   *  its line & stops from a Google My Maps upload (keeping fare & settings). */
  editRouteFor(v: CityVehicleRow, routeId: number): void {
    this.editChoiceVehicle = v;
    this.editChoiceRouteId = routeId;
    this.editChoiceName = this.routesForVehicle(v).find((r) => r.id === routeId)?.name ?? 'this route';
    this.editChoiceOpen = true;
  }

  chooseManualEdit(): void {
    const v = this.editChoiceVehicle;
    const id = this.editChoiceRouteId;
    this.editChoiceOpen = false;
    if (v && id != null) { this.select(v); setTimeout(() => this.editRoute(id)); }
  }

  chooseMyMapsEdit(): void {
    this.editChoiceOpen = false;
    const el = this.editKmlInput?.nativeElement;
    if (el) { el.value = ''; el.click(); }
  }

  /** Upload for the "edit → from My Maps" path: parse, then open the map editor
   *  for THIS route with the imported line + stops, preserving fare & settings. */
  onEditKmlFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    const routeId = this.editChoiceRouteId;
    const v = this.editChoiceVehicle;
    if (!file || this.cityId == null || routeId == null || !v) return;

    const fd = new FormData();
    fd.append('file', file);
    this.importingKml = true;
    this.api.postMultipart<{ routes: ImportedRouteDraft[]; count: number }>(
      `/admin/cities/${this.cityId}/fixed-routes/import-kml`, fd,
    ).subscribe({
      next: (res) => {
        this.importingKml = false;
        const routes = res?.routes ?? [];
        if (!routes.length) { this.toast.error('No routes were found in that file.'); return; }
        // If the file holds several routes, prefer the one whose name matches
        // this route; otherwise use the first.
        const draft = routes.find((d) => d.existing_route_id === routeId) ?? routes[0];
        this.select(v);
        setTimeout(() => this.fixedRoutes?.openEditFromImport(routeId, draft));
      },
      error: (err) => {
        this.importingKml = false;
        this.toast.error(err?.error?.message || 'Could not read that file.');
      },
    });
  }

  // ── Import from Google My Maps (KML/KMZ) ──────────────────────────────────
  // The file is parsed server-side into draft routes; each draft is opened in the
  // normal map editor for review and saved through the normal create flow. When
  // a file holds several routes we queue them and open the next after each close.
  @ViewChild('kmlInput') private kmlInput?: ElementRef<HTMLInputElement>;
  importingKml = false;
  private importQueue: ImportedRouteDraft[] = [];
  private importTotal = 0;
  private importTargetVehicle: CityVehicleRow | null = null;

  // ── "Import from My Maps" → choose Single (review each) or Bulk (all now) ──
  importChoiceOpen = false;
  importChoiceVehicle: CityVehicleRow | null = null;
  @ViewChild('bulkKmlInput') private bulkKmlInput?: ElementRef<HTMLInputElement>;

  openImportChoice(v: CityVehicleRow): void {
    if (this.importingKml) return;
    this.importChoiceVehicle = v;
    this.importChoiceOpen = true;
  }

  chooseSingleImport(): void {
    const v = this.importChoiceVehicle;
    this.importChoiceOpen = false;
    if (v) this.triggerKmlImport(v);
  }

  chooseBulkImport(): void {
    this.importChoiceOpen = false;
    const el = this.bulkKmlInput?.nativeElement;
    if (el) { el.value = ''; el.click(); }
  }

  /** Bulk import: create every route across ALL chosen files for the vehicle,
   *  with name + line only (no stops/price) — they land as "Needs pricing".
   *  Files are sent one at a time and the counts are summed into one toast. */
  onBulkKmlFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    const v = this.importChoiceVehicle;
    if (!files.length || this.cityId == null || !v) return;

    this.importingKml = true;
    this.bulkImportNext(files, v.id, 0, { created: 0, skipped: 0, failed: 0 });
  }

  /** Sends one file, then recurses to the next — keeps a running tally. */
  private bulkImportNext(
    files: File[],
    cityVehicleTypeId: number,
    index: number,
    tally: { created: number; skipped: number; failed: number },
  ): void {
    if (index >= files.length) {
      this.importingKml = false;
      this.reportBulkImport(files.length, tally);
      this.loadRoutes();
      return;
    }

    const fd = new FormData();
    fd.append('file', files[index]);
    fd.append('city_vehicle_type_id', String(cityVehicleTypeId));
    this.api.postMultipart<{ created_count: number; skipped_count: number }>(
      `/admin/cities/${this.cityId}/fixed-routes/import-kml-bulk`, fd,
    ).subscribe({
      next: (res) => {
        tally.created += res?.created_count ?? 0;
        tally.skipped += res?.skipped_count ?? 0;
        this.bulkImportNext(files, cityVehicleTypeId, index + 1, tally);
      },
      error: () => {
        tally.failed += 1;
        this.bulkImportNext(files, cityVehicleTypeId, index + 1, tally);
      },
    });
  }

  private reportBulkImport(fileCount: number, tally: { created: number; skipped: number; failed: number }): void {
    const parts: string[] = [];
    if (tally.skipped) parts.push(`skipped ${tally.skipped} existing`);
    if (tally.failed) parts.push(`${tally.failed} file${tally.failed === 1 ? '' : 's'} could not be read`);
    const tail = parts.length ? ` (${parts.join(', ')})` : '';

    if (tally.created) {
      const scope = fileCount > 1 ? ` from ${fileCount} files` : '';
      this.toast.success(`Imported ${tally.created} route${tally.created === 1 ? '' : 's'}${scope}${tail} — add a price to finish each.`);
    } else if (tally.failed && !tally.skipped) {
      this.toast.error('Could not read those files.');
    } else {
      this.toast.info(tally.skipped ? (tally.skipped === 1 ? 'Route already exists' : 'Routes already exist') : 'No routes were found in those files.');
    }
  }

  triggerKmlImport(v: CityVehicleRow): void {
    if (this.importingKml) return;
    this.importTargetVehicle = v;
    const el = this.kmlInput?.nativeElement;
    if (el) { el.value = ''; el.click(); }
  }

  onKmlFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || this.cityId == null || !this.importTargetVehicle) return;

    const fd = new FormData();
    fd.append('file', file);
    this.importingKml = true;
    this.api.postMultipart<{ routes: ImportedRouteDraft[]; count: number }>(
      `/admin/cities/${this.cityId}/fixed-routes/import-kml`, fd,
    ).subscribe({
      next: (res) => {
        this.importingKml = false;
        const routes = res?.routes ?? [];
        if (!routes.length) { this.toast.error('No routes were found in that file.'); return; }

        // The import button only CREATES. Any route whose name already exists is
        // skipped (it's updated from its own Edit → "Update from My Maps"), so the
        // button can never silently make duplicates.
        const fresh = routes.filter((r) => !r.existing_route_id);
        const skipped = routes.filter((r) => r.existing_route_id);
        if (skipped.length) {
          this.toast.info(skipped.length === 1 ? 'Route already exists' : 'Routes already exist');
        }
        if (!fresh.length) { return; }

        this.importQueue = [...fresh];
        this.importTotal = fresh.length;
        this.toast.success(`Found ${fresh.length} new route${fresh.length === 1 ? '' : 's'} — review and save each one.`);
        this.openNextImported();
      },
      error: (err) => {
        this.importingKml = false;
        this.toast.error(err?.error?.message || 'Could not read that file.');
      },
    });
  }

  private openNextImported(): void {
    const draft = this.importQueue.shift();
    if (!draft || !this.importTargetVehicle) return;
    if (this.importTotal > 1) {
      this.toast.info(`Reviewing route ${this.importTotal - this.importQueue.length} of ${this.importTotal}`);
    }
    // The "Import from My Maps" button only ever CREATES new routes. Updating an
    // existing route from My Maps is done from the ungrouped route's edit menu.
    this.select(this.importTargetVehicle);
    setTimeout(() => this.fixedRoutes?.openImported(draft, false));
  }

  /** After a reviewed import is saved or cancelled, open the next queued route. */
  onRouteEditorClosed(): void {
    this.routeView = 'all';
    this.routeStatusFilter = 'all';
    this.kanbanSearch = '';
    this.onRouteMutation();
    if (this.importQueue.length) setTimeout(() => this.openNextImported(), 150);
    else { this.importTotal = 0; this.importTargetVehicle = null; }
  }
  openGroupDrawerFor(v: CityVehicleRow): void { this.select(v); this.openGroupDrawer(); }

  openUnifiedGroupDrawerFromTop(): void {
    const v = this.singleSelectedVehicle;
    if (v) {
      this.openUnifiedGroupDrawer(v);
    } else if (this.selectedIds.size > 1) {
      this.toast.error('Please select only one vehicle to manage its stands.');
    } else {
      this.toast.error('Please select a vehicle first.');
    }
  }

  triggerKmlImportFromTop(): void {
    const v = this.singleSelectedVehicle;
    if (v) {
      this.openImportChoice(v);
    } else if (this.selectedIds.size > 1) {
      this.toast.error('Please select only one vehicle to import routes.');
    } else {
      this.toast.error('Please select a vehicle first.');
    }
  }

  addNewRouteFromTop(): void {
    const v = this.singleSelectedVehicle;
    if (v) {
      this.select(v);
      setTimeout(() => this.newRoute());
    } else if (this.selectedIds.size > 1) {
      this.toast.error('Please select only one vehicle to add a route.');
    } else {
      this.toast.error('Please select a vehicle first.');
    }
  }

  // floating row kebab menu
  openRowMenu(v: CityVehicleRow, ev: MouseEvent): void {
    ev.stopPropagation();
    this.select(v);
    this.menuId = v.id;
    this.menuX = Math.min(ev.clientX, window.innerWidth - 230);
    this.menuY = Math.min(ev.clientY, window.innerHeight - 250);
  }
  closeRowMenu(): void { this.menuId = null; }

  // ── copy vehicles to another location ──────────────────────
  openCopyModal(v?: CityVehicleRow): void {
    if (this.cityId == null) return;
    this.cityCtx.ensureCitiesLoaded().subscribe();

    if (v) {
      this.copyScope = 'single';
      this.copySingleVehicle = v;
      this.copyForm.vehicle_ids = [v.id];
    } else if (this.selectedIds.size > 0) {
      this.copyScope = 'selected';
      this.copySingleVehicle = null;
      this.copyForm.vehicle_ids = Array.from(this.selectedIds);
    } else {
      this.copyScope = 'all';
      this.copySingleVehicle = null;
      this.copyForm.vehicle_ids = this.vehicles.map((x) => x.id);
    }

    this.copyForm.target_city_ids = [];
    this.copyForm.copy_pricing = true;
    this.copyForm.copy_seat_layouts = true;
    this.copyForm.overwrite_existing = true;
    this.copyModalOpen = true;
  }

  openCopyModalForSelected(): void {
    if (!this.selectedIds.size) return;
    this.openCopyModal();
  }

  toggleTargetCity(cityId: number): void {
    if (this.copyForm.target_city_ids.includes(cityId)) {
      this.copyForm.target_city_ids = this.copyForm.target_city_ids.filter((id) => id !== cityId);
    } else {
      this.copyForm.target_city_ids = [...this.copyForm.target_city_ids, cityId];
    }
  }

  selectAllTargetCities(): void {
    this.copyForm.target_city_ids = this.availableTargetCities.map((c) => c.id);
  }

  clearTargetCities(): void {
    this.copyForm.target_city_ids = [];
  }

  toggleCopyVehicle(vehicleId: number): void {
    if (this.copyForm.vehicle_ids.includes(vehicleId)) {
      this.copyForm.vehicle_ids = this.copyForm.vehicle_ids.filter((id) => id !== vehicleId);
    } else {
      this.copyForm.vehicle_ids = [...this.copyForm.vehicle_ids, vehicleId];
    }
  }

  selectAllVehiclesForCopy(): void {
    this.copyForm.vehicle_ids = this.vehicles.map((v) => v.id);
  }

  submitCopyToLocation(): void {
    if (this.cityId == null) return;
    if (!this.copyForm.target_city_ids.length) {
      this.toast.error('Select at least one destination city/location.');
      return;
    }
    if (!this.copyForm.vehicle_ids.length) {
      this.toast.error('Select at least one vehicle to copy.');
      return;
    }

    this.copyingToLocation = true;
    this.api
      .post<{ message: string; copied_count: number; copied_layouts_count: number }>(
        `/admin/cities/${this.cityId}/vehicle-types/copy-to-city`,
        this.copyForm,
      )
      .subscribe({
        next: (res) => {
          this.copyingToLocation = false;
          this.copyModalOpen = false;
          this.toast.success(res?.message || 'Vehicle settings copied successfully.');
        },
        error: (err) => {
          this.copyingToLocation = false;
          this.toast.error(err?.error?.message || 'Failed to copy vehicle settings.');
        },
      });
  }

  // ── helpers ────────────────────────────────────────────────
  private blankCreate() {
    return { vehicle_type_id: null as number | null, vehicle_type_name: '', vehicle_set_id: null as number | null, display_name: '', max_people: 4, luggage_capacity: 0 };
  }

  private groupKey(row: CityVehicleRow): string {
    return `${row.vehicle_type_id ?? 'none'}:${row.display_name.trim().toLowerCase()}`;
  }

  /** Collapses the per-mode API rows into one row per physical vehicle. */
  private groupRows(rows: CityVehicleRow[]): CityVehicleRow[] {
    const buckets = new Map<string, CityVehicleRow[]>();
    rows.forEach((row) => {
      const key = this.groupKey(row);
      buckets.set(key, [...(buckets.get(key) ?? []), row]);
    });
    const order = this.rideTypes.map((rt) => rt.id);
    return Array.from(buckets.values()).map((bucket) => {
      const rep = bucket.find((r) => this.kindOf(r.ride_type_name) === 'private') ?? bucket[0];
      const mode_ids = order.filter((id) => bucket.some((row) => row.ride_type_id === id));
      return { ...rep, mode_ids, mode_row_ids: bucket.map(row => row.id), vehicle_set_ids: [...new Set(bucket.flatMap(row => row.vehicle_set_id ? [row.vehicle_set_id] : []))] };
    });
  }
}
