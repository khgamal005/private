'use client';

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
