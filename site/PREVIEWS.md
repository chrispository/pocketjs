# Local site preview

```sh
bun run site:preview
```

Open **http://127.0.0.1:4173/** to preview the production homepage.
The app strip links Pocket Shell, OpenStrike, Pocket Voxel, and PSPMAN to
their setup details. The Ecosystem section includes device filters,
engineering examples, and articles.

The PSP motion demo shows its loading placeholder inside the reserved demo
viewport. It loads when the section approaches the screen.

Use `--port=4174` for another port, or `--no-build` to serve an existing
`site/dist/`. The preview serves the same output that is deployed.

To inspect the docs navigation, open `/docs/overview/` below 1000 CSS pixels
wide. The sticky **Browse docs** disclosure contains the same sections and
active page as the desktop sidebar. It works without JavaScript, supports
keyboard activation, and scrolls internally when the directory exceeds the
screen.
