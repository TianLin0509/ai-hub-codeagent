# Ceramic navigation artwork

Approved by the user on 2026-09-21: proposal C, soft ceramic / 100 px rail.
`ceramic-navigation.png` is the unchanged generated contact sheet from the design
round. Its second row supplies the eight navigation icons; the first column is
the unused brand exploration. The bitmap has transparency and is local only.

Source image: `20260921-hub-nav-codex1-icon-directions.png` (1536 × 1024).
CSS samples 37 × 37 px windows from the sheet at scale 0.2, centered at
source x = 300 + 160n, y = 407 for n = 0…7. Keep these coordinates in sync with
`renderer/styles/rail.css`. Text, focus, selected state and notification badges
remain native UI elements rather than being baked into the image.
