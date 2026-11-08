import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { ButtonComponent, DrawerComponent } from '../../ui';

interface VehicleMember { id: number; display_name: string; ride_type_name: string | null; vehicle_set_id?: number | null; }
interface SharedGroup { id: number; name: string; route_ids: number[]; }
interface VehicleSet { id: number; name: string; members: { id: number }[]; route_group_ids: number[]; }

@Component({
  selector: 'app-vehicle-sets-editor', standalone: true,
  imports: [CommonModule, FormsModule, ButtonComponent, DrawerComponent],
  template: `
    <tm-drawer [open]="true" title="Vehicle sets and shared stands" [width]="640" (closed)="closed.emit()">
      <div slot="body" class="sets">
        <p>Vehicles in a set share the stands selected here. Routes stay in one place. Choose each driver's stands separately when assigning the driver.</p>
        <p *ngIf="loading">Loading vehicle sets…</p>
        <p *ngIf="loadError">Could not load vehicle sets. <button type="button" (click)="load()">Retry</button></p>
        <ng-container *ngIf="!loading && !loadError">
          <label>Vehicle set
            <select [ngModel]="selectedId" (ngModelChange)="select($event)" [disabled]="saving">
              <option [ngValue]="null">Create a new set</option>
              <option *ngFor="let set of sets" [ngValue]="set.id">{{ set.name }}</option>
            </select>
          </label>
          <label>Set name <input [(ngModel)]="name" maxlength="120" placeholder="For example, Kupwara shared vehicles" [disabled]="saving" /></label>
          <fieldset [disabled]="saving">
            <legend>Vehicles using this set</legend>
            <p>Add a vehicle from the workspace if it is missing here. Each vehicle option can belong to one set.</p>
            <label class="choice" *ngFor="let vehicle of vehicles">
              <input type="checkbox" [checked]="vehicleIds.has(vehicle.id)" (change)="toggle(vehicleIds, vehicle.id)" />
              <span>{{ vehicle.display_name }} <small>{{ vehicle.ride_type_name }}</small>
                <small *ngIf="vehicle.vehicle_set_id && vehicle.vehicle_set_id !== selectedId">Currently in {{ setName(vehicle.vehicle_set_id) }}; selecting it moves it to this set.</small>
              </span>
            </label>
            <p *ngIf="!vehicles.length">No vehicles have been added in this city.</p>
          </fieldset>
          <fieldset [disabled]="saving">
            <legend>Shared stands</legend>
            <p>All selected vehicles can use these stands. New stands created under a member vehicle are shared with its set automatically.</p>
            <label class="choice" *ngFor="let group of groups">
              <input type="checkbox" [checked]="groupIds.has(group.id)" (change)="toggle(groupIds, group.id)" />
              <span>{{ group.name }} <small>{{ group.route_ids.length }} routes</small></span>
            </label>
            <p *ngIf="!groups.length">Create stands in the workspace, then select them here.</p>
          </fieldset>
          <p>Removing a vehicle or stand from this set keeps existing driver assignments. Change those separately if needed.</p>
          <tm-button variant="green" [disabled]="saving || !name.trim()" (clicked)="save()">{{ saving ? 'Saving…' : (selectedId ? 'Save set' : 'Create set') }}</tm-button>
        </ng-container>
      </div>
    </tm-drawer>
  `,
  styles: [`
    .sets { padding: 20px; display: grid; gap: 18px; color: #334155; }
    p { margin: 0; font-size: 13px; line-height: 1.6; }
    label { display: grid; gap: 7px; font-weight: 600; }
    select, input:not([type=checkbox]) { padding: 10px; border: 1px solid #cbd5e1; border-radius: 8px; width: 100%; box-sizing: border-box; }
    fieldset { border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px; display: grid; gap: 12px; }
    legend { font-weight: 700; padding: 0 5px; }
    .choice { display: flex; align-items: flex-start; gap: 10px; font-size: 14px; }
    .choice input { margin-top: 4px; }
    small { display: block; font-weight: 400; color: #64748b; margin-top: 4px; }
  `],
})
export class VehicleSetsEditorComponent implements OnInit {
  @Input() cityId!: number;
  @Input() vehicles: VehicleMember[] = [];
  @Input() groups: SharedGroup[] = [];
  @Output() closed = new EventEmitter<void>();
  @Output() saved = new EventEmitter<void>();
  sets: VehicleSet[] = [];
  loading = false;
  loadError = false;
  saving = false;
  selectedId: number | null = null;
  name = '';
  vehicleIds = new Set<number>();
  groupIds = new Set<number>();
  constructor(private api: ApiService, private toast: ToastService) {}
  ngOnInit(): void { this.load(); }
  load(): void {
    this.loading = true; this.loadError = false;
    this.api.get<{ data: VehicleSet[] }>(`/admin/cities/${this.cityId}/vehicle-sets`).subscribe({
      next: res => { this.sets = res.data ?? []; this.loading = false; },
      error: () => { this.loading = false; this.loadError = true; },
    });
  }
  select(id: number | null): void {
    this.selectedId = id;
    const set = this.sets.find(item => item.id === id);
    this.name = set?.name ?? '';
    this.vehicleIds = new Set(set?.members.map(member => member.id) ?? []);
    this.groupIds = new Set(set?.route_group_ids ?? []);
  }
  setName(id: number): string { return this.sets.find(set => set.id === id)?.name ?? `set #${id}`; }
  toggle(ids: Set<number>, id: number): void { if (ids.has(id)) ids.delete(id); else ids.add(id); }
  save(): void {
    if (this.saving || !this.name.trim()) return;
    this.saving = true;
    const payload = { name: this.name.trim(), vehicle_ids: [...this.vehicleIds], route_group_ids: [...this.groupIds] };
    const url = `/admin/cities/${this.cityId}/vehicle-sets`;
    const request = this.selectedId === null ? this.api.post(url, payload) : this.api.patch(`${url}/${this.selectedId}`, payload);
    request.subscribe({
      next: () => { this.saving = false; this.toast.success('Vehicle set saved'); this.saved.emit(); this.closed.emit(); },
      error: err => { this.saving = false; this.toast.error(err?.error?.message || 'Could not save vehicle set'); },
    });
  }
}
