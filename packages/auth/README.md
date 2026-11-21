# Signing in

Three packages, for any server of ours that needs to know who someone is.
None of them knows about books.

| Package | What it is |
| --- | --- |
| `@ribbon/auth` (here) | The interface, and what every provider shares: sessions, and sign-ins under way. |
| `@ribbon/auth-accounts` | A provider: a name and a password each, kept in the server's own database. |
| `@ribbon/auth-pocket-id` | A provider: a [Pocket ID](https://pocket-id.org) instance, where people sign in with passkeys. |

## The idea

**A provider proves who someone is, and nothing else.** It answers with an
`Identity` (`src/identity.ts`):

```ts
interface Identity {
  provider: string;      // "accounts", "pocket-id"
  subject: string;       // the provider's own id for them: never changes, never shown
  username: string;      // what they sign in as; they may change it
  displayName: string;   // what to call them
  picture?: string;      // where their picture is
  email?: string;
  emailVerified?: boolean;
  groups: string[];      // the provider's groups, by name
  claims: Record<string, unknown>;  // everything else it said, untouched
}
```

What the person may do, and what is theirs, is the app's business. The app
keeps its own people, each tied to `(provider, subject)`, and gives them
its own roles. Ribbon's are in `packages/server/src/auth.ts`.

There are two kinds of provider, because there are two things an app can
show:

- a **`PasswordProvider`** takes a name and a password: the app shows a
  form, and calls `check(name, password)`.
- a **`BrowserProvider`** has pages of its own: the app sends the browser
  there with `begin(state, callbackUrl)`, and learns who came back with
  `finish(query, callbackUrl, memo)`.

A new provider is one more package with one of those two shapes.

## What every provider shares

- **`Sessions`** (`src/sessions.ts`): what a device keeps once someone is
  signed in. A long random token, sent as a bearer or in a cookie, good for
  a year from the last day it was used. Only its hash is stored.
- **`BrowserSignIns`** (`src/sign-ins.ts`): a sign-in that leaves for the
  browser and comes back to an app, which trades a one-time code and a
  secret only it knows for its session.
- **`DeviceSignIns`** (`src/sign-ins.ts`): a sign-in for a TV, which shows a
  short code that someone approves from their phone.

## Reading it, in order

1. `src/identity.ts`: the two interfaces. Everything else serves them.
2. `src/sessions.ts`, then `src/sign-ins.ts`.
3. `../auth-accounts/src/accounts.ts`: the simplest provider.
4. `../auth-pocket-id/src/pocket-id.ts`: OpenID Connect in one file, and
   `test/fake-issuer.ts` beside it, the stand-in the tests sign in to.
5. `../server/src/auth.ts` and `sign-in-routes.ts`: how Ribbon's server puts
   them together.

## Checks

```bash
npm test -w @ribbon/auth -w @ribbon/auth-accounts -w @ribbon/auth-pocket-id
npm run typecheck -w @ribbon/auth -w @ribbon/auth-accounts -w @ribbon/auth-pocket-id
```

The names start `@ribbon/` only because they were born here. Nothing in
them is Ribbon's, and they can move to a repository of their own when a
second app wants them.
