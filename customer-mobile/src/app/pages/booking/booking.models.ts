/**
 * The vocabulary the whole booking flow shares.
 *
 * One draft trip is carried across every screen so backing out of a step and
 * changing something never loses what the rider already confirmed.
 */

export type RideMode = 'private' | 'fixed' | 'shuttle';
export type TripScope = 'local' | 'outstation';

/**
 * A city the operator runs in.
 *
 * Which city the rider is in decides which services exist — Sopore has fixed
 * routes, Kupwara doesn't — so this has to be resolved from where they actually
 * are, never from whichever city happens to be first in the list.
 */
export interface City {
  id: number;
  name: string;
  center_lat?: number | null;
  center_lng?: number | null;
  boundary_polygon?: { lat: number; lng: number }[] | null;
}

/** A place with coordinates — a pickup, a drop, or a saved location. */
export interface Place {
  lat: number;
  lng: number;
  address: string;
  label?: string;
}

/**
 * One service tile on the home sheet, built from the city catalogue.
 *
 * A mode switched off in admin has no tile; "Share a seat" stays hidden in a
 * city with no live route. The tile only sets a preference — the actual price
 * still comes from the flow it opens.
 */
export interface ServiceTile {
  /** Always one of the three modes — never null. */
  mode: RideMode;
  title: string;
  hint: string;
  icon: string;
  imageUrl?: string | null;
  /** The catalogue ride-type id, needed to price Fixed/Shuttle. */
  rideTypeId: number | null;
}

/** Rider-facing wording for each mode, kept in one place. */
export const MODE_COPY: Record<RideMode, { title: string; hint: string; icon: string }> = {
  private: { title: 'Private', hint: 'Whole car', icon: 'car-outline' },
  fixed: { title: 'Fixed', hint: 'A seat', icon: 'bus-outline' },
  shuttle: { title: 'Shuttle', hint: 'Pool', icon: 'git-merge-outline' },
};

/** What the rider has told us so far. Lives in BookingService. */
export interface TripDraft {
  scope: TripScope;
  mode: RideMode | null;
  /** Catalogue ride-type id for the chosen mode (Fixed/Shuttle pricing). */
  rideTypeId: number | null;
  pickup: Place | null;
  drop: Place | null;
  cityId: number | null;
}

export const EMPTY_TRIP: TripDraft = {
  scope: 'local',
  mode: null,
  rideTypeId: null,
  pickup: null,
  drop: null,
  cityId: null,
};
