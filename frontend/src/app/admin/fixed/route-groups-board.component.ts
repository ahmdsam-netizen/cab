import { Component, EventEmitter, OnDestroy, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription, forkJoin, of } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { CityContextService } from '../../core/city-context.service';
import { ToastService } from '../../core/toast.service';

interface RouteCard {
  id: number;
  name: string;
  scope: string;
  origin_name: string;
  dest_name: string;
  flat_fare: number | null;
  is_active: boolean;
  stops?: { id: number }[];
}
interface GroupRow {
  id: number;
  name: string;
  is_active: boolean;
  route_ids: number[];
  driver_user_ids: number[];
}
interface DriverOpt { user_id: number; name: string; phone?: string | null; }

/**
 * Fixed Routes board — a drag-and-drop Kanban. Routes are cards; groups are
 * columns. Drag a route into a group to grant it (groups grant drivers the
 * permission to run those routes). "Needs a group" holds ungrouped routes;
 * "New group" creates a column. Each group column also carries its drivers.
 * Uses native HTML5 drag-and-drop (no extra dependency).
 */
@Component({
  selector: 'app-route-groups-board',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="cue" *ngIf="cityId == null">Select a city (top bar) to manage fixed routes.</div>

    <ng-container *ngIf="cityId != null">
      <header class="bd-head">
        <div>
          <h1 class="bd-title">Fixed routes</h1>
          <p class="bd-sub">Drag routes into stands. Stands grant drivers permission to run them.</p>
        </div>
        <button class="bd-add" (click)="addRoute.emit()">+ Add fixed route</button>
      </header>

      <div class="bd-bar">
        <span class="bd-chip">{{ routes.length }} routes</span>
        <span class="bd-chip">{{ groups.length }} {{ groups.length === 1 ? 'stand' : 'stands' }}</span>
        <span class="bd-chip bd-chip--warn" *ngIf="ungrouped.length">⚠ {{ ungrouped.length }} needs a stand</span>
        <span class="bd-spacer"></span>
        <input class="bd-search" type="text" [(ngModel)]="search" placeholder="🔍 Search routes…" />
      </div>

      <div class="bd-cols">
        <!-- Needs a group -->
        <section class="col col--orphan" [class.drop]="dropTarget === 'orphan'"
                 (dragover)="allow($event)" (dragenter)="dropTarget='orphan'" (dragleave)="clearDrop('orphan')" (drop)="drop(null)">
          <div class="col__head"><span class="col__name">Needs a stand</span><span class="col__badge">{{ orphanFiltered.length }}</span></div>
          <div class="col__body">
            <div class="card" *ngFor="let r of orphanFiltered" draggable="true" (dragstart)="startDrag(r.id, null, $event)" (dragend)="endDrag()">
              <ng-container *ngTemplateOutlet="cardTpl; context: { r: r }"></ng-container>
            </div>
            <div class="col__empty" *ngIf="!orphanFiltered.length">All routes have stands 🎉</div>
          </div>
        </section>

        <!-- Group columns -->
        <section class="col col--group" *ngFor="let g of groups" [class.drop]="dropTarget === g.id"
                 (dragover)="allow($event)" (dragenter)="dropTarget=g.id" (dragleave)="clearDrop(g.id)" (drop)="drop(g.id)">
          <div class="col__head">
            <span class="col__name">{{ g.name }}</span>
            <span class="col__badge col__badge--green">{{ g.route_ids.length }}</span>
            <span class="col__spacer"></span>
            <button class="col__menu" (click)="menuFor = menuFor === g.id ? null : g.id">⋯</button>
            <div class="menu" *ngIf="menuFor === g.id">
              <button (click)="rename(g); menuFor=null">Rename</button>
              <button class="menu--danger" (click)="remove(g); menuFor=null">Delete</button>
            </div>
          </div>
          <div class="col__body">
            <div class="card" *ngFor="let r of routesFor(g)" draggable="true" (dragstart)="startDrag(r.id, g.id, $event)" (dragend)="endDrag()">
              <ng-container *ngTemplateOutlet="cardTpl; context: { r: r }"></ng-container>
            </div>
            <div class="col__empty" *ngIf="!routesFor(g).length">Drop a route here.</div>
          </div>
          <!-- Drivers -->
          <div class="col__drivers">
            <span class="drv-chip" *ngFor="let d of driversFor(g)">
              <span class="drv-av">{{ initials(d.name) }}</span>{{ d.name }}
              <button (click)="removeDriver(g, d.user_id)">✕</button>
            </span>
            <button class="drv-add" (click)="driverPickFor = driverPickFor === g.id ? null : g.id">+ driver</button>
            <div class="drv-pick" *ngIf="driverPickFor === g.id">
              <input class="bd-search" type="text" [(ngModel)]="driverSearch" placeholder="🔍 driver…" />
              <button class="drv-opt" *ngFor="let d of driverOptions(g)" (click)="addDriver(g, d.user_id)">+ {{ d.name }}</button>
              <div class="col__empty" *ngIf="!driverOptions(g).length">No more drivers.</div>
            </div>
          </div>
        </section>

        <!-- New group dropzone -->
        <section class="col col--new" [class.drop]="dropTarget === 'new'"
                 (dragover)="allow($event)" (dragenter)="dropTarget='new'" (dragleave)="clearDrop('new')" (drop)="drop('new')"
                 (click)="createEmpty()">
          <div class="new-inner">
            <div class="new-plus">+</div>
            <div class="new-t">New stand</div>
            <div class="new-s">or drop a route here</div>
          </div>
        </section>
      </div>
    </ng-container>

    <!-- Route card template -->
    <ng-template #cardTpl let-r="r">
      <div class="card__top">
        <span class="badge" [class.badge--out]="r.scope === 'outstation'">{{ r.scope === 'outstation' ? 'Outstation' : 'Local' }}</span>
        <span class="card__fare">₹{{ r.flat_fare != null ? r.flat_fare : '—' }}</span>
      </div>
      <div class="card__leg"><span class="dot dot--o"></span>{{ r.origin_name }}</div>
      <div class="card__leg"><span class="dot dot--d"></span>{{ r.dest_name }}</div>
      <div class="card__foot"><span>🔗 {{ r.stops?.length || 0 }} stops</span></div>
    </ng-template>
  `,
  styles: [`
    .cue { padding: 20px; color: var(--tm-text-muted); font-size: 13px; }
    .bd-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
    .bd-title { margin: 0; font-size: 22px; font-weight: 800; color: var(--tm-text); }
    .bd-sub { margin: 3px 0 0; font-size: 13px; color: var(--tm-text-muted); }
    .bd-add { padding: 9px 14px; border: 0; border-radius: 9px; background: var(--tm-green, #12b35b); color: #fff; font-weight: 800; font-size: 13px; cursor: pointer; white-space: nowrap; }
    .bd-bar { display: flex; align-items: center; gap: 8px; margin: 14px 0; }
    .bd-chip { font-size: 12px; font-weight: 700; color: #556; background: #eef1f4; border-radius: 999px; padding: 5px 11px; }
    .bd-chip--warn { background: #fdf1dc; color: #9a6a11; }
    .bd-spacer { flex: 1; }
    .bd-search { padding: 8px 11px; border: 1px solid var(--tm-line); border-radius: 8px; font-size: 13px; background: #fff; min-width: 180px; }
    .bd-cols { display: flex; gap: 14px; overflow-x: auto; padding-bottom: 8px; align-items: flex-start; }
    .col { flex: 0 0 300px; background: #f7f9fb; border-radius: 12px; display: flex; flex-direction: column; min-height: 140px; border-top: 3px solid transparent; }
    .col--orphan { border-top-color: #e8a13a; }
    .col--group { border-top-color: var(--tm-green, #12b35b); }
    .col.drop { outline: 2px dashed var(--tm-green, #12b35b); outline-offset: -2px; background: #eefaf2; }
    .col__head { display: flex; align-items: center; gap: 8px; padding: 12px 14px 8px; }
    .col__name { font-weight: 800; font-size: 14px; color: var(--tm-text); }
    .col__badge { font-size: 11px; font-weight: 800; background: #fbe6c9; color: #9a6a11; border-radius: 999px; padding: 2px 8px; }
    .col__badge--green { background: #d9f2e3; color: #0e7a3d; }
    .col__spacer { flex: 1; }
    .col__menu { border: 0; background: transparent; cursor: pointer; font-size: 18px; color: var(--tm-text-muted); line-height: 1; position: relative; }
    .menu { position: absolute; right: 14px; margin-top: 4px; background: #fff; border: 1px solid var(--tm-line); border-radius: 8px; box-shadow: 0 6px 18px rgba(0,0,0,.1); z-index: 5; display: flex; flex-direction: column; }
    .menu button { border: 0; background: transparent; padding: 8px 16px; text-align: left; cursor: pointer; font-size: 13px; }
    .menu button:hover { background: #f2f4f6; }
    .menu--danger { color: #c0392b; }
    .col__body { display: flex; flex-direction: column; gap: 10px; padding: 4px 12px 12px; min-height: 40px; }
    .col__empty { font-size: 12px; color: var(--tm-text-muted); padding: 10px 2px; text-align: center; }
    .card { background: #fff; border: 1px solid #eaeef2; border-radius: 12px; padding: 12px; cursor: grab; box-shadow: 0 1px 2px rgba(0,0,0,.04); }
    .card:active { cursor: grabbing; }
    .card__top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    .badge { font-size: 11px; font-weight: 700; background: #e3f4ea; color: #0e7a3d; padding: 3px 9px; border-radius: 999px; }
    .badge--out { background: #fdf0e1; color: #b7791f; }
    .card__fare { font-weight: 800; color: #0e7a3d; font-size: 14px; }
    .card__leg { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--tm-text); padding: 2px 0; }
    .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
    .dot--o { background: #12b35b; }
    .dot--d { background: #e0533d; }
    .card__foot { display: flex; gap: 14px; margin-top: 8px; padding-top: 8px; border-top: 1px solid #f0f2f4; font-size: 12px; color: var(--tm-text-muted); }
    .col__drivers { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 10px 12px; border-top: 1px solid #eceff2; position: relative; }
    .drv-chip { display: inline-flex; align-items: center; gap: 6px; background: #fff; border: 1px solid var(--tm-line); border-radius: 999px; padding: 3px 8px 3px 3px; font-size: 12px; font-weight: 600; }
    .drv-av { width: 20px; height: 20px; border-radius: 50%; background: var(--tm-green, #12b35b); color: #fff; font-size: 9px; font-weight: 800; display: inline-flex; align-items: center; justify-content: center; }
    .drv-chip button { border: 0; background: transparent; cursor: pointer; color: #999; }
    .drv-add { border: 1px dashed var(--tm-line); background: #fff; border-radius: 999px; padding: 4px 10px; font-size: 12px; font-weight: 700; color: var(--tm-text-muted); cursor: pointer; }
    .drv-pick { position: absolute; bottom: 44px; left: 12px; right: 12px; background: #fff; border: 1px solid var(--tm-line); border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.12); padding: 8px; display: flex; flex-direction: column; gap: 4px; max-height: 220px; overflow-y: auto; z-index: 6; }
    .drv-opt { text-align: left; border: 0; background: transparent; padding: 6px 8px; border-radius: 6px; cursor: pointer; font-size: 12.5px; }
    .drv-opt:hover { background: #eef2f6; }
    .col--new { flex: 0 0 220px; border: 2px dashed var(--tm-line); background: transparent; align-items: center; justify-content: center; min-height: 200px; cursor: pointer; }
    .col--new:hover { border-color: var(--tm-green, #12b35b); }
    .new-inner { text-align: center; color: var(--tm-text-muted); }
    .new-plus { width: 40px; height: 40px; border-radius: 50%; background: #eafaf1; color: var(--tm-green, #12b35b); font-size: 22px; font-weight: 800; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 8px; }
    .new-t { font-weight: 800; color: var(--tm-text); font-size: 14px; }
    .new-s { font-size: 12px; margin-top: 2px; }
  `],
})
export class RouteGroupsBoardComponent implements OnInit, OnDestroy {
  @Output() addRoute = new EventEmitter<void>();

  cityId: number | null = null;
  routes: RouteCard[] = [];
  groups: GroupRow[] = [];
  cityDrivers: DriverOpt[] = [];
  search = '';
  driverSearch = '';
  dragId: number | null = null;
  dragFrom: number | null = null;
  dropTarget: number | 'orphan' | 'new' | null = null;
  menuFor: number | null = null;
  driverPickFor: number | null = null;
  private sub?: Subscription;

  constructor(private api: ApiService, private cityCtx: CityContextService, private toast: ToastService) {}

  ngOnInit(): void {
    this.cityCtx.ensureCitiesLoaded().subscribe();
    this.sub = this.cityCtx.cityId$.subscribe((id) => {
      this.cityId = id;
      if (id != null) this.load();
      else { this.routes = []; this.groups = []; this.cityDrivers = []; }
    });
  }
  ngOnDestroy(): void { this.sub?.unsubscribe(); }

  load(): void {
    if (this.cityId == null) return;
    this.api.get<{ data: RouteCard[] }>(`/admin/cities/${this.cityId}/fixed-routes`).subscribe({
      next: (res) => { this.routes = (res?.data || []).filter((r) => r.is_active !== false); },
      error: () => { this.routes = []; },
    });
    this.api.get<{ data: GroupRow[] }>(`/admin/cities/${this.cityId}/route-groups`).subscribe({
      next: (res) => { this.groups = (res?.data || []).map((g) => ({ ...g, route_ids: [...(g.route_ids || [])], driver_user_ids: [...(g.driver_user_ids || [])] })); },
      error: () => { this.groups = []; },
    });
    this.api.get<{ data: DriverOpt[] }>(`/admin/cities/${this.cityId}/route-group-drivers`).subscribe({
      next: (res) => { this.cityDrivers = res?.data || []; },
      error: () => { this.cityDrivers = []; },
    });
  }

  private match(r: RouteCard): boolean {
    const q = this.search.trim().toLowerCase();
    return !q || r.name.toLowerCase().includes(q) || r.origin_name.toLowerCase().includes(q) || r.dest_name.toLowerCase().includes(q);
  }
  get ungrouped(): RouteCard[] {
    const covered = new Set<number>(this.groups.flatMap((g) => g.route_ids));
    return this.routes.filter((r) => !covered.has(r.id));
  }
  get orphanFiltered(): RouteCard[] { return this.ungrouped.filter((r) => this.match(r)); }
  routesFor(g: GroupRow): RouteCard[] { return this.routes.filter((r) => g.route_ids.includes(r.id) && this.match(r)); }
  driversFor(g: GroupRow): DriverOpt[] { return this.cityDrivers.filter((d) => g.driver_user_ids.includes(d.user_id)); }
  driverOptions(g: GroupRow): DriverOpt[] {
    const q = this.driverSearch.trim().toLowerCase();
    return this.cityDrivers.filter((d) => !g.driver_user_ids.includes(d.user_id) && (!q || d.name.toLowerCase().includes(q))).slice(0, 30);
  }
  initials(name: string): string { return (name || '?').split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase(); }

  // ---- Drag & drop ----
  startDrag(routeId: number, fromGroupId: number | null, ev: DragEvent): void {
    this.dragId = routeId; this.dragFrom = fromGroupId;
    ev.dataTransfer?.setData('text/plain', String(routeId));
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
  }
  endDrag(): void { this.dropTarget = null; }
  allow(ev: DragEvent): void { ev.preventDefault(); if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'; }
  clearDrop(which: number | 'orphan' | 'new'): void { if (this.dropTarget === which) this.dropTarget = null; }

  drop(toGroupId: number | 'new' | null): void {
    const routeId = this.dragId; const fromId = this.dragFrom;
    this.dropTarget = null; this.dragId = null; this.dragFrom = null;
    if (routeId == null) return;

    if (toGroupId === 'new') { this.createFromDrop(routeId, fromId); return; }
    if (toGroupId === fromId) return; // no-op

    const from = fromId != null ? this.groups.find((g) => g.id === fromId) : null;
    const to = toGroupId != null ? this.groups.find((g) => g.id === toGroupId) : null;
    if (from) from.route_ids = from.route_ids.filter((id) => id !== routeId);
    if (to && !to.route_ids.includes(routeId)) to.route_ids.push(routeId);

    this.persist([from, to].filter(Boolean) as GroupRow[]);
  }

  private persist(affected: GroupRow[]): void {
    if (this.cityId == null || !affected.length) { this.load(); return; }
    const calls = affected.map((g) => this.api.patch(`/admin/cities/${this.cityId}/route-groups/${g.id}`, { name: g.name, route_ids: g.route_ids }));
    forkJoin(calls.length ? calls : [of(null)]).subscribe({
      next: () => this.load(),
      error: (e) => { this.toast.error(e?.error?.message || 'Could not save.'); this.load(); },
    });
  }

  private createFromDrop(routeId: number, fromId: number | null): void {
    const name = (prompt('Name the new stand') || '').trim();
    if (!name || this.cityId == null) { this.load(); return; }
    this.api.post<{ route_group: GroupRow }>(`/admin/cities/${this.cityId}/route-groups`, { name, route_ids: [routeId] }).subscribe({
      next: () => {
        const from = fromId != null ? this.groups.find((g) => g.id === fromId) : null;
        if (from) { from.route_ids = from.route_ids.filter((id) => id !== routeId); this.persist([from]); }
        else { this.toast.success('Stand created.'); this.load(); }
      },
      error: (e) => { this.toast.error(e?.error?.message || 'Could not create stand.'); this.load(); },
    });
  }

  createEmpty(): void {
    if (this.cityId == null) return;
    const name = (prompt('Name the new stand') || '').trim();
    if (!name) return;
    this.api.post(`/admin/cities/${this.cityId}/route-groups`, { name }).subscribe({
      next: () => { this.toast.success('Stand created.'); this.load(); },
      error: (e) => { this.toast.error(e?.error?.message || 'Could not create stand.'); },
    });
  }

  rename(g: GroupRow): void {
    if (this.cityId == null) return;
    const name = (prompt('Rename stand', g.name) || '').trim();
    if (!name || name === g.name) return;
    this.api.patch(`/admin/cities/${this.cityId}/route-groups/${g.id}`, { name, route_ids: g.route_ids }).subscribe({
      next: () => { this.toast.success('Renamed.'); this.load(); },
      error: (e) => { this.toast.error(e?.error?.message || 'Could not rename.'); },
    });
  }

  remove(g: GroupRow): void {
    if (this.cityId == null) return;
    if (!confirm(`Delete "${g.name}"? Its routes go back to "Needs a stand" unless another stand holds them.`)) return;
    this.api.delete(`/admin/cities/${this.cityId}/route-groups/${g.id}`).subscribe({
      next: () => { this.toast.success('Deleted.'); this.load(); },
      error: (e) => { this.toast.error(e?.error?.message || 'Could not delete.'); },
    });
  }

  addDriver(g: GroupRow, uid: number): void {
    if (!g.driver_user_ids.includes(uid)) g.driver_user_ids.push(uid);
    this.driverSearch = '';
    this.saveDrivers(g);
  }
  removeDriver(g: GroupRow, uid: number): void {
    g.driver_user_ids = g.driver_user_ids.filter((x) => x !== uid);
    this.saveDrivers(g);
  }
  private saveDrivers(g: GroupRow): void {
    if (this.cityId == null) return;
    this.api.put(`/admin/cities/${this.cityId}/route-groups/${g.id}/drivers`, { driver_user_ids: g.driver_user_ids }).subscribe({
      next: () => {},
      error: (e) => { this.toast.error(e?.error?.message || 'Could not update drivers.'); this.load(); },
    });
  }
}
