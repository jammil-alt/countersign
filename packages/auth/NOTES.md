# packages/auth: what is unchecked against WorkOS

Written from WorkOS's documentation and our own tests with a fake WorkOS client; none of it has
been tried against a real WorkOS environment yet. Check each item on staging and mark it checked
(with the date) or fix the code.

## Onboarding's invites (`docs/plan.md` §1.149, `docs/cases-plan.md` §4.4)

The invite a client's person gets is **one email, ours**: the branded invite from their lead with a
link to our welcome page (`/start/<token>`). WorkOS should send nothing of its own for it.

- **UNCHECKED: sign-up without a WorkOS invitation.** Our flow assumes AuthKit lets an address that
  has no WorkOS user yet sign up (Google, Microsoft, or email with a code or password) without a
  WorkOS invitation, and that our callback then claims the `app_user` row made for that address
  (`provision`: a verified email claims an invited row; anyone not invited is refused). §1.14
  already says a person can sign in with the invited address when the invitation email failed,
  which suggests sign-up is open in our settings. To check: on staging, make an `app_user` row and
  membership for a new address (Invite, or Sign up now) without calling `AuthAdapter.invite`, open
  the welcome page's link, choose "Continue with email" and sign up. Also with Google and with
  Microsoft.
- **If sign-up needs an invitation (the fallback, kept behind the adapter):** turn WorkOS's own
  invitation email off (WorkOS → the environment → Authentication or Emails, depending on the
  dashboard; UNCHECKED where) and make the invitation with `WorkOSAdapter.invitationLink(email)`,
  which creates it and returns its accept URL without our code sending anything. The welcome page
  then sends the person to that accept URL instead of `/api/auth/sign-in` (a change in
  `apps/web/src/onboarding/Welcome.tsx` and the invite stream's `runInvite`, which would store the
  invitation's id). Our welcome page stays in front either way.
- **Do not call `AuthAdapter.invite` for an intake's people** while sign-up is open: with WorkOS's
  invitation email on, it would send a second, unbranded email.
- **UNCHECKED: `login_hint`.** The welcome page starts sign-in with `login_hint=<invited address>`
  (`/api/auth/sign-in?method=…&login_hint=…`). WorkOS's authorize endpoint documents `login_hint`
  for AuthKit (it fills the email field) and passes it to Google and Microsoft OAuth (which
  preselect the account). Check all three. It is only a convenience: the callback and then the
  welcome page check the address that actually signed in.
- **UNCHECKED: `provider=GoogleOAuth` and `provider=MicrosoftOAuth`** go straight to Google's or
  Microsoft's sign-in, skipping AuthKit's page. Both need the provider switched on in the WorkOS
  environment (Authentication → Social login) with Mezonas' own OAuth clients in production
  (WorkOS's shared test clients show WorkOS's name on the consent screen).
- **UNCHECKED: branding on the sign-in and its code emails.** The Mezonas logo and colours on
  AuthKit's hosted pages and the emails WorkOS sends (sign-in codes, password resets), and the
  custom domain `auth.mezonas.com` if the plan allows. Owner steps: `docs/operations.md` ("By
  hand", WorkOS).
