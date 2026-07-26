'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export default function KnowledgeNavRuntime() {
  const [target, setTarget] = useState(null);
  useEffect(() => {
    let timer;
    const find = () => {
      const nav = document.querySelector('.side nav');
      if (nav) setTarget(nav);
      else timer = setTimeout(find, 200);
    };
    find();
    return () => clearTimeout(timer);
  }, []);

  if (!target) return null;
  const tenant = typeof location !== 'undefined' ? location.pathname.match(/^\/tenant\/([^/]+)/)?.[1] : null;
  const href = tenant ? `/tenant/${tenant}/knowledge` : '/knowledge';
  return createPortal(
    <button type="button" className="knowledge-nav-button" onClick={() => { location.href = href; }}>
      <span aria-hidden="true">◈</span><span>أخبار ومعارف</span>
    </button>,
    target,
  );
}
