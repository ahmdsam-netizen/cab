import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { ApiService } from './api.service';
import { setGlobalCustomerMarkerUrl } from './car-marker.helper';

interface CustomerMarkerResponse {
  customer_marker_url?: string | null;
  customer_marker?: { id: number; image_url?: string | null } | null;
}

@Injectable({
  providedIn: 'root',
})
export class AppAssetService {
  private customerMarkerSubject = new BehaviorSubject<string | null>(null);
  public customerMarker$: Observable<string | null> = this.customerMarkerSubject.asObservable();
  private loaded = false;

  constructor(private api: ApiService) {
    // Synchronously seed from localStorage if previously cached
    try {
      const cached = localStorage.getItem('dc_customer_marker_url');
      if (cached) {
        this.customerMarkerSubject.next(cached);
        setGlobalCustomerMarkerUrl(cached);
      }
    } catch {}
  }

  getCustomerMarkerUrl(): string | null {
    return this.customerMarkerSubject.value;
  }

  loadCustomerMarker(): void {
    this.api.get<CustomerMarkerResponse>('/app-assets/customer-marker').subscribe({
      next: (res) => {
        this.loaded = true;
        const url = res?.customer_marker_url || res?.customer_marker?.image_url || null;
        this.customerMarkerSubject.next(url);
        setGlobalCustomerMarkerUrl(url);
      },
      error: () => {
        this.loaded = true;
      },
    });
  }
}
