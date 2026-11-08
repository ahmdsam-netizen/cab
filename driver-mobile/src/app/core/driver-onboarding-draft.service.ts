import { Injectable } from '@angular/core';

export interface DriverRegistrationDraft {
  step: 1 | 2 | 3 | 4;
  city_id: number | null;
  city_ids?: number[];
  service_scope: 'local' | 'outstation' | 'both' | null;
  service_mode: 'private' | 'fixed' | 'shuttle' | null;
  vehicle_type_id: number | null;
  city_vehicle_type_id: number | null;
  fleet_id: number | null;
  vehicle_model_year: string;
  vehicle_color: string;
  vehicle_reg_no: string;
}

export interface DriverOnboardingProfileDraft {
  name: string;
  email: string;
  dob: string;
  address: string;
  app_version?: string;
  os_version?: string;
  device_type?: string;
}

const PROFILE_STORAGE_KEY = 'driver_onboarding_profile_draft';
const REGISTRATION_STORAGE_KEY = 'driver_registration_draft';

@Injectable({ providedIn: 'root' })
export class DriverOnboardingDraftService {
  private photoWrites: Promise<void> = Promise.resolve();

  private photoStore(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest): Promise<any> {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open('driver-onboarding-drafts', 1);
      open.onupgradeneeded = () => { open.result.createObjectStore('photos'); };
      open.onerror = () => reject(open.error);
      open.onblocked = () => reject(new Error('Photo draft storage is unavailable.'));
      open.onsuccess = () => {
        const db = open.result;
        const transaction = db.transaction('photos', mode);
        const request = action(transaction.objectStore('photos'));
        transaction.oncomplete = () => { db.close(); resolve(request.result); };
        transaction.onabort = () => { db.close(); reject(transaction.error || new Error('Photo draft could not be saved.')); };
        transaction.onerror = () => { /* onabort reports the failure. */ };
      };
    });
  }

  setPhotoFile(photoFile: File | null, ownerId: number): Promise<void> {
    const write = this.photoWrites.catch(() => undefined).then(() => this.photoStore('readwrite', store => photoFile
      ? store.put({ file: photoFile, name: photoFile.name, type: photoFile.type, lastModified: photoFile.lastModified }, ownerId)
      : store.delete(ownerId))).then(() => undefined);
    this.photoWrites = write;
    return write;
  }

  async setProfile(profile: DriverOnboardingProfileDraft, photoFile: File | null, ownerId: number): Promise<void> {
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
    await this.setPhotoFile(photoFile, ownerId);
  }

  getProfile(): DriverOnboardingProfileDraft | null {
    const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as DriverOnboardingProfileDraft;
    } catch {
      return null;
    }
  }

  async getPhotoFile(ownerId: number): Promise<File | null> {
    await this.photoWrites.catch(() => undefined);
    const saved = await this.photoStore('readonly', store => store.get(ownerId));
    if (!saved?.file) return null;
    return new File([saved.file], saved.name, { type: saved.type, lastModified: saved.lastModified });
  }

  setRegistration(draft: DriverRegistrationDraft): void {
    localStorage.setItem(REGISTRATION_STORAGE_KEY, JSON.stringify(draft));
  }

  getRegistration(): DriverRegistrationDraft | null {
    const raw = localStorage.getItem(REGISTRATION_STORAGE_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as DriverRegistrationDraft;
    } catch {
      return null;
    }
  }

  clearRegistration(): void {
    localStorage.removeItem(REGISTRATION_STORAGE_KEY);
  }

  async clear(ownerId: number): Promise<void> {
    localStorage.removeItem(PROFILE_STORAGE_KEY);
    this.clearRegistration();
    await this.setPhotoFile(null, ownerId);
  }
}
