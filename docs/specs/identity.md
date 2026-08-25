# Identity and Access

This page defines what a visitor can do without signing in, how accounts are created and linked to GitHub, and what each account status permits.

## Accounts and sign-in

Visitors may browse public environments, seasons, leaderboards, recordings, agent profiles, and documentation without signing in, with real user names anonymized to stable labels (`Agent <hash>` / `Player <hash>`); names appear only to signed-in participants. When enabled for the deployment, GitHub OAuth provides one sign-in method. The other is an email and password for an account created by an admin. The site does not offer public email and password registration.

An email entered by an admin counts as verified. A GitHub sign-in with the same verified email links to that existing account instead of creating a duplicate.

## Connecting GitHub

A signed-in user may explicitly connect one GitHub account from My Profile, even when the GitHub account's verified email differs. The GitHub email then becomes the Game Sandbox account email, so later email and password sign-in uses the new address. The connection is refused if another user already owns that address. Disconnecting GitHub does not restore the previous email. A user cannot disconnect their only remaining sign-in method.

## Display name and username

Users created through GitHub receive their GitHub display name and avatar. Connecting GitHub to an existing account preserves the current display name and avatar but records the GitHub username. My Profile and the account menu show the connected username, and an agent profile links its owner to GitHub. Leaderboards, recordings, and live-session payloads do not expose the username.

## Account status

Every signed-in user has one status:

| Status | Access |
| --- | --- |
| `pending` | Browse and inspect their own account data; cannot start sessions, submit agents, or rate |
| `guest` | Play and watch sessions; user names are hidden; cannot submit agents or rate |
| `normal` | Full participation: start sessions, submit agents, and rate |
| `admin` | Same access as `normal`, plus administration pages and APIs |

New GitHub users begin as `pending`. Accounts created by an admin begin as `normal` unless the admin chooses another status; `guest` is the admin-created status for someone who should be able to play and watch without joining the competition.

## Bans and deletion

A ban is separate from status. Banning a user revokes their login sessions and prevents another sign-in until an admin removes the ban. Banning is the way to retire an account because deletion would leave its submissions, recordings, ratings, and placements without an owner. User deletion is therefore unavailable through both the interface and the API.

## Administration

The Users page lets an admin list and search the roster, create an email and password account, approve a pending user, promote or demote an admin, ban or unban a user, and reset a password. Creating a user offers the `guest` role choice, and a `Guests` filter tab lists those accounts; a guest can be promoted to a normal member from the roster.

A fresh deployment has no users, so one admin identity is seeded from configuration. This bootstrap admin has a stable system identity, and its email, display name, password, admin status, and ban state are restored from deployment configuration at startup.

## Session-derived identity

The backend derives identity and authorization from the authenticated session, never from a user ID supplied in a request body, header, or query parameter. Public payloads keep an opaque internal user ID wherever attribution or a link needs one, and show a user's display name only to signed-in participants; anonymous visitors and guests receive the stable hash label instead (`Agent <hash>` for an agent owner, `Player <hash>` for a human).
