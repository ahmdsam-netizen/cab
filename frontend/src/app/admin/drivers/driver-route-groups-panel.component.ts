import { Component, EventEmitter, Input, Output, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { IconComponent } from '../../ui/icon/icon.component';

interface GroupOpt { id: number; name: string; city_id?: number; city_name?: string; is_active: boolean; vehicle_set_names?: string[]; matches_vehicle_set?: boolean; }
interface EffRoute { id: number; name: string; origin_name: string; dest_name: string; scope: string; is_active: boolean; }
interface Payload { assigned_group_ids: number[]; groups: GroupOpt[]; effective_routes: EffRoute[]; }

/**
 * Driver page panel: assign route groups to this driver and show the resolved
 * "effective routes" (the union of the routes in the groups they hold). This is
 * how a driver's fixed-route access is set — independent of their vehicle.
 */
@Component({
  selector: 'app-driver-route-groups-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent],
  template: `
    <section class="drg" [class.drg--readonly]="readOnly">
      <header class="drg__head">
        <h3>Fixed route access</h3>
        <span class="drg__sub">This driver's stand assignments determine which fixed routes they can serve.</span>
      </header>

      <p *ngIf="loading" role="status">Loading route assignments…</p>
      <p *ngIf="loadFailed" role="alert">Could not load assignments. Close and try again.</p>
      @if (!loading && !loadFailed) {
        @if (readOnly) {
          <div class="drg__cards">
            <section class="drg__card" *ngIf="assignedGroups as stands">
              <h4><tm-icon name="map-marker" [size]="16" aria-hidden="true" /> Assigned stands <span>{{ stands.length }}</span></h4>
              <p class="drg__empty" *ngIf="!stands.length">No stands assigned.</p>
              <ul class="drg__items" *ngIf="stands.length">
                <li class="drg__route" *ngFor="let stand of stands">
                  <strong>{{ stand.name }}</strong>
                  <small *ngIf="stand.city_name">{{ stand.city_name }}</small>
                  <small class="drg__paused" *ngIf="!stand.is_active">Route access paused</small>
                </li>
              </ul>
            </section>
            <section class="drg__card drg__card--routes">
              <h4><tm-icon name="road" [size]="16" aria-hidden="true" /> Accessible routes <span>{{ effective.length }}</span></h4>
              <p class="drg__empty" *ngIf="!effective.length">No fixed routes available.</p>
              <ul class="drg__items" *ngIf="effective.length">
                <li class="drg__route" *ngFor="let route of effective">
                  <ng-container *ngTemplateOutlet="routeDetails; context: { $implicit: route }" />
                </li>
              </ul>
            </section>
          </div>
        } @else {
          <ng-container *ngTemplateOutlet="assignmentEditor" />
        }
      }
      <ng-template #assignmentEditor>
        <div class="drg__body">
        <div class="drg__col">
          <div class="drg__label">Stands</div>
          <div class="drg__empty" *ngIf="!groups.length">No stands found in this driver's cities yet.</div>
          <label class="drg__grp" *ngFor="let g of groups">
            <input type="checkbox" [disabled]="saving" [checked]="assigned.has(g.id)" (change)="toggle(g.id)" />
            <span>
              <strong>{{ g.name }}</strong>
              <small class="drg__city" *ngIf="g.city_name">· {{ g.city_name }}</small>
              <small class="drg__city" *ngIf="!g.is_active">· Inactive stand: route access paused</small>
              <small class="drg__city" *ngIf="g.vehicle_set_names?.length">· {{ g.vehicle_set_names?.join(', ') }}{{ g.matches_vehicle_set ? ' · Matches driver vehicle' : '' }}</small>
            </span>
          </label>
          <button class="drg__save" [disabled]="saving || !driverId" (click)="save()">{{ saving ? 'Saving…' : 'Save stands' }}</button>
        </div>

        <div class="drg__col">
          <div class="drg__header-row">
            <div class="drg__label">Effective routes ({{ filteredEffective.length }})</div>
            <div class="drg__filters">
              <button type="button" class="drg__filter-btn" [class.is-active]="scopeFilter === 'all'" (click)="scopeFilter = 'all'">All ({{ effective.length }})</button>
              <button type="button" class="drg__filter-btn" [class.is-active]="scopeFilter === 'local'" (click)="scopeFilter = 'local'">Local ({{ localCount }})</button>
              <button type="button" class="drg__filter-btn" [class.is-active]="scopeFilter === 'outstation'" (click)="scopeFilter = 'outstation'">Outstation ({{ outstationCount }})</button>
            </div>
          </div>
          <div class="drg__empty" *ngIf="!filteredEffective.length">
            {{ effective.length ? 'No routes match the selected scope filter.' : 'No routes — assign a stand to give this driver work.' }}
          </div>
          <div class="drg__route" *ngFor="let r of filteredEffective">
            <ng-container *ngTemplateOutlet="routeDetails; context: { $implicit: r }" />
          </div>
        </div>
      </div>
      </ng-template>
      <ng-template #routeDetails let-route>
        <div class="drg__route-top">
          <strong [title]="readOnly ? routeLabel(route) : null">{{ readOnly ? routeLabel(route) : route.name }}</strong>
          <span class="drg__badge" [class.is-outstation]="route.scope === 'outstation'" [class.is-local]="route.scope === 'local'">
            {{ route.scope | uppercase }}
          </span>
        </div>
        <small *ngIf="!readOnly">{{ route.origin_name }} → {{ route.dest_name }}</small>
      </ng-template>
    </section>
  `,
  styles: [`
    .drg { border: 1px solid var(--tm-line); border-radius: 12px; padding: 14px; margin-top: 16px; }
    .drg__head { display: flex; flex-direction: column; gap: 2px; margin-bottom: 12px; }
    .drg__head h3 { margin: 0; font-size: 15px; font-weight: 800; color: var(--tm-text); }
    .drg__sub { font-size: 12px; color: var(--tm-text-muted); }
    .drg--readonly { border: 0; padding: 0; margin-top: 0; }
    .drg--readonly .drg__head { margin-bottom: 14px; }
    .drg__cards { display: grid; gap: 12px; }
    .drg__card { min-width: 0; padding: 12px; border: 1px solid var(--tm-line); border-radius: 12px; background: var(--tm-canvas); }
    .drg__card h4 { display: flex; align-items: center; gap: 6px; margin: 0 0 10px; font-size: 13px; color: var(--tm-text); }
    .drg__card h4 tm-icon { color: var(--tm-green-deep); }
    .drg__card h4 span { margin-left: auto; padding: 2px 6px; border-radius: var(--tm-radius-pill); background: var(--tm-surface); color: var(--tm-text-muted); font-size: 11px; }
    .drg__card .drg__empty { margin: 0; }
    .drg__items { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
    .drg__items .drg__route { margin: 0; background: var(--tm-surface); overflow-wrap: anywhere; }
    .drg__card--routes .drg__route-top { gap: 6px; }
    .drg__card--routes .drg__route-top strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .drg__card--routes .drg__badge { flex-shrink: 0; }
    .drg__route .drg__paused { color: #b45309; }
    .drg__body { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    @media (max-width: 640px) { .drg__body { grid-template-columns: 1fr; } }
    .drg__header-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; flex-wrap: wrap; gap: 6px; }
    .drg__label { font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .03em; color: var(--tm-text-muted); }
    .drg__filters { display: flex; gap: 4px; }
    .drg__filter-btn { font-size: 10.5px; font-weight: 700; border: 1px solid var(--tm-line); border-radius: 4px; background: transparent; color: var(--tm-text-muted); padding: 2px 6px; cursor: pointer; }
    .drg__filter-btn.is-active { background: var(--tm-line-2, #e5e7eb); color: var(--tm-text); border-color: var(--tm-text-soft, #9ca3af); }
    .drg__grp { display: flex; align-items: center; gap: 8px; padding: 5px 0; font-size: 13px; color: var(--tm-text); cursor: pointer; }
    .drg__city { font-size: 11.5px; color: var(--tm-text-muted); font-weight: 600; margin-left: 4px; }
    .drg__save { margin-top: 10px; padding: 8px 14px; border: 0; border-radius: 8px; background: var(--tm-green, #12b35b); color: #fff; font-weight: 700; font-size: 12.5px; cursor: pointer; }
    .drg__save:disabled { opacity: .5; cursor: default; }
    .drg__route { padding: 7px 10px; border: 1px solid var(--tm-line); border-radius: 8px; margin-bottom: 6px; display: flex; flex-direction: column; gap: 2px; }
    .drg__route-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .drg__route strong { font-size: 13px; color: var(--tm-text); }
    .drg__route small { font-size: 11.5px; color: var(--tm-text-muted); }
    .drg__badge { font-size: 10px; font-weight: 800; padding: 1px 6px; border-radius: 4px; letter-spacing: .03em; }
    .drg__badge.is-local { background: rgba(37, 99, 235, 0.12); color: #2563eb; }
    .drg__badge.is-outstation { background: rgba(234, 88, 12, 0.12); color: #ea580c; }
    .drg__empty { font-size: 12.5px; color: var(--tm-text-muted); padding: 6px 0; }
  `],
})
export class DriverRouteGroupsPanelComponent implements OnChanges {
  @Input() driverId!: number;
  @Input() readOnly = false;
  @Output() saved = new EventEmitter<void>();

  groups: GroupOpt[] = [];
  effective: EffRoute[] = [];
  assigned = new Set<number>();
  saving = false;
  loading = false;
  loadFailed = false;
  scopeFilter: 'all' | 'local' | 'outstation' = 'all';

  get assignedGroups(): GroupOpt[] {
    return this.groups.filter(group => this.assigned.has(group.id));
  }

  routeLabel(route: EffRoute): string {
    const endpoints = `${route.origin_name} → ${route.dest_name}`;
    const name = route.name.trim();
    return name && name !== endpoints ? `${name} · ${endpoints}` : endpoints;
  }

  get localCount(): number {
    return this.effective.filter((r) => r.scope === 'local').length;
  }

  get outstationCount(): number {
    return this.effective.filter((r) => r.scope === 'outstation').length;
  }

  get filteredEffective(): EffRoute[] {
    if (this.scopeFilter === 'all') return this.effective;
    return this.effective.filter((r) => r.scope === this.scopeFilter);
  }

  constructor(private api: ApiService, private toast: ToastService) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['driverId'] && this.driverId) this.load();
  }

  load(): void {
    const driverId = this.driverId; this.loading = true; this.loadFailed = false;
    this.groups = []; this.effective = []; this.assigned = new Set();
    this.api.get<Payload>(`/admin/drivers/${this.driverId}/route-groups`).subscribe({
      next: (res) => {
        if (this.driverId !== driverId) return; this.loading = false;
        this.groups = [...(res?.groups || [])].sort((a, b) => Number(!!b.matches_vehicle_set) - Number(!!a.matches_vehicle_set));
        this.effective = res?.effective_routes || [];
        this.assigned = new Set<number>(res?.assigned_group_ids || []);
      },
      error: () => { if (this.driverId !== driverId) return; this.loading = false; this.loadFailed = true; },
    });
  }

  toggle(id: number): void {
    if (this.readOnly) return;
    if (this.assigned.has(id)) this.assigned.delete(id);
    else this.assigned.add(id);
  }

  save(): void {
    if (this.readOnly || !this.driverId || this.saving || this.loading || this.loadFailed) return;
    this.saving = true;
    this.api.put<Payload>(`/admin/drivers/${this.driverId}/route-groups`, { group_ids: Array.from(this.assigned) }).subscribe({
      next: (res) => {
        this.saving = false;
        this.effective = res?.effective_routes || [];
        this.assigned = new Set<number>(res?.assigned_group_ids || []);
        this.toast.success('Stands updated.'); this.saved.emit();
      },
      error: (e) => { this.saving = false; this.toast.error(e?.error?.message || 'Could not update stands.'); },
    });
  }
}
