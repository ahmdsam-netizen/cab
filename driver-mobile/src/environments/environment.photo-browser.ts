// Manual browser fixture only; selected explicitly with --configuration photo-browser.
import { environment as base } from './environment.prod';
export const environment = { ...base, production: false, useServerOtp: true, apiUrl: 'http://127.0.0.1:8001/api' };
