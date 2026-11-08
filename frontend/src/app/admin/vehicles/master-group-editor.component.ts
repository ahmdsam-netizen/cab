import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonComponent, DrawerComponent, IconComponent } from '../../ui';
import { ApiService } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { MasterDriver, MasterGroup, MasterRoute } from './master-explorer.component';

@Component({
  selector: 'app-master-group-editor', standalone: true,
  imports: [CommonModule, FormsModule, ButtonComponent, DrawerComponent, IconComponent],
  templateUrl: './master-group-editor.component.html', styleUrls: ['./master-group-editor.component.scss'],
})
export class MasterGroupEditorComponent implements OnChanges {
  @Input() group!: MasterGroup;
  @Input() cityId!: number;
  @Input() vehicleName = '';
  @Input() routes: MasterRoute[] = [];
  @Input() drivers: MasterDriver[] = [];
  @Output() closed = new EventEmitter<void>();
  @Output() saved = new EventEmitter<void>();
  @Output() editRoute = new EventEmitter<number>();
  tab: 'routes' | 'drivers' = 'routes';
  name = '';
  routeIds = new Set<number>();
  driverIds = new Set<number>();
  search = '';
  onlySelected = true;
  saving = false;
  private initialGroupId: number | null = null;
  private initialName = '';
  private initialRoutes: number[] = [];
  private initialDrivers: number[] = [];
  constructor(private api: ApiService, private toast: ToastService) {}
  ngOnChanges(changes: SimpleChanges): void {
    if (changes['group'] && this.group.id !== this.initialGroupId) {
      this.initialGroupId = this.group.id; this.name = this.initialName = this.group.name;
      this.initialRoutes = [...this.group.route_ids]; this.initialDrivers = [...this.group.driver_user_ids];
      this.routeIds = new Set(this.initialRoutes); this.driverIds = new Set(this.initialDrivers);
      this.tab = 'routes'; this.search = ''; this.onlySelected = true;
    }
  }
  setTab(tab: 'routes' | 'drivers'): void { if (this.saving) return; this.tab = tab; this.search = ''; this.onlySelected = true; }
  setView(selected: boolean): void { this.onlySelected = selected; this.search = ''; }
  get shownRoutes(): MasterRoute[] {
    const query = this.search.trim().toLowerCase();
    return this.routes.filter(route => (!this.onlySelected || this.routeIds.has(route.id)) && `${route.name} ${route.origin_name} ${route.dest_name}`.toLowerCase().includes(query));
  }
  get shownDrivers(): MasterDriver[] {
    const query = this.search.trim().toLowerCase();
    return this.drivers.filter(driver => (!this.onlySelected || this.driverIds.has(driver.user_id)) && `${driver.name} ${driver.phone ?? ''} ${driver.vehicle_reg_no ?? ''}`.toLowerCase().includes(query));
  }
  canSelectRoute(route: MasterRoute): boolean { return this.routeIds.has(route.id) || (route.flat_fare !== null && route.flat_fare > 0); }
  toggleRoute(route: MasterRoute): void { if (this.saving || !this.canSelectRoute(route)) return; this.routeIds.has(route.id) ? this.routeIds.delete(route.id) : this.routeIds.add(route.id); }
  toggleDriver(userId: number): void { if (this.saving) return; this.driverIds.has(userId) ? this.driverIds.delete(userId) : this.driverIds.add(userId); }
  private changed(ids: Set<number>, original: number[]): boolean { return ids.size !== original.length || original.some(id => !ids.has(id)); }
  get routesChanged(): boolean { return this.name.trim() !== this.initialName || this.changed(this.routeIds, this.initialRoutes); }
  get driversChanged(): boolean { return this.changed(this.driverIds, this.initialDrivers); }
  get dirty(): boolean { return this.tab === 'routes' ? this.routesChanged : this.driversChanged; }
  get hasOtherChanges(): boolean { return this.tab === 'routes' ? this.driversChanged : this.routesChanged; }
  save(): void {
    if (this.saving || !this.dirty || (this.tab === 'routes' && !this.name.trim())) return;
    const tab = this.tab;
    const name = this.name.trim(), routeIds = [...this.routeIds], driverIds = [...this.driverIds];
    const url = `/admin/cities/${this.cityId}/route-groups/${this.group.id}`;
    this.saving = true;
    const request = tab === 'routes' ? this.api.patch(url, { name, route_ids: routeIds }) : this.api.put(`${url}/drivers`, { driver_user_ids: driverIds });
    request.subscribe({
      next: () => {
        this.saving = false;
        if (tab === 'routes') { this.name = this.initialName = name; this.initialRoutes = routeIds; }
        else this.initialDrivers = driverIds;
        this.toast.success(tab === 'routes' ? 'Stand routes updated' : 'Stand drivers updated'); this.saved.emit();
      },
      error: (error) => { this.saving = false; this.toast.error(error?.error?.message || 'Could not save stand changes'); },
    });
  }
}
