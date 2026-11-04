# Android release handoff

## 2026-11-04 — Customer navigation readiness check

- Local evidence: the customer production web build passed from the working
  tree (hash `4ae0e234d7bcbcba`). The staged snapshot omitted some latest
  customer fixes and included Driver changes, including a manifest setting
  enabling cleartext traffic and a manifest backup.
- Repository evidence: pushes to master, main or opeartor-payments trigger
  the VPS workflow. That workflow does not publish the customer Android app.
- Pending verification: customer signed build, Android GPS and boarding
  walkthrough, Private and Shuttle live navigation, and route search against
  the production API. No Play Console or production state was checked.

## 2026-10-17 — Driver APK for client review

This is a dated local build record, not proof of Play Console or production status.
The earlier handoff and `Google-Play-Release-Setup.md` referenced by AGENTS.md
were absent from this checkout; historical release details were not reconstructed.

### User-reported status

- User reported code changes and requested a fresh release APK to send to the client.
- Driver app selected based on the preceding driver UI discussion.

### Local evidence

- Built the current driver source with `npm.cmd run apk:release` from `driver-mobile`.
- Production web build, Capacitor Android sync, Android release lint and
  `assembleRelease` completed successfully using the existing signing configuration.
- Version increased from 5.1.3 (513) to 5.1.4 (514).
- APK package: `product.driver.dreamcab`; label: `CABBIES`.
- Minimum Android API: 24; target API: 36.
- Client copy: `release-apks/Cabbies-Driver-5.1.4-release-2026-10-17.apk`.
- File size: 11,930,293 bytes.
- SHA-256: `78497a8ce4ef467b2f04b8f1be7015161fa7d531cd624e88d1ccdf0ceef5c783`.
- Android apksigner verification passed with APK Signature Scheme v2.
- Signing certificate SHA-256:
  `f1090e13d1f75a22cde8d70cdb7111346ca5157237691228a76bef3d98808bd4`.
- APK metadata independently checked with Android aapt.
- Production source configuration points to `https://dreamcabs.in/api`.
- No UI redesign was implemented in this task. Customer app was not rebuilt.

### External verification and remaining limits

- No phone installation or runtime testing was performed.
- No backend, Firebase Console, or Play Console status was verified or changed.
- APK was prepared locally; it was not sent to the client or uploaded to a store.
- Compatibility with an existing installation depends on its signing certificate.

Keep signing passwords and private keys outside these notes and source control.

## 2026-10-17 — Customer APK for client review

### User-reported status

- User additionally requested a customer-app release APK.

### Local evidence

- Built current customer source with `npm.cmd run apk:release` from `customer-mobile`.
- Production web build, Capacitor sync, Android release lint and `assembleRelease`
  completed successfully using the existing customer signing configuration.
- Version increased from 5.7.0 (570) to 5.7.1 (571).
- APK package: `product.customer.dreamcab`; label: `DREAMCABS`.
- Minimum Android API: 24; target API: 36.
- Client copy: `release-apks/DreamCabs-Customer-5.7.1-release-2026-10-17.apk`.
- File size: 11,497,138 bytes.
- SHA-256: `72b2bce89f1c3be31f23a74a71111aa659f18d0e03e57e0f399cb7727422c46e`.
- Android apksigner verification passed with APK Signature Scheme v2.
- Signing certificate SHA-256:
  `832ba8215bf2220054245b094f78e06f84a2916c396f73ef7d5b200678b1319e`.
- APK version and package independently verified with Android aapt.
- Packaged main JavaScript bundle hash matches the fresh production build.
- Production source configuration points to `https://dreamcabs.in/api`.
- Build log: `release-apks/customer-5.7.1-build.log` (ignored by Git).

### External verification and remaining limits

- No phone installation or runtime testing was performed.
- No backend, Firebase Console, or Play Console status was verified or changed.
- APK was prepared locally; it was not sent to the client or uploaded to a store.
- Compatibility with an existing installation depends on its signing certificate.
