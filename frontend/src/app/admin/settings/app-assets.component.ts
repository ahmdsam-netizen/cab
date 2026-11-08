import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { ActivatedRoute } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { ButtonComponent, IconComponent, IconName, ModalComponent } from '../../ui';

type AssetKey = 'map_marker' | 'booking_card' | 'customer_marker';
interface VehicleFamily { key: string; display_name: string; }
interface FamilyAsset { id: number; display_name: string; key: AssetKey; image_url: string | null; }
interface AssetsResponse { families: VehicleFamily[]; data: FamilyAsset[]; customer_marker?: FamilyAsset | null; }

@Component({
  selector: 'app-app-assets',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonComponent, IconComponent, ModalComponent],
  template: `
    <div class="page">
      <header class="hero">
        <h1>App Assets</h1>
        <p>Configure shared vehicle and customer map icons across <strong>all cities, Android, iOS and admin dashboards</strong>.</p>
      </header>

      <nav class="asset-tabs" role="tablist">
        <button class="asset-tab" [class.is-active]="activeTab === 'vehicles'" (click)="activeTab = 'vehicles'" role="tab">
          <tm-icon name="car" [size]="16" />
          <span>Vehicle Icons</span>
        </button>
        <button class="asset-tab" [class.is-active]="activeTab === 'customer'" (click)="activeTab = 'customer'" role="tab">
          <tm-icon name="user" [size]="16" />
          <span>Customer Icon</span>
        </button>
      </nav>

      <div class="cue" *ngIf="loading">Loading assets...</div>
      <div class="cue" *ngIf="loadError">
        <span>{{ loadError }}</span>
        <tm-button variant="outline" icon="refresh" (clicked)="loadAssets()">Retry</tm-button>
      </div>

      <!-- Vehicle Icons Tab -->
      <section class="layout" *ngIf="activeTab === 'vehicles' && !loading && !loadError">
        <aside class="vehicles">
          <div class="search">
            <tm-icon name="search" [size]="16" />
            <input [(ngModel)]="search" placeholder="Search vehicles" aria-label="Search vehicles" />
          </div>
          <button class="vehicle" *ngFor="let family of filteredFamilies"
            [class.is-active]="selectedFamily?.key === family.key" (click)="selectFamily(family)">
            <tm-icon name="car" [size]="18" /><strong>{{ family.display_name }}</strong>
          </button>
          <p *ngIf="!filteredFamilies.length">No matching vehicles.</p>
        </aside>
        <main class="assets">
          <div class="cue" *ngIf="!selectedFamily">Add a vehicle in Vehicles to configure its images.</div>
          <ng-container *ngIf="selectedFamily">
            <header class="assets-head">
              <div><h2>{{ selectedFamily.display_name }}</h2><p>Shared across all cities and apps</p></div>
              <tm-button variant="outline" icon="refresh" [disabled]="busy" (clicked)="loadAssets()">Refresh</tm-button>
            </header>
            <div class="slots">
              <article class="slot" *ngFor="let slot of slots">
                <div class="slot-title"><tm-icon [name]="slot.icon" [size]="18" /><strong>{{ slot.title }}</strong></div>
                <p>{{ slot.subtitle }}</p>
                <input #fileInput type="file" accept="image/png,image/jpeg,image/gif,image/svg+xml,image/webp"
                  hidden (change)="onFileSelect(slot.key, $event)" />
                <div class="preview" *ngIf="assetFor(slot.key) as asset">
                  <img [src]="asset.image_url" [alt]="slot.title" />
                  <tm-button variant="outline" icon="edit" [disabled]="busy" (clicked)="fileInput.click()">Replace</tm-button>
                  <tm-button variant="danger" icon="trash" [disabled]="busy" (clicked)="assetToDelete = asset">Delete</tm-button>
                </div>
                <tm-button *ngIf="!assetFor(slot.key)" variant="green" icon="upload" [disabled]="busy"
                  (clicked)="fileInput.click()">Upload {{ slot.title }}</tm-button>
                <small>{{ slot.hint }}</small>
              </article>
            </div>
            <p class="saving" *ngIf="busy">Saving changes...</p>
          </ng-container>
        </main>
      </section>

      <!-- Customer Icon Tab -->
      <section class="customer-section" *ngIf="activeTab === 'customer' && !loading && !loadError">
        <div class="customer-card">
          <header class="assets-head">
            <h2>Customer Marker Icon</h2>
            <tm-button variant="outline" icon="refresh" [disabled]="busy" (clicked)="loadAssets()">Refresh</tm-button>
          </header>
          <div class="slots" style="grid-template-columns: 1fr;">
            <article class="slot">
              <input #customerFileInput type="file" accept="image/png,image/jpeg,image/gif,image/svg+xml,image/webp"
                hidden (change)="onCustomerFileSelect($event)" />
              <div class="preview" *ngIf="customerAsset as asset">
                <img [src]="asset.image_url" alt="Customer Marker" />
                <tm-button variant="outline" icon="edit" [disabled]="busy" (clicked)="customerFileInput.click()">Replace</tm-button>
                <tm-button variant="danger" icon="trash" [disabled]="busy" (clicked)="assetToDelete = asset">Delete</tm-button>
              </div>
              <div class="preview default-preview" *ngIf="!customerAsset">
                <div class="dot-preview-box">
                  <span class="preview-dot-pulse"></span>
                  <span class="preview-dot"></span>
                </div>
                <div class="default-desc">
                  <strong>Default: Location Dot</strong>
                  <p>No custom icon uploaded. The customer app currently displays the default pulsing location dot.</p>
                </div>
                <tm-button variant="green" icon="upload" [disabled]="busy" (clicked)="customerFileInput.click()">Upload Customer Icon</tm-button>
              </div>
              <small>Transparent PNG or SVG. If removed, the customer app seamlessly falls back to the default location dot.</small>
            </article>
          </div>
          <p class="saving" *ngIf="busy">Saving changes...</p>
        </div>
      </section>
    </div>

    <tm-modal [open]="!!assetToDelete" title="Delete shared image" (closed)="assetToDelete = null">
      <div slot="body">
        <p *ngIf="assetToDelete?.key === 'customer_marker'">Delete the customer marker icon? The customer app will immediately use the default location dot.</p>
        <p *ngIf="assetToDelete?.key !== 'customer_marker'">Delete this image for <strong>all cities and both Android and iOS</strong>? The apps will use their default image.</p>
      </div>
      <div slot="footer">
        <tm-button variant="ghost" [disabled]="busy" (clicked)="assetToDelete = null">Cancel</tm-button>
        <tm-button variant="danger" [disabled]="busy" (clicked)="deleteAsset()">Delete</tm-button>
      </div>
    </tm-modal>
  `,
  styles: [`
    .page { display:flex; flex-direction:column; gap:16px; }
    h1 { margin:0; font-size:22px; } h2 { margin:0; font-size:18px; }
    p, small { color:var(--tm-text-muted); } .hero p { margin:6px 0; }
    .asset-tabs { display:flex; gap:8px; border-bottom:1px solid var(--tm-line); padding-bottom:8px; }
    .asset-tab { display:flex; align-items:center; gap:8px; padding:8px 16px; border:1px solid transparent; border-radius:8px; background:transparent; color:var(--tm-text-muted); cursor:pointer; font-weight:600; font-size:14px; transition:all .15s ease; }
    .asset-tab.is-active { background:var(--tm-surface); color:var(--tm-text); border-color:var(--tm-line); box-shadow:0 1px 3px rgba(0,0,0,0.05); }
    .customer-section { display:flex; flex-direction:column; gap:16px; width:100%; }
    .customer-card { background:var(--tm-surface); border:1px solid var(--tm-line); border-radius:14px; padding:20px; width:100%; box-sizing:border-box; }
    .default-preview { display:flex; align-items:center; gap:16px; padding:12px; background:var(--tm-canvas); border-radius:10px; }
    .dot-preview-box { position:relative; width:44px; height:44px; display:flex; align-items:center; justify-content:center; background:#ffffff; border-radius:10px; border:1px solid var(--tm-line); }
    .preview-dot { width:16px; height:16px; border-radius:50%; background:#2563EB; border:3px solid #ffffff; box-shadow:0 2px 5px rgba(0,0,0,0.25); z-index:2; position:relative; }
    .preview-dot-pulse { position:absolute; width:28px; height:28px; border-radius:50%; border:2px solid #2563EB; opacity:0.6; z-index:1; }
    .default-desc { flex:1; min-width:0; } .default-desc strong { display:block; font-size:13px; color:var(--tm-text); } .default-desc p { margin:2px 0 0; font-size:12px; }
    .layout { display:grid; grid-template-columns:280px 1fr; gap:16px; align-items:start; }
    .vehicles, .assets { background:var(--tm-surface); border:1px solid var(--tm-line); border-radius:14px; padding:16px; }
    .vehicles { display:flex; flex-direction:column; gap:8px; max-height:70vh; overflow:auto; }
    .search { display:flex; align-items:center; gap:8px; padding:10px; background:var(--tm-canvas); border-radius:8px; }
    .search input { width:100%; min-width:0; border:0; outline:0; background:transparent; color:var(--tm-text); }
    .vehicle { display:flex; gap:10px; align-items:center; padding:12px; border:1px solid transparent; border-radius:8px; background:transparent; color:var(--tm-text); cursor:pointer; text-align:left; }
    .vehicle.is-active { border-color:var(--tm-green); background:var(--tm-canvas); }
    .assets-head { display:flex; align-items:center; justify-content:space-between; gap:12px; }
    .slots { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:16px; }
    .slot { border:1px solid var(--tm-line); border-radius:12px; padding:16px; display:flex; flex-direction:column; gap:12px; }
    .slot-title { display:flex; align-items:center; gap:8px; } .slot p { margin:0; font-size:13px; }
    .preview { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
    .preview img { width:110px; height:90px; object-fit:contain; background:var(--tm-canvas); border-radius:8px; }
    .cue { padding:24px; display:flex; flex-direction:column; gap:12px; align-items:center; }
    .saving { text-align:center; } @media(max-width:900px) { .layout, .slots { grid-template-columns:1fr; } }
  `],
})
export class AppAssetsComponent implements OnInit, OnDestroy {
  activeTab: 'vehicles' | 'customer' = 'vehicles';
  families: VehicleFamily[] = [];
  assets: FamilyAsset[] = [];
  customerAsset: FamilyAsset | null = null;
  selectedFamily: VehicleFamily | null = null;
  assetToDelete: FamilyAsset | null = null;
  search = '';
  loading = false;
  loadError = '';
  busy = false;
  readonly slots: { key: AssetKey; title: string; subtitle: string; hint: string; icon: IconName }[] = [
    { key:'map_marker', title:'Map Marker Icon', subtitle:'Vehicle symbol shown on live tracking maps.', hint:'Transparent PNG or SVG pointing upwards. Maximum 4 MB.', icon:'pin' },
    { key:'booking_card', title:'Vehicle Booking Image', subtitle:'Vehicle photo used for ride selection, estimates, history and invoices.', hint:'Side or front view of the vehicle. Maximum 4 MB.', icon:'car' },
  ];
  private subscriptions = new Subscription();
  private loadSubscription?: Subscription;

  constructor(private api: ApiService, private toast: ToastService, private route: ActivatedRoute) {}
  ngOnInit(): void { this.loadAssets(); }
  ngOnDestroy(): void { this.subscriptions.unsubscribe(); this.loadSubscription?.unsubscribe(); }
  get filteredFamilies(): VehicleFamily[] {
    const query = this.search.trim().toLowerCase();
    return this.families.filter(f => f.display_name.toLowerCase().includes(query));
  }
  selectFamily(family: VehicleFamily): void { this.selectedFamily = family; }
  assetFor(key: AssetKey): FamilyAsset | null {
    return this.assets.find(a => a.display_name === this.selectedFamily?.key && a.key === key) ?? null;
  }
  loadAssets(): void {
    this.loadSubscription?.unsubscribe();
    this.loading = true;
    this.loadError = '';
    const selected = this.selectedFamily?.key || this.route.snapshot.queryParamMap.get('family')?.trim().toLowerCase();
    this.loadSubscription = this.api.get<AssetsResponse>('/admin/app-assets').subscribe({
      next: res => {
        this.families = res.families || [];
        this.assets = res.data || [];
        this.customerAsset = res.customer_marker ?? this.assets.find(a => a.display_name === 'customer' && a.key === 'customer_marker') ?? null;
        this.selectedFamily = this.families.find(f => f.key === selected) || this.families[0] || null;
        this.loading = false;
      },
      error: err => {
        this.loading = false;
        this.loadError = err.status === 404 ? 'Shared App Assets requires the latest backend update on the server.' : 'Could not load app assets. Please retry.';
      },
    });
  }
  onFileSelect(key: AssetKey, event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !this.selectedFamily || this.busy) return;
    if (file.size > 4 * 1024 * 1024) { this.toast.error('Choose an image smaller than 4 MB.'); return; }
    const form = new FormData();
    form.append('display_name', this.selectedFamily.key);
    form.append('key', key);
    form.append('image', file);
    this.busy = true;
    this.subscriptions.add(this.api.postMultipart('/admin/app-assets', form).subscribe({
      next: () => { this.busy = false; this.toast.success('Image saved for all cities and apps'); this.loadAssets(); },
      error: err => { this.busy = false; this.toast.error(err.error?.message || 'Could not upload image'); },
    }));
  }
  onCustomerFileSelect(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || this.busy) return;
    if (file.size > 4 * 1024 * 1024) { this.toast.error('Choose an image smaller than 4 MB.'); return; }
    const form = new FormData();
    form.append('display_name', 'customer');
    form.append('key', 'customer_marker');
    form.append('image', file);
    this.busy = true;
    this.subscriptions.add(this.api.postMultipart('/admin/app-assets', form).subscribe({
      next: () => {
        this.busy = false;
        this.toast.success('Customer marker icon saved for all cities and apps');
        this.loadAssets();
      },
      error: err => {
        this.busy = false;
        this.toast.error(err.error?.message || 'Could not upload customer marker icon');
      },
    }));
  }
  deleteAsset(): void {
    if (!this.assetToDelete || this.busy) return;
    this.busy = true;
    this.subscriptions.add(this.api.delete(`/admin/app-assets/${this.assetToDelete.id}`).subscribe({
      next: () => {
        this.busy = false;
        const wasCustomer = this.assetToDelete?.key === 'customer_marker';
        this.assetToDelete = null;
        this.toast.success(wasCustomer ? 'Customer marker icon deleted' : 'Image deleted for all cities and apps');
        this.loadAssets();
      },
      error: err => { this.busy = false; this.toast.error(err.error?.message || 'Could not delete image'); },
    }));
  }
}
