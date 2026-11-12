# Standalone runner contract

This applies to NASANI standalone output only. The packaged `lib/engine/{runner,format,svg,swiper}.cjs` modules are the source of truth; validation errors refine this summary. Do not impose these constraints on an existing application. Local/bridge tools take `directory`; direct remote tools take a `bundle` with explicit HTML, CSS and base64 assets instead.

## Document and CSS

Use an explicit HTML5 document, charset, viewport and exactly one stylesheet link to `style.css`. Each body region has this native structure, with unique semantic role names:

```html
<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Page title</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div class="hero-wrap">
    <div class="wrap-content">
      <div class="hero-layout">
        <h2 class="hero__title">Actual design text</h2>
      </div>
    </div>
  </div>
</body>
</html>
```

Define `.wrap-content` exactly once at top level, never override it by region or media query:

```css
.wrap-content {
  max-width: 1200px;
  margin-inline: auto;
  padding-inline: 15px;
  width: 100%;
  box-sizing: border-box;
}
```

Here the MCP `content_width` is **1200**, not 1170 or the frame width. Replace it with the measured wrapper width. Region backgrounds/outer spacing belong on `hero-wrap`; inner layout belongs on `hero-layout`.

- Content HTML allowlist: `div span h2 h3 h4 h5 h6 p a ul li form label input select textarea button img`, plus inert validated SVG and document tags. The first heading is `h2`; this legacy export convention does not replace native app semantics.
- Use semantic BEM classes; `block__element` needs an owning block or `block-layout` ancestor. A modifier retains its base class. Reuse meaningful component blocks instead of duplicating identical CSS. No empty decorative divs, except supported Swiper controls.
- No scripts, inline styles, event handlers, iframes, external URLs, `@import`, `data:` URLs or external fonts. Links use local `#fragments`. Buttons use `type="button"`; inert demo forms use `method="dialog"`. Do not turn functional application forms into inert forms merely to satisfy this export policy.
- Width/margin/padding rules target actual BEM classes or `html`/`body`, never global `*` or anonymous `div`. A grid has a scoped direct-child rule immediately after it: `.hero-layout > * { min-width: 0; }`.
- Use normal-flow layout for content, absolute positioning only for measured overlap/decorations. Preserve crop, masks, rotation and stacking without applying baked image transforms twice.
- Do not use CSS attribute selectors or arbitrary custom properties/functions rejected by the validator. Prefer ordinary CSS lengths, percentages and valid dimensional math. The formatter supports a narrow measured parent-dimension convention; inspect existing runner examples before using it.
- Keep desktop styles as base CSS and add meaningful responsive rules, including mobile behavior around 600px where relevant. The optional responsive flag checks the existing runner policy; it is not a guarantee that every required breakpoint exists or looks correct.

## Assets

Download original images, icons and licensed fonts through the official Figma tools or host file tools into `assets/`. Match each image to its actual node, visible crop and stacking, not its filename alone. Every image has alt text and a local source. Use source SVGs/icons where available; do not redraw complex artwork from memory. The runner supports validated SVG, PNG, JPEG, WebP and common font files, with byte/pixel limits. Keep unsupported originals separate from the validated output.

`nasani_assets` checks referenced local paths and asset policy; it does not delete unused assets or prove visual completeness. `nasani_format` can embed validated SVGs and change markup/styles; read the result and compare again. The source HTML and CSS combined are limited to 16 MiB, each asset to 20 MiB, total referenced assets to 64 MiB; the runner also enforces SVG and decoded-pixel limits.

## Declarative Swiper

Use the existing project's carousel when integrating into an app. For standalone NASANI sliders, library-only wrapper/slide classes remain separate from meaningful BEM item classes:

```html
<div class="swiper gallery__slider">
  <div class="swiper-wrapper">
    <div class="swiper-slide">
      <div class="gallery__item"><p>Actual item content</p></div>
    </div>
  </div>
</div>
```

The slider must live under its owning `gallery` block or `gallery-layout`. Scope library CSS beneath `.swiper.gallery__slider`. Example tool arguments:

```json
{
  "directory": ".nasani/gallery",
  "swipers": [{
    "selector": ".swiper.gallery__slider",
    "config": {"slidesPerView": 1.25, "loop": false, "autoplay": false}
  }]
}
```

For validation/formatting add the measured `content_width`. Use the same entries throughout. The existing generator validates allowed options, normalizes spacing, controls and dependencies, and returns `functions`, `apps`, `bridge`, normalized `swipers` and pinned library URLs. It writes nothing and executes nothing. Prefer returned trusted helpers over invented callbacks. `config` is declarative data only, at most 20 sliders.

Vertical sliders are desktop-only, `loop:false`, with owned scrollbar/mousewheel; `mobile_only:true` cannot be vertical. Freely arranged mosaics should retain their desktop composition rather than being forced into one row; a mobile-only slider can be appropriate. A centered perspective carousel is a candidate for native coverflow, with values chosen from the actual design.

Keep the validated `index.html` script-free. If a runnable standalone slider demo is requested, create a **separate** `demo.html` using the host's file tools, load the returned pinned dependencies in order (jQuery, Swiper, helpers, apps; Swiper CSS as needed), and test it. `demo.html` is outside the strict static validator contract. The returned bridge supports the original web preview pipeline and need not be injected into an app. Do not claim the static validator has checked the interactive demo.
