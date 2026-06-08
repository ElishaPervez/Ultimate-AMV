# Ultimate AMV Theme Engine

A modular, "deep" CSS theme engine. A developer can completely overhaul the
UI — colors, fonts, spacing, backgrounds, even layout — **through CSS alone**,
by adding a theme: a folder containing a `theme.json` manifest plus a CSS file.

Conceptually this is like SourceBans++ themes: drop in a folder, pick it from a
menu, the whole app reskins. No code changes, and for external themes, no
rebuild.

---

## 1. Mental model: two CSS cascade layers

The engine is built on [CSS cascade layers](https://developer.mozilla.org/en-US/docs/Web/CSS/@layer).
`src/styles.css` declares the order once, at the very top:

```css
@layer reset, base, theme, user;
```

Then the entire existing app stylesheet (all 10 files in `src/styles/`) is
imported **into the `base` layer**:

```css
@import "./styles/base.css" layer(base);
@import "./styles/shell.css" layer(base);
/* …all the rest… */
```

The **active theme's CSS is injected into the `theme` layer** at runtime, into a
single `<style id="amv-theme">` element in `<head>` (see
`engine/themeLoader.ts`). The injected CSS is wrapped like this:

```css
@layer theme {
  /* …the theme's CSS… */
}
```

**Why this matters:** a later layer beats an earlier layer *regardless of
selector specificity*. So a theme rule like

```css
:root[data-theme-id="my-theme"] .sidebar { background: red; }
```

wins over the app's own `.sidebar { background: … }` in `base` **without needing
`!important`** — even though the base selector might be more specific. You never
fight specificity; you just write the rule you want in the theme layer.

> The `reset` and `user` layers are reserved for future use. The engine only
> ever writes to `theme`.

### What a theme can and cannot do

- ✅ **Can:** restyle and re-lay-out the existing DOM — colors, fonts, spacing,
  borders, radii, backgrounds, fl/grid layout of existing elements, show/hide
  elements, swap background images, load webfonts.
- ❌ **Cannot:** change which React component renders. The engine is
  **CSS-only**. A theme cannot add a new button, reorder React components, or
  change app logic.

**The one documented exception:** the two flagship themes are genuinely "old UI
vs new UI" for the audio panel. When the active theme is `ultimate-amv-old`,
`src/shell/App.tsx` renders the legacy `AudioExtractionPanel`; every other theme
renders `NewAudioExtractionPanel`. This is the *only* place a React component is
branched on the theme id, and it is deliberate. Do not add more component
branches — everything else is pure CSS.

---

## 2. The accent color is a separate axis

The app already had an accent-color system (Settings → Appearance: pick one or
two colors for buttons/highlights/active tabs). That is **orthogonal** to the
theme engine and keeps working inside whichever theme is active.

- The **theme** sets the overall look (surfaces, layout, radii, backgrounds,
  default accent).
- The **accent** is the user's chosen highlight color, applied as inline
  `:root` styles (`--theme-accent-rgb`, `--theme-accent-2-rgb`,
  `--theme-accent-contrast`).

Because inline styles beat *any* cascade layer, a user's saved accent will
override a theme's `--theme-accent-*` defaults. That's intentional: themes
should read as distinct via their *non-accent* changes (surfaces, layout,
backgrounds), and the accent stays the user's call. Set sensible
`--theme-accent-*` defaults in your theme so it looks right out of the box, but
don't rely on them being the final word.

---

## 3. Theme folder & manifest format

A theme is a folder:

```
my-theme/
  theme.json      ← manifest (required)
  theme.css       ← the CSS entry (required; name configurable via manifest)
  assets/         ← optional images, fonts, etc.
    bg.png
    font.woff2
```

`theme.json`:

```json
{
  "id": "my-theme",
  "name": "My Theme",
  "description": "A short blurb shown in the picker tooltip.",
  "author": "Your Name",
  "version": "1.0.0",
  "entry": "theme.css"
}
```

| Field         | Required | Notes                                                                 |
|---------------|----------|-----------------------------------------------------------------------|
| `id`          | no\*     | For **external** themes the folder name IS the id; an explicit `id` must match it. For **built-in** themes use the folder name. |
| `name`        | no       | Display name in the picker. Falls back to the id.                      |
| `description` | no       | Tooltip text in the picker.                                           |
| `author`      | no       | Informational.                                                        |
| `version`     | no       | Informational.                                                        |
| `entry`       | no       | CSS file to load, relative to the folder. Defaults to `theme.css`.    |

\* Recommended for built-ins so the id is stable regardless of folder renames.

---

## 4. The token contract (for a broad reskin)

The fastest way to reskin everything at once is to redefine the design tokens
that `src/styles/base.css` declares on `:root`. Scope them to your theme id so
they only apply when your theme is active:

```css
:root[data-theme-id="my-theme"] {
  /* ---- Accent (also overridable by the user's accent picker) ---- */
  --theme-accent-rgb: 124 130 255;     /* space-separated RGB, used as rgb(var(--…)) */
  --theme-accent-2-rgb: 86 214 230;    /* secondary accent for gradients */
  --theme-accent-contrast: #0a0b18;    /* readable text color on accent fills */

  /* ---- Text ---- */
  --ink: #f1f3fb;                      /* primary text */
  --muted: #9aa3c2;                    /* secondary/muted text */

  /* ---- Surfaces ---- */
  --line: rgba(150, 160, 220, 0.08);   /* hairline dividers */
  --panel: rgba(14, 15, 28, 0.78);     /* standard panel background */
  --panel-strong: rgba(18, 19, 34, 0.9); /* stronger panel background */
  --glass: rgba(140, 150, 220, 0.05);  /* glass fill */
  --glass-border: rgba(150, 160, 230, 0.12); /* glass border */

  /* ---- Geometry ---- */
  --radius-xl: 22px;
  --radius-lg: 16px;
  --radius-md: 12px;
}
```

Derived tokens (`--accent`, `--accent-gradient`, `--accent-glow`,
`--accent-soft`, `--accent-muted`, `--accent-border`, …) are all computed from
`--theme-accent-rgb` / `--theme-accent-2-rgb` in `base.css`, so redefining the
two RGB tokens cascades to all of them automatically.

There are also layout tokens you can nudge:
`--sidebar-expanded-width`, `--sidebar-compact-width`, `--sidebar-label-width`,
`--sidebar-gap`, and `--spring-easing` (the spring transition curve).

After the broad token pass, add **targeted selector overrides** for anything you
want to polish further (the `ultimate-amv` built-in theme is the worked example
— see `builtin/ultimate-amv/theme.css`). Useful structural classes to target:
`.sidebar`, `.workspace-header h1`, `.focus-panel`, `.glass` / `.glass-strong`,
`.mode-tab.is-active`, `.sidebar-home.is-active`, `.sidebar-subitem.is-active`.

---

## 5. Worked example: the `ultimate-amv` default theme

`builtin/ultimate-amv/theme.css` is the reference. It does two things:

1. **Token redefinition** — a new indigo→aqua accent, deeper violet glass
   surfaces, rounder radii. One block, broad effect.
2. **Targeted overrides** — tinted sidebar with an accent edge, a gradient-text
   workspace title, accent-washed active nav items, filled accent mode-tab
   pills, and a few audio-panel card tweaks.

It also paints a deep indigo page background **only when no user wallpaper is
set** (`:not(.has-app-bg)`), so it doesn't fight the background-image feature:

```css
:root[data-theme-id="ultimate-amv"]:not(.has-app-bg) body { background: …; }
```

Compare it with `builtin/ultimate-amv-old/theme.css`, which is a near-empty
*identity* theme: the base layer already IS the classic look, so "Old" only
re-asserts the classic cyan accent (and pairs with the legacy audio panel via
the component exception above).

---

## 6. Creating a new theme

### 6a. A built-in (bundled) theme

1. Create `src/themes/builtin/<your-id>/theme.json` and `theme.css`.
2. That's it. `engine/themeRegistry.ts` discovers built-ins at **build time**
   via Vite `import.meta.glob`:
   - `../builtin/*/theme.json` → manifest
   - `../builtin/*/**/*.css` (inlined as a string) → the entry CSS
   So the next `npm run build` / `npm run dev` picks it up; it appears in the
   sidebar Theme picker automatically.
3. Built-in theme assets are bundled normally — reference them however Vite
   resolves them (e.g. import the asset in a `.ts` and inject the URL, or use a
   `data:` URL). Built-ins do **not** get the external `url()` rewriting that
   drop-in themes get.

### 6b. A runtime drop-in (external) theme — no rebuild

This is the SourceBans-style path.

1. Build your theme folder anywhere (start by copying
   `theme-examples/midnight-neon/`).
2. Copy the whole folder into the app's runtime themes directory:

   ```
   Windows:  %APPDATA%\com.elishapervez.ultimateamv\themes\<your-id>\
   ```

   The app **creates this `themes/` directory on first run** if it doesn't
   exist. (The folder name becomes the theme id.)
3. Open the app → sidebar **Theme** dropdown → pick your theme. It shows up with
   a `drop-in` tag. No rebuild, no restart needed beyond reopening the picker
   (the list re-scans disk each time it's opened).

Under the hood: the Rust `list_themes` command scans
`<app state dir>/themes/*/theme.json` and returns each manifest plus the
absolute folder path; `read_theme_css` returns the entry CSS for a chosen id.
Both guard against path traversal — the id must match a discovered folder.

---

## 7. Using assets (images & fonts)

### External themes

Reference assets with **relative paths** from your `theme.css`:

```css
:root[data-theme-id="my-theme"] body {
  background-image: url(./assets/bg.png);
}
@font-face {
  font-family: "MyFont";
  src: url(./assets/MyFont.woff2) format("woff2");
}
```

The engine rewrites every relative `url(./…)` to a Tauri **asset-protocol** URL
rooted at your theme folder (`engine/themeLoader.ts` →
`rewriteExternalAssetUrls`), so the files resolve at runtime. Absolute URLs
(`http(s):`, `data:`, `blob:`, `asset:`, root-relative `/…`, and in-document
`#…` refs) are left untouched.

### CSP / `font-src` note

Tauri enforces a Content-Security-Policy. The app's CSP
(`src-tauri/tauri.conf.json` → `app.security.csp`) allows themes to load:

- **images** from `asset:` / `http://asset.localhost`, `https:`, `data:`,
  `blob:` (via `img-src`)
- **fonts** from `asset:` / `http://asset.localhost`, `data:`, and
  `https://fonts.gstatic.com` (via `font-src`)

So: a webfont shipped inside your theme folder (loaded via the rewritten
asset URL), a `data:` font, or a Google Fonts `gstatic` font will all work. A
font from some *other* https origin will be blocked — either self-host it in
your theme's `assets/` or inline it as `data:`.

> On Windows, Tauri v2's asset origin is `http://asset.localhost` — that exact
> origin is already in the CSP. The runtime themes dir lives under `$APPDATA`,
> which is in `assetProtocol.scope`.

### v1 limitation: no nested `@import`

For external themes, the entry CSS must be **self-contained** — a single
`theme.css` (plus assets). Nested `@import "other.css"` inside the entry is
**not** resolved by the engine in v1. Put all your CSS in the one entry file.

---

## 8. Testing / previewing a theme

- **Built-in:** `npm run dev`, open the app, use the sidebar Theme picker. Edits
  to `theme.css` hot-reload.
- **External:** drop the folder in `%APPDATA%\com.elishapervez.ultimateamv\themes\`,
  open the Theme picker (it re-scans on open). After editing the file, re-pick
  the theme to re-inject the updated CSS.
- **Verify layer override works:** open WebView2 devtools (in a dev build),
  inspect an element your theme restyles, and confirm your `@layer theme` rule
  wins over the `@layer base` rule in the Styles pane — with no `!important`.
- **Check the active id:** `document.documentElement.dataset.themeId` reflects
  the currently applied theme.

---

## 9. File map

```
src/themes/
  engine/
    types.ts            ← ThemeManifest / ThemeEntry / DEFAULT_THEME_ID
    themeRegistry.ts    ← build-time discovery of built-in themes (import.meta.glob)
    themeLoader.ts      ← runtime: applyTheme / listThemes / persistence / url() rewrite
    ThemeProvider.tsx   ← React context + useActiveTheme() hook
  builtin/
    ultimate-amv/       ← DEFAULT theme (new direction; worked example)
    ultimate-amv-old/   ← classic look (identity theme + legacy audio panel)
  README.md             ← this file

theme-examples/
  midnight-neon/        ← example EXTERNAL theme (copy into the runtime themes dir)

src/styles.css          ← declares @layer order; imports the app CSS into `base`
src-tauri/src/themes.rs ← list_themes / read_theme_css commands
```

Persistence: the active theme id is stored under the config key **`ui_theme`**
(default `"ultimate-amv"`), separate from the accent `theme` key.
