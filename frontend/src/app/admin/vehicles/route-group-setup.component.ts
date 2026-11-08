import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonComponent, DrawerComponent, IconComponent } from '../../ui';
import { ApiService } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { MasterDriver, MasterGroup, MasterRoute } from './master-explorer.component';

export interface SetupVehicle { id: number; display_name: string; vehicle_type_id: number | null; ride_type_name?: string | null; vehicle_set_id?: number | null; is_active?: boolean; image_url?: string | null; }
export interface SetupVehicleSet { id: number; name: string; members?: { id: number; display_name?: string }[]; route_group_ids?: number[]; }

@Component({
  selector: 'app-route-group-setup', standalone: true,
  imports: [CommonModule, FormsModule, ButtonComponent, DrawerComponent, IconComponent],
  templateUrl: './route-group-setup.component.html', styleUrls: ['./route-group-setup.component.scss'],
})
export class RouteGroupSetupComponent implements OnChanges {
  @Input() cityId!: number;
  @Input() group: MasterGroup | null = null;
  @Input() initialSection: 'routes' | 'vehicles' | 'drivers' = 'routes';
  @Input() initialRouteId: number | null = null;
  @Input() routes: MasterRoute[] = [];
  @Input() vehicles: SetupVehicle[] = [];
  @Input() sets: SetupVehicleSet[] = [];
  @Input() drivers: MasterDriver[] = [];
  @Output() closed = new EventEmitter<void>();
  @Output() saved = new EventEmitter<void>();
  @Output() addRoute = new EventEmitter<number>();
  @Output() addVehicle = new EventEmitter<void>();
  name = '';
  extraNames: string[] = [];
  active = true;
  routeIds = new Set<number>();
  driverIds = new Set<number>();
  setIds = new Set<number>();
  vehicleIds = new Set<number>();
  routeSearch = '';
  driverSearch = '';
  vehicleSearch = '';
  selectedOnly = false;
  failedDriverPhotos = new Set<string>();
  failedVehiclePhotos = new Set<string>();
  vehiclePhoto(ids: number[]): string | null {
    return this.vehicles.find(vehicle => ids.includes(vehicle.id) && vehicle.image_url && !this.failedVehiclePhotos.has(vehicle.image_url))?.image_url ?? null;
  }
  setPhoto(set: SetupVehicleSet): string | null {
    return this.vehiclePhoto([...(set.members ?? []).map(member => member.id), ...this.vehicles.filter(vehicle => vehicle.vehicle_set_id === set.id).map(vehicle => vehicle.id)]);
  }
  saving = false;
  error = '';
  section: 'routes' | 'vehicles' | 'drivers' = 'routes';
  routeVehicleId: number | null = null;
  ownerVehicleId: number | null = null;
  private initialized = false;
  private initial = '';
  private beforeRouteCreate: Set<number> | null = null;
  private beforeVehicleCreate: Set<number> | null = null;
  ngOnChanges(changes: SimpleChanges): void {
    if (!this.initialized || changes['cityId'] || changes['group']) {
      this.initialized = true;
      this.section = this.initialSection;
      this.selectedOnly = false;
      this.routeSearch = ''; this.vehicleSearch = ''; this.driverSearch = '';
      this.name = this.group?.name ?? '';
      this.extraNames = [];
      this.active = this.group?.is_active ?? true;
      this.ownerVehicleId = this.group?.city_vehicle_type_id ?? null;
      this.routeIds = new Set(this.group?.route_ids ?? []);
      this.driverIds = new Set(this.group?.driver_user_ids ?? []);
      this.setIds = new Set(this.group?.vehicle_set_ids ?? []);
      this.vehicleIds = new Set();
      this.initial = this.signature();
      if (this.initialRouteId) this.routeIds.add(this.initialRouteId);
    }
    if (changes['routes'] && this.beforeRouteCreate) {
      const added = this.routes.filter(route => !this.beforeRouteCreate!.has(route.id));
      if (added.length) {
        added.filter(route => this.selectable(route)).forEach(route => this.routeIds.add(route.id));
        this.beforeRouteCreate = null;
      }
    }
    if (!this.routeVehicleOptions.some(vehicle => vehicle.id === this.routeVehicleId)) this.routeVehicleId = this.routeVehicleOptions[0]?.id ?? null;
    if (changes['vehicles'] && this.beforeVehicleCreate) {
      const added = this.vehicles.filter(vehicle => !this.beforeVehicleCreate!.has(vehicle.id));
      if (added.length) { added.forEach(vehicle => vehicle.vehicle_set_id ? this.setIds.add(vehicle.vehicle_set_id) : this.vehicleIds.add(vehicle.id)); this.beforeVehicleCreate = null; }
    }
  }
  constructor(private api: ApiService, private toast: ToastService) {}
  get routeVehicleOptions(): SetupVehicle[] {
    const choices = new Map<string, SetupVehicle>();
    for (const vehicle of this.vehicles) {
      const mode = (vehicle.ride_type_name ?? '').trim().toLowerCase();
      if (vehicle.is_active === false || (mode && !mode.includes('fixed'))) continue;
      const key = `${vehicle.vehicle_type_id}:${vehicle.display_name.trim().toLowerCase()}`;
      const previous = choices.get(key);
      // Prefer an explicit fixed configuration over a legacy base row.
      if (!previous || (!previous.ride_type_name && mode)) choices.set(key, vehicle);
    }
    return [...choices.values()];
  }
  get standaloneVehicles(): { name: string; ids: number[] }[] {
    const families = new Map<string, { name: string; ids: number[] }>();
    this.vehicles.filter(vehicle => !vehicle.vehicle_set_id).forEach(vehicle => {
      const key = `${vehicle.vehicle_type_id}:${vehicle.display_name}`;
      const family = families.get(key) ?? { name: vehicle.display_name, ids: [] };
      family.ids.push(vehicle.id); families.set(key, family);
    });
    return [...families.values()];
  }
  setMembers(set: SetupVehicleSet): string { return [...new Set([...(set.members ?? []).map(member => member.display_name || this.vehicles.find(vehicle => vehicle.id === member.id)?.display_name), ...this.vehicles.filter(vehicle => vehicle.vehicle_set_id === set.id).map(vehicle => vehicle.display_name)].filter(Boolean))].join(', ') || 'Shared vehicle set'; }
  toggle(ids: Set<number>, id: number): void { if (this.saving) return; ids.has(id) ? ids.delete(id) : ids.add(id); }
  toggleFamily(ids: number[]): void {
    if (this.saving) return;
    const selected = this.familySelected(ids);
    if (selected && this.ownerVehicleId !== null && ids.includes(this.ownerVehicleId)) this.ownerVehicleId = null;
    if (!selected && this.ownerVehicleId === null && this.group?.city_vehicle_type_id && ids.includes(this.group.city_vehicle_type_id)) {
      this.ownerVehicleId = this.group.city_vehicle_type_id;
      return;
    }
    ids.forEach(id => selected ? this.vehicleIds.delete(id) : this.vehicleIds.add(id));
  }
  familySelected(ids: number[]): boolean { return (this.ownerVehicleId !== null && ids.includes(this.ownerVehicleId)) || ids.every(id => this.vehicleIds.has(id)); }
  trackFamily(_: number, family: { ids: number[] }): string { return family.ids.join(','); }
  trackName(index: number): number { return index; }
  selectable(route: MasterRoute): boolean { return route.is_active && route.flat_fare !== null && route.flat_fare > 0; }
  get shownRoutes(): MasterRoute[] { const query = this.routeSearch.toLowerCase().trim(); return this.routes.filter(route => (!this.selectedOnly || this.routeIds.has(route.id)) && `${route.name} ${route.origin_name} ${route.dest_name}`.toLowerCase().includes(query)); }
  get shownDrivers(): MasterDriver[] { const query = this.driverSearch.toLowerCase().trim(); return this.drivers.filter(driver => (!this.selectedOnly || this.driverIds.has(driver.user_id)) && `${driver.name} ${driver.phone ?? ''} ${driver.vehicle_reg_no ?? ''}`.toLowerCase().includes(query)); }
  get shownVehicleSets(): SetupVehicleSet[] { const query = this.vehicleSearch.toLowerCase().trim(); return this.sets.filter(set => (!this.selectedOnly || this.setIds.has(set.id)) && `${set.name} ${this.setMembers(set)}`.toLowerCase().includes(query)); }
  get shownStandaloneVehicles(): { name: string; ids: number[] }[] { const query = this.vehicleSearch.toLowerCase().trim(); return this.standaloneVehicles.filter(vehicle => (!this.selectedOnly || this.familySelected(vehicle.ids)) && vehicle.name.toLowerCase().includes(query)); }
  changeSection(section: 'routes' | 'vehicles' | 'drivers'): void { this.section = section; this.selectedOnly = false; }
  get selectedVehicleLabels(): string[] {
    const ids = new Set(this.vehicleIds);
    if (this.ownerVehicleId !== null) ids.add(this.ownerVehicleId);
    for (const set of this.sets.filter(set => this.setIds.has(set.id))) {
      (set.members ?? []).forEach(member => ids.add(member.id));
      this.vehicles.filter(vehicle => vehicle.vehicle_set_id === set.id).forEach(vehicle => ids.add(vehicle.id));
    }
    const families = new Map<string, string>();
    for (const id of ids) {
      const vehicle = this.vehicles.find(vehicle => vehicle.id === id);
      const member = this.sets.flatMap(set => set.members ?? []).find(member => member.id === id);
      const name = vehicle?.display_name || member?.display_name || `Vehicle #${id}`;
      families.set(`${vehicle?.vehicle_type_id ?? ''}:${name.toLowerCase()}`, name);
    }
    return [...families.values()].sort((a, b) => a.localeCompare(b));
  }
  get routeSummary(): string { return this.summary(this.routes.filter(route => this.routeIds.has(route.id)).map(route => route.name), 'Choose routes'); }
  get vehicleSummary(): string { return this.summary(this.selectedVehicleLabels, this.setIds.size ? `${this.setIds.size} shared sets selected` : 'Choose vehicles'); }
  get driverSummary(): string { return this.summary(this.drivers.filter(driver => this.driverIds.has(driver.user_id)).map(driver => driver.name), 'Choose drivers'); }
  private summary(names: string[], empty: string): string { return names.length ? names.slice(0, 2).join(', ') + (names.length > 2 ? ` +${names.length - 2} more` : '') : empty; }
  selectShownRoutes(): void { if (!this.saving) this.shownRoutes.filter(route => this.selectable(route)).forEach(route => this.routeIds.add(route.id)); }
  selectShownDrivers(): void { if (!this.saving) this.shownDrivers.forEach(driver => this.driverIds.add(driver.user_id)); }
  get groupNames(): string[] { return [this.name, ...this.extraNames].map(name => name.trim()); }
  get namesValid(): boolean { const names = this.groupNames; return names.every(name => !!name && name.length <= 120) && new Set(names.map(name => name.toLowerCase())).size === names.length; }
  get selectedVehicleCount(): number { return this.selectedVehicleLabels.length; }
  private signature(): string { return JSON.stringify([this.groupNames, this.active, this.ownerVehicleId, ...[this.routeIds, this.driverIds, this.setIds, this.vehicleIds].map(ids => [...ids].sort((a, b) => a - b))]); }
  get dirty(): boolean { return !this.group || this.signature() !== this.initial; }
  createRoute(): void { if (!this.routeVehicleOptions.some(vehicle => vehicle.id === this.routeVehicleId) || this.saving) return; this.beforeRouteCreate = new Set(this.routes.map(route => route.id)); this.addRoute.emit(this.routeVehicleId!); }
  createVehicles(): void { if (!this.saving) { this.beforeVehicleCreate = new Set(this.vehicles.map(vehicle => vehicle.id)); this.addVehicle.emit(); } }
  close(): void { if (!this.saving && (!this.dirty || !this.groupNames.some(name => !!name) || confirm('Discard your unsaved stand changes?'))) this.closed.emit(); }
  save(): void {
    if (this.saving || !this.namesValid || !this.dirty) return;
    this.saving = true; this.error = '';
    const body = { name: this.name.trim(), is_active: this.active, city_vehicle_type_id: this.ownerVehicleId, route_ids: [...this.routeIds], driver_user_ids: [...this.driverIds], vehicle_set_ids: [...this.setIds], vehicle_ids: [...this.vehicleIds] };
    const url = `/admin/cities/${this.cityId}/route-groups`;
    const request = this.group ? this.api.put(`${url}/${this.group.id}/setup`, body) : this.extraNames.length ? this.api.post(`${url}/setup-batch`, { ...body, names: this.groupNames }) : this.api.post(`${url}/setup`, body);
    request.subscribe({
      next: () => { this.saving = false; this.initial = this.signature(); this.toast.success(this.extraNames.length ? `${this.groupNames.length} stands, vehicles and drivers saved` : 'Stand, vehicles and drivers saved'); this.saved.emit(); this.closed.emit(); },
      error: err => { this.saving = false; this.error = err?.error?.errors ? Object.values(err.error.errors).flat()[0] as string : err?.error?.message || 'Could not save setup. Your selections are kept; try again.'; },
    });
  }
}
