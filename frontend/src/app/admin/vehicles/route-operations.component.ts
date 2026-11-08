import { Component, ElementRef, EventEmitter, Input, OnChanges, Output, SimpleChanges, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonComponent, DrawerComponent, IconComponent } from '../../ui';
import { DriverRouteGroupsPanelComponent } from '../drivers/driver-route-groups-panel.component';
import { MasterAction, MasterDriver, MasterGroup, MasterRoute, MasterVehicle, MasterExplorerComponent, RouteGrouping } from './master-explorer.component';
import { RouteGroupSetupComponent, SetupVehicle, SetupVehicleSet } from './route-group-setup.component';
import { AddVehiclesComponent } from './add-vehicles.component';
import { RouteNetworkMapComponent } from './route-network-map.component';
import { StandRenameComponent } from './stand-rename.component';
import { RouteCopyComponent } from './route-copy.component';

export type OperationsAction = MasterAction | { kind: 'add-vehicle' | 'vehicle-types' | 'vehicle-sets' | 'edit-vehicle' | 'toggle-vehicle' | 'vehicle-layouts' | 'vehicle-fare' | 'vehicle-assets' | 'vehicle-drivers' | 'copy-vehicles' | 'bulk-enable' | 'bulk-disable' | 'export-vehicles'; id?: number; vehicleId?: number | null; rideTypeId?: number; ids?: number[] };
type View = 'routes' | 'vehicles' | 'drivers';
type RouteDetailTab = 'overview' | 'browse' | 'ungrouped' | 'copied' | 'groups' | 'tools';
interface DirectoryRow { key: string; depth: number; name: string; kind: string; id?: number; ids: number[]; route?: MasterRoute; }
@Component({
  selector: 'app-route-operations', standalone: true,
  imports: [CommonModule, FormsModule, ButtonComponent, DrawerComponent, IconComponent, RouteGroupSetupComponent, DriverRouteGroupsPanelComponent, AddVehiclesComponent, RouteNetworkMapComponent, StandRenameComponent, RouteCopyComponent],
  templateUrl: './route-operations.component.html', styleUrls: ['./route-operations.component.scss'],
})
export class RouteOperationsComponent implements OnChanges {
  @Input() cityId!: number;
  @Input() cityName = '';
  @Input() countryCode = '';
  @Input() loading = false;
  @Input() loadError = '';
  @Input() routes: MasterRoute[] = [];
  @Input() groups: MasterGroup[] = [];
  @Input() vehicles: MasterVehicle[] = [];
  @Input() vehicleRows: SetupVehicle[] = [];
  @Input() sets: SetupVehicleSet[] = [];
  @Input() drivers: MasterDriver[] = [];
  @Input() fareModes: { id: number; name: string }[] = [];
  @Input() vehicleTypeOptions: { id: number; name: string }[] = [];
  @Input() editId: number | null = null;
  @Input() editField = '';
  @Input() editValue = '';
  @Output() cellEdit = new EventEmitter<{ phase: 'start' | 'change' | 'save' | 'cancel'; id: number; field: 'name' | 'seats' | 'bags'; value?: string }>();
  @ViewChild('vehicleCellInput') set focusVehicleCell(input: ElementRef<HTMLInputElement> | undefined) { input?.nativeElement.focus(); input?.nativeElement.select(); }
  @Output() action = new EventEmitter<OperationsAction>();
  @Output() refresh = new EventEmitter<void>();
  view: View = 'routes';
  routeDetailTab: RouteDetailTab = 'overview';
  readonly routeTabs = [
    { id: 'overview', label: 'Overview', icon: 'eye' },
    { id: 'browse', label: 'Browse routes', icon: 'road' },
    { id: 'ungrouped', label: 'Ungrouped routes', icon: 'folder' },
    { id: 'copied', label: 'Copied routes', icon: 'copy' },
    { id: 'groups', label: 'Stands', icon: 'share-alt' },
    { id: 'tools', label: 'Manage & import', icon: 'cog' },
  ] as const;
  search = '';
  status: 'all' | 'active' | 'inactive' | 'attention' = 'all';
  scope = 'all';
  routeGroupId: number | null = null;
  selectedGroupId: number | null = null;
  detailDriverId: number | null = null;
  vehicleId: number | null = null;
  selectedRouteId: number | null = null;
  showFilters = false;
  groupSetupOpen = false;
  initialRouteId: number | null = null;
  routeForGroup: MasterRoute | null = null;
  editingGroup: MasterGroup | null = null;
  renameGroup: MasterGroup | null = null;
  copyRoute: MasterRoute | null = null;
  copyReverse = false;
  startRouteCopy(route: MasterRoute, reverse = false): void { this.copyRoute = route; this.copyReverse = reverse; }
  routeCopied(result: { id: number; name: string }): void {
    this.trackCopiedRoute(result.id);
    this.clearFilters(); this.search = result.name; this.grouping = 'routes';
    this.selectedRouteId = result.id; this.routeDetailTab = 'copied'; this.refresh.emit();
  }
  standRenamed(result: { id: number; name: string }): void {
    const group = this.groups.find(item => item.id === result.id);
    if (group) group.name = result.name;
    this.refresh.emit();
  }
  groupSetupSection: 'routes' | 'vehicles' | 'drivers' = 'routes';
  routeForDrivers: MasterRoute | null = null;
  get driverTargetGroups(): MasterGroup[] { const linked = this.routeForDrivers ? this.groupsForRoute(this.routeForDrivers.id) : []; return linked.length ? linked : this.groups; }
  driverAssignment: MasterDriver | null = null;
  routeStarterOpen = false;
  newRouteVehicleId: number | null = null;
  grouping: RouteGrouping = 'routes';
  readonly explorer = new MasterExplorerComponent();
  selectedVehicleIds = new Set<number>();
  vehicleTypeId: number | null = null;
  vehicleSettingsId: number | null = null;
  batchVehicleOpen = false;
  pageSize = 10;
  readonly pageSizes = [10, 25, 50, 100];
  private pageNumber = 1;
  private paginationFilterKey = '';
  get totalItems(): number { return this.view === 'routes' ? this.directoryRows.length : this.view === 'vehicles' ? this.filteredVehicles.length : this.filteredDrivers.length; }
  get pageCount(): number { return Math.max(1, Math.ceil(this.totalItems / this.pageSize)); }
  get currentPage(): number {
    const key = JSON.stringify([this.cityId, this.view, this.search, this.status, this.scope, this.routeGroupId, this.vehicleId, this.vehicleTypeId, this.grouping]);
    if (key !== this.paginationFilterKey) { this.paginationFilterKey = key; this.pageNumber = 1; }
    this.pageNumber = Math.min(this.pageNumber, this.pageCount);
    return this.pageNumber;
  }
  get firstItem(): number { return this.totalItems ? (this.currentPage - 1) * this.pageSize + 1 : 0; }
  get lastItem(): number { return Math.min(this.currentPage * this.pageSize, this.totalItems); }
  goToPage(page: number): void { void this.currentPage; this.pageNumber = Math.max(1, Math.min(page, this.pageCount)); this.selectedRouteId = null; this.vehicleSettingsId = null; }
  changePageSize(size: number): void { if (this.pageSizes.includes(Number(size))) { this.pageSize = Number(size); this.goToPage(1); } }
  private paginate<T>(items: T[]): T[] { return items.slice((this.currentPage - 1) * this.pageSize, this.currentPage * this.pageSize); }
  get pagedVehicles(): MasterVehicle[] { return this.paginate(this.filteredVehicles); }
  get pagedDrivers(): MasterDriver[] { return this.paginate(this.filteredDrivers); }
  get pagedDirectoryRows(): DirectoryRow[] {
    const rows = this.directoryRows;
    const page = this.paginate(rows);
    const first = page[0];
    if (!first) return [];
    // Repeat ancestor headings when a grouped branch continues onto another page.
    const context = rows.filter(row => !row.route && first.key.startsWith(row.key + '/'));
    return [...context, ...page];
  }
  ngOnChanges(changes: SimpleChanges): void {
    if (changes['cityId']) {
      this.renameGroup = null;
      this.copyRoute = null;
      this.closeRoutePicker(); this.closeGroupPicker();
      this.search = ''; this.status = 'all'; this.scope = 'all'; this.vehicleId = null;
      this.routeGroupId = null;
      this.detailDriverId = null; this.selectedGroupId = null; this.resetGroupFilters();
      this.routeDetailTab = 'overview';
      this.selectedRouteId = null; this.groupSetupOpen = false; this.editingGroup = null;
      this.driverAssignment = null; this.routeStarterOpen = false;
      this.routeForGroup = null; this.routeForDrivers = null; this.initialRouteId = null; this.importStarter = false; this.newRouteVehicleId = null;
      this.selectedVehicleIds.clear(); this.vehicleTypeId = null; this.vehicleSettingsId = null;
      this.batchVehicleOpen = false;
      this.pageNumber = 1; this.paginationFilterKey = '';
      this.explorer.expanded.clear(); this.restorePreferences();
      this.copiedSearch = ''; this.restoreCopiedRouteIds();
    }
    if (this.vehicleId !== null && !this.loading && this.vehicles.length && !this.vehicles.some(vehicle => vehicle.id === this.vehicleId)) this.vehicleId = null;
    if (this.selectedRouteId !== null && !this.routes.some(route => route.id === this.selectedRouteId)) this.selectedRouteId = null;
    if (this.routeGroupId !== null && !this.groups.some(group => group.id === this.routeGroupId)) this.routeGroupId = null;
    if (this.selectedGroupId !== null && !this.groups.some(group => group.id === this.selectedGroupId)) this.selectedGroupId = null;
  }
  savePreferences(): void {
    try { localStorage.setItem(`master-route-view:v1:${this.cityId}`, JSON.stringify({ grouping: this.grouping, vehicleId: this.vehicleId })); } catch { /* Storage is optional. */ }
  }
  private restorePreferences(): void {
    this.grouping = 'routes';
    try {
      const saved = JSON.parse(localStorage.getItem(`master-route-view:v1:${this.cityId}`) ?? 'null');
      if (saved && ['route-set', 'city-area', 'scope', 'type', 'all-routes', 'routes'].includes(saved.grouping)) {
        this.grouping = saved.grouping;
        if (Number.isInteger(saved.vehicleId) && saved.vehicleId > 0) this.vehicleId = saved.vehicleId;
      }
    } catch { /* Invalid preferences do not block the page. */ }
  }
  changeGrouping(): void { this.explorer.expanded.clear(); this.selectedRouteId = null; this.savePreferences(); }
  get directoryRows(): DirectoryRow[] {
    this.explorer.routes = this.filteredRoutes;
    this.explorer.groups = this.routeGroupId === null ? this.groups : this.groups.filter(group => group.id === this.routeGroupId);
    this.explorer.cityName = this.cityName; this.explorer.grouping = this.grouping;
    return this.explorer.rows.map(row => ({ key: row.trackKey, depth: row.depth, name: row.node.name, kind: row.node.kind, id: row.node.id, ids: row.node.ids, route: row.node.kind === 'route' ? this.routes.find(route => route.id === row.node.id) : undefined }));
  }
  toggleDirectory(row: { key: string }): void { this.explorer.toggle(row.key.split('/').pop()!); }
  trackDirectoryRow(_: number, row: { key: string }): string { return row.key; }
  directoryExpanded(row: { key: string }): boolean { return this.explorer.expanded.has(row.key.split('/').pop()!); }
  expandDirectory(): void {
    void this.directoryRows;
    const visit = (node: typeof this.explorer.tree) => { if (node.kind !== 'route') this.explorer.expanded.add(node.key); node.children.forEach(visit); };
    visit(this.explorer.tree);
  }
  groupById(id?: number): MasterGroup | null { return this.groups.find(group => group.id === id) ?? null; }
  get vehicleTypes(): { id: number; name: string }[] { return [...new Map(this.vehicles.filter(vehicle => vehicle.vehicle_type_id !== null).map(vehicle => [vehicle.vehicle_type_id!, { id: vehicle.vehicle_type_id!, name: vehicle.vehicle_type_name || vehicle.display_name }])).values()]; }
  toggleVehicleSelection(id: number): void { this.selectedVehicleIds.has(id) ? this.selectedVehicleIds.delete(id) : this.selectedVehicleIds.add(id); }
  get allVisibleVehiclesSelected(): boolean { return this.pagedVehicles.length > 0 && this.pagedVehicles.every(vehicle => this.selectedVehicleIds.has(vehicle.id)); }
  get selectedVehicle(): MasterVehicle | undefined { return this.vehicles.find(vehicle => vehicle.id === this.vehicleId); }
  vehicleCellEditing(id: number, field: string): boolean { return this.editId === id && this.editField === field; }
  editVehicleCell(phase: 'start' | 'change' | 'save' | 'cancel', id: number, field: 'name' | 'seats' | 'bags', value?: string): void { this.cellEdit.emit({ phase, id, field, value }); }
  selectVisibleVehicles(): void { const all = this.allVisibleVehiclesSelected; this.pagedVehicles.forEach(vehicle => { if (all) this.selectedVehicleIds.delete(vehicle.id); else this.selectedVehicleIds.add(vehicle.id); }); }
  vehicleBatch(kind: 'copy-vehicles' | 'bulk-enable' | 'bulk-disable' | 'export-vehicles'): void { this.action.emit({ kind, ids: [...this.selectedVehicleIds] }); }
  vehicleFare(id: number, rideTypeId: number): void { this.action.emit({ kind: 'vehicle-fare', id, rideTypeId }); }
  initials(name: string): string { return name.trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase(); }
  routeDrivers(routeId: number): MasterDriver[] { const ids = new Set(this.groupsForRoute(routeId).flatMap(group => group.driver_user_ids)); return this.drivers.filter(driver => ids.has(driver.user_id)); }
  vehicleForRoute(route: MasterRoute): MasterVehicle | undefined { return this.vehicles.find(vehicle => (vehicle.mode_row_ids ?? [vehicle.id]).includes(route.city_vehicle_type_id ?? -1)); }
  get moduleTitle(): string { return { routes: 'Routes', vehicles: 'Vehicles & sharing', drivers: 'Driver assignments' }[this.view]; }
  get moduleDescription(): string { return { routes: 'Manage route maps, stops, fares and service areas.', vehicles: 'Configure vehicle options, capacity, pricing and shared sets.', drivers: 'Manage drivers, profiles and their assigned stands.' }[this.view]; }
  changeView(view: View): void {
    if (this.view === view) return;
    this.view = view; this.search = ''; this.status = 'all'; this.scope = 'all';
    this.selectedRouteId = null; this.routeGroupId = null; this.vehicleId = null;
    this.vehicleTypeId = null; this.showFilters = false; this.vehicleSettingsId = null;
    this.routeDetailTab = 'overview';
    this.pageNumber = 1; this.paginationFilterKey = '';
  }
  onModuleKeydown(event: KeyboardEvent, view: View): void {
    const views: View[] = ['routes', 'vehicles', 'drivers'];
    const index = views.indexOf(view);
    const target = event.key === 'ArrowRight' ? (index + 1) % views.length : event.key === 'ArrowLeft' ? (index + views.length - 1) % views.length : event.key === 'Home' ? 0 : event.key === 'End' ? views.length - 1 : -1;
    if (target < 0) return;
    event.preventDefault(); this.changeView(views[target]);
    (event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[target]?.focus();
  }
  selectGroup(group: MasterGroup): void { this.openGroupManagement(); this.selectedGroupId = group.id; }
  openGroupManagement(): void { this.changeView('routes'); this.routeDetailTab = 'groups'; this.resetGroupFilters(); }
  groupSearch = '';
  ungroupedSearch = '';
  copiedSearch = '';
  copiedRouteIds = new Set<number>();
  groupStatus: 'all' | 'active' | 'inactive' | 'attention' = 'all';
  groupVehicleId: number | null = null;
  resetGroupFilters(): void { this.groupSearch = ''; this.groupStatus = 'all'; this.groupVehicleId = null; }
  openDriver(driver: MasterDriver): void { this.changeView('drivers'); this.detailDriverId = driver.id; }
  routeTabCount(tab: RouteDetailTab): number | null {
    if (tab === 'groups') return this.groups.length;
    if (tab === 'browse') return this.filteredRoutes.length;
    if (tab === 'ungrouped') return this.ungroupedRoutes.length;
    if (tab === 'copied') return this.copiedRoutes.length;
    return null;
  }
  showUngroupedRoutes(): void {
    this.closeRoutePicker();
    this.closeGroupPicker();
    this.routeGroupId = null;
    this.selectedRouteId = null;
    this.routeDetailTab = 'ungrouped';
  }
  showCopiedRoutes(): void {
    this.closeRoutePicker();
    this.closeGroupPicker();
    this.routeGroupId = null;
    this.selectedRouteId = null;
    this.routeDetailTab = 'copied';
  }
  selectRouteDetailTab(tab: RouteDetailTab): void {
    if (tab === 'ungrouped') this.showUngroupedRoutes();
    else if (tab === 'copied') this.showCopiedRoutes();
    else this.routeDetailTab = tab;
  }
  onRouteTabKeydown(event: KeyboardEvent, tab: RouteDetailTab): void {
    const index = this.routeTabs.findIndex(item => item.id === tab);
    const target = event.key === 'ArrowRight' ? (index + 1) % this.routeTabs.length : event.key === 'ArrowLeft' ? (index + this.routeTabs.length - 1) % this.routeTabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? this.routeTabs.length - 1 : -1;
    if (target < 0) return;
    event.preventDefault(); this.selectRouteDetailTab(this.routeTabs[target].id);
    (event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[target]?.focus();
  }
  clearFilters(): void { this.search = ''; this.status = 'all'; this.scope = 'all'; this.routeGroupId = null; this.vehicleId = null; this.vehicleTypeId = null; this.savePreferences(); }
  get filtersActive(): boolean { return !!this.search || this.status !== 'all' || this.scope !== 'all' || this.routeGroupId !== null || this.vehicleId !== null || this.vehicleTypeId !== null; }
  get activeRouteCount(): number { return this.routes.filter(route => route.is_active).length; }
  get countryName(): string {
    if (!/^[A-Za-z]{2}$/.test(this.countryCode)) return 'Not configured';
    try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(this.countryCode.toUpperCase()) || this.countryCode; } catch { return this.countryCode; }
  }
  get overviewGroup(): MasterGroup | undefined { return this.groups.find(group => group.id === this.selectedGroupId) || this.groups.find(group => group.id === this.routeGroupId) || this.groups.find(group => group.route_ids.length > 0) || this.groups[0]; }
  get detailRoute(): MasterRoute | undefined { return this.selectedRoute || this.filteredRoutes[0]; }
  get detailStops() { return [...(this.detailRoute?.stops || [])].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)); }
  get detailDriver(): MasterDriver | undefined {
    return this.drivers.find(driver => driver.id === this.detailDriverId) || this.drivers[0];
  }
  routesForDriver(userId: number): MasterRoute[] { const ids = new Set(this.groupsForDriver(userId).flatMap(group => group.route_ids)); return this.routes.filter(route => ids.has(route.id)); }
  get incompleteGroupCount(): number { return this.groups.filter(group => !group.route_ids.length || !group.driver_user_ids.length).length; }
  showSetup(view: View): void { this.changeView(view); this.clearFilters(); this.status = 'attention'; }
  groupPickerOpen = false;
  groupPickerSearch = '';
  groupPickerIndex = 0;
  get selectedGroupLabel(): string { return this.groups.find(group => group.id === this.routeGroupId)?.name || 'All stands'; }
  get groupPickerResults(): { id: number | null; name: string }[] {
    const query = this.groupPickerSearch.toLowerCase().trim();
    return [{ id: null, name: 'All stands' }, ...this.groups].filter(group => group.name.toLowerCase().includes(query));
  }
  openGroupPicker(): void { this.closeRoutePicker(); this.groupPickerSearch = ''; this.groupPickerIndex = 0; this.groupPickerOpen = true; }
  searchGroupPicker(value: string): void { this.groupPickerSearch = value; this.groupPickerIndex = 0; this.groupPickerOpen = true; }
  closeGroupPicker(): void { this.groupPickerOpen = false; this.groupPickerSearch = ''; this.groupPickerIndex = 0; }
  onGroupPickerKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') { event.preventDefault(); this.closeGroupPicker(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!this.groupPickerOpen) { this.openGroupPicker(); return; }
      const count = this.groupPickerResults.length;
      this.groupPickerIndex = count ? (this.groupPickerIndex + (event.key === 'ArrowDown' ? 1 : count - 1)) % count : 0;
    } else if (event.key === 'Enter' && this.groupPickerOpen) {
      event.preventDefault(); const group = this.groupPickerResults[this.groupPickerIndex]; if (group) this.switchNetworkGroup(group.id);
    }
  }
  routePickerOpen = false;
  routePickerSearch = '';
  routePickerIndex = 0;
  get routePickerResults(): MasterRoute[] {
    const query = this.routePickerSearch.toLowerCase().trim();
    return this.filteredRoutes.filter(route => (route.name + ' ' + route.origin_name + ' ' + route.dest_name).toLowerCase().includes(query));
  }
  openRoutePicker(): void { this.closeGroupPicker(); this.routePickerSearch = ''; this.routePickerIndex = 0; this.routePickerOpen = true; }
  searchRoutePicker(value: string): void { this.routePickerSearch = value; this.routePickerIndex = 0; this.routePickerOpen = true; }
  closeRoutePicker(): void { this.routePickerOpen = false; this.routePickerSearch = ''; this.routePickerIndex = 0; }
  pickRoute(id: number): void { this.selectRoute(id); this.closeRoutePicker(); }
  onRoutePickerKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') { event.preventDefault(); this.closeRoutePicker(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!this.routePickerOpen) { this.openRoutePicker(); return; }
      const count = this.routePickerResults.length;
      this.routePickerIndex = count ? (this.routePickerIndex + (event.key === 'ArrowDown' ? 1 : count - 1)) % count : 0;
    } else if (event.key === 'Enter' && this.routePickerOpen) {
      event.preventDefault(); const route = this.routePickerResults[this.routePickerIndex]; if (route) this.pickRoute(route.id);
    }
  }
  selectRoute(id: number): void { if (this.routes.some(route => route.id === id)) { this.selectedRouteId = id; this.detailDriverId = null; this.routeDetailTab = 'overview'; } }
  showDriverRoute(id: number): void { this.changeView('routes'); this.clearFilters(); this.selectRoute(id); }
  get assignedDriverCount(): number { return this.drivers.filter(driver => this.groupsForDriver(driver.user_id).length > 0).length; }
  routeScopeCount(scope: string): number { return this.routes.filter(route => route.scope === scope).length; }
  groupRouteCount(group: MasterGroup): number { return this.routes.filter(route => group.route_ids.includes(route.id)).length; }
  switchNetworkGroup(groupId: number | null): void {
    if (groupId !== null && !this.groups.some(group => group.id === groupId)) return;
    this.clearFilters(); this.closeRoutePicker(); this.closeGroupPicker();
    this.selectNetwork('all', groupId); this.selectedGroupId = groupId;
    this.routeDetailTab = 'overview';
  }
  selectNetwork(scope = 'all', groupId: number | null = null): void {
    this.changeView('routes');
    this.scope = scope; this.routeGroupId = groupId; this.selectedRouteId = null;
    this.expandDirectory();
  }
  get networkLabel(): string { return this.groups.find(group => group.id === this.routeGroupId)?.name || (this.scope === 'all' ? 'All routes' : this.scope === 'local' ? 'Local routes' : 'Outstation routes'); }
  private matches(value: string): boolean { return value.toLowerCase().includes(this.search.toLowerCase().trim()); }
  groupVehicles(group: MasterGroup): MasterVehicle[] {
    return this.vehicles.filter(vehicle => (vehicle.mode_row_ids ?? [vehicle.id]).includes(group.city_vehicle_type_id ?? -1)
      || (group.vehicle_set_ids ?? []).some(id => (vehicle.vehicle_set_ids ?? (vehicle.vehicle_set_id ? [vehicle.vehicle_set_id] : [])).includes(id)));
  }
  groupsForRoute(id: number): MasterGroup[] { return this.groups.filter(group => group.route_ids.includes(id)); }
  groupsForDriver(userId: number): MasterGroup[] { return this.groups.filter(group => group.driver_user_ids.includes(userId)); }
  driverRouteCount(userId: number): number { return new Set(this.groupsForDriver(userId).flatMap(group => group.route_ids)).size; }
  groupsForVehicle(vehicle: MasterVehicle): MasterGroup[] { return this.groups.filter(group => this.groupVehicles(group).some(member => member.id === vehicle.id)); }
  vehicleLabel(group: MasterGroup): string { return this.groupVehicles(group).map(vehicle => vehicle.display_name).join(', ') || 'Choose vehicles'; }
  driverCount(route: MasterRoute): number { return new Set(this.groupsForRoute(route.id).flatMap(group => group.driver_user_ids)).size; }
  needsAttention(route: MasterRoute): boolean { return !route.flat_fare || !this.groupsForRoute(route.id).length; }
  get attentionCount(): number { return this.routes.filter(route => this.needsAttention(route)).length; }
  get filteredRoutes(): MasterRoute[] {
    return this.routes.filter(route => {
      const groups = this.groupsForRoute(route.id);
      return this.matches(`${route.name} ${route.origin_name} ${route.dest_name} ${groups.map(group => group.name).join(' ')}`)
        && (this.scope === 'all' || route.scope === this.scope)
        && (this.routeGroupId === null || groups.some(group => group.id === this.routeGroupId))
        && this.statusMatches(route.is_active, this.needsAttention(route))
        && (this.vehicleId === null || (this.vehicles.find(vehicle => vehicle.id === this.vehicleId)?.mode_row_ids ?? [this.vehicleId]).includes(route.city_vehicle_type_id ?? -1) || groups.some(group => this.groupVehicles(group).some(vehicle => vehicle.id === this.vehicleId)));
    });
  }
  get ungroupedRoutes(): MasterRoute[] {
    const query = this.ungroupedSearch.trim().toLowerCase();
    return this.routes.filter(route => this.groupsForRoute(route.id).length === 0
      && (!query || `${route.name} ${route.origin_name} ${route.dest_name}`.toLowerCase().includes(query)));
  }
  private restoreCopiedRouteIds(): void {
    this.copiedRouteIds.clear();
    if (!this.cityId) return;
    try {
      const raw = localStorage.getItem(`admin-copied-routes:v1:${this.cityId}`);
      if (raw) {
        const ids = JSON.parse(raw);
        if (Array.isArray(ids)) {
          ids.forEach((id: unknown) => { if (typeof id === 'number' && Number.isInteger(id)) this.copiedRouteIds.add(id); });
        }
      }
    } catch { /* Storage is optional. */ }
  }
  private saveCopiedRouteIds(): void {
    if (!this.cityId) return;
    try { localStorage.setItem(`admin-copied-routes:v1:${this.cityId}`, JSON.stringify([...this.copiedRouteIds])); } catch { /* Storage is optional. */ }
  }
  trackCopiedRoute(id: number): void {
    this.copiedRouteIds.add(id);
    this.saveCopiedRouteIds();
  }
  isCopiedRoute(route: MasterRoute): boolean {
    if (this.copiedRouteIds.has(route.id)) return true;
    const name = (route.name || '').trim().toLowerCase();
    return name.includes('(copy') || name.includes('copy)') || name.includes('copy of') || /\bcopy\b/i.test(name);
  }
  get copiedRoutes(): MasterRoute[] {
    const query = this.copiedSearch.trim().toLowerCase();
    return this.routes.filter(route => this.isCopiedRoute(route)
      && (!query || `${route.name} ${route.origin_name} ${route.dest_name}`.toLowerCase().includes(query)));
  }
  private statusMatches(active: boolean, attention: boolean): boolean { return this.status === 'all' || (this.status === 'attention' ? attention : active === (this.status === 'active')); }
  get filteredGroups(): MasterGroup[] { return this.groups.filter(group => (group.name + ' ' + this.vehicleLabel(group)).toLowerCase().includes(this.groupSearch.toLowerCase().trim()) && (this.groupStatus === 'all' || (this.groupStatus === 'attention' ? !group.route_ids.length || !group.driver_user_ids.length : group.is_active === (this.groupStatus === 'active'))) && (this.groupVehicleId === null || this.groupVehicles(group).some(vehicle => vehicle.id === this.groupVehicleId))); }
  get filteredVehicles(): MasterVehicle[] { return this.vehicles.filter(vehicle => this.matches(`${vehicle.display_name} ${vehicle.vehicle_type_name ?? ''}`) && (this.vehicleId === null || vehicle.id === this.vehicleId) && (this.vehicleTypeId === null || vehicle.vehicle_type_id === this.vehicleTypeId) && (this.status === 'all' || (this.status === 'attention' ? !this.groupsForVehicle(vehicle).length : vehicle.is_active === (this.status === 'active')))); }
  get filteredDrivers(): MasterDriver[] { return this.drivers.filter(driver => this.matches(`${driver.name} ${driver.phone ?? ''} ${driver.vehicle_reg_no ?? ''} ${this.groupsForDriver(driver.user_id).map(group => group.name).join(' ')}`) && (this.vehicleId === null || this.driverMatchesVehicle(driver)) && (this.status !== 'attention' || !this.groupsForDriver(driver.user_id).length)); }
  private driverMatchesVehicle(driver: MasterDriver): boolean {
    const vehicle = this.vehicles.find(item => item.id === this.vehicleId);
    return !!vehicle && ((vehicle.mode_row_ids ?? [vehicle.id]).includes(driver.city_vehicle_type_id ?? -1)
      || (vehicle.vehicle_type_id !== null && driver.vehicle_type_id === vehicle.vehicle_type_id)
      || this.groupsForDriver(driver.user_id).some(group => this.groupVehicles(group).some(member => member.id === vehicle.id)));
  }
  get selectedRoute(): MasterRoute | undefined { return this.filteredRoutes.find(route => route.id === this.selectedRouteId); }
  get busy(): boolean { return this.loading || !!this.loadError; }
  startGroup(group: MasterGroup | null = null, routeId: number | null = null, section: 'routes' | 'vehicles' | 'drivers' = 'routes'): void { this.editingGroup = group; this.initialRouteId = routeId; this.groupSetupSection = section; this.groupSetupOpen = true; }
  addRouteDrivers(route: MasterRoute): void {
    if (this.busy) return;
    const groups = this.groupsForRoute(route.id);
    if (groups.length === 1) { this.startGroup(groups[0], null, 'drivers'); return; }
    if (!groups.length && (!route.flat_fare || route.flat_fare <= 0)) { this.emit('edit-route', route.id); return; }
    this.routeForDrivers = route;
  }
  chooseDriverGroup(group: MasterGroup | null): void {
    const route = this.routeForDrivers;
    if (!route || (group && !this.driverTargetGroups.some(candidate => candidate.id === group.id))) return;
    this.routeForDrivers = null;
    this.startGroup(group, group?.route_ids.includes(route.id) ? null : route.id, 'drivers');
  }
  assignRoute(route: MasterRoute): void {
    if (!route.flat_fare || route.flat_fare <= 0) { this.emit('edit-route', route.id); return; }
    this.routeForGroup = route;
  }
  chooseGroupForRoute(group: MasterGroup | null): void { const id = this.routeForGroup?.id ?? null; this.routeForGroup = null; this.startGroup(group, id); }
  startRoute(): void {
    this.importStarter = false;
    const vehicleId = this.vehicleId ?? (this.vehicles.length === 1 ? this.vehicles[0].id : null);
    if (vehicleId) this.emit('add-route', undefined, vehicleId);
    else { this.newRouteVehicleId = this.vehicles[0]?.id ?? null; this.routeStarterOpen = true; }
  }
  createRoute(): void { if (this.newRouteVehicleId) { this.routeStarterOpen = false; this.emit('add-route', undefined, this.newRouteVehicleId); } }
  importRoutes(): void { if (this.vehicleId) this.emit('import', undefined, this.vehicleId); else { this.newRouteVehicleId = this.vehicles[0]?.id ?? null; this.importStarter = true; this.routeStarterOpen = true; } }
  importStarter = false;
  completeRouteStarter(): void { if (!this.newRouteVehicleId) return; if (this.importStarter) { this.emit('import', undefined, this.newRouteVehicleId); this.routeStarterOpen = false; } else this.createRoute(); this.importStarter = false; }
  emit(kind: OperationsAction['kind'], id?: number, vehicleId: number | null = this.vehicleId): void { this.action.emit({ kind, id, vehicleId } as OperationsAction); }
  exportRoutes(): void {
    const rows = [['Route', 'Origin', 'Destination', 'Scope', 'Fare', 'Status'], ...this.filteredRoutes.map(route => [route.name, route.origin_name, route.dest_name, route.scope, route.flat_fare ?? '', route.is_active ? 'Active' : 'Inactive'])];
    const csv = rows.map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${this.cityName || 'city'}-routes.csv`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
