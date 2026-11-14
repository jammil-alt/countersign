# Mezonas for iPhone and Android (`apps/mobile`)

The phone app (docs/plan.md §1.99): Your Desk, signing with Face ID or a fingerprint, questions
answered in one tap, release codes, messages with your Mezonas lead, notifications and the person's
phones. Expo SDK 58 (React Native 0.88, React 19.3) with expo-router. It reaches the platform only
through the API, typed by `@countersign/core`'s route contract; its look comes from
`packages/design-system/tokens.json` (`pnpm --filter @countersign/mobile tokens` writes
`src/theme/tokens.ts` again after a new delivery).

## How it works

- **Sign-in.** The system browser opens `/api/mobile/sign-in?challenge=…` (a PKCE S256 challenge),
  which runs the usual WorkOS sign-in and ends at `mezonas://signed-in?code=…`. The app trades the
  code and its verifier at `POST /api/mobile/session` for the sealed session, kept in the secure
  store and sent as `x-mezonas-session` on every request; a response carrying that header gives the
  session sealed again, or ends it (empty). Every rule of a browser session holds: 12 hours at most,
  30 minutes idle (only the person's own taps count, `x-countersign-activity: 1`).
- **The lock.** A cold start, or five minutes in the background, asks for Face ID or a fingerprint
  before anything shows.
- **This phone.** Setup asks to send notifications (an Expo push token), makes an ECDSA P-256 key
  (`@noble/curves`, seeded from `expo-crypto`), keeps its private half in the secure store behind
  Face ID or a fingerprint, and registers the phone (`POST /api/me/devices`, the public half as a
  JWK).
- **Signing.** Sign or Reject reads the key (that read is the Face ID prompt) and signs core's
  `deviceSignedText` (device, item, decision, the item's fingerprint, the time); the signature rides
  on `POST /api/inbox/:id/resolve`. The undo window then counts down on the Desk.
- **Notifications.** A count and nothing else on the lock screen (or with the business name, if the
  person chose that). A tap opens the Desk, Messages or Settings (`data.kind`, `data.path`).

## Run it

Expo Go is not enough: biometric secure-store reads and push need a development build.

```sh
pnpm install
cd apps/mobile
# A development build on a phone or simulator (needs Xcode or Android Studio locally), or with EAS:
npx expo run:ios            # or: npx expo run:android
npx eas build --profile development --platform ios     # internal build for a registered iPhone
npx expo start --dev-client # then open the development build
```

Against local `wrangler dev` with the dev adapter: set `EXPO_PUBLIC_API_ORIGIN=http://<your-lan-ip>:8787`
and use "Dev sign-in" (development builds only) with a seeded user's email; it sends
`x-countersign-dev-user`.

Without a phone, the fixture build runs every screen in a browser with made-up data and no API:

```sh
EXPO_PUBLIC_FIXTURES=1 npx expo start --web
```

## Settings

| Name | Where | What |
|---|---|---|
| `EXPO_PUBLIC_API_ORIGIN` | `eas.json` per profile, or the shell | The Mezonas API. Default `https://staging.mezonas.com`; production builds use `https://app.mezonas.com`. |
| `EAS_PROJECT_ID` | the shell / EAS environment | The EAS project (`eas init` makes it). Push tokens need it; without it setup skips notifications. |
| `EAS_OWNER` | the shell / EAS environment | The Expo account or organization that owns the project. |
| `EXPO_PUBLIC_FIXTURES` | the shell | `1` runs on fixtures (`src/api/fixtures.ts`), never a real API. |
| `GOOGLE_SERVICES_JSON` | EAS file variable (`eas env:create --type file`) | Firebase's `google-services.json` for the Android app: Android push needs it. Never committed. |

## Builds and stores

```sh
npx eas init                                   # once: creates the project, prints EAS_PROJECT_ID
npx eas credentials                            # Apple certificates and the APNs key; Android keystore and FCM (V1) key
npx eas build --profile preview --platform all # internal builds to install on test phones
npx eas build --profile production --platform all
npx eas submit --platform ios                  # App Store Connect (TestFlight first)
npx eas submit --platform android              # Google Play (internal testing first)
```

Push goes through Expo's push service: EAS holds the APNs key and the FCM V1 service account
(`eas credentials`), and the API sends to Expo with the person's token.

## Accounts (once)

All in the company's name (Twelve Thirty-Four), never a person's, so the apps stay with the
company. Nothing here is shared with Plenary Labs.

**Both stores need a D-U-N-S number** for Twelve Thirty-Four, with the legal name and address
exactly as registered. Look it up (or request one, free) through Apple's D-U-N-S lookup on the
developer site; a new number takes up to about a week to reach Apple.

**Apple** (iPhone builds need it; nothing installs on an iPhone without it):
1. An Apple Account for the company (a shared address such as apps@ on the company's domain), with
   two-factor on.
2. Enroll at developer.apple.com/programs/enroll as an **organization**: the D-U-N-S number, the
   company's website, and the authority to sign for it. $99 a year. Apple may call to check.
3. Once approved: add the team in App Store Connect (Users and Access). EAS makes the bundle id
   `com.mezonas.app`, the certificates and the push key (APNs) on the first
   `npx eas build --platform ios`; register test iPhones first with `npx eas device:create`.
4. TestFlight for testers before any store release.

**Google** (Android builds install from a link without it; the store and push need it):
1. Google Play Console as an **organization** ($25 once), with the same D-U-N-S number and a
   payments profile for the company; Google verifies the business and a contact person.
   Organization accounts are not held to the closed test (12 testers for 14 days) that new
   personal accounts are.
2. Create the app "Mezonas", package `com.mezonas.app`.
3. Push: a Firebase project for Mezonas, add the Android app `com.mezonas.app`, download
   `google-services.json` and store it as the EAS file variable `GOOGLE_SERVICES_JSON`; then a
   service-account key for Firebase Cloud Messaging (V1), uploaded with `npx eas credentials`
   (Android, push notifications).

**Expo**: an organization account for Mezonas, then `npx eas init` here (set `EAS_OWNER` to it).

## What is checked here, and what isn't

Checked: `pnpm --filter @countersign/mobile typecheck` and `test` (the API client's headers and
sign-out, PKCE against RFC 7636, the signature verified with Web Crypto exactly as the API checks
it, the fingerprint against core's text, the lock, the Desk's rules); the fixture build exported for
web and every main screen looked at in Chromium at phone size, light and dark.

Not checked here (needs a phone, the accounts and staging): the system-browser sign-in round trip
against WorkOS, Face ID and fingerprint prompts and the secure store's biometric reads, Expo push
tokens and delivery, the app on a real iPhone and Android phone, store builds and review.
