# Mezonas for iPhone and Android (`apps/mobile`)

The phone app (docs/plan.md §1.97): Your Desk, signing with Face ID or a fingerprint, questions
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

## What is checked here, and what isn't

Checked: `pnpm --filter @countersign/mobile typecheck` and `test` (the API client's headers and
sign-out, PKCE against RFC 7636, the signature verified with Web Crypto exactly as the API checks
it, the fingerprint against core's text, the lock, the Desk's rules); the fixture build exported for
web and every main screen looked at in Chromium at phone size, light and dark.

Not checked here (needs a phone, the accounts and staging): the system-browser sign-in round trip
against WorkOS, Face ID and fingerprint prompts and the secure store's biometric reads, Expo push
tokens and delivery, the app on a real iPhone and Android phone, store builds and review.
