# Deployment branding

Status: complete. The owner approved the charcoal, crimson, and gold Game Sandbox emblem on 2026-08-24. The bundled icon and third-party override shipped together.

The shared chrome uses one deployment brand from `GET /api/config`: the full name, compact name, and icon URL. The bundled opaque PNG is the default icon in the sidebar, mobile bar, and browser favicon. `SITE_ICON_URL` accepts a root-relative path or an absolute HTTP(S) URL so another deployment can use its own hosted artwork without rebuilding the frontend.

Frontend startup renders the bundled name and icon immediately, then applies valid public configuration. A failed or malformed response leaves the defaults in place. Unit coverage owns config parsing, the public response, client loading, favicon replacement, and sidebar rendering.
