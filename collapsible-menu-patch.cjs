const fs = require('fs');

const themePath = 'app/marktone-theme.css';
const globalsPath = 'app/globals.css';
const cssPath = fs.existsSync(themePath) ? themePath : globalsPath;
const layoutPath = 'app/layout.js';
const runtimePath = 'components/mobile-menu-runtime.js';

if (!fs.existsSync(cssPath) || !fs.existsSync(layoutPath)) {
  throw new Error('Required application files were not found for the collapsible mobile menu patch');
}

const runtimeSource = `'use client';

import { useEffect } from 'react';

export default function MobileMenuRuntime() {
  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    const media = window.matchMedia('(max-width: 820px)');
    const side = document.querySelector('.side');

    if (!side) return undefined;

    let toggle = document.querySelector('.mobile-side-toggle');
    let backdrop = document.querySelector('.mobile-side-backdrop');
    let closeButton = side.querySelector('.mobile-side-close');

    if (!toggle) {
      toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'mobile-side-toggle';
      toggle.setAttribute('aria-label', 'فتح القائمة الرئيسية');
      toggle.setAttribute('aria-controls', 'marktone-mobile-navigation');
      toggle.innerHTML = '<span></span><span></span><span></span>';
      body.appendChild(toggle);
    }

    if (!backdrop) {
      backdrop = document.createElement('button');
      backdrop.type = 'button';
      backdrop.className = 'mobile-side-backdrop';
      backdrop.setAttribute('aria-label', 'إغلاق القائمة');
      body.appendChild(backdrop);
    }

    if (!side.id) side.id = 'marktone-mobile-navigation';

    if (!closeButton) {
      closeButton = document.createElement('button');
      closeButton.type = 'button';
      closeButton.className = 'mobile-side-close';
      closeButton.setAttribute('aria-label', 'طي القائمة');
      closeButton.innerHTML = '<span aria-hidden="true">×</span>';
      side.prepend(closeButton);
    }

    const setOpen = (open) => {
      const shouldOpen = Boolean(open && media.matches);
      root.classList.toggle('mt-mobile-menu-open', shouldOpen);
      toggle.classList.toggle('is-open', shouldOpen);
      toggle.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
      toggle.setAttribute('aria-label', shouldOpen ? 'إغلاق القائمة الرئيسية' : 'فتح القائمة الرئيسية');
      side.setAttribute('aria-hidden', shouldOpen || !media.matches ? 'false' : 'true');
      body.style.overflow = shouldOpen ? 'hidden' : '';
    };

    const toggleMenu = () => setOpen(!root.classList.contains('mt-mobile-menu-open'));
    const closeMenu = () => setOpen(false);

    toggle.addEventListener('click', toggleMenu);
    backdrop.addEventListener('click', closeMenu);
    closeButton.addEventListener('click', closeMenu);

    const nav = side.querySelector('nav');
    const handleNavigation = (event) => {
      if (event.target.closest('a,button')) window.setTimeout(closeMenu, 80);
    };
    nav?.addEventListener('click', handleNavigation);

    const handleKeydown = (event) => {
      if (event.key === 'Escape') closeMenu();
    };
    document.addEventListener('keydown', handleKeydown);

    const handleMedia = () => {
      if (!media.matches) setOpen(false);
      else closeMenu();
    };
    media.addEventListener?.('change', handleMedia);

    closeMenu();

    return () => {
      toggle?.removeEventListener('click', toggleMenu);
      backdrop?.removeEventListener('click', closeMenu);
      closeButton?.removeEventListener('click', closeMenu);
      nav?.removeEventListener('click', handleNavigation);
      document.removeEventListener('keydown', handleKeydown);
      media.removeEventListener?.('change', handleMedia);
      body.style.overflow = '';
      root.classList.remove('mt-mobile-menu-open');
    };
  }, []);

  return null;
}
`;

fs.mkdirSync('components', { recursive: true });
fs.writeFileSync(runtimePath, runtimeSource, 'utf8');

let layout = fs.readFileSync(layoutPath, 'utf8');
if (!layout.includes('MobileMenuRuntime')) {
  layout = `import MobileMenuRuntime from '../components/mobile-menu-runtime';\n${layout}`;
  if (!layout.includes('{children}')) throw new Error('Could not find the children slot in app/layout.js');
  layout = layout.replace('{children}', '{children}<MobileMenuRuntime />');
  fs.writeFileSync(layoutPath, layout, 'utf8');
}

const marker = '/* MARKTONE COLLAPSIBLE MOBILE MENU RELEASE 1.4.2 */';
let css = fs.readFileSync(cssPath, 'utf8');
css = css.split(marker)[0].trimEnd();

const collapsibleCss = String.raw`

${marker}
.mobile-side-toggle,
.mobile-side-backdrop,
.mobile-side-close {
  display: none;
}

@media (max-width: 820px) {
  .shell,
  .control-shell,
  .tenant-shell {
    display: block !important;
    width: 100% !important;
    min-width: 0 !important;
    direction: rtl !important;
    overflow-x: clip !important;
  }

  .main,
  .control-shell .main,
  .tenant-shell .main {
    display: block !important;
    width: 100% !important;
    min-width: 0 !important;
    margin: 0 !important;
    padding: 0 !important;
    overflow-x: clip !important;
  }

  .side {
    display: flex !important;
    flex-direction: column !important;
    position: fixed !important;
    top: 0 !important;
    right: 0 !important;
    left: auto !important;
    width: min(84vw, 310px) !important;
    height: 100dvh !important;
    min-height: 100dvh !important;
    padding: calc(16px + env(safe-area-inset-top)) 14px calc(18px + env(safe-area-inset-bottom)) !important;
    border: 0 !important;
    border-inline-start: 1px solid rgba(255,255,255,.09) !important;
    border-radius: 0 !important;
    box-shadow: -24px 0 70px rgba(5,22,48,.28) !important;
    overflow-x: hidden !important;
    overflow-y: auto !important;
    overscroll-behavior: contain;
    transform: translateX(108%) !important;
    opacity: .98 !important;
    visibility: hidden !important;
    transition: transform .3s cubic-bezier(.22,1,.36,1), visibility .3s ease, box-shadow .3s ease !important;
    z-index: 1001 !important;
  }

  html.mt-mobile-menu-open .side {
    transform: translateX(0) !important;
    visibility: visible !important;
  }

  .side .brand-logo-link {
    width: calc(100% - 42px) !important;
    min-height: 74px !important;
    margin: 0 0 12px !important;
    padding: 0 !important;
  }

  .side .marktone-logo {
    display: flex !important;
    align-items: center !important;
    justify-content: flex-start !important;
    gap: 9px !important;
  }

  .side .marktone-logo svg {
    width: 168px !important;
    height: auto !important;
    max-height: 70px !important;
    border-radius: 14px !important;
  }

  .side .marktone-logo > span {
    display: none !important;
  }

  .side nav {
    display: grid !important;
    grid-template-columns: minmax(0, 1fr) !important;
    gap: 6px !important;
    width: 100% !important;
    margin: 0 !important;
    padding: 4px 0 !important;
    overflow: visible !important;
    scroll-snap-type: none !important;
  }

  .side nav button,
  .side nav a {
    display: flex !important;
    align-items: center !important;
    justify-content: flex-start !important;
    width: 100% !important;
    min-width: 0 !important;
    min-height: 46px !important;
    margin: 0 !important;
    padding: 10px 13px !important;
    gap: 10px !important;
    text-align: right !important;
    white-space: normal !important;
    overflow-wrap: anywhere !important;
    font-size: 12.5px !important;
    line-height: 1.45 !important;
    border: 1px solid transparent !important;
    border-radius: 13px !important;
    box-shadow: none !important;
    transition: background .18s ease, border-color .18s ease, transform .18s ease !important;
  }

  .side nav button:active,
  .side nav a:active {
    transform: scale(.985) !important;
  }

  .side nav button.active,
  .side nav a.active {
    border-color: rgba(255,255,255,.10) !important;
    box-shadow: inset -3px 0 0 var(--mt-sidebar-primary) !important;
  }

  .side .account {
    display: flex !important;
    margin-top: auto !important;
    padding-top: 14px !important;
  }

  .mobile-side-toggle {
    display: grid !important;
    place-items: center !important;
    position: fixed !important;
    top: calc(12px + env(safe-area-inset-top)) !important;
    right: 12px !important;
    left: auto !important;
    width: 46px !important;
    height: 46px !important;
    padding: 0 !important;
    border: 1px solid rgba(15,47,84,.12) !important;
    border-radius: 14px !important;
    background: rgba(255,255,255,.94) !important;
    box-shadow: 0 12px 32px rgba(10,35,67,.16) !important;
    backdrop-filter: blur(16px) !important;
    color: var(--mt-navy) !important;
    cursor: pointer !important;
    z-index: 1003 !important;
    transition: transform .2s ease, background .2s ease, color .2s ease !important;
  }

  .mobile-side-toggle span {
    display: block !important;
    position: absolute !important;
    width: 20px !important;
    height: 2px !important;
    border-radius: 999px !important;
    background: currentColor !important;
    transition: transform .25s ease, opacity .2s ease !important;
  }

  .mobile-side-toggle span:nth-child(1) { transform: translateY(-6px); }
  .mobile-side-toggle span:nth-child(3) { transform: translateY(6px); }
  .mobile-side-toggle.is-open {
    background: var(--mt-navy) !important;
    color: #fff !important;
    transform: translateX(calc(-1 * min(84vw, 310px) + 58px)) !important;
  }
  .mobile-side-toggle.is-open span:nth-child(1) { transform: rotate(45deg); }
  .mobile-side-toggle.is-open span:nth-child(2) { opacity: 0; }
  .mobile-side-toggle.is-open span:nth-child(3) { transform: rotate(-45deg); }

  .mobile-side-close {
    display: grid !important;
    place-items: center !important;
    position: absolute !important;
    top: calc(16px + env(safe-area-inset-top)) !important;
    left: 14px !important;
    width: 36px !important;
    height: 36px !important;
    padding: 0 !important;
    border: 1px solid rgba(255,255,255,.10) !important;
    border-radius: 11px !important;
    background: rgba(255,255,255,.07) !important;
    color: #fff !important;
    font-size: 25px !important;
    line-height: 1 !important;
    cursor: pointer !important;
    z-index: 2 !important;
  }

  .mobile-side-backdrop {
    display: block !important;
    position: fixed !important;
    inset: 0 !important;
    width: 100% !important;
    height: 100dvh !important;
    padding: 0 !important;
    border: 0 !important;
    background: rgba(5,20,40,.52) !important;
    backdrop-filter: blur(4px) !important;
    opacity: 0 !important;
    visibility: hidden !important;
    pointer-events: none !important;
    transition: opacity .25s ease, visibility .25s ease !important;
    z-index: 1000 !important;
  }

  html.mt-mobile-menu-open .mobile-side-backdrop {
    opacity: 1 !important;
    visibility: visible !important;
    pointer-events: auto !important;
  }

  .top {
    width: 100% !important;
    padding-right: 68px !important;
  }

  .content {
    width: 100% !important;
    min-width: 0 !important;
  }

  .assistant {
    right: 10px !important;
    left: 10px !important;
  }

  .assistant-launcher {
    right: auto !important;
    left: 14px !important;
  }
}

@media (max-width: 430px) {
  .side {
    width: min(88vw, 292px) !important;
  }

  .mobile-side-toggle.is-open {
    transform: translateX(calc(-1 * min(88vw, 292px) + 56px)) !important;
  }

  .side .marktone-logo svg {
    width: 152px !important;
  }

  .side nav button,
  .side nav a {
    min-height: 44px !important;
    font-size: 12px !important;
  }
}
`;

fs.writeFileSync(cssPath, `${css}${collapsibleCss}\n`, 'utf8');

const releasePath = 'public/release.json';
const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
release.version = '1.4.2';
release.release = 'professional-collapsible-mobile-sidebar';
release.mobileMenu = 'collapsible-right-drawer';
release.mobileMenuDefault = 'collapsed';
release.mobileMenuBackdrop = true;
fs.writeFileSync(releasePath, `${JSON.stringify(release, null, 2)}\n`);

console.log(`Applied Marktone professional collapsible mobile menu release 1.4.2 to ${cssPath}`);
