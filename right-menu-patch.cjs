const fs = require('fs');

const themePath = 'app/marktone-theme.css';
const globalsPath = 'app/globals.css';
const cssPath = fs.existsSync(themePath) ? themePath : globalsPath;

if (!fs.existsSync(cssPath)) {
  throw new Error('No application CSS file found for the right mobile menu patch');
}

const marker = '/* MARKTONE RIGHT MOBILE MENU RELEASE 1.4.1 */';
let css = fs.readFileSync(cssPath, 'utf8');
css = css.split(marker)[0].trimEnd();

const rightMenuCss = String.raw`

${marker}
@media (max-width: 820px) {
  .shell,
  .control-shell,
  .tenant-shell {
    display: grid !important;
    grid-template-columns: 96px minmax(0, 1fr) !important;
    direction: rtl !important;
    width: 100% !important;
    min-width: 0 !important;
    align-items: start !important;
    overflow: visible !important;
  }

  .side {
    grid-column: 1 !important;
    grid-row: 1 !important;
    position: sticky !important;
    top: 0 !important;
    right: 0 !important;
    left: auto !important;
    width: 96px !important;
    height: 100dvh !important;
    min-height: 100dvh !important;
    padding: 10px 7px calc(12px + env(safe-area-inset-bottom)) !important;
    border-inline-start: 1px solid var(--mt-sidebar-border) !important;
    overflow-x: hidden !important;
    overflow-y: auto !important;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    z-index: 45 !important;
  }

  .side::-webkit-scrollbar { width: 3px; }
  .side::-webkit-scrollbar-thumb { background: rgba(255,255,255,.18); border-radius: 999px; }

  .brand-logo-link {
    width: 100% !important;
    padding: 0 2px 10px !important;
  }

  .side .marktone-logo {
    display: grid !important;
    justify-items: center !important;
    gap: 5px !important;
  }

  .side .marktone-logo svg {
    width: 78px !important;
    height: auto !important;
    max-height: 54px !important;
    border-radius: 10px !important;
  }

  .side .marktone-logo > span,
  .side .account {
    display: none !important;
  }

  .side nav {
    display: grid !important;
    grid-template-columns: minmax(0, 1fr) !important;
    gap: 5px !important;
    width: 100% !important;
    margin: 0 !important;
    padding: 0 !important;
    overflow: visible !important;
    scroll-snap-type: none !important;
  }

  .side nav button,
  .side nav a {
    display: grid !important;
    place-items: center !important;
    width: 100% !important;
    min-width: 0 !important;
    min-height: 46px !important;
    margin: 0 !important;
    padding: 8px 5px !important;
    text-align: center !important;
    white-space: normal !important;
    overflow-wrap: anywhere !important;
    font-size: 10.5px !important;
    line-height: 1.35 !important;
    border: 1px solid transparent !important;
    border-radius: 10px !important;
    box-shadow: none !important;
  }

  .side nav button:hover,
  .side nav a:hover {
    border-color: rgba(255,255,255,.08) !important;
  }

  .side nav button.active,
  .side nav a.active {
    box-shadow: inset -3px 0 0 var(--mt-sidebar-primary) !important;
    border-color: rgba(255,255,255,.09) !important;
  }

  .main,
  .control-shell .main,
  .tenant-shell .main {
    grid-column: 2 !important;
    grid-row: 1 !important;
    direction: rtl !important;
    width: 100% !important;
    min-width: 0 !important;
    overflow-x: clip !important;
  }

  .top {
    right: auto !important;
    left: auto !important;
    width: 100% !important;
  }

  .content {
    width: 100% !important;
    min-width: 0 !important;
  }

  .assistant-launcher {
    right: auto !important;
    left: 12px !important;
  }

  .assistant {
    right: 106px !important;
    left: 10px !important;
    width: auto !important;
  }
}

@media (max-width: 430px) {
  .shell,
  .control-shell,
  .tenant-shell {
    grid-template-columns: 82px minmax(0, 1fr) !important;
  }

  .side {
    width: 82px !important;
    padding-inline: 5px !important;
  }

  .side .marktone-logo svg {
    width: 68px !important;
    max-height: 48px !important;
  }

  .side nav button,
  .side nav a {
    min-height: 43px !important;
    padding: 7px 4px !important;
    font-size: 9.5px !important;
  }

  .assistant {
    right: 90px !important;
  }
}
`;

fs.writeFileSync(cssPath, `${css}${rightMenuCss}\n`);

const releasePath = 'public/release.json';
const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
release.version = '1.4.1';
release.release = 'mobile-right-sidebar-menu';
release.mobileMenu = 'right-sidebar';
release.mobileMenuWidth = 96;
fs.writeFileSync(releasePath, `${JSON.stringify(release, null, 2)}\n`);

console.log(`Applied Marktone right mobile menu release 1.4.1 to ${cssPath}`);
