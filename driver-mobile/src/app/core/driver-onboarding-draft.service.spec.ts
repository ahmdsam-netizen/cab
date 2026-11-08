import { DriverOnboardingDraftService } from './driver-onboarding-draft.service';

describe('Registration photo draft persistence', () => {
  const profile = { name: 'Photo Driver', email: 'photo@example.test', dob: '1995-01-01', address: 'Test city' };
  const owner = 990001;
  const otherOwner = 990002;
  afterEach(async () => {
    const drafts = new DriverOnboardingDraftService();
    await drafts.clear(owner);
    await drafts.clear(otherOwner);
  });

  it('restores identical file bytes and metadata after service recreation without losing another account photo', async () => {
    const drafts = new DriverOnboardingDraftService();
    const file = new File(['original-photo-bytes'], 'portrait.png', { type: 'image/png', lastModified: 12345 });
    await drafts.setProfile(profile, file, owner);
    const restarted = new DriverOnboardingDraftService();
    const restored = await restarted.getPhotoFile(owner);
    expect(restored?.name).toBe('portrait.png');
    expect(restored?.type).toBe('image/png');
    expect(restored?.lastModified).toBe(12345);
    expect(await restored?.text()).toBe('original-photo-bytes');
    expect(await restarted.getPhotoFile(otherOwner)).toBeNull();
  });

  it('persists photo selection before Continue and clears only the finished account after queued writes', async () => {
    const drafts = new DriverOnboardingDraftService();
    await drafts.setPhotoFile(new File(['other'], 'other.png', { type: 'image/png' }), otherOwner);
    const first = drafts.setPhotoFile(new File(['first'], 'first.png'), owner);
    const second = drafts.setPhotoFile(new File(['replacement'], 'new.png'), owner);
    await Promise.all([first, second]);
    expect(await (await new DriverOnboardingDraftService().getPhotoFile(owner))?.text()).toBe('replacement');
    await drafts.clear(owner);
    const restarted = new DriverOnboardingDraftService();
    expect(await restarted.getPhotoFile(owner)).toBeNull();
    expect(await (await restarted.getPhotoFile(otherOwner))?.text()).toBe('other');
    expect(restarted.getProfile()).toBeNull();
  });
});
