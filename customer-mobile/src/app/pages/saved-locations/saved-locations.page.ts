import { CUSTOMER_MAP_STYLE } from '../../core/customer-map';
import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { AlertController, ToastController } from '@ionic/angular';
import { Subject, debounceTime, switchMap } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { PlacesService, PlaceSuggestion } from '../../core/places.service';
import { GeolocationService } from '../../core/geolocation.service';

declare const google: any;

interface SavedLocation {
  id: number;
  label: string;
  address: string;
  lat: number;
  lng: number;
  icon: string | null;
}

type PresetKey = 'home' | 'work' | 'other';

/**
 * Customer's saved places (Home, Work, …). "Add Location" opens a map picker:
 * the customer searches a place or taps/pans the map, picks a category, saves.
 */
@Component({
  selector: 'app-saved-locations',
  templateUrl: './saved-locations.page.html',
  styleUrls: ['./saved-locations.page.scss'],
  standalone: false,
})
export class SavedLocationsPage implements OnInit {
  rows: SavedLocation[] = [];
  loading = false;
  error: string | null = null;

  // ── Map picker state ─────────────────────────────────────────────
  pickerOpen = false;
  saving = false;
  editingId: number | null = null;

  pickerAddress = '';
  pickerLat: number | null = null;
  pickerLng: number | null = null;

  selectedPreset: PresetKey = 'home';
  customLabel = '';
  pickerError: string | null = null;

  searchQuery = '';
  searchResults: PlaceSuggestion[] = [];
  private search$ = new Subject<string>();

  presets: { key: PresetKey; label: string; icon: string }[] = [
    { key: 'home', label: 'Home', icon: 'home' },
    { key: 'work', label: 'Work', icon: 'briefcase' },
    { key: 'other', label: 'Other', icon: 'location' },
  ];

  private map: any = null;

  constructor(
    private api: ApiService,
    private router: Router,
    private alertCtrl: AlertController,
    private toastCtrl: ToastController,
    private places: PlacesService,
    private geo: GeolocationService,
  ) {}

  ngOnInit(): void {
    this.refresh();
    this.search$
      .pipe(
        debounceTime(250),
        switchMap((q) =>
          this.places.autocompleteSearch(
            q,
            this.pickerLat != null && this.pickerLng != null
              ? { lat: this.pickerLat, lng: this.pickerLng }
              : undefined,
          ),
        ),
      )
      .subscribe((res) => (this.searchResults = res));
  }

  refresh(): void {
    this.loading = true;
    this.error = null;
    this.api.get<{ data: SavedLocation[] }>('/me/saved-locations').subscribe({
      next: (res) => { this.rows = res.data ?? []; this.loading = false; },
      error: (err) => { this.error = err?.error?.message || 'Could not load locations.'; this.loading = false; },
    });
  }

  // ── Picker open / close ──────────────────────────────────────────
  openAdd(): void {
    this.editingId = null;
    this.selectedPreset = 'home';
    this.customLabel = '';
    this.pickerAddress = '';
    this.pickerLat = null;
    this.pickerLng = null;
    this.searchQuery = '';
    this.searchResults = [];
    this.pickerError = null;
    this.pickerOpen = true;
    void this.initPickerMap();
  }

  openEdit(l: SavedLocation): void {
    this.editingId = l.id;
    const low = (l.label || '').toLowerCase();
    if (low === 'home') { this.selectedPreset = 'home'; this.customLabel = ''; }
    else if (low === 'work') { this.selectedPreset = 'work'; this.customLabel = ''; }
    else { this.selectedPreset = 'other'; this.customLabel = l.label; }
    this.pickerAddress = l.address;
    this.pickerLat = l.lat;
    this.pickerLng = l.lng;
    this.searchQuery = '';
    this.searchResults = [];
    this.pickerError = null;
    this.pickerOpen = true;
    void this.initPickerMap();
  }

  closePicker(): void {
    this.pickerOpen = false;
    this.map = null;
    this.searchResults = [];
  }

  private async initPickerMap(): Promise<void> {
    await this.places.ensureLoaded();
    const center =
      this.pickerLat != null && this.pickerLng != null
        ? { lat: this.pickerLat, lng: this.pickerLng }
        : (await this.geo.getCurrentPosition()) ?? { lat: 28.6139, lng: 77.209 };

    // Wait for the picker map div to render before binding the map.
    await new Promise((r) => setTimeout(r, 80));
    const div = document.getElementById('picker-map');
    if (!div) return;

    this.map = new google.maps.Map(div, {
      ...CUSTOMER_MAP_STYLE,
      center,
      zoom: 16,
      disableDefaultUI: true,
      clickableIcons: false,
      mapId: 'DEMO_MAP_ID',
    });
    this.pickerLat = center.lat;
    this.pickerLng = center.lng;
    void this.settleCenter();

    // Pan settles → reverse geocode the centred pin. Tap → re-centre there.
    this.map.addListener('idle', () => this.settleCenter());
    this.map.addListener('click', (ev: any) => {
      this.map.panTo({ lat: ev.latLng.lat(), lng: ev.latLng.lng() });
    });
  }

  private async settleCenter(): Promise<void> {
    if (!this.map) return;
    const c = this.map.getCenter();
    const lat = c.lat();
    const lng = c.lng();
    this.pickerLat = lat;
    this.pickerLng = lng;
    const addr = await this.places.reverseGeocode(lat, lng);
    this.pickerAddress = addr ?? 'Pinned location';
  }

  onPickerSearch(ev: any): void {
    const q = ev?.target?.value ?? '';
    this.searchQuery = q;
    if (q.trim().length < 2) { this.searchResults = []; return; }
    this.search$.next(q);
  }

  async pickSearchResult(s: PlaceSuggestion): Promise<void> {
    this.searchResults = [];
    this.searchQuery = s.main_text;
    const detail = await this.places.getPlaceDetail(s.place_id);
    if (!detail || !this.map) return;
    this.pickerAddress = detail.description;
    this.pickerLat = detail.lat;
    this.pickerLng = detail.lng;
    this.map.panTo({ lat: detail.lat, lng: detail.lng });
    this.map.setZoom(16);
  }

  selectPreset(key: PresetKey): void {
    this.selectedPreset = key;
    this.pickerError = null;
  }

  get pickerLabel(): string {
    if (this.selectedPreset === 'home') return 'Home';
    if (this.selectedPreset === 'work') return 'Work';
    return this.customLabel.trim();
  }

  get pickerIcon(): string {
    if (this.selectedPreset === 'home') return 'home';
    if (this.selectedPreset === 'work') return 'briefcase';
    return 'location';
  }

  savePicker(): void {
    this.pickerError = null;
    const label = this.pickerLabel;
    if (!label) { this.pickerError = 'Enter a name for this place.'; return; }
    if (this.pickerLat == null || this.pickerLng == null) {
      this.pickerError = 'Pick a location on the map.';
      return;
    }

    const body = {
      label,
      address: this.pickerAddress || label,
      lat: this.pickerLat,
      lng: this.pickerLng,
      icon: this.pickerIcon,
    };

    this.saving = true;
    const req = this.editingId
      ? this.api.patch<{ location: SavedLocation }>(`/me/saved-locations/${this.editingId}`, body)
      : this.api.post<{ location: SavedLocation }>('/me/saved-locations', body);
    req.subscribe({
      next: () => { this.saving = false; this.pickerOpen = false; this.refresh(); },
      error: (err) => { this.pickerError = err?.error?.message || 'Could not save.'; this.saving = false; },
    });
  }

  async confirmDelete(l: SavedLocation): Promise<void> {
    const alert = await this.alertCtrl.create({
      header: 'Delete this location?',
      message: l.label + ' — ' + l.address,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Delete', role: 'destructive', handler: () => this.doDelete(l) },
      ],
    });
    await alert.present();
  }

  private doDelete(l: SavedLocation): void {
    this.api.delete(`/me/saved-locations/${l.id}`).subscribe({
      next: () => this.refresh(),
      error: async (err) => {
        const t = await this.toastCtrl.create({
          message: err?.error?.message || 'Could not delete.',
          duration: 2500, color: 'danger',
        });
        await t.present();
      },
    });
  }

  back(): void { this.router.navigateByUrl('/customer-tabs/go'); }
}
