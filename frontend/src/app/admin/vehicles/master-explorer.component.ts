import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonComponent, IconComponent } from '../../ui';

export type MasterSection = 'routes' | 'drivers' | 'route-groups' | 'vehicle-configuration';
export type RouteGrouping = 'route-set' | 'city-area' | 'scope' | 'type' | 'all-routes' | 'routes';
export interface MasterVehicle { image_url?: string | null; id: number; display_name: string; vehicle_type_id: number | null; vehicle_type_name?: string | null; max_people: number; luggage_capacity: number; is_active: boolean; vehicle_set_id?: number | null; vehicle_set_ids?: number[]; mode_row_ids?: number[]; }
export interface MasterRouteStop { id: number; name?: string; seq?: number; lat?: number | null; lng?: number | null; }
export interface MasterRoute { id: number; name: string; scope: string; origin_name: string; dest_name: string; flat_fare: number | null; booking_window_hours: number | null; is_active: boolean; city_vehicle_type_id: number | null; stops?: MasterRouteStop[]; origin_lat?: number; origin_lng?: number; dest_lat?: number; dest_lng?: number; path_polyline?: { lat: number; lng: number }[] | null; image_url?: string | null; }
export interface MasterGroup { id: number; name: string; is_active: boolean; city_vehicle_type_id: number | null; route_ids: number[]; driver_user_ids: number[]; vehicle_set_ids?: number[]; }
export interface MasterDriver { avatar_url?: string | null; id: number; user_id: number; name: string; phone: string | null; city_vehicle_type_id: number | null; vehicle_type_id: number | null; vehicle_reg_no: string | null; vehicle_model: string | null; vehicle_color: string | null; }
export interface MasterAction { kind: 'add-route' | 'edit-route' | 'toggle-route' | 'import' | 'add-group' | 'edit-group' | 'group-drivers' | 'delete-group' | 'driver'; id?: number; vehicleId?: number | null; }
interface Node { key: string; name: string; kind: 'root' | 'scope' | 'area' | 'type' | 'group' | 'route'; ids: number[]; children: Node[]; id?: number; scope?: string; }
interface Row { node: Node; depth: number; trackKey: string; }

@Component({
  selector: 'app-master-explorer', standalone: true,
  imports: [CommonModule, FormsModule, ButtonComponent, IconComponent],
  templateUrl: './master-explorer.component.html',
  styleUrls: ['./master-explorer.component.scss'],
})
export class MasterExplorerComponent implements OnChanges {
  @Input() section: MasterSection = 'routes';
  @Input() cityId: number | null = null;
  @Input() cityName = '';
  @Input() loading = false;
  @Input() vehicles: MasterVehicle[] = [];
  @Input() routes: MasterRoute[] = [];
  @Input() groups: MasterGroup[] = [];
  @Input() drivers: MasterDriver[] = [];
  @Input() groupCreating = false;
  @Input() groupCreatedVersion = 0;
  @Output() groupCreate = new EventEmitter<{ name: string; vehicleId: number }>();
  groupCreatorOpen = false;
  newGroupName = '';
  @Output() action = new EventEmitter<MasterAction>();
  search = '';
  scope = 'all';
  status = 'all';
  vehicleId: number | null = null;
  grouping: RouteGrouping = 'route-set';
  selectedKey = '';
  expanded = new Set<string>();
  menuKey = '';
  ngOnChanges(changes: SimpleChanges): void {
    if (changes['cityId'] || changes['section'] || (changes['groupCreatedVersion'] && !changes['groupCreatedVersion'].firstChange)) { this.groupCreatorOpen = false; this.newGroupName = ''; }
    if (changes['cityId']) { this.vehicleId = null; this.search = ''; this.scope = 'all'; this.status = 'all'; }
    if (changes['section']) { this.search = ''; this.scope = 'all'; this.status = 'all'; }
    if (changes['cityId'] || changes['section']) this.restoreView();
    if (this.vehicleId !== null && !this.loading && this.vehicles.length && changes['vehicles'] && !this.vehicles.some(vehicle => vehicle.id === this.vehicleId)) { this.vehicleId = null; this.saveView(); }
  }
  get selectedVehicle(): MasterVehicle | undefined { return this.vehicles.find(vehicle => vehicle.id === this.vehicleId); }
  get vehicleRoutes(): MasterRoute[] {
    const groupIds = new Set(this.groups.filter(group => this.groupUsesVehicle(group)).flatMap(group => group.route_ids));
    return this.routes.filter(route => this.vehicleId === null || route.city_vehicle_type_id === this.vehicleId || groupIds.has(route.id));
  }
  private groupUsesVehicle(group: MasterGroup): boolean {
    if (this.vehicleId === null || group.city_vehicle_type_id === this.vehicleId) return true;
    const vehicle = this.selectedVehicle;
    if (!vehicle) return false;
    return (vehicle.mode_row_ids ?? [vehicle.id]).includes(group.city_vehicle_type_id ?? -1)
      || (group.vehicle_set_ids ?? []).some(id => (vehicle.vehicle_set_ids ?? (vehicle.vehicle_set_id ? [vehicle.vehicle_set_id] : [])).includes(id));
  }
  get vehicleGroups(): MasterGroup[] { return this.groups.filter(group => this.groupUsesVehicle(group) || group.route_ids.some(id => this.vehicleRoutes.some(route => route.id === id))); }
  get vehicleDrivers(): MasterDriver[] {
    const vehicle = this.selectedVehicle;
    return this.drivers.filter(driver => !vehicle || driver.city_vehicle_type_id === vehicle.id || (vehicle.vehicle_type_id !== null && driver.vehicle_type_id === vehicle.vehicle_type_id) || this.driverGroups(driver.user_id).some(group => this.vehicleGroups.some(item => item.id === group.id)));
  }
  submitGroup(): void {
    const name = this.newGroupName.trim(); const vehicleId = this.targetVehicleId;
    if (name && vehicleId && !this.groupCreating) this.groupCreate.emit({ name, vehicleId });
  }
  changeVehicle(): void { this.groupCreatorOpen = false; this.newGroupName = ''; this.selectedKey = ''; this.expanded.clear(); this.menuKey = ''; this.saveView(); }
  get targetVehicleId(): number | null { return this.vehicleId ?? (this.vehicles.length === 1 ? this.vehicles[0].id : null); }
  private matches(text: string): boolean { return text.toLowerCase().includes(this.search.trim().toLowerCase()); }
  get scopedRoutes(): MasterRoute[] {
    return this.vehicleRoutes.filter(route =>
      (this.scope === 'all' || route.scope === this.scope) && (this.status === 'all' || route.is_active === (this.status === 'active')));
  }
  get scopedGroups(): MasterGroup[] {
    return this.vehicleGroups;
  }
  get shownGroups(): MasterGroup[] { return this.scopedGroups.filter(group => this.matches(group.name) && (this.status === 'all' || group.is_active === (this.status === 'active'))); }
  get shownDrivers(): MasterDriver[] {
    return this.vehicleDrivers.filter(driver => this.matches(`${driver.name} ${driver.phone ?? ''} ${driver.vehicle_reg_no ?? ''}`));
  }
  get tree(): Node {
    if (this.grouping !== 'all-routes') return this.groupedTree;
    const root: Node = { key: 'root', name: 'All Routes', kind: 'root', ids: [], children: [] };
    for (const scope of ['local', 'outstation']) {
      if (this.scope !== 'all' && this.scope !== scope) continue;
      const area: Node = { key: `area:${scope}`, name: `${this.cityName || 'Selected city'} area`, kind: 'area', scope, ids: [], children: [] };
      for (const group of this.scopedGroups) {
        const routes = this.scopedRoutes.filter(route => route.scope === scope && group.route_ids.includes(route.id) && (this.matches(group.name) || this.matches(`${route.name} ${route.origin_name} ${route.dest_name}`)));
        if (!routes.length && (this.search || group.route_ids.length || scope !== 'local' || this.status !== 'all')) continue;
        area.children.push({ key: `group:${scope}:${group.id}`, name: group.name, kind: 'group', scope, id: group.id, ids: routes.map(route => route.id), children: routes.map(route => this.routeNode(route)) });
      }
      const loose = this.scopedRoutes.filter(route => route.scope === scope && !this.groups.some(group => group.route_ids.includes(route.id)) && this.matches(`${route.name} ${route.origin_name} ${route.dest_name}`));
      if (loose.length) area.children.push({ key: `loose:${scope}`, name: 'Routes without a stand', kind: 'group', scope, ids: loose.map(route => route.id), children: loose.map(route => this.routeNode(route)) });
      area.ids = [...new Set(area.children.flatMap(node => node.ids))];
      if (area.children.length) root.children.push({ key: scope, name: scope === 'local' ? 'Local' : 'Outstation', kind: 'scope', scope, ids: area.ids, children: [area] });
    }
    root.ids = [...new Set(root.children.flatMap(node => node.ids))];
    return root;
  }
  private get matchingRoutes(): MasterRoute[] {
    return this.scopedRoutes.filter(route => this.matches(`${route.name} ${route.origin_name} ${route.dest_name}`) || this.scopedGroups.some(group => group.route_ids.includes(route.id) && this.matches(group.name)));
  }
  private get groupedTree(): Node {
    const routes = this.matchingRoutes;
    const root: Node = { key: 'root', name: 'All Routes', kind: 'root', ids: routes.map(route => route.id), children: [] };
    const branch = (key: string, name: string, kind: Node['kind'], members: MasterRoute[], id?: number, scope?: string): Node => ({ key, name, kind, id, scope, ids: members.map(route => route.id), children: members.map(route => this.routeNode(route)) });
    if (this.grouping === 'route-set') {
      for (const group of this.scopedGroups) {
        const members = routes.filter(route => group.route_ids.includes(route.id));
        if (members.length || (!group.route_ids.length && this.matches(group.name) && this.status === 'all')) root.children.push(branch(`group:${group.id}`, group.name, 'group', members, group.id));
      }
      const loose = routes.filter(route => !this.groups.some(group => group.route_ids.includes(route.id)));
      if (loose.length) root.children.push(branch('loose', 'Routes without a stand', 'group', loose));
    } else if (this.grouping === 'city-area') {
      if (routes.length) root.children.push(branch('area', `${this.cityName || 'Selected city'} area`, 'area', routes));
    } else if (this.grouping === 'scope') {
      for (const scope of ['local', 'outstation']) {
        const members = routes.filter(route => route.scope === scope);
        if (members.length) root.children.push(branch(scope, scope === 'local' ? 'Local' : 'Outstation', 'scope', members, undefined, scope));
      }
    } else if (this.grouping === 'type') {
      // The operational catalog is explicitly filtered to Fixed by the existing API.
      if (routes.length) root.children.push(branch('type:fixed', 'Fixed', 'type', routes));
    } else root.children = routes.map(route => this.routeNode(route));
    return root;
  }
  private get viewStorageKey(): string { return `master-route-view:v1:${this.cityId ?? 'none'}`; }
  private saveView(): void {
    if (this.cityId === null) return;
    try { localStorage.setItem(this.viewStorageKey, JSON.stringify({ grouping: this.grouping, vehicleId: this.vehicleId })); } catch { /* Keep the view usable when browser storage is unavailable. */ }
  }
  private restoreView(): void {
    this.grouping = 'route-set'; this.vehicleId = null; this.selectedKey = ''; this.expanded.clear(); this.menuKey = '';
    if (this.cityId === null) return;
    try {
      const saved = JSON.parse(localStorage.getItem(this.viewStorageKey) ?? 'null');
      if (!saved || !['route-set', 'city-area', 'scope', 'type', 'all-routes', 'routes'].includes(saved.grouping)) return;
      this.grouping = saved.grouping;
      if (Number.isInteger(saved.vehicleId) && saved.vehicleId > 0) this.vehicleId = saved.vehicleId;

    } catch { /* Ignore an invalid or unavailable saved preference. */ }
  }
  changeGrouping(): void { this.selectedKey = ''; this.expanded.clear(); this.menuKey = ''; this.saveView(); }
  collapseAll(): void { this.expanded.clear(); this.menuKey = ''; }
  private routeNode(route: MasterRoute): Node { return { key: `route:${route.id}`, name: route.name, kind: 'route', id: route.id, scope: route.scope, ids: [route.id], children: [] }; }
  get rows(): Row[] {
    const rows: Row[] = [];
    const walk = (node: Node, depth: number, path: string) => { const trackKey = `${path}/${node.key}`; rows.push({ node, depth, trackKey }); if (this.expanded.has(node.key)) node.children.forEach(child => walk(child, depth + 1, trackKey)); };
    if (this.grouping === 'all-routes') walk(this.tree, 0, '');
    else this.tree.children.forEach(node => walk(node, 0, ''));
    return rows;
  }
  get selected(): Node | undefined {
    const find = (node: Node): Node | undefined => node.key === this.selectedKey ? node : node.children.map(find).find(Boolean);
    return find(this.tree);
  }
  routeIsActive(id: number): boolean { return !!this.routes.find(route => route.id === id)?.is_active; }
  get selectedRoute(): MasterRoute | undefined { return this.selected?.kind === 'route' ? this.routes.find(route => route.id === this.selected?.id) : undefined; }
  get selectedGroup(): MasterGroup | undefined { return this.selected?.kind === 'group' ? this.groups.find(group => group.id === this.selected?.id) : undefined; }
  get selectedRoutes(): MasterRoute[] { return this.routes.filter(route => this.selected?.ids.includes(route.id)); }
  get selectedDrivers(): MasterDriver[] {
    const ids = new Set(this.groups.filter(group => this.selectedGroup ? group.id === this.selectedGroup.id : group.route_ids.some(id => this.selected?.ids.includes(id))).flatMap(group => group.driver_user_ids));
    return this.drivers.filter(driver => ids.has(driver.user_id));
  }
  choose(node: Node, trackKey?: string): void {
    const paths: Node[][] = [];
    const walk = (current: Node, ancestors: Node[]) => {
      const path = [...ancestors, current];
      if (current.key === node.key) paths.push(path);
      current.children.forEach(child => walk(child, path));
    };
    walk(this.tree, []);
    const visiblePath = (path: Node[]) => this.grouping === 'all-routes' ? path : path.slice(1);
    const score = (path: Node[]) => (path.some(part => part.key === this.selectedKey) ? 1000 : 0) + path.filter(part => this.expanded.has(part.key)).length;
    const path = trackKey
      ? paths.find(path => '/' + visiblePath(path).map(part => part.key).join('/') === trackKey)
      : paths.sort((a, b) => score(b) - score(a))[0];
    if (path) visiblePath(path).filter(part => part.kind !== 'route').forEach(part => {
      if (!this.expanded.has(part.key)) this.toggle(part.key);
    });
    this.selectedKey = node.key;
    this.menuKey = '';
  }
  chooseRoute(route: MasterRoute): void { this.choose(this.routeNode(route)); }
  toggle(key: string): void {
    const close = (node: Node) => { this.expanded.delete(node.key); node.children.forEach(close); };
    const findSiblings = (node: Node): Node[] | undefined => node.children.some(child => child.key === key) ? node.children : node.children.map(findSiblings).find(Boolean);
    const root = this.tree;
    const siblings = key === root.key ? [root] : findSiblings(root);
    const target = siblings?.find(node => node.key === key);
    if (!target || target.kind === 'route') return;
    if (this.expanded.has(key)) close(target);
    else { siblings!.forEach(close); this.expanded.add(key); }
    this.menuKey = '';
  }
  track(_: number, row: Row): string { return row.trackKey; }
  routeDrivers(id: number): MasterDriver[] { const ids = new Set(this.groups.filter(group => group.route_ids.includes(id)).flatMap(group => group.driver_user_ids)); return this.drivers.filter(driver => ids.has(driver.user_id)); }
  driverGroups(userId: number): MasterGroup[] { return this.groups.filter(group => group.driver_user_ids.includes(userId)); }
  driverRoutes(userId: number): number { return new Set(this.driverGroups(userId).flatMap(group => group.route_ids)).size; }
  vehicleName(id: number | null): string { return this.vehicles.find(vehicle => vehicle.id === id)?.display_name ?? 'Not bound to a vehicle'; }
  groupRoutes(group: MasterGroup): MasterRoute[] { return this.routes.filter(route => group.route_ids.includes(route.id)); }
  emit(kind: MasterAction['kind'], id?: number, vehicleId: number | null = this.targetVehicleId): void { this.menuKey = ''; this.action.emit({ kind, id, vehicleId }); }
  exportRoutes(): void {
    const rows = [['Route', 'Origin', 'Destination', 'Scope', 'Ticket price', 'Status'], ...this.scopedRoutes.filter(route => this.matches(`${route.name} ${route.origin_name} ${route.dest_name}`) || this.groups.some(group => group.route_ids.includes(route.id) && this.matches(group.name))).map(route => [route.name, route.origin_name, route.dest_name, route.scope, route.flat_fare ?? '', route.is_active ? 'Enabled' : 'Disabled'])];
    const csv = rows.map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'routes.csv'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
