import { Injectable } from '@angular/core';

/** In-memory launch state: survives page recreation, resets after a cold start. */
@Injectable({ providedIn: 'root' })
export class HomeSessionService {
  locationLoaderShown = false;
  readonly dismissedOffers = new Set<string>();
}
