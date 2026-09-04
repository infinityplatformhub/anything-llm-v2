# Task 9 Report

## Manual acceptance checklist

- [x] `shows Lark button only when enabled and multi-user` — public setup data is checked with both flags at `frontend/src/components/Modals/Password/MultiUserAuth.jsx:298-307`; conditional button and normal browser navigation are at `frontend/src/components/Modals/Password/MultiUserAuth.jsx:390-401`.
- [x] `maps known error codes to fixed banners and ignores arbitrary text` — allowlisted fixed login messages are defined at `frontend/src/components/Modals/Password/MultiUserAuth.jsx:13-37`, selected by key only at `frontend/src/components/Modals/Password/MultiUserAuth.jsx:212-215`, and rendered at `frontend/src/components/Modals/Password/MultiUserAuth.jsx:343-350`. Connect callbacks use a separate fixed allowlist at `frontend/src/pages/GeneralSettings/LarkConnection/index.jsx:14-23` and `frontend/src/pages/GeneralSettings/LarkConnection/index.jsx:45-54`.
- [x] `renders disconnected connected and needs-reauth states` — enabled/unavailable, re-auth, connected, and disconnected branches are at `frontend/src/pages/GeneralSettings/LarkConnection/index.jsx:107-156`; safe profile fields, scope chips, and connected date are at `frontend/src/pages/GeneralSettings/LarkConnection/index.jsx:207-281`.
- [x] `starts connect and reconnect with connect mode` — both buttons call the shared handler at `frontend/src/pages/GeneralSettings/LarkConnection/index.jsx:59-68`; it uses existing `System.larkConnectUrl()`, whose backend request includes `mode=connect`. Login mode navigates directly to the start route without a mode at `frontend/src/components/Modals/Password/MultiUserAuth.jsx:397-401`.
- [x] `confirms disconnect and refreshes local status` — explicit confirmation opens at `frontend/src/pages/GeneralSettings/LarkConnection/index.jsx:136-140`, dialog and local-revoke warning render at `frontend/src/pages/GeneralSettings/LarkConnection/index.jsx:160-194`, and successful deletion reloads status at `frontend/src/pages/GeneralSettings/LarkConnection/index.jsx:70-85`.

## Routing and entry points

- `/settings/lark` uses `MultiUserRoute` so every authenticated multi-user role can access it at `frontend/src/main.jsx:150-157` and `frontend/src/components/PrivateRoute/index.jsx:129-148`.
- Account modal contains one `Lark` button at `frontend/src/components/UserMenu/AccountModal/index.jsx:165-174`.
- Existing admin panel moved to `/settings/admin/lark` to avoid route collision. Admin sidebar uses this admin-only path.
- `frontend/src/pages/Login/SSO/lark.jsx` stayed unchanged, preserving existing token exchange and recovery-code behavior.
- `frontend/src/models/system.js` stayed unchanged because Task 6 already supplied `larkStatus`, `larkConnectUrl`, and `disconnectLark` with required contracts.

## Verification

- `yarn --cwd frontend lint` passed. It ran repository ESLint auto-fix with no errors.
- Focused ESLint passed for all owned files.
- `yarn --cwd frontend build` passed after final route-guard change.

```text
dist/index.js                                    2,888.62 kB │ gzip: 924.31 kB
✓ built in 49.20s
Running frontend post build script...
index.html renamed to _index.html so SSR of the index page can be assumed.
Done in 49.76s.
```

Build emitted existing chunk-size and browser-externalization warnings. No build errors.

## Files

- `frontend/src/components/Modals/Password/MultiUserAuth.jsx`
- `frontend/src/components/PrivateRoute/index.jsx`
- `frontend/src/components/SettingsSidebar/index.jsx`
- `frontend/src/components/UserMenu/AccountModal/index.jsx`
- `frontend/src/main.jsx`
- `frontend/src/pages/GeneralSettings/LarkConnection/index.jsx`
- `frontend/src/utils/paths.js`
