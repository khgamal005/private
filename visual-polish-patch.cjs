const fs = require('fs');

const themePath = 'app/marktone-theme.css';
const globalsPath = 'app/globals.css';
const cssPath = fs.existsSync(themePath) ? themePath : globalsPath;

if (!fs.existsSync(cssPath)) {
  throw new Error('No application CSS file found for the visual polish release');
}

const marker = '/* MARKTONE CONTROL ROOM POLISH RELEASE 1.8.0 */';
let css = fs.readFileSync(cssPath, 'utf8');
css = css.split(marker)[0].trimEnd();

const polishCss = String.raw`

${marker}
:root {
  --mt-canvas: #f3f7fb;
  --mt-navy: #092b4e;
  --mt-navy-soft: #123f6e;
  --mt-gold: #e0b53d;
  --mt-line: #dce6f0;
  --mt-text: #142b46;
  --mt-subtle: #708096;
}

html,
body {
  background: var(--mt-canvas) !important;
}

.control-shell,
.tenant-shell {
  min-height: 100dvh !important;
}

.control-shell .main,
.tenant-shell .main {
  min-width: 0 !important;
  background:
    radial-gradient(circle at 12% -10%, rgba(49, 117, 180, .11), transparent 30rem),
    linear-gradient(180deg, #f8fbfe 0%, var(--mt-canvas) 100%) !important;
}

.top {
  box-shadow: 0 1px 0 rgba(12, 45, 78, .02) !important;
}

.top > div:first-child {
  min-width: 240px;
}

.top > div:last-child,
.top .user-actions {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px !important;
  min-width: 0;
}

.top button,
.top a,
.user-email {
  min-height: 38px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.user-email {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hero {
  position: relative;
  isolation: isolate;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, .1) !important;
}

.hero::after {
  content: '';
  position: absolute;
  z-index: -1;
  width: 310px;
  height: 310px;
  inset-inline-start: -90px;
  top: -190px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(224, 181, 61, .2), transparent 70%);
  pointer-events: none;
}

.hero > div {
  min-width: 0;
}

.hero p {
  max-width: 760px;
}

.hero button,
.hero .hero-link {
  min-height: 46px;
  border-radius: 13px !important;
  box-shadow: 0 12px 30px rgba(4, 22, 43, .2);
}

.stats {
  align-items: stretch;
}

.stat-button,
.stats article {
  position: relative;
  min-width: 0;
  min-height: 104px;
  overflow: hidden;
  transition: transform .18s ease, border-color .18s ease, box-shadow .18s ease !important;
}

.stat-button::before,
.stats article::before {
  content: '';
  position: absolute;
  inset-block: 15px;
  inset-inline-start: 0;
  width: 3px;
  border-radius: 999px;
  background: linear-gradient(180deg, var(--mt-gold), #f3d880);
  opacity: .9;
}

.stat-button:hover,
.stats article:hover {
  transform: translateY(-2px);
  border-color: #cad9e8 !important;
  box-shadow: 0 18px 44px -30px rgba(10, 43, 78, .38) !important;
}

.stat-button b,
.stats article b {
  margin-block: 8px 6px !important;
  letter-spacing: -.02em;
}

.panel {
  min-width: 0;
}

.panel-head {
  padding-bottom: 13px;
  border-bottom: 1px solid #edf2f7;
}

.panel-head button {
  min-height: 36px;
}

.tenant-row,
.tenant-admin-card,
.feature-grid article,
.role-grid article,
.support-list article,
.table-list > div {
  transition: border-color .16s ease, background-color .16s ease, box-shadow .16s ease;
}

.tenant-row:hover,
.tenant-admin-card:hover,
.feature-grid article:hover,
.role-grid article:hover,
.support-list article:hover,
.table-list > div:hover {
  border-color: #cedbe8 !important;
  background: #fbfdff !important;
  box-shadow: 0 12px 34px -30px rgba(9, 43, 78, .42);
}

.action-stack button {
  min-height: 43px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.action-stack button::after {
  content: '+';
  width: 23px;
  height: 23px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  background: #edf3f8;
  color: #315474;
  font-family: var(--mt-font-en) !important;
  font-weight: 600;
}

.action-stack button:hover::after {
  background: rgba(255, 255, 255, .13);
  color: #fff;
}

@media (min-width: 901px) {
  .shell,
  .control-shell,
  .tenant-shell {
    grid-template-columns: 228px minmax(0, 1fr) !important;
    align-items: start !important;
  }

  .side {
    position: sticky !important;
    inset-block-start: 0 !important;
    width: 228px !important;
    height: 100dvh !important;
    min-height: 100dvh !important;
    padding: 16px 13px 18px !important;
    overflow-x: hidden !important;
    overflow-y: auto !important;
    scrollbar-width: thin;
  }

  .side::-webkit-scrollbar {
    width: 4px;
  }

  .side::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, .14);
    border-radius: 999px;
  }

  .brand-logo-link {
    padding: 0 2px 13px !important;
  }

  .side .marktone-logo svg {
    max-height: 74px !important;
    border-radius: 14px !important;
  }

  .side .marktone-logo > span {
    font-size: 9px !important;
  }

  .account {
    margin-bottom: 13px !important;
    padding: 11px 12px !important;
  }

  .side nav {
    gap: 3px !important;
  }

  .side nav button,
  .side nav a {
    min-height: 41px !important;
    margin: 1px 0 !important;
    padding: 9px 11px !important;
    font-size: 12px !important;
  }

  .top {
    position: sticky !important;
    top: 0 !important;
    z-index: 40 !important;
    min-height: 74px !important;
    height: auto !important;
    padding: 11px clamp(20px, 2.4vw, 34px) !important;
    gap: 18px;
  }

  .content {
    width: min(100%, 1510px) !important;
    max-width: 1510px !important;
    margin-inline: auto !important;
    padding: 26px clamp(20px, 2.4vw, 34px) 42px !important;
  }

  .hero {
    min-height: 146px;
    display: grid !important;
    grid-template-columns: minmax(0, 1fr) auto !important;
    align-items: center !important;
    gap: 28px !important;
    padding: 28px !important;
  }

  .stats {
    gap: 12px !important;
    margin: 15px 0 !important;
  }

  .stat-button,
  .stats article {
    padding: 16px 18px !important;
  }

  .grid {
    grid-template-columns: minmax(0, 1.65fr) minmax(250px, .68fr) !important;
    gap: 15px !important;
    align-items: start !important;
    margin-top: 15px !important;
  }

  .panel {
    padding: 17px 18px !important;
  }
}

@media (min-width: 901px) and (max-width: 1180px) {
  .shell,
  .control-shell,
  .tenant-shell {
    grid-template-columns: 210px minmax(0, 1fr) !important;
  }

  .side {
    width: 210px !important;
  }

  .top {
    align-items: flex-start !important;
  }

  .top > div:last-child,
  .top .user-actions {
    flex-wrap: wrap;
  }

  .user-email {
    display: none;
  }

  .grid {
    grid-template-columns: minmax(0, 1fr) !important;
  }
}

@media (max-width: 900px) {
  .top {
    min-height: 70px !important;
    padding-block: 11px !important;
  }

  .top h1 {
    font-size: clamp(16px, 4.5vw, 20px) !important;
  }

  .content {
    padding-top: 14px !important;
  }

  .hero {
    min-height: 0;
    padding: 20px !important;
  }

  .hero::after {
    width: 220px;
    height: 220px;
    top: -145px;
  }

  .panel-head {
    padding-bottom: 11px;
  }
}

@media (max-width: 520px) {
  .stats {
    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
  }

  .stat-button,
  .stats article {
    min-height: 96px;
    padding: 13px !important;
  }

  .stat-button b,
  .stats article b {
    font-size: 22px !important;
  }
}
`;

fs.writeFileSync(cssPath, `${css}${polishCss}\n`);

const releasePath = 'public/release.json';
const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
release.version = '1.8.0';
release.release = 'control-room-visual-polish';
release.visualSource = 'Marktone Projects';
release.integratedNavigation = true;
release.desktopSidebarWidth = 228;
release.mobileMenu = 'collapsible-right-drawer';
fs.writeFileSync(releasePath, `${JSON.stringify(release, null, 2)}\n`);

console.log(`Applied Marktone control room visual polish to ${cssPath}`);
