---
name: Short-Drama Asset Management System
colors:
  surface: '#f9f9ff'
  surface-dim: '#d0daf2'
  surface-bright: '#f9f9ff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f0f3ff'
  surface-container: '#e8eeff'
  surface-container-high: '#dfe8ff'
  surface-container-highest: '#d9e3fb'
  on-surface: '#111c2d'
  on-surface-variant: '#434655'
  inverse-surface: '#273143'
  inverse-on-surface: '#ecf0ff'
  outline: '#737686'
  outline-variant: '#c3c6d7'
  surface-tint: '#0053db'
  primary: '#004ac6'
  on-primary: '#ffffff'
  primary-container: '#2563eb'
  on-primary-container: '#eeefff'
  inverse-primary: '#b4c5ff'
  secondary: '#515f74'
  on-secondary: '#ffffff'
  secondary-container: '#d5e3fd'
  on-secondary-container: '#57657b'
  tertiary: '#006056'
  on-tertiary: '#ffffff'
  tertiary-container: '#007b6e'
  on-tertiary-container: '#b1fff1'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#dbe1ff'
  primary-fixed-dim: '#b4c5ff'
  on-primary-fixed: '#00174b'
  on-primary-fixed-variant: '#003ea8'
  secondary-fixed: '#d5e3fd'
  secondary-fixed-dim: '#b9c7e0'
  on-secondary-fixed: '#0d1c2f'
  on-secondary-fixed-variant: '#3a485c'
  tertiary-fixed: '#71f8e4'
  tertiary-fixed-dim: '#4fdbc8'
  on-tertiary-fixed: '#00201c'
  on-tertiary-fixed-variant: '#005048'
  background: '#f9f9ff'
  on-background: '#111c2d'
  surface-variant: '#d9e3fb'
typography:
  headline-sm:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  title-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '600'
    lineHeight: 24px
  title-sm:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '600'
    lineHeight: 20px
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  body-sm:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
  label-md:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: 0.02em
  label-sm:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: '500'
    lineHeight: 14px
    letterSpacing: 0.03em
  mono-sm:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  unit: 4px
  container-padding: 16px
  table-cell-padding: 8px 12px
  gutter: 12px
  sidebar-width: 240px
  inspector-width: 320px
---

## Brand & Style
The design system is engineered for high-density AIGC production environments, specifically tailored for short-drama resource management. The brand personality is **utilitarian, precise, and systematic**, prioritizing information density and speed of recognition over decorative elements.

The aesthetic follows a **Corporate / Modern** style with a focus on data clarity. It utilizes a neutral foundation to allow colorful media assets (video, posters, storyboards) to remain the focal point. The UI evokes an emotional response of organized control and professional efficiency, essential for teams managing thousands of granular digital assets.

## Colors
The palette is functional and categorized by asset type and status.
- **Action & Primary:** Blue (#2563EB) is reserved for primary actions, selections, and active states.
- **Resource Coding:** Video assets are represented by Slate (#334155), while Audio assets use Cyan (#14B8A6) for immediate visual filtering.
- **Semantic Status:** Approved (Green), Pending (Amber), and Rejected (Red) provide instant feedback on asset readiness.
- **Neutral Foundation:** A light gray background (#F7F8FA) differentiates the workspace from white surface containers (#FFFFFF), reducing eye strain during long production sessions.

## Typography
The system uses **Inter** for its exceptional legibility at small sizes. For Chinese character support, **Noto Sans SC** is the secondary fallback.
- **High-Density Scaling:** The base body size is set to 13px/14px to allow more data on screen.
- **Labels:** Uppercase or semi-bold labels at 11px are used for metadata headers in inspector panels.
- **Monospace:** Technical metadata (file paths, hash IDs, prompt strings) should use a monospace font for character alignment and technical clarity.

## Layout & Spacing
This system employs a **Fixed-Fluid hybrid grid** designed for 16:9 and 21:9 displays common in video production.
- **Three-Pane Architecture:**
  1. **Navigation:** A collapsed or 240px left sidebar.
  2. **Canvas/Grid:** A fluid center area for asset browsing or dependency mapping.
  3. **Inspector:** A fixed 320px right panel for deep metadata and versioning.
- **Rhythm:** A strict 4px baseline grid. Content uses 12px gutters to maximize horizontal real estate.
- **Density:** Table rows are capped at 40px height to ensure high visible row counts.

## Elevation & Depth
Depth is communicated through **Tonal Layering** rather than heavy shadows to maintain a clean, "flat-plus" professional look.
- **Level 0 (Background):** #F7F8FA.
- **Level 1 (Cards/Tables):** #FFFFFF with a 1px border (#D0D5DD).
- **Level 2 (Overlays/Modals):** #FFFFFF with a subtle ambient shadow (0px 4px 12px rgba(0,0,0,0.08)).
- **Active State:** Elements being dragged or selected receive a primary-colored glow/outline rather than an elevation lift.

## Shapes
A consistent 8px (`0.5rem`) corner radius is applied to all primary containers, cards, and large buttons to soften the high-density grid.
- **Small Components:** Tags, chips, and small input fields use a reduced 4px radius to prevent "circular" shapes from wasting space in tight table rows.
- **Media Thumbnails:** Must carry the 8px radius for visual consistency with their parent cards.
- **Dependency Nodes:** Small 4px radius or pill-shaped to denote connectivity.

## Components
- **Compact Tables:** Use "Stripe" or "Bordered" rows. Status chips are condensed with 12px icons and text.
- **Status Chips:** Low-saturation backgrounds with high-saturation text (e.g., Success: Green 50 BG / Green 700 Text).
- **Resource Thumbnails:**
    - *Video:* 16:9 aspect ratio with a play icon overlay and duration tag.
    - *Audio:* Waveform visualization (miniature) in the Cyan colorway.
    - *Prompts/Docs:* Document icon with extension labels (.json, .txt).
- **Inspector Panels:** Vertical stacks of labeled data. Use `label-sm` for headers and `body-sm` for values.
- **Relationship Maps:** Use 1px "Hairline" strokes (#D0D5DD) for dependency lines. Active paths should transition to Primary Blue.
- **Input Fields:** 32px height with a 1px border. Focus state is a 2px Primary Blue ring with 0% offset.
- **Action Buttons:** Primary buttons use solid fills; secondary/utility buttons use ghost or outline styles to maintain hierarchy.
