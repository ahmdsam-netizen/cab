interface ServiceAssignment {
  id: number;
  name: string;
}

export interface DriverServiceAccess {
  cities: ServiceAssignment[];
  stands: Array<ServiceAssignment & { city: ServiceAssignment | null; is_active: boolean }>;
  routes: Array<ServiceAssignment & { origin_name: string; dest_name: string; scope: 'local' | 'outstation' }>;
}
